'use strict';

const { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const identity = require('./nexi-identity.cjs');
const canonicalJson = require('./nexi-canonical-json.cjs');
const snapshots = require('./nexi-attendance-snapshot.cjs');
const CANONICAL_VERSION = canonicalJson.VERSION;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PN = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const LID = /^\d{1,20}@lid$/;
const ID_PREFIX = '3EB0A77E1B'; // Denial marker; never permission to send/retry.
const MAX_ATTEMPTS = 12; // Accepted persistent Groups outbox retry ceiling.
const BARRIER_STATES = ['staged', 'fencing', 'active', 'pause_requested', 'paused', 'retired', 'unresolved'];
const ADDRESSING_PROTOCOL_VERSION = 2;
const ADDRESSING_FIELDS = ['addressing_protocol_version', 'transport_recipient', 'addressing_representation'];
const DISPATCH_PROOF_KEYS = ['version','protocol','preparation_id','execution_id','attempt_id','reservation_id','grant_id','release_id',
  'consumption_id','external_id','stanza_id','stanza_recipient','transport_recipient','addressing_representation',
  'identity_version_id','session_identity','dispatch_started_at','receipt_remote_jid','receipt_remote_jid_semantics','transport_response'];
const COMMON = ['version', 'protocol_version', 'canonical_version', 'audience', 'provider', 'account_id', 'managed_channel_id', 'instance_id',
  'instance_lineage_id', 'session_identity', 'original_session_identity', 'sender_account_lineage_id', 'sender_attestation_id',
  'binding_generation', 'writer_epoch', 'writer_protocol_version', 'barrier_state'];
const FIELDS = {
  'attendance.context.request': ['version', 'canonical_version', 'audience', 'provider', 'account_id', 'inbox_id', 'nonce', 'session_identity'],
  'attendance.writer.context.request': ['version', 'canonical_version', 'audience', 'provider', 'account_id', 'inbox_id', 'nonce', 'session_identity', 'socket_owner'],
  'attendance.foundation.request': COMMON.concat(['action', 'request_id', 'execution_id', 'attempt_id', 'transport_unit',
    'external_id', 'authority_digest', 'payload_digest', 'preparation_id', 'preparation_nonce_digest', 'recipient', 'identity_version_id']),
  'attendance.session.observed': COMMON.concat(['observation_id', 'canonical_pn', 'canonical_lid', 'public_material_digest',
    'registration_digest', 'provenance', 'observed_at']),
  'attendance.session.proved': COMMON.concat(['observation_id', 'canonical_pn', 'canonical_lid', 'public_material_digest',
    'registration_digest', 'provenance', 'observed_at']),
  'attendance.transport.prepared': COMMON.concat(['execution_id', 'attempt_id', 'transport_unit', 'reservation_id',
    'external_id', 'recipient', 'identity_version_id', 'preparation_id', 'preparation_nonce', 'revision', 'content_digest',
    'authority_digest', 'preparation_digest', 'observed_at']),
  'attendance.receipt.observed': COMMON.concat(['journal_id', 'external_id', 'remote_jid', 'participant', 'from_me',
    'direction', 'semantic_class', 'normalized_status', 'receipt_timestamp', 'captured_at', 'protocol_metadata', 'dispatch_proof']),
  'attendance.media.request': COMMON.concat(['inbox_id','execution_id','attempt_id','preparation_id','reservation_id','external_id','grant_id','release_id']),
};
const configs = new WeakMap();
// Only a fresh, nonce-bound APP response can authorize capture attestation
// renewal. Persisted JSON or a copied proof is never this local capability.
const authenticatedAttestationRenewals = new WeakMap();
const sockets = new WeakMap();
const purposes = new WeakMap();
const internalControls = new WeakMap();
const encodings = new WeakMap();
const scope = new AsyncLocalStorage();
const workers = new Map();
const outboxDrainers = new WeakMap();
const OUTBOX_WAKE_CAPACITY = 256;
const healthWrites = new Map();
const inboundSpans = new WeakMap();
const inboundArrivals = new WeakMap();
const inboundQueues = new WeakMap();
const inboundThrottle = new Map();
const receiptThrottle = new Map();
const receiptCounts = new Map();
const diagnosticOwners = new WeakMap();
const DIAGNOSTIC_THROTTLE_CAPACITY = 1024;
const DIAGNOSTIC_COUNT_CAPACITY = 512;
const DIAGNOSTIC_THROTTLE_TTL_MS = 300000;
const DIAGNOSTIC_COUNT_TTL_MS = 900000;
// Shared process-wide budgets: no instance/ID can increase the aggregate cap.
const TRACE_WINDOW_MS = 60000;
const traceBudgets = {
  sampled: { limit: 120, remaining: 120, resetAt: 0 },
  slow: { limit: 60, remaining: 60, resetAt: 0 },
  failed: { limit: 60, remaining: 60, resetAt: 0 },
};
const INBOUND_SLOW_MS = 1000;

function pruneDiagnostics(map, now) {
  // Writes reinsert at the tail with a fixed TTL; reads never extend expiry.
  for (const [key, value] of map) {
    if (value.expiresAt > now) break;
    map.delete(key);
  }
}
function putDiagnostic(map, key, value, capacity, ttl, now) {
  pruneDiagnostics(map, now);
  map.delete(key);
  if (map.size >= capacity) map.delete(map.keys().next().value);
  map.set(key, { ...value, expiresAt: now + ttl });
}
function clearInstanceDiagnostics(service) {
  try {
    const owner = diagnosticOwners.get(service);
    if (owner) owner.active = false;
    const instanceId = diagnosticInstance({ instanceId: owner?.instanceId || service?.instanceId });
    for (const map of [inboundThrottle, receiptThrottle, receiptCounts]) {
      for (const [key, value] of map) if (value.instanceId === instanceId) map.delete(key);
    }
  } catch { /* Cleanup is diagnostic only; never interfere with lifecycle. */ }
}
function diagnosticInstance(source) {
  return typeof source?.instanceId === 'string' && UUID.test(source.instanceId) ? source.instanceId : 'unknown';
}
function allowDiagnosticTrace(lane, now = performance.now()) {
  try {
    if (!['sampled', 'slow', 'failed'].includes(lane)) return false;
    const budget = traceBudgets[lane];
    if (now >= budget.resetAt) {
      budget.remaining = budget.limit;
      budget.resetAt = now + TRACE_WINDOW_MS;
    }
    if (budget.remaining <= 0) return false;
    budget.remaining--; // Shared reservation before any S2 trace logger runs.
    return true;
  } catch { return false; }
}
function admitTrace(map, source, stage, values) {
  if (source?.diagnosticOwner?.active === false) return null;
  // Only bounded internal labels enter a diagnostic key, never payload IDs.
  if (typeof stage !== 'string' || !/^[a-z_]{1,64}$/.test(stage)) return null;
  const reason = typeof values.reason === 'string' && /^[a-z_]{1,64}$/.test(values.reason) ? values.reason : '';
  const lane = values.result === 'sampled' ? 'sampled' : (values.result === 'failed' ||
    reason && !['append_waiting', 'append_duplicate_race'].includes(reason)) ? 'failed' : 'slow';
  const now = performance.now(), instanceId = diagnosticInstance(source);
  const key = `${instanceId}:${stage}:${lane}:${reason}`;
  pruneDiagnostics(map, now);
  let previous = map.get(key);
  const interval = lane === 'slow' ? 30000 : 1000;
  if ((previous && now - previous.at < interval) || !allowDiagnosticTrace(lane, now)) {
    if (!previous) {
      putDiagnostic(map, key, { instanceId, at: -Infinity, suppressed: 0 },
        DIAGNOSTIC_THROTTLE_CAPACITY, DIAGNOSTIC_THROTTLE_TTL_MS, now);
      previous = map.get(key);
    }
    previous.suppressed = Math.min(Number.MAX_SAFE_INTEGER, previous.suppressed + 1);
    return null;
  }
  const suppressed = previous?.suppressed || 0;
  putDiagnostic(map, key, { instanceId, at: now, suppressed: 0 },
    DIAGNOSTIC_THROTTLE_CAPACITY, DIAGNOSTIC_THROTTLE_TTL_MS, now);
  return { suppressed };
}
function inboundReference(source, id) {
  try {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) return null;
    return createHmac('sha256', envelopeSecret(source)).update(`inbound-message:v1:${id}`).digest('hex').slice(0, 24);
  } catch { return null; } // Missing diagnostic material must never stop capture/append/drain.
}
function inboundTrace(source, stage, values = {}) {
  try {
    const throttle = admitTrace(inboundThrottle, source, stage, values);
    if (!throttle) return;
    const now = Date.now();
    const effective = process.env.NEXI_RUNTIME_REVISION || '';
    const safe = { event: 'attendance.inbound_trace', stage, timestamp: new Date(now).toISOString(),
      marker: 's2-inbound-observability-v1', runtime_revision: /^[0-9a-f]{40}$/i.test(effective) ? effective : 'unknown' };
    if (source?.instanceId && UUID.test(source.instanceId)) safe.instance_id = source.instanceId;
    if (typeof values.ref === 'string' && /^[0-9a-f]{24}$/.test(values.ref)) safe.ref = values.ref;
    if (typeof values.batch_ref === 'string' && UUID.test(values.batch_ref)) safe.batch_ref = values.batch_ref;
    for (const key of ['received_at_ms', 'receive_to_observe_ms', 'observed_at_ms', 'buffered_at_ms', 'enqueued_at_ms', 'queue_age_ms', 'buffer_age_ms',
      'pre_item_ms', 'duration_ms', 'observed_to_end_ms']) {
      if (Number.isSafeInteger(values[key]) && values[key] >= 0) safe[key] = values[key];
    }
    // Stanza time is a remote clock, never a measured queue duration.
    if (Number.isSafeInteger(values.stanza_clock_delta_ms) && Math.abs(values.stanza_clock_delta_ms) <= 604800000)
      safe.stanza_clock_delta_ms = values.stanza_clock_delta_ms;
    if (['failed', 'slow', 'still_waiting', 'missing_observation', 'sampled'].includes(values.result)) safe.result = values.result;
    if (['history', 'upsert', 'other', 'durable_ingress'].includes(values.category)) safe.category = values.category;
    if (throttle.suppressed) safe.suppressed_count = throttle.suppressed;
    if (values.result === 'sampled' && source?.logger?.info) source.logger.info(safe);
    else if (source?.logger?.warn) source.logger.warn(safe);
    else console.warn(JSON.stringify(safe));
  } catch { /* diagnostics never influence dispatch or inbound persistence */ }
}
function receiptTrace(source, stage, values = {}) {
  try {
    const previous = admitTrace(receiptThrottle, source, stage, values);
    if (!previous) return;
    const now = Date.now();
    const effective = process.env.NEXI_RUNTIME_REVISION || '';
    const data = { event: 'attendance.receipt_trace', stage, timestamp: new Date(now).toISOString(),
      marker: 's2-receipt-observability-v1', runtime_revision: /^[0-9a-f]{40}$/i.test(effective) ? effective : 'unknown' };
    if (UUID.test(source?.instanceId || '')) data.instance_id = source.instanceId;
    if (UUID.test(values.event_id || '')) data.event_id = values.event_id;
    if (UUID.test(values.journal_id || '')) data.journal_id = values.journal_id;
    if (typeof values.ref === 'string' && /^[0-9a-f]{24}$/.test(values.ref)) data.ref = values.ref;
    if (['registration_missing', 'context_unavailable', 'normalization_empty', 'normalization_failed',
      'append_failed', 'append_duplicate_race', 'append_deadline', 'append_waiting', 'queue_saturated', 'receipt_packet_limit',
      'unsupported_address', 'receipt_repository_unavailable', 'receipt_limits_unconfigured',
      'request_failed', 'json_unreadable', 'http_rejected', 'ack_unproved', 'ack_persist_failed',
      'unsupported_mark_failed', 'drain_failed'].includes(values.reason))
      data.reason = values.reason;
    for (const name of ['duration_ms', 'queue_age_ms']) if (Number.isSafeInteger(values[name]) && values[name] >= 0)
      data[name] = values[name];
    if (Number.isSafeInteger(values.count) && values.count >= 0) data.count = values.count;
    if (values.result === 'sampled') data.result = 'sampled';
    if (previous.suppressed) data.suppressed_count = previous.suppressed;
    if (values.result === 'sampled' && source?.logger?.info) source.logger.info(data);
    else if (source?.logger?.warn) source.logger.warn(data);
    else console.warn(JSON.stringify(data));
  } catch { /* diagnostics cannot affect receipt evidence */ }
}
function inboundFailure(service, span) {
  try {
    const source = span?.source || { instanceId: service.instanceId, diagnosticOwner: diagnosticOwners.get(service) };
    const throttle = admitTrace(inboundThrottle, source, 'item_failed', { result: 'failed' });
    if (!throttle) return;
    const data = { event: 'nexi_inbound_item_failed' };
    if (UUID.test(source.instanceId || '')) data.instance_id = source.instanceId;
    if (typeof span?.ref === 'string' && /^[0-9a-f]{24}$/.test(span.ref)) data.ref = span.ref;
    if (throttle.suppressed) data.suppressed_count = throttle.suppressed;
    service.logger?.warn(JSON.stringify(data));
  } catch { /* A failing logger cannot abort the remaining WhatsApp batch. */ }
}
function countReceipt(source, stage) {
  try {
    if (source?.diagnosticOwner?.active === false || !['pre_buffer_observed', 'append_committed'].includes(stage)) return;
    const now = performance.now(), instanceId = diagnosticInstance(source), key = `${instanceId}:${stage}`;
    pruneDiagnostics(receiptCounts, now);
    let entry = receiptCounts.get(key);
    if (!entry) {
      putDiagnostic(receiptCounts, key, { instanceId, count: 0 }, DIAGNOSTIC_COUNT_CAPACITY, DIAGNOSTIC_COUNT_TTL_MS, now);
      entry = receiptCounts.get(key);
    }
    const count = entry.count = Math.min(Number.MAX_SAFE_INTEGER, entry.count + 1);
    if (count % 100 === 0) receiptTrace(source, `${stage}_count`, { count });
  } catch { /* diagnostic only */ }
}
function preparedOutboxTrace(source, row, phase, started = null, outcome = null) {
  try {
    if (row.eventType !== 'attendance.transport.prepared') return;
    const duration = started === null ? 0 : Math.round(performance.now() - started);
    const outboxAge = Math.max(0, Date.now() - +new Date(row.createdAt));
    const lane = phase === 'delivery_ended' && outcome !== 'ack_persisted' ? 'failed' :
      duration >= INBOUND_SLOW_MS || outboxAge >= INBOUND_SLOW_MS ? 'slow' : 'sampled';
    if (!allowDiagnosticTrace(lane)) return;
    const revision = process.env.NEXI_RUNTIME_REVISION || '';
    const data = { event: 'attendance.prepared_outbox', phase, timestamp: new Date().toISOString(),
      runtime_revision: /^[0-9a-f]{40}$/i.test(revision) ? revision : 'unknown', outcome,
      outbox_age_ms: outboxAge };
    if (UUID.test(source.instanceId || '')) data.instance_id = source.instanceId;
    if (UUID.test(row.id || '')) data.event_id = row.id;
    if (UUID.test(row.body?.data?.preparation_id || '')) data.preparation_id = row.body.data.preparation_id;
    if (started !== null) data.duration_ms = duration;
    console.info(JSON.stringify(data));
  } catch { /* Outbox diagnostics never affect delivery, lease or ACK. */ }
}
function receiveInbound(config, node) {
  try {
    const receivedAt = Date.now(), receivedTick = performance.now();
    const registration = configs.get(config);
    if (!registration?.context || registration.source.diagnosticOwner?.active === false || !node || typeof node !== 'object') return;
    if (![PN, LID].some(pattern => pattern.test(jid(node.attrs?.from) || ''))) return;
    const source = registration.source, ref = inboundReference(source, node.attrs?.id);
    if (!ref) return;
    const seconds = typeof node.attrs?.t === 'string' && /^\d{1,12}$/.test(node.attrs.t) ? Number(node.attrs.t) : null;
    const delta = seconds === null ? null : receivedAt - seconds * 1000;
    const stanzaClockDelta = Number.isSafeInteger(delta) && Math.abs(delta) <= 604800000 ? delta : null;
    // The offline processor retains this exact node. Weak keys add no queue,
    // timer or strong per-message retention; no packet/recipient is logged.
    inboundArrivals.set(node, { receivedAt, receivedTick, ref, stanzaClockDelta });
    if (parseInt(ref.slice(0, 2), 16) < 4 || stanzaClockDelta >= INBOUND_SLOW_MS)
      inboundTrace(source, 'baileys_received', { ref, received_at_ms: receivedAt,
        stanza_clock_delta_ms: stanzaClockDelta, result: stanzaClockDelta >= INBOUND_SLOW_MS ? 'slow' : 'sampled' });
  } catch { /* Socket ingress diagnostics never affect processing or ACK. */ }
}
function observeInbound(config, msg, node) {
  try {
    const registration = configs.get(config);
    if (!registration?.context || !msg || typeof msg !== 'object') return;
    const source = registration.source;
    const ref = inboundReference(source, msg.key?.id);
    if (ref) {
      const observedAt = Date.now(), observedTick = performance.now(), sampled = parseInt(ref.slice(0, 2), 16) < 4;
      const arrival = inboundArrivals.get(node);
      inboundArrivals.delete(node);
      const received = arrival?.ref === ref ? arrival : null;
      const receiveToObserve = received ? Math.round(observedTick - received.receivedTick) : null;
      inboundSpans.set(msg, { source, ref, observedAt, observedTick, sampled,
        receivedAt: received?.receivedAt ?? null, receiveToObserve,
        stanzaClockDelta: received?.stanzaClockDelta ?? null,
        bufferedAt: null, bufferedTick: null, enqueuedAt: null, enqueuedTick: null,
        queueStartedAt: null, queueStartTick: null });
      if (sampled || receiveToObserve >= INBOUND_SLOW_MS) inboundTrace(source, 'baileys_observed', {
        ref, received_at_ms: received?.receivedAt, receive_to_observe_ms: receiveToObserve,
        stanza_clock_delta_ms: received?.stanzaClockDelta, observed_at_ms: observedAt,
        result: receiveToObserve >= INBOUND_SLOW_MS ? 'slow' : 'sampled' });
    }
  } catch { /* observation is diagnostic only */ }
}
function enqueueInbound(config, msg) {
  try {
    const span = inboundSpans.get(msg);
    if (span && configs.get(config)?.source?.instanceId === span.source.instanceId) {
      span.bufferedAt = Date.now(); span.bufferedTick = performance.now();
    }
  } catch { /* diagnostic only */ }
}
function queueEnqueued(service, events) {
  try {
    if (!service?.instance?.name?.startsWith('nexi-wa-')) return;
    const messages = events?.['messages.upsert']?.messages;
    const spans = Array.isArray(messages) ? messages.map(msg => inboundSpans.get(msg))
      .filter(span => span?.source.instanceId === service.instanceId) : [];
    const at = Date.now(), tick = performance.now();
    const source = spans[0]?.source || { instanceId: service.instanceId, logger: service.logger,
      diagnosticOwner: diagnosticOwners.get(service) };
    const category = events?.['messaging-history.set'] ? 'history' : messages ? 'upsert' : 'other';
    const batchRef = randomUUID(), sampled = parseInt(batchRef.slice(0, 2), 16) < 4;
    for (const span of spans) {
      span.enqueuedAt = at; span.enqueuedTick = tick; span.batchRef = batchRef; span.category = category;
    }
    const batch = { source, batchRef, spans, enqueuedAt: at, enqueuedTick: tick, category, sampled };
    batch.pendingTimer = setTimeout(() => inboundTrace(source, 'queue_pending', { batch_ref: batchRef,
      queue_age_ms: Math.round(performance.now() - tick), category, result: 'still_waiting' }), INBOUND_SLOW_MS);
    batch.pendingTimer.unref?.();
    inboundQueues.set(events, batch);
    if (sampled) inboundTrace(source, 'queue_enqueued', { batch_ref: batchRef, enqueued_at_ms: at,
      category, result: 'sampled' });
    for (const span of spans) if (span.sampled) inboundTrace(span.source, 'queue_enqueued', { ref: span.ref, batch_ref: batchRef,
      observed_at_ms: span.observedAt, buffered_at_ms: span.bufferedAt, enqueued_at_ms: at,
      buffer_age_ms: span.bufferedTick ? Math.round(tick - span.bufferedTick) : null, result: 'sampled' });
  } catch { /* diagnostic only */ }
}
function queueStarted(service, events) {
  try {
    const batch = inboundQueues.get(events);
    if (!batch || batch.source.instanceId !== service.instanceId) return null;
    clearTimeout(batch.pendingTimer);
    const now = Date.now();
    batch.startedAt = now; batch.startTick = performance.now();
    for (const span of batch.spans) { span.queueStartedAt = now; span.queueStartTick = batch.startTick; }
    const age = Math.round(batch.startTick - batch.enqueuedTick);
    if (batch.sampled) inboundTrace(batch.source, 'queue_started', { batch_ref: batch.batchRef,
      queue_age_ms: age, category: batch.category, result: 'sampled' });
    for (const span of batch.spans) if (span.sampled) inboundTrace(span.source, 'queue_started', { ref: span.ref, batch_ref: batch.batchRef,
      queue_age_ms: age, result: 'sampled' });
    if (age >= INBOUND_SLOW_MS) inboundTrace(batch.source, 'queue_started', { batch_ref: batch.batchRef,
      enqueued_at_ms: batch.enqueuedAt, queue_age_ms: age, category: batch.category, result: 'slow' });
    batch.timer = setTimeout(() => inboundTrace(batch.source, 'queue_wait', { batch_ref: batch.batchRef,
      duration_ms: Math.round(performance.now() - batch.startTick), category: batch.category,
      result: 'still_waiting' }), INBOUND_SLOW_MS);
    batch.timer.unref?.();
    return batch;
  } catch { return null; }
}
function queueEnded(batch, failed = false) {
  if (!batch) return;
  clearTimeout(batch.timer);
  const duration = Math.round(performance.now() - batch.startTick);
  if (batch.sampled) inboundTrace(batch.source, 'queue_ended', { batch_ref: batch.batchRef,
    duration_ms: duration, category: batch.category, result: 'sampled' });
  for (const span of batch.spans) if (span.sampled) inboundTrace(span.source, 'queue_ended', { ref: span.ref, batch_ref: batch.batchRef,
    duration_ms: duration, result: 'sampled' });
  if (failed || duration >= INBOUND_SLOW_MS) inboundTrace(batch.source, 'queue_ended', { batch_ref: batch.batchRef,
    duration_ms: duration, category: batch.category, result: failed ? 'failed' : 'slow' });
}
function beginInbound(service, msg) {
  try {
    const span = inboundSpans.get(msg);
    if (!span || span.source.instanceId !== service.instanceId) return null;
    const startedAt = Date.now(), startTick = performance.now();
    const queueAge = span.queueStartTick && span.enqueuedTick ? Math.round(span.queueStartTick - span.enqueuedTick) : null;
    const bufferAge = span.enqueuedTick && span.bufferedTick ? Math.round(span.enqueuedTick - span.bufferedTick) : null;
    const preItem = span.queueStartTick ? Math.round(startTick - span.queueStartTick) : null;
    if (span.sampled) inboundTrace(span.source, 'handler_started', { ref: span.ref, batch_ref: span.batchRef, pre_item_ms: preItem,
      result: 'sampled' });
    if ([queueAge, bufferAge, preItem].some(value => value !== null && value >= INBOUND_SLOW_MS))
      inboundTrace(span.source, 'handler_started', { ref: span.ref, batch_ref: span.batchRef, observed_at_ms: span.observedAt,
        buffered_at_ms: span.bufferedAt, enqueued_at_ms: span.enqueuedAt, queue_age_ms: queueAge,
        buffer_age_ms: bufferAge, pre_item_ms: preItem, result: 'slow' });
    const running = { ...span, startedAt, startTick, queueAge, bufferAge, preItem, failed: false };
    running.timer = setTimeout(() => inboundTrace(span.source, 'handler_wait', { ref: span.ref, batch_ref: span.batchRef,
      duration_ms: Math.round(performance.now() - startTick), result: 'still_waiting' }), INBOUND_SLOW_MS);
    running.timer.unref?.();
    return running;
  } catch { return null; }
}
function resumeIngressDiagnostics(service, msg, journalId, acceptedAt) {
  try {
    const now = Date.now(), tick = performance.now();
    const source = { instanceId: service.instanceId, instance: { name: service.instance.name },
      prismaRepository: service.prismaRepository, logger: service.logger, diagnosticOwner: diagnosticOwners.get(service) };
    const ref = inboundReference(source, msg.key?.id);
    if (!ref) return;
    const accepted = Date.parse(acceptedAt), age = Math.max(0, now - accepted);
    if (!Number.isSafeInteger(age)) return;
    // Fresh monotonic handler duration; durable queue age uses persisted wall
    // time. Never fabricate pre-restart receive/buffer monotonic timestamps.
    const sampled = parseInt(ref.slice(0, 2), 16) < 4;
    inboundSpans.set(msg, { source, ref, sampled, observedAt: now, observedTick: tick,
      receivedAt: null, receiveToObserve: null, stanzaClockDelta: null, bufferedAt: null, bufferedTick: null,
      enqueuedAt: accepted, enqueuedTick: tick - age, queueStartedAt: now, queueStartTick: tick,
      batchRef: journalId, category: 'durable_ingress' });
    if (sampled || age >= INBOUND_SLOW_MS) inboundTrace(source, 'journal_worker_started', {
      ref, batch_ref: journalId, queue_age_ms: age, category: 'durable_ingress', result: age >= INBOUND_SLOW_MS ? 'slow' : 'sampled' });
  } catch { /* Diagnostic handoff cannot authorize, block or retry ingress. */ }
}
function failInbound(span) { if (span) span.failed = true; }
function endInbound(span) {
  if (!span) return;
  clearTimeout(span.timer);
  const duration = Math.round(performance.now() - span.startTick), total = Math.round(performance.now() - span.observedTick);
  if (span.sampled) inboundTrace(span.source, 'handler_ended', { ref: span.ref, batch_ref: span.batchRef,
    duration_ms: duration, observed_to_end_ms: total, result: 'sampled' });
  if (span.failed || duration >= INBOUND_SLOW_MS || total >= INBOUND_SLOW_MS ||
      span.receiveToObserve >= INBOUND_SLOW_MS || span.stanzaClockDelta >= INBOUND_SLOW_MS)
    inboundTrace(span.source, 'handler_ended', { ref: span.ref, batch_ref: span.batchRef, observed_at_ms: span.observedAt,
      received_at_ms: span.receivedAt, receive_to_observe_ms: span.receiveToObserve, stanza_clock_delta_ms: span.stanzaClockDelta,
      buffered_at_ms: span.bufferedAt, enqueued_at_ms: span.enqueuedAt, queue_age_ms: span.queueAge,
      buffer_age_ms: span.bufferAge, pre_item_ms: span.preItem, duration_ms: duration,
      observed_to_end_ms: total, result: span.failed ? 'failed' : 'slow' });
}
async function timedInbound(span, stage, work) {
  if (!span) return work();
  const tick = performance.now();
  const timer = setTimeout(() => inboundTrace(span.source, stage, { ref: span.ref,
    batch_ref: span.batchRef, category: span.category,
    duration_ms: Math.round(performance.now() - tick), result: 'still_waiting' }), INBOUND_SLOW_MS);
  timer.unref?.();
  try {
    const result = await work();
    const duration = Math.round(performance.now() - tick);
    if (duration >= INBOUND_SLOW_MS) inboundTrace(span.source, stage, { ref: span.ref,
      batch_ref: span.batchRef, category: span.category, duration_ms: duration, result: 'slow' });
    return result;
  } catch (error) {
    inboundTrace(span.source, stage, { ref: span.ref, batch_ref: span.batchRef, category: span.category,
      duration_ms: Math.round(performance.now() - tick), result: 'failed' });
    throw error;
  } finally { clearTimeout(timer); }
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function envelopeSecret(source) {
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) fail('nexi_attendance_envelope_authentication_required');
  return createHmac('sha256', master).update(`event:${source.instance.name}`).digest();
}
function signEnvelope(source, claims, domain) {
  const encoded = Buffer.from(canonicalBytes(claims)).toString('base64url');
  return { claims: encoded, signature:createHmac('sha256', envelopeSecret(source)).update(`${domain}:v1:${encoded}`).digest('hex') };
}
function verifyEnvelope(source, envelope, domain, maxBytes = 16384) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'claims,signature' || typeof envelope.claims !== 'string' ||
      envelope.claims.length > maxBytes || !/^[A-Za-z0-9_-]+$/.test(envelope.claims) || !HASH.test(envelope.signature || ''))
    fail('nexi_attendance_envelope_authentication_required');
  const expected=createHmac('sha256',envelopeSecret(source)).update(`${domain}:v1:${envelope.claims}`).digest();
  if (!timingSafeEqual(expected,Buffer.from(envelope.signature,'hex'))) fail('nexi_attendance_envelope_authentication_required');
  const claims=decodeCanonicalClaims(envelope.claims);
  if (Buffer.from(canonicalBytes(claims)).toString('base64url')!==envelope.claims) fail('nexi_attendance_noncanonical_material');
  return claims;
}
function canonical(value) {
  // A validated transport structure only. Digests/wire fingerprints must use
  // canonicalBytes directly, never JSON.stringify of this parsed object.
  return JSON.parse(canonicalJson.bytes(value));
}
const canonicalBytes = canonicalJson.bytes;
const digest = canonicalJson.digest;
function canonicalVersion(value, source = {}) {
  if (value !== CANONICAL_VERSION) {
    log(source, 'attendance.canonical_version.unsupported'); fail('nexi_attendance_canonical_version_unsupported');
  }
}
const jid = value => typeof value === 'string' ? value.replace(/:\d{1,5}(?=@)/, '') : null;
function log(source, event, values = {}) {
  const safe = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    ['instance_id', 'preparation_id', 'attempt_id', 'journal_id', 'event_id', 'reason', 'state'].includes(key) &&
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)));
  if (source.logger?.warn) source.logger.warn({ event, ...safe });
  else console.warn(JSON.stringify({ event, ...safe }));
}
const WRITER_PROBE_STAGES = new Set(['request_received', 'signed_contract_validated', 'instance_socket_verified',
  'context_requested', 'authenticated_context_received', 'binding_fencing_validated', 'storage_guard_executed',
  'writer_isolation_proved', 'proof_response_produced']);
