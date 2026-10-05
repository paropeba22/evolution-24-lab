'use strict';
// Build-only assertions. Never run on Serra; EasyPanel owns validation.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const assertProtectedSendNode = require('./assert-protected-send-node.cjs');
let scratch;
const root = __dirname;
const files = ['src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
  'src/api/integrations/channel/whatsapp/voiceCalls/useVoiceCallsBaileys.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts',
  'src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts', 'src/api/routes/index.router.ts',
  'src/api/repository/repository.service.ts', 'tsup.config.ts',
  ...['index', 'socket', 'messages-send', 'messages-recv'].map(name => `node_modules/baileys/lib/Socket/${name}.js`),
  ...['mysql', 'postgresql', 'psql_bouncer'].map(provider => `prisma/${provider}-schema.prisma`)];

test('MariaDB scoped metadata loader executes check-node while preserving unrelated JSON/YML assets', async () => {
  const esbuild = require('esbuild');
  const { patchAttendanceTsupConfig } = await import(pathToFileURL(path.join(root, 'patch-attendance-source.mjs')));
  const { assertMariaDbMetadata } = await import(pathToFileURL(path.join(root, 'assert-attendance-runtime.mjs')));
  // Standalone fixture contains the pinned tsup anchors; image builds use the actual snapshot.
  const upstream = fs.existsSync(path.join(root, '.attendance-upstream/tsup.config.ts'))
    ? fs.readFileSync(path.join(root, '.attendance-upstream/tsup.config.ts'), 'utf8')
    : `import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';
export default defineConfig({
  external: ['/evolution/nexi-groups.cjs', 'baileys',],
  noExternal: [/^@prisma\\/client$/],
  loader: { '.json': 'file', '.yml': 'file' },
});`;
  const source = patchAttendanceTsupConfig(upstream), configModule = { exports: {} };
  // esbuild validates RegExp with instanceof, so load the config in this realm.
  vm.runInThisContext(`(function(require,module,exports,process,__dirname) {
    ${esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code}
  })`)(require, configModule, configModule.exports, process, root);
  const config = configModule.exports.default;
  assert.equal(config.loader['.json'], 'file'); assert.equal(config.loader['.yml'], 'file');
  for (const name of ['@prisma/client', '@prisma/adapter-mariadb', 'mariadb'])
    assert.ok(config.noExternal.some(pattern => pattern.test(name)), `${name} stays bundled`);
  const plugin = config.esbuildPlugins.find(item => item.name === 'nexi-mariadb-runtime-metadata');
  let registration;
  plugin.setup({ onLoad: (options, load) => { registration = { ...options, load }; } });
  assert.equal(registration.namespace, 'file');
  for (const name of ['/evolution/node_modules/mariadb/package.json',
    'C:\\evolution\\node_modules\\mariadb\\package.json', '/evolution/node_modules/x/node_modules/mariadb/package.json'])
    assert.ok(registration.filter.test(name), name);
  for (const name of ['/evolution/assets/package.json', '/evolution/node_modules/other/package.json',
    '/evolution/node_modules/mariadb/lib/package.json', '/evolution/node_modules/mariadb/package.json.backup'])
    assert.ok(!registration.filter.test(name), name);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-mariadb-loader-'));
  try {
    const driver = path.join(fixture, 'node_modules/mariadb'); fs.mkdirSync(driver, { recursive: true });
    const metadata = { name: 'mariadb', engines: { node: '>= 14' }, description: 'boundary }) inside JSON' };
    fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify(metadata));
    // Exact module-scope access and subsequent initialization from pinned check-node.js.
    fs.writeFileSync(path.join(driver, 'check-node.js'), `const requirement = require('./package.json').engines.node;
const connectorRequirement = requirement.replace('>=', '').trim();
module.exports = { connectorRequirement };`);
    fs.writeFileSync(path.join(fixture, 'asset.json'), '{"asset":true}');
    fs.writeFileSync(path.join(fixture, 'asset.yml'), 'asset: true');
    fs.mkdirSync(path.join(fixture, 'node_modules/other'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'node_modules/other/package.json'), '{"name":"other"}');
    const entry = `module.exports = { check: require('./node_modules/mariadb/check-node.js'),
      asset: require('./asset.json'), yaml: require('./asset.yml'), other: require('./node_modules/other/package.json') };`;
    for (const minify of [false, true]) {
      const options = { stdin: { contents: entry, resolveDir: fixture }, bundle: true, platform: 'node',
        format: 'cjs', minify, loader: config.loader, write: false, outfile: path.join(fixture, 'dist/main.js') };
      const broken = await esbuild.build(options);
      const brokenCode = broken.outputFiles.find(file => file.path.endsWith('.js')).text;
      const execute = code => {
        const module = { exports: {} };
        vm.runInNewContext(code, { module, exports: module.exports }, { timeout: 1000 });
        return module.exports;
      };
      assert.throws(() => execute(brokenCode), /Cannot read properties of undefined.*node/);
      if (minify) assert.throws(() => assertMariaDbMetadata(brokenCode), /Cannot read properties of undefined.*node/);
      const fixed = await esbuild.build({ ...options, plugins: config.esbuildPlugins });
      const fixedCode = fixed.outputFiles.find(file => file.path.endsWith('.js')).text, result = execute(fixedCode);
      assert.equal(result.check.connectorRequirement, '14');
      for (const key of ['asset', 'yaml', 'other']) assert.equal(typeof result[key], 'string', `${key} remains a file path`);
      assert.equal(fixed.outputFiles.filter(file => file.path.endsWith('.json')).length, 2, 'only unrelated JSON assets emitted');
      if (minify) {
        assert.equal(assertMariaDbMetadata(fixedCode), metadata.engines.node);
        // A server/external side effect must never run during the artifact probe.
        assert.equal(assertMariaDbMetadata(fixedCode + '\nthrow new Error("server must not run");'), metadata.engines.node);
        assert.throws(() => assertMariaDbMetadata(fixedCode.replace('name:"mariadb"', 'name:"other"')), /shipped MariaDB package/);
      }
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('MariaDB tsup loader anchors reject drift rather than widening JSON semantics', async () => {
  const { patchAttendanceTsupConfig } = await import(pathToFileURL(path.join(root, 'patch-attendance-source.mjs')));
  assert.throws(() => patchAttendanceTsupConfig("import { cpSync, readFileSync } from 'node:fs';"), /expected 1, found 0/);
  assert.throws(() => patchAttendanceTsupConfig("import { cpSync } from 'node:fs';\nimport { cpSync } from 'node:fs';"), /expected 1, found 2/);
});

describe('installed Attendance source and artifacts', () => {
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-attendance-source-'));
  for (const file of files) {
    const target = path.join(scratch, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, '.attendance-upstream', file), target);
  }
  for (const file of ['package-lock.json', 'node_modules/baileys/package.json', 'attendance-models.prisma',
    'node_modules/baileys/WAProto/index.js',
    'node_modules/@prisma/adapter-mariadb/package.json', 'node_modules/@prisma/adapter-mariadb/dist/index.js']) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(scratch, file));
  }
});
test('bad ACK anchor rejects zero/multiple matches without partial writes and precedes all secondary/error emission', () => {
  // Restore pristine snapshots independently of test case order.
  for (const sourceFile of files) fs.copyFileSync(path.join(root, '.attendance-upstream', sourceFile), path.join(scratch, sourceFile));
  const recv = path.join(scratch, 'node_modules/baileys/lib/Socket/messages-recv.js'), accepted = fs.readFileSync(recv, 'utf8');
  const anchor = '        if (attrs.error) {\n            const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked);';
  assert.equal(accepted.split(anchor).length - 1, 1);
  for (const broken of [accepted.replace(anchor, '/* removed bad ACK */'), accepted + '\n' + anchor]) {
    fs.writeFileSync(recv, broken);
    const before = files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8'));
    const result = spawnSync(process.execPath, [path.join(root, 'patch-attendance-source.mjs'), scratch], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /expected 1, found [02]/);
    assert.deepEqual(files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8')), before);
  }
  fs.writeFileSync(recv, accepted);
  const shipped = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Socket/messages-recv.js'), 'utf8');
  const start = shipped.indexOf('    const handleBadAck = async ({ attrs }) => {');
  const capture = shipped.indexOf('await nexiAttendance.captureBadAck(config, attrs, key);', start);
  assert.ok(capture > start && capture < shipped.indexOf('const isReachoutTimelocked', start));
  assert.ok(capture < shipped.indexOf("ev.emit('messages.update'", start));
  assert.ok(shipped.includes("ws.on('CB:ack,class:message'"));
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

test('semantic snapshot, encoder and final-frame anchors fail closed without partial patches', () => {
  const anchors = [
    ['node_modules/baileys/lib/Socket/messages-send.js', '    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {'],
    ['node_modules/baileys/lib/Socket/messages-send.js', '                const bytes = encodeWAMessage(msgToEncrypt);'],
    ['node_modules/baileys/lib/Socket/socket.js', '        const buff = encodeBinaryNode(frame);'],
  ];
  for (const [file, anchor] of anchors) {
    for (const sourceFile of files) fs.copyFileSync(path.join(root, '.attendance-upstream', sourceFile), path.join(scratch, sourceFile));
    const target = path.join(scratch, file), accepted = fs.readFileSync(target, 'utf8');
    assert.equal(accepted.split(anchor).length - 1, 1);
    for (const broken of [accepted.replace(anchor, '/* removed snapshot boundary */'), accepted + '\n' + anchor]) {
      fs.writeFileSync(target, broken);
      const before = files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8'));
      const result = spawnSync(process.execPath, [path.join(root, 'patch-attendance-source.mjs'), scratch], { encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /expected 1, found [02]/);
      assert.deepEqual(files.map(f => fs.readFileSync(path.join(scratch, f), 'utf8')), before);
    }
  }
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
  assertProtectedSendNode(socket);
  assert.match(socket, /sendRawMessage: data => \{\s+nexiAttendance.externalRaw\(config\)/);
  assert.match(socket, /const sendRawMessage = async/);
});
test('protected sendNode artifact proof is scoped to its lexical region and preserves snapshot ordering', () => {
  const valid = `    const sendNode = async (frame) => {
        const nexiFrame = nexiAttendance.snapshotFrame(config, frame);
        await nexiAttendance.assertNode(config, nexiFrame);
        if (logger.level === 'trace') {
            logger.trace({ xml: binaryNodeToString(nexiFrame), msg: 'xml send' });
        }
        const buff = encodeBinaryNode(nexiFrame);
        return sendRawMessage(buff);
    };
    /**
     * Wait for a message with a certain tag`;
  assert.doesNotThrow(() => assertProtectedSendNode(valid));
  assert.throws(() => assertProtectedSendNode(valid.replace(
    'encodeBinaryNode(nexiFrame)', 'encodeBinaryNode(frame)')));
  assert.throws(() => assertProtectedSendNode(valid.replace(
    'binaryNodeToString(nexiFrame)', 'binaryNodeToString(frame)')));
  assert.doesNotThrow(() => assertProtectedSendNode(valid + '\nencodeBinaryNode(frame);'));
  const outOfOrder = valid.replace(
    'await nexiAttendance.assertNode(config, nexiFrame);',
    'const buff = encodeBinaryNode(nexiFrame);\n        await nexiAttendance.assertNode(config, nexiFrame);')
    .replace('        const buff = encodeBinaryNode(nexiFrame);\n        return sendRawMessage(buff);',
      '        return sendRawMessage(buff);');
  assert.throws(() => assertProtectedSendNode(outOfOrder));
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
});
