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
  NexiManagedTransportContext: ['instanceId', 'sessionIdentity', 'fingerprint', 'payload'],
  NexiAttendancePreparation: ['executionId', 'attemptId', 'transportUnit', 'reservationId', 'externalId', 'authority',
    'intent', 'contentDigest', 'preparationDigest', 'preparationNonce', 'preparationRevision', 'admissionId',
    'releaseId', 'releaseConsumedAt', 'dispatchStartedAt', 'outcomeUnknown', 'successorId', 'recoveryAttempts', 'nextRecoveryAt'],
  NexiReceiptJournal: ['sourceKey', 'externalId', 'evidence', 'sessionIdentity'],
  NexiAttendanceEventOutbox: ['id', 'fingerprint', 'body', 'version', 'eventType', 'attempts', 'leaseToken', 'acknowledgedAt'],
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
    ['await nexiAttendance.retryMessage(config, { ...key, id }, msg);', 1]],
  'Socket/messages-send.js': [['nexiAttendance.bindStanza(config, stanza, message, msgId);', 2],
    ['nexiFinancial.assertWireRecipient(', 1], ['nexiGroups.denyOutbound(', 1]],
};
for (const [file, markers] of Object.entries(runtimeFiles)) {
  const text = fs.readFileSync(path.join(root, 'node_modules/baileys/lib', file), 'utf8');
  for (const [marker, expected] of markers) assert.equal(text.split(marker).length - 1, expected, `shipped ${file}: ${marker}`);
  if (file.includes('messages-recv')) {
    const start = text.indexOf('    const handleReceipt = async (node) => {');
    const capture = text.indexOf('await nexiAttendance.capture(', start);
    assert.ok(capture > start && capture < text.indexOf("ev.emit('messages.update'", start));
    assert.ok(text.includes('nexiFinancial.nativeFinancial(') && text.includes('nexiGroups.groupLike(key.remoteJid)'));
  }
  if (file.includes('socket.js')) {
    const start = text.indexOf('    const sendNode = async (frame) => {');
    assert.ok(start > 0 && text.indexOf('await nexiAttendance.assertNode(config, frame);', start) < text.indexOf('encodeBinaryNode(frame)', start));
  }
}
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/baileys/package.json'))).version, '7.0.0-rc13');
// Prisma adapters are bundled by tsup. Verify the shipped implementation,
// rather than inspecting the unrelated base image's node_modules copy.
assert.ok(bundle.includes('@prisma/adapter-mariadb') && bundle.includes('underlyingDriver()'), 'shipped dedicated pool boundary');
const attendance = createRequire(import.meta.url)(path.join(root, 'nexi-attendance.cjs'));
await assert.rejects(attendance.foundationCapability({ reservationId: 'foundation', preparationDigest: 'foundation' },
  () => attendance.assertNode({}, { tag: 'message', attrs: { id: 'foundation' } })), /dispatch_disabled_wave1b/);
await assert.rejects(attendance.assertNode({}, { tag: 'message', attrs: { id: attendance.ID_PREFIX + 'RECOVERED' } }), /dispatch_disabled_wave1b/);
assert.equal(attendance.normalization('unrecognized'), 'UNKNOWN');
console.log(`Attendance ${provider}: shipped models, receipt-before-buffer, all wire hooks and physical denial verified`);