const WRITER_PROBE_PHASES = new Set(['instance_lookup', 'contract_validation', 'socket_validation', 'context_request_setup',
  'context_transport', 'context_response', 'context_authentication', 'context_storage', 'scoped_operation_validation', 'binding_validation', 'storage_guard',
  'writer_isolation', 'writer_socket_cas', 'writer_registration_validation', 'capture_context_installation',
  'writer_transaction_completion', 'writer_post_transaction_validation', 'response_production']);
const WRITER_PROBE_FAILURES = new Set(['nexi_attendance_envelope_authentication_required', 'nexi_attendance_noncanonical_material',
  'nexi_attendance_canonical_version_unsupported', 'nexi_attendance_authority_invalid', 'nexi_attendance_writer_unavailable',
  'nexi_attendance_boundary_invalid', 'nexi_attendance_binding_ambiguous', 'nexi_attendance_boundary_unavailable',
  'nexi_attendance_managed_binding_missing', 'nexi_attendance_contract_unsupported', 'nexi_attendance_contract_invalid',
  'nexi_attendance_event_limit', 'nexi_attendance_reservation_conflict', 'nexi_attendance_app_unresolved',
  'nexi_attendance_context_invalid', 'nexi_attendance_writer_binding_conflict', 'nexi_attendance_writer_isolation_unproved',
  'nexi_attendance_isolated_authority_invalid', 'nexi_attendance_capture_socket_mismatch',
  'nexi_attendance_capture_context_superseded', 'nexi_attendance_capture_context_regression']);
const WRITER_PROBE_ERROR_CLASSES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
  'TimeoutError', 'AbortError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientValidationError', 'PrismaClientInitializationError', 'PrismaClientRustPanicError']);
const WRITER_PROBE_RUNTIME_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2002', 'P2003', 'P2010', 'P2021',
  'P2022', 'P2024', 'P2028', 'P2034', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND']);
const WRITER_PROBE_REGRESSION_FIELDS = new Set(['account_id', 'inbox_id', 'managed_channel_id', 'writer_epoch',
  'binding_generation', 'barrier_state', 'instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id']);
