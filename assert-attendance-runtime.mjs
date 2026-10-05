import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = process.env.EVOLUTION_ATTENDANCE_ROOT || '/evolution';
const provider = process.env.EVOLUTION_SCHEMA_PROVIDER || process.env.EVOLUTION_PROVIDER || 'postgresql';
assert.ok(['postgresql', 'psql_bouncer', 'mysql'].includes(provider));
const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH || path.join(root, 'dist/main.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, `prisma/${provider}-schema.prisma`), 'utf8');
const assignment = '.runtimeDataModel=JSON.parse(';
assert.equal(bundle.split(assignment).length, 2, 'one shipped runtime model');
let cursor = bundle.indexOf(assignment) + assignment.length;
const first = cursor, quote = bundle[cursor++];
assert.ok(quote === '"' || quote === "'");
while (cursor < bundle.length) {
  if (bundle[cursor] === '\\') cursor += 2;
  else if (bundle[cursor] === quote) break;
  else cursor++;
}
assert.equal(bundle[cursor + 1], ')');
const models = JSON.parse(vm.runInNewContext(bundle.slice(first, cursor + 1), Object.create(null))).models;
const required = {
  NexiManagedTransportContext: ['canonicalVersion', 'instanceId', 'sessionIdentity', 'fingerprint', 'payload'],
  NexiAttendancePreparation: ['canonicalVersion', 'executionId', 'attemptId', 'transportUnit', 'reservationId', 'externalId', 'authority',
    'intent', 'contentDigest', 'preparationDigest', 'preparationNonce', 'preparationRevision', 'admissionId',
    'releaseId', 'releaseConsumedAt', 'dispatchStartedAt', 'outcomeUnknown', 'successorId', 'recoveryAttempts', 'nextRecoveryAt'],
  NexiReceiptJournal: ['canonicalVersion', 'sourceKey', 'externalId', 'evidence', 'sessionIdentity'],
  NexiAttendanceEventOutbox: ['canonicalVersion', 'id', 'fingerprint', 'body', 'version', 'eventType', 'attempts', 'leaseToken', 'acknowledgedAt'],
  NexiAttendanceHealth: ['instanceId', 'unhealthy', 'reason'],
};
for (const [name, fields] of Object.entries(required)) {
  assert.equal(schema.split(`model ${name} {`).length, 2, `one ${name} schema`);
  assert.ok(models[name], `actual compiled model ${name}`);
  for (const field of fields) assert.ok(models[name].fields.some(f => f.name === field), `${name}.${field}`);
  assert.ok(!models[name].fields.some(f => f.kind === 'object'), `${name} independent of Message/Instance cascading FK`);
}
for (const method of ['configure', 'installRoutes', 'legacyForInstance', 'settings', 'trackSocket', 'rawNodeForInstance', 'rawNodeForSocket', 'boundedMariaDb']) {
  const marker = `require("/evolution/nexi-attendance.cjs").${method}(`;
  assert.equal(bundle.split(marker).length - 1, method === 'legacyForInstance' ? 5 : 1, `actual compiled ${method} hooks`);
}
assert.ok(bundle.includes('attendanceReceiptRepository()'), 'compiled bounded driver factory');
const runtimeFiles = {
  'Socket/index.js': [['nexiAttendance.inheritConfig(config, newConfig);', 1]],
  'Socket/socket.js': [['await nexiAttendance.assertNode(config, frame);', 1], ['nexiAttendance.externalRaw(config);', 1],
    ['nexiAttendance.publicAttestation(', 2], ['nexiAttendance.sessionObserved(', 2]],
  'Socket/messages-recv.js': [['await nexiAttendance.capture(config, attrs, key, ids);', 1],
    ['await nexiAttendance.captureBadAck(config, attrs, key);', 1],
    ['await nexiAttendance.retryMessage(config, { ...key, id }, msg);', 1]],
  'Socket/messages-send.js': [['nexiAttendance.bindStanza(config, stanza, message, msgId);', 2],
    ['nexiAttendance.markInternalControl(config, protocolMessage, meJid);', 1],
    ['nexiFinancial.assertWireRecipient(', 1], ['nexiGroups.denyOutbound(', 1]],
};
for (const [file, markers] of Object.entries(runtimeFiles)) {
  const text = fs.readFileSync(path.join(root, 'node_modules/baileys/lib', file), 'utf8');
  for (const [marker, expected] of markers) assert.equal(text.split(marker).length - 1, expected, `shipped ${file}: ${marker}`);
  if (file.includes('messages-recv')) {
    const start = text.indexOf('    const handleReceipt = async (node) => {');
    const capture = text.indexOf('await nexiAttendance.capture(', start);
    assert.ok(capture > start && capture < text.indexOf("ev.emit('messages.update'", start));
    const badStart = text.indexOf('    const handleBadAck = async ({ attrs }) => {');
    const badCapture = text.indexOf('await nexiAttendance.captureBadAck(config, attrs, key);', badStart);
    assert.ok(badCapture > badStart && badCapture < text.indexOf('const isReachoutTimelocked', badStart));
    assert.ok(badCapture < text.indexOf("ev.emit('messages.update'", badStart));
    assert.ok(text.includes('nexiFinancial.nativeFinancial(') && text.includes('nexiGroups.groupLike(key.remoteJid)'));
  }
  if (file.includes('socket.js')) {
    const start = text.indexOf('    const sendNode = async (frame) => {');
    assert.ok(start > 0 && text.indexOf('await nexiAttendance.assertNode(config, frame);', start) < text.indexOf('encodeBinaryNode(frame)', start));
  }
  if (file.includes('messages-send')) {
    const mark = text.indexOf('nexiAttendance.markInternalControl(config, protocolMessage, meJid);');
    assert.ok(mark > 0 && mark < text.indexOf('const msgId = await relayMessage(meJid, protocolMessage, {', mark));
  }
}
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/baileys/package.json'))).version, '7.0.0-rc13');
const protocolEnums = fs.readFileSync(path.join(root, 'node_modules/baileys/WAProto/index.js'), 'utf8');
for (const anchor of ['values[valuesById[14] = "MESSAGE_EDIT"] = 14;',
  'values[valuesById[16] = "PEER_DATA_OPERATION_REQUEST_MESSAGE"] = 16;',
  'values[valuesById[4] = "PLACEHOLDER_MESSAGE_RESEND"] = 4;'])
  assert.equal(protocolEnums.split(anchor).length - 1, 1, 'exact shipped protocol classifier enum');
// Prisma adapters are bundled by tsup. Verify the shipped implementation,
// rather than inspecting the unrelated base image's node_modules copy.
assert.ok(bundle.includes('@prisma/adapter-mariadb') && bundle.includes('underlyingDriver()'), 'shipped dedicated pool boundary');
const attendance = createRequire(import.meta.url)(path.join(root, 'nexi-attendance.cjs'));
assert.equal(attendance.CANONICAL_VERSION, 'canonical_json_v1');
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/attendance-canonical-json-v1.json'), 'utf8'));
for (const fixture of corpus.fixtures.filter(row => row.result === 'accept')) {
  assert.equal(attendance.canonicalBytes(JSON.parse(fixture.input_json)), fixture.canonical_utf8);
  assert.equal(attendance.digest(JSON.parse(fixture.input_json)), fixture.sha256);
}
const credentials = { me: { id: '5511999999999@s.whatsapp.net' }, registrationId: 9,
  signedIdentityKey: { public: Buffer.alloc(32, 7) } };
const config = { auth: { creds: credentials } };
const session = createRequire(import.meta.url)(path.join(root, 'nexi-identity.cjs')).sessionFingerprint(credentials);
const context = { canonical_version: attendance.CANONICAL_VERSION, instance_id: 'artifact-instance', session_identity: session };
const repository = { webhook: { findUnique: async () => null }, attendanceReceiptRepository: () => ({}),
  nexiManagedTransportContext: { findFirst: async () => ({ instanceId: 'artifact-instance', sessionIdentity: session,
    canonicalVersion: attendance.CANONICAL_VERSION, fingerprint: attendance.digest(context), payload: context }) },
  nexiAttendancePreparation: { findFirst: async () => null }, nexiAttendanceHealth: { upsert: async () => ({}) } };
await attendance.configure({ prismaRepository: repository, instanceId: 'artifact-instance', instance: { name: 'artifact-managed' } }, config);
const editNode = { tag: 'message', attrs: { id: 'NEW-EDIT-ID', to: '5511888888888@s.whatsapp.net' } };
attendance.bindStanza(config, editNode, { protocolMessage: { type: 14, key: { id: 'ORIGINAL' },
  editedMessage: { conversation: 'artifact-only' }, timestampMs: 1720000000000 } }, 'NEW-EDIT-ID');
await assert.rejects(attendance.assertNode(config, editNode), /customer_protocol_denied/);
await assert.rejects(attendance.assertNode(config, { tag: 'message', attrs: { id: 'RAW-BYPASS' } }), /unknown_protocol_denied/);
await assert.rejects(attendance.foundationCapability({ reservationId: 'foundation', preparationDigest: 'foundation' },
  () => attendance.assertNode({}, { tag: 'message', attrs: { id: 'foundation' } })), /dispatch_disabled_wave1b/);
await assert.rejects(attendance.assertNode({}, { tag: 'message', attrs: { id: attendance.ID_PREFIX + 'RECOVERED' } }), /dispatch_disabled_wave1b/);
assert.equal(attendance.normalization('unrecognized'), 'UNKNOWN');
console.log(`Attendance ${provider}: shipped models, receipt-before-buffer, all wire hooks and physical denial verified`);
