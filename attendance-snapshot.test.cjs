'use strict';
// Actual pinned lexical sendNode/relay bodies, with deterministic async barriers.
// EasyPanel only; never execute project suites on Serra.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHmac } = require('node:crypto');
const a = require('./nexi-attendance.cjs'), snapshots = require('./nexi-attendance-snapshot.cjs');
const identity = require('./nexi-identity.cjs'), financial = require('./nexi-financial-transport.cjs'), groups = require('./nexi-groups.cjs');
const Long = require('long');
let proto, binary;
before(async () => {
  ({ proto } = await import(pathToFileURL(path.join(__dirname, 'node_modules/baileys/WAProto/index.js'))));
  binary = await import(pathToFileURL(path.join(__dirname, 'node_modules/baileys/lib/WABinary/index.js')));
});
const own = '5511999999999@s.whatsapp.net', peer = '5511888888888@s.whatsapp.net';
const creds = () => ({ me: { id: '5511999999999:2@s.whatsapp.net' }, registrationId: 9, signedIdentityKey: { public: Buffer.alloc(32, 7) } });
function barrier() {
  let enter, release; const reached = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, resumed, release, async wait() { enter(); await resumed; } };
}
function lexical(file, start, end) {
  const source = fs.readFileSync(path.join(__dirname, 'node_modules/baileys/lib/Socket', file), 'utf8');
  assert.equal(source.split(start).length - 1, 1); assert.equal(source.split(end).length - 1, 1);
  return source.slice(source.indexOf(start), source.indexOf(end));
}
function actualSendNode(config, gate, sent) {
  const source = lexical('socket.js', '    const sendNode = async (frame) => {', '    /**\n     * Wait for a message');
  return new Function('config', 'nexiAttendance', 'logger', 'binaryNodeToString', 'encodeBinaryNode', 'sendRawMessage',
    source + '\nreturn sendNode;')(config, { snapshotFrame: a.snapshotFrame, assertNode: gate },
    { level: 'silent' }, binary.binaryNodeToString, binary.encodeBinaryNode, async bytes => { sent.push(Buffer.from(bytes)); });
}
async function socket(kind = 'ambiguous') {
  const config = { auth: { creds: creds() }, nexiFinancialManaged: false }, instanceId = randomUUID();
  const name = 'nexi-wa-' + instanceId;
  const context = { version: 1, protocol_version: 1, canonical_version: a.CANONICAL_VERSION,
    audience: 'nexi-attendance-evolution', provider: 'evolution-baileys', account_id: 1, inbox_id: 2, managed_channel_id: 3,
    instance_id: instanceId, instance: name, instance_lineage_id: randomUUID(), sender_account_lineage_id: randomUUID(),
    sender_attestation_id: randomUUID(), session_identity: identity.sessionFingerprint(config.auth.creds), original_session_identity: null,
    binding_generation: 1, writer_epoch: 1, writer_protocol_version: 1, barrier_state: 'staged', channel_state: 'active',
    current_session: true, physical_dispatch: false, isolation_cutover: false };
  const repo = { webhook: { findUnique: async () => kind !== 'managed' ? null : ({ enabled: true,
    url: 'https://app.invalid/webhooks/nexi/channels/evolution', headers: {
      'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '2' } }) }, attendanceReceiptRepository: () => ({}),
    nexiManagedTransportContext: { findFirst: async () => kind === 'legacy' ? null : ({ instanceId,
      canonicalVersion: a.CANONICAL_VERSION, sessionIdentity: context.session_identity, fingerprint: a.digest(context), payload: context }),
      findUnique: async () => ({ canonicalVersion: a.CANONICAL_VERSION, payload: context }) },
    nexiAttendancePreparation: { findFirst: async () => null }, nexiAttendanceHealth: { upsert: async () => ({}) } };
  const previousFetch = global.fetch, previousMaster = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
  const master = 'synthetic-snapshot-boundary-event-master-32';
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  global.fetch = async (_url, options) => {
    const claims = Buffer.from(a.canonicalBytes({ ...context, nonce: JSON.parse(options.body).data.nonce })).toString('base64url');
    return { ok: true, json: async () => ({ claims, signature: createHmac('sha256',
      createHmac('sha256', master).update('event:' + name).digest()).update('attendance-context:v1:' + claims).digest('hex') }) };
  };
  try { await a.configure({ prismaRepository: repo, instanceId, instance: { name }, logger: { warn() {} } }, config); }
  finally {
    global.fetch = previousFetch;
    if (previousMaster === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
    else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = previousMaster;
  }
  return config;
}
function actualRelay(config, encryption, sent, patch = value => value, devices) {
  const source = lexical('messages-send.js', '    const createParticipantNodes = async ', '    const issuePrivacyTokens = async ');
  const args = { config, nexiAttendance: a, nexiFinancial: financial, nexiGroups: groups, Long, proto,
    authState: { creds: config.auth.creds, keys: { transaction: async fn => fn(), get: async () => ({}) } },
    logger: { debug() {}, trace() {}, warn() {}, error() {} }, patchMessageBeforeSending: patch,
    encryptionMutex: { mutex: async (_jid, fn) => fn() },
    signalRepository: { encryptMessage: encryption, lidMapping: { getPNForLID: async value => value } },
    assertMeId: credentials => credentials.me.id, generateMessageIDV2: () => 'GENERATED',
    jidDecode: binary.jidDecode, jidEncode: binary.jidEncode, isLidUser: binary.isLidUser,
    isJidGroup: binary.isJidGroup, areJidsSameUser: binary.areJidsSameUser,
    getUSyncDevices: async () => devices || [{ user: '5511888888888', device: 1, jid: '5511888888888:1@s.whatsapp.net' }],
    assertSessions: async () => {}, generateParticipantHashV2: () => 'test-hash',
    encodeWAMessage: value => proto.Message.encode(value).finish(),
    encodeNewsletterMessage: value => proto.Message.encode(value).finish(),
    normalizeMessageContent: value => value, resolveTcTokenJid: async value => value, getLIDForPN: async value => value,
    isTcTokenExpired: () => false,
    sock: { serverProps: {} }, PSA_WID: '0@s.whatsapp.net', isJidBot: () => false, isJidMetaAI: () => false,
    shouldSendNewTcToken: () => false, messageRetryManager: null,
    sendNode: actualSendNode(config, (c, frame) => a.assertNode(c, frame), sent) };
  return new Function(...Object.keys(args), source + '\nreturn relayMessage;')(...Object.values(args));
}
const edit = () => ({ protocolMessage: { type: 14, key: { id: 'ORIGINAL', remoteJid: peer, fromMe: true },
  editedMessage: { conversation: 'original edit', imageMessage: { jpegThumbnail: Buffer.from([1, 2, 3]) } }, timestampMs: 1720000000000 } });
const control = () => ({ protocolMessage: { type: 16, peerDataOperationRequestMessage: { peerDataOperationRequestType: 4,
  placeholderMessageResendRequest: [{ messageKey: { id: 'INCOMING', remoteJid: peer, fromMe: false } }] } } });

test('actual relay captures edit semantics/options before encryption; mutate/restore cannot hide edit or change bytes', async () => {
  const config = await socket('managed'), beforeEncode = barrier(), pause = barrier(), sent = [], plaintexts = [], original = edit();
  const opts = { messageId: 'OUTER-ORIGINAL', additionalAttributes: { edit: '1' }, additionalNodes: [] };
  const relay = actualRelay(config, async ({ data }) => { plaintexts.push(Buffer.from(data)); await pause.wait();
    return { type: 'msg', ciphertext: Buffer.from(data) }; }, sent, async value => { await beforeEncode.wait(); return value; });
  const result = assert.rejects(relay(peer, original, opts), /customer_protocol_denied/);
  await beforeEncode.reached;
  original.protocolMessage.type = 16; original.protocolMessage.editedMessage.conversation = 'transient changed edit';
  original.protocolMessage.editedMessage.imageMessage.jpegThumbnail.fill(9);
  opts.messageId = 'SUBSTITUTED'; opts.additionalAttributes.to = own; opts.additionalNodes.push({ tag: 'evil', attrs: {} });
  beforeEncode.release(); await pause.reached;
  original.protocolMessage.type = 14; original.protocolMessage.editedMessage.conversation = 'original edit';
  original.protocolMessage.editedMessage.imageMessage.jpegThumbnail = Buffer.from([1, 2, 3]);
  pause.release(); await result;
  const encoded = proto.Message.decode(plaintexts[0]);
  assert.equal(encoded.protocolMessage.type, 14); assert.equal(encoded.protocolMessage.editedMessage.conversation, 'original edit');
  assert.deepEqual(Buffer.from(encoded.protocolMessage.editedMessage.imageMessage.jpegThumbnail), Buffer.from([1, 2, 3]));
  assert.equal(sent.length, 0);
});

test('actual internal PDO encrypts immutable subtype 4; copied objects and changed callback payload cannot acquire exemption', async () => {
  const config = await socket(), beforeEncode = barrier(), pause = barrier(), original = control(), sent = [], decoded = [];
  const trusted = a.markInternalControl(config, original, own);
  const relay = actualRelay(config, async ({ data }) => { decoded.push(proto.Message.decode(data)); await pause.wait();
    return { type: 'msg', ciphertext: Buffer.from(data) }; }, sent, async value => { await beforeEncode.wait(); return value; });
  const result = relay(own, trusted, { messageId: 'INTERNAL', additionalAttributes: { category: 'peer' } });
  await beforeEncode.reached; original.protocolMessage.peerDataOperationRequestMessage.peerDataOperationRequestType = 3;
  original.protocolMessage.peerDataOperationRequestMessage.placeholderMessageResendRequest[0].messageKey.remoteJid = own;
  beforeEncode.release(); await pause.reached;
  original.protocolMessage.peerDataOperationRequestMessage.peerDataOperationRequestType = 4;
  original.protocolMessage.peerDataOperationRequestMessage.placeholderMessageResendRequest[0].messageKey.remoteJid = peer;
  pause.release(); await result;
  const semantic = decoded[0].deviceSentMessage?.message || decoded[0];
  assert.equal(semantic.protocolMessage.peerDataOperationRequestMessage.peerDataOperationRequestType, 4);
  assert.equal(semantic.protocolMessage.peerDataOperationRequestMessage.placeholderMessageResendRequest[0].messageKey.remoteJid, peer);
  assert.equal(sent.length, 1);
  const fast = async ({ data }) => ({ type: 'msg', ciphertext: Buffer.from(data) });
  await assert.rejects(actualRelay(config, fast, [])(own, control(), { messageId: 'COPIED', additionalAttributes: { category: 'peer' } }), /unknown_protocol_denied/);
  const maliciousPatch = async value => {
    const body = value.deviceSentMessage?.message || value;
    body.protocolMessage.peerDataOperationRequestMessage.peerDataOperationRequestType = 3;
    return value;
  };
  await assert.rejects(actualRelay(config, fast, [], maliciousPatch)(own, trusted,
    { messageId: 'PATCHED', additionalAttributes: { category: 'peer' } }), /unknown_protocol_denied/);
});

test('actual final sendNode snapshots non-message before await; later conversion to message cannot affect socket bytes', async () => {
  const config = await socket(), pause = barrier(), sent = [], original = { tag: 'iq', attrs: { id: 'IQ', to: own }, content: [] };
  const expected = binary.encodeBinaryNode(original);
  const sendNode = actualSendNode(config, async (c, frame) => { await pause.wait(); await a.assertNode(c, frame); }, sent);
  const result = sendNode(original); await pause.reached;
  original.tag = 'message'; original.attrs = { id: 'CUSTOMER', to: peer }; original.content.push({ tag: 'enc', attrs: {}, content: Buffer.from('evil') });
  pause.release(); await result; assert.deepEqual(sent[0], expected);
});

test('actual final sendNode protects ID/to/participant, attrs replacement, children and bytes while validation awaits', async () => {
  const config = await socket('legacy'), pause = barrier(), sent = [];
  const original = { tag: 'message', attrs: { id: 'LEGACY-ID', to: peer, participant: '10001@lid' },
    content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from([1, 2, 3]) }] };
  const expected = binary.encodeBinaryNode(original);
  const sendNode = actualSendNode(config, async (c, frame) => { await a.assertNode(c, frame); await pause.wait(); }, sent);
  const result = sendNode(original); await pause.reached;
  original.attrs.id = 'BAD'; original.attrs.to = own; original.attrs.participant = '10002@lid';
  original.content[0].content.fill(9); original.content[0].attrs.type = 'pkmsg'; original.content.push({ tag: 'extra', attrs: {} });
  original.attrs = { id: 'REPLACED', to: own }; original.tag = 'iq';
  pause.release(); await result; assert.deepEqual(sent[0], expected);
});

test('actual legacy relay keeps protobuf content and options stable during async callback and encryption', async () => {
  const config = await socket('legacy'), patchPause = barrier(), encryptedPause = barrier(), sent = [];
  const original = { conversation: 'legacy original', messageContextInfo: { messageSecret: Buffer.from([1, 2]) } };
  // Avoid reporting-token code: use binary thumbnail in a valid image instead.
  delete original.messageContextInfo; original.imageMessage = { jpegThumbnail: new Uint8Array([4, 5]) };
  const options = { messageId: 'STABLE-ID', additionalAttributes: { custom: 'stable' } }, plaintexts = [];
  const relay = actualRelay(config, async ({ data }) => { plaintexts.push(Buffer.from(data)); await encryptedPause.wait();
    return { type: 'msg', ciphertext: Buffer.from(data) }; }, sent, async value => { await patchPause.wait(); return value; });
  const result = relay(peer, original, options); await patchPause.reached;
  original.conversation = 'mutated'; original.imageMessage.jpegThumbnail.fill(9);
  options.messageId = 'BAD-ID'; options.additionalAttributes.to = own; options.additionalAttributes.custom = 'bad';
  patchPause.release(); await encryptedPause.reached; original.conversation = 'legacy original'; encryptedPause.release();
  await result;
  assert.equal(proto.Message.decode(plaintexts[0]).conversation, 'legacy original');
  assert.deepEqual(Buffer.from(proto.Message.decode(plaintexts[0]).imageMessage.jpegThumbnail), Buffer.from([4, 5]));
  const wire = await binary.decodeBinaryNode(sent[0]); assert.equal(wire.attrs.id, 'STABLE-ID'); assert.equal(wire.attrs.to, peer);
  assert.equal(wire.attrs.custom, 'stable');
});

test('snapshot preserves installed protobuf, Long, undefined/null and binary semantics without freezing caller', () => {
  const original = proto.Message.fromObject({ protocolMessage: { type: 14, key: { id: 'KEY', fromMe: true },
    editedMessage: { imageMessage: { jpegThumbnail: Buffer.from([1, 2]), fileLength: Long.fromString('9007199254740993', true) } },
    timestampMs: Long.fromString('1720000000000') } });
  const config = { auth: { creds: creds() } }, fixed = a.beginRelay(config, peer, original, {}, proto, Long.prototype).message;
  assert.deepEqual(proto.Message.encode(fixed).finish(), proto.Message.encode(original).finish());
  assert.ok(Object.isFrozen(fixed.protocolMessage.editedMessage.imageMessage)); assert.ok(!Object.isFrozen(original));
  fixed.protocolMessage.editedMessage.imageMessage.jpegThumbnail.fill(8);
  assert.deepEqual(Buffer.from(fixed.protocolMessage.editedMessage.imageMessage.jpegThumbnail), Buffer.from([1, 2]));
  const shape = snapshots.copy({ absent: undefined, nil: null, list: [undefined, null], binary: new Uint8Array([3]) });
  assert.equal(shape.absent, undefined); assert.equal(shape.nil, null); assert.equal(shape.list.length, 2);
  assert.notEqual(snapshots.fingerprint({ number: -0 }), snapshots.fingerprint({ number: 0 }));
  const tooDeep = {}; let nested = tooDeep;
  for (let index = 0; index < snapshots.LIMITS.depth + 1; index++) { nested.next = {}; nested = nested.next; }
  const tooMany = Object.fromEntries(Array.from({ length: snapshots.LIMITS.nodes }, (_, index) => ['field' + index, 1]));
  for (const value of [new Date(), Object.create({ inherited: true }), { get value() { assert.fail('accessor executed'); } },
    (() => { const cycle = {}; cycle.self = cycle; return cycle; })(), new Array(snapshots.LIMITS.nodes + 1),
    tooDeep, tooMany, { bytes: Buffer.alloc(snapshots.LIMITS.bytes + 1) }]) assert.throws(() => snapshots.copy(value), /snapshot_/);
});

test('participant fanout encodes isolated semantic material even when callback/caller retain writable references', async () => {
  const config = await socket('legacy'), pause = barrier(), sent = [], plaintexts = [], retained = [];
  const original = { conversation: 'same revision', imageMessage: { jpegThumbnail: Buffer.from([1, 2]) } };
  const devices = [
    { user: '5511888888888', device: 1, jid: '5511888888888:1@s.whatsapp.net' },
    { user: '5511888888888', device: 2, jid: '5511888888888:2@s.whatsapp.net' },
    { user: '5511999999999', device: 3, jid: '5511999999999:3@s.whatsapp.net' },
  ];
  const relay = actualRelay(config, async ({ data }) => {
    plaintexts.push(Buffer.from(data));
    if (plaintexts.length === devices.length) await pause.wait(); else await pause.resumed;
    return { type: 'msg', ciphertext: Buffer.from(data) };
  }, sent, async value => { retained.push(value); return value; }, devices);
  const result = relay(peer, original, { messageId: 'FANOUT' }); await pause.reached;
  original.conversation = 'caller changed'; original.imageMessage.jpegThumbnail.fill(8);
  for (const value of retained) {
    const semantic = value.deviceSentMessage?.message || value;
    semantic.conversation = 'callback retained'; semantic.imageMessage.jpegThumbnail.fill(9);
  }
  pause.release(); await result;
  assert.equal(plaintexts.length, 3);
  for (const bytes of plaintexts) {
    const encoded = proto.Message.decode(bytes), semantic = encoded.deviceSentMessage?.message || encoded;
    assert.equal(semantic.conversation, 'same revision');
    assert.deepEqual(Buffer.from(semantic.imageMessage.jpegThumbnail), Buffer.from([1, 2]));
  }
  assert.equal(sent.length, 1);
});

test('immutable PDO provenance cannot transfer to another recipient, replacement session or altered final frame', async () => {
  const config = await socket(), trusted = a.markInternalControl(config, control(), own);
  const encode = value => Buffer.from(JSON.stringify(value));
  const wrongRecipient = a.beginRelay(config, peer, trusted, {}).message;
  a.encodeMessage(config, wrongRecipient, wrongRecipient, encode);
  const wrongNode = { tag: 'message', attrs: { id: 'WRONG-RECIPIENT', to: peer } };
  a.bindStanza(config, wrongNode, wrongRecipient, wrongNode.attrs.id);
  await assert.rejects(a.assertNode(config, a.snapshotFrame(config, wrongNode)), /unknown_protocol_denied/);

  const root = a.beginRelay(config, own, trusted, {}).message;
  a.encodeMessage(config, root, root, encode);
  const original = { tag: 'message', attrs: { id: 'INTERNAL', to: own }, content: [] };
  a.bindStanza(config, original, root, original.attrs.id);
  const fixed = a.snapshotFrame(config, original);
  await a.assertNode(config, fixed);
  original.attrs.to = peer;
  await assert.rejects(a.assertNode(config, a.snapshotFrame(config, original)), /unknown_protocol_denied/);
  config.auth.creds.signedIdentityKey.public = Buffer.alloc(32, 8);
  await assert.rejects(a.assertNode(config, fixed), /unknown_protocol_denied/);
  assert.throws(() => a.encodeMessage(config, root, root, encode), /encoding_context_conflict/);
  const replaced = a.beginRelay(config, own, trusted, {}).message;
  a.encodeMessage(config, replaced, replaced, encode);
  const newNode = { tag: 'message', attrs: { id: 'NEW-SESSION', to: own } };
  a.bindStanza(config, newNode, replaced, newNode.attrs.id);
  await assert.rejects(a.assertNode(config, a.snapshotFrame(config, newNode)), /unknown_protocol_denied/);
});

test('snapshot is never release authority; unknown/edit/raw/retry/session/socket and regression guards remain closed', async () => {
  const config = await socket(), other = await socket();
  for (const original of [edit(), { protocolMessage: { type: 999 } }]) {
    const root = a.beginRelay(config, peer, original, {}).message;
    a.encodeMessage(config, root, root, value => Buffer.from(JSON.stringify(value)));
    const node = { tag: 'message', attrs: { id: 'NEW', to: peer }, content: [] };
    a.bindStanza(config, node, root, 'NEW');
    await assert.rejects(a.assertNode(config, a.snapshotFrame(config, node)), /protocol_denied/);
  }
  const trusted = a.markInternalControl(config, control(), own);
  const root = a.beginRelay(other, own, trusted, {}).message;
  a.encodeMessage(other, root, root, value => Buffer.from(JSON.stringify(value)));
  const node = { tag: 'message', attrs: { id: 'CROSS-SOCKET', to: own } }; a.bindStanza(other, node, root, node.attrs.id);
  await assert.rejects(a.assertNode(other, a.snapshotFrame(other, node)), /unknown_protocol_denied/);
  assert.throws(() => a.externalRaw(config), /raw_send_denied/);
  assert.equal(await a.retryMessage(config, { id: 'CACHE' }, { conversation: 'cached' }), undefined);
  assert.throws(() => groups.denyOutbound(true, '120363000000000000@g.us'), /group/);
  assert.throws(() => financial.assertWireRecipient(peer, { attrs: { id: '3EB0F1A9C7D5E3B1AAAA' } }, creds(), {}, true), /native_retry_denied/);
  await assert.rejects(a.foundationCapability({ reservationId: randomUUID(), preparationDigest: 'a'.repeat(64) },
    () => a.assertNode(config, a.snapshotFrame(config, node))), /dispatch_disabled_wave1b/);
});