function writerProbeErrorDetails(error) {
  try {
    const name = error?.name, code = error?.code;
    return { error_class: WRITER_PROBE_ERROR_CLASSES.has(name) ? name : 'OtherError',
      error_code: WRITER_PROBE_FAILURES.has(code) || WRITER_PROBE_RUNTIME_CODES.has(code) ? code : 'unclassified' };
  } catch { return { error_class: 'OtherError', error_code: 'unclassified' }; }
}
function writerProbeFailure(error) {
  try {
    const errorCode = error?.code;
    if (WRITER_PROBE_FAILURES.has(errorCode)) return errorCode;
    // These existing errors have no code. Match only exact allowlisted literals;
    // never emit the error message itself or classify arbitrary message text.
    const messages = { nexi_attendance_authority_storage_unguarded: 'storage_guard_rejected',
      nexi_event_secret_missing: 'event_authentication_unavailable', nexi_event_instance_missing: 'event_identity_unavailable' };
    if (Object.hasOwn(messages, error?.message)) return messages[error.message];
    const code = errorCode || error?.cause?.code;
    if (['TimeoutError', 'AbortError'].includes(error?.name) ||
        ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout';
    if (error?.name === 'SyntaxError') return 'invalid_response';
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) return 'transport_unavailable';
    return 'unexpected_failure';
  } catch { return 'unexpected_failure'; }
}
function writerProbeTrace(envelope) {
  try {
    // This untrusted action hint scopes logging only, before HMAC validation.
    if (typeof envelope?.claims !== 'string' || envelope.claims.length > 32768 ||
        JSON.parse(Buffer.from(envelope.claims, 'base64url').toString('utf8'))?.action !== 'writer_probe') return null;
    const correlation = digest(envelope).slice(0, 24);
    let lastStage = null, phase = 'instance_lookup';
    const emit = (event, values) => {
      try { console.warn(JSON.stringify({ event, operation: 'writer_probe', correlation, ...values })); }
      catch { /* Diagnostics must never affect authority or its response. */ }
    };
    return {
      attempt(value) { if (WRITER_PROBE_PHASES.has(value)) phase = value; },
      stage(value) {
        if (!WRITER_PROBE_STAGES.has(value)) return;
        lastStage = value;
        emit('attendance.writer_probe.stage', { stage: value });
      },
      socketChecks(read) {
        try {
          const safe = Object.fromEntries(Object.entries(read()).filter(([key, value]) =>
            ['material_valid', 'socket_open', 'owner_token_valid', 'lifecycle_current', 'session_matches'].includes(key) && typeof value === 'boolean'));
          emit('attendance.writer_probe.socket_checks', safe);
        } catch { /* A diagnostic read cannot replace the original checks. */ }
      },
      isolationChecks(read) {
        try {
          const safe = Object.fromEntries(Object.entries(read()).filter(([key, value]) =>
            ['database_socket_owner_matched', 'lifecycle_current_after_cas', 'socket_open_after_cas',
              'registration_present', 'registration_instance_id_matches', 'registration_instance_name_matches',
              'context_current_session', 'context_channel_active', 'context_session_matches', 'attestation_present',
              'attestation_session_matches', 'attestation_provenance_valid', 'lifecycle_current_after_transaction',
              'isolated_dispatch_enabled', 'composer_dispatch_enabled', 'scoped_composer'].includes(key) &&
            typeof value === 'boolean'));
          emit('attendance.writer_probe.isolation_checks', safe);
        } catch { /* Omit unavailable diagnostics; never affect isolation. */ }
      },
      attestationChecks(read) {
        try {
          const value = read();
          const safe = Object.fromEntries(Object.entries(value).filter(([key, item]) =>
            (key === 'status' && ATTESTATION_STATUSES.has(item)) ||
            (key === 'trigger' && ATTESTATION_TRIGGERS.has(item)) ||
            (['registration_present', 'credentials_object_matches', 'attestation_present', 'attestation_session_matches'].includes(key) &&
              typeof item === 'boolean')));
          emit('attendance.writer_probe.attestation', safe);
        } catch { /* Diagnostic state cannot authorize a writer. */ }
      },
      captureRegression(field) {
        if (WRITER_PROBE_REGRESSION_FIELDS.has(field)) emit('attendance.writer_probe.capture_regression', { field });
      },
      failure(error) {
        emit('attendance.writer_probe.rejected', { last_stage: lastStage, failure_stage: phase,
          category: writerProbeFailure(error), ...writerProbeErrorDetails(error) });
      },
      instanceMissing() {
        emit('attendance.writer_probe.rejected', { last_stage: lastStage, failure_stage: phase, category: 'instance_not_found', http_status: 404 });
      },
      contextHttp(status, result) {
        if (!Number.isInteger(status) || status < 100 || status > 599 || !['success', 'http_error'].includes(result)) return;
        emit('attendance.writer_probe.context_http', { http_status: status, result });
      },
      contextFailure(error) {
        emit('attendance.writer_probe.context_failed', { category: writerProbeFailure(error) });
      }
    };
  } catch { return null; }
}
function eventPayload(event, data) {
  if (!event.startsWith('attendance.')) return null;
  const operationContext = event === 'attendance.writer.context.request' && data && Object.hasOwn(data, 'isolated_authorization_id');
  // The UUID selects one operation in the signed APP context exchange; it
  // grants no authority itself. Keep every other event's exact shape intact.
  const renewalContext = event === 'attendance.writer.context.request' && data && Object.hasOwn(data, 'previous_sender_attestation_id');
  let fields = operationContext ? FIELDS[event].concat('isolated_authorization_id') : FIELDS[event];
  if (renewalContext) fields = fields.concat('previous_sender_attestation_id');
  const addressed = (event === 'attendance.foundation.request' || event === 'attendance.transport.prepared') &&
    data && Object.hasOwn(data, 'addressing_protocol_version');
  if (addressed) fields = fields.concat(ADDRESSING_FIELDS);
  if (!fields || !data || Object.keys(data).sort().join(',') !== [...fields].sort().join(',') ||
      data.version !== 1 || (data.protocol_version !== undefined && data.protocol_version !== 1)) fail('nexi_attendance_contract_unsupported');
  canonicalVersion(data.canonical_version);
  const normalized = canonical(data);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const external = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
  if (data.audience !== 'nexi-attendance-app' || data.provider !== 'evolution-baileys' || !positive(data.account_id))
    fail('nexi_attendance_contract_invalid');
  if (event === 'attendance.context.request' || event === 'attendance.writer.context.request') {
    if (!positive(data.inbox_id) || !UUID.test(data.nonce || '') || !HASH.test(data.session_identity || ''))
      fail('nexi_attendance_contract_invalid');
    if (event === 'attendance.writer.context.request' && !UUID.test(data.socket_owner || ''))
      fail('nexi_attendance_contract_invalid');
    if (operationContext && (typeof data.isolated_authorization_id !== 'string' || !UUID.test(data.isolated_authorization_id)))
      fail('nexi_attendance_contract_invalid');
    if (renewalContext && (typeof data.previous_sender_attestation_id !== 'string' || !UUID.test(data.previous_sender_attestation_id)))
      fail('nexi_attendance_contract_invalid');
  } else {
    const observation = event.startsWith('attendance.session.') || event === 'attendance.receipt.observed';
    if (!positive(data.managed_channel_id) || typeof data.instance_id !== 'string' || !data.instance_id.length || data.instance_id.length > 100 ||
        !HASH.test(data.session_identity || '') || ![1,2].includes(data.writer_protocol_version) ||
        !BARRIER_STATES.includes(data.barrier_state) ||
        !(data.original_session_identity === null || HASH.test(data.original_session_identity || '')) ||
        !['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id'].every(key =>
          observation && data[key] === null || UUID.test(data[key] || '')) ||
        !['writer_epoch', 'binding_generation'].every(key => observation && data[key] === null || positive(data[key])))
      fail('nexi_attendance_contract_invalid');
    if (event === 'attendance.foundation.request' || event === 'attendance.transport.prepared') {
      if (!UUID.test(data.execution_id || '') || !Number.isSafeInteger(data.transport_unit) || data.transport_unit < 0 ||
          !UUID.test(data.preparation_id || '') || !external(data.external_id) || !PN.test(data.recipient || '') ||
          !positive(data.identity_version_id) || !HASH.test(data.authority_digest || '') ||
          addressed && !validAddressing(data)) fail('nexi_attendance_contract_invalid');
      if (event === 'attendance.foundation.request') {
        if (!['attempt', 'reserve', 'readback', 'close_collision'].includes(data.action) || !UUID.test(data.request_id || '') ||
            !(data.action === 'attempt' && data.attempt_id === null || UUID.test(data.attempt_id || '')) ||
            !HASH.test(data.payload_digest || '') || !HASH.test(data.preparation_nonce_digest || '')) fail('nexi_attendance_contract_invalid');
      } else if (!['attempt_id', 'reservation_id'].every(key => UUID.test(data[key] || '')) ||
          !['content_digest', 'preparation_digest', 'preparation_nonce'].every(key => HASH.test(data[key] || '')) ||
          !positive(data.revision) || !positive(data.observed_at)) fail('nexi_attendance_contract_invalid');
    } else if (event.startsWith('attendance.session.')) {
      if (!UUID.test(data.observation_id || '') || !PN.test(data.canonical_pn || '') ||
          !(data.canonical_lid === null || LID.test(data.canonical_lid || '')) ||
          !['public_material_digest', 'registration_digest'].every(key => HASH.test(data[key] || '')) ||
          !['verified_pairing', 'verified_restored_account'].includes(data.provenance) || !positive(data.observed_at))
        fail('nexi_attendance_contract_invalid');
    } else if (event === 'attendance.media.request') {
      if (!['execution_id','attempt_id','preparation_id','reservation_id','grant_id','release_id'].every(k=>UUID.test(data[k]||'')) ||
          !external(data.external_id)) fail('nexi_attendance_media_identity_invalid');
    } else if (!UUID.test(data.journal_id || '') || !external(data.external_id) || ![PN, LID].some(r => r.test(data.remote_jid || '')) ||
        !(data.participant === null || [PN, LID].some(r => r.test(data.participant || ''))) || typeof data.from_me !== 'boolean' ||
        data.direction !== (data.from_me ? 'outgoing' : 'incoming') || !['ERROR', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED', 'UNKNOWN'].includes(data.normalized_status) ||
        (!data.from_me && data.normalized_status !== 'UNKNOWN') || !/^[a-z-]{1,32}$/.test(data.semantic_class || '') ||
        !(data.receipt_timestamp === null || Number.isSafeInteger(data.receipt_timestamp) && data.receipt_timestamp >= 0) ||
        !positive(data.captured_at) || !receiptMetadata(data) || !validDispatchProof(data))
      fail('nexi_attendance_contract_invalid');
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > 16384) fail('nexi_attendance_event_limit');
  return normalized;
}
function validAddressing(value) {
  const recipient = value.transport_recipient, representation = value.addressing_representation;
  return value.addressing_protocol_version === ADDRESSING_PROTOCOL_VERSION && recipient === value.recipient &&
    (representation === 'pn' && PN.test(recipient || '') || representation === 'lid' && LID.test(recipient || ''));
}
function validDispatchProof(data) {
  const proof = data.dispatch_proof;
  if (proof === null) return true;
  if (!data.from_me || !proof || typeof proof !== 'object' || Array.isArray(proof) ||
      Object.keys(proof).sort().join(',') !== [...DISPATCH_PROOF_KEYS].sort().join(',') || proof.version !== 1 ||
      proof.protocol !== 'nexi-attendance-dispatch-binding-v2' ||
      !['preparation_id','execution_id','attempt_id','reservation_id','grant_id','release_id','consumption_id'].every(k => UUID.test(proof[k] || '')) ||
      proof.external_id !== data.external_id || proof.stanza_id !== data.external_id ||
      proof.stanza_recipient !== proof.transport_recipient || !['pn','lid'].includes(proof.addressing_representation) ||
      !(proof.addressing_representation === 'pn' && PN.test(proof.transport_recipient || '') ||
        proof.addressing_representation === 'lid' && LID.test(proof.transport_recipient || '')) ||
      !positiveInteger(proof.identity_version_id) || proof.session_identity !== data.session_identity ||
      !Number.isSafeInteger(proof.dispatch_started_at) || proof.dispatch_started_at <= 0 ||
      proof.receipt_remote_jid !== data.remote_jid || ![PN,LID].some(pattern => pattern.test(proof.receipt_remote_jid || '')) ||
      proof.receipt_remote_jid_semantics !== 'opaque_authenticated_socket_observation') return false;
  const returned = proof.transport_response;
  return returned && typeof returned === 'object' && !Array.isArray(returned) &&
    Object.keys(returned).sort().join(',') === 'message_id,remote_jid' && returned.message_id === data.external_id &&
    returned.remote_jid === proof.transport_recipient;
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function receiptMetadata(data) {
  const metadata = data.protocol_metadata;
  if (!metadata || metadata.protocol !== 'baileys-7.0.0-rc13') return false;
  if (metadata.origin === 'baileys.handleReceipt.pre_buffer') return data.normalized_status !== 'ERROR' &&
    Object.keys(metadata).sort().join(',') === 'origin,protocol';
  return metadata.origin === 'baileys.handleBadAck.pre_buffer' &&
    Object.keys(metadata).sort().join(',') === 'error_category,error_code,origin,protocol' &&
    metadata.error_category === 'message_ack_error' &&
    (metadata.error_code === null || typeof metadata.error_code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(metadata.error_code)) &&
    data.semantic_class === 'message-ack-error' && data.normalized_status === (data.from_me ? 'ERROR' : 'UNKNOWN');
}
function common(context) {
  return Object.fromEntries(COMMON.map(key => [key, key === 'audience' ? 'nexi-attendance-app' : context[key] ?? null]));
}
function cutoverHeld(env = process.env, readRelease = file => require('node:fs').readFileSync(file, 'utf8')) {
  const composerFlag = env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED;
  if (composerFlag !== undefined && composerFlag !== 'false') return true;
  // Isolated mode never opens the normal lane, including partial rollout.
  const isolatedFlag = env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED;
  if (isolatedFlag !== undefined && isolatedFlag !== 'false') return true;
  const value = env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  if (value === undefined || value === 'false') return false;
  if (value !== 'true') return true; // Invalid configuration cannot be released.
  // The isolated lane cannot release commercial work via a legacy boot file.
  const boot = env.NEXI_ATTENDANCE_CUTOVER_BOOT_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(boot || '')) return true;
  try { return readRelease(`/tmp/nexi-attendance-cutover-${boot}.release`) !== `${boot}\n`; }
  catch { return true; }
}
function assertConfiguration(env = process.env) {
  const composer = env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED;
  if ((composer !== undefined && composer !== 'false' && composer !== 'true') ||
      (composer === 'true' && (env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED !== 'true' || env.NEXI_ATTENDANCE_CUTOVER_HOLD !== 'true')))
    fail('nexi_attendance_composer_configuration_invalid');
  const flag = env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED;
  if ((flag !== undefined && flag !== 'false' && flag !== 'true') ||
      (flag === 'true' && env.NEXI_ATTENDANCE_CUTOVER_HOLD !== 'true'))
    fail('nexi_attendance_isolated_configuration_invalid');
}
function settings(env = process.env) {
  assertConfiguration(env);
  const names = { queueItems: 'QUEUE_ITEMS', queueBytes: 'QUEUE_BYTES', concurrent: 'APPEND_CONCURRENCY',
    acquireMs: 'DB_ACQUISITION_TIMEOUT_MS', statementMs: 'DB_STATEMENT_TIMEOUT_MS', lockMs: 'DB_LOCK_TIMEOUT_MS',
    deadlineMs: 'APPEND_DEADLINE_MS', recoveryItems: 'RECOVERY_ITEMS', recoveryBytes: 'RECOVERY_BYTES' };
  const result = {};
  for (const [key, suffix] of Object.entries(names)) {
    const raw = env['NEXI_ATTENDANCE_' + suffix];
    if (!/^[1-9]\d{0,9}$/.test(raw || '') || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647)
      fail('nexi_attendance_receipt_limits_unconfigured');
    result[key] = Number(raw);
  }
  if (result.acquireMs >= result.deadlineMs || result.statementMs >= result.deadlineMs ||
      result.lockMs > result.statementMs || result.concurrent > result.queueItems) fail('nexi_attendance_receipt_limits_invalid');
  return Object.freeze(result);
}
function boundedMariaDb(factory, limits) {
  // The pinned adapter exposes its dedicated pool through underlyingDriver().
  // Use driver destruction at an absolute statement deadline for real MySQL
  // writes, where MariaDB's queryTimeout/max_statement_time is unavailable.
  // This does not kill the shared Evolution pool or claim commit certainty.
  return { provider: factory.provider, adapterName: factory.adapterName, async connect() {
    const adapter = await factory.connect(), pool = adapter.underlyingDriver?.();
    if (!pool || typeof pool.getConnection !== 'function') fail('nexi_attendance_driver_boundary_changed');
    const getConnection = pool.getConnection.bind(pool), wrapped = new WeakSet();
    pool.getConnection = async (...args) => {
      const connection = await getConnection(...args);
      if (wrapped.has(connection)) return connection;
      if (typeof connection.destroy !== 'function' || !['query', 'execute'].every(key => typeof connection[key] === 'function'))
        fail('nexi_attendance_driver_boundary_changed');
      wrapped.add(connection);
      for (const method of ['query', 'execute']) {
        const run = connection[method].bind(connection);
        connection[method] = (...values) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            try { connection.destroy(); } catch { /* bounded caller still returns */ }
            reject(Object.assign(new Error('nexi_attendance_statement_deadline'), { code: 'NEXI_STATEMENT_DEADLINE' }));
          }, limits.statementMs);
          Promise.resolve().then(() => run(...values)).then(resolve, reject).finally(() => clearTimeout(timer));
        });
      }
      return connection;
    };
    return adapter;
  } };
}
async function boundary(source) {
  const webhook = await source.prismaRepository.webhook.findUnique({ where: { instanceId: source.instanceId } });
  if (!webhook) return null;
  let url;
  try { url = new URL(webhook.url); } catch { return null; }
  if (url.pathname !== '/webhooks/nexi/channels/evolution') return null;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      webhook.webhookByEvents || webhook.webhookBase64) fail('nexi_attendance_boundary_invalid');
  const headers = webhook.headers || {};
  if (!/^[1-9]\d*$/.test(headers['X-Nexi-Chatwoot-Account-Id'] || '') ||
      !/^[1-9]\d*$/.test(headers['X-Nexi-Chatwoot-Inbox-Id'] || '')) fail('nexi_attendance_binding_ambiguous');
  return { url, headers, enabled: webhook.enabled };
}
async function request(source, data, event = 'attendance.foundation.request', fetchImpl = fetch, eventId = randomUUID(), writerProbe = null) {
  const destination = await boundary(source);
  if (!destination?.enabled) fail('nexi_attendance_boundary_unavailable');
  const transport = require('./nexi-transport.cjs');
  const body = { event, instance: source.instance.name, data: eventPayload(event, data) };
  const prepared = transport.prepareEvent(destination.headers, body, source.instance.name, source.instanceId);
  prepared.headers['X-Nexi-Event-Id'] = eventId;
  const probe = event === 'attendance.writer.context.request' ? writerProbe : null;
  let response;
  try {
    const options = { method: 'POST', redirect: 'error',
      headers: transport.freshEventHeaders(prepared.headers, prepared.body), body: canonicalBytes(prepared.body),
      signal: AbortSignal.timeout(10000) };
    probe?.attempt('context_transport');
    probe?.stage('context_requested');
    response = await fetchImpl(destination.url, options);
  } catch (error) { probe?.contextFailure(error); throw error; }
  probe?.contextHttp(response.status, response.ok ? 'success' : 'http_error');
  if (!response.ok) fail(response.status === 409 ? 'nexi_attendance_reservation_conflict' : 'nexi_attendance_app_unresolved');
  if (!probe) return response.json();
  probe.attempt('context_response');
  try { return await response.json(); }
  catch (error) { probe.contextFailure(error); throw error; }
}
function verifyContext(source, envelope, nonce, session, previousAttestationId = null) {
  if (!envelope || typeof envelope.claims !== 'string' || envelope.claims.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.claims) || !HASH.test(envelope.signature || '')) fail('nexi_attendance_context_invalid');
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) fail('nexi_attendance_context_invalid');
  const secret = createHmac('sha256', master).update(`event:${source.instance.name}`).digest();
  const expected = createHmac('sha256', secret).update(`attendance-context:v1:${envelope.claims}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex'))) fail('nexi_attendance_context_invalid');
  const context = decodeCanonicalClaims(envelope.claims);
  canonicalVersion(context.canonical_version, source);
  const keys = [...COMMON, 'nonce', 'inbox_id', 'instance', 'channel_state', 'current_session', 'physical_dispatch', 'isolation_cutover'];
  if (Object.hasOwn(context, 'isolated_operation')) keys.push('isolated_operation');
  if (Object.hasOwn(context, 'sender_attestation_renewal')) keys.push('sender_attestation_renewal');
  if (Object.keys(context).sort().join(',') !== keys.sort().join(',') || context.version !== 1 || context.protocol_version !== 1 ||
      context.audience !== 'nexi-attendance-evolution' || context.provider !== 'evolution-baileys' || context.nonce !== nonce ||
      context.instance !== source.instance.name || context.instance_id !== source.instanceId || context.session_identity !== session ||
      ![true,false].includes(context.physical_dispatch) || ![true,false].includes(context.isolation_cutover) ||
      (context.physical_dispatch && (!context.isolation_cutover || context.barrier_state !== 'active' || context.writer_protocol_version !== 2)) ||
      !['account_id', 'inbox_id', 'managed_channel_id'].every(key => Number.isSafeInteger(context[key]) && context[key] > 0) ||
      !['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id'].every(key => context[key] === null || UUID.test(context[key] || '')) ||
      !['binding_generation', 'writer_epoch'].every(key => context[key] === null || Number.isSafeInteger(context[key]) && context[key] > 0) ||
      ![1,2].includes(context.writer_protocol_version) || !BARRIER_STATES.includes(context.barrier_state) ||
      typeof context.current_session !== 'boolean' || !['active', 'disabled', 'removed'].includes(context.channel_state) ||
      !(context.original_session_identity === null || HASH.test(context.original_session_identity || '')))
    fail('nexi_attendance_context_invalid');
  if (Object.hasOwn(context, 'isolated_operation')) require('./nexi-attendance-isolated.cjs').context(source, context, context.isolated_operation, Date.now());
  if (Object.hasOwn(context, 'sender_attestation_renewal')) {
    const proof = context.sender_attestation_renewal, now = Date.now();
    if (!proof || Object.keys(proof).sort().join(',') !== 'expires_at,from_attestation_id,to_attestation_id,version' ||
        proof.version !== 1 || !UUID.test(previousAttestationId || '') || proof.from_attestation_id !== previousAttestationId ||
        !UUID.test(proof.to_attestation_id || '') || proof.to_attestation_id !== context.sender_attestation_id ||
        proof.from_attestation_id === proof.to_attestation_id || !Number.isSafeInteger(proof.expires_at) ||
        proof.expires_at <= now || proof.expires_at > now + 60000) fail('nexi_attendance_context_invalid');
    authenticatedAttestationRenewals.set(context, Object.freeze({...proof}));
  }
  return context;
}
async function refreshContext(source, session, fetchImpl = fetch, socketOwner = null, writerProbe = null, authorizationId = null, previousAttestationId = null) {
  const destination = await boundary(source);
  const db = source.prismaRepository.nexiManagedTransportContext;
  if (!destination) {
    const historical = await db.findFirst({ where: { OR: [{ instanceId: source.instanceId }, { instanceName: source.instance.name }] } });
    if (historical) fail('nexi_attendance_managed_binding_missing');
    return null;
  }
  const nonce = randomUUID();
  const envelope = await request(source, { version: 1, canonical_version: CANONICAL_VERSION, audience: 'nexi-attendance-app', provider: 'evolution-baileys',
    account_id: Number(destination.headers['X-Nexi-Chatwoot-Account-Id']), inbox_id: Number(destination.headers['X-Nexi-Chatwoot-Inbox-Id']),
    nonce, session_identity: session, ...(socketOwner ? {socket_owner:socketOwner} : {}),
    ...(authorizationId ? {isolated_authorization_id:authorizationId} : {}),
    ...(previousAttestationId ? {previous_sender_attestation_id:previousAttestationId} : {}) },
    socketOwner ? 'attendance.writer.context.request' : 'attendance.context.request', fetchImpl, nonce, writerProbe);
  writerProbe?.attempt('context_authentication');
  const context = verifyContext(source, envelope, nonce, session, previousAttestationId);
  writerProbe?.stage('authenticated_context_received');
  writerProbe?.attempt('context_storage');
  // Nonce authenticates the exchange, not classification identity.
  const renewal = authenticatedAttestationRenewals.get(context);
  const durable = { ...context }; delete durable.nonce; delete durable.sender_attestation_renewal;
  const fingerprint = digest(durable);
  const previous = await db.findUnique({ where: { fingerprint } });
  if (previous) canonicalVersion(previous.canonicalVersion, source);
  else try { await db.create({ data: { id: randomUUID(), instanceId: source.instanceId, instanceName: source.instance.name,
    managedChannelId: String(context.managed_channel_id), sessionIdentity: session, fingerprint, payload: durable,
    canonicalVersion: CANONICAL_VERSION } }); }
  catch (error) { if (error.code !== 'P2002') throw error; }
  const result = previous ? previous.payload : durable;
  if (renewal) {
    if (digest(result) !== fingerprint) fail('nexi_attendance_context_invalid');
    authenticatedAttestationRenewals.set(result, Object.freeze({...renewal, context_digest:fingerprint}));
  }
  return result;
}

// No private key, creds object, registration secret or Signal state leaves this
// function. Verification is re-run for restored account public material.
function verifyPublicAccountSignature(key, bytes, signature) {
  // rc13 Curve.verify ignores libsignal's boolean result. Require the actual
  // primitive's positive result; the Signal public key version byte is 0x05.
  return require('libsignal/src/curve.js').verifySignature(Buffer.concat([Buffer.from([5]), key]), bytes, signature) === true;
}
function restoredAccountBytes(value, provenance) {
  // rc13 ADVSignedDeviceIdentity.toJSON runs before BufferJSON.replacer and
  // emits canonical Base64 strings. BufferJSON.reviver leaves those strings
  // intact. Restore only that bounded encoding at the restored-account hook;
  // never mutate credentials, invent absent bytes or infer another encoding.
  if (provenance !== 'verified_restored_account' || typeof value !== 'string' || value.length > 1368 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return value;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : value;
}
function publicAttestation(credentials, verify, prefixes, provenance = 'verified_restored_account', observedAt = Date.now(), diagnose) {
  const report = status => { try { diagnose?.(status); } catch { /* Diagnostics confer no authority. */ } };
  const absent = status => { report(status); return null; };
  const account = credentials?.account;
  const session = identity.sessionFingerprint(credentials), pn = jid(credentials?.me?.id), lid = jid(credentials?.me?.lid);
  if (!session) return absent('session_material_unavailable');
  if (!PN.test(pn || '') || (lid && !LID.test(lid))) return absent('account_identity_invalid');
  if (!account) return absent('account_material_unavailable');
  const key = restoredAccountBytes(account.accountSignatureKey, provenance);
  if (key == null) return absent('account_signature_key_missing');
  if (!(key instanceof Uint8Array)) return absent('account_signature_key_wrong_type');
  if (key.length !== 32) return absent('account_signature_key_wrong_length');
  const signature = restoredAccountBytes(account.accountSignature, provenance);
  const details = restoredAccountBytes(account.details, provenance);
  if (!(signature instanceof Uint8Array) || signature.length !== 64)
    return absent('account_signature_invalid');
  if (!(details instanceof Uint8Array) || details.length > 1024 || !details.length)
    return absent('account_details_invalid');
  let prefix;
  try { prefix = prefixes(details); }
  catch (error) { report('account_details_decode_failed'); throw error; }
  const bytes = Buffer.concat([prefix, details, credentials.signedIdentityKey.public]);
  let verified;
  try { verified = verify(key, bytes, signature); }
  catch (error) { report('signature_verifier_failed'); throw error; }
  if (verified !== true) return absent('signature_rejected');
  report('verified');
  return Object.freeze({ observation_id: randomUUID(), session_identity: session, canonical_pn: pn, canonical_lid: lid || null,
    public_material_digest: digest({ public_key: Buffer.from(key).toString('base64'),
      signature: Buffer.from(signature).toString('base64'), details: Buffer.from(details).toString('base64') }),
    registration_digest: digest({ registration_id: credentials.registrationId, session_identity: session }),
    provenance, observed_at: observedAt });
}
const ATTESTATION_STATUSES = new Set(['not_observed', 'session_material_unavailable', 'account_identity_invalid',
  'account_material_unavailable', 'account_signature_key_missing', 'account_signature_key_wrong_type',
  'account_signature_key_wrong_length', 'account_signature_invalid', 'account_details_invalid',
  'account_details_decode_failed', 'signature_verifier_failed', 'signature_rejected', 'verified', 'unexpected_failure']);
const ATTESTATION_TRIGGERS = new Set(['verified_pairing', 'verified_restored_account']);
function attestationDiagnostic(config, status, trigger) {
  if (!ATTESTATION_STATUSES.has(status) || !ATTESTATION_TRIGGERS.has(trigger)) return;
  const registration = configs.get(config);
  if (registration) registration.attestationDiagnostic = { status, trigger };
  // No account identifiers, session fingerprints, keys, signature, creds or raw errors.
  try { console.warn(JSON.stringify({ event: 'attendance.attestation.observation', status, trigger,
    registration_present: !!registration })); } catch { /* Diagnostics cannot change lifecycle. */ }
}
function observePublicAccount(config, credentials, verify, prefixes, provenance) {
  let status = 'unexpected_failure';
  try {
    const attestation = publicAttestation(credentials, verify, prefixes, provenance, Date.now(), value => { status = value; });
    attestationDiagnostic(config, status, provenance);
    return sessionObserved(config, attestation);
  } catch (error) {
    attestationDiagnostic(config, status === 'verified' ? 'unexpected_failure' : status, provenance);
    throw error; // Preserve the existing pinned hook's failure handling.
  }
}
async function enqueue(tx, source, context, event, material, sourceKey) {
  const data = eventPayload(event, { ...common(context), ...material });
  const body = canonical({ event, instance: source.instance.name, data });
  const fingerprint = digest(body), db = tx.nexiAttendanceEventOutbox;
  const previous = await db.findUnique({ where: { instanceId_sourceKey: { instanceId: source.instanceId, sourceKey } } });
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('nexi_attendance_outbox_identity_conflict');
    canonicalVersion(previous.canonicalVersion, source);
    return previous;
  }
  return db.create({ data: { id: randomUUID(), canonicalVersion: CANONICAL_VERSION, instanceId: source.instanceId, instanceName: source.instance.name,
    sessionIdentity: context.session_identity, eventType: event, version: 1, sourceKey, fingerprint, body,
    state: 'pending', nextAttemptAt: new Date() } });
}
async function observe(source, context, attestation) {
  if (!context || !attestation) return;
  return source.prismaRepository.$transaction(tx => enqueue(tx, source, context, 'attendance.session.proved',
    attestation, digest(['session', context.instance_lineage_id, attestation.session_identity, attestation.observation_id])));
}
function normalization(type) {
  if (type === 'sender') return 'SERVER_ACK';
  if (type === undefined) return 'DELIVERY_ACK';
  if (type === 'read' || type === 'read-self') return 'READ';
  if (type === 'played') return 'PLAYED';
  return 'UNKNOWN';
}
function numericNormalization(status) {
  return Number.isInteger(status) ? ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'][status] || 'UNKNOWN' : 'UNKNOWN';
}
function dispatchProof(row, context, externalId, observedRemoteJid) {
  const intent = row?.intent, released = row?.releasedAuthority, grant = released?.grant, release = released?.release;
  if (!row?.dispatchStartedAt || !row.outcomeUnknown || !['dispatch_started','transport_returned','outcome_unknown'].includes(row.state) ||
      intent?.addressing_protocol_version !== ADDRESSING_PROTOCOL_VERSION || !validAddressing(intent) ||
      ![PN,LID].some(pattern => pattern.test(observedRemoteJid || '')) ||
      row.externalId !== externalId || row.recipient !== intent.transport_recipient || row.sessionIdentity !== context.session_identity ||
      row.consumptionId !== released?.consumption_id || canonicalJson.digest(grant) !== released?.grant_digest ||
      canonicalJson.digest(release) !== released?.release_digest ||
      !['preparation_id','execution_id','attempt_id','reservation_id','grant_id'].every(key => UUID.test(grant?.[key] || '')) ||
      !UUID.test(release?.release_id || '') || !UUID.test(row.consumptionId || '') ||
      grant.preparation_id !== row.id || grant.execution_id !== row.executionId || grant.attempt_id !== row.attemptId ||
      grant.reservation_id !== row.reservationId || grant.external_id !== row.externalId || release.external_id !== row.externalId ||
      release.preparation_id !== row.id || release.attempt_id !== row.attemptId || release.reservation_id !== row.reservationId ||
      grant.identity_version_id !== intent.identity_version_id || grant.session_identity !== row.sessionIdentity ||
      ADDRESSING_FIELDS.some(key => grant[key] !== intent[key])) return null;
  const returned = row.transportReturn;
  if (returned?.boundary_returned !== true || returned.succeeded !== true || returned.message_id !== row.externalId ||
      returned.remote_jid !== row.recipient) return null;
  const transportResponse = {message_id:returned.message_id,remote_jid:returned.remote_jid};
  return {version:1,protocol:'nexi-attendance-dispatch-binding-v2',preparation_id:row.id,execution_id:row.executionId,
    attempt_id:row.attemptId,reservation_id:row.reservationId,grant_id:grant.grant_id,release_id:release.release_id,
    consumption_id:row.consumptionId,external_id:row.externalId,stanza_id:row.externalId,stanza_recipient:row.recipient,
    transport_recipient:intent.transport_recipient,addressing_representation:intent.addressing_representation,
    identity_version_id:intent.identity_version_id,session_identity:row.sessionIdentity,
    dispatch_started_at:+row.dispatchStartedAt,receipt_remote_jid:observedRemoteJid,
    receipt_remote_jid_semantics:'opaque_authenticated_socket_observation',transport_response:transportResponse};
}
async function receiptDispatchProofs(source, ids, context, observedRemoteJid) {
  const externalIds = [...new Set(ids)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(id));
  if (!externalIds.length) return new Map();
  const rows = await source.prismaRepository.nexiAttendancePreparation.findMany({where:{
    instanceId:source.instanceId,externalId:{in:externalIds},dispatchStartedAt:{not:null}}});
  return new Map(rows.map(row => [row.externalId, dispatchProof(row, context, row.externalId, observedRemoteJid)]).filter(([,proof]) => proof));
}
function normalizeReceipt(context, attrs, key, ids, capturedAt = Date.now(), dispatchProofs = new Map()) {
  if (!context || !HASH.test(context.session_identity || '') || ![PN, LID].some(r => r.test(jid(key.remoteJid) || '')) ||
      typeof key.fromMe !== 'boolean' || !Array.isArray(ids) || ids.length > 128) return [];
  const semantic = attrs.type == null ? 'no-type' : /^[a-z-]{1,32}$/.test(attrs.type) ? attrs.type : 'unrecognized';
  const remote = jid(key.remoteJid), participant = jid(key.participant);
  const timestamp = typeof attrs.t === 'string' && /^\d{1,12}$/.test(attrs.t) ? Number(attrs.t) : null;
  return [...new Set(ids)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(id)).map(externalId => {
    const evidence = { ...common(context), journal_id: null, external_id: externalId, remote_jid: remote,
      participant: participant && [PN, LID].some(r => r.test(participant)) ? participant : null, from_me: key.fromMe,
      direction: key.fromMe ? 'outgoing' : 'incoming', semantic_class: semantic,
      normalized_status: key.fromMe ? normalization(attrs.type) : 'UNKNOWN', receipt_timestamp: timestamp,
      captured_at: capturedAt, protocol_metadata: { origin: 'baileys.handleReceipt.pre_buffer', protocol: 'baileys-7.0.0-rc13' },
      dispatch_proof: key.fromMe ? dispatchProofs.get(externalId) || null : null };
    // Capture time/UUID do not alter source dedupe. Missing timestamp stays
    // explicit; neither a direction guess nor numeric fallback promotes ACK.
    const sourceKey = digest({ ...evidence, journal_id: null, captured_at: null });
    return { sourceKey, evidence };
  });
}
function normalizeBadAck(context, attrs, key, ids, capturedAt = Date.now(), dispatchProofs = new Map()) {
  if (!attrs.error) return [];
  return normalizeReceipt(context, attrs, key, ids, capturedAt, dispatchProofs).map(item => {
    const evidence = { ...item.evidence, semantic_class: 'message-ack-error',
      normalized_status: key.fromMe ? 'ERROR' : 'UNKNOWN', protocol_metadata: {
        origin: 'baileys.handleBadAck.pre_buffer', protocol: 'baileys-7.0.0-rc13',
        error_category: 'message_ack_error', error_code: typeof attrs.error === 'string' &&
          /^[A-Za-z0-9_-]{1,32}$/.test(attrs.error) ? attrs.error : null } };
    return { evidence, sourceKey: digest({ ...evidence, journal_id: null, captured_at: null }) };
  });
}
async function trip(source, reason) {
  const worker = workers.get(source.instanceId);
  if (worker) worker.unhealthy = true;
  log(source, 'attendance.evidence_gap', { instance_id: source.instanceId, reason });
  // Socket processing must never wait for health persistence after a DB gap.
  // Restart also defaults unhealthy until durable health can be read.
  if (healthWrites.has(source.instanceId)) return;
  const work = Promise.resolve().then(() => source.prismaRepository.nexiAttendanceHealth.upsert({ where: { instanceId: source.instanceId },
    create: { instanceId: source.instanceId, unhealthy: true, reason, firstGapAt: new Date(), lastGapAt: new Date() },
    update: { unhealthy: true, reason, lastGapAt: new Date(), revision: { increment: 1 } } }));
  healthWrites.set(source.instanceId, work);
  try { await work; } catch { /* explicit gap remains */ }
  finally { healthWrites.delete(source.instanceId); }
}
async function persistPromotedReceipt(tx, source, preparation, journal) {
  const original = journal?.evidence;
  if (!original || original.dispatch_proof !== null || original.from_me !== true ||
      original.external_id !== preparation.externalId || original.session_identity !== preparation.sessionIdentity ||
      journal.instanceId !== source.instanceId || journal.externalId !== preparation.externalId ||
      journal.sessionIdentity !== preparation.sessionIdentity || journal.fingerprint !== digest(original) ||
      ![PN,LID].some(pattern => pattern.test(original.remote_jid || ''))) return null;
  const proof = dispatchProof(preparation, original, original.external_id, original.remote_jid);
  if (!proof) return null;
  // Promotion creates new immutable evidence. The original null-proof journal
  // remains the durable receipt captured before the transport method returned.
  const material = {...original,journal_id:null,dispatch_proof:proof};
  const sourceKey = digest({...material,captured_at:null});
  const previous = await tx.nexiReceiptJournal.findUnique({where:{instanceId_sourceKey:{
    instanceId:source.instanceId,sourceKey}}});
  if (previous) { canonicalVersion(previous.canonicalVersion, source); return previous; }
  const id=randomUUID(), evidence={...material,journal_id:id};
  const promoted=await tx.nexiReceiptJournal.create({data:{id,canonicalVersion:CANONICAL_VERSION,instanceId:source.instanceId,
    sessionIdentity:preparation.sessionIdentity,sourceKey,fingerprint:digest(evidence),externalId:evidence.external_id,
    normalizedStatus:evidence.normalized_status,evidence}});
  await enqueue(tx,source,original,'attendance.receipt.observed',evidence,sourceKey);
  return promoted;
}
async function promotePendingReceipts(tx, source, preparation, candidates = null) {
  if (preparation?.intent?.addressing_protocol_version !== ADDRESSING_PROTOCOL_VERSION ||
      preparation?.transportReturn?.boundary_returned !== true || preparation.transportReturn.succeeded !== true ||
      preparation.transportReturn.message_id !== preparation.externalId ||
      preparation.transportReturn.remote_jid !== preparation.recipient) return [];
  const journals=candidates || await tx.nexiReceiptJournal.findMany({where:{instanceId:source.instanceId,
    externalId:preparation.externalId},orderBy:{createdAt:'asc'},take:128});
  const promoted=[];
  for (const journal of journals) {
    const result=await persistPromotedReceipt(tx,source,preparation,journal);
    if (result) promoted.push(result);
  }
  return promoted;
}
async function append(source, context, item, limits) {
  const repo = source.receiptRepository;
  if (!repo) fail('nexi_attendance_receipt_repository_unavailable');
  return repo.$transaction(async tx => {
    const provider = process.env.DATABASE_PROVIDER || 'postgresql';
    if (provider === 'mysql') {
      // MySQL has no universal PostgreSQL-style write statement_timeout.
      // The dedicated driver's absolute operation/socket timeout bounds statements;
      // server lock timeout also bounds lock acquisition independently.
      await tx.$executeRawUnsafe(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(limits.lockMs / 1000))}`);
    } else {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${limits.statementMs}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${limits.lockMs}`);
    }
    let preparation=await tx.nexiAttendancePreparation.findUnique({where:{instanceId_externalId:{
      instanceId:source.instanceId,externalId:item.evidence.external_id}}});
    if (preparation?.intent?.addressing_protocol_version === ADDRESSING_PROTOCOL_VERSION) {
      // Use the same provider-aware row lock as dispatchStart/expiryReadback.
      // The immutable preparation guard rejects every UPDATE without revision+1.
      const locked=await tx.$queryRawUnsafe(provider === 'mysql' ?
        'SELECT id FROM NexiAttendancePreparation WHERE id=? FOR UPDATE' :
        'SELECT id FROM "NexiAttendancePreparation" WHERE id=$1 FOR UPDATE',preparation.id);
      if (!Array.isArray(locked) || locked.length !== 1) fail('nexi_attendance_receipt_preparation_unresolved');
      preparation=await tx.nexiAttendancePreparation.findUnique({where:{id:preparation.id}});
    }
    const previous = await tx.nexiReceiptJournal.findUnique({ where: { instanceId_sourceKey: {
      instanceId: source.instanceId, sourceKey: item.sourceKey } } });
    if (previous) {
      canonicalVersion(previous.canonicalVersion, source);
      if (preparation) await promotePendingReceipts(tx,source,preparation,[previous]);
      return previous;
    }
    const id = randomUUID(), evidence = { ...item.evidence, journal_id: id };
    const row = await tx.nexiReceiptJournal.create({ data: { id, canonicalVersion: CANONICAL_VERSION, instanceId: source.instanceId,
      sessionIdentity: context.session_identity, sourceKey: item.sourceKey, fingerprint: digest(evidence),
      externalId: evidence.external_id, normalizedStatus: evidence.normalized_status, evidence } });
    await enqueue(tx, source, context, 'attendance.receipt.observed', evidence, item.sourceKey);
    if (preparation) await promotePendingReceipts(tx,source,preparation,[row]);
    return row;
  }, { maxWait: limits.acquireMs, timeout: Math.min(limits.statementMs, limits.deadlineMs) });
}
class ReceiptWorker {
  constructor(source, limits, appendImpl = append) {
    this.source = source; this.limits = limits; this.appendImpl = appendImpl;
    this.diagnosticSource = source;
    this.queue = []; this.bytes = 0; this.active = 0; this.activeBytes = 0;
    this.recovery = new Map(); this.recoveryBytes = 0; this.unhealthy = false;
  }
  gap(reason, item, context) {
    this.unhealthy = true;
    receiptTrace(this.diagnosticSource, 'append_gap', { reason,
      ref: item?.evidence?.external_id ? inboundReference(this.source, item.evidence.external_id) : null });
    if (item && !this.recovery.has(item.sourceKey) && this.recovery.size < this.limits.recoveryItems &&
        this.recoveryBytes + item.size <= this.limits.recoveryBytes) {
      this.recovery.set(item.sourceKey, { item, context }); this.recoveryBytes += item.size;
    }
    void trip(this.source, reason);
    if (item?.evidence?.protocol_metadata?.origin === 'baileys.handleBadAck.pre_buffer')
      log(this.source, 'attendance.bad_ack.journal_failed', { reason });
  }
  submit(context, item) {
    item = { ...item, size: Buffer.byteLength(JSON.stringify(item)) };
    if (this.queue.length + this.active >= this.limits.queueItems ||
        this.bytes + this.activeBytes + item.size > this.limits.queueBytes) {
      this.gap('queue_saturated', item, context); return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const job = { context, item, resolve, expired: false, queuedTick: performance.now() };
      job.timer = setTimeout(() => {
        job.expired = true; this.gap('append_deadline', item, context); resolve(false);
      }, this.limits.deadlineMs);
      this.queue.push(job); this.bytes += item.size; this.pump();
    });
  }
  pump() {
    while (this.active < this.limits.concurrent && this.queue.length) {
      const job = this.queue.shift(); this.bytes -= job.item.size;
      if (job.expired) { clearTimeout(job.timer); continue; }
      this.active++; this.activeBytes += job.item.size;
      const diagnosticSource = this.diagnosticSource;
      const queueAge = Math.round(performance.now() - job.queuedTick), appendTick = performance.now();
      if (queueAge >= INBOUND_SLOW_MS) receiptTrace(diagnosticSource, 'append_started', { queue_age_ms: queueAge });
      const timer = setTimeout(() => receiptTrace(diagnosticSource, 'append_wait', { reason: 'append_waiting',
        duration_ms: Math.round(performance.now() - appendTick) }), INBOUND_SLOW_MS);
      timer.unref?.();
      Promise.resolve().then(() => this.appendImpl(this.source, job.context, job.item, this.limits)).then(row => {
        job.resolve(true);
        countReceipt(diagnosticSource, 'append_committed');
        const ref = inboundReference(this.source, job.item.evidence?.external_id);
        if (ref && parseInt(ref.slice(0, 2), 16) < 4)
          receiptTrace(diagnosticSource, 'append_committed', { ref, journal_id: row?.id, result: 'sampled' });
        const duration = Math.round(performance.now() - appendTick);
        if (duration >= INBOUND_SLOW_MS) receiptTrace(diagnosticSource, 'append_ended', { duration_ms: duration, queue_age_ms: queueAge });
        if (job.item.evidence?.protocol_metadata?.origin === 'baileys.handleBadAck.pre_buffer')
          log(this.source, 'attendance.bad_ack.captured', { journal_id: row?.id });
      }, error => {
        // A competing append may have committed the same persistent identity.
        // Leave finite recovery to retry/readback, never a WhatsApp send.
        this.gap(error.code === 'P2002' ? 'append_duplicate_race' : 'append_failed', job.item, job.context); job.resolve(false);
        receiptTrace(diagnosticSource, 'append_ended', { reason: 'append_failed',
          duration_ms: Math.round(performance.now() - appendTick), queue_age_ms: queueAge });
      }).finally(() => {
        clearTimeout(timer); clearTimeout(job.timer); this.active--; this.activeBytes -= job.item.size; this.pump();
      });
      // A timed-out DB promise still occupies its slot until settlement. It
      // cannot create an unbounded tail of unresolved append operations.
    }
  }
  async recover() {
    if (this.active || this.queue.length) return;
    const first = this.recovery.entries().next().value;
    if (!first) return;
    const [key, { item, context }] = first;
    this.recovery.delete(key); this.recoveryBytes -= item.size;
    await this.submit(context, item); // idempotent append; circuit remains sticky
  }
}
async function capture(config, attrs, key, ids, normalize = normalizeReceipt) {
  const registration = configs.get(config);
  if (!registration) { receiptTrace({}, 'pre_buffer', { reason: 'registration_missing' }); return; }
  const { source, context } = registration;
  if (![PN, LID].some(pattern => pattern.test(jid(key?.remoteJid) || ''))) {
    receiptTrace(source, 'pre_buffer', { reason: 'unsupported_address' }); return;
  }
  if (!context) {
    if (registration.ambiguous) {
      log(source, 'attendance.receipt.classification_failed', { instance_id: source.instanceId });
      void trip(source, 'receipt_classification_unresolved');
    }
    receiptTrace(source, 'pre_buffer', { reason: 'context_unavailable' });
    return;
  }
  if (!source.receiptRepository) {
    receiptTrace(source, 'pre_buffer', { reason: 'receipt_repository_unavailable' });
    void trip(source, 'receipt_repository_unavailable'); return;
  }
  let worker = workers.get(source.instanceId);
  if (!worker) {
    try { worker = new ReceiptWorker(source, settings()); workers.set(source.instanceId, worker); }
    catch {
      receiptTrace(source, 'pre_buffer', { reason: 'receipt_limits_unconfigured' });
      void trip(source, 'receipt_limits_unconfigured'); return;
    }
  }
  let evidence;
  let dispatchProofs = new Map();
  try { dispatchProofs = await receiptDispatchProofs(source, ids, context, jid(key?.remoteJid)); }
  catch { receiptTrace(source, 'pre_buffer', { reason: 'dispatch_proof_unavailable' }); }
  try { evidence = normalize(context, attrs, key, ids, Date.now(), dispatchProofs); }
  catch (error) { receiptTrace(source, 'pre_buffer', { reason: 'normalization_failed' }); throw error; }
  if (ids.length > 128) worker.gap('receipt_packet_limit');
  if (ids.length && !evidence.length) receiptTrace(source, 'pre_buffer', { reason: 'normalization_empty' });
  for (const item of evidence) {
    countReceipt(source, 'pre_buffer_observed');
    const ref = inboundReference(source, item.evidence.external_id);
    if (ref && parseInt(ref.slice(0, 2), 16) < 4)
      receiptTrace(source, 'pre_buffer_observed', { ref, result: 'sampled' });
  }
  await Promise.all(evidence.map(item => worker.submit(context, item)));
}
async function captureBadAck(config, attrs, key) {
  await capture(config, attrs, { ...key, participant: attrs.participant }, [key.id], normalizeBadAck);
}

async function classification(source) {
  const persisted = await source.prismaRepository.nexiManagedTransportContext.findFirst({ where: { OR: [
    { instanceId: source.instanceId }, { instanceName: source.instance.name }] } });
  if (persisted) return persisted.instanceId === source.instanceId ? 'managed' : 'managed_unresolved';
  return await boundary(source) ? 'managed_unresolved' : 'legacy';
}
function inheritConfig(original, completed) {
  const registration = configs.get(original);
  if (registration) configs.set(completed, registration);
  require('./nexi-ingress.cjs').inheritConfig(original, completed);
}
async function configure(service, config) {
  assertConfiguration(); // Outside recovery handling: an invalid process must not start a socket.
  // Capture exact socket credentials/lifecycle. Never read replacement creds in
  // callbacks of the old socket, and never assign APP attempt ownership here.
  const source = { prismaRepository: service.prismaRepository, instanceId: service.instanceId,
    instance: { name: service.instance.name }, logger: config.logger };
  try {
    clearInstanceDiagnostics(service);
    const owner = { instanceId: service.instanceId, active: true };
    diagnosticOwners.set(service, owner);
    source.diagnosticOwner = owner;
    const worker = workers.get(service.instanceId);
    if (worker) worker.diagnosticSource = source; // Never replace the append/recovery source.
  } catch { /* Diagnostic ownership never changes socket configuration. */ }
  const registration = { source, context: null, ambiguous: false, credentials: config.auth?.creds, contextRevision: 0 };
  configs.set(config, registration);
  try {
    const kind = await classification(source);
    if (kind !== 'legacy') {
      registration.ambiguous = true;
      try { source.receiptRepository = service.prismaRepository.attendanceReceiptRepository(); }
      catch { void trip(source, 'receipt_limits_unconfigured'); }
      const session = identity.sessionFingerprint(config.auth?.creds);
      if (session) {
        const historical = await source.prismaRepository.nexiManagedTransportContext.findFirst({ where: {
          instanceId: source.instanceId, sessionIdentity: session }, orderBy: { createdAt: 'desc' } });
        if (historical?.canonicalVersion === CANONICAL_VERSION && historical.payload.canonical_version === CANONICAL_VERSION &&
            historical.fingerprint === digest(historical.payload) &&
            historical.payload.instance_id === source.instanceId && historical.payload.session_identity === session)
          registration.context = historical.payload; // receipt provenance only; never current send authority
        const snapshot = await registrationContext(registration, session);
        installCaptureContext(snapshot);
      }
    }
  } catch { registration.ambiguous = true; log(source, 'attendance.classification_failed', { instance_id: source.instanceId }); }
  require('./nexi-ingress.cjs').configure(service, config);
  return config;
}
async function sessionObserved(config, attestation) {
  const registration = configs.get(config);
  if (!registration || !attestation) return;
  // Produced only by the pinned public-account signature verifier. Retain
  // evidence for this exact configured socket, never for a replacement.
  registration.attestation = attestation;
  try {
    if (await classification(registration.source) === 'legacy') return;
    // Pairing may change credentials in this exact socket. Obtain a fresh
    // authenticated context; never substitute a replacement socket's session.
    const snapshot = await registrationContext(registration, attestation.session_identity);
    const context = snapshot.context;
    if (!context) return;
    if (identity.sessionFingerprint(registration.credentials) !== attestation.session_identity) return;
    // Session proof must progress even when a concurrent writer refresh wins
    // installation. Its authenticated observation does not authorize dispatch.
    await observe(registration.source, context, attestation);
    try { installCaptureContext(snapshot); }
    catch (error) {
      if (!['nexi_attendance_capture_context_superseded', 'nexi_attendance_capture_context_regression'].includes(error.code)) throw error;
    }
  } catch { void trip(registration.source, 'session_observation_unresolved'); }
}
async function registrationContext(registration, session, source = registration.source, owner = null, probe = null, authorizationId = null) {
  // Every asynchronous installer shares this socket-local sequence. An older
  // response cannot replace a context installed by a later request.
  // V2 operation contexts are local signed authority. They must not compete
  // for the shared receipt context revision when two messages use one socket.
  const revision = authorizationId ? registration.contextRevision : ++registration.contextRevision;
  const previousAttestationId = probe && owner && registration.context?.session_identity === session &&
    UUID.test(registration.context.sender_attestation_id || '') ? registration.context.sender_attestation_id : null;
  const context = await refreshContext(source, session, fetch, owner?.token || null, probe, authorizationId, previousAttestationId);
  return { registration, revision, context, owner, operation:!!authorizationId };
}
async function captureContextSnapshot(source, owner, probe = null, authorizationId = null) {
  const registration = configs.get(sockets.get(owner?.socket));
  if (!registration || registration.source.instanceId !== source.instanceId ||
      registration.source.instance.name !== source.instance.name || !require('./nexi-groups.cjs').lifecycleCurrent(owner))
    fail('nexi_attendance_capture_socket_mismatch');
  return registrationContext(registration, identity.sessionFingerprint(registration.credentials), source, owner, probe, authorizationId);
}
function captureContextCurrent(snapshot, installed = false) {
  const { registration, revision, context, owner, operation } = snapshot;
  return (operation || registration.contextRevision === revision) && context &&
    context.instance_id === registration.source.instanceId && context.instance === registration.source.instance.name &&
    context.session_identity === identity.sessionFingerprint(registration.credentials) &&
    (!owner || require('./nexi-groups.cjs').lifecycleCurrent(owner) && configs.get(sockets.get(owner.socket)) === registration) &&
    (!installed || (operation ? digest(captureMaterial(registration.context)) === digest(captureMaterial(context)) : registration.context === context));
}
function captureMaterial(context) {
  if (!context) return null;
  const material={...context};delete material.isolated_operation;delete material.sender_attestation_renewal;material.physical_dispatch=false;
  return material;
}
function attestationRenewalCurrent(previous, context) {
  try {
    const proof = authenticatedAttestationRenewals.get(context);
    return !!proof && proof.expires_at > Date.now() && proof.from_attestation_id === previous.sender_attestation_id &&
      proof.to_attestation_id === context.sender_attestation_id && proof.context_digest === digest(context) &&
      ['account_id','inbox_id','managed_channel_id','instance','instance_id','session_identity','instance_lineage_id',
        'sender_account_lineage_id','writer_epoch','binding_generation','writer_protocol_version'].every(key => previous[key] === context[key]);
  } catch { return false; }
}
function installCaptureContext(snapshot, writerProbe = null) {
  if (!captureContextCurrent(snapshot)) fail('nexi_attendance_capture_context_superseded');
  const { registration, context } = snapshot, previous = registration.context;
  if (previous?.session_identity === context.session_identity) {
    const stages = ['unresolved', 'staged', 'fencing', 'active', 'pause_requested', 'paused', 'retired'];
    const regression = (field, rejected) => {
      if (rejected) {
        try { writerProbe?.captureRegression(field); }
        catch { /* Diagnostic failure cannot replace the original guard. */ }
      }
      return rejected;
    };
    if (!['account_id', 'inbox_id', 'managed_channel_id'].every(key => !regression(key, previous[key] !== context[key])) ||
        regression('writer_epoch', context.writer_epoch < previous.writer_epoch) ||
        regression('binding_generation', context.binding_generation < previous.binding_generation) ||
        context.writer_epoch === previous.writer_epoch &&
          (regression('barrier_state', stages.indexOf(context.barrier_state) < stages.indexOf(previous.barrier_state)) ||
           ['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id'].some(key =>
             previous[key] != null && regression(key, previous[key] !== context[key] &&
               !(key === 'sender_attestation_id' && attestationRenewalCurrent(previous, context))))))
      fail('nexi_attendance_capture_context_regression');
  }
  // capture() dereferences this exact shared registration at receipt arrival.
  // Already queued receipts retain their original immutable evidence/context.
  // Receipt capture never owns one selected operation. Tokens stay in the
  // immutable preparation/grant and the dispatch call's lexical snapshot.
  registration.context = Object.freeze(snapshot.operation ? captureMaterial(context) : context);
  registration.ambiguous = false;
}
function validateIntent(context, intent) {
  canonicalVersion(context?.canonical_version);
  canonicalVersion(intent?.canonical_version);
  const addressed = intent && Object.hasOwn(intent, 'addressing_protocol_version');
  const fields = ['canonical_version', 'execution_id', 'transport_unit', 'authority_digest', 'payload_digest', 'identity_version_id', 'recipient', 'payload']
    .concat(addressed ? ADDRESSING_FIELDS : []);
  if (intent && digest(intent.payload) !== intent.payload_digest) {
    log({}, 'attendance.canonical_digest.mismatch'); fail('nexi_attendance_intent_digest_conflict');
  }
  if (!intent || Object.keys(intent).sort().join(',') !== fields.sort().join(',') || !UUID.test(intent.execution_id || '') ||
      !Number.isSafeInteger(intent.transport_unit) || intent.transport_unit < 0 || !HASH.test(intent.authority_digest || '') ||
      !HASH.test(intent.payload_digest || '') || digest(intent.payload) !== intent.payload_digest || !PN.test(intent.recipient || '') ||
      addressed && !validAddressing(intent) ||
      !Number.isSafeInteger(intent.identity_version_id) || intent.identity_version_id <= 0 ||
      !UUID.test(context.instance_lineage_id || '') || !UUID.test(context.sender_account_lineage_id || '') ||
      !UUID.test(context.sender_attestation_id || '') || context.current_session !== true || context.channel_state !== 'active' ||
      !['staged', 'active'].includes(context.barrier_state) || !Number.isSafeInteger(context.writer_epoch) ||
      context.writer_epoch <= 0 || Buffer.byteLength(JSON.stringify(intent)) > 1048576) fail('nexi_attendance_intent_unresolved');
}
function addressingMaterial(intent) {
  if (!intent || !Object.hasOwn(intent, 'addressing_protocol_version')) return {};
  if (!validAddressing(intent)) fail('nexi_attendance_intent_unresolved');
  return Object.fromEntries(ADDRESSING_FIELDS.map(key => [key, intent[key]]));
}
function requestMaterial(row, action) {
  return { ...common(row.authority), action, request_id: row.requests[action], execution_id: row.executionId,
    original_session_identity: row.sessionIdentity,
    attempt_id: action === 'attempt' ? null : row.attemptId, transport_unit: row.transportUnit,
    external_id: row.externalId, authority_digest: row.authorityDigest, payload_digest: row.payloadDigest,
    preparation_id: row.id, preparation_nonce_digest: digest(row.preparationNonce), recipient: row.recipient,
    identity_version_id: row.intent.identity_version_id, ...addressingMaterial(row.intent) };
}
async function compareUpdate(db, row, changes) {
  const updated = await db.updateMany({ where: { id: row.id, revision: row.revision, state: row.state },
    data: { ...changes, revision: { increment: 1 } } });
  if (updated.count !== 1) fail('nexi_attendance_preparation_conflict');
  return db.findUnique({ where: { id: row.id } });
}
async function draft(source, context, intent, requestId, predecessor = null) {
  validateIntent(context, intent);
  if (Object.hasOwn(context, 'isolated_operation')) require('./nexi-attendance-isolated.cjs').intent(source, context, intent);
  if (!UUID.test(requestId)) fail('nexi_attendance_preparation_identity_invalid');
  const db = source.prismaRepository.nexiAttendancePreparation;
  if (predecessor && (predecessor.state !== 'definitively_not_sent' || predecessor.closureReason !== 'collision_fenced'))
    fail('nexi_attendance_predecessor_unresolved');
  const inputDigest = digest({ context, intent, predecessor_id: predecessor?.id || null });
  const previous = await db.findUnique({ where: { instanceId_requestId: { instanceId: source.instanceId, requestId } } });
  if (previous) {
    if (previous.inputDigest !== inputDigest) fail('nexi_attendance_preparation_identity_conflict');
    canonicalVersion(previous.canonicalVersion, source);
    return previous;
  }
  const requests = Object.fromEntries(['attempt', 'reserve', 'readback', 'close_collision', 'replacement'].map(action => [action, randomUUID()]));
  requests.predecessor = predecessor?.id || null;
  const data = { id: randomUUID(), canonicalVersion: CANONICAL_VERSION, instanceId: source.instanceId, instanceName: source.instance.name,
    executionId: intent.execution_id, transportUnit: intent.transport_unit, requestId, inputDigest, requests,
    authority: context, intent: canonical(intent), authorityDigest: intent.authority_digest, payloadDigest: intent.payload_digest,
    recipient: intent.recipient, sessionIdentity: context.session_identity, externalId: ID_PREFIX + randomBytes(12).toString('hex').toUpperCase(),
    preparationNonce: randomBytes(32).toString('hex'), preparationRevision: predecessor ? predecessor.preparationRevision + 1 : 1, state: 'draft' };
  try {
    const created = await db.create({ data });
    log(source, 'attendance.preparation.created', { preparation_id: created.id });
    return created;
  }
  catch (error) {
    if (error.code !== 'P2002') throw error;
    const winner = await db.findUnique({ where: { instanceId_requestId: { instanceId: source.instanceId, requestId } } });
    if (!winner || winner.inputDigest !== inputDigest) fail('nexi_attendance_preparation_identity_conflict');
    canonicalVersion(winner.canonicalVersion, source);
    return winner;
  }
}
async function prepare(source, row, requestImpl = request) {
  canonicalVersion(row.canonicalVersion, source);
  const db = source.prismaRepository.nexiAttendancePreparation;
  if (row.state === 'definitively_not_sent' && row.closureReason === 'collision_fenced') {
    const replacement = await replacementDraft(source, row);
    return prepare(source, replacement, requestImpl);
  }
  if (['prepared', 'awaiting_admission', 'dispatch_ready_but_disabled', 'dispatch_started', 'transport_returned'].includes(row.state)) {
    const content = digest({ intent: row.intent, attempt_id: row.attemptId, reservation_id: row.reservationId,
      external_id: row.externalId, authority: row.authority });
    if (!row.frozenAt || !row.reservationId || content !== row.contentDigest || row.preparationDigest !== digest({
      content_digest: content, authority_digest: row.authorityDigest, preparation_id: row.id,
      nonce: row.preparationNonce, revision: row.preparationRevision })) fail('nexi_attendance_frozen_digest_conflict');
    wakeOutbox(source);
    return row;
  }
  if (!['draft', 'reserved'].includes(row.state) || row.dispatchStartedAt || row.admissionId || row.releaseId)
    fail('nexi_attendance_preparation_fenced');
  if (!row.attemptId) {
    const result = await requestImpl(source, requestMaterial(row, 'attempt'));
    if (result.outcome !== 'attempt_registered' || !UUID.test(result.attempt_id || '') || result.external_id !== row.externalId ||
        result.authority_digest !== row.authorityDigest || result.payload_digest !== row.payloadDigest ||
        result.recipient !== row.recipient || result.identity_version_id !== row.intent.identity_version_id ||
        Object.entries(addressingMaterial(row.intent)).some(([key,value]) => result[key] !== value) ||
        result.preparation_id !== row.id || result.physical_dispatch !== false)
      fail('nexi_attendance_attempt_response_conflict');
    row = await compareUpdate(db, row, { attemptId: result.attempt_id });
  }
  if (!row.reservationId) {
    log(source, 'attendance.reservation.request', { preparation_id: row.id, attempt_id: row.attemptId });
    // The same candidate/request/digest is retried after response loss. An HTTP
    // conflict never itself licenses candidate substitution.
    let result;
    try { result = await requestImpl(source, requestMaterial(row, 'reserve')); }
    catch (error) {
      // Read the exact APP reservation after uncertain HTTP. A missing row is
      // unresolved and never licenses a resend or a substitute candidate.
      const observed = await requestImpl(source, requestMaterial(row, 'readback'));
      if (observed.outcome === 'reserved') result = observed;
      else if (observed.outcome === 'collision_fenced' && observed.attempt_id === row.attemptId &&
          observed.external_id === row.externalId && observed.replacement_permitted === true && observed.physical_dispatch === false) {
        // APP committed the original collision fence before its response was
        // lost. Replaying that same closure recovers it; timeout alone cannot.
        const fenced = await closeCollision(source, row, requestImpl);
        return replacementDraft(source, fenced);
      }
      else if (error.code === 'nexi_attendance_reservation_conflict' && observed.outcome === 'unresolved' && observed.admission_registered === false) {
        const fenced = await closeCollision(source, row, requestImpl);
        return replacementDraft(source, fenced);
      } else throw error;
    }
    if (result.outcome !== 'reserved' || result.attempt_id !== row.attemptId || result.external_id !== row.externalId ||
        !UUID.test(result.reservation_id || '') || result.physical_dispatch !== false) fail('nexi_attendance_reservation_response_conflict');
    row = await compareUpdate(db, row, { reservationId: result.reservation_id, state: 'reserved', reservedAt: new Date() });
    log(source, 'attendance.reservation.persisted', { preparation_id: row.id, attempt_id: row.attemptId });
  }
  const contentDigest = digest({ intent: row.intent, attempt_id: row.attemptId, reservation_id: row.reservationId,
    external_id: row.externalId, authority: row.authority });
  const preparationDigest = digest({ content_digest: contentDigest, authority_digest: row.authorityDigest,
    preparation_id: row.id, nonce: row.preparationNonce, revision: row.preparationRevision });
  const prepared = await source.prismaRepository.$transaction(async tx => {
    const current = await compareUpdate(tx.nexiAttendancePreparation, row,
      { state: 'prepared', contentDigest, preparationDigest, frozenAt: new Date() });
    await enqueue(tx, source, row.authority, 'attendance.transport.prepared', {
      original_session_identity: row.sessionIdentity,
      execution_id: row.executionId, attempt_id: row.attemptId, transport_unit: row.transportUnit, reservation_id: row.reservationId,
      external_id: row.externalId, recipient: row.recipient, identity_version_id: row.intent.identity_version_id,
      ...addressingMaterial(row.intent),
      preparation_id: row.id, preparation_nonce: row.preparationNonce, revision: row.preparationRevision,
      content_digest: contentDigest, authority_digest: row.authorityDigest, preparation_digest: preparationDigest,
      observed_at: +current.frozenAt }, digest(['preparation', row.id]));
    return current;
  });
  // $transaction has resolved: both the frozen preparation and its persistent
  // event are committed. The wake is only a hint; it carries no dispatch grant.
  wakeOutbox(source);
  log(source, 'attendance.preparation.frozen', { preparation_id: row.id, attempt_id: row.attemptId });
  return prepared;
}
async function replacementDraft(source, fenced) {
  const replacement = await draft(source, fenced.authority, fenced.intent, fenced.requests.replacement, fenced);
  if (!fenced.successorId) await compareUpdate(source.prismaRepository.nexiAttendancePreparation, fenced, { successorId: replacement.id });
  else if (fenced.successorId !== replacement.id) fail('nexi_attendance_successor_conflict');
  return replacement;
}
async function closeCollision(source, row, requestImpl = request) {
  if (row.state !== 'draft' || !row.attemptId || row.reservationId || row.admissionId || row.releaseId || row.dispatchStartedAt)
    fail('nexi_attendance_collision_replacement_denied');
  const result = await requestImpl(source, requestMaterial(row, 'close_collision'));
  if (result.outcome !== 'collision_fenced' || result.attempt_id !== row.attemptId || result.external_id !== row.externalId ||
      result.replacement_permitted !== true || result.physical_dispatch !== false) fail('nexi_attendance_collision_unresolved');
  const fenced = await compareUpdate(source.prismaRepository.nexiAttendancePreparation, row,
    { state: 'definitively_not_sent', closureReason: 'collision_fenced', closedAt: new Date() });
  log(source, 'attendance.reservation.collision', { preparation_id: row.id, attempt_id: row.attemptId });
  // New caller request identity creates a new draft, candidate, APP attempt,
  // nonce and immutable preparation. This row is NEVER recycled.
  return fenced;
}
function foundationCapability(preparation, work) {
  if (!preparation?.reservationId || !preparation.preparationDigest) fail('nexi_attendance_not_prepared');
  return scope.run(Object.freeze({ kind: 'foundation_only', preparation }), work);
}
async function releasedGrantCapability(source, preparationId, consumptionId, work) {
  const authority = require('./nexi-attendance-authority.cjs');
  const row = await source.prismaRepository.nexiAttendancePreparation.findUnique({where:{id:preparationId}});
  if (!row?.releaseConsumedAt || row.consumptionId !== consumptionId || row.state !== 'dispatch_ready_but_disabled')
    fail('nexi_attendance_dispatch_unconsumed');
  if (!authority.physicalDispatchEnabled(source,row)) return {state:'dispatch_ready_but_disabled',physical_dispatch:false};
  return scope.run(Object.freeze({kind:'released_grant',source,preparation:row,consumptionId}),work);
}
function semanticPurpose(message) {
  // Bounded unwrapping of the pinned future-proof wrappers. Edits, reactions,
  // revokes and all protocol containers are never ordinary customer content.
  const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
    'documentWithCaptionMessage', 'deviceSentMessage', 'associatedChildMessage', 'groupStatusMessage', 'groupStatusMessageV2'];
  for (let depth = 0; depth < 8; depth++) {
    if (!message || typeof message !== 'object') return 'unresolved';
    if (message.editedMessage || message.reactionMessage || message.encReactionMessage || message.pinInChatMessage)
      return 'customer_affecting';
    if (message.protocolMessage) {
      const protocol = message.protocolMessage;
      if (protocol.editedMessage || protocol.key || [0, 3, 11, 14, 27, 30].includes(protocol.type))
        return 'customer_affecting';
      return 'unresolved'; // Including unproven sync/history and every future enum.
    }
    const wrapper = wrappers.find(key => message[key]);
    if (!wrapper) return 'customer';
    // A wrapper combined with other content cannot conceal a protocol operation.
    if (Object.keys(message).some(key => key !== wrapper && key !== 'messageContextInfo')) return 'unresolved';
    message = message[wrapper]?.message;
  }
  return 'unresolved';
}
function markInternalControl(config, message, recipient) {
  // Called only by the exact pinned sendPeerDataOperationMessage constructor.
  // The allowlist is a request to recover an INCOMING placeholder from our own
  // phone, not a retry of our customer send. History/mutation PDOs are excluded.
  message = transportSnapshot(config, message);
  const protocol = message?.protocolMessage, request = protocol?.peerDataOperationRequestMessage;
  const own = [jid(config.auth?.creds?.me?.id), jid(config.auth?.creds?.me?.lid)].filter(Boolean);
  if (Object.keys(message || {}).join(',') !== 'protocolMessage' || protocol?.type !== 16 ||
      Object.keys(protocol).sort().join(',') !== 'peerDataOperationRequestMessage,type' ||
      request?.peerDataOperationRequestType !== 4 || !own.includes(jid(recipient)) ||
      Object.keys(request).sort().join(',') !== 'peerDataOperationRequestType,placeholderMessageResendRequest' ||
      !Array.isArray(request.placeholderMessageResendRequest) || !request.placeholderMessageResendRequest.length ||
      request.placeholderMessageResendRequest.length > 128 || !request.placeholderMessageResendRequest.every(item =>
        Object.keys(item).join(',') === 'messageKey' && item.messageKey?.fromMe === false &&
        Object.keys(item.messageKey).every(key => ['remoteJid', 'fromMe', 'id', 'participant'].includes(key)) &&
        (item.messageKey.participant == null || [PN, LID].some(pattern => pattern.test(jid(item.messageKey.participant) || ''))) &&
        [PN, LID].some(pattern => pattern.test(jid(item.messageKey.remoteJid) || '')) &&
        typeof item.messageKey.id === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(item.messageKey.id))) return message;
  internalControls.set(message, { config, recipient: jid(recipient), session: identity.sessionFingerprint(config.auth?.creds),
    fingerprint: snapshots.fingerprint(message) });
  return message;
}
function transportSnapshot(config, value, allowed, immutable = true) {
  try { return snapshots.copy(value, allowed, immutable); }
  catch (error) {
    const code = error && ['object', 'function'].includes(typeof error) ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
    const reason = ['depth', 'number', 'type', 'cycle', 'prototype', 'key', 'limit', 'accessor']
      .map(value => 'nexi_attendance_snapshot_' + value).includes(code) ? code : 'snapshot_invalid';
    log(configs.get(config)?.source || {}, 'attendance.snapshot.denied', { reason });
    throw error; // No mutable or legacy fallback.
  }
}
function beginRelay(config, recipient, message, options, proto, longPrototype) {
  if (typeof recipient !== 'string') fail('nexi_attendance_snapshot_recipient');
  const allowed = snapshots.registry(proto, longPrototype), control = internalControls.get(message);
  const root = transportSnapshot(config, message, allowed), fixedOptions = transportSnapshot(config, options, allowed);
  const record = { config, recipient: jid(recipient), session: identity.sessionFingerprint(config.auth?.creds), allowed,
    root, fingerprint: snapshots.fingerprint(root), purpose: semanticPurpose(root), encoded: 0, internal: null };
  if (control?.config === config && control.session === record.session && control.recipient === record.recipient &&
      control.fingerprint === record.fingerprint) record.internal = control;
  encodings.set(root, record);
  return Object.freeze({ message: root, options: fixedOptions });
}
function encodingInput(root, value) {
  const record = encodings.get(root); return transportSnapshot(record?.config, value, record?.allowed);
}
async function patchEncoding(config, root, message, recipients, patch) {
  const record = encodings.get(root), allowed = record?.allowed;
  // Existing list normalization may mutate its input. Give the callback a
  // private writable working copy, then isolate its result before any encoder.
  const working = transportSnapshot(config, message, allowed, false);
  const result = await patch(working, recipients === undefined ? undefined : transportSnapshot(config, recipients, allowed, false));
  return transportSnapshot(config, result, allowed);
}
function encodeMessage(config, root, material, encode) {
  const record = encodings.get(root), fixed = transportSnapshot(config, material, record?.allowed);
  if (record) {
    if (record.config !== config || record.session !== identity.sessionFingerprint(config.auth?.creds))
      fail('nexi_attendance_encoding_context_conflict');
    let semantic = fixed;
    if (fixed.deviceSentMessage && Object.keys(fixed).every(key => ['deviceSentMessage', 'messageContextInfo'].includes(key))) {
      if (record.internal && jid(fixed.deviceSentMessage.destinationJid) !== record.recipient) record.internal = null;
      semantic = fixed.deviceSentMessage.message;
    }
    const purpose = semanticPurpose(semantic);
    if (purpose === 'customer_affecting' || record.purpose === 'customer_affecting') record.purpose = 'customer_affecting';
    else if (purpose === 'unresolved' || record.purpose === 'unresolved') record.purpose = 'unresolved';
    if (record.internal && snapshots.fingerprint(semantic) !== record.fingerprint) record.internal = null;
    record.encoded++;
  }
  // Synchronous encoder consumes exactly the immutable semantic material just
  // classified. Returned bytes are private to the cryptographic pipeline.
  return Buffer.from(encode(fixed));
}
function snapshotFrame(config, frame) {
  const fixed = transportSnapshot(config, frame), purpose = purposes.get(frame);
  if (purpose?.config === config && purpose.fingerprint === snapshots.fingerprint(fixed)) purposes.set(fixed, purpose);
  return fixed;
}
function bindStanza(config, stanza, message, messageId) {
  const capability = scope.getStore();
  if (capability) {
    const row = capability.preparation;
    if (messageId !== row.externalId || stanza?.attrs?.id !== row.externalId || jid(stanza?.attrs?.to) !== row.recipient ||
        identity.sessionFingerprint(config.auth?.creds) !== row.sessionIdentity) fail('nexi_attendance_final_stanza_mismatch');
    if (capability.kind !== 'released_grant') fail('nexi_attendance_dispatch_disabled_wave1b');
    return;
  }
  // Peer/protocol exemptions come from pinned internal message construction,
  // never from a serializable category/managed attribute supplied by an API.
  const record = encodings.get(message), control = record?.internal;
  const own = [jid(config.auth?.creds?.me?.id), jid(config.auth?.creds?.me?.lid)].filter(Boolean);
  const internal = record?.encoded > 0 && control?.config === config && own.includes(jid(stanza?.attrs?.to)) &&
    control.recipient === jid(stanza?.attrs?.to) && control.session && control.session === identity.sessionFingerprint(config.auth?.creds) &&
    control.fingerprint === snapshots.fingerprint(message) &&
    semanticPurpose(message) === 'unresolved';
  purposes.set(stanza, Object.freeze({ kind: internal ? 'internal_control' : record?.purpose || semanticPurpose(message),
    config, session: record?.session || identity.sessionFingerprint(config.auth?.creds),
    recipient: jid(stanza.attrs?.to), id: stanza.attrs?.id, fingerprint: snapshots.fingerprint(snapshots.copy(stanza)) }));
}
async function assertNode(config, stanza) {
  if (stanza?.tag !== 'message') return;
  // Operational hold is independent of cached contexts and persisted grants.
  // It does not change their historical facts or claim that Signal is idle.
  const capability = scope.getStore();
  const scoped = capability?.kind === 'released_grant' && capability.preparation?.authority?.isolated_operation;
  if (cutoverHeld() && !scoped) fail('nexi_attendance_cutover_held');
  if (scoped) require('./nexi-attendance-isolated.cjs').grant(capability.source, capability.preparation, capability.preparation.releasedAuthority);
  const registration = configs.get(config);
  if (capability) {
    const authority=require('./nexi-attendance-authority.cjs');
    // Commit the original one-way CAS before the lexical socket write.
    if (capability.kind !== 'released_grant') fail('nexi_attendance_dispatch_disabled_wave1b');
    if (!authority.physicalDispatchEnabled(capability.source,capability.preparation))
      fail('nexi_attendance_dispatch_unreleased');
    if (!registration || registration.source.instanceId !== capability.source.instanceId ||
        identity.sessionFingerprint(config.auth?.creds) !== capability.preparation.sessionIdentity)
      fail('nexi_attendance_dispatch_socket_mismatch');
    const started=await authority.dispatchStart(capability.source,capability.preparation.id,capability.consumptionId,stanza);
    if (!started.started) fail('nexi_attendance_dispatch_already_started');
    return;
  }
  if (stanza?.tag !== 'message') return;
  if (typeof stanza.attrs?.id === 'string' && stanza.attrs.id.startsWith(ID_PREFIX)) {
    if (registration) log(registration.source, 'attendance.gate.denied', { reason: 'foundation_only' });
    fail('nexi_attendance_dispatch_disabled_wave1b');
  }
  if (!registration) return;
  const { source } = registration;
  if (!registration.ambiguous && !registration.context) return;
  const row = await source.prismaRepository.nexiAttendancePreparation.findFirst({ where: {
    instanceId: source.instanceId, externalId: stanza.attrs?.id || '' } });
  if (row) fail('nexi_attendance_native_retry_denied');
  const proof = purposes.get(stanza);
  const purpose = proof?.kind || 'unresolved';
  if (purpose === 'internal_control') {
    if (proof.config === config && proof.session === identity.sessionFingerprint(config.auth?.creds) &&
        proof.recipient === jid(stanza.attrs?.to) && proof.id === stanza.attrs?.id &&
        proof.fingerprint === snapshots.fingerprint(stanza)) return;
    log(source, 'attendance.unknown_protocol.denied'); fail('nexi_attendance_unknown_protocol_denied');
  }
  if (jid(stanza.attrs?.to)?.endsWith('@g.us')) return; // existing Groups guard remains authoritative
  if (purpose === 'customer_affecting' || purpose === 'unresolved') {
    log(source, purpose === 'customer_affecting' ? 'attendance.customer_protocol.denied' : 'attendance.unknown_protocol.denied');
    fail(purpose === 'customer_affecting' ? 'nexi_attendance_customer_protocol_denied' : 'nexi_attendance_unknown_protocol_denied');
  }
  if (registration.ambiguous) fail('nexi_attendance_classification_unresolved');
  // A cached pre-activation context cannot authorize an independent writer.
  installCaptureContext(await registrationContext(registration, identity.sessionFingerprint(config.auth?.creds)));
  if (registration.context?.isolation_cutover) fail('nexi_attendance_legacy_bypass_denied');
}
function externalRaw(config) {
  const registration = configs.get(config);
  if (!registration) fail('nexi_attendance_raw_context_missing');
  if (registration.context || registration.ambiguous) {
    log(registration.source, 'attendance.raw_bypass.denied'); fail('nexi_attendance_raw_send_denied');
  }
}
function trackSocket(socket, config) {
  if (!configs.has(config)) fail('nexi_attendance_raw_context_missing');
  sockets.set(socket, config);
  require('./nexi-ingress.cjs').trackSocket(socket, config);
}
function writerIsolation(source, context, writerProbe = null) {
  const config = sockets.get(source.service?.client), registration = configs.get(config);
  const session = identity.sessionFingerprint(source.service?.client?.authState?.creds);
  // Capture only predicates actually reached by the original short-circuit.
  // The captured values, not a second read of live state, describe the decision.
  const checks = {};
  const rejected = !(checks.registration_present = !!registration) ||
    !(checks.registration_instance_id_matches = registration.source.instanceId === source.instanceId) ||
    !(checks.registration_instance_name_matches = registration.source.instance.name === source.instance.name) ||
    !(checks.context_current_session = !!context?.current_session) ||
    !(checks.context_channel_active = context.channel_state === 'active') ||
    !(checks.context_session_matches = context.session_identity === session) ||
    !(checks.attestation_session_matches = registration.attestation?.session_identity === session) ||
    !(checks.attestation_provenance_valid = ['verified_pairing','verified_restored_account'].includes(registration.attestation.provenance));
  writerProbe?.isolationChecks(() => ({ ...checks,
    ...(registration ? { attestation_present: !!registration.attestation } : {}) }));
  writerProbe?.attestationChecks?.(() => ({ status: registration?.attestationDiagnostic?.status || 'not_observed',
    trigger: registration?.attestationDiagnostic?.trigger, registration_present: !!registration,
    ...(registration ? { credentials_object_matches: registration.credentials === source.service?.client?.authState?.creds,
      attestation_present: !!registration.attestation,
      attestation_session_matches: registration.attestation?.session_identity === session } : {}) }));
  if (rejected || !['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id']
    .every(key => UUID.test(context[key] || ''))) fail('nexi_attendance_writer_isolation_unproved');
  // Verification alone cannot install an arbitrary context. The production
  // caller installs its guarded request snapshot before CAS/proof response.
  return true;
}
function rawNodeForSocket(socket, node) {
  const registration = configs.get(sockets.get(socket));
  if (!registration) fail('nexi_attendance_raw_context_missing');
  if (node?.tag === 'message' && (registration.context || registration.ambiguous)) fail('nexi_attendance_raw_send_denied');
}
async function rawNodeForInstance(repository, instance, node) {
  if (node?.tag !== 'message') return;
  const row = await repository.instance.findUnique({ where: { name: instance.instanceName } });
  if (!row || await classification({ prismaRepository: repository, instanceId: row.id, instance: { name: row.name } }) !== 'legacy')
    fail('nexi_attendance_raw_send_denied');
}
async function retryMessage(config, key, message) {
  const registration = configs.get(config);
  if (String(key?.id || '').startsWith(ID_PREFIX)) return undefined;
  if (!registration) return message;
  if (!registration.ambiguous && !registration.context) return message;
  const row = await registration.source.prismaRepository.nexiAttendancePreparation.findFirst({ where: {
    instanceId: registration.source.instanceId, externalId: key?.id || '' } });
  if (row || registration.ambiguous) {
    log(registration.source, 'attendance.native_retry.suppressed'); return undefined;
  }
  return message;
}
async function legacyAllowed(source, operation, externalId) {
  const kind = await classification(source);
  if (kind === 'legacy') return true;
  const context = await source.prismaRepository.nexiManagedTransportContext.findFirst({ where: {
    instanceId: source.instanceId }, orderBy: { createdAt: 'desc' } });
  if (!context) fail('nexi_attendance_classification_unresolved');
  if (externalId && await source.prismaRepository.nexiAttendancePreparation.findFirst({ where: {
    instanceId: source.instanceId, externalId } })) {
    log(source, 'attendance.legacy_bypass.denied', { reason: operation }); return false;
  }
  return !context.payload.isolation_cutover;
}
async function legacyForInstance(repository, instance, operation, externalId) {
  if (!repository || !instance?.instanceName) fail('nexi_attendance_legacy_context_missing');
  const row = await repository.instance.findUnique({ where: { name: instance.instanceName } });
  if (!row) {
    const historical = await repository.nexiManagedTransportContext.findFirst({ where: { instanceName: instance.instanceName } });
    if (historical) return false;
    fail('nexi_attendance_instance_unresolved');
  }
  return legacyAllowed({ prismaRepository: repository, instanceId: row.id, instance: { name: row.name } }, operation, externalId);
}
async function drain(source, fetchImpl = fetch, limit = 20) {
  const db = source.prismaRepository.nexiAttendanceEventOutbox, destination = await boundary(source);
  if (!destination?.enabled) {
    // Retain immutable UUID/body for explicit authenticated reconciliation.
    // A removed/disabled binding must never redirect to another endpoint or
    // monopolize the global due-work window indefinitely.
    await db.updateMany({ where: { instanceId: source.instanceId, state: 'pending',
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
      data: { state: 'binding_unavailable' } });
    return;
  }
  await db.updateMany({ where: { instanceId: source.instanceId, state: 'pending', attempts: { gte: MAX_ATTEMPTS },
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] }, data: { state: 'quarantined', leaseToken: null, leaseUntil: null } });
  for (let i = 0; i < limit; i++) {
    const now = new Date(), token = randomUUID();
    const eligible = { instanceId: source.instanceId, state: 'pending', nextAttemptAt: { lte: now },
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
    const row = await db.findFirst({ where: eligible, orderBy: { createdAt: 'asc' } });
    if (!row) return;
    row.body = canonical(row.body);
    const receiptRef = row.eventType === 'attendance.receipt.observed'
      ? inboundReference(source, row.body.data?.external_id) : null;
    if (row.canonicalVersion !== CANONICAL_VERSION || row.body.data?.canonical_version !== CANONICAL_VERSION ||
        row.version !== 1 || !FIELDS[row.eventType] || digest(row.body) !== row.fingerprint) {
      if (row.canonicalVersion !== CANONICAL_VERSION || row.body.data?.canonical_version !== CANONICAL_VERSION)
        log(source, 'attendance.canonical_version.unsupported', { event_id: row.id });
      await db.updateMany({ where: { id: row.id, state: 'pending' }, data: { state: 'unsupported' } });
      log(source, 'attendance.outbox.unsupported', { event_id: row.id }); continue;
    }
    const claimed = await db.updateMany({ where: { id: row.id, ...eligible }, data: {
      leaseToken: token, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    let settled = false, deliveryReason = 'request_failed', deliveryOutcome = 'unresolved';
    const deliveryTick = performance.now();
    preparedOutboxTrace(source, row, 'delivery_started');
    const waiting = setTimeout(() => receiptTrace(source, 'outbox_wait', { event_id: row.id,
      duration_ms: Math.round(performance.now() - deliveryTick) }), INBOUND_SLOW_MS);
    waiting.unref?.();
    try {
      const transport = require('./nexi-transport.cjs');
      const prepared = transport.prepareEvent(destination.headers, row.body, row.instanceName, row.instanceId);
      prepared.headers['X-Nexi-Event-Id'] = row.id;
      const response = await fetchImpl(destination.url, { method: 'POST', redirect: 'error',
        headers: transport.freshEventHeaders(prepared.headers, row.body), body: canonicalBytes(row.body),
        signal: AbortSignal.timeout(10000) });
      deliveryReason = response.ok ? 'json_unreadable' : 'http_rejected';
      const ack = response.ok ? await response.json() : null;
      if (response.ok) deliveryReason = 'ack_unproved';
      if (ack?.ack === 'persisted' && ack.event_id === row.id && ack.fingerprint === row.fingerprint && ack.version === 1) {
        deliveryReason = 'ack_persist_failed';
        const acknowledged = await db.updateMany({ where: { id: row.id, state: 'pending', leaseToken: token }, data: {
          state: 'acknowledged', acknowledgedAt: new Date(), leaseToken: null, leaseUntil: null } });
        settled = true;
        deliveryReason = null;
        deliveryOutcome = acknowledged.count === 1 ? 'ack_persisted' : 'ack_cas_not_won';
      }
      // Unsupported APP schema is retained with immutable UUID/body. It can be
      // explicitly re-enabled after compatible APP deployment; never dropped.
      if ([400, 404, 422].includes(response.status)) {
        deliveryReason = 'unsupported_mark_failed';
        await db.updateMany({ where: { id: row.id, state: 'pending', leaseToken: token },
          data: { state: 'unsupported', leaseToken: null, leaseUntil: null } }); settled = true;
        deliveryReason = null;
        deliveryOutcome = 'unsupported_response';
      }
    } catch { /* response loss leaves the same durable event pending */ }
    finally { clearTimeout(waiting); }
    preparedOutboxTrace(source, row, 'delivery_ended', deliveryTick, deliveryReason || deliveryOutcome);
    if (deliveryReason) receiptTrace(source, 'outbox_delivery', { event_id: row.id, ref: receiptRef, reason: deliveryReason,
      duration_ms: Math.round(performance.now() - deliveryTick) });
    else if (performance.now() - deliveryTick >= INBOUND_SLOW_MS)
      receiptTrace(source, 'outbox_delivery', { event_id: row.id, ref: receiptRef,
        duration_ms: Math.round(performance.now() - deliveryTick) });
    else if (receiptRef && parseInt(receiptRef.slice(0, 2), 16) < 4)
      receiptTrace(source, `outbox_${deliveryOutcome}`, { event_id: row.id, ref: receiptRef,
        journal_id: row.body.data?.journal_id, result: 'sampled' });
    if (!settled) {
      await db.updateMany({ where: { id: row.id, state: 'pending', leaseToken: token }, data: {
        state: row.attempts + 1 >= MAX_ATTEMPTS ? 'quarantined' : 'pending', leaseToken: null, leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6))) } });
      log(source, 'attendance.outbox.retry', { event_id: row.id });
    }
  }
}
async function recoverPreparation(source, row) {
  try { return await prepare(source, row); }
  catch {
    const db = source.prismaRepository.nexiAttendancePreparation;
    const current = await db.findUnique({ where: { id: row.id } });
    if (!current || !['draft', 'reserved', 'definitively_not_sent'].includes(current.state)) return;
    await compareUpdate(db, current, { recoveryAttempts: current.recoveryAttempts + 1,
      nextRecoveryAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(current.recoveryAttempts, 6))),
      lastRecoveryReason: 'app_authority_unresolved' });
    log(source, 'attendance.reservation.unresolved', { preparation_id: row.id });
  }
}
function installOutboxDrainer(repository) {
  if (outboxDrainers.has(repository)) return;
  outboxDrainers.set(repository, { ready: new Map(), running: false });
}
function wakeOutbox(source) {
  const state = outboxDrainers.get(source.prismaRepository);
  if (!state) return; // Startup/restart is covered by the persisted-work poll.
  // One queued hint per instance, with a bounded process-local hint set. A
  // saturated hint set never changes or discards a persistent outbox row.
  if (!state.ready.has(source.instanceId) && state.ready.size >= OUTBOX_WAKE_CAPACITY) return;
  state.ready.set(source.instanceId, { prismaRepository: source.prismaRepository,
    instanceId: source.instanceId, instance: { name: source.instance.name } });
  if (state.running) return;
  state.running = true;
  const immediate = setImmediate(async () => {
    try {
      while (state.ready.size) {
        const [instanceId, next] = state.ready.entries().next().value;
        state.ready.delete(instanceId);
        // All wake and poll requests share this single consumer per repository.
        // A busy instance rejoins at the tail; each turn retains drain's batch
        // bound, oldest-due selection, HTTP deadline, lease/CAS and backoff.
        try { await drain(next); }
        catch { receiptTrace(next, 'outbox_drain', { reason: 'drain_failed' }); }
      }
    } finally { state.running = false; }
  });
  immediate.unref?.();
}
function installRoutes(router, monitor, guard, repository) {
  assertConfiguration(); // Routes are installed before the HTTP listener starts.
  installOutboxDrainer(repository);
  require('./nexi-attendance-authority.cjs').installRoute(router,monitor,guard,repository);
  // No preparation endpoint accepts arbitrary browser/API intent. Later APP
  // workers call authenticated contracts; exported primitives cannot dispatch.
  router.post('/nexi/attendance/prepare/:instanceName', guard, async (req, res) => {
    try {
      const service = monitor.waInstances[req.params.instanceName];
      if (!service || !service.client?.ws?.isOpen) return res.sendStatus(503);
      const claims = prepareClaims(service, req.body);
      const groups = require('./nexi-groups.cjs'), owner = groups.lifecycleCapture(service);
      if (!groups.lifecycleCurrent(owner)) fail('nexi_attendance_session_superseded');
      const source = { prismaRepository: repository, instanceId: service.instanceId, instance: { name: service.instance.name } };
      // An exchange retry reads its original durable draft before consulting a
      // fresh context. Context churn never reallocates the candidate/request.
      const previous = await repository.nexiAttendancePreparation.findUnique({where:{instanceId_requestId:{instanceId:source.instanceId,requestId:claims.request_id}}});
      if (previous) {
        if (digest(previous.intent)!==digest(claims.intent) || previous.sessionIdentity!==claims.session_identity ||
            previous.authority.managed_channel_id!==claims.managed_channel_id || previous.authority.writer_epoch!==claims.writer_epoch ||
            digest(previous.authority.isolated_operation || null)!==digest(claims.isolated_operation || null))
          fail('nexi_attendance_preparation_identity_conflict');
        const prepared=await prepare(source,previous);
        return res.json({state:prepared.state,preparation_id:prepared.id,physical_dispatch:prepared.authority.physical_dispatch === true});
      }
      const authorizationId = claims.isolated_operation?.protocol === require('./nexi-attendance-isolated.cjs').COMPOSER_PROTOCOL ?
        claims.isolated_operation.authorization_id : null;
      const context = await refreshContext(source, claims.session_identity, fetch, owner.token, null, authorizationId);
      if (!groups.lifecycleCurrent(owner) || identity.sessionFingerprint(service.client?.authState?.creds) !== claims.session_identity)
        fail('nexi_attendance_session_superseded');
      if (context?.managed_channel_id !== claims.managed_channel_id || context.writer_epoch !== claims.writer_epoch)
        fail('nexi_attendance_authorization_superseded');
      if (digest(context.isolated_operation || null)!==digest(claims.isolated_operation || null)) fail('nexi_attendance_isolated_authority_invalid');
      const row = await draft(source, context, claims.intent, claims.request_id);
      const prepared = await prepare(source, row);
      return res.json({ state: prepared.state, preparation_id: prepared.id, attempt_id: prepared.attemptId,
        reservation_id: prepared.reservationId, external_id: prepared.externalId, preparation_digest: prepared.preparationDigest,
        physical_dispatch: prepared.authority.physical_dispatch === true });
    } catch (error) {
      return res.status(error.code?.includes('conflict') ? 409 : 422).json({ error: 'nexi_attendance_preparation_unresolved', physical_dispatch: false });
    }
  });
  router.get('/nexi/attendance/health/:instanceName', guard, async (req, res) => {
    try {
      const instance = await repository.instance.findUnique({ where: { name: req.params.instanceName } });
      if (!instance) return res.sendStatus(404);
      const row = await repository.nexiAttendanceHealth.findUnique({ where: { instanceId: instance.id } });
      const worker = workers.get(instance.id);
      const service = monitor.waInstances[instance.name];
      const session = identity.sessionFingerprint(service?.client?.authState?.creds);
      const context = service?.client?.ws?.isOpen && session ? await refreshContext({prismaRepository:repository,
        instanceId:instance.id,instance:{name:instance.name}},session,fetch,
        require('./nexi-groups.cjs').lifecycleCapture(service).token) : null;
      return res.json({ physical_dispatch: context?.physical_dispatch === true, receipt_health: row?.unhealthy || worker?.unhealthy ? 'evidence_gap' : 'unproved',
        reason: row?.reason || null, queue_items: worker?.queue.length || 0, queue_bytes: worker?.bytes || 0,
        active_appends: worker?.active || 0, recovery_items: worker?.recovery.size || 0, recovery_bytes: worker?.recoveryBytes || 0 });
    } catch { return res.sendStatus(503); }
  });
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; running = true;
    try {
      // Include unloaded/deleted instances. Outbox has no cascading Instance FK.
      const pending = await repository.nexiAttendanceEventOutbox.findMany({ where: { state: 'pending', nextAttemptAt: { lte: new Date() } },
        select: { instanceId: true, instanceName: true }, distinct: ['instanceId'], take: 20 });
      for (const entry of pending) wakeOutbox({ prismaRepository: repository, instanceId: entry.instanceId,
        instance: { name: entry.instanceName } });
      const unfinished = await repository.nexiAttendancePreparation.findMany({ where: {
        nextRecoveryAt: { lte: new Date() }, recoveryAttempts: { lt: MAX_ATTEMPTS }, OR: [
        { state: { in: ['draft', 'reserved'] } }, { state: 'definitively_not_sent', closureReason: 'collision_fenced', successorId: null }] },
        orderBy: { nextRecoveryAt: 'asc' }, take: 20 });
      for (const row of unfinished) await recoverPreparation({ prismaRepository: repository, instanceId: row.instanceId,
        instance: { name: row.instanceName } }, row).catch(() => {});
      for (const worker of workers.values()) await worker.recover();
    } catch { /* durable work remains eligible; never bypass or dispatch */ }
    finally { running = false; }
  }, 5000);
  timer.unref?.(); return timer;
}
function prepareClaims(service, envelope, now = Date.now()) {
  const claims = verifyEnvelope(service, envelope, 'attendance-prepare', 2097152);
  canonicalVersion(claims.canonical_version);
  const expected = 'audience,canonical_version,expires_at,instance,instance_id,intent,managed_channel_id,physical_dispatch,provider,request_id,session_identity,version,writer_epoch'.split(',');
  if (Object.hasOwn(claims, 'isolated_operation')) expected.push('isolated_operation');
  if (Object.keys(claims).sort().join(',') !== expected.sort().join(',') ||
      claims.version !== 1 || claims.audience !== 'nexi-attendance-evolution' || claims.provider !== 'evolution-baileys' ||
      claims.instance !== service.instance.name || claims.instance_id !== service.instanceId || ![true,false].includes(claims.physical_dispatch) ||
      !['managed_channel_id', 'writer_epoch'].every(key => Number.isSafeInteger(claims[key]) && claims[key] > 0) ||
      !UUID.test(claims.request_id || '') || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= now || claims.expires_at > now + 60000 ||
      claims.session_identity !== identity.sessionFingerprint(service.client?.authState?.creds)) fail('nexi_attendance_prepare_authentication_required');
  if (claims.isolated_operation) {
    require('./nexi-attendance-isolated.cjs').intent({instanceId:service.instanceId,instance:service.instance},
      {...claims,...claims.isolated_operation,instance:claims.instance}, claims.intent, now);
  } else if (process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED === 'true' && cutoverHeld()) fail('nexi_attendance_cutover_held');
  return claims;
}
function decodeCanonicalClaims(encoded) {
  const buffer = Buffer.from(encoded, 'base64url'), text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) fail('nexi_attendance_noncanonical_material');
  return canonicalJson.parse(text);
}
module.exports = { canonical, digest, eventPayload, settings, assertConfiguration, publicAttestation, observePublicAccount, verifyPublicAccountSignature,
  normalizeReceipt, normalization, numericNormalization, receiveInbound, observeInbound, enqueueInbound, queueEnqueued, queueStarted, queueEnded,
  beginInbound, resumeIngressDiagnostics, failInbound, endInbound, timedInbound, inboundFailure, clearInstanceDiagnostics, allowDiagnosticTrace,
  configure, sessionObserved, capture, refreshContext, classification, draft, prepare, closeCollision, cutoverHeld,
  foundationCapability, bindStanza, assertNode, externalRaw, retryMessage, legacyAllowed, legacyForInstance, ReceiptWorker,
  drain, installRoutes, requestMaterial, common, prepareClaims, rawNodeForInstance, rawNodeForSocket, trackSocket, writerIsolation, writerProbeTrace,
  captureContextSnapshot, captureContextCurrent, installCaptureContext,
  append, enqueue, inheritConfig, boundedMariaDb, recoverPreparation, semanticPurpose, markInternalControl,
  promotePendingReceipts,
  normalizeBadAck, captureBadAck, canonicalBytes, CANONICAL_VERSION, ID_PREFIX,
  beginRelay, encodingInput, patchEncoding, encodeMessage, snapshotFrame, signEnvelope, verifyEnvelope, releasedGrantCapability, boundary, envelopeSecret };
