'use strict';

const { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
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
const COMMON = ['version', 'protocol_version', 'canonical_version', 'audience', 'provider', 'account_id', 'managed_channel_id', 'instance_id',
  'instance_lineage_id', 'session_identity', 'original_session_identity', 'sender_account_lineage_id', 'sender_attestation_id',
  'binding_generation', 'writer_epoch', 'writer_protocol_version', 'barrier_state'];
const FIELDS = {
  'attendance.context.request': ['version', 'canonical_version', 'audience', 'provider', 'account_id', 'inbox_id', 'nonce', 'session_identity'],
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
    'direction', 'semantic_class', 'normalized_status', 'receipt_timestamp', 'captured_at', 'protocol_metadata']),
};
const configs = new WeakMap();
const sockets = new WeakMap();
const purposes = new WeakMap();
const internalControls = new WeakMap();
const encodings = new WeakMap();
const scope = new AsyncLocalStorage();
const workers = new Map();
const healthWrites = new Map();

function fail(code) { const error = new Error(code); error.code = code; throw error; }
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
function eventPayload(event, data) {
  if (!event.startsWith('attendance.')) return null;
  const fields = FIELDS[event];
  if (!fields || !data || Object.keys(data).sort().join(',') !== [...fields].sort().join(',') ||
      data.version !== 1 || (data.protocol_version !== undefined && data.protocol_version !== 1)) fail('nexi_attendance_contract_unsupported');
  canonicalVersion(data.canonical_version);
  const normalized = canonical(data);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const external = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
  if (data.audience !== 'nexi-attendance-app' || data.provider !== 'evolution-baileys' || !positive(data.account_id))
    fail('nexi_attendance_contract_invalid');
  if (event === 'attendance.context.request') {
    if (!positive(data.inbox_id) || !UUID.test(data.nonce || '') || !HASH.test(data.session_identity || ''))
      fail('nexi_attendance_contract_invalid');
  } else {
    const observation = event.startsWith('attendance.session.') || event === 'attendance.receipt.observed';
    if (!positive(data.managed_channel_id) || typeof data.instance_id !== 'string' || !data.instance_id.length || data.instance_id.length > 100 ||
        !HASH.test(data.session_identity || '') || data.writer_protocol_version !== 1 ||
        !BARRIER_STATES.includes(data.barrier_state) ||
        !(data.original_session_identity === null || HASH.test(data.original_session_identity || '')) ||
        !['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id'].every(key =>
          observation && data[key] === null || UUID.test(data[key] || '')) ||
        !['writer_epoch', 'binding_generation'].every(key => observation && data[key] === null || positive(data[key])))
      fail('nexi_attendance_contract_invalid');
    if (event === 'attendance.foundation.request' || event === 'attendance.transport.prepared') {
      if (!UUID.test(data.execution_id || '') || !Number.isSafeInteger(data.transport_unit) || data.transport_unit < 0 ||
          !UUID.test(data.preparation_id || '') || !external(data.external_id) || !PN.test(data.recipient || '') ||
          !positive(data.identity_version_id) || !HASH.test(data.authority_digest || '')) fail('nexi_attendance_contract_invalid');
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
    } else if (!UUID.test(data.journal_id || '') || !external(data.external_id) || ![PN, LID].some(r => r.test(data.remote_jid || '')) ||
        !(data.participant === null || [PN, LID].some(r => r.test(data.participant || ''))) || typeof data.from_me !== 'boolean' ||
        data.direction !== (data.from_me ? 'outgoing' : 'incoming') || !['ERROR', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED', 'UNKNOWN'].includes(data.normalized_status) ||
        (!data.from_me && data.normalized_status !== 'UNKNOWN') || !/^[a-z-]{1,32}$/.test(data.semantic_class || '') ||
        !(data.receipt_timestamp === null || Number.isSafeInteger(data.receipt_timestamp) && data.receipt_timestamp >= 0) ||
        !positive(data.captured_at) || !receiptMetadata(data))
      fail('nexi_attendance_contract_invalid');
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > 16384) fail('nexi_attendance_event_limit');
  return normalized;
}
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
function settings(env = process.env) {
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
async function request(source, data, event = 'attendance.foundation.request', fetchImpl = fetch, eventId = randomUUID()) {
  const destination = await boundary(source);
  if (!destination?.enabled) fail('nexi_attendance_boundary_unavailable');
  const transport = require('./nexi-transport.cjs');
  const body = { event, instance: source.instance.name, data: eventPayload(event, data) };
  const prepared = transport.prepareEvent(destination.headers, body, source.instance.name, source.instanceId);
  prepared.headers['X-Nexi-Event-Id'] = eventId;
  const response = await fetchImpl(destination.url, { method: 'POST', redirect: 'error',
    headers: transport.freshEventHeaders(prepared.headers, prepared.body), body: canonicalBytes(prepared.body),
    signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail(response.status === 409 ? 'nexi_attendance_reservation_conflict' : 'nexi_attendance_app_unresolved');
  return response.json();
}
function verifyContext(source, envelope, nonce, session) {
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
  if (Object.keys(context).sort().join(',') !== keys.sort().join(',') || context.version !== 1 || context.protocol_version !== 1 ||
      context.audience !== 'nexi-attendance-evolution' || context.provider !== 'evolution-baileys' || context.nonce !== nonce ||
      context.instance !== source.instance.name || context.instance_id !== source.instanceId || context.session_identity !== session ||
      context.physical_dispatch !== false || context.isolation_cutover !== false ||
      !['account_id', 'inbox_id', 'managed_channel_id'].every(key => Number.isSafeInteger(context[key]) && context[key] > 0) ||
      !['instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id'].every(key => context[key] === null || UUID.test(context[key] || '')) ||
      !['binding_generation', 'writer_epoch'].every(key => context[key] === null || Number.isSafeInteger(context[key]) && context[key] > 0) ||
      context.writer_protocol_version !== 1 || !BARRIER_STATES.includes(context.barrier_state) ||
      typeof context.current_session !== 'boolean' || !['active', 'disabled', 'removed'].includes(context.channel_state) ||
      !(context.original_session_identity === null || HASH.test(context.original_session_identity || '')))
    fail('nexi_attendance_context_invalid');
  return context;
}
async function refreshContext(source, session, fetchImpl = fetch) {
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
    nonce, session_identity: session }, 'attendance.context.request', fetchImpl, nonce);
  const context = verifyContext(source, envelope, nonce, session);
  // Nonce authenticates the exchange, not classification identity.
  const durable = { ...context }; delete durable.nonce;
  const fingerprint = digest(durable);
  const previous = await db.findUnique({ where: { fingerprint } });
  if (previous) { canonicalVersion(previous.canonicalVersion, source); return previous.payload; }
  try { await db.create({ data: { id: randomUUID(), instanceId: source.instanceId, instanceName: source.instance.name,
    managedChannelId: String(context.managed_channel_id), sessionIdentity: session, fingerprint, payload: durable,
    canonicalVersion: CANONICAL_VERSION } }); }
  catch (error) { if (error.code !== 'P2002') throw error; }
  return durable;
}

// No private key, creds object, registration secret or Signal state leaves this
// function. Verification is re-run for restored account public material.
function publicAttestation(credentials, verify, prefixes, provenance = 'verified_restored_account', observedAt = Date.now()) {
  const account = credentials?.account;
  const session = identity.sessionFingerprint(credentials), pn = jid(credentials?.me?.id), lid = jid(credentials?.me?.lid);
  if (!session || !PN.test(pn || '') || (lid && !LID.test(lid)) || !account ||
      !(account.accountSignatureKey instanceof Uint8Array) || account.accountSignatureKey.length !== 32 ||
      !(account.accountSignature instanceof Uint8Array) || account.accountSignature.length !== 64 ||
      !(account.details instanceof Uint8Array) || account.details.length > 1024 || !account.details.length) return null;
  const prefix = prefixes(account.details);
  const bytes = Buffer.concat([prefix, account.details, credentials.signedIdentityKey.public]);
  if (!verify(account.accountSignatureKey, bytes, account.accountSignature)) return null;
  return Object.freeze({ observation_id: randomUUID(), session_identity: session, canonical_pn: pn, canonical_lid: lid || null,
    public_material_digest: digest({ public_key: Buffer.from(account.accountSignatureKey).toString('base64'),
      signature: Buffer.from(account.accountSignature).toString('base64'), details: Buffer.from(account.details).toString('base64') }),
    registration_digest: digest({ registration_id: credentials.registrationId, session_identity: session }),
    provenance, observed_at: observedAt });
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
function normalizeReceipt(context, attrs, key, ids, capturedAt = Date.now()) {
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
      captured_at: capturedAt, protocol_metadata: { origin: 'baileys.handleReceipt.pre_buffer', protocol: 'baileys-7.0.0-rc13' } };
    // Capture time/UUID do not alter source dedupe. Missing timestamp stays
    // explicit; neither a direction guess nor numeric fallback promotes ACK.
    const sourceKey = digest({ ...evidence, journal_id: null, captured_at: null });
    return { sourceKey, evidence };
  });
}
function normalizeBadAck(context, attrs, key, ids, capturedAt = Date.now()) {
  if (!attrs.error) return [];
  return normalizeReceipt(context, attrs, key, ids, capturedAt).map(item => {
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
    const previous = await tx.nexiReceiptJournal.findUnique({ where: { instanceId_sourceKey: {
      instanceId: source.instanceId, sourceKey: item.sourceKey } } });
    if (previous) { canonicalVersion(previous.canonicalVersion, source); return previous; }
    const id = randomUUID(), evidence = { ...item.evidence, journal_id: id };
    const row = await tx.nexiReceiptJournal.create({ data: { id, canonicalVersion: CANONICAL_VERSION, instanceId: source.instanceId,
      sessionIdentity: context.session_identity, sourceKey: item.sourceKey, fingerprint: digest(evidence),
      externalId: evidence.external_id, normalizedStatus: evidence.normalized_status, evidence } });
    await enqueue(tx, source, context, 'attendance.receipt.observed', evidence, item.sourceKey);
    return row;
  }, { maxWait: limits.acquireMs, timeout: Math.min(limits.statementMs, limits.deadlineMs) });
}
class ReceiptWorker {
  constructor(source, limits, appendImpl = append) {
    this.source = source; this.limits = limits; this.appendImpl = appendImpl;
    this.queue = []; this.bytes = 0; this.active = 0; this.activeBytes = 0;
    this.recovery = new Map(); this.recoveryBytes = 0; this.unhealthy = false;
  }
  gap(reason, item, context) {
    this.unhealthy = true;
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
      const job = { context, item, resolve, expired: false };
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
      Promise.resolve().then(() => this.appendImpl(this.source, job.context, job.item, this.limits)).then(row => {
        job.resolve(true); log(this.source, 'attendance.receipt.appended', { instance_id: this.source.instanceId });
        if (job.item.evidence?.protocol_metadata?.origin === 'baileys.handleBadAck.pre_buffer')
          log(this.source, 'attendance.bad_ack.captured', { journal_id: row?.id });
      }, error => {
        // A competing append may have committed the same persistent identity.
        // Leave finite recovery to retry/readback, never a WhatsApp send.
        this.gap(error.code === 'P2002' ? 'append_duplicate_race' : 'append_failed', job.item, job.context); job.resolve(false);
      }).finally(() => {
        clearTimeout(job.timer); this.active--; this.activeBytes -= job.item.size; this.pump();
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
  if (!registration) return;
  const { source, context } = registration;
  if (![PN, LID].some(pattern => pattern.test(jid(key?.remoteJid) || ''))) return;
  if (!context) {
    if (registration.ambiguous) {
      log(source, 'attendance.receipt.classification_failed', { instance_id: source.instanceId });
      void trip(source, 'receipt_classification_unresolved');
    }
    return;
  }
  if (!source.receiptRepository) { void trip(source, 'receipt_repository_unavailable'); return; }
  let worker = workers.get(source.instanceId);
  if (!worker) {
    try { worker = new ReceiptWorker(source, settings()); workers.set(source.instanceId, worker); }
    catch { void trip(source, 'receipt_limits_unconfigured'); return; }
  }
  const evidence = normalize(context, attrs, key, ids);
  if (ids.length > 128) worker.gap('receipt_packet_limit');
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
}
async function configure(service, config) {
  // Capture exact socket credentials/lifecycle. Never read replacement creds in
  // callbacks of the old socket, and never assign APP attempt ownership here.
  const source = { prismaRepository: service.prismaRepository, instanceId: service.instanceId,
    instance: { name: service.instance.name }, logger: config.logger };
  const registration = { source, context: null, ambiguous: false, credentials: config.auth?.creds };
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
        registration.context = await refreshContext(source, session);
        registration.ambiguous = false;
      }
    }
  } catch { registration.ambiguous = true; log(source, 'attendance.classification_failed', { instance_id: source.instanceId }); }
  return config;
}
async function sessionObserved(config, attestation) {
  const registration = configs.get(config);
  if (!registration || !attestation) return;
  try {
    if (await classification(registration.source) === 'legacy') return;
    // Pairing may change credentials in this exact socket. Obtain a fresh
    // authenticated context; never substitute a replacement socket's session.
    const context = await refreshContext(registration.source, attestation.session_identity);
    if (!context) return;
    registration.context = context;
    registration.ambiguous = false;
    await observe(registration.source, context, attestation);
  } catch { void trip(registration.source, 'session_observation_unresolved'); }
}
function validateIntent(context, intent) {
  canonicalVersion(context?.canonical_version);
  canonicalVersion(intent?.canonical_version);
  const fields = ['canonical_version', 'execution_id', 'transport_unit', 'authority_digest', 'payload_digest', 'identity_version_id', 'recipient', 'payload'];
  if (intent && digest(intent.payload) !== intent.payload_digest) {
    log({}, 'attendance.canonical_digest.mismatch'); fail('nexi_attendance_intent_digest_conflict');
  }
  if (!intent || Object.keys(intent).sort().join(',') !== fields.sort().join(',') || !UUID.test(intent.execution_id || '') ||
      !Number.isSafeInteger(intent.transport_unit) || intent.transport_unit < 0 || !HASH.test(intent.authority_digest || '') ||
      !HASH.test(intent.payload_digest || '') || digest(intent.payload) !== intent.payload_digest || !PN.test(intent.recipient || '') ||
      !Number.isSafeInteger(intent.identity_version_id) || intent.identity_version_id <= 0 ||
      !UUID.test(context.instance_lineage_id || '') || !UUID.test(context.sender_account_lineage_id || '') ||
      !UUID.test(context.sender_attestation_id || '') || context.current_session !== true || context.channel_state !== 'active' ||
      !['staged', 'active'].includes(context.barrier_state) || !Number.isSafeInteger(context.writer_epoch) ||
      context.writer_epoch <= 0 || Buffer.byteLength(JSON.stringify(intent)) > 8192) fail('nexi_attendance_intent_unresolved');
}
function requestMaterial(row, action) {
  return { ...common(row.authority), action, request_id: row.requests[action], execution_id: row.executionId,
    original_session_identity: row.sessionIdentity,
    attempt_id: action === 'attempt' ? null : row.attemptId, transport_unit: row.transportUnit,
    external_id: row.externalId, authority_digest: row.authorityDigest, payload_digest: row.payloadDigest,
    preparation_id: row.id, preparation_nonce_digest: digest(row.preparationNonce), recipient: row.recipient,
    identity_version_id: row.intent.identity_version_id };
}
async function compareUpdate(db, row, changes) {
  const updated = await db.updateMany({ where: { id: row.id, revision: row.revision, state: row.state },
    data: { ...changes, revision: { increment: 1 } } });
  if (updated.count !== 1) fail('nexi_attendance_preparation_conflict');
  return db.findUnique({ where: { id: row.id } });
}
async function draft(source, context, intent, requestId, predecessor = null) {
  validateIntent(context, intent);
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
  if (['prepared', 'awaiting_admission'].includes(row.state)) {
    const content = digest({ intent: row.intent, attempt_id: row.attemptId, reservation_id: row.reservationId,
      external_id: row.externalId, authority: row.authority });
    if (!row.frozenAt || !row.reservationId || content !== row.contentDigest || row.preparationDigest !== digest({
      content_digest: content, authority_digest: row.authorityDigest, preparation_id: row.id,
      nonce: row.preparationNonce, revision: row.preparationRevision })) fail('nexi_attendance_frozen_digest_conflict');
    return row;
  }
  if (!['draft', 'reserved'].includes(row.state) || row.dispatchStartedAt || row.admissionId || row.releaseId)
    fail('nexi_attendance_preparation_fenced');
  if (!row.attemptId) {
    const result = await requestImpl(source, requestMaterial(row, 'attempt'));
    if (result.outcome !== 'attempt_registered' || !UUID.test(result.attempt_id || '') || result.external_id !== row.externalId ||
        result.authority_digest !== row.authorityDigest || result.payload_digest !== row.payloadDigest ||
        result.recipient !== row.recipient || result.identity_version_id !== row.intent.identity_version_id ||
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
      preparation_id: row.id, preparation_nonce: row.preparationNonce, revision: row.preparationRevision,
      content_digest: contentDigest, authority_digest: row.authorityDigest, preparation_digest: preparationDigest,
      observed_at: +current.frozenAt }, digest(['preparation', row.id]));
    return current;
  });
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
    fail('nexi_attendance_dispatch_disabled_wave1b');
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
  const registration = configs.get(config);
  if (scope.getStore()) fail('nexi_attendance_dispatch_disabled_wave1b');
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
  // Generic legacy writers remain enabled until the APP-owned cutover. No
  // configuration flag can activate that cutover or physical Attendance here.
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
    let settled = false;
    try {
      const transport = require('./nexi-transport.cjs');
      const prepared = transport.prepareEvent(destination.headers, row.body, row.instanceName, row.instanceId);
      prepared.headers['X-Nexi-Event-Id'] = row.id;
      const response = await fetchImpl(destination.url, { method: 'POST', redirect: 'error',
        headers: transport.freshEventHeaders(prepared.headers, row.body), body: canonicalBytes(row.body),
        signal: AbortSignal.timeout(10000) });
      const ack = response.ok ? await response.json() : null;
      if (ack?.ack === 'persisted' && ack.event_id === row.id && ack.fingerprint === row.fingerprint && ack.version === 1) {
        await db.updateMany({ where: { id: row.id, state: 'pending', leaseToken: token }, data: {
          state: 'acknowledged', acknowledgedAt: new Date(), leaseToken: null, leaseUntil: null } });
        settled = true;
      }
      // Unsupported APP schema is retained with immutable UUID/body. It can be
      // explicitly re-enabled after compatible APP deployment; never dropped.
      if ([400, 404, 422].includes(response.status)) {
        await db.updateMany({ where: { id: row.id, state: 'pending', leaseToken: token },
          data: { state: 'unsupported', leaseToken: null, leaseUntil: null } }); settled = true;
      }
    } catch { /* response loss leaves the same durable event pending */ }
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
function installRoutes(router, monitor, guard, repository) {
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
      const context = await refreshContext(source, claims.session_identity);
      if (!groups.lifecycleCurrent(owner) || identity.sessionFingerprint(service.client?.authState?.creds) !== claims.session_identity)
        fail('nexi_attendance_session_superseded');
      if (context?.managed_channel_id !== claims.managed_channel_id || context.writer_epoch !== claims.writer_epoch)
        fail('nexi_attendance_authorization_superseded');
      const row = await draft(source, context, claims.intent, claims.request_id);
      const prepared = await prepare(source, row);
      return res.json({ state: prepared.state, preparation_id: prepared.id, attempt_id: prepared.attemptId,
        reservation_id: prepared.reservationId, external_id: prepared.externalId, preparation_digest: prepared.preparationDigest,
        physical_dispatch: false });
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
      return res.json({ physical_dispatch: false, receipt_health: row?.unhealthy || worker?.unhealthy ? 'evidence_gap' : 'unproved',
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
      for (const entry of pending) await drain({ prismaRepository: repository, instanceId: entry.instanceId,
        instance: { name: entry.instanceName } }).catch(() => {});
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
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'claims,signature' || typeof envelope.claims !== 'string' ||
      envelope.claims.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(envelope.claims) || !HASH.test(envelope.signature || ''))
    fail('nexi_attendance_prepare_authentication_required');
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) fail('nexi_attendance_prepare_authentication_required');
  const secret = createHmac('sha256', master).update(`event:${service.instance.name}`).digest();
  const expected = createHmac('sha256', secret).update(`attendance-prepare:v1:${envelope.claims}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex'))) fail('nexi_attendance_prepare_authentication_required');
  const claims = decodeCanonicalClaims(envelope.claims);
  canonicalVersion(claims.canonical_version);
  if (Object.keys(claims).sort().join(',') !== 'audience,canonical_version,expires_at,instance,instance_id,intent,managed_channel_id,physical_dispatch,provider,request_id,session_identity,version,writer_epoch' ||
      claims.version !== 1 || claims.audience !== 'nexi-attendance-evolution' || claims.provider !== 'evolution-baileys' ||
      claims.instance !== service.instance.name || claims.instance_id !== service.instanceId || claims.physical_dispatch !== false ||
      !['managed_channel_id', 'writer_epoch'].every(key => Number.isSafeInteger(claims[key]) && claims[key] > 0) ||
      !UUID.test(claims.request_id || '') || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= now || claims.expires_at > now + 60000 ||
      claims.session_identity !== identity.sessionFingerprint(service.client?.authState?.creds)) fail('nexi_attendance_prepare_authentication_required');
  return claims;
}
function decodeCanonicalClaims(encoded) {
  const buffer = Buffer.from(encoded, 'base64url'), text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) fail('nexi_attendance_noncanonical_material');
  return canonicalJson.parse(text);
}
module.exports = { canonical, digest, eventPayload, settings, publicAttestation, normalizeReceipt, normalization, numericNormalization,
  configure, sessionObserved, capture, refreshContext, classification, draft, prepare, closeCollision,
  foundationCapability, bindStanza, assertNode, externalRaw, retryMessage, legacyAllowed, legacyForInstance, ReceiptWorker,
  drain, installRoutes, requestMaterial, common, prepareClaims, rawNodeForInstance, rawNodeForSocket, trackSocket,
  append, enqueue, inheritConfig, boundedMariaDb, recoverPreparation, semanticPurpose, markInternalControl,
  normalizeBadAck, captureBadAck, canonicalBytes, CANONICAL_VERSION, ID_PREFIX,
  beginRelay, encodingInput, patchEncoding, encodeMessage, snapshotFrame };
