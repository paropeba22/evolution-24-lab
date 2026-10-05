'use strict';
// Build-only assertions. Never run on Serra; EasyPanel owns validation.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
let scratch;
const root = __dirname;
const files = ['src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
  'src/api/integrations/channel/whatsapp/voiceCalls/useVoiceCallsBaileys.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts',
  'src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts', 'src/api/routes/index.router.ts',
  'src/api/repository/repository.service.ts', 'tsup.config.ts',
  ...['index', 'socket', 'messages-send', 'messages-recv'].map(name => `node_modules/baileys/lib/Socket/${name}.js`),
  ...['mysql', 'postgresql', 'psql_bouncer'].map(provider => `prisma/${provider}-schema.prisma`)];
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-attendance-source-'));
  for (const file of files) {
    const target = path.join(scratch, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, '.attendance-upstream', file), target);
  }
  for (const file of ['package-lock.json', 'node_modules/baileys/package.json', 'attendance-models.prisma',
    'node_modules/@prisma/adapter-mariadb/package.json', 'node_modules/@prisma/adapter-mariadb/dist/index.js']) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
test('each pinned anchor rejects zero/multiple matches before modifying any source', () => {
  const file = path.join(scratch, files[0]), accepted = fs.readFileSync(file, 'utf8');
  const anchor = "  public async baileysSendNode(stanza: any) {\n    console.log('stanza', JSON.stringify(stanza));";
  assert.equal(accepted.split(anchor).length - 1, 1);
  for (const broken of [accepted.replace(anchor, '/* removed */'), accepted + '\n' + anchor]) {
    fs.writeFileSync(file, broken);
    const before = files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8'));
    const result = spawnSync(process.execPath, [path.join(root, 'patch-attendance-source.mjs'), scratch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /expected 1, found [02]/);
    assert.deepEqual(files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8')), before);
  }
  fs.writeFileSync(file, accepted);
  execFileSync(process.execPath, [path.join(root, 'patch-attendance-source.mjs'), scratch]);
});
test('actual patched source captures raw semantics before buffer, final ID before sendNode, and native retry before resend', () => {
  const recv = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Socket/messages-recv.js'), 'utf8');
  const start = recv.indexOf('    const handleReceipt = async (node) => {');
  assert.ok(recv.indexOf('await nexiAttendance.capture(config, attrs, key, ids);', start) < recv.indexOf("ev.emit('messages.update'", start));
  const push = recv.indexOf('            msgs.push(msg);');
  assert.ok(recv.lastIndexOf('await nexiAttendance.retryMessage(', push) > recv.indexOf('const sendMessagesAgain'));
  const send = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Socket/messages-send.js'), 'utf8');
  assert.equal(send.split('nexiAttendance.bindStanza(config, stanza, message, msgId);').length - 1, 2);
  const final = send.indexOf('nexiFinancial.assertWireRecipient(');
  assert.ok(send.lastIndexOf('nexiAttendance.bindStanza(', final) > send.lastIndexOf('const stanza = {', final));
  assert.ok(final < send.indexOf('await sendNode(stanza)', final));
  assert.equal(send.split('nexiGroups.denyOutbound(').length - 1, 1);
});
test('API, WebSocket service and voice structured nodes cannot bypass raw provenance; raw handshake remains lexical', () => {
  const service = fs.readFileSync(path.join(root, files[0]), 'utf8');
  assert.match(service, /rawNodeForInstance\(this\.prismaRepository, \{ instanceName: this\.instance\.name \}, stanza\)/);
  const voice = fs.readFileSync(path.join(root, files[1]), 'utf8');
  assert.match(voice, /rawNodeForSocket\(baileys_sock, stanza\)/);
  const socket = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Socket/socket.js'), 'utf8');
  const sendNode = socket.indexOf('    const sendNode = async (frame) => {');
  assert.ok(socket.indexOf('await nexiAttendance.assertNode(config, frame)', sendNode) < socket.indexOf('encodeBinaryNode(frame)', sendNode));
  assert.match(socket, /sendRawMessage: data => \{\s+nexiAttendance.externalRaw\(config\)/);
  assert.match(socket, /const sendRawMessage = async/);
});
test('actual Chatwoot unsafe SQL/import and conversation READ have managed capability hooks', () => {
  const service = fs.readFileSync(path.join(root, files[2]), 'utf8'), helper = fs.readFileSync(path.join(root, files[3]), 'utf8');
  assert.match(service, /'conversation_read', body\?\.key\?\.id/);
  assert.match(helper, /'import_database_source_id', sourceId/);
  assert.match(helper, /'import_database', \(message.key as any\)\?\.id/);
  const guard = helper.indexOf("'import_database_source_id', sourceId");
  assert.ok(guard >= 0 && guard < helper.indexOf('UPDATE messages', guard));
});
test('PostgreSQL/MySQL/psql_bouncer schemas preserve transport provider parity, no Message FK and permanent correlation', () => {
  const names = ['NexiManagedTransportContext', 'NexiAttendancePreparation', 'NexiReceiptJournal', 'NexiAttendanceEventOutbox', 'NexiAttendanceHealth'];
  for (const provider of ['postgresql', 'mysql', 'psql_bouncer']) {
    const schema = fs.readFileSync(path.join(root, `prisma/${provider}-schema.prisma`), 'utf8');
    for (const name of names) {
      assert.equal(schema.split(`model ${name} {`).length - 1, 1);
      const model = schema.split(`model ${name} {`)[1].split('}')[0];
      assert.doesNotMatch(model, /@relation|Message\[\]|Instance\[\]/);
    }
  }
  for (const provider of ['postgresql', 'mysql']) {
    const sql = fs.readFileSync(path.join(root, `prisma/${provider}-migrations/20261005000000_nexi_attendance_boundaries/migration.sql`), 'utf8');
    assert.match(sql, /NexiAttendancePreparation_no_dispatch/); assert.match(sql, /dispatchStartedAt.*IS NULL/);
    assert.match(sql, /successorId/); assert.match(sql, /nexi_attendance_preparation_no_reset/);
    assert.doesNotMatch(sql, /REFERENCES.*Message|DELETE FROM|DROP TABLE/);
    for (const name of names) assert.match(sql, new RegExp(`CREATE TABLE ["\x60]${name}["\x60]`));
  }
});
test('actual installed compiled bundles are asserted per provider and final runtime image', () => {
  execFileSync(process.execPath, [path.join(root, 'assert-attendance-runtime.mjs')], { env: process.env });
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.ok(docker.indexOf('patch-attendance-source.mjs /evolution --snapshot') > docker.indexOf('patch-groups-source.mjs /evolution --snapshot'));
  assert.ok(docker.indexOf('patch-attendance-source.mjs /evolution --snapshot') < docker.indexOf('npm run db:generate'));
  assert.match(docker, /COPY --from=source-builder \/evolution\/nexi-attendance.cjs/);
  assert.ok(docker.split('node /tmp/assert-attendance-runtime.mjs').length >= 3);
});
