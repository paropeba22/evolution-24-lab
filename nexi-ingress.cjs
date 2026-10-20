'use strict';

const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const canonical = require('./nexi-canonical-json.cjs');
const identity = require('./nexi-identity.cjs');
const groups = require('./nexi-groups.cjs');
const transport = require('./nexi-transport.cjs');
const configs = new WeakMap(), captured = new WeakSet(), context = new AsyncLocalStorage();
const registrations = new Map();
const instanceRunning = new Map();
const LIMIT = 10000, MAX_BYTES = 1024 * 1024, CONCURRENT = 4, PER_INSTANCE = 2, LEASE_MS = 60000;
let running = 0, pumping = false, scheduled = false, cursor = 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const current = service => { const ctx = context.getStore(); return ctx?.service === service ? ctx : null; };
function log(service, event, row, reason) {
  service.logger?.warn({ event, journal_id: row?.id, instance_id: service.instanceId, reason });
}
function creationDiagnostic(ctx, event, fields) {
  try { ctx.service.logger?.warn({ event, journal_id: ctx.row.id, attempt: ctx.row.attempts, ...fields }); }
  catch { /* Diagnostics must never change creation or reconciliation. */ }
}
function creationError(error, status) {
  if (status === 401 || status === 403) return 'authorization_rejected';
  if (status === 400 || status === 422) return 'validation_rejected';
  if (status === 429 || status >= 500) return 'remote_unavailable';
  if (status >= 400) return 'http_rejected';
  if (['ETIMEDOUT', 'ECONNABORTED', 'TimeoutError'].includes(error?.code) || error?.name === 'TimeoutError') return 'timeout';
  if (['AbortError', 'CancelError'].includes(error?.name) || error?.code === 'ERR_CANCELED') return 'cancelled';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'transport_unavailable';
  if (['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_BAD_OPTION_VALUE', 'ERR_BAD_OPTION'].includes(error?.code)) return 'local_configuration_failure';
  if (['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError'].includes(error?.name)) return 'local_runtime_failure';
  if (['PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientInitializationError',
    'PrismaClientRustPanicError', 'PrismaClientValidationError'].includes(error?.name)) return 'local_persistence_failure';
  return 'unclassified_failure';
}
function creationErrorDetails(error) {
  // Never echo arbitrary names/codes: exceptions can contain private input.
  const names = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'AxiosError', 'ApiError', 'TimeoutError', 'AbortError', 'CancelError',
    'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientInitializationError', 'PrismaClientRustPanicError', 'PrismaClientValidationError'];
  const codes = ['ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_BAD_OPTION_VALUE', 'ERR_BAD_OPTION', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE',
    'P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1017', 'P2000', 'P2001', 'P2002', 'P2003',
    'P2010', 'P2011', 'P2012', 'P2013', 'P2014', 'P2021', 'P2022', 'P2024', 'P2025', 'P2028', 'P2034'];
  return { error_name: names.includes(error?.name) ? error.name : 'other',
    ...(codes.includes(error?.code) ? { error_code: error.code } : {}), has_http_response: !!error?.response ||
      (error?.name === 'ApiError' && Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599) };
}
function creationStep(step, error) {
  const ctx = context.getStore();
  if (!ctx || ctx.secondary || !ctx.creationTrace || !['client_resolution', 'body_preparation', 'conversation_resolution',
    'message_preparation', 'reply_resolution', 'sdk_operation', 'sdk_url', 'sdk_form', 'sdk_body', 'sdk_headers',
    'sdk_send', 'sdk_response', 'sdk_return'].includes(step)) return;
  try {
    ctx.creationTrace.step = step;
    creationDiagnostic(ctx, 'ingress.creation', { stage: error ? 'preparation_error' : 'preparation', operation_step: step,
      request_started: ctx.creationTrace.requestStarted,
      ...(error ? { error_class: creationError(error, error?.status || error?.response?.status), ...creationErrorDetails(error) } : {}) });
  } catch { /* Diagnostics must not affect SDK preparation. */ }
}
function ingressRequestDiagnostic(ctx, event, eventId, stage, status, error) {
  if (!['ingress.observed', 'ingress.reconcile', 'ingress.correlated', 'ingress.profile'].includes(event)) return;
  try {
    const httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    creationDiagnostic(ctx, 'ingress.request', { ingress_event: event, event_id: eventId, stage,
      ...(httpStatus ? { http_status: httpStatus } : {}),
      ...(stage === 'transport_error' || httpStatus >= 400 ? { error_class: creationError(error, httpStatus) } : {}) });
  } catch { /* Diagnostics must not replace a rejection or authorize a retry. */ }
}
// Called at the actual SDK/Axios boundary. Never log URL, headers, source_id,
// exception messages/bodies, content or caller-provided diagnostic properties.
function creationHttp(kind, stage, status, error) {
  const ctx = context.getStore();
  if (!ctx || ctx.secondary || !ctx.creationTrace || !['sdk_message_post', 'media_message_post'].includes(kind) ||
      !['request_started', 'http_response', 'transport_error'].includes(stage)) return false;
  try {
    const httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    ctx.creationTrace.requestStarted = true;
    creationDiagnostic(ctx, 'ingress.creation', { stage, transport: kind, boundary: 'axios_invocation', ...(httpStatus ? { http_status: httpStatus } : {}),
      ...(stage === 'transport_error' || httpStatus >= 400 ? { error_class: creationError(error, httpStatus), ...creationErrorDetails(error) } : {}) });
  } catch { /* Observability is never authority or a request outcome. */ }
  return true;
}
function creationSkipped(reason) {
  const ctx = context.getStore();
  if (!ctx || ctx.secondary || !ctx.creationTrace || !['instance_unavailable', 'client_unavailable', 'conversation_unavailable',
    'ignored_group', 'ignored_contact', 'ignored_jid', 'empty_body'].includes(reason)) return false;
  ctx.creationTrace.skipReason = reason;
  return true;
}
function creationFailure(error) {
  const ctx = context.getStore();
  if (!ctx || ctx.secondary || !ctx.creationTrace) return;
  try {
    const status = error?.status || error?.response?.status;
    creationDiagnostic(ctx, 'ingress.creation', { stage: 'event_whatsapp_error', error_class: creationError(error, status),
      ...creationErrorDetails(error), request_started: ctx.creationTrace.requestStarted, operation_step: ctx.creationTrace.step || 'event_entry',
      ...(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}) });
  } catch { /* Preserve even unusual original errors. */ }
}
async function persistCreationAck(ctx, ack) {
  try { await checkpoint(ctx, { acknowledgement: ack, checkpoint: 'chatwoot_confirmed', state: 'pending' }); }
  catch (error) {
    creationDiagnostic(ctx, 'ingress.creation', { stage: 'ack_persistence_failed', has_message_id: true });
    throw error;
  }
  creationDiagnostic(ctx, 'ingress.creation', { stage: 'ack_persisted', has_message_id: true });
}
async function reconcileCreation(ctx, stage) {
  try {
    const result = await request(ctx, 'ingress.reconcile');
    creationDiagnostic(ctx, 'ingress.reconciliation', { stage, has_message_id: !!result.message_id,
      result: result.message_id ? 'message_confirmed' : result.creation_state === 'absent_retry_safe' ? 'absent_retry_safe' : 'unconfirmed' });
    return result;
  } catch (error) {
    try {
      creationDiagnostic(ctx, 'ingress.reconciliation', { stage, result: 'failed', error_class: creationError(error, error?.httpStatus),
        ...(error?.httpStatus ? { http_status: error.httpStatus } : {}) });
    } catch { /* Preserve the original reconciliation error. */ }
    throw error;
  }
}
function key(name) {
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) fail('nexi_ingress_secret_missing');
  return createHmac('sha256', master).update(`ingress:v1:${name}`).digest();
}
function proof(claims) { return createHmac('sha256', key(claims.instance_name)).update(canonical.bytes(claims)).digest('hex'); }
function verify(row, metadataOnly = false) {
  const { claims, signature } = row.envelope || {};
  const expected = claims && proof(claims);
  if (!/^[a-f0-9]{64}$/.test(signature || '') || !expected ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ||
      claims.version !== 1 || claims.provider !== 'evolution' || claims.journal_id !== row.id ||
      claims.instance_id !== row.instanceId || claims.observation.session_identity !== row.sessionIdentity ||
      (!(metadataOnly && row.state === 'succeeded' && row.payloadPrunedAt) &&
        claims.payload_digest !== hash(Buffer.from(row.payload, 'base64'))) ||
      row.dedupKey !== canonical.digest(['evolution', claims.account_id, claims.inbox_id, row.instanceId,
        row.sessionIdentity, claims.observation.external_message_id]) ||
      row.scopeId !== canonical.digest(['evolution', claims.account_id, claims.inbox_id, row.instanceId]) ||
      row.laneId !== canonical.digest([row.scopeId, row.sessionIdentity, claims.observation.pn_jid])) fail('nexi_ingress_proof_invalid');
  return claims;
}
async function binding(service) {
  const webhook = await service.prismaRepository.webhook.findUnique({ where: { instanceId: service.instanceId } });
  if (!webhook?.enabled || webhook.webhookByEvents || webhook.webhookBase64) fail('nexi_ingress_binding_unavailable');
  const url = new URL(webhook.url), headers = webhook.headers || {};
  const account = Number(headers['X-Nexi-Chatwoot-Account-Id']), inbox = Number(headers['X-Nexi-Chatwoot-Inbox-Id']);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/webhooks/nexi/channels/evolution' || !Number.isSafeInteger(account) || account <= 0 ||
      !Number.isSafeInteger(inbox) || inbox <= 0) fail('nexi_ingress_binding_unavailable');
  return { url, headers, account, inbox };
}
function configure(service, config) { configs.set(config, { service, credentials: config.auth?.creds }); }
function inheritConfig(original, completed) {
  const registration = configs.get(original);
  if (registration) configs.set(completed, registration);
}
function trackSocket(socket, config) {
  const registration = configs.get(config);
  if (registration) registration.owner = groups.lifecycleCapture(registration.service, socket);
}
async function ownerCheck(service, owner, session) {
  await groups.operationCheck(owner);
  if (identity.sessionFingerprint(owner.socket?.authState?.creds) !== session) fail('nexi_ingress_session_fenced');
}
// Called only by identity's live, object-identity-gated transfer function.
// A deserialized observation never enters this function as a capability.
async function append(service, owner, observation, encoded) {
  await ownerCheck(service, owner, observation.session_identity);
  const target = await binding(service);
  const bytes = Buffer.from(encoded);
  if (bytes.length > MAX_BYTES) fail('nexi_ingress_payload_backpressure');
  const scopeId = canonical.digest(['evolution', target.account, target.inbox, service.instanceId]);
  const laneId = canonical.digest([scopeId, observation.session_identity, observation.pn_jid]);
  const dedupKey = canonical.digest(['evolution', target.account, target.inbox, service.instanceId,
    observation.session_identity, observation.external_message_id]);
  const repository = service.prismaRepository;
  const id = randomUUID();
  const claims = { version: 1, provider: 'evolution', journal_id: id, instance_id: service.instanceId,
    instance_name: service.instance.name, account_id: target.account, inbox_id: target.inbox,
    accepted_at: new Date().toISOString(), observation, payload_digest: hash(bytes) };
  const envelope = { claims, signature: proof(claims) };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await repository.$transaction(async tx => {
        const previous = await tx.nexiIngressJournal.findUnique({ where: { dedupKey } });
        if (previous) {
          const old = verify(previous, true);
          // Delivery duplicates may carry different timestamps; authenticated
          // identity must remain exact. Never replace the original payload.
          if (old.observation.pn_jid !== observation.pn_jid || old.observation.lid_jid !== observation.lid_jid)
            fail('nexi_ingress_identity_conflict');
          if (previous.payloadPrunedAt) return previous; // Complete dedup tombstone; never reconstruct effects.
          const oldPayload = canonical.parse(Buffer.from(previous.payload, 'base64').toString('utf8'));
          const incomingPayload = canonical.parse(bytes.toString('utf8'));
          if (oldPayload.content_digest !== incomingPayload.content_digest) fail('nexi_ingress_content_conflict');
          return previous;
        }
        const scope = await tx.nexiIngressScope.upsert({ where: { id: scopeId },
          create: { id: scopeId }, update: {} });
        if (scope.pending >= LIMIT) fail('nexi_ingress_capacity_backpressure');
        const reserved = await tx.nexiIngressScope.updateMany({ where: { id: scopeId, revision: scope.revision },
          data: { revision: { increment: 1 }, nextSequence: { increment: 1 }, pending: { increment: 1 } } });
        if (reserved.count !== 1) fail('nexi_ingress_cas_retry');
        await tx.nexiIngressLane.upsert({ where: { id: laneId }, create: { id: laneId, scopeId,
          instanceId: service.instanceId, sessionIdentity: observation.session_identity, pending: 1 },
          update: { pending: { increment: 1 } } });
        return tx.nexiIngressJournal.create({ data: { id, dedupKey, scopeId, laneId,
          instanceId: service.instanceId, sessionIdentity: observation.session_identity,
          sequence: scope.nextSequence + 1n, envelope, payload: bytes.toString('base64') } });
      });
      groups.lifecycleCheck(owner);
      wake();
      return row;
    } catch (error) {
      if (attempt < 4 && ['P2002', 'P2034', 'nexi_ingress_cas_retry'].includes(error.code)) continue;
      throw error;
    }
  }
}
async function capture(config, message, proto) {
  const registration = configs.get(config);
  if (!registration) {
    if (config.nexiFinancialManaged) throw Object.assign(new Error('nexi_ingress_configuration_missing'),
      { code: 'nexi_ingress_configuration_missing', nexiIngressAdmissionFailed: true });
    return;
  }
  if (!registration.service.instance.name.startsWith('nexi-wa-')) return;
  const service = registration.service;
  try {
    const owner = registration.owner;
    const row = await identity.transferToIngress(message, async observation => {
      if (observation.session_identity !== identity.sessionFingerprint(registration.credentials)) fail('nexi_ingress_session_fenced');
      // Baileys extends MessageKey outside WAProto. Protobuf alone discards
      // remoteJidAlt/addressingMode and would lose authenticated LID context.
      const transportKey = Object.fromEntries(['remoteJidAlt', 'addressingMode', 'participantAlt']
        .filter(field => typeof message.key[field] === 'string').map(field => [field, message.key[field]]));
      const recovery = { version: 1, protobuf: Buffer.from(proto.WebMessageInfo.encode(message).finish()).toString('base64'),
        transport_key: transportKey, content_digest: hash(Buffer.from(proto.Message.encode(message.message).finish())) };
      return append(service, owner, observation, Buffer.from(canonical.bytes(recovery), 'utf8'));
    });
    if (row) captured.add(message);
  } catch (error) {
    log(service, 'ingress.admission_failed', null, error.code || 'storage_unavailable');
    // Stop intake before the pinned decoder sends its delivery receipt.
    // Failure is visible; no memory-only queue substitutes for a commit.
    const owner = registration.owner;
    if (groups.lifecycleCurrent(owner)) owner.socket?.end?.(new Error('nexi_ingress_backpressure'));
    error.nexiIngressAdmissionFailed = true;
    throw error;
  }
}
function skipSerial(message) { return context.getStore()?.message !== message && captured.has(message); }
function observation(service, message) {
  const ctx = current(service);
  return ctx?.message === message ? ctx.claims.observation : null;
}
function register(service, decode, process, effects, policy) {
  if (!service.instance.name.startsWith('nexi-wa-')) return;
  const previous = registrations.get(service.instanceId);
  if (previous?.service === service && previous.socket === service.client) return;
  registrations.set(service.instanceId, { service, socket: service.client, decode, process, effects, policy });
  wake();
}
async function check(ctx) {
  if (ctx.secondary) return require('./nexi-ingress-dispatch.cjs').guard();
  if (ctx.lost) fail('nexi_ingress_lease_lost');
  if (ctx.service.instanceId !== ctx.row.instanceId || ctx.service.instance.name !== ctx.claims.instance_name)
    fail('nexi_ingress_binding_fenced');
  await ownerCheck(ctx.service, ctx.owner, ctx.row.sessionIdentity);
  const lane = await ctx.service.prismaRepository.nexiIngressLane.findUnique({ where: { id: ctx.row.laneId } });
  if (lane?.leaseToken !== ctx.token || lane.leaseUntil <= new Date()) fail('nexi_ingress_lease_lost');
}
async function checkpoint(ctx, data) {
  await check(ctx);
  // Transaction holds the lane row while updating the checkpoint. Lease
  // expiry/replacement cannot race a successful stale-owner checkpoint.
  await ctx.service.prismaRepository.$transaction(async tx => {
    const lock = await tx.nexiIngressLane.updateMany({ where: { id: ctx.row.laneId,
      leaseToken: ctx.token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (lock.count !== 1) fail('nexi_ingress_lease_lost');
    await tx.nexiIngressJournal.update({ where: { id: ctx.row.id }, data });
  });
  Object.assign(ctx.row, data);
}
async function request(ctx, event, acknowledgement) {
  await check(ctx);
  const target = await binding(ctx.service);
  if (target.account !== ctx.claims.account_id || target.inbox !== ctx.claims.inbox_id) fail('nexi_ingress_binding_fenced');
  const data = { ...ctx.claims.observation, account_id: target.account, inbox_id: target.inbox,
    ingress: ctx.row.envelope, ...(acknowledgement ? { ack: acknowledgement } : {}) };
  const prepared = transport.prepareEvent(target.headers,
    { event, instance: ctx.claims.instance_name, data }, ctx.claims.instance_name, ctx.row.instanceId);
  // Distinct immutable event IDs per stage/ACK. A successor association can
  // legitimately change the correlation ACK; it must not reuse another body.
  const eventHash = canonical.digest([ctx.row.id, event, acknowledgement || null]);
  prepared.headers['X-Nexi-Event-Id'] = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-${eventHash.slice(12, 16)}-${eventHash.slice(16, 20)}-${eventHash.slice(20, 32)}`;
  const options = { method: 'POST', redirect: 'error',
    headers: transport.freshEventHeaders(prepared.headers, prepared.body), body: JSON.stringify(prepared.body),
    signal: AbortSignal.timeout(10000) };
  const eventId = prepared.headers['X-Nexi-Event-Id'];
  ingressRequestDiagnostic(ctx, event, eventId, 'request_started');
  let response;
  try { response = await fetch(target.url, options); }
  catch (error) {
    ingressRequestDiagnostic(ctx, event, eventId, 'transport_error', undefined, error);
    throw error;
  }
  ingressRequestDiagnostic(ctx, event, eventId, 'http_response', response.status);
  if (!response.ok) {
    const code = response.status >= 500 || response.status === 429 ? 'nexi_ingress_remote_unavailable' : 'nexi_ingress_remote_rejected';
    throw Object.assign(new Error(code), { code, httpStatus: response.status });
  }
  const result = await response.json();
  if (result.account_id !== ctx.claims.account_id || result.inbox_id !== ctx.claims.inbox_id ||
      !['association_id', 'generation', 'contact_id', 'contact_inbox_id', 'conversation_id', 'conversation_display_id']
        .every(field => Number.isSafeInteger(result[field]) && result[field] > 0) ||
      (result.message_id !== undefined && (!Number.isSafeInteger(result.message_id) || result.message_id <= 0))) fail('nexi_ingress_ack_invalid');
  await check(ctx);
  return result;
}
async function observed(service, work) {
  const ctx = current(service);
  if (!ctx) return work();
  await checkpoint(ctx, { checkpoint: 'identity_pending', state: 'recoverable_failure' });
  const association = await request(ctx, 'ingress.observed');
  await checkpoint(ctx, { association, checkpoint: 'identity_confirmed', state: 'pending' });
  return association;
}
async function chatwoot(service, body, work) {
  const ctx = current(service);
  if (!ctx) return work();
  // Always reconcile before any creation, even on the first worker attempt.
  // The APP atomically reserves and returns the exact persisted source result.
  const result = await reconcileCreation(ctx, 'before_creation');
  if (ctx.expectedMessageId && result.message_id !== ctx.expectedMessageId) fail('nexi_ingress_confirmed_id_conflict');
  await checkpoint(ctx, { association: result });
  identity.bind(body, result);
  if (result.message_id) {
    const ack = { id: result.message_id, inbox_id: result.inbox_id, conversation_id: result.conversation_display_id };
    await persistCreationAck(ctx, ack);
    return ack;
  }
  if (result.creation_state !== 'absent_retry_safe') fail('nexi_ingress_reconciliation_uncertain');
  await checkpoint(ctx, { checkpoint: 'chatwoot_inflight', state: 'result_uncertain' });
  await check(ctx);
  ctx.creationTrace = { requestStarted: false };
  creationDiagnostic(ctx, 'ingress.creation', { stage: 'event_whatsapp_started' });
  let ack;
  try {
    ack = await work();
    creationDiagnostic(ctx, 'ingress.creation', { stage: 'event_whatsapp_returned', request_started: ctx.creationTrace.requestStarted,
      has_message_id: Number.isSafeInteger(ack?.id) && ack.id > 0,
      ...(ctx.creationTrace.skipReason ? { skip_reason: ctx.creationTrace.skipReason } : {}) });
  } catch (error) {
    creationDiagnostic(ctx, 'ingress.creation', { stage: 'event_whatsapp_failed', request_started: ctx.creationTrace.requestStarted,
      operation_step: ctx.creationTrace.step || 'event_entry', ...creationErrorDetails(error),
      error_class: creationError(error, error?.status || error?.response?.status) });
    // Only reconciliation can establish the committed result, including after a timeout.
  }
  // A positive HTTP ACK alone is insufficient: reconcile the committed APP
  // reservation. A lost response/crash never falls through to a blind POST.
  const confirmed = await reconcileCreation(ctx, 'after_creation');
  if (!confirmed.message_id) fail('nexi_ingress_chatwoot_unconfirmed');
  if (ack?.id && ack.id !== confirmed.message_id) fail('nexi_ingress_ack_conflict');
  ack = { id: confirmed.message_id, inbox_id: confirmed.inbox_id, conversation_id: confirmed.conversation_display_id };
  await persistCreationAck(ctx, ack);
  return ack;
}
async function correlated(service, acknowledgement, work) {
  const ctx = current(service);
  if (!ctx) return work();
  await checkpoint(ctx, { checkpoint: 'correlation_pending', state: 'recoverable_failure' });
  const result = await request(ctx, 'ingress.correlated', acknowledgement);
  await checkpoint(ctx, { association: result, checkpoint: 'correlation_confirmed', state: 'pending' });
  return result;
}
async function materializePrimary(service, body) {
  const ctx = current(service);
  if (!ctx) return false;
  if (ctx.row.checkpoint !== 'correlation_confirmed' || !ctx.row.association?.message_id ||
      ctx.row.acknowledgement?.id !== ctx.row.association.message_id || body.chatwootMessageId !== ctx.row.association.message_id)
    fail('nexi_ingress_primary_requirements_missing');
  const { pollUpdates, ...data } = body;
  const registration = registrations.get(service.instanceId);
  const effects = require('./nexi-ingress-effects.cjs');
  await check(ctx);
  await service.prismaRepository.$transaction(async tx => {
    // The same scope -> lane order as append/finish. Intent creation and the
    // mandatory local Message are atomic; no secondary call occurs here.
    await tx.nexiIngressScope.update({ where: { id: ctx.row.scopeId }, data: { revision: { increment: 1 } } });
    const held = await tx.nexiIngressLane.updateMany({ where: { id: ctx.row.laneId, leaseToken: ctx.token,
      leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (held.count !== 1) fail('nexi_ingress_lease_lost');
    const fence = await tx.instance.updateMany({ where: { id: ctx.row.instanceId, nexiGroupsSocketOwner: ctx.owner.token },
      data: { nexiGroupsSocketOwner: ctx.owner.token } });
    if (fence.count !== 1) fail('nexi_ingress_session_fenced');
    const message = await tx.message.upsert({ where: { id: ctx.row.id }, create: { ...data, id: ctx.row.id }, update: {} });
    if (message.instanceId !== ctx.row.instanceId || message.chatwootMessageId !== ctx.row.association.message_id ||
        message.key?.id !== ctx.claims.observation.external_message_id || message.key?.fromMe !== false)
      fail('nexi_ingress_local_message_conflict');
    const contact = await tx.contact.findFirst({ where: { instanceId: ctx.row.instanceId, remoteJid: ctx.claims.observation.pn_jid } });
    const chat = await tx.chat.findFirst({ where: { instanceId: ctx.row.instanceId, remoteJid: body.key.remoteJid } });
    const priorContactEvent = await tx.nexiIngressEffect.findFirst({ where: { conversationLaneId: ctx.row.laneId,
      kind: 'contact_webhook', contractVersion: 2, sequence: { lt: ctx.row.sequence } }, select: { id: true } });
    const policy = { ...registration.policy(), contactExisted: !!contact || !!priorContactEvent,
      contactPhoto: contact?.profilePicUrl || null, chatSnapshot: chat ? JSON.parse(JSON.stringify(chat)) : null,
      chatNameChanged: !!(chat && ctx.claims.observation.contact_profile?.public_name &&
        chat.name !== ctx.claims.observation.contact_profile.public_name) };
    await effects.plan(tx, ctx, policy, registration.effects);
    await tx.nexiIngressJournal.update({ where: { id: ctx.row.id }, data: {
      mainMaterializedAt: new Date(), checkpoint: 'main_materialized', state: 'pending', lastError: null } });
  });
  ctx.row.mainMaterializedAt = new Date();
  ctx.row.checkpoint = 'main_materialized';
  return true;
}
async function persistMessage(service, data, work) {
  const ctx = current(service);
  if (!ctx) return work();
  await check(ctx);
  return service.prismaRepository.message.upsert({ where: { id: ctx.row.id }, create: { ...data, id: ctx.row.id }, update: {} });
}
// These are the existing socket controls, not writer permissions. Persist the
// attempt before invoking them and never repeat an uncertain physical effect.
async function control(service, name, work) {
  const ctx = current(service);
  if (!ctx) return work();
  // Existing receipt/history/presentation controls are optional effects. Their
  // durable intents are created by materializePrimary, outside the main lane.
  if (!ctx.secondary) return null;
  if (Object.prototype.hasOwnProperty.call(ctx.row.controls || {}, name)) return ctx.row.controls[name];
  await checkpoint(ctx, { checkpoint: name, state: 'outcome_unknown' });
  await check(ctx);
  groups.lifecycleCheck(ctx.owner);
  const result = await work();
  await checkpoint(ctx, { controls: { ...(ctx.row.controls || {}), [name]: typeof result === 'string' ? result : null },
    checkpoint: 'control_confirmed', state: 'pending' });
  return result;
}
function provider(service) { return context.getStore()?.providers.get(service); }
function socket(service) {
  const ctx = current(service);
  if (!ctx) return service.client;
  groups.lifecycleCheck(ctx.owner);
  return ctx.owner.socket;
}
function setProvider(service, value) {
  const ctx = context.getStore();
  if (!ctx) return false;
  ctx.providers.set(service, value);
  return true;
}
async function cancellable(work) {
  const operation = work();
  const ctx = context.getStore();
  if (!ctx) return operation;
  const tracked = typeof operation?.cancel === 'function' && typeof operation?.nexiTransportSettled?.then === 'function';
  const timer = setTimeout(() => {
    ctx.creationDeadlineElapsed = true;
    log(ctx.service, 'ingress.creation_deadline', ctx.row, tracked ? 'abort_requested_result_uncertain' : 'awaiting_real_completion');
    if (tracked) operation.cancel();
  }, 15000);
  try { return await operation; }
  finally {
    clearTimeout(timer);
    // The SDK facade can reject before its executor settles. Do not return to
    // reconciliation/release the worker slot until the real executor finishes.
    if (tracked) await operation.nexiTransportSettled;
  }
}
async function finish(ctx) {
  await check(ctx);
  await ctx.service.prismaRepository.$transaction(async tx => {
    // Match append's scope -> lane lock order.
    await tx.nexiIngressScope.update({ where: { id: ctx.row.scopeId }, data: { pending: { decrement: 1 } } });
    const lock = await tx.nexiIngressLane.updateMany({ where: { id: ctx.row.laneId, leaseToken: ctx.token,
      leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (lock.count !== 1) fail('nexi_ingress_lease_lost');
    const message = await tx.message.findUnique({ where: { id: ctx.row.id } });
    if (!ctx.row.mainMaterializedAt || !message || message.instanceId !== ctx.row.instanceId ||
        message.chatwootMessageId !== ctx.row.association?.message_id) fail('nexi_ingress_primary_requirements_missing');
    await tx.nexiIngressJournal.update({ where: { id: ctx.row.id },
      data: { state: 'succeeded', checkpoint: 'completed', completedAt: new Date(), lastError: null } });
    await tx.nexiIngressLane.update({ where: { id: ctx.row.laneId }, data: { pending: { decrement: 1 } } });
  });
}
async function run(registration, lane, token) {
  const { service } = registration, repository = service.prismaRepository;
  let ctx, row, timer, delay = 0;
  try {
    row = await repository.nexiIngressJournal.findFirst({ where: { laneId: lane.id, state: { not: 'succeeded' } }, orderBy: { sequence: 'asc' } });
    if (!row) { delay = 60000; return; }
    const claims = verify(row), owner = groups.lifecycleCapture(service, registration.socket);
    ctx = { service, row, claims, owner, token, providers: new Map(), lost: false,
      expectedMessageId: row.mainMaterializedAt || row.continuationStartedAt ? row.association?.message_id : null,
      legacyControlUnknown: row.legacyControlKind || (row.state === 'outcome_unknown' &&
        ['read_control', 'history_control', 'placeholder_control', 'chat_name_webhook'].includes(row.checkpoint) ? row.checkpoint : null) };
    await check(ctx);
    if ((row.state === 'outcome_unknown' || row.continuationStartedAt) &&
        !(row.continuationStartedAt && ctx.expectedMessageId) && !ctx.legacyControlUnknown && !row.mainMaterializedAt) {
      await checkpoint(ctx, { state: 'outcome_unknown', lastError: 'manual_reconciliation_required' });
      log(service, 'ingress.outcome_unknown', row, 'manual_reconciliation_required');
      delay = 300000; return;
    }
    timer = setInterval(() => {
      if (ctx.renewing) return;
      ctx.renewing = true;
      repository.nexiIngressLane.updateMany({ where: { id: lane.id, leaseToken: token,
        leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
        .then(result => { if (result.count !== 1) ctx.lost = true; }, () => { ctx.lost = true; })
        .finally(() => { ctx.renewing = false; });
    }, LEASE_MS / 3);
    timer.unref?.();
    if (ctx.legacyControlUnknown && !row.legacyControlKind) await checkpoint(ctx, { legacyControlKind: ctx.legacyControlUnknown });
    await checkpoint(ctx, { attempts: row.attempts + 1 });
    if (row.mainMaterializedAt) {
      const confirmed = await request(ctx, 'ingress.reconcile');
      if (confirmed.message_id !== ctx.expectedMessageId) fail('nexi_ingress_confirmed_id_conflict');
      await finish(ctx);
      return;
    }
    const recovery = canonical.parse(Buffer.from(row.payload, 'base64').toString('utf8'));
    if (recovery.version !== 1 || typeof recovery.protobuf !== 'string' || !/^[a-f0-9]{64}$/.test(recovery.content_digest || '') || !recovery.transport_key ||
        Object.keys(recovery.transport_key).some(field => !['remoteJidAlt', 'addressingMode', 'participantAlt'].includes(field)))
      fail('nexi_ingress_payload_identity_invalid');
    const message = registration.decode(Buffer.from(recovery.protobuf, 'base64'), owner.socket.authState.creds, recovery.transport_key, recovery.content_digest);
    ctx.message = message;
    if (message.key?.id !== claims.observation.external_message_id || message.key.fromMe !== false ||
        ![claims.observation.pn_jid, claims.observation.lid_jid].includes(message.key.remoteJid))
      fail('nexi_ingress_payload_identity_invalid');
    require('./nexi-attendance.cjs').resumeIngressDiagnostics(service, message, row.id, claims.accepted_at);
    await context.run(ctx, () => registration.process(message));
    if (!ctx.row.association?.message_id || !ctx.row.mainMaterializedAt) fail('nexi_ingress_completion_missing');
    await finish(ctx);
  } catch (error) {
    delay = Math.min(300000, 1000 * 2 ** Math.min(ctx?.row.attempts || 1, 8)) + Math.floor(Math.random() * 1000);
    if (row && /fenced|proof_invalid|identity_conflict|payload_identity_invalid|LIFECYCLE_STALE/.test(error.code || '')) {
      // Recording a fence is bookkeeping, never permission to use that old
      // session. The lane CAS alone authorizes this quarantine write.
      try {
        await repository.$transaction(async tx => {
          const held = await tx.nexiIngressLane.updateMany({ where: { id: lane.id, leaseToken: token,
            leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
          if (held.count !== 1) fail('nexi_ingress_lease_lost');
          await tx.nexiIngressJournal.update({ where: { id: row.id }, data: { state: 'outcome_unknown',
            lastError: 'session_or_proof_fenced' } });
        });
        delay = 300000;
      } catch { /* Only the current lease owner may quarantine. */ }
    }
    if (ctx && !ctx.lost) {
      const uncertain = !ctx.expectedMessageId && (ctx.row.continuationStartedAt || ctx.row.state === 'outcome_unknown');
      const fenced = /fenced|proof_invalid|identity_conflict/.test(error.code || '');
      try { await checkpoint(ctx, { state: uncertain || fenced ? 'outcome_unknown' :
        ctx.row.checkpoint === 'chatwoot_inflight' ? 'result_uncertain' : 'recoverable_failure',
        lastError: uncertain ? 'continuation_result_unknown' : error.code || 'worker_unavailable' }); } catch { /* Lease/session fence wins. */ }
    }
    log(service, 'ingress.worker_pending', row, error.code || 'worker_unavailable');
  } finally {
    if (timer) clearInterval(timer);
    await repository.nexiIngressLane.updateMany({ where: { id: lane.id, leaseToken: token },
      data: { leaseToken: null, leaseUntil: null, servedAt: new Date(), nextAttemptAt: new Date(Date.now() + delay) } });
  }
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const all = [...registrations.values()];
    for (let offset = 0; offset < all.length && running < CONCURRENT; offset++) {
      const registration = all[(cursor + offset) % all.length], { service } = registration;
      if ((instanceRunning.get(service.instanceId) || 0) >= PER_INSTANCE || registration.socket !== service.client) continue;
      const owner = groups.lifecycleCapture(service);
      if (!groups.lifecycleCurrent(owner) || !owner.socket?.ws?.isOpen) continue;
      const now = new Date();
      const lanes = await service.prismaRepository.nexiIngressLane.findMany({ where: { instanceId: service.instanceId,
        pending: { gt: 0 }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        orderBy: [{ servedAt: 'asc' }, { id: 'asc' }], take: PER_INSTANCE });
      for (const lane of lanes) {
        if (running >= CONCURRENT || (instanceRunning.get(service.instanceId) || 0) >= PER_INSTANCE) break;
        const token = randomUUID();
        const claimed = await service.prismaRepository.nexiIngressLane.updateMany({ where: { id: lane.id,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) } });
        if (claimed.count !== 1) continue;
        running++;
        instanceRunning.set(service.instanceId, (instanceRunning.get(service.instanceId) || 0) + 1);
        void run(registration, lane, token).catch(() => log(service, 'ingress.storage_unavailable', null, 'lease_recovery_required'))
          .finally(() => {
            running--;
            instanceRunning.set(service.instanceId, Math.max(0, (instanceRunning.get(service.instanceId) || 0) - 1));
            wake();
          });
      }
    }
    cursor = (cursor + 1) % Math.max(all.length, 1);
  } finally { pumping = false; }
}
function wake() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; void pump().catch(() => {
    for (const { service } of registrations.values()) log(service, 'ingress.recovery_pending', null, 'storage_unavailable');
  }); });
  require('./nexi-ingress-effects.cjs').wake();
}
const recovery = setInterval(wake, 5000); recovery.unref?.();
// Raw payloads/results can be pruned after seven days and terminal secondary
// work. Signed dedup/audit tombstones survive; active work keeps its payload.
const retention = setInterval(() => {
  for (const { service } of registrations.values()) {
    const cutoff = new Date(Date.now() - 7 * 86400000);
    void require('./nexi-ingress-effects.cjs').retain(service, cutoff)
    .then(() => service.prismaRepository.nexiIngressContactCache.deleteMany({ where: { instanceId: service.instanceId, expiresAt: { lt: new Date() } } }))
    .then(() => service.prismaRepository.nexiIngressLane.deleteMany({ where: { instanceId: service.instanceId,
      pending: 0, leaseToken: null, servedAt: { lt: cutoff } } }))
      .catch(() => log(service, 'ingress.retention_pending', null, 'storage_unavailable'));
  }
}, 3600000); retention.unref?.();
async function contactSupplement(service) {
  const ctx = current(service);
  if (!ctx?.secondary || ctx.effect.kind !== 'contact_chatwoot') fail('nexi_ingress_effect_context_invalid');
  const result = await request(ctx, 'ingress.profile', ctx.row.association);
  if (result.message_id !== ctx.row.association.message_id || result.contact_id !== ctx.row.association.contact_id)
    fail('nexi_ingress_confirmed_id_conflict');
  return { contact_id: result.contact_id, message_id: result.message_id, profile_synchronized: true };
}
async function cachedContacts(service, jids) {
  const owner = groups.lifecycleCapture(service), session = identity.sessionFingerprint(owner.socket?.authState?.creds);
  if (!session) fail('nexi_ingress_session_fenced');
  await ownerCheck(service, owner, session);
  const target = await binding(service);
  const scopeId = canonical.digest(['evolution', target.account, target.inbox, service.instanceId]);
  const rows = await service.prismaRepository.nexiIngressContactCache.findMany({ where: {
    scopeId, sessionIdentity: session, expiresAt: { gt: new Date() }, OR: [{ pnJid: { in: jids } }, { lidJid: { in: jids } }] } });
  await ownerCheck(service, owner, session);
  return rows.map(row => ({ remoteJid: row.pnJid, number: row.pnJid.split('@')[0],
    jidOptions: [row.pnJid, row.lidJid].filter(Boolean), lid: row.lidJid ? 'lid' : undefined }));
}
module.exports = { configure, inheritConfig, trackSocket, capture, skipSerial, observation, register, current, observed, chatwoot, correlated, socket,
  creationHttp, creationSkipped, creationFailure, creationStep,
  materializePrimary, persistMessage, control, provider, setProvider, cancellable, contactSupplement, cachedContacts, inWorker: () => !!context.getStore(),
  secondaryRuntime: { registrations, context, verify, ownerCheck, log } };
