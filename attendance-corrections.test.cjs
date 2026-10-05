'use strict';
// Source tests for EasyPanel only. Do not execute on Serra.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const a = require('./nexi-attendance.cjs');
const identity = require('./nexi-identity.cjs');
const financial = require('./nexi-financial-transport.cjs');
const master = 'synthetic-correction-event-master-at-least-32';
const own = '5511999999999@s.whatsapp.net', recipient = '5511888888888@s.whatsapp.net';
const creds = () => ({ me: { id: own, lid: '10001@lid' }, registrationId: 9,
  signedIdentityKey: { public: Buffer.alloc(32, 7) } });
const edit = () => ({ protocolMessage: { type: 14,
  key: { remoteJid: recipient, fromMe: true, id: 'ORIGINAL-CUSTOMER-ID' },
  editedMessage: { conversation: 'synthetic edited body' }, timestampMs: 1720000000000 } });
const control = () => ({ protocolMessage: { type: 16, peerDataOperationRequestMessage: {
  peerDataOperationRequestType: 4,
  placeholderMessageResendRequest: [{ messageKey: { remoteJid: recipient, fromMe: false, id: 'INCOMING-PLACEHOLDER' } }] } } });
async function socket(kind) {
  const instanceId = randomUUID(), name = 'nexi-wa-' + instanceId, credentials = creds();
  const context = { version: 1, protocol_version: 1, canonical_version: 'canonical_json_v1',
    audience: 'nexi-attendance-evolution', provider: 'evolution-baileys', account_id: 1, inbox_id: 2,
    managed_channel_id: 3, instance_id: instanceId, instance: name, instance_lineage_id: randomUUID(),
    sender_account_lineage_id: randomUUID(), sender_attestation_id: randomUUID(),
    session_identity: identity.sessionFingerprint(credentials), original_session_identity: null,
    binding_generation: 1, writer_epoch: 1, writer_protocol_version: 1, barrier_state: 'staged',
    channel_state: 'active', current_session: true, physical_dispatch: false, isolation_cutover: false };
  const journals = [], events = [], health = [];
  const table = rows => ({
    findUnique: async ({ where }) => rows.find(row => row.instanceId === where.instanceId_sourceKey?.instanceId &&
      row.sourceKey === where.instanceId_sourceKey?.sourceKey) || null,
    create: async ({ data }) => { rows.push(data); return data; },
  });
  const repo = { nexiManagedTransportContext: {
    findFirst: async () => kind === 'legacy' ? null : { instanceId, instanceName: name, sessionIdentity: context.session_identity,
      canonicalVersion: 'canonical_json_v1', payload: context, fingerprint: a.digest(context) },
    findUnique: async () => ({ payload: context, canonicalVersion: a.CANONICAL_VERSION }),
  }, webhook: { findUnique: async () => kind === 'legacy' ? null : { enabled: kind === 'managed',
    url: 'https://app.invalid/webhooks/nexi/channels/evolution', headers: {
      'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '2' } } },
  nexiAttendancePreparation: { findFirst: async () => null },
  nexiAttendanceHealth: { upsert: async ({ create }) => { health.push(create); return create; } },
  nexiReceiptJournal: table(journals), nexiAttendanceEventOutbox: table(events),
  $executeRawUnsafe: async () => 0,
  $transaction: async work => {
    const counts = [journals.length, events.length];
    try { return await work(repo); }
    catch (error) { journals.splice(counts[0]); events.splice(counts[1]); throw error; }
  }, attendanceReceiptRepository: () => repo };
  const source = { prismaRepository: repo, receiptRepository: repo, instanceId, instance: { name }, logger: { warn() {} } };
  const config = { auth: { creds: credentials } }, previousFetch = global.fetch;
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  global.fetch = async (_url, options) => {
    const nonce = JSON.parse(options.body).data.nonce;
    const claims = Buffer.from(a.canonicalBytes({ ...context, nonce })).toString('base64url');
    const secret = createHmac('sha256', master).update('event:' + name).digest();
    return { ok: true, json: async () => ({ claims,
      signature: createHmac('sha256', secret).update('attendance-context:v1:' + claims).digest('hex') }) };
  };
  try { await a.configure(source, config); } finally { global.fetch = previousFetch; }
  return { config, source, context, repo, journals, events, health };
}
const stanza = (to = recipient) => ({ tag: 'message', attrs: { id: 'NEW-OUTER-ID', to } });

test('managed and ambiguous pinned editedMessage/revoke/reaction never inherit protocol exemption', async () => {
  for (const kind of ['managed', 'ambiguous']) {
    const f = await socket(kind);
    for (const message of [edit(), { protocolMessage: { type: 0, key: edit().protocolMessage.key } },
      { reactionMessage: { key: edit().protocolMessage.key, text: 'synthetic' } },
      { ephemeralMessage: { message: edit() } }, { associatedChildMessage: { message: edit() } }]) {
      const node = stanza(); a.bindStanza(f.config, node, message, node.attrs.id);
      await assert.rejects(a.assertNode(f.config, node), /customer_protocol_denied/);
    }
    const forged = stanza(); forged.attrs.category = 'peer'; forged.attrs.purpose = 'internal_control';
    await assert.rejects(a.assertNode(f.config, forged), /unknown_protocol_denied/); // bypass relay/high-level route
  }
});
const limits = { queueItems: 4, queueBytes: 65536, concurrent: 1, acquireMs: 5, statementMs: 10,
  lockMs: 5, deadlineMs: 100, recoveryItems: 2, recoveryBytes: 65536 };
test('authenticated bad ACK uses the same journal/outbox, persistent dedupe and non-positive ERROR contract', async () => {
  const f = await socket('ambiguous'), attrs = { id: 'REJECTED-ID', from: recipient, error: '479', t: '1720000000' };
  const key = { id: attrs.id, remoteJid: attrs.from, fromMe: true };
  const env = { QUEUE_ITEMS: '4', QUEUE_BYTES: '65536', APPEND_CONCURRENCY: '1', DB_ACQUISITION_TIMEOUT_MS: '5',
    DB_STATEMENT_TIMEOUT_MS: '10', DB_LOCK_TIMEOUT_MS: '5', APPEND_DEADLINE_MS: '100', RECOVERY_ITEMS: '2', RECOVERY_BYTES: '65536' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env['NEXI_ATTENDANCE_' + key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env['NEXI_ATTENDANCE_' + key] = value;
    await a.captureBadAck(f.config, attrs, key);
    await a.captureBadAck(f.config, attrs, key);
    assert.equal(f.journals.length, 1); assert.equal(f.events.length, 1);
    const evidence = f.journals[0].evidence;
    assert.equal(evidence.normalized_status, 'ERROR'); assert.equal(evidence.protocol_metadata.error_code, '479');
    assert.equal(evidence.session_identity, f.context.session_identity);
    assert.equal(f.events[0].body.data.normalized_status, 'ERROR');
    assert.notEqual(evidence.normalized_status, 'SERVER_ACK'); assert.notEqual(evidence.normalized_status, 'DELIVERY_ACK');
    // ERROR and a later positive receipt are independent evidence, never overwrites.
    await a.append(f.source, f.context, a.normalizeReceipt(f.context, {}, key, [key.id])[0], limits);
    assert.equal(f.journals.length, 2); assert.equal(f.journals[1].normalizedStatus, 'DELIVERY_ACK');
    await a.append(f.source, f.context, a.normalizeBadAck(f.context, { ...attrs, error: '463' }, key, [key.id])[0], limits);
    assert.equal(f.journals.length, 3);
    assert.equal(await a.retryMessage(f.config, key, { conversation: 'cached' }), undefined);
    for (const remote of ['120363000000000000@g.us', 'status@broadcast', '123@broadcast'])
      assert.deepEqual(a.normalizeBadAck(f.context, attrs, { ...key, remoteJid: remote }, [key.id]), []);
    const wrongDirection = a.normalizeBadAck(f.context, attrs, { ...key, fromMe: false }, [key.id])[0];
    assert.equal(wrongDirection.evidence.normalized_status, 'UNKNOWN');
    assert.equal(a.eventPayload('attendance.receipt.observed', { ...wrongDirection.evidence, journal_id: randomUUID() }).normalized_status, 'UNKNOWN');
    assert.equal(a.normalizeBadAck(f.context, { ...attrs, error: 'x'.repeat(2000) }, key, [key.id])[0].evidence.protocol_metadata.error_code, null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env['NEXI_ATTENDANCE_' + key]; else process.env['NEXI_ATTENDANCE_' + key] = value;
    }
  }
});
test('bad ACK outbox failure rolls back journal; append failure trips sticky health without granting retry', async () => {
  const f = await socket('ambiguous'), key = { remoteJid: recipient, fromMe: true, id: 'ERROR-ID' };
  const item = a.normalizeBadAck(f.context, { error: '479' }, key, [key.id])[0];
  f.repo.nexiAttendanceEventOutbox.create = async () => { throw new Error('synthetic outbox unavailable'); };
  await assert.rejects(a.append(f.source, f.context, item, limits), /unavailable/);
  assert.equal(f.journals.length, 0); assert.equal(f.events.length, 0);
  const worker = new a.ReceiptWorker(f.source, limits);
  assert.equal(await worker.submit(f.context, item), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.unhealthy, true); assert.ok(f.health.some(row => row.unhealthy && row.reason === 'append_failed'));
  assert.equal(await a.retryMessage(f.config, key, { conversation: 'cached' }), undefined);
  await assert.rejects(a.assertNode(f.config, stanza()), /unknown_protocol_denied/);
});
test('legacy edits remain unchanged; unknown enum is denied on both managed classifications', async () => {
  const legacy = await socket('legacy'), node = stanza(); a.bindStanza(legacy.config, node, edit(), node.attrs.id);
  await a.assertNode(legacy.config, node);
  for (const kind of ['managed', 'ambiguous']) {
    const f = await socket(kind), unknown = stanza();
    a.bindStanza(f.config, unknown, { protocolMessage: { type: 999 } }, unknown.attrs.id);
    await assert.rejects(a.assertNode(f.config, unknown), /unknown_protocol_denied/);
  }
});
test('only pinned trusted incoming-placeholder control to our own phone is exempt, never JSON flags or later mutation', async () => {
  const f = await socket('ambiguous'), message = control(), node = stanza(own);
  a.markInternalControl(f.config, message, own); a.bindStanza(f.config, node, message, node.attrs.id);
  await a.assertNode(f.config, node);
  const changedWire = stanza(own); a.bindStanza(f.config, changedWire, message, changedWire.attrs.id);
  changedWire.attrs.to = recipient;
  await assert.rejects(a.assertNode(f.config, changedWire), /unknown_protocol_denied/);
  for (const forged of [control(), { ...control(), internal: true }]) {
    const raw = stanza(own); a.bindStanza(f.config, raw, forged, raw.attrs.id);
    await assert.rejects(a.assertNode(f.config, raw), /unknown_protocol_denied/);
  }
  message.protocolMessage.peerDataOperationRequestMessage.peerDataOperationRequestType = 3;
  const mutated = stanza(own); a.bindStanza(f.config, mutated, message, mutated.attrs.id);
  await assert.rejects(a.assertNode(f.config, mutated), /unknown_protocol_denied/);
  const outbound = control(); outbound.protocolMessage.peerDataOperationRequestMessage.placeholderMessageResendRequest[0].messageKey.fromMe = true;
  a.markInternalControl(f.config, outbound, own); const retry = stanza(own); a.bindStanza(f.config, retry, outbound, retry.attrs.id);
  await assert.rejects(a.assertNode(f.config, retry), /unknown_protocol_denied/);
  for (const tag of ['ack', 'receipt', 'iq', 'presence']) await a.assertNode(f.config, { tag, attrs: {} });
  await a.assertNode(f.config, stanza('120363000000000000@g.us')); // Existing Groups gate remains in pinned source.
  assert.throws(() => financial.assertWireRecipient(recipient,
    { attrs: { id: '3EB0F1A9C7D5E3B1AAAA' } }, creds(), {}, true), /native_retry_denied/);
  await assert.rejects(a.foundationCapability({ reservationId: randomUUID(), preparationDigest: 'a'.repeat(64) },
    () => a.assertNode(f.config, node)), /dispatch_disabled_wave1b/);
});
