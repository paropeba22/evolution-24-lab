'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createHmac, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const groups = require('./nexi-groups.cjs');
const identity = require('./nexi-identity.cjs');
const transport = require('./nexi-transport.cjs');
const financial = require('./nexi-financial-transport.cjs');
const revision = 'e273b904d53f5726970fd6a244ed9caa61dfeb9a';
const upstream = process.env.EVOLUTION_UPSTREAM_SOURCE || path.join(__dirname, '../evolution-upstream');
const baileysFile = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
const recvFile = 'node_modules/baileys/lib/Socket/messages-recv.js';
const sendFile = 'node_modules/baileys/lib/Socket/messages-send.js';
const sourceFiles = [baileysFile, 'src/api/integrations/event/event.manager.ts', 'src/api/routes/index.router.ts',
  'src/api/controllers/instance.controller.ts',
  'src/api/services/monitor.service.ts',
  'src/api/services/channel.service.ts',
  'src/api/abstract/abstract.router.ts', 'node_modules/baileys/lib/Socket/chats.js', 'node_modules/baileys/lib/Socket/socket.js',
  'src/api/integrations/chatbot/chatbot.controller.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', recvFile, sendFile, 'tsup.config.ts',
  ...['session_record.js', 'session_cipher.js', 'session_builder.js', 'queue_job.js', 'curve.js']
    .map(file => `node_modules/libsignal/src/${file}`),
  ...['postgresql', 'psql_bouncer', 'mysql'].map(provider => `prisma/${provider}-schema.prisma`)];
const master = 'synthetic-groups-secret-at-least-32-bytes';
const jid = '120363000000000001@g.us', otherJid = '120363000000000002@g.us';
const sender = '5511999999999@s.whatsapp.net', lid = '100000000000001@lid';
const creds = { me: { id: '5500000000000:1@s.whatsapp.net', lid: '200000000000001@lid' },
  registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
const session = identity.sessionFingerprint(creds);
let scratch, sources, ts, acceptedSources, acceptedGroups, deltaSources, deltaGroups, lifecycleSources, lifecycleGroups, residualSources, residualGroups, profileSources, profileGroups;

before(() => {
  ts = require(require.resolve('typescript', { paths: [__dirname, upstream] }));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-groups-wave1-'));
  const hasSnapshot = fs.existsSync(path.join(__dirname, '.groups-upstream'));
  const files = new Set(sourceFiles);
  if (!hasSnapshot) {
    for (const file of ['src/validate/message.schema.ts', 'src/api/integrations/event/webhook/webhook.controller.ts',
      'node_modules/baileys/lib/Utils/event-buffer.js']) files.add(file);
  }
  for (const file of files) {
    const target = path.join(scratch, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let source;
    if (hasSnapshot) source = fs.readFileSync(path.join(__dirname, '.groups-upstream', file));
    else if (file.startsWith('node_modules/')) source = fs.readFileSync(path.join(upstream, file));
    else source = execFileSync('git', ['show', `${revision}:${file}`], { cwd: upstream, encoding: 'utf8' });
    fs.writeFileSync(target, source);
  }
  if (!hasSnapshot) {
    execFileSync(process.execPath, [path.join(__dirname, 'patch-prisma-binding.mjs')],
      { env: { ...process.env, EVOLUTION_PRISMA_DIR: path.join(scratch, 'prisma') } });
    for (const patch of ['patch-financial-delivery-source.mjs', 'patch-trusted-baileys.mjs', 'patch-managed-retry.mjs']) {
      execFileSync(process.execPath, [path.join(__dirname, patch), scratch]);
    }
  }
  // Reproduce findings against immutable accepted history when locally present.
  const available = require('node:child_process').spawnSync('git', ['cat-file', '-e', 'c04855465d9e93596f248a73e4e9f8a731053f84'],
    { cwd: __dirname, stdio: 'ignore' }).status === 0;
  if (available) {
    const acceptedRoot = path.join(scratch, 'accepted');
    for (const file of sourceFiles) {
      const target = path.join(acceptedRoot, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scratch, file), target);
    }
    const script = path.join(scratch, 'accepted-patch.mjs');
    fs.writeFileSync(script, execFileSync('git', ['show', 'c04855465d9e93596f248a73e4e9f8a731053f84:patch-groups-source.mjs'], { cwd: __dirname }));
    execFileSync(process.execPath, [script, acceptedRoot]);
    acceptedSources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(acceptedRoot, file), 'utf8')]));
    const Module = require('node:module'), isolated = new Module(path.join(__dirname, 'accepted-groups.cjs'), module);
    isolated.filename = path.join(__dirname, 'accepted-groups.cjs'); isolated.paths = module.paths;
    isolated._compile(execFileSync('git', ['show', 'c04855465d9e93596f248a73e4e9f8a731053f84:nexi-groups.cjs'],
      { cwd: __dirname, encoding: 'utf8' }), isolated.filename);
    acceptedGroups = isolated.exports;
    const deltaRoot = path.join(scratch, 'delta');
    for (const file of sourceFiles) {
      const target = path.join(deltaRoot, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scratch, file), target);
    }
    fs.writeFileSync(script, execFileSync('git', ['show', '7e7bc04ac397bc92f1cd0ed32833474e16b58410:patch-groups-source.mjs'], { cwd: __dirname }));
    execFileSync(process.execPath, [script, deltaRoot]);
    deltaSources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(deltaRoot, file), 'utf8')]));
    const prior = new Module(path.join(__dirname, 'delta-groups.cjs'), module);
    prior.filename = path.join(__dirname, 'delta-groups.cjs'); prior.paths = module.paths;
    prior._compile(execFileSync('git', ['show', '7e7bc04ac397bc92f1cd0ed32833474e16b58410:nexi-groups.cjs'],
      { cwd: __dirname, encoding: 'utf8' }), prior.filename);
    deltaGroups = prior.exports;
  }
  if (available) {
    const lifecycleRoot = path.join(scratch, 'lifecycle-reviewed');
    for (const file of sourceFiles) {
      const target = path.join(lifecycleRoot, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scratch, file), target);
    }
    const script = path.join(scratch, 'lifecycle-reviewed-patch.mjs');
    fs.writeFileSync(script, execFileSync('git', ['show', 'a9fb4cbf9e3d0c84ef77b7e8ea728efdc37d1b3a:patch-groups-source.mjs'], { cwd: __dirname }));
    execFileSync(process.execPath, [script, lifecycleRoot]);
    lifecycleSources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(lifecycleRoot, file), 'utf8')]));
    const Module = require('node:module'), reviewed = new Module(path.join(__dirname, 'reviewed-lifecycle.cjs'), module);
    reviewed.filename = path.join(__dirname, 'reviewed-lifecycle.cjs'); reviewed.paths = module.paths;
    reviewed._compile(execFileSync('git', ['show', 'a9fb4cbf9e3d0c84ef77b7e8ea728efdc37d1b3a:nexi-groups.cjs'],
      { cwd: __dirname, encoding: 'utf8' }), reviewed.filename);
    lifecycleGroups = reviewed.exports;
  }
  if (available) {
    const residualRoot = path.join(scratch, 'residual-reviewed');
    for (const file of sourceFiles) {
      const target = path.join(residualRoot, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scratch, file), target);
    }
    const script = path.join(scratch, 'residual-reviewed-patch.mjs');
    fs.writeFileSync(script, execFileSync('git', ['show', '99ab770105fa6de3608a7dedf959ff845eb67048:patch-groups-source.mjs'], { cwd: __dirname }));
    execFileSync(process.execPath, [script, residualRoot]);
    residualSources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(residualRoot, file), 'utf8')]));
    const Module = require('node:module'), reviewed = new Module(path.join(__dirname, 'reviewed-residual.cjs'), module);
    reviewed.filename = path.join(__dirname, 'reviewed-residual.cjs'); reviewed.paths = module.paths;
    reviewed._compile(execFileSync('git', ['show', '99ab770105fa6de3608a7dedf959ff845eb67048:nexi-groups.cjs'],
      { cwd: __dirname, encoding: 'utf8' }), reviewed.filename);
    residualGroups = reviewed.exports;
  }
  if (available) {
    const profileRoot = path.join(scratch, 'profile-reviewed');
    for (const file of sourceFiles) {
      const target = path.join(profileRoot, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scratch, file), target);
    }
    const script = path.join(scratch, 'profile-reviewed-patch.mjs');
    fs.writeFileSync(script, execFileSync('git', ['show', '17896c187c891bb437df353840561f17010d7ce4:patch-groups-source.mjs'], { cwd: __dirname }));
    execFileSync(process.execPath, [script, profileRoot]);
    profileSources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(profileRoot, file), 'utf8')]));
    const Module = require('node:module'), reviewed = new Module(path.join(__dirname, 'reviewed-profile.cjs'), module);
    reviewed.filename = path.join(__dirname, 'reviewed-profile.cjs'); reviewed.paths = module.paths;
    reviewed._compile(execFileSync('git', ['show', '17896c187c891bb437df353840561f17010d7ce4:nexi-groups.cjs'],
      { cwd: __dirname, encoding: 'utf8' }), reviewed.filename);
    profileGroups = reviewed.exports;
  }
  execFileSync(process.execPath, [path.join(__dirname, 'patch-groups-source.mjs'), scratch, '--snapshot']);
  sources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(scratch, file), 'utf8')]));
});
after(() => {
  assert.equal(path.dirname(scratch), os.tmpdir());
  assert.ok(path.basename(scratch).startsWith('nexi-groups-wave1-'));
  fs.rmSync(scratch, { recursive: true, force: true });
});

// Real transformed native methods retain their awaits; only I/O is synthetic.
function lifecycleMethod(code, start, end) {
  const a = code.indexOf(start), b = code.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return code.slice(a, b);
}
function nativeLifecycle(helper, code, extra = {}) {
  const provider = code[baileysFile], methods = [
    lifecycleMethod(provider, '  private async connectionUpdate(', '  private async getMessage('),
    lifecycleMethod(provider, '  public async connectToWhatsapp(', '  public async reloadConnection('),
    lifecycleMethod(provider, '  public async reloadConnection(', '  private readonly chatHandle'),
    lifecycleMethod(provider, '  public async logoutInstance()', '  public async getProfileName()'),
    lifecycleMethod(provider, '  public async updatePrivacySettings(', '  public async fetchBusinessProfile('),
    lifecycleMethod(provider, '  public async updateProfilePicture(', '  public async blockUser(')
  ].join('\n');
  const dependencies = { require: () => helper, Events: new Proxy({}, { get: (_t, key) => key }),
    DisconnectReason: { loggedOut: 401, forbidden: 403, badSession: 500, connectionClosed: 428 },
    BaileysStartupService: { STREAM_515_RECONNECT_GRACE_MS: 30000 },
    InternalServerErrorException: class extends Error {}, BadRequestException: class extends Error {}, delay: async () => {},
    isURL: value => String(value).startsWith('https://'), isBase64: () => true,
    axios: { get: async () => ({ data: Buffer.from('synthetic-picture') }) },
    qrcode: { toDataURL: (_qr, _opts, callback) => callback(null, 'synthetic-base64') },
    qrcodeTerminal: { generate() {} }, ...extra };
  return new (new Function(...Object.keys(dependencies), ts.transpileModule(
    'class Native { ' + methods + ' }; return Native;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
  (...Object.values(dependencies)))();
}
function nativeMonitor(helper, code, subject, extra = {}) {
  const monitor = code['src/api/services/monitor.service.ts'];
  const methods = [
    lifecycleMethod(monitor, '  private async setInstance(', '  private async loadInstancesFromRedis'),
    lifecycleMethod(monitor, '  public delInstanceTime(', '  public async instanceInfo('),
    lifecycleMethod(monitor, '  public async instanceInfo(', '  public async instanceInfoById('),
    monitor.slice(monitor.indexOf('  private removeInstance()'), monitor.lastIndexOf('\n}')),
    lifecycleMethod(monitor, '  public async cleaningUp(', '  public async loadInstance()')
  ].join('\n');
  const dependencies = { require: () => helper, channelController: { init: () => subject },
    Integration: { WHATSAPP_BAILEYS: 'baileys', EVOLUTION: 'evo', EVOHUB: 'hub' },
    Events: new Proxy({}, { get: (_t, key) => key }), rmSync() {}, join: path.join,
    INSTANCE_DIR: 'synthetic', STORE_DIR: 'synthetic', execFileSync() {}, ...extra };
  const m = new (new Function(...Object.keys(dependencies), ts.transpileModule(
    'class NativeMonitor { ' + methods + ' }; return NativeMonitor;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
  (...Object.values(dependencies)))();
  Object.assign(m, { waInstances: {}, delInstanceTimeouts: {}, logger: subject.logger,
    configService: subject.configService, prismaRepository: subject.prismaRepository, eventEmitter: subject.eventEmitter,
    db: { SAVE_DATA: { INSTANCE: true } }, redis: { REDIS: { ENABLED: false } } });
  return m;
}
async function lifecycleFixture(helper, code, { managed = true, extra = {} } = {}) {
  const subject = nativeLifecycle(helper, code, extra);
  Object.assign(subject, service());
  subject.client = undefined;
  if (!managed) subject.instance.name = 'ordinary-direct-instance';
  const row = { id: subject.instanceId, name: subject.instance.name, nexiGroupsSocketOwner: null,
    connectionStatus: 'open', disconnectionObject: null };
  const effects = [], sockets = [], configs = [], gate = { write: null, registration: null };
  const update = async args => {
    if (args.data.connectionStatus && gate.write) await gate.write(args);
    const registration = args.data.nexiGroupsSocketOwner && gate.registration;
    if (registration === 'before') throw new Error('synthetic registration unavailable');
    if (Object.entries(args.where).some(([key, value]) => row[key] !== (value?.equals ?? value))) return { count: 0 };
    Object.assign(row, args.data);
    if (registration === 'uncertain') { gate.registration = null; throw new Error('synthetic response lost'); }
    return { count: 1 };
  };
  subject.prismaRepository.instance = {
    findUnique: async () => structuredClone(row), findFirst: async () => structuredClone(row),
    updateMany: update,
    update: async args => { await update({ ...args, where: { id: row.id } }); return structuredClone(row); },
    delete: async () => { effects.push('instance.delete'); return row; }
  };
  subject.prismaRepository.session = { findFirst: async () => null, deleteMany: async () => effects.push('session.delete') };
  subject.instance.wuid = sender; subject.instance.qrcode = { count: 0 };
  subject.stateConnection = { state: 'open' }; subject._lastStream515At = 0;
  subject.logger = Object.fromEntries(['warn', 'error', 'info', 'debug', 'log'].map(level => [level, () => {}]));
  subject.configService = { get: key => ({ CHATWOOT: { ENABLED: true }, QRCODE: { LIMIT: 3, COLOR: '#000000' },
    DATABASE: { SAVE_DATA: { INSTANCE: false } }, CACHE: { REDIS: { ENABLED: false } }, PROVIDER: {} }[key]) };
  subject.localChatwoot = { enabled: true };
  subject.chatwootService = { eventWhatsapp: (...args) => effects.push(['chatwoot', ...args]) };
  subject.syncChatwootLostMessages = () => effects.push('chatwoot.sync');
  subject.profilePicture = async () => ({ profilePictureUrl: 'synthetic-profile' });
  subject.getProfileName = async () => 'Synthetic';
  subject.sendDataWebhook = (...args) => effects.push(['webhook', ...args]);
  subject.eventEmitter = { emit: (...args) => effects.push(['event', ...args]), on() {} };
  subject.setInstance = () => {};
  subject.integration = 'baileys';
  for (const name of ['loadChatwoot', 'loadSettings', 'loadWebhook', 'loadProxy']) subject[name] = () => {};
  subject.messageProcessor = { mount() {}, onDestroy() {} };
  subject.messageHandle = { 'messages.upsert'() {} };
  const install = async label => {
    const config = { auth: { creds }, logger: subject.logger }; configs.push(config);
    const socket = await helper.installAdmissionSocket(subject, config, () => {
      const next = { label, user: { id: sender, name: 'Synthetic' },
        ws: { isOpen: true, close() { next.ws.isOpen = false; effects.push(label + '.ws'); } },
        end() { next.ws.isOpen = false; effects.push(label + '.end'); },
        logout: async () => {}, requestPairingCode: async () => 'synthetic-pair',
        sendMessage: (destination, body) => { effects.push(['send', destination, body]); return 'sent'; } };
      sockets.push(next); return next;
    }, helper.connectOwner ? helper.connectOwner(subject) : undefined);
    subject.client = socket; return socket;
  };
  subject.createClient = async () => {
    if (!await helper.beforeConnect(subject)) return subject.client;
    subject.endSession = false;
    return install('S' + sockets.length);
  };
  return { subject, row, effects, sockets, configs, gate, install };
}
function pause() {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { waiting, release, enter: async () => { entered(); await blocked; } };
}

const privacyMethods = ['updateReadReceiptsPrivacy', 'updateProfilePicturePrivacy', 'updateStatusPrivacy',
  'updateOnlinePrivacy', 'updateLastSeenPrivacy', 'updateGroupsAddPrivacy'];
const profileOperations = ['updatePrivacySettings', 'updateProfilePicture', 'removeProfilePicture'];
async function profileFixture(helper, code, options = {}) {
  const f = await lifecycleFixture(helper, code, options), reloads = [], mutations = [];
  const install = f.install;
  f.install = async label => {
    const socket = await install(label);
    for (const method of [...privacyMethods, 'updateProfilePicture', 'removeProfilePicture']) {
      socket[method] = async (...args) => { mutations.push({ label, method, args }); };
    }
    return socket;
  };
  f.subject.createClient = async () => {
    if (!await helper.beforeConnect(f.subject)) return f.subject.client;
    f.subject.endSession = false;
    return f.install('S' + f.sockets.length);
  };
  const reload = f.subject.reloadConnection.bind(f.subject);
  f.subject.reloadConnection = (...args) => {
    const task = reload(...args); reloads.push({ args, task }); task.catch(() => {}); return task;
  };
  await f.install('A');
  const invoke = operation => f.subject[operation](operation === 'updatePrivacySettings'
    ? { readreceipts: 'all', profile: 'all', status: 'all', online: 'all', last: 'all', groupadd: 'all' }
    : operation === 'updateProfilePicture' ? 'c3ludGhldGljLXBpY3R1cmU=' : undefined);
  return { ...f, reloads, mutations, invoke };
}

test('R3 historical reproduction: all three actual profile/privacy methods adopt B after an A await and build C', async t => {
  if (!profileSources) return t.skip('reviewed Git history unavailable');
  for (const operation of profileOperations) {
    const f = await profileFixture(profileGroups, profileSources), p = pause();
    const method = operation === 'updatePrivacySettings' ? privacyMethods[0] : operation;
    f.subject.client[method] = p.enter;
    const pending = f.invoke(operation);
    await p.waiting; await f.install('B'); const tokenB = f.row.nexiGroupsSocketOwner;
    p.release(); assert.equal((await pending).update, 'success');
    await Promise.all(f.reloads.map(value => value.task));
    assert.equal(f.reloads.length, 1); assert.equal(f.sockets.length, 3);
    assert.notEqual(f.row.nexiGroupsSocketOwner, tokenB); assert.notEqual(f.subject.client.label, 'B');
    if (operation === 'updatePrivacySettings') assert.ok(f.mutations.some(value => value.label === 'B'));
  }
});

test('R3 historical strongest reproduction: profile await survives actual Chatwoot manual disconnect and resurrects on restart', async t => {
  if (!profileSources) return t.skip('reviewed Git history unavailable');
  const f = await profileFixture(profileGroups, profileSources), p = pause(); f.subject.client.removeProfilePicture = p.enter;
  f.row.disconnectionObject = 'nexi_groups_admission_suspended';
  const pending = f.invoke('removeProfilePicture'); await p.waiting;
  const cw = chatwootCommandFixture(profileGroups, profileSources, f);
  await cw.subject.receiveWebhook(cw.instance, cw.body);
  assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close'); assert.equal(f.subject.client.ws.isOpen, false);
  p.release(); await pending; await Promise.all(f.reloads.map(value => value.task));
  assert.equal(f.sockets.length - 1, 1);
  await f.subject.connectionUpdate({ connection: 'open' }); assert.equal(f.row.connectionStatus, 'open');
  const restarted = await lifecycleFixture(profileGroups, profileSources); Object.assign(restarted.row, f.row);
  const monitor = nativeMonitor(profileGroups, profileSources, restarted.subject);
  await monitor.setInstance({ instanceId: restarted.subject.instanceId, instanceName: restarted.subject.instance.name,
    integration: 'baileys', connectionStatus: f.row.connectionStatus, ...profileGroups.suspensionMetadata(f.row) });
  assert.equal(restarted.sockets.length, 1);
});

for (const operation of profileOperations) {
  test(`R3 ${operation}: actual mutation await cannot adopt or replace B; original context and timers stay intact`, async () => {
    const f = await profileFixture(groups, sources), p = pause();
    const method = operation === 'updatePrivacySettings' ? privacyMethods[0] : operation;
    f.subject.client[method] = p.enter;
    const pending = f.invoke(operation), rejected = assert.rejects(pending, error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
    await p.waiting; await f.install('B');
    const ownerB = groups.lifecycleCapture(f.subject), saved = structuredClone(f.row);
    const timer = groups.scheduleLifecycle(ownerB, async () => {}, 100000);
    try {
      p.release(); await rejected;
      assert.equal(f.subject.client.label, 'B'); assert.equal(f.subject.client.ws.isOpen, true);
      assert.equal(f.sockets.length, 2); assert.deepEqual(f.row, saved); assert.equal(f.reloads.length, 0);
      assert.ok(ownerB.owner.timers.has(timer)); assert.ok(!f.mutations.some(value => value.label === 'B'));
      assert.ok(!f.effects.includes('B.ws')); assert.ok(!f.effects.includes('B.end'));
    } finally { groups.cancelLifecycle(ownerB); }
  });

  test(`R3 ${operation}: manual Chatwoot disconnect wins over pending mutation; restart has zero sockets`, async () => {
    const f = await profileFixture(groups, sources), p = pause();
    f.row.disconnectionObject = 'nexi_groups_admission_suspended';
    const method = operation === 'updatePrivacySettings' ? privacyMethods[0] : operation;
    f.subject.client[method] = p.enter;
    const pending = f.invoke(operation), rejected = assert.rejects(pending, error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
    await p.waiting;
    const cw = chatwootCommandFixture(groups, sources, f); await cw.subject.receiveWebhook(cw.instance, cw.body);
    assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close'); assert.equal(f.row.connectionStatus, 'close');
    const manual = structuredClone(f.row);
    p.release(); await rejected;
    assert.equal(f.reloads.length, 0); assert.equal(f.sockets.length - 1, 0); assert.deepEqual(f.row, manual);
    await f.subject.connectionUpdate({ connection: 'open' });
    await groups.recoverAdmission(f.subject, Date.now() + 600000); assert.deepEqual(f.row, manual);
    const restarted = await lifecycleFixture(groups, sources); Object.assign(restarted.row, f.row);
    const monitor = nativeMonitor(groups, sources, restarted.subject);
    await monitor.setInstance({ instanceId: restarted.subject.instanceId, instanceName: restarted.subject.instance.name,
      integration: 'baileys', connectionStatus: f.row.connectionStatus, ...groups.suspensionMetadata(f.row) });
    await groups.recoverAdmission(restarted.subject, Date.now() + 600000); assert.equal(restarted.sockets.length, 0);
  });

  test(`R3 ${operation}: current-owner mutation awaits reload and yields one live owned socket`, async () => {
    const f = await profileFixture(groups, sources), captured = groups.lifecycleCapture(f.subject);
    const result = await f.invoke(operation);
    assert.equal(result.update, 'success'); assert.equal(f.reloads.length, 1);
    assert.equal(f.reloads[0].args[0].socket, captured.socket); assert.equal(f.reloads[0].args[0].token, captured.token);
    assert.equal(f.reloads[0].args[0].connectEpoch, captured.connectEpoch);
    assert.equal(f.sockets.length, 2); assert.equal(f.sockets.filter(value => value.ws.isOpen).length, 1);
    assert.equal(f.subject.client.label, 'S1'); assert.ok(f.mutations.length > 0);
    assert.ok(f.mutations.every(value => value.label === 'A'));
    await f.subject.connectionUpdate({ connection: 'open' }); assert.equal(f.row.connectionStatus, 'open');
  });

  test(`R3 ${operation}: deleted row, foreign DB owner, epoch-only cancellation and monitor removal cannot grant reload authority`, async () => {
    for (const outcome of ['deleted', 'foreign', 'epoch', 'removed']) {
      const f = await profileFixture(groups, sources), p = pause();
      const method = operation === 'updatePrivacySettings' ? privacyMethods[0] : operation;
      f.subject.client[method] = p.enter;
      const monitor = nativeMonitor(groups, sources, f.subject); groups.trackRecovery(monitor, f.subject, f.subject.instance.name);
      const pending = f.invoke(operation), rejected = assert.rejects(pending, error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
      await p.waiting;
      if (outcome === 'deleted') f.subject.prismaRepository.instance.findUnique = async () => null;
      if (outcome === 'foreign') Object.assign(f.row, { nexiGroupsSocketOwner: 'foreign-newer-owner', connectionStatus: 'open', disconnectionObject: 'foreign-state' });
      if (outcome === 'epoch') groups.lifecycleCapture(f.subject).owner.connectEpoch = 1;
      if (outcome === 'removed') {
        const handlers = {}; monitor.eventEmitter = { on: (event, handler) => { handlers[event] = handler; } }; monitor.removeInstance();
        monitor.configService = { get: () => ({ ENABLED: false }) };
        for (const key of ['chat', 'contact', 'messageUpdate', 'message', 'webhook', 'chatwoot', 'proxy', 'rabbitmq', 'nats', 'sqs', 'integrationSession', 'typebot', 'websocket', 'setting', 'label']) {
          f.subject.prismaRepository[key] ||= {}; f.subject.prismaRepository[key].deleteMany = async () => {};
        }
        await handlers['remove.instance'](f.subject.instance.name);
        assert.ok(f.effects.includes('instance.delete')); assert.equal(monitor.waInstances[f.subject.instance.name], undefined);
      }
      const saved = structuredClone(f.row); p.release(); await rejected;
      assert.equal(f.reloads.length, 0); assert.equal(f.sockets.length, 1); assert.deepEqual(f.row, saved);
      if (outcome === 'foreign') { assert.equal(f.row.nexiGroupsSocketOwner, 'foreign-newer-owner'); assert.ok(!f.effects.includes('A.end')); }
    }
  });
}

test('R3 privacy revalidates all six actual remote awaits before any later mutation or reload', async () => {
  for (const method of privacyMethods) {
    const f = await profileFixture(groups, sources), p = pause(); f.subject.client[method] = p.enter;
    const pending = f.invoke('updatePrivacySettings'), rejected = assert.rejects(pending, error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
    await p.waiting; await f.install('B'); const mutations = f.mutations.length; p.release(); await rejected;
    assert.equal(f.mutations.length, mutations); assert.equal(f.reloads.length, 0); assert.equal(f.sockets.length, 2);
  }
});

test('R3 actual profile download await cannot mutate replacement; current download still mutates A and awaits reload', async () => {
  for (const stale of [true, false]) {
    const p = pause(), f = await profileFixture(groups, sources, { extra: { axios: { get: async () => { await p.enter(); return { data: Buffer.from('synthetic') }; } } } });
    const pending = f.subject.updateProfilePicture('https://synthetic.example.test/picture');
    const result = pending.then(value => ({ value }), error => ({ error }));
    await p.waiting; if (stale) await f.install('B'); p.release(); const completed = await result;
    if (stale) { assert.equal(completed.error.code, 'NEXI_SOCKET_LIFECYCLE_STALE'); assert.equal(f.mutations.length, 0); assert.equal(f.reloads.length, 0); assert.equal(f.subject.client.label, 'B'); }
    else { assert.equal(completed.value.update, 'success'); assert.equal(f.mutations[0].label, 'A'); assert.equal(f.reloads.length, 1); }
  }
});

test('R3 reload rejects stale original context before construction and profile callers await real reload rejection', async () => {
  const f = await profileFixture(groups, sources), original = groups.lifecycleCapture(f.subject);
  await f.install('B'); const saved = structuredClone(f.row);
  await assert.rejects(f.subject.reloadConnection(original), error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
  assert.equal(f.sockets.length, 2); assert.deepEqual(f.row, saved); assert.equal(f.subject.client.ws.isOpen, true);
  for (const operation of profileOperations) {
    const current = await profileFixture(groups, sources);
    current.subject.createClient = async () => { throw new Error('synthetic actual reload construction failure'); };
    await assert.rejects(current.invoke(operation), /Error (updating|removing)/);
    await assert.rejects(current.reloads[0].task, /reload construction failure/);
    assert.equal(current.reloads.length, 1); assert.equal(current.sockets.length, 1);
  }
});

async function creationFixture(helper, code) {
  const f = await lifecycleFixture(helper, code), p = pause();
  const method = lifecycleMethod(code['src/api/controllers/instance.controller.ts'], '  public async createInstance(', '  public async connectToWhatsapp(');
  const dependencies = { require: () => helper, channelController: { init: () => f.subject },
    v4: () => f.subject.instanceId, eventManager: { setInstance: async () => {} },
    Integration: { WHATSAPP_BAILEYS: 'baileys', WHATSAPP_BUSINESS: 'business', EVOLUTION: 'evo' },
    BadRequestException: class extends Error {}, isArray: Array.isArray,
    isURL: value => String(value).startsWith('https://'), delay: async () => {}, Events: { INSTANCE_CREATE: 'INSTANCE_CREATE' } };
  const Controller = new Function(...Object.keys(dependencies), ts.transpileModule('class Controller { ' + method + ' }; return Controller;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(dependencies));
  const controller = new Controller(), monitor = { waInstances: {}, saveInstance: async () => {}, delInstanceTime() {},
    deleteInstance: name => { delete monitor.waInstances[name]; f.effects.push('monitor.delete'); } };
  Object.assign(controller, { waMonitor: monitor, settingsService: { create: p.enter }, configService: f.subject.configService,
    prismaRepository: f.subject.prismaRepository, logger: f.subject.logger });
  f.subject.instanceName = f.subject.instance.name; f.subject.connectionStatus = { state: 'close' }; f.subject.qrCode = {};
  const invoke = () => controller.createInstance({ instanceName: f.subject.instance.name, integration: 'baileys', qrcode: true, token: 'synthetic' });
  return { ...f, controller, monitor, p, invoke };
}

test('R3 same-class historical createInstance: settings await permits late connect to adopt A after manual disconnect', async t => {
  if (!profileSources) return t.skip('reviewed Git history unavailable');
  const f = await creationFixture(profileGroups, profileSources), pending = f.invoke();
  await f.p.waiting; await f.subject.connectToWhatsapp();
  f.row.disconnectionObject = 'nexi_groups_admission_suspended';
  const cw = chatwootCommandFixture(profileGroups, profileSources, f);
  await cw.subject.receiveWebhook(cw.instance, cw.body); assert.equal(f.row.connectionStatus, 'close');
  f.p.release(); await pending;
  assert.equal(f.sockets.length, 2); assert.equal(f.subject.client.ws.isOpen, true);
});

test('R3 same-class historical startup failure adopts B after its original connection await fails', async t => {
  if (!profileSources) return t.skip('reviewed Git history unavailable');
  const f = await lifecycleFixture(profileGroups, profileSources), p = pause(), create = f.subject.createClient;
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  f.subject.createClient = async () => { await create(); await p.enter(); throw new Error('synthetic late local initialization failure'); };
  const monitor = nativeMonitor(profileGroups, profileSources, f.subject);
  const pending = monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name,
    integration: 'baileys', connectionStatus: 'connecting', ...profileGroups.suspensionMetadata(f.row) });
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open'; p.release(); await pending;
  assert.equal(f.subject.client.label, 'B'); assert.equal(f.subject.client.ws.isOpen, false); assert.ok(f.effects.includes('B.end'));
  assert.equal(f.row.connectionStatus, 'connecting');
});

test('R3 same-class actual startup failure retains original attempt authority and cannot suspend replacement B', async () => {
  const f = await lifecycleFixture(groups, sources), p = pause(), create = f.subject.createClient;
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  f.subject.createClient = async () => { await create(); await p.enter(); throw new Error('synthetic late local initialization failure'); };
  const monitor = nativeMonitor(groups, sources, f.subject);
  const pending = monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name,
    integration: 'baileys', connectionStatus: 'connecting', ...groups.suspensionMetadata(f.row) });
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open'; const saved = structuredClone(f.row);
  p.release(); await pending;
  assert.equal(f.subject.client.label, 'B'); assert.equal(f.subject.client.ws.isOpen, true); assert.ok(!f.effects.includes('B.end'));
  assert.deepEqual(f.row, saved); assert.equal(monitor.waInstances[f.subject.instance.name], f.subject);
});

test('R3 same-class actual createInstance settings await retains original authority; replacement/manual close cannot be adopted or deleted', async () => {
  for (const outcome of ['replacement', 'manual', 'foreign-service', 'current']) {
    const f = await creationFixture(groups, sources), pending = f.invoke();
    const result = pending.then(value => ({ value }), error => ({ error }));
    await f.p.waiting;
    if (outcome !== 'current') await f.subject.connectToWhatsapp();
    if (outcome === 'manual') {
      f.row.disconnectionObject = 'nexi_groups_admission_suspended';
      const cw = chatwootCommandFixture(groups, sources, f); await cw.subject.receiveWebhook(cw.instance, cw.body);
    }
    const foreign = { marker: 'foreign-service' };
    if (outcome === 'foreign-service') f.monitor.waInstances[f.subject.instance.name] = foreign;
    const saved = structuredClone(f.row);
    f.p.release(); const completed = await result;
    if (outcome === 'current') { assert.equal(completed.value.instance.instanceName, f.subject.instance.name); assert.equal(f.sockets.length, 1); }
    else {
      assert.equal(completed.error.code, 'NEXI_SOCKET_LIFECYCLE_STALE'); assert.equal(f.sockets.length, 1); assert.deepEqual(f.row, saved);
      assert.ok(!f.effects.includes('monitor.delete'));
      assert.equal(f.monitor.waInstances[f.subject.instance.name], outcome === 'foreign-service' ? foreign : f.subject);
      assert.equal(f.subject.client.ws.isOpen, outcome !== 'manual');
    }
  }
});

test('R3 actual reload initialization await cannot lose its original owner to replacement or manual intent', async () => {
  for (const outcome of ['replacement', 'manual']) {
    const f = await profileFixture(groups, sources), p = pause(), create = f.subject.createClient;
    f.subject.createClient = async () => { await p.enter(); return create(); };
    const pending = f.invoke('removeProfilePicture'), rejected = assert.rejects(pending, error => error.code === 'NEXI_SOCKET_LIFECYCLE_STALE');
    await p.waiting;
    if (outcome === 'replacement') await f.install('B');
    else {
      f.row.disconnectionObject = 'nexi_groups_admission_suspended';
      // The native logout cancellation starts immediately and waits for the
      // already-running reload registration task. Release that task afterward.
      const logout = f.subject.logoutInstance();
      await new Promise(resolve => setImmediate(resolve)); p.release(); await rejected; await logout;
      assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close'); assert.equal(f.sockets.length, 1);
      continue;
    }
    const saved = structuredClone(f.row); p.release(); await rejected;
    assert.equal(f.sockets.length, 2); assert.equal(f.subject.client.ws.isOpen, true); assert.deepEqual(f.row, saved);
  }
});

test('R3 legitimate explicit reconnect after manual close permits new current-owner profile operations', async () => {
  const f = await profileFixture(groups, sources); f.row.disconnectionObject = 'nexi_groups_admission_suspended';
  const cw = chatwootCommandFixture(groups, sources, f); await cw.subject.receiveWebhook(cw.instance, cw.body);
  await f.subject.connectToWhatsapp(); await f.subject.connectionUpdate({ connection: 'open' });
  assert.equal(f.row.connectionStatus, 'open');
  assert.equal((await f.invoke('updatePrivacySettings')).update, 'success');
});

test('R3 same-class mechanical audit inventories transformed lifecycle calls and pins every residual reload to original authority', () => {
  const methods = new Set(['reloadConnection', 'connectToWhatsapp', 'logout', 'end', 'close', 'connect', 'restart',
    'lifecycleCapture', 'lifecycleCheck', 'lifecycleCurrent', 'lifecycleAwait', 'connectCheck', 'connectAwait',
    'connectLifecycle', 'controlConnect', 'manualLifecycle', 'cleanupLifecycle', 'scheduleLifecycle',
    'persistLifecycle', 'startupFailure', 'recoverAdmission', 'operationCheck', 'operationAwait']);
  const inventory = [], runtime = { ...sources, 'nexi-groups.cjs': fs.readFileSync(path.join(__dirname, 'nexi-groups.cjs'), 'utf8') };
  for (const [file, source] of Object.entries(runtime).filter(([file]) => file.endsWith('.ts') || file === 'nexi-groups.cjs')) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      const method = ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : null);
      if (methods.has(method)) {
        let scope = node.parent;
        while (scope && !((ts.isMethodDeclaration(scope) || ts.isFunctionDeclaration(scope)) && scope.name)) scope = scope.parent;
        inventory.push({ file, method, scope: scope?.name?.getText(ast) || 'callback',
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, call: node.getText(ast).replace(/\s+/g, ' ') });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const reloads = inventory.filter(value => value.method === 'reloadConnection');
  assert.equal(reloads.length, 3); assert.ok(reloads.every(value => value.call === 'this.reloadConnection(nexiOperation)'));
  for (const operation of profileOperations) {
    const start = sources[baileysFile].indexOf(`  public async ${operation}(`);
    const end = sources[baileysFile].indexOf('\n  public async ', start + 1);
    const block = sources[baileysFile].slice(start, end);
    assert.doesNotMatch(block, /this\.client/); assert.match(block, /await this\.reloadConnection\(nexiOperation\)/);
    assert.ok(block.indexOf('lifecycleCapture(this)') < block.indexOf('await '));
  }
  const startup = lifecycleMethod(sources['src/api/services/monitor.service.ts'], '  private async setInstance(', '  private async loadInstancesFromRedis');
  assert.match(startup, /startupFailure\(instance, nexiStartupOwner\)/); assert.match(startup, /controlConnect\(nexiStartupOwner\)/);
  const creation = lifecycleMethod(sources['src/api/controllers/instance.controller.ts'], '  public async createInstance(', '  public async connectToWhatsapp(');
  assert.match(creation, /controlConnect\(nexiCreationOwner, instanceData.number\)/);
  assert.match(runtime['nexi-groups.cjs'], /const current = expected \|\| lifecycleCapture/);
  assert.ok(inventory.some(value => value.method === 'logout')); assert.ok(inventory.some(value => value.method === 'end'));
  const esbuild = require(require.resolve('esbuild', { paths: [__dirname, upstream] }));
  const compiled = esbuild.transformSync('class Lifecycle { ' +
    lifecycleMethod(sources[baileysFile], '  public async reloadConnection(', '  private readonly chatHandle') +
    lifecycleMethod(sources[baileysFile], '  public async updatePrivacySettings(', '  public async fetchBusinessProfile(') +
    lifecycleMethod(sources[baileysFile], '  public async updateProfilePicture(', '  public async blockUser(') + ' }',
  { loader: 'ts', minify: true, target: 'node20' }).code;
  for (const gate of ['operationCheck(', 'operationAwait(', 'nexi_socket_profile_reload']) assert.ok(compiled.includes(gate));
  if (process.env.NEXI_GROUPS_AUDIT_OUTPUT) fs.writeFileSync(process.env.NEXI_GROUPS_AUDIT_OUTPUT, JSON.stringify(inventory, null, 2));
});

async function uncertainManualFixture(helper, code, { outcome = 'proposed', deletion = false, refundUncertain = false } = {}) {
  const f = await lifecycleFixture(helper, code); await f.install('A');
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  const previous = f.row.nexiGroupsSocketOwner, p = pause(), update = f.subject.prismaRepository.instance.updateMany;
  let proposal, held = false, reads = 0;
  const read = f.subject.prismaRepository.instance.findUnique;
  f.subject.prismaRepository.instance.findUnique = async args => { if (held) reads++; return read(args); };
  f.subject.prismaRepository.instance.updateMany = async args => {
    if (!held && args.data.nexiGroupsSocketOwner && args.data.nexiGroupsSocketOwner !== previous) {
      proposal = args.data.nexiGroupsSocketOwner;
      if (outcome !== 'previous') await update(args);
      held = true; await p.enter(); throw new Error('synthetic lost registration response after possible commit');
    }
    if (refundUncertain && held && args.data.nexiGroupsSocketOwner === previous) {
      refundUncertain = false; await update(args); throw new Error('synthetic manual refund response lost');
    }
    return update(args);
  };
  const connect = f.subject.connectToWhatsapp();
  const connectFailure = assert.rejects(connect, /lost registration response/);
  await p.waiting;
  let manual;
  const monitor = nativeMonitor(helper, code, f.subject);
  helper.trackRecovery(monitor, f.subject, f.subject.instance.name);
  if (deletion) {
    const handlers = {};
    monitor.logger.error = error => f.effects.push(error?.error?.message || error?.message || String(error));
    monitor.logger.warn = message => f.effects.push(message);
    monitor.eventEmitter = { on: (name, handler) => { handlers[name] = handler; } }; monitor.removeInstance();
    const keys = ['chat', 'contact', 'messageUpdate', 'message', 'webhook', 'chatwoot', 'proxy', 'rabbitmq', 'nats', 'sqs', 'integrationSession', 'typebot', 'websocket', 'setting', 'label'];
    for (const key of keys) {
      f.subject.prismaRepository[key] ||= {};
      f.subject.prismaRepository[key].deleteMany = async () => {};
    }
    monitor.configService = { get: () => ({ ENABLED: false }) };
    manual = handlers['remove.instance'](f.subject.instance.name);
  } else manual = f.subject.logoutInstance();
  const result = manual.then(() => ({ success: true }), error => ({ error: error.code }));
  await new Promise(resolve => setImmediate(resolve));
  if (outcome === 'foreign') Object.assign(f.row, { nexiGroupsSocketOwner: 'foreign-newer-owner', connectionStatus: 'open', disconnectionObject: 'foreign-state' });
  p.release(); await connectFailure;
  return { ...f, monitor, previous, proposal, result: await result, reads };
}

test('R1 historical exact reproduction: manual cancellation + committed registration + failed response resurrects after restart', async t => {
  if (!residualSources) return t.skip('reviewed Git history unavailable');
  const f = await uncertainManualFixture(residualGroups, residualSources);
  assert.equal(f.result.error, 'NEXI_SOCKET_LIFECYCLE_STALE');
  assert.equal(f.row.connectionStatus, 'connecting'); assert.equal(f.row.disconnectionObject, 'nexi_groups_admission_suspended');
  assert.equal(f.row.nexiGroupsSocketOwner, f.proposal); assert.equal(f.subject.client.ws.isOpen, false);
  const restarted = await lifecycleFixture(residualGroups, residualSources); Object.assign(restarted.row, f.row);
  const monitor = nativeMonitor(residualGroups, residualSources, restarted.subject);
  await monitor.setInstance({ instanceId: restarted.subject.instanceId, instanceName: restarted.subject.instance.name,
    integration: 'baileys', connectionStatus: f.row.connectionStatus, ...residualGroups.suspensionMetadata(f.row) });
  assert.equal(restarted.sockets.length, 1);
});

function chatwootCommandFixture(helper, code, f, content = '/disconnect') {
  const source = code['src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'];
  const method = lifecycleMethod(source, '  public async receiveWebhook(', '  private async updateChatwootMessageId(');
  const Subject = new Function('require', 'setTimeout', 'i18next', 'sendTelemetry', ts.transpileModule('class Chatwoot { ' + method + ' }; return Chatwoot;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(() => helper, resolve => { resolve(); return {}; }, { t: key => key }, async () => {});
  const subject = new Subject();
  Object.assign(subject, { waMonitor: { waInstances: { [f.subject.instance.name]: f.subject } },
    configService: { get: () => ({ BOT_CONTACT: true }) }, clientCw: async () => ({}), provider: {},
    logger: f.subject.logger, createBotMessage: async () => f.effects.push('bot.response') });
  const body = { event: 'message_created', content, message_type: 'outgoing', inbox: { name: 'Synthetic' },
    conversation: { meta: { sender: { identifier: '123456' } }, messages: [{ sender: { available_name: 'Synthetic' } }] } };
  return { subject, body, instance: { instanceName: f.subject.instance.name, instanceId: f.subject.instanceId } };
}

test('R2 historical exact reproduction: actual Chatwoot disconnect await logs out and closes replacement B', async t => {
  if (!residualSources) return t.skip('reviewed Git history unavailable');
  const f = await lifecycleFixture(residualGroups, residualSources); await f.install('A');
  const cw = chatwootCommandFixture(residualGroups, residualSources, f), p = pause();
  cw.subject.createBotMessage = p.enter;
  const command = cw.subject.receiveWebhook(cw.instance, cw.body);
  await p.waiting; await f.install('B'); f.subject.client.logout = async () => f.effects.push('B.logout');
  p.release(); await command;
  assert.ok(f.effects.includes('B.logout')); assert.ok(f.effects.includes('B.ws')); assert.equal(f.subject.client.ws.isOpen, false);
});

test('R1-A/C actual manual logout resolves committed lost response and true noncommit; restart stays closed', async () => {
  for (const outcome of ['proposed', 'previous']) {
    const f = await uncertainManualFixture(groups, sources, { outcome });
    assert.equal(f.result.error, undefined); assert.equal(f.row.nexiGroupsSocketOwner, f.previous);
    assert.ok(f.reads >= 1, 'manual cleanup rereads authoritative ownership');
    assert.equal(f.row.connectionStatus, 'close'); assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close');
    assert.equal(f.subject.client.ws.isOpen, false);
    const restarted = await lifecycleFixture(groups, sources); Object.assign(restarted.row, f.row);
    const monitor = nativeMonitor(groups, sources, restarted.subject);
    await monitor.setInstance({ instanceId: restarted.subject.instanceId, instanceName: restarted.subject.instance.name,
      integration: 'baileys', connectionStatus: f.row.connectionStatus, ...groups.suspensionMetadata(f.row) });
    await groups.recoverAdmission(restarted.subject, Date.now() + 600000);
    assert.equal(restarted.sockets.length, 0);
  }
});

test('R1-B foreign committed owner is never adopted, refunded, deleted or overwritten; pending service retires', async () => {
  const f = await uncertainManualFixture(groups, sources, { outcome: 'foreign' });
  assert.equal(f.result.error, undefined); assert.equal(f.row.nexiGroupsSocketOwner, 'foreign-newer-owner');
  assert.equal(f.row.connectionStatus, 'open'); assert.equal(f.row.disconnectionObject, 'foreign-state');
  assert.equal(f.monitor.waInstances[f.subject.instance.name], undefined);
  assert.equal(f.sockets[0].ws.isOpen, false, 'retirement closes only the old physical socket');
  assert.ok(!f.effects.includes('instance.delete')); assert.equal(f.sockets.length, 1);
  await groups.recoverAdmission(f.subject, Date.now() + 600000); assert.equal(f.sockets.length, 1);
});

test('R1-D actual manual delete resolves uncertain committed token and clears recoverable state before deletion', async () => {
  const f = await uncertainManualFixture(groups, sources, { deletion: true });
  assert.equal(f.result.error, undefined); assert.equal(f.row.connectionStatus, 'close');
  assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close');
  assert.ok(f.effects.includes('instance.delete'), JSON.stringify(f.effects)); assert.equal(f.monitor.waInstances[f.subject.instance.name], undefined);
});

test('R1-E uncertain committed registration without manual action retains bounded automatic recovery', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const failure = Object.assign(new Error('synthetic admission unavailable'), { code: 'NEXI_GROUPS_ADMISSION_SUSPENDED' });
  f.configs[0].nexiGroupsSuspend(failure); await groups.recordSuspension(f.subject, failure, 'connection.update');
  f.gate.registration = 'uncertain';
  await groups.recoverAdmission(f.subject, Date.now() + 600000);
  assert.equal(f.sockets.length, 1);
  await groups.recoverAdmission(f.subject, Date.now() + 1200000);
  assert.equal(f.sockets.length, 2); assert.equal(f.subject.client.ws.isOpen, true);
});

test('R1 manual refund response lost after commit resolves by authoritative reread without duplicate registration', async () => {
  const f = await uncertainManualFixture(groups, sources, { refundUncertain: true });
  assert.equal(f.result.error, undefined); assert.ok(f.reads >= 2);
  assert.equal(f.row.nexiGroupsSocketOwner, f.previous);
  assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close'); assert.equal(f.row.connectionStatus, 'close');
  assert.equal(f.sockets.length, 1); assert.equal(f.subject.client.ws.isOpen, false);
});

test('R1 suspension write awaiting parent ownership lock cannot overwrite newer manual intent', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const failure = Object.assign(new Error('synthetic admission unavailable'), { code: 'NEXI_GROUPS_ADMISSION_SUSPENDED' });
  f.configs[0].nexiGroupsSuspend(failure);
  const p = pause(), update = f.subject.prismaRepository.instance.updateMany; let first = true;
  f.subject.prismaRepository.instance.updateMany = async args => {
    if (first && args.data.nexiGroupsSocketOwner) { first = false; await p.enter(); }
    return update(args);
  };
  const pending = groups.recordSuspension(f.subject, failure, 'connection.update');
  await p.waiting; await f.subject.logoutInstance(); p.release(); await pending;
  assert.equal(f.row.connectionStatus, 'close');
  assert.notEqual(f.row.disconnectionObject, 'nexi_groups_admission_suspended');
  assert.equal(f.subject.stateConnection.state, 'close');
});

test('R2-A actual Chatwoot disconnect/createBotMessage race preserves B, monitor, state and timers; no success reply', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const cw = chatwootCommandFixture(groups, sources, f), p = pause(), replies = [];
  cw.subject.createBotMessage = async (_instance, content) => { replies.push(content); await p.enter(); };
  const command = cw.subject.receiveWebhook(cw.instance, cw.body);
  await p.waiting; await f.install('B'); f.subject.client.logout = async () => f.effects.push('B.logout');
  f.row.connectionStatus = 'open'; f.subject.stateConnection.state = 'open';
  const ownerB = groups.lifecycleCapture(f.subject), timerB = groups.scheduleLifecycle(ownerB, async () => {}, 100000);
  p.release(); const result = await command;
  assert.equal(result.lifecycle, 'superseded'); assert.equal(f.subject.client.ws.isOpen, true);
  assert.equal(f.row.connectionStatus, 'open'); assert.equal(f.subject.stateConnection.state, 'open');
  assert.equal(cw.subject.waMonitor.waInstances[f.subject.instance.name], f.subject);
  assert.ok(!f.effects.includes('B.logout')); assert.ok(!f.effects.includes('B.ws')); assert.ok(!f.effects.includes('B.end'));
  assert.deepEqual(replies, ['cw.inbox.status']); assert.ok(ownerB.owner.timers.has(timerB));
  groups.cancelLifecycle(ownerB);
});

test('R2-B current-owner Chatwoot disconnect retains logout/close behavior and persists explicit manual state', async () => {
  for (const content of ['/disconnect', '/desconectar']) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    f.row.disconnectionObject = 'nexi_groups_admission_suspended';
    f.subject.client.logout = async () => f.effects.push('A.logout');
    const cw = chatwootCommandFixture(groups, sources, f, content), replies = [];
    cw.subject.createBotMessage = async (_instance, message) => replies.push(message);
    const result = await cw.subject.receiveWebhook(cw.instance, cw.body);
    assert.equal(result.lifecycle, undefined);
    assert.ok(f.effects.includes('A.logout')); assert.ok(f.effects.includes('A.ws'));
    assert.equal(f.subject.client.ws.isOpen, false); assert.equal(f.row.connectionStatus, 'close');
    assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close');
    assert.deepEqual(replies, ['cw.inbox.status', 'cw.inbox.disconnect']);
    await groups.recoverAdmission(f.subject, Date.now() + 600000); assert.equal(f.sockets.length, 1);
  }
});

test('R2 current disconnect notification failure cannot strand a manual owner with a live socket', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  f.row.disconnectionObject = 'nexi_groups_admission_suspended';
  f.subject.client.logout = async () => f.effects.push('A.logout');
  const cw = chatwootCommandFixture(groups, sources, f);
  cw.subject.createBotMessage = async () => { throw new Error('synthetic control response unavailable'); };
  await cw.subject.receiveWebhook(cw.instance, cw.body);
  assert.ok(f.effects.includes('A.logout')); assert.equal(f.subject.client.ws.isOpen, false);
  assert.equal(f.row.connectionStatus, 'close'); assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close');
});

test('R2 historical audit: native setSettings closes/connects B after its awaited settings write', async t => {
  if (!residualSources) return t.skip('reviewed Git history unavailable');
  const f = await lifecycleFixture(residualGroups, residualSources); await f.install('A');
  const method = lifecycleMethod(residualSources['src/api/services/channel.service.ts'], '  public async setSettings(', '  public async findSettings(');
  const Settings = new Function(ts.transpileModule('class Settings { ' + method + ' }; return Settings;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)();
  f.subject.setSettings = Settings.prototype.setSettings; f.subject.localSettings = {};
  const p = pause(); f.subject.prismaRepository.setting = { upsert: p.enter };
  const update = f.subject.setSettings({ wavoipToken: 'synthetic-setting' });
  await p.waiting; await f.install('B'); f.subject.client.ws.connect = () => f.effects.push('B.connect');
  p.release(); await update; assert.ok(f.effects.includes('B.ws')); assert.ok(f.effects.includes('B.connect'));
});

test('R2-C entry/clientCw and captured logout awaits fence disconnect and init/iniciar commands', async () => {
  for (const content of ['/disconnect', '/init', '/iniciar']) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    const cw = chatwootCommandFixture(groups, sources, f, content), p = pause();
    cw.subject.clientCw = async () => { await p.enter(); return {}; };
    const command = cw.subject.receiveWebhook(cw.instance, cw.body);
    await p.waiting; await f.install('B'); f.subject.client.logout = async () => f.effects.push('B.logout');
    p.release(); assert.equal((await command).lifecycle, 'superseded');
    assert.equal(f.subject.client.ws.isOpen, true); assert.equal(f.sockets.length, 2); assert.equal(f.row.connectionStatus, 'open');
  }
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const cw = chatwootCommandFixture(groups, sources, f), p = pause(); f.subject.client.logout = p.enter;
  const command = cw.subject.receiveWebhook(cw.instance, cw.body);
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open'; p.release();
  assert.equal((await command).lifecycle, 'superseded'); assert.equal(f.subject.client.ws.isOpen, true);
  assert.ok(!f.effects.includes('B.ws')); assert.equal(f.row.connectionStatus, 'open');
});

test('R2-D actual direct Chatwoot receive and current init command preserve direct behavior', async () => {
  for (const destination of [sender, lid]) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    const cw = chatwootCommandFixture(groups, sources, f, 'direct realistic fixture'), sent = [];
    cw.body.conversation.meta.sender.identifier = destination; cw.body.conversation.messages[0].source_id = 'WAID:0123456789ABCDEF';
    f.subject.textMessage = async value => sent.push(value);
    assert.deepEqual(await cw.subject.receiveWebhook(cw.instance, cw.body), { message: 'bot' });
    assert.equal(f.subject.client.ws.isOpen, true);
    cw.body.message_type = 'template'; cw.body.conversation.messages[0].source_id = undefined;
    await cw.subject.receiveWebhook(cw.instance, cw.body);
    assert.equal(sent.length, 1); assert.equal(sent[0].number, destination);
  }
  const f = await lifecycleFixture(groups, sources); await f.install('A'); f.subject.connectionStatus = { state: 'close' };
  const cw = chatwootCommandFixture(groups, sources, f, '/init');
  await cw.subject.receiveWebhook(cw.instance, cw.body); assert.equal(f.sockets.length, 2);
});

test('R2 targeted audit: actual setSettings await cannot close/connect replacement; current owner remains functional', async () => {
  for (const stale of [true, false]) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    const method = lifecycleMethod(sources['src/api/services/channel.service.ts'], '  public async setSettings(', '  public async findSettings(');
    const Settings = new Function('require', ts.transpileModule('class Settings { ' + method + ' }; return Settings;',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(() => groups);
    f.subject.setSettings = Settings.prototype.setSettings; f.subject.localSettings = {};
    const p = pause(); f.subject.prismaRepository.setting = { upsert: p.enter };
    f.subject.client.ws.connect = () => f.effects.push('A.connect');
    const update = f.subject.setSettings({ wavoipToken: 'synthetic-setting' });
    const result = update.then(() => ({}), error => ({ code: error.code }));
    await p.waiting;
    if (stale) { await f.install('B'); f.subject.client.ws.connect = () => f.effects.push('B.connect'); }
    p.release(); const final = await result;
    if (stale) { assert.equal(final.code, 'NEXI_SOCKET_LIFECYCLE_STALE'); assert.ok(!f.effects.includes('B.ws')); assert.ok(!f.effects.includes('B.connect')); }
    else { assert.ok(f.effects.includes('A.ws')); assert.ok(f.effects.includes('A.connect')); }
  }
});

test('D1 historical reproduction: native 408 callback across DB await closes replacement and persists close', async t => {
  if (!lifecycleSources) return t.skip('reviewed Git history unavailable');
  const f = await lifecycleFixture(lifecycleGroups, lifecycleSources);
  await f.install('A'); const p = pause(); f.gate.write = p.enter;
  const stale = f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open'; f.subject.stateConnection = { state: 'open' };
  p.release(); await stale;
  assert.ok(f.effects.includes('B.ws')); assert.ok(f.effects.includes('B.end'));
  assert.equal(f.row.connectionStatus, 'close');
});

test('D1 native 408 persistence CAS rejects stale A after B registration; B state/socket/timers stay untouched', async () => {
  const f = await lifecycleFixture(groups, sources);
  await f.install('A'); const p = pause(); f.gate.write = p.enter;
  const stale = f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open'; f.subject.stateConnection = { state: 'open', marker: 'B' };
  const bToken = f.row.nexiGroupsSocketOwner, beforeEffects = f.effects.length;
  p.release(); await stale;
  assert.equal(f.subject.client.label, 'B'); assert.equal(f.subject.client.ws.isOpen, true);
  assert.equal(f.row.connectionStatus, 'open'); assert.equal(f.row.nexiGroupsSocketOwner, bToken);
  assert.deepEqual(f.subject.stateConnection, { state: 'open', marker: 'B' });
  assert.equal(f.effects.length, beforeEffects);
  assert.equal(groups.lifecycleCurrent(groups.lifecycleCapture(f.subject)), true);
});

test('D1 actual direct native 408, open, connecting, pairing and Chatwoot preserve accepted behavior', async () => {
  for (const managed of [true, false]) {
    const f = await lifecycleFixture(groups, sources, { managed }); await f.install('A');
    await f.subject.connectionUpdate({ connection: 'connecting' });
    assert.equal(f.subject.stateConnection.state, 'connecting');
    await f.subject.connectionUpdate({ connection: 'open' });
    assert.equal(f.row.connectionStatus, 'open'); assert.ok(f.effects.includes('chatwoot.sync'));
    f.subject.phoneNumber = '5511999999999';
    await f.subject.connectionUpdate({ qr: 'synthetic-qr' });
    assert.equal(f.subject.instance.qrcode.pairingCode, 'synthetic-pair');
    assert.equal(f.row.connectionStatus, 'connecting');
    await f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    assert.equal(f.row.connectionStatus, 'close'); assert.equal(f.subject.client.ws.isOpen, false);
    assert.deepEqual(f.effects.filter(value => value === 'A.ws' || value === 'A.end'), ['A.ws', 'A.end']);
    await f.subject.connectToWhatsapp();
    assert.equal(f.subject.client.ws.isOpen, true);
    for (const destination of [sender, lid]) assert.equal(f.subject.client.sendMessage(destination,
      { text: 'direct', key: { remoteJid: destination, id: '0123456789ABCDEF0123456789ABCDEF' } }), 'sent');
  }
});

test('D1 profile/pairing awaits and QR callback cannot mutate replacement; owner context is opaque', async () => {
  for (const operation of ['profile', 'pairing']) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    const p = pause();
    if (operation === 'profile') f.subject.profilePicture = async () => { await p.enter(); return { profilePictureUrl: 'OLD' }; };
    else { f.subject.phoneNumber = sender; f.subject.client.requestPairingCode = async () => { await p.enter(); return 'OLD'; }; }
    const stale = f.subject.connectionUpdate(operation === 'profile' ? { connection: 'open' } : { qr: 'old' });
    await p.waiting; await f.install('B');
    f.subject.instance.profilePictureUrl = 'B'; f.subject.instance.qrcode.pairingCode = 'B';
    f.row.connectionStatus = 'open'; p.release(); await stale;
    assert.equal(f.subject.instance.profilePictureUrl, 'B'); assert.equal(f.subject.instance.qrcode.pairingCode, 'B');
    assert.equal(f.row.connectionStatus, 'open'); assert.equal(JSON.stringify(groups.lifecycleCapture(f.subject)), '{}');
  }
  let qrCallback;
  const f = await lifecycleFixture(groups, sources, { extra: { qrcode: { toDataURL: (_qr, _opts, cb) => { qrCallback = cb; } } } });
  await f.install('A'); await f.subject.connectionUpdate({ qr: 'old' }); await f.install('B');
  f.subject.instance.qrcode.base64 = 'B'; qrCallback(null, 'OLD');
  assert.equal(f.subject.instance.qrcode.base64, 'B');
});

test('D1 monitor delayed-close/logout recheck owner after native awaits; stale timer cannot remove B timer', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const callbacks = [], handlers = {};
  const monitor = nativeMonitor(groups, sources, f.subject, {
    setTimeout: callback => { const handle = { callback }; callbacks.push(handle); return handle; }, clearTimeout() {}
  });
  monitor.waInstances[f.subject.instance.name] = f.subject; groups.trackRecovery(monitor, f.subject, f.subject.instance.name);
  monitor.configService = { get: () => 1 };
  f.subject.connectionStatus = { state: 'connecting' };
  const p = pause(); f.subject.client.logout = p.enter;
  monitor.delInstanceTime(f.subject.instance.name); const oldTimer = callbacks[0];
  const stale = oldTimer.callback(); await p.waiting; await f.install('B');
  monitor.delInstanceTime(f.subject.instance.name); const newTimer = callbacks[1];
  p.release(); await stale;
  assert.equal(monitor.delInstanceTimeouts[f.subject.instance.name], newTimer);
  assert.equal(f.subject.client.ws.isOpen, true); assert.ok(!f.effects.includes('B.ws'));
  monitor.eventEmitter = { on: (name, handler) => { handlers[name] = handler; } };
  monitor.removeInstance(); monitor.noConnection();
  const webhook = pause(); f.subject.sendDataWebhook = webhook.enter;
  const ownerB = groups.lifecycleCapture(f.subject, f.subject.client, true);
  const lateLogout = handlers['logout.instance'](f.subject.instance.name, 'inner', ownerB);
  await webhook.waiting; await f.install('C'); webhook.release(); await lateLogout;
  assert.equal(f.subject.client.ws.isOpen, true); assert.equal(f.row.connectionStatus, 'open');
  assert.equal(monitor.delInstanceTimeouts[f.subject.instance.name], newTimer);
  assert.ok(!f.effects.includes('session.delete'));
});

test('D1 owner-bound native reconnect timer, disconnect cleanup and concurrent connect create no duplicate socket', async () => {
  const originalTimeout = global.setTimeout, originalClear = global.clearTimeout, timers = [];
  global.setTimeout = callback => { const timer = { callback }; timers.push(timer); return timer; };
  global.clearTimeout = timer => { timer.cancelled = true; };
  try {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    await f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    assert.equal(timers.length, 1);
    await f.install('B'); await timers[0].callback(); assert.equal(f.sockets.length, 2);
    await f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    await timers[1].callback(); assert.equal(f.sockets.length, 3);
    const current = f.subject.client, p = pause(); current.logout = p.enter;
    const logout = f.subject.logoutInstance(); await p.waiting;
    f.subject.isDeleting = false; f.subject.endSession = false;
    await f.install('C'); f.row.connectionStatus = 'open';
    p.release(); await logout;
    assert.equal(f.subject.client.ws.isOpen, true); assert.equal(f.row.connectionStatus, 'open');
    f.subject.isDeleting = false; f.subject.endSession = false;
    await f.subject.logoutInstance(); assert.equal(f.row.connectionStatus, 'close');
    assert.equal(f.subject.client.ws.isOpen, false); assert.equal(f.subject.isDeleting, true);
    f.subject.isDeleting = false;
    await Promise.all([f.subject.connectToWhatsapp(), f.subject.connectToWhatsapp()]);
    assert.equal(f.sockets.length, 5, 'single-flight explicit restart');
  } finally { global.setTimeout = originalTimeout; global.clearTimeout = originalClear; }
});

test('D2 historical reproduction: actual Monitor.setInstance loses recoverable startup after registration rejection', async t => {
  if (!lifecycleSources) return t.skip('reviewed Git history unavailable');
  const f = await lifecycleFixture(lifecycleGroups, lifecycleSources);
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  f.gate.registration = 'before';
  const monitor = nativeMonitor(lifecycleGroups, lifecycleSources, f.subject);
  await assert.rejects(monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name,
    integration: 'baileys', connectionStatus: 'connecting', ...lifecycleGroups.suspensionMetadata(f.row) }));
  assert.equal(monitor.waInstances[f.subject.instance.name], undefined);
  assert.equal(f.row.disconnectionObject, 'nexi_groups_admission_suspended'); assert.equal(f.sockets.length, 0);
});

test('D1 actual controller logout/delete and restart callbacks retain captured socket across lifecycle boundaries', async () => {
  const code = sources['src/api/controllers/instance.controller.ts'];
  const methods = lifecycleMethod(code, '  public async restartInstance(', '  public async connectionState(') +
    code.slice(code.indexOf('  public async logout('), code.lastIndexOf('\n}'));
  const Controller = new Function('require', 'BadRequestException', 'InternalServerErrorException', ts.transpileModule(
    'class Controller { ' + methods + ' }; return Controller;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
  (() => groups, class extends Error {}, class extends Error {});
  for (const operation of ['logout', 'deleteInstance']) {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    const controller = new Controller(), p = pause();
    Object.assign(controller, { waMonitor: { waInstances: { [f.subject.instance.name]: f.subject } },
      logger: f.subject.logger, configService: f.subject.configService, eventEmitter: f.subject.eventEmitter,
      connectionState: async () => { await p.enter(); return { instance: { state: 'open' } }; } });
    const stale = controller[operation]({ instanceName: f.subject.instance.name });
    const rejected = assert.rejects(stale, /stale/);
    await p.waiting; await f.install('B'); p.release(); await rejected;
    assert.equal(f.subject.client.ws.isOpen, true); assert.equal(f.row.connectionStatus, 'open');
    assert.ok(!f.effects.some(value => Array.isArray(value) && value[0] === 'event'));
  }
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  f.subject.connectionStatus = { state: 'open' };
  const c = new Controller();
  Object.assign(c, { waMonitor: { waInstances: { [f.subject.instance.name]: f.subject } }, logger: f.subject.logger,
    configService: { get: () => ({ ENABLED: false }) }, connectToWhatsapp: async () => 'native-restart' });
  assert.equal(await c.restartInstance({ instanceName: f.subject.instance.name }), 'native-restart');
  assert.ok(f.effects.includes('A.ws')); assert.ok(f.effects.includes('A.end'));
});

test('D1 live stream-515 grace keeps native reconnect while public instance info omits owner token', async () => {
  const original = global.setTimeout, timerCallbacks = [];
  global.setTimeout = callback => { timerCallbacks.push(callback); return {}; };
  try {
    const f = await lifecycleFixture(groups, sources); await f.install('A');
    f.subject._lastStream515At = Date.now();
    await f.subject.connectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(timerCallbacks.length, 1); await timerCallbacks[0](); assert.equal(f.sockets.length, 2);
    const monitor = nativeMonitor(groups, sources, f.subject);
    monitor.configService = { get: () => ({ CONNECTION: { CLIENT_NAME: 'synthetic' } }) };
    monitor.prismaRepository.instance.findMany = async () => [structuredClone(f.row)];
    const [info] = await monitor.instanceInfo();
    assert.equal(info.id, f.row.id); assert.equal(info.nexiGroupsSocketOwner, undefined);
    assert.ok(!JSON.stringify(info).includes(f.row.nexiGroupsSocketOwner));
  } finally { global.setTimeout = original; }
});

test('D1 connect cancellation during registration resolves its proposal before manual cleanup; restart never resurrects', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  const tokenA = f.row.nexiGroupsSocketOwner, p = pause(), update = f.subject.prismaRepository.instance.updateMany;
  let first = true;
  f.subject.prismaRepository.instance.updateMany = async args => {
    if (first && args.data.nexiGroupsSocketOwner && args.data.nexiGroupsSocketOwner !== tokenA) {
      first = false; const result = await update(args); await p.enter(); return result;
    }
    return update(args);
  };
  const connect = f.subject.connectToWhatsapp();
  const rejected = assert.rejects(connect, /stale/);
  await p.waiting;
  const logout = f.subject.logoutInstance();
  await new Promise(resolve => setImmediate(resolve));
  p.release(); await rejected; await logout;
  assert.equal(f.sockets.length, 1); assert.equal(f.subject.client.ws.isOpen, false);
  assert.equal(f.row.nexiGroupsSocketOwner, tokenA);
  assert.equal(f.row.connectionStatus, 'close'); assert.equal(f.row.disconnectionObject, 'nexi_socket_manual_close');
  const restarted = await lifecycleFixture(groups, sources); Object.assign(restarted.row, f.row);
  const monitor = nativeMonitor(groups, sources, restarted.subject);
  await monitor.setInstance({ instanceId: restarted.subject.instanceId, instanceName: restarted.subject.instance.name,
    integration: 'baileys', connectionStatus: 'close', ...groups.suspensionMetadata(restarted.row) });
  await groups.recoverAdmission(restarted.subject, Date.now() + 600000);
  assert.equal(restarted.sockets.length, 0);
});

test('D1 unconnected manual logout retains credential/status semantics and invalidates delayed reconnect', async () => {
  const f = await lifecycleFixture(groups, sources);
  await f.subject.logoutInstance();
  assert.equal(f.row.connectionStatus, 'close'); assert.equal(f.subject.isDeleting, true);
  assert.equal(f.sockets.length, 0);
  await groups.recoverAdmission(f.subject, Date.now() + 600000);
  assert.equal(f.sockets.length, 0);
});

test('D1 actual monitor cleanup CAS/await cannot delete a replacement monitor entry after credential cleanup', async () => {
  const f = await lifecycleFixture(groups, sources); await f.install('A');
  const monitor = nativeMonitor(groups, sources, f.subject), handlers = {};
  groups.trackRecovery(monitor, f.subject, f.subject.instance.name);
  monitor.eventEmitter = { on: (name, handler) => { handlers[name] = handler; } }; monitor.removeInstance();
  const p = pause(); f.subject.prismaRepository.session.deleteMany = p.enter;
  const removing = handlers['remove.instance'](f.subject.instance.name);
  await p.waiting; await f.install('B'); f.row.connectionStatus = 'open';
  p.release(); await removing;
  assert.equal(monitor.waInstances[f.subject.instance.name], f.subject);
  assert.equal(f.subject.client.ws.isOpen, true); assert.equal(f.row.connectionStatus, 'open');
  assert.ok(!f.effects.includes('instance.delete'));
});

test('D2 local failure after socket construction suspends only that socket; tracked retry creates one live replacement', async () => {
  const f = await lifecycleFixture(groups, sources);
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  const create = f.subject.createClient;
  f.subject.createClient = async () => { await create(); throw new Error('synthetic handler registration failed'); };
  const monitor = nativeMonitor(groups, sources, f.subject);
  await monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name, integration: 'baileys',
    connectionStatus: 'connecting', ...groups.suspensionMetadata(f.row) });
  assert.equal(monitor.waInstances[f.subject.instance.name], f.subject);
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].ws.isOpen, false);
  f.subject.createClient = create;
  await groups.recoverAdmission(f.subject, Date.now() + 600000);
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets.filter(socket => socket.ws.isOpen).length, 1);
});

test('D2 newly recoverable startup is pretracked too; uncertain first registration never creates a duplicate owner/socket', async () => {
  const f = await lifecycleFixture(groups, sources);
  f.gate.registration = 'uncertain';
  const monitor = nativeMonitor(groups, sources, f.subject);
  await monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name,
    integration: 'baileys', connectionStatus: 'open' });
  assert.equal(monitor.waInstances[f.subject.instance.name], f.subject);
  assert.ok(f.row.nexiGroupsSocketOwner); assert.equal(f.sockets.length, 0);
  for (let tick = 0; tick < 100; tick++) await groups.recoverAdmission(f.subject);
  assert.equal(f.sockets.length, 0);
  await groups.recoverAdmission(f.subject, Date.now() + 600000);
  assert.equal(f.sockets.length, 1); assert.equal(f.subject.client.ws.isOpen, true);
});

test('D2 actual Monitor/native connect retains failed/uncertain registration; bounded tick resolves ownership before one socket', async () => {
  for (const failure of ['before', 'uncertain']) {
    const f = await lifecycleFixture(groups, sources);
    Object.assign(f.row, { connectionStatus: 'close', disconnectionObject: 'nexi_groups_admission_suspended' });
    f.gate.registration = failure;
    const monitor = nativeMonitor(groups, sources, f.subject);
    const data = { instanceId: f.subject.instanceId, instanceName: f.subject.instance.name, integration: 'baileys',
      connectionStatus: 'close', ...groups.suspensionMetadata(f.row) };
    await monitor.setInstance(data);
    assert.equal(monitor.waInstances[f.subject.instance.name], f.subject); assert.equal(f.sockets.length, 0);
    assert.equal(!!f.row.nexiGroupsSocketOwner, failure === 'uncertain');
    for (let tick = 0; tick < 100; tick++) await groups.recoverAdmission(monitor.waInstances[data.instanceName]);
    assert.equal(f.sockets.length, 0);
    f.gate.registration = null;
    await groups.recoverAdmission(monitor.waInstances[data.instanceName], Date.now() + 600000);
    assert.equal(f.sockets.length, 1); assert.equal(f.subject.client.ws.isOpen, true);
    await monitor.setInstance(data); assert.equal(f.sockets.length, 1);
    await f.subject.connectionUpdate({ connection: 'open' }); assert.equal(f.row.connectionStatus, 'open');
    for (const destination of [sender, lid]) assert.equal(f.subject.client.sendMessage(destination, { text: 'direct' }), 'sent');
    await groups.recoverAdmission(f.subject, Date.now() + 1200000); assert.equal(f.sockets.length, 1);
  }
});

test('D2 pending retry retires on foreign DB owner and never evicts replacement monitor entry', async () => {
  for (const replacementEntry of [false, true]) {
    const f = await lifecycleFixture(groups, sources);
    Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
    f.gate.registration = 'before';
    const monitor = nativeMonitor(groups, sources, f.subject);
    await monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name, integration: 'baileys',
      connectionStatus: 'connecting', ...groups.suspensionMetadata(f.row) });
    const otherService = { marker: 'B' };
    if (replacementEntry) monitor.waInstances[f.subject.instance.name] = otherService;
    f.row.nexiGroupsSocketOwner = 'foreign-authoritative-owner'; f.gate.registration = null;
    await groups.recoverAdmission(f.subject, Date.now() + 600000);
    assert.equal(f.sockets.length, 0);
    assert.equal(monitor.waInstances[f.subject.instance.name], replacementEntry ? otherService : undefined);
    assert.equal(f.row.nexiGroupsSocketOwner, 'foreign-authoritative-owner');
  }
});

test('D2 persistent outage is bounded, manual close never resurrects, startup probe racing new owner retires', async () => {
  const f = await lifecycleFixture(groups, sources);
  Object.assign(f.row, { connectionStatus: 'connecting', disconnectionObject: 'nexi_groups_admission_suspended' });
  f.subject.store.failCreate(true);
  const monitor = nativeMonitor(groups, sources, f.subject);
  await monitor.setInstance({ instanceId: f.subject.instanceId, instanceName: f.subject.instance.name, integration: 'baileys',
    connectionStatus: 'connecting', ...groups.suspensionMetadata(f.row) });
  let probes = 0; const transaction = f.subject.prismaRepository.$transaction;
  f.subject.prismaRepository.$transaction = async work => { probes++; return transaction(work); };
  const now = Date.now() + 600000;
  for (let tick = 0; tick < 100; tick++) await groups.recoverAdmission(f.subject, now + tick);
  assert.equal(probes, 1); assert.equal(f.sockets.length, 0);
  f.subject.store.failCreate(false);
  const p = pause(); f.subject.prismaRepository.$transaction = async work => { await p.enter(); return transaction(work); };
  const pending = groups.recoverAdmission(f.subject, now + 600000); await p.waiting;
  f.row.nexiGroupsSocketOwner = 'new-owner'; p.release(); await pending;
  assert.equal(f.sockets.length, 0); assert.equal(monitor.waInstances[f.subject.instance.name], undefined);
  for (const reason of ['manual', JSON.stringify({ output: { statusCode: 401 } })]) {
    const closed = await lifecycleFixture(groups, sources);
    Object.assign(closed.row, { connectionStatus: 'close', disconnectionObject: reason });
    const m = nativeMonitor(groups, sources, closed.subject);
    await m.setInstance({ instanceId: closed.subject.instanceId, instanceName: closed.subject.instance.name,
      integration: 'baileys', connectionStatus: 'close', ...groups.suspensionMetadata(closed.row) });
    await groups.recoverAdmission(closed.subject, Date.now() + 10000000);
    assert.equal(closed.sockets.length, 0);
  }
});

function fixture({ remote = jid, fromMe = false, attrs = {}, key = {}, message = { conversation: 'requestPlaceholder' } } = {}) {
  const node = { attrs: { from: remote, participant: sender, id: 'synthetic-group-id', t: '1790942400', ...attrs } };
  const received = { key: { remoteJid: remote, participant: node.attrs.participant, fromMe, id: node.attrs.id, ...key },
    messageTimestamp: Number(node.attrs.t), pushName: 'Synthetic', message };
  return { node, received };
}

function database() {
  const rows = [], controls = new Map();
  let failCreate = false;
  const controlStore = {
    async findUnique({ where }) { return structuredClone(controls.get(where.instanceId) || null); },
    async create({ data }) {
      if (controls.has(data.instanceId)) throw new Error('unique');
      const row = { revision: 0, catalogStale: true, catalog: [], catalogAt: null, ...structuredClone(data) };
      controls.set(data.instanceId, row); return structuredClone(row);
    },
    async updateMany({ where, data }) {
      const row = controls.get(where.instanceId);
      if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? row[key] + value.increment : structuredClone(value);
      return { count: 1 };
    },
  };
  const outbox = {
    async findUnique({ where }) {
      return structuredClone(rows.find(r => r.instanceId === where.instanceId_sourceKey.instanceId &&
        r.sourceKey === where.instanceId_sourceKey.sourceKey) || null);
    },
    async upsert({ where, create }) {
      if (failCreate) throw new Error('synthetic_db_down');
      const row = rows.find(r => r.instanceId === where.instanceId_sourceKey.instanceId && r.sourceKey === where.instanceId_sourceKey.sourceKey);
      if (row) return structuredClone(row);
      const next = { id: BigInt(rows.length + 1), createdAt: new Date(), attempts: 0, leaseUntil: null, leaseToken: null, ...structuredClone(create) };
      rows.push(next); return structuredClone(next);
    },
    async findFirst({ where }) { return structuredClone(rows.find(r => matches(r, where)) || null); },
    async updateMany({ where, data }) {
      const selected = rows.filter(r => matches(r, where));
      for (const row of selected) for (const [key, value] of Object.entries(data)) {
        row[key] = value?.increment ? row[key] + value.increment : structuredClone(value);
      }
      return { count: selected.length };
    },
  };
  const db = { nexiGroupControl: controlStore, nexiGroupEventOutbox: outbox,
    webhook: { async findUnique() { return { enabled: true, webhookByEvents: false, webhookBase64: false,
      url: 'https://nexi.example.test/webhooks/nexi/channels/evolution',
      headers: { 'X-Nexi-Chatwoot-Account-Id': '4', 'X-Nexi-Chatwoot-Inbox-Id': '13' } }; } },
    async $transaction(fn) {
      const savedRows = structuredClone(rows), savedControls = structuredClone([...controls]);
      try { return await fn(db); } catch (error) {
        rows.splice(0, rows.length, ...savedRows); controls.clear();
        for (const [key, value] of savedControls) controls.set(key, value);
        throw error;
      }
    },
  };
  return { db, rows, controls, failCreate: value => failCreate = value };
}

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(child => matches(row, child));
    if (key === 'AND') return value.every(child => matches(row, child));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, bound]) => row[key] != null &&
        ({ lte: row[key] <= bound, gt: row[key] > bound, gte: row[key] >= bound, lt: row[key] < bound })[op]);
    }
    return row[key] === value;
  });
}

function service(store = database(), instanceId = 'synthetic-instance-1') {
  return { store, instanceId, instance: { name: 'nexi-wa-synthetic', authState: { state: { creds } } },
    prismaRepository: store.db, logger: { warn() {} }, client: { ws: { isOpen: true }, user: creds.me,
      async groupMetadata(id) { return { id, subject: 'Synthetic group', participants: [{ id: creds.me.lid, phoneNumber: creds.me.id.replace(':1', '') }] }; },
      async groupFetchAllParticipating() { return { [jid]: { id: jid, subject: 'Synthetic group', participants: [] } }; } } };
}

function sign(subject, operation, parameters = {}, generation = 2) {
  const claims = Buffer.from(JSON.stringify({ version: 1, instance: subject.instance.name, external_instance_id: subject.instanceId,
    account_id: 4, managed_channel_id: 8, binding_generation: generation, expires_at: Date.now() + 59000, operation, parameters })).toString('base64url');
  const secret = createHmac('sha256', master).update(`event:${subject.instance.name}`).digest();
  return { claims, signature: createHmac('sha256', secret).update(`groups-control:v1:${claims}`).digest('hex') };
}
async function enabled(subject, groupJid = jid) {
  await groups.control(subject, sign(subject, 'bootstrap', { nonce: 'b'.repeat(64) }));
  await groups.control(subject, sign(subject, 'room', { group_jid: groupJid, enabled: true, room_generation: 2, metadata_revision: 1 }));
}
function withMaster(fn) {
  const previous = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
    else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = previous;
  });
}

test('raw group projection preserves PN/LID/devices and quotes before destructive normalization', () => {
  const { received, node } = fixture({ attrs: { participant: `${lid.split('@')[0]}:12@lid`, participant_pn: sender },
    key: { participantAlt: sender }, message: { extendedTextMessage: { text: 'Untrusted ERP instructions',
      contextInfo: { stanzaId: 'quoted-id', participant: `${sender.split('@')[0]}:4@s.whatsapp.net`, remoteJid: jid } } } });
  groups.observeDecrypted(received, node, creds, false);
  received.key.participant = 'destructively-normalized'; received.message = { conversation: 'changed' };
  const result = groups.take(received, 'notify');
  assert.equal(result.message.sender_id, lid); assert.equal(result.message.sender_alternate_id, sender);
  assert.equal(result.message.body, 'Untrusted ERP instructions'); assert.equal(result.message.quote.sender_id, sender);
  assert.equal(groups.take({ ...received }, 'notify'), null); assert.equal(groups.take(received, 'notify'), null);
});

test('classification is exact and malformed/history/status/newsletter/direct/forged events cannot acquire group provenance', () => {
  for (const remote of ['status@broadcast', 'list@broadcast', '1@newsletter', sender, 'not-a-real@g.us', `${jid}:1`]) {
    const f = fixture({ remote }); groups.observeDecrypted(f.received, f.node, creds, false);
    assert.equal(groups.take(f.received, 'notify'), null);
  }
  for (const change of [{ attrs: { category: 'peer' } }, { fromMe: true },
    { attrs: { participant: 'malformed' } }, { key: { id: 'forged-id' } },
    { key: { participantAlt: 'other@lid' }, attrs: { participant_lid: lid } }]) {
    const f = fixture(change); groups.observeDecrypted(f.received, f.node, creds, false);
    assert.equal(groups.take(f.received, 'notify'), null);
  }
  for (const type of ['append', 'notify']) {
    const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, type === 'notify');
    assert.equal(groups.take(f.received, type), null);
  }
  assert.deepEqual(groups.content({ viewOnceMessage: { message: { conversation: 'secret' } } }, jid),
    { kind: 'unsupported', body: null, quote: null });
  assert.equal(groups.content({ extendedTextMessage: { text: 'text', contextInfo: { stanzaId: 'id', remoteJid: otherJid, participant: sender } } }, jid).quote, null);
});

test('independent bootstrap atomically stores proof/outbox without a customer or direct message', () => withMaster(async () => {
  const s = service(); await groups.control(s, sign(s, 'bootstrap', { nonce: 'b'.repeat(64) }));
  assert.equal(s.store.controls.get(s.instanceId).sessionIdentity, session);
  assert.equal(s.store.rows[0].payload.event, 'group.session.proved');
  assert.equal(s.store.rows[0].payload.data.managed_channel_id, 8);
  s.store.failCreate(true);
  await assert.rejects(groups.control(s, sign(s, 'bootstrap', { nonce: 'c'.repeat(64) }, 3)), /db_down/);
  assert.equal(s.store.controls.get(s.instanceId).generation, 2, 'outbox failure rolls authority change back');
}));

test('control rejects forged signature, foreign instance/account, stale generations, replaced session and expired proof', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const forged = sign(s, 'catalog'); forged.signature = '0'.repeat(64);
  await assert.rejects(groups.control(s, forged), /control_rejected/);
  await assert.rejects(groups.control(s, sign(service(database(), 'foreign-instance'), 'catalog')), /control_rejected/);
  await assert.rejects(groups.control(s, sign(s, 'bootstrap', { nonce: 'c'.repeat(64) }, 1)), /control_rejected/);
  const claims = sign(s, 'catalog'); assert.throws(() => groups.controlClaims(s, claims, Date.now() + 60001), /control_rejected/);
  s.instance.authState.state.creds = { ...creds, registrationId: 2 };
  assert.equal(await groups.bindingFor(s), null);
  await assert.rejects(groups.control(s, sign(s, 'catalog')), /control_rejected/);
}));

test('ingress terminates before content-triggered resend, Chatwoot/chatbot/AI/transcription even on unavailable persistence', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const direct = fixture({ remote: sender }).received;
  const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false);
  let output = await groups.interceptEvents(s, { 'messages.upsert': { messages: [f.received, direct], type: 'notify' },
    'messaging-history.set': { messages: [f.received, direct], chats: [{ id: jid }, { id: sender }], contacts: [{ id: jid }] },
    'messages.update': [{ key: { remoteJid: jid } }, { key: { remoteJid: sender } }],
    'message-receipt.update': [{ key: { remoteJid: jid }, receipt: {} }], 'presence.update': { id: jid },
    'group-participants.update': { id: jid, action: 'add', participants: [{ id: lid, phoneNumber: sender }] } });
  assert.deepEqual(output['messages.upsert'].messages, [direct]);
  assert.deepEqual(output['messaging-history.set'].messages, [direct]);
  assert.equal(output['messages.update'].length, 1); assert.equal(output['group-participants.update'], undefined);
  assert.equal(output['presence.update'], undefined); assert.deepEqual(output['message-receipt.update'], []);
  const messageRows = s.store.rows.filter(r => r.payload.event === 'group.message.observed');
  assert.equal(messageRows.length, 1); assert.equal(messageRows[0].payload.data.message.body, 'requestPlaceholder');
  s.store.failCreate(true);
  const failed = fixture({ attrs: { id: 'another-id' } }); groups.observeDecrypted(failed.received, failed.node, creds, false);
  output = await groups.interceptEvents(s, { 'messages.upsert': { messages: [failed.received, direct], type: 'notify' } });
  assert.deepEqual(output['messages.upsert'].messages, [direct]);
  assert.equal(await groups.ingest(s, fixture().received, 'notify'), true, 'untrusted group never falls through');
}));

test('instance-scoped outbox keeps stable UUID/raw body across crash, retry and duplicate source', () => withMaster(async () => {
  const store = database(), s = service(store); await enabled(s);
  const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false); await groups.ingest(s, f.received, 'notify');
  const original = structuredClone(store.rows[2]);
  const replay = fixture(); groups.observeDecrypted(replay.received, replay.node, creds, false); await groups.ingest(s, replay.received, 'notify');
  assert.equal(store.rows.length, 3);
  for (const row of store.rows.slice(0, 2)) { row.state = 'delivered'; row.payload = {}; }
  const requests = [];
  await groups.drain(s, async (url, request) => { requests.push(request); throw new Error('lost HTTP response'); });
  assert.equal(store.rows[2].state, 'queued'); assert.equal(store.rows[2].eventId, original.eventId);
  store.rows[2].nextAttemptAt = new Date(0);
  await groups.drain(service(store), async (url, request) => { requests.push(request); return { ok: true, status: 200 }; });
  assert.equal(store.rows[2].state, 'delivered'); assert.deepEqual(store.rows[2].payload, {});
  assert.equal(requests[0].body, requests[1].body); assert.equal(requests[1].headers['X-Nexi-Event-Id'], original.eventId);
  const stamp = requests[1].headers['X-Nexi-Event-Timestamp'];
  const secret = createHmac('sha256', master).update(`event:${s.instance.name}`).digest();
  assert.equal(requests[1].headers['X-Nexi-Event-Signature'], 'sha256=' + createHmac('sha256', secret)
    .update(`${stamp}.${original.eventId}.${s.instance.name}.${s.instanceId}.${requests[1].body}`).digest('hex'));
  const foreign = service(store, 'foreign-instance');
  await groups.drain(foreign, async () => { throw new Error('must not dispatch another instance'); });
}));

test('lease recovery and concurrent workers only redeliver the same inbound event, and terminal rejection retains tombstones', () => withMaster(async () => {
  const s = service(); await enabled(s);
  s.store.rows[1].state = 'delivered'; s.store.rows[1].payload = {};
  const row = s.store.rows[0]; row.leaseUntil = new Date(Date.now() + 60000); row.leaseToken = 'old-worker';
  let calls = 0;
  await groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; }); assert.equal(calls, 0);
  row.leaseUntil = new Date(0);
  await Promise.all([groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; }),
    groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; })]);
  assert.equal(calls, 1); assert.equal(s.store.rows.length, 2);
  assert.equal(row.state, 'rejected'); assert.ok(row.fingerprint); assert.ok(row.sourceKey);
}));

test('catalog performs no photo fanout and uses persistent instance/session cache; rc13 participants never invent phones', () => withMaster(async () => {
  const s = service(); let catalogs = 0, metadata = 0;
  s.client.groupFetchAllParticipating = async () => { catalogs++; return { [jid]: { id: jid, subject: 'A', participants: [] },
    [otherJid]: { id: otherJid, isCommunityAnnounce: true, participants: [] } }; };
  s.client.groupMetadata = async () => { metadata++; throw new Error('not for discovery'); };
  s.client = groups.guardSocket(s.client, true);
  await groups.control(s, sign(s, 'bootstrap', { nonce: 'b'.repeat(64) }));
  const first = await groups.control(s, sign(s, 'catalog')), second = await groups.control(s, sign(s, 'catalog'));
  assert.equal(catalogs, 1); assert.equal(metadata, 0); assert.deepEqual(first.groups, second.groups); assert.equal(first.groups.length, 1);
  assert.deepEqual(groups.participants([{ id: lid, admin: 'admin' }]), [{ id: lid, alternate_id: null, admin: true, display_name: null }]);
  assert.equal(groups.participants([{ id: lid, phoneNumber: sender }])[0].alternate_id, sender);
  assert.throws(() => groups.participants([sender]), /participant_invalid/);
}));

test('local account removal stops ingress; stale room/snapshot controls cannot restore a disabled generation', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const f = fixture(); f.node.content = [{ tag: 'remove', content: [{ tag: 'participant', attrs: { jid: creds.me.lid } }] }];
  groups.observeNotification(f.received, f.node, creds); await groups.ingest(s, f.received, 'append');
  assert.equal(s.store.rows[2].payload.data.reason, 'local_left');
  assert.equal(s.store.controls.get(s.instanceId).rooms[jid].enabled, false);
  await groups.control(s, sign(s, 'room', { group_jid: jid, enabled: false, room_generation: 3, metadata_revision: 2 }));
  await assert.rejects(groups.control(s, sign(s, 'room', { group_jid: jid, enabled: true, room_generation: 2, metadata_revision: 1 })), /control_rejected/);
}));

test('managed generic outbound and native retry denial preserve ordinary direct and unmanaged group transport', () => {
  assert.throws(() => groups.denyOutbound(true, jid), /outbound_disabled_wave1/);
  groups.denyOutbound(true, sender); groups.denyOutbound(false, jid);
  assert.equal(groups.hasGroupTarget({ number: sender, text: '123456789012345678901234567890' }), false);
  assert.equal(groups.hasGroupTarget({ number: '120363000000000001' }), true);
  assert.equal(groups.hasGroupTarget({ readMessages: [{ remoteJid: jid }] }), true);
  assert.equal(groups.filterGeneric('ordinary', { key: { remoteJid: jid } }).key.remoteJid, jid);
  assert.equal(groups.filterGeneric('nexi-wa-synthetic', { key: { remoteJid: jid }, body: 'secret' }), null);
  assert.deepEqual(groups.filterGeneric('nexi-wa-synthetic', [jid, sender]), [sender]);
  const direct = { key: { remoteJid: sender }, binary: Buffer.from('synthetic'), timestamp: new Date(),
    message: { mediaKey: Buffer.alloc(32) } };
  assert.equal(groups.filterGeneric('nexi-wa-synthetic', direct), direct);
  assert.equal(groups.filterGeneric('nexi-wa-synthetic', [direct])[0], direct);
});

test('group call events cannot reach automatic call replies, while direct payload objects retain their identity', async () => {
  const s = service(), direct = { from: sender, status: 'offer', binary: Buffer.from('synthetic') };
  const result = await groups.interceptEvents(s, { call: [{ from: jid, status: 'offer' }, direct] });
  assert.deepEqual(result.call, [direct]); assert.equal(result.call[0], direct);
  assert.equal((await groups.interceptEvents(s, { call: [{ from: jid, status: 'offer' }] })).call, undefined);
});

test('raw protocol redactions retain target identity without edited text, and foreign group references cannot redact', () => {
  const baileysRoot = path.dirname(require.resolve('baileys/package.json', { paths: [__dirname, upstream] }));
  const { proto } = require(path.join(baileysRoot, 'WAProto/index.js'));
  const types = proto.Message.ProtocolMessage.Type;
  for (const type of [types.REVOKE, types.MESSAGE_EDIT]) {
    const f = fixture({ message: { protocolMessage: { type, key: { id: 'original-id', remoteJid: jid, participant: sender }, editedMessage: { conversation: 'secret' } } } });
    groups.observeDecrypted(f.received, f.node, creds, false, types);
    const projection = groups.take(f.received, 'notify');
    assert.equal(projection.event, 'group.message.redacted'); assert.equal(projection.target_message_id, 'original-id');
    assert.equal(projection.message, undefined); assert.equal(projection.body, undefined);
  }
  const f = fixture({ message: { protocolMessage: { type: types.REVOKE, key: { id: 'original-id', remoteJid: otherJid } } } });
  groups.observeDecrypted(f.received, f.node, creds, false, types);
  assert.equal(groups.take(f.received, 'notify'), null);
});

test('actual patched source compiles and places authority gates before content and all generic handlers', () => {
  for (const file of sourceFiles.filter(f => f.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(scratch, file)], { stdio: 'pipe' });
  }
  for (const file of sourceFiles.filter(f => f.endsWith('.ts'))) {
    const compiled = ts.transpileModule(sources[file], { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.deepEqual(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [], file);
  }
  const source = sources[baileysFile];
  assert.ok(source.indexOf('interceptEvents(this, events)') < source.indexOf("const payload = events['messaging-history.set']"));
  const loop = source.indexOf('for (const received of messages)');
  assert.ok(source.indexOf('groupLike(received?.key?.remoteJid)', loop) < source.indexOf("text == 'requestPlaceholder'", loop));
  assert.match(source, /groupMetadataCache.set\(nexiCacheKey/); assert.match(source, /sessionFingerprint\(this.instance.authState/);
  assert.doesNotMatch(source, /participants: string\[\]/); assert.doesNotMatch(source, /normalizePhoneNumber\(participantId\)/);
  const recv = sources[recvFile];
  assert.ok(recv.indexOf('await nexiGroups.admit') < recv.indexOf('await sendReceipt(msg.key.remoteJid'));
  assert.ok(recv.indexOf('nexiGroups.observeNotification') < recv.indexOf("upsertMessage(fullMsg, 'append')"));
  assert.match(recv, /config.nexiFinancialManaged && nexiGroups.groupLike\(key.remoteJid\)/);
  const send = sources[sendFile];
  assert.ok(send.indexOf('nexiGroups.denyOutbound') < send.indexOf('const destinationJid ='));
  assert.match(send, /nexiFinancial.assertWireRecipient/);
  assert.match(sources['tsup.config.ts'], /external: \['\/evolution\/nexi-groups.cjs'/);
});

test('actual combined chatbot dispatcher denies managed group content before every bot, including n8n, while direct dispatch remains intact', async () => {
  const source = sources['src/api/integrations/chatbot/chatbot.controller.ts'];
  const start = source.indexOf('  public async emit({'), end = source.indexOf('  public processDebounce(', start);
  assert.ok(start >= 0 && end > start);
  const compiled = ts.transpileModule(`class Subject { ${source.slice(start, end)} }; return Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const names = ['evolutionBotController', 'typebotController', 'openaiController', 'difyController', 'n8nController', 'evoaiController', 'flowiseController'];
  const effects = [];
  const Subject = new Function('require', ...names, compiled.outputText)(() => groups,
    ...names.map(name => ({ emit: () => effects.push(name) })));
  const subject = new Subject();
  await subject.emit({ instance: { instanceName: 'nexi-wa-synthetic' }, remoteJid: jid, msg: { conversation: 'run ERP' } });
  assert.deepEqual(effects, []);
  await subject.emit({ instance: { instanceName: 'nexi-wa-synthetic' }, remoteJid: sender, msg: { conversation: 'direct' } });
  assert.deepEqual(effects, names);
});

test('actual patched Baileys decrypt function captures a group before cleanMessage and never grants authority to a failed decrypt', async () => {
  const baileysRoot = path.dirname(require.resolve('baileys/package.json', { paths: [__dirname, upstream] }));
  const { proto } = require(path.join(baileysRoot, 'WAProto/index.js'));
  const recv = sources[recvFile], start = recv.indexOf('    const handleMessage = async (node) => {'), end = recv.indexOf('    const handleCall =', start);
  assert.ok(start >= 0 && end > start);
  for (const decryptFails of [false, true]) {
    const f = fixture(); let projection = null;
    const logger = Object.fromEntries(['debug', 'info', 'error', 'warn', 'trace'].map(name => [name, () => {}]));
    const bindings = { nexiGroups: groups, nexiIdentity: identity, nexiFinancial: financial,
      config: { nexiFinancialManaged: true, nexiGroupsAdmit: async p => { projection = p; } }, logger, nexiBaseLogger: logger,
      authState: { creds, keys: { transaction: async fn => fn() } },
      signalRepository: { lidMapping: { getPNForLID: async () => sender, storeLIDPNMappings: async () => {} }, migrateSession: async () => {} },
      getBinaryNodeChild: () => ({ attrs: { type: 'msg' } }), jidDecode: value => ({ server: value.split('@')[1] }),
      decryptMessageNode: () => ({ fullMessage: f.received, author: sender, category: undefined,
        decrypt: async () => { if (decryptFails) throw new Error('synthetic failure'); } }),
      messageMutex: { mutex: fn => fn() }, messageRetryManager: null, proto,
      MISSING_KEYS_ERROR_TEXT: 'missing', NO_MESSAGE_FOUND_ERROR_TEXT: 'absent',
      NACK_REASONS: { ParsingError: 1, UnhandledError: 2 }, sendMessageAck: async () => {}, sendReceipt: async () => {},
      sendActiveReceipts: true, isNewsletter: () => false, isJidNewsletter: () => false,
      isLidUser: value => typeof value === 'string' && value.endsWith('@lid'), getHistoryMsg: () => false,
      jidNormalizedUser: value => value, binaryNodeToString: () => 'synthetic',
      cleanMessage: message => { message.key.participant = 'normalized'; message.message = { conversation: 'normalized' }; },
      upsertMessage: async () => {},
    };
    const handle = new Function(...Object.keys(bindings), recv.slice(start, end) + 'return handleMessage;')(...Object.values(bindings));
    await handle(f.node);
    if (decryptFails) assert.equal(projection, null);
    else { assert.equal(projection.message.sender_id, sender); assert.equal(projection.message.body, 'requestPlaceholder'); }
  }
});

test('Prisma validates all provider schemas without connecting or generating a client', () => {
  const cli = path.join(path.dirname(require.resolve('prisma/package.json', { paths: [__dirname, upstream] })), 'build/index.js');
  for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
    const result = execFileSync(process.execPath, [cli, 'validate', '--schema', path.join(scratch, `prisma/${provider}-schema.prisma`)], {
      cwd: fs.existsSync(path.join(upstream, 'package.json')) ? upstream : __dirname,
      env: { ...process.env, DATABASE_PROVIDER: provider, DATABASE_CONNECTION_URI: provider === 'mysql'
        ? 'mysql://test:test@localhost:3306/test' : 'postgresql://test:test@localhost:5432/test' }, encoding: 'utf8', stdio: 'pipe' });
    assert.match(result, /is valid/);
  }
});

test('F1 actual Baileys derivation and contact sinks isolate Group participants but preserve direct PN/LID', async () => {
  const source = sources['node_modules/baileys/lib/Socket/chats.js'];
  const start = source.indexOf('    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {');
  const end = source.indexOf('        const historyMsg =', start);
  assert.ok(start >= 0 && end > start);
  const effects = [];
  const derive = new Function('nexiGroups', 'config', 'authState', 'jidNormalizedUser', 'ev',
    source.slice(start, end) + '\n}); return upsertMessage;')(groups, { nexiFinancialManaged: true }, { creds },
    value => value, { createBufferedFunction: fn => fn, emit: (name, data) => effects.push({ name, data }) });
  await derive(fixture().received, 'notify');
  assert.deepEqual(effects, [], 'no contact events, message events or credential pushname writes');
  const provider = sources[baileysFile];
  const a = provider.indexOf('  private readonly contactHandle = {'), b = provider.indexOf('  private readonly messageHandle =', a);
  const code = ts.transpileModule(`class Subject { ${provider.slice(a, b)} }; return Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const Subject = new Function('require', 'Events', code)(() => groups, { CONTACTS_UPDATE: 'contacts.update' });
  const target = new Subject();
  target.instance = { name: 'nexi-wa-synthetic' }; target.instanceId = 'synthetic';
  const sinkEffects = [];
  target.logger = { debug: () => sinkEffects.push('log') };
  target.profilePicture = async () => { sinkEffects.push('profile'); return {}; };
  target.sendDataWebhook = () => sinkEffects.push('event');
  target.configService = { get: () => ({ SAVE_DATA: { CONTACTS: true } }) };
  target.prismaRepository = { contact: { upsert: () => { sinkEffects.push('upsert'); return {}; } }, $transaction: async () => {} };
  const marked = groups.deriveContact(fixture().received, { id: sender, notify: 'Group participant' });
  await target.contactHandle['contacts.update']([marked]);
  assert.deepEqual(sinkEffects, []);
  for (const id of [sender, lid]) {
    await derive(fixture({ remote: id, attrs: { participant: undefined } }).received, 'notify');
    await target.contactHandle['contacts.update']([{ id, notify: 'Direct' }]);
  }
  assert.equal(effects.filter(e => e.name === 'contacts.update').length, 2);
  assert.equal(sinkEffects.filter(e => e === 'upsert').length, 2);
});

test('F2 actual receive path commits canonical data before Signal consumption/receipt; failures and replay remain safe', () => withMaster(async () => {
  const baileysRoot = path.dirname(require.resolve('baileys/package.json', { paths: [__dirname, upstream] }));
  const { proto } = require(path.join(baileysRoot, 'WAProto/index.js'));
  const { pathToFileURL } = require('node:url');
  const { addTransactionCapability } = await import(pathToFileURL(path.join(baileysRoot, 'lib/Utils/auth-utils.js')).href);
  const s = service(); await enabled(s);
  const timeline = [], logs = [];
  const logger = Object.fromEntries(['debug', 'info', 'error', 'warn', 'trace'].map(name => [name, (...args) => logs.push(args)]));
  let keysCommitted = 0, beforeFail = false, afterFail = false, suspended = 0;
  const keys = addTransactionCapability({ get: async () => ({}), set: async () => { keysCommitted++; timeline.push('keys'); } }, logger,
    { maxCommitRetries: 1, delayBetweenTriesMs: 0 });
  async function run(offline = false, direct = false) {
    const f = fixture({ remote: direct ? sender : jid, attrs: offline ? { offline: '1' } : {} });
    const bindings = { nexiGroups: groups, nexiIdentity: identity, nexiFinancial: financial,
      config: { nexiFinancialManaged: true, nexiGroupsSuspend: () => { suspended++; }, nexiGroupsAdmit: async p => {
        if (beforeFail) throw new Error('failure before canonical enqueue');
        await groups.admitProjection(s, p); timeline.push('canonical');
        if (afterFail) throw new Error('simulated process death after canonical commit');
      } }, logger, nexiBaseLogger: logger, authState: { creds, keys },
      signalRepository: { lidMapping: { getPNForLID: async () => sender, storeLIDPNMappings: async () => {} }, migrateSession: async () => {} },
      getBinaryNodeChild: () => ({ attrs: { type: 'msg' } }), jidDecode: value => ({ server: value.split('@')[1] }),
      decryptMessageNode: () => ({ fullMessage: f.received, author: sender, category: undefined,
        decrypt: async () => keys.transaction(async () => { timeline.push('decrypt'); await keys.set({ 'sender-key': { synthetic: 'new-ratchet' } }); }, jid) }),
      messageMutex: { mutex: fn => fn() }, messageRetryManager: null, proto,
      MISSING_KEYS_ERROR_TEXT: 'missing', NO_MESSAGE_FOUND_ERROR_TEXT: 'absent', NACK_REASONS: { UnhandledError: 2 },
      sendMessageAck: async () => timeline.push('ack'), sendReceipt: async () => timeline.push('receipt'), sendActiveReceipts: true,
      isJidNewsletter: () => false, isLidUser: () => false, getHistoryMsg: () => false, jidNormalizedUser: value => value,
      binaryNodeToString: () => 'RAW GROUP SECRET', cleanMessage: () => timeline.push('clean'), upsertMessage: async () => timeline.push('upsert') };
    const recv = sources[recvFile], a = recv.indexOf('    const handleMessage = async (node) => {'), b = recv.indexOf('    const handleCall =', a);
    const handle = new Function(...Object.keys(bindings), recv.slice(a, b) + 'return handleMessage;')(...Object.values(bindings));
    await handle(f.node);
  }
  s.store.failCreate(true); await run();
  assert.equal(keysCommitted, 0); assert.equal(s.store.rows.length, 2);
  assert.ok(!timeline.includes('receipt') && !timeline.includes('ack') && !timeline.includes('upsert'));
  s.store.failCreate(false); beforeFail = true; timeline.length = 0; await run();
  assert.equal(keysCommitted, 0); assert.equal(s.store.rows.length, 2); assert.ok(!timeline.includes('receipt'));
  beforeFail = false; afterFail = true; timeline.length = 0; await run();
  assert.equal(s.store.rows.length, 3); assert.equal(keysCommitted, 0); assert.ok(!timeline.includes('receipt'));
  const eventId = s.store.rows[2].eventId;
  afterFail = false; timeline.length = 0; await run(true);
  assert.equal(s.store.rows.length, 3); assert.equal(s.store.rows[2].eventId, eventId);
  assert.ok(timeline.indexOf('canonical') < timeline.indexOf('keys') && timeline.indexOf('keys') < timeline.indexOf('receipt'));
  timeline.length = 0; await run(); assert.equal(s.store.rows.length, 3);
  assert.ok(suspended > 0); assert.ok(!JSON.stringify(logs).includes('RAW GROUP SECRET'));
  timeline.length = 0; await run(false, true);
  assert.ok(timeline.includes('receipt')); assert.ok(!timeline.includes('canonical'), 'direct path is not subject to Groups admission');
}));

test('F3 canonical boundary covers arrays, normalized suffixes, multipart and socket controls', async () => {
  for (const field of ['chat', 'number', 'jid', 'remoteJid', 'numbers', 'participants', 'mentions']) {
    const value = ['numbers', 'participants', 'mentions'].includes(field) ? [jid] : jid;
    assert.throws(() => groups.validateTargets(true, { nested: { [field]: value } }), /outbound_disabled/);
    groups.validateTargets(false, { [field]: value });
  }
  assert.throws(() => groups.validateTargets(true, { number: '120363000000000001@unknown' }), /outbound_disabled/);
  assert.throws(() => groups.validateTargets(true, {}, jid), /outbound_disabled/);
  const calls = [];
  const socket = groups.guardSocket({ chatModify: (...args) => calls.push(args), sendMessage: (...args) => calls.push(args),
    groupMetadata: () => calls.push('metadata'), groupCreate: () => calls.push('create') }, true);
  assert.throws(() => socket.chatModify({ archive: true }, jid), /outbound_disabled/);
  assert.throws(() => socket.sendMessage(jid, { text: 'denied' }), /outbound_disabled/);
  socket.chatModify({ archive: true }, sender); socket.sendMessage(lid, { text: 'direct' }); assert.equal(calls.length, 2);
  assert.throws(() => socket.groupMetadata(jid), /outbound_disabled/);
  assert.throws(() => socket.groupCreate('Generic group', [sender]), /outbound_disabled/);
  const source = sources['src/api/abstract/abstract.router.ts'];
  const a = source.indexOf('  public async dataValidate<T>('), b = source.indexOf('  public async groupNoValidate', a);
  const code = ts.transpileModule(`class Subject { ${source.slice(a, b)} }; return Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const Subject = new Function('require', 'sanitizeUntrustedInput', 'validate', code)(() => groups, value => value, () => ({ valid: true }));
  let invoked = false;
  await assert.rejects(new Subject().dataValidate({ request: { params: { instanceName: 'nexi-wa-synthetic' },
    body: { number: jid }, query: {}, originalUrl: '/message/sendMedia/nexi-wa-synthetic' },
  ClassRef: class {}, execute: async () => { invoked = true; } }), /outbound_disabled/);
  assert.equal(invoked, false, 'parsed multipart field denied before operation executes');
});

test('F4 metadata completions discard invalidated catalog, replacement session and concurrent room disable', () => withMaster(async () => {
  for (const race of ['invalidation', 'session', 'instance', 'disable']) {
    const s = service(); await enabled(s);
    let release; const pending = new Promise(resolve => { release = resolve; });
    s.client.groupFetchAllParticipating = async () => pending;
    s.client.groupMetadata = async () => pending;
    const request = groups.control(s, sign(s, race === 'disable' ? 'room' : 'catalog', race === 'disable'
      ? { group_jid: jid, enabled: true, room_generation: 2, metadata_revision: 2 } : {}));
    await new Promise(resolve => setImmediate(resolve));
    if (race === 'session') s.instance.authState.state.creds = { ...creds, registrationId: 2 };
    else if (race === 'instance') s.instance.name = 'nexi-wa-replacement';
    else if (race === 'invalidation') await groups.interceptEvents(s, { 'groups.update': [{ id: jid }] });
    else await groups.control(s, sign(s, 'room', { group_jid: jid, enabled: false, room_generation: 3, metadata_revision: 3 }));
    release(race === 'disable' ? { id: jid, subject: 'STALE', participants: [{ id: creds.me.lid }] }
      : { [jid]: { id: jid, subject: 'STALE', participants: [] } });
    await assert.rejects(request, /superseded|control_rejected/);
    const row = s.store.controls.get(s.instanceId);
    assert.ok(!JSON.stringify(row.catalog).includes('STALE'));
    if (race === 'disable') assert.equal(row.rooms[jid].enabled, false);
  }
}));

test('F5 forged protocol target and unproved moderation cannot acquire a tombstone projection', () => {
  const types = { REVOKE: 0, MESSAGE_EDIT: 14 };
  for (const target of [{ id: 'original-id' }, { id: 'original-id', participant: lid },
    { id: 'original-id', remoteJid: otherJid, participant: sender }]) {
    const f = fixture({ message: { protocolMessage: { type: types.REVOKE, key: target } } });
    groups.observeDecrypted(f.received, f.node, creds, false, types);
    assert.equal(groups.take(f.received, 'notify'), null);
  }
  const own = fixture({ fromMe: true, attrs: { participant: creds.me.lid },
    message: { protocolMessage: { type: types.REVOKE, key: { id: 'own-id', fromMe: true } } } });
  groups.observeDecrypted(own.received, own.node, creds, false, types);
  assert.equal(groups.take(own.received, 'notify').actor_from_me, true);
});

test('F6 source conflicts remain closed within a session namespace; N4 replacements can reuse external IDs', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false);
  const projection = groups.take(f.received, 'notify');
  await groups.admitProjection(s, projection);
  await groups.admitProjection(s, { ...projection, message: { ...projection.message, display_name: 'Different display' } });
  assert.equal(s.store.rows.length, 3);
  await assert.rejects(groups.admitProjection(s, { ...projection, message: { ...projection.message, from_me: true } }), /source_conflict/);
  const binding = s.store.controls.get(s.instanceId);
  const replaced = { ...binding, generation: binding.generation + 1, sessionIdentity: 'c'.repeat(64) };
  await groups.enqueue(s, replaced, { ...projection, session_identity: replaced.sessionIdentity, room_generation: 2 },
    [projection.event, jid, projection.source_id]);
  assert.equal(s.store.rows.length, 4);
}));

function independentGroups() {
  const Module = require('node:module');
  const isolated = new Module(path.join(__dirname, 'nexi-groups.cjs'), module);
  isolated.filename = path.join(__dirname, 'nexi-groups.cjs'); isolated.paths = module.paths;
  isolated._compile(fs.readFileSync(isolated.filename, 'utf8'), isolated.filename);
  return isolated.exports;
}

test('N1 ownership, write-aware recovery, outage backoff, stale callbacks and persisted restart recovery', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const log = { warn() {}, error() {}, debug() {}, info() {}, trace() {} };
  let saved = { id: s.instanceId, connectionStatus: 'open', nexiGroupsSocketOwner: null }, reconnects = 0, probes = 0, failReads = false;
  const endings = [], configs = [];
  s.logger = log; s.stateConnection = { state: 'open' }; s.sendDataWebhook = () => {};
  s.prismaRepository.instance = { findUnique: async () => {
    if (failReads) throw new Error('storage unavailable');
    return structuredClone(saved);
  }, updateMany: async ({ where, data }) => {
    if (Object.entries(where).some(([key, value]) => saved[key] !== value)) return { count: 0 };
    Object.assign(saved, data); return { count: 1 }; } };
  const install = async subject => {
    const config = { auth: { creds }, logger: log }; configs.push(config);
    subject.client = await groups.installAdmissionSocket(subject, config, () => {
      const socket = { ws: { isOpen: true }, end: error => { endings.push(error); socket.ws.isOpen = false; },
        sendMessage: destination => destination };
      return socket;
    });
    return config;
  };
  s.connectToWhatsapp = async () => { assert.equal(await groups.beforeConnect(s), true); reconnects++; await install(s); };
  const originalTransaction = s.prismaRepository.$transaction;
  s.prismaRepository.$transaction = async callback => { probes++; return originalTransaction(callback); };
  const a = await install(s), f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false);
  const p = groups.take(f.received, 'notify');
  s.store.failCreate(true);
  await assert.rejects(a.nexiGroupsAdmit(p));
  const failure = Object.assign(new Error('safe'), { code: 'NEXI_GROUPS_ADMISSION_SUSPENDED' });
  a.nexiGroupsSuspend(failure);
  assert.equal(endings.length, 1); assert.equal(s.client.ws.isOpen, false);
  await groups.recordSuspension(s, failure, 'connection.update');
  assert.equal(saved.connectionStatus, 'connecting');
  const clock = Date.now() + 6000;
  await groups.recoverAdmission(s, clock);
  const count = probes;
  for (let i = 0; i < 100; i++) await groups.recoverAdmission(s, clock + i);
  assert.equal(probes, count, 'backoff must prevent busy health polling'); assert.equal(reconnects, 0);
  s.store.failCreate(false);
  await groups.recoverAdmission(s, clock + 400000);
  assert.equal(reconnects, 1); assert.equal(s.client.ws.isOpen, true);
  assert.equal(s.client.sendMessage(sender), sender); assert.equal(s.client.sendMessage(lid), lid);
  await configs[1].nexiGroupsAdmit(p); await configs[1].nexiGroupsAdmit(p);
  assert.equal(s.store.rows.length, 3, 'rolled-back probes add no rows; canonical replay adds only one');
  a.nexiGroupsSuspend(Object.assign(new Error('late'), { code: failure.code }));
  assert.equal(endings.length, 1, 'A cannot end B');
  await assert.rejects(a.nexiGroupsAdmit(p));
  await groups.recordSuspension(s, failure, 'connection.update');
  assert.equal(s.client.ws.isOpen, true);
  // A suspension write selected before replacement must revalidate DB ownership
  // when it finally executes, rather than overwrite the new socket's status.
  const bFailure = Object.assign(new Error('B failed'), { code: failure.code });
  configs[1].nexiGroupsSuspend(bFailure);
  const update = s.prismaRepository.instance.updateMany;
  let releaseWrite;
  const waitForWrite = new Promise(resolve => { releaseWrite = resolve; });
  s.prismaRepository.instance.updateMany = async args => {
    if (args.data.connectionStatus) await waitForWrite;
    return update(args);
  };
  const lateWrite = groups.recordSuspension(s, bFailure, 'connection.update');
  await install(s); saved.connectionStatus = 'open';
  releaseWrite(); await lateWrite;
  assert.equal(saved.connectionStatus, 'open', 'B cannot write a suspension onto C');
  assert.equal(s.client.ws.isOpen, true);
  s.prismaRepository.instance.updateMany = update;
  // An uncertain registration response can commit its owner token before the
  // caller sees a DB error. Recovery accepts only its own proposed token.
  const cFailure = Object.assign(new Error('C failed'), { code: failure.code });
  configs[2].nexiGroupsSuspend(cFailure);
  let uncertain = true;
  s.prismaRepository.instance.updateMany = async args => {
    const result = await update(args);
    if (uncertain && args.data.nexiGroupsSocketOwner) { uncertain = false; throw new Error('response lost after commit'); }
    return result;
  };
  const beforeUncertain = reconnects;
  await groups.recoverAdmission(s, clock + 1000000);
  assert.equal(reconnects, beforeUncertain + 1); assert.equal(s.client.ws.isOpen, false);
  await groups.recoverAdmission(s, clock + 1000001);
  assert.equal(reconnects, beforeUncertain + 1, 'registration failure retains bounded backoff');
  await groups.recoverAdmission(s, clock + 1400000);
  assert.equal(reconnects, beforeUncertain + 2); assert.equal(s.client.ws.isOpen, true);
  s.prismaRepository.instance.updateMany = update;
  // First-correction close and new connecting reasons both resume after restart.
  for (const status of ['close', 'connecting']) {
    saved = { id: s.instanceId, connectionStatus: status, nexiGroupsSocketOwner: null,
      disconnectionObject: 'nexi_groups_admission_suspended' };
    const restarted = { ...s, client: undefined, stateConnection: { state: 'close' } };
    restarted.connectToWhatsapp = async () => {
      if (!await groups.beforeConnect(restarted)) return;
      reconnects++; await install(restarted);
    };
    restarted.setInstance = () => {};
    const monitorCode = sources['src/api/services/monitor.service.ts'];
    const start = monitorCode.indexOf('  private async setInstance('), end = monitorCode.indexOf('  private async loadInstancesFromRedis', start);
    const Monitor = new Function('require', 'channelController', 'Integration', ts.transpileModule(
      `class Subject { ${monitorCode.slice(start, end)} }; return Subject;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
    (() => groups, { init: () => restarted }, { WHATSAPP_BAILEYS: 'baileys', EVOLUTION: 'evo', EVOHUB: 'hub' });
    const monitor = new Monitor(); monitor.waInstances = {}; monitor.logger = { info() {} };
    s.store.failCreate(true); failReads = true;
    await monitor.setInstance({ instanceName: restarted.instance.name, integration: 'baileys', connectionStatus: status,
      ...groups.suspensionMetadata(saved) });
    assert.equal(monitor.waInstances[restarted.instance.name], restarted);
    assert.equal(restarted.client, undefined);
    const before = reconnects;
    s.store.failCreate(false); failReads = false; await groups.recoverAdmission(restarted, clock + 900000);
    assert.equal(reconnects, before + 1); assert.equal(restarted.client.ws.isOpen, true);
  }
  const provider = sources[baileysFile];
  assert.ok(provider.includes('beforeConnect(this)')); assert.ok(provider.includes('recordSuspension(this,'));
  assert.ok(sources['src/api/services/monitor.service.ts'].includes('restoreSuspension(instance,'));
  assert.ok(provider.includes('408'), 'ordinary disconnect branches remain');
}));

test('N1 constructor failure remains recoverable and stale health completion cannot reconnect a replacement', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const logger = { warn() {}, error() {}, info() {}, debug() {} };
  const row = { id: s.instanceId, nexiGroupsSocketOwner: null, connectionStatus: 'open' };
  s.logger = logger; s.stateConnection = { state: 'open' }; s.sendDataWebhook = () => {};
  s.prismaRepository.instance = {
    findUnique: async () => structuredClone(row),
    updateMany: async ({ where, data }) => {
      if (Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    }
  };
  let endings = 0, reconnects = 0;
  const socket = () => ({ ws: { isOpen: true }, end() { endings++; this.ws.isOpen = false; } });
  const config = () => ({ auth: { creds }, logger });
  s.client = await groups.installAdmissionSocket(s, config(), socket);
  await assert.rejects(groups.installAdmissionSocket(s, config(), () => { throw new Error('constructor failed'); }), /suspended/);
  assert.equal(endings, 1); assert.equal(row.connectionStatus, 'connecting');
  s.connectToWhatsapp = async () => {
    assert.equal(await groups.beforeConnect(s), true); reconnects++;
    s.client = await groups.installAdmissionSocket(s, config(), socket);
  };
  await groups.recoverAdmission(s, Date.now() + 400000);
  assert.equal(reconnects, 1); assert.equal(s.client.ws.isOpen, true);
  const ownedConfig = config(); s.client = await groups.installAdmissionSocket(s, ownedConfig, socket);
  ownedConfig.nexiGroupsSuspend(Object.assign(new Error('failed'), { code: 'NEXI_GROUPS_ADMISSION_SUSPENDED' }));
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const original = s.prismaRepository.$transaction;
  s.prismaRepository.$transaction = async callback => { await paused; return original(callback); };
  const stale = groups.recoverAdmission(s, Date.now() + 400000);
  await new Promise(resolve => setImmediate(resolve));
  s.client = await groups.installAdmissionSocket(s, config(), socket);
  release(); await stale;
  assert.equal(reconnects, 1, 'old health completion cannot reconnect the current generation');
  assert.equal(s.client.ws.isOpen, true);
}));

test('N2 realistic direct IDs and financial text never become destinations; actual bot and Chatwoot dispatch gates', async () => {
  const ids = ['0123456789ABCDEF0123456789ABCDEF', '123456789012345678901234567890',
    'ABCDEF0123456789ABCDEF0123456789', '7f20eaf4-e822-447d-87dd-2d33b44d1a3f'];
  const text = 'PIX 00020126580014br.gov.bcb.pix; boleto 123456789012345678901234567890; copyCode 120363000000000001';
  for (const remote of [sender, lid]) for (const id of ids) {
    const messageRaw = { key: { remoteJid: remote, id, participant: lid, fromMe: false },
      message: { conversation: text }, source_id: id, external_message_id: id };
    assert.equal(groups.hasGroupTarget({ messageRaw, copyCode: text }), false);
    groups.validateTargets(true, { messageRaw });
    const effects = [];
    const socket = groups.guardSocket({ readMessages: keys => effects.push(keys),
      sendReceipt: (destination, _participant, keys) => effects.push(keys),
      sendMessage: (destination, content) => effects.push(content), relayMessage: (destination, content) => effects.push(content) }, true);
    socket.readMessages([messageRaw.key]); socket.sendReceipt(remote, lid, [id]);
    socket.sendMessage(remote, { delete: messageRaw.key, text }); socket.relayMessage(remote, { conversation: text });
    assert.equal(effects.length, 4);
  }
  for (const value of [{ number: jid }, { numbers: [jid] }, { chat: jid }, { nested: { target: { jid } } },
    { chatJid: jid }, { chat: { id: jid } }, { recipient: jid }, { remoteJid: jid },
    { number: '120363000000000001@unknown' }]) assert.throws(() => groups.validateTargets(true, value), /outbound_disabled/);
  groups.validateTargets(false, { number: jid });
  const code = sources['src/api/integrations/chatbot/chatbot.controller.ts'];
  const a = code.indexOf('  public async emit({'), b = code.indexOf('  public processDebounce(', a);
  const names = ['evolutionBotController', 'typebotController', 'openaiController', 'difyController', 'n8nController', 'evoaiController', 'flowiseController'];
  const effects = [];
  const make = helper => new (new Function('require', ...names, ts.transpileModule(
    `class Subject { ${code.slice(a, b)} }; return Subject;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
  (() => helper, ...names.map(name => ({ emit: () => effects.push(name) }))))();
  for (const remoteJid of [sender, lid]) for (const id of ids) {
    effects.length = 0;
    await make(groups).emit({ instance: { instanceName: 'nexi-wa-synthetic' }, remoteJid,
      msg: { messageRaw: { key: { remoteJid, id, participant: lid }, message: { conversation: text } } } });
    assert.deepEqual(effects, names);
  }
  effects.length = 0;
  await make(groups).emit({ instance: { instanceName: 'nexi-wa-synthetic' }, remoteJid: jid,
    msg: { messageRaw: { key: { remoteJid: jid, id: ids[0] } } } }); assert.deepEqual(effects, []);
  const cw = sources['src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts'];
  const start = cw.indexOf('  public async receiveWebhook('), end = cw.indexOf('      const client = await this.clientCw(instance);', start);
  assert.ok(end > start);
  const prefix = ts.transpileModule(`class Subject { ${cw.slice(start, end)} return 'direct'; } catch(error) { throw error; } } }; return Subject;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const CW = new Function('require', prefix)(() => groups), subject = new CW();
  subject.provider = {}; subject.cache = { delete() {} }; subject.logger = { log() {}, info() {}, warn() {} };
  for (const destination of [sender, lid, jid]) {
    const body = { id: ids[1], source_id: ids[0], event: 'message_created', content: text,
      conversation: { id: ids[1], meta: { sender: { identifier: destination } } } };
    if (destination === jid) await assert.rejects(subject.receiveWebhook({ instanceName: 'nexi-wa-synthetic' }, body), /outbound_disabled/);
    else assert.equal(await subject.receiveWebhook({ instanceName: 'nexi-wa-synthetic' }, body), 'direct');
  }
});

test('N3 raw notifications invalidate fresh catalog without an enabled room and supersede in-flight fetch/session', () => withMaster(async () => {
  const s = service(); await groups.control(s, sign(s, 'bootstrap', { nonce: 'b'.repeat(64) }));
  s.client.groupFetchAllParticipating = async () => ({ [jid]: { id: jid, subject: 'OLD', participants: [] } });
  await groups.control(s, sign(s, 'catalog'));
  const notification = { attrs: { from: jid, id: 'raw-membership', t: '1790942400' }, content: [] };
  const carrier = {}; groups.observeNotification(carrier, notification, creds);
  await groups.admitProjection(s, groups.take(carrier, 'append'));
  assert.equal(s.store.controls.get(s.instanceId).catalogStale, true);
  assert.equal(s.store.rows.length, 1, 'no room event for an unenabled room');
  let fetches = 0;
  s.client.groupFetchAllParticipating = async () => { fetches++; return { [jid]: { id: jid, subject: 'NEW', participants: [] } }; };
  assert.equal((await groups.control(s, sign(s, 'catalog'))).groups[0].name, 'NEW'); assert.equal(fetches, 1);
  const recv = sources[recvFile], start = recv.indexOf('    const handleNotification = async (node) => {');
  const marker = 'return; // no generic notification derivation or fallback ACK\n        }';
  const end = recv.indexOf(marker, start) + marker.length;
  let acknowledgements = 0;
  const log = { warn() {}, error() {}, debug() {} };
  const notify = new Function('nexiGroups', 'config', 'nexiBaseLogger', 'authState', 'sendMessageAck',
    recv.slice(start, end) + '\n};return handleNotification;')(groups,
    { nexiFinancialManaged: true, nexiGroupsAdmit: projection => groups.admitProjection(s, projection),
      nexiGroupsInvalidate: () => groups.invalidateCatalog(s) }, log, { creds }, () => { acknowledgements++; });
  for (const race of ['notification', 'unprojectable', 'session']) {
    s.store.controls.get(s.instanceId).catalogStale = true;
    let release; s.client.groupFetchAllParticipating = () => new Promise(resolve => { release = resolve; });
    const running = groups.control(s, sign(s, 'catalog')); await new Promise(resolve => setImmediate(resolve));
    if (race === 'notification') {
      const raw = {}; groups.observeNotification(raw, notification, creds);
      await groups.admitProjection(s, groups.take(raw, 'append'));
    } else if (race === 'unprojectable') {
      await notify({ tag: 'notification', attrs: { from: 'g.us', xmlns: 'w:g2' }, content: [] });
      assert.equal(acknowledgements, 1);
      assert.equal(s.store.rows.length, 1, 'discovery invalidation without fabricated APP event');
    } else s.instance.authState.state.creds = { ...creds, registrationId: 99 };
    release({ [jid]: { id: jid, subject: 'STALE', participants: [] } });
    await assert.rejects(running, /superseded/);
    assert.equal(s.store.controls.get(s.instanceId).catalog[0].name, 'NEW');
  }
}));

test('N4 trusted replacement namespace, same-session conflict, room separation and legacy terminal tombstone migration', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false);
  const a = groups.take(f.received, 'notify'); await groups.admitProjection(s, a);
  const original = structuredClone(s.store.rows.at(-1));
  const key = createHash('sha256').update(JSON.stringify([a.event, jid, a.source_id])).digest('hex');
  s.store.rows.at(-1).sourceKey = key; // migrated first-correction logical key
  s.store.rows.at(-1).payload = {}; s.store.rows.at(-1).state = 'delivered';
  await groups.admitProjection(s, a);
  assert.equal(s.store.rows.at(-1).eventId, original.eventId, 'legacy valid replay retains UUID');
  await assert.rejects(groups.admitProjection(s, { ...a, message: { ...a.message, body: 'legacy conflict' } }), /source_conflict/);
  const replacement = { ...creds, registrationId: 91 }, newSession = identity.sessionFingerprint(replacement);
  s.instance.authState.state.creds = replacement;
  let binding = s.store.controls.get(s.instanceId); binding.sessionIdentity = newSession; binding.generation++;
  // Relabeling only the binding epoch cannot confer current cryptographic session proof.
  await assert.rejects(groups.admitProjection(s, a), /suspended/);
  const b = { ...a, session_identity: newSession };
  await groups.admitProjection(s, b); await groups.admitProjection(s, b);
  assert.equal(s.store.rows.length, 4); assert.notEqual(s.store.rows.at(-1).eventId, original.eventId);
  for (const message of [{ ...b.message, body: 'conflicting' }, { ...b.message, sender_id: '99999999999999@lid' },
    { ...b.message, from_me: true }]) await assert.rejects(groups.admitProjection(s, { ...b, message }), /source_conflict/);
  binding = s.store.controls.get(s.instanceId);
  binding.rooms[otherJid] = { ...binding.rooms[jid] };
  await groups.admitProjection(s, { ...b, group_jid: otherJid }); assert.equal(s.store.rows.length, 5);
  // Simulate an old payload-cleared row after the additive migration. The
  // original UUID/fingerprint/source key survive. A new epoch is permitted.
  const opaque = s.store.rows.find(row => row.sourceKey === key);
  Object.assign(opaque, { sourceSession: null, sourceGeneration: null, legacyGeneration: binding.generation });
  await assert.rejects(groups.enqueue(s, binding, { ...b, room_generation: 2 }, [a.event, jid, a.source_id]), /source_conflict/);
  binding.generation++;
  const admitted = await groups.enqueue(s, binding, { ...b, room_generation: 2 }, [a.event, jid, a.source_id]);
  assert.notEqual(admitted.eventId, original.eventId);
}));

test('N5 actual online/offline processors cover shared Signal identity, key transaction and failed-decrypt logs', async () => {
  const root = path.dirname(require.resolve('baileys/package.json', { paths: [__dirname, upstream] }));
  const { makeOfflineNodeProcessor } = require(path.join(root, 'lib/Utils/offline-node-processor.js'));
  const { makeLibSignalRepository } = require(path.join(root, 'lib/Signal/libsignal.js'));
  const { addTransactionCapability } = require(path.join(root, 'lib/Utils/auth-utils.js'));
  const { PreKeyWhisperMessage } = require(require.resolve('libsignal/src/protobufs.js', { paths: [__dirname, upstream] }));
  const ciphertext = Buffer.concat([Buffer.from([0x33]), Buffer.from(PreKeyWhisperMessage.encode({
    identityKey: Buffer.alloc(33, 7), baseKey: Buffer.alloc(33, 8), registrationId: 1 }).finish())]);
  async function run(source, helper, offline, from) {
    const output = [];
    const rawLogger = Object.fromEntries(['info', 'error', 'debug', 'trace', 'warn'].map(level =>
      [level, (...args) => output.push({ level, args })]));
    rawLogger.child = bindings => { output.push({ bindings }); return rawLogger; };
    const logger = helper.privacyLogger(rawLogger, true);
    const keys = addTransactionCapability({ get: async () => ({}), set: async () => {} }, logger,
      { maxCommitRetries: 0, delayBetweenTriesMs: 0 });
    const signal = makeLibSignalRepository({ creds, keys }, logger);
    let done; const completion = new Promise(resolve => { done = resolve; });
    const onUnexpectedError = (err, where) => { logger.error({ err, where }, err.message); done(); };
    const handler = async () => {
      logger.child({ participant: sender, session: 'raw-private-identity' }).info({ lid }, 'child signal');
      await signal.decryptMessage({ jid: from === jid ? sender : from, type: 'pkmsg', ciphertext })
        .catch(err => logger.error({ err }, 'failed decrypt'));
      await keys.transaction(async () => { throw new Error(`key-store ${sender} ${lid} private body`); }, sender);
    };
    const node = { attrs: { from, ...(offline ? { offline: '1' } : {}) } };
    if (offline) {
      const a = source.indexOf('    const offlineNodeProcessor ='), b = source.indexOf('    const processNode =', a);
      const processor = new Function('makeOfflineNodeProcessor', 'nexiGroups', 'config', 'ws', 'logger', 'onUnexpectedError',
        'handleMessage', 'handleCall', 'handleReceipt', 'handleNotification', source.slice(a, b) + '\nreturn offlineNodeProcessor;')
      (makeOfflineNodeProcessor, helper, { nexiFinancialManaged: true }, { isOpen: true }, logger, onUnexpectedError,
        handler, handler, handler, handler);
      processor.enqueue('message', node); await completion;
    } else {
      const a = source.indexOf('    const processNodeWithBuffer ='), b = source.indexOf('    const offlineNodeProcessor =', a);
      const process = new Function('ev', 'nexiGroups', 'config', 'onUnexpectedError',
        source.slice(a, b) + '\nreturn processNodeWithBuffer;')
      ({ buffer() {}, flush() {} }, helper, { nexiFinancialManaged: true }, onUnexpectedError);
      await process(node, 'message', handler);
    }
    return output;
  }
  for (const offline of [false, true]) {
    const output = await run(sources[recvFile], groups, offline, jid);
    const encoded = JSON.stringify(output);
    for (const privateValue of [sender, lid, jid, 'private body', 'raw-private-identity']) assert.ok(!encoded.includes(privateValue));
    assert.ok(output.some(row => row.level === 'info'), 'actual Signal identity change executes');
    assert.ok(output.some(row => row.level === 'error'), 'actual key transaction/receive errors execute');
    for (const direct of [sender, lid]) {
      const directOutput = JSON.stringify(await run(sources[recvFile], groups, offline, direct));
      assert.ok(directOutput.includes(direct), 'direct Signal diagnostics preserved');
    }
  }
  if (deltaSources) {
    const original = JSON.stringify(await run(deltaSources[recvFile], deltaGroups, true, jid));
    assert.ok(original.includes(sender), 'original offline shared Signal leak reproduced');
  }
});

test('N5 pinned Signal console diagnostics share Group/ambiguous privacy scope and retain direct diagnostics', async () => {
  const Module = require('node:module');
  const file = 'node_modules/libsignal/src/session_record.js';
  const load = (source, filename = file) => {
    const nativeFile = require.resolve(`libsignal/src/${path.basename(filename)}`, { paths: [__dirname, upstream] });
    const isolated = new Module(nativeFile, module);
    isolated.filename = nativeFile; isolated.paths = module.paths;
    const nativeRequire = isolated.require.bind(isolated);
    isolated.require = name => name === '/evolution/nexi-groups.cjs' ? groups : nativeRequire(name);
    isolated._compile(source, isolated.filename); return isolated.exports;
  };
  const Record = load(sources[file]), originalRecord = load(deltaSources?.[file] ||
    fs.readFileSync(path.join(scratch, '.groups-upstream', file), 'utf8'));
  const saved = { info: console.info, warn: console.warn, error: console.error }, output = [];
  const packetLogs = [], logger = groups.privacyLogger({ debug: (...args) => packetLogs.push(args) }, true);
  try {
    for (const level of Object.keys(saved)) console[level] = (...args) => output.push(args);
    const exercise = Subject => {
      const record = new Subject();
      const entry = { indexInfo: { closed: -1 }, pn: sender, lid, secretRatchet: 'private key material' };
      record.closeSession(entry); record.closeSession(entry); record.openSession(entry);
    };
    await groups.withPacketScope({ tag: 'message', attrs: { from: jid, offline: '1' } }, true, () => exercise(originalRecord));
    assert.ok(JSON.stringify(output).includes('private key material'), 'original Signal console leak reproduced');
    output.length = 0;
    for (const node of [{ tag: 'message', attrs: { from: jid } },
      { tag: 'message', attrs: { from: jid, offline: '1' } },
      { tag: 'iq', attrs: { from: 'g.us', xmlns: 'w:g2' } },
      { tag: 'message', attrs: { offline: '1' } }]) {
      await groups.withPacketScope(node, true, () => exercise(Record));
    }
    assert.equal(output.length, 12);
    assert.ok(output.every(args => args.length === 1 && args[0] === 'nexi_groups_signal_filtered'));
    for (const from of [sender, lid]) {
      output.length = 0;
      await groups.withPacketScope({ tag: 'message', attrs: { from, offline: '1' } }, true, () => exercise(Record));
      assert.ok(JSON.stringify(output).includes(sender), 'direct console diagnostics remain unchanged');
      logger.debug({ xml: `<message from="${from}">direct diagnostic</message>` });
      assert.ok(JSON.stringify(packetLogs.at(-1)).includes(from));
    }
    logger.debug({ xml: `<message offline="1">${sender} private body</message>` });
    logger.debug({ xml: `<iq from="g.us" xmlns="w:g2">${lid}</iq>` });
    assert.deepEqual(packetLogs.slice(-2), [['nexi_groups_packet_filtered'], ['nexi_groups_packet_filtered']]);
    for (const file of sourceFiles.filter(file => file.startsWith('node_modules/libsignal/'))) {
      assert.doesNotMatch(sources[file], /^\s*console\.(info|warn|error)\(/m);
      assert.match(sources[file], /signalDiagnostic/);
    }
    const queueFile = 'node_modules/libsignal/src/queue_job.js';
    const queue = load(sources[queueFile], queueFile);
    for (const firstGroup of [true, false]) {
      output.length = 0;
      let release;
      const paused = new Promise(resolve => { release = resolve; });
      const first = groups.withPacketScope({ tag: 'message', attrs: { from: firstGroup ? jid : sender } }, true,
        () => queue('shared-device', async () => { await paused; groups.signalDiagnostic('info', sender, 'first'); }));
      const second = groups.withPacketScope({ tag: 'message', attrs: { from: firstGroup ? sender : jid, offline: '1' } }, true,
        () => queue('shared-device', async () => { groups.signalDiagnostic('info', sender, 'second'); }));
      release(); await Promise.all([first, second]);
      assert.deepEqual(output, firstGroup ? [['nexi_groups_signal_filtered'], [sender, 'second']]
        : [[sender, 'first'], ['nexi_groups_signal_filtered']], 'each queued operation must retain its own packet scope');
    }
  } finally { Object.assign(console, saved); }
});

test('delta self-review reproduces original N1/N2/N3/N4 source defects without live transport', () => withMaster(async () => {
  if (!deltaGroups) return;
  const prior = deltaGroups;
  const direct = { messageRaw: { key: { remoteJid: sender, id: '0123456789ABCDEF0123456789ABCDEF' } } };
  assert.equal(prior.hasGroupTarget(direct), true); assert.equal(groups.hasGroupTarget(direct), false);
  const callback = deltaSources[baileysFile].match(/nexiGroupsSuspend = (error => this.client\?\.end\(error\));/)[1];
  const ended = [], oldService = { client: { end: () => ended.push('A') } };
  const suspend = new Function(`return ${callback};`).call(oldService);
  oldService.client = { end: () => ended.push('B') }; suspend(new Error('old A callback'));
  assert.deepEqual(ended, ['B']);
  const s = service(); await prior.control(s, sign(s, 'bootstrap', { nonce: 'b'.repeat(64) }));
  await prior.control(s, sign(s, 'catalog'));
  const binding = s.store.controls.get(s.instanceId), revision = binding.revision;
  await prior.admitProjection(s, { event: 'group.metadata.invalidated', session_identity: session,
    group_jid: jid, source_id: 'raw-notification', occurred_at: 1790942400, reason: 'notification' });
  assert.equal(binding.revision, revision); assert.equal(binding.catalogStale, false);
  const f = fixture(); prior.observeDecrypted(f.received, f.node, creds, false);
  const p = prior.take(f.received, 'notify');
  await prior.enqueue(s, binding, { ...p, room_generation: 2 }, [p.event, jid, p.source_id]);
  await assert.rejects(prior.enqueue(s, { ...binding, generation: binding.generation + 1, sessionIdentity: 'c'.repeat(64) },
    { ...p, session_identity: 'c'.repeat(64), room_generation: 2 }, [p.event, jid, p.source_id]), /source_conflict/);
}));

test('F9 independent worker modules contend using DB predicates; stale claim/backoff, lease death and old ACK cannot win', () => withMaster(async () => {
  const s = service(); await enabled(s);
  s.store.rows[1].state = 'delivered'; s.store.rows[1].payload = {};
  const row = s.store.rows[0], workerA = independentGroups(), workerB = independentGroups();
  let release; const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const runningA = workerA.drain(service(s.store), async () => { calls++; return pending; });
  await new Promise(resolve => setImmediate(resolve));
  await workerB.drain(service(s.store), async () => { calls++; return { ok: true, status: 200 }; });
  assert.equal(calls, 1, 'separate helpers have no shared Set or process-local lock');
  row.leaseUntil = new Date(0); // worker A dies; B claims a new lease
  await workerB.drain(service(s.store), async () => { calls++; return { ok: false, status: 503 }; });
  const retryTime = +row.nextAttemptAt;
  release({ ok: true, status: 200 }); await runningA;
  assert.equal(row.state, 'queued'); assert.equal(+row.nextAttemptAt, retryTime, 'expired ACK cannot erase B retry');
  const originalFind = s.store.db.nexiGroupEventOutbox.findFirst;
  row.nextAttemptAt = new Date(0);
  s.store.db.nexiGroupEventOutbox.findFirst = async args => {
    const selected = await originalFind(args);
    if (selected) row.nextAttemptAt = new Date(Date.now() + 60000); // changes after SELECT
    return selected;
  };
  await workerB.drain(service(s.store), async () => { throw new Error('stale retry schedule must not dispatch'); }, 1);
  assert.equal(row.attempts, 2);
  s.store.db.nexiGroupEventOutbox.findFirst = originalFind;
  row.nextAttemptAt = new Date(0); row.attempts = groups.MAX_ATTEMPTS - 1;
  await workerB.drain(service(s.store), async () => ({ ok: false, status: 503 }));
  assert.equal(row.state, 'quarantined'); assert.deepEqual(row.payload, {}); assert.ok(row.sourceKey && row.fingerprint && row.eventId);
  row.state = 'queued'; row.attempts = 0; row.payload = { secret: 'expired' }; row.createdAt = new Date(Date.now() - groups.MAX_AGE_MS - 1);
  await workerB.drain(service(s.store), async () => { throw new Error('expired payload'); });
  assert.equal(row.state, 'quarantined'); assert.deepEqual(row.payload, {});
  const unloaded = { ...structuredClone(row), id: 99n, instanceId: 'unloaded-instance', state: 'queued', payload: { body: 'expired' } };
  s.store.rows.push(unloaded);
  await groups.expireOutbox(s.store.db.nexiGroupEventOutbox);
  assert.equal(unloaded.state, 'quarantined'); assert.deepEqual(unloaded.payload, {});
}));

test('F10 Group loggers filter packet, decrypt errors and participant data before logging while direct logs are unchanged', async () => {
  const output = [];
  const logger = { error: (...args) => output.push(args), debug: (...args) => output.push(args), warn: (...args) => output.push(args) };
  const protectedLogger = groups.packetLogger(logger, { attrs: { from: jid } }, true);
  protectedLogger.error({ error: new Error('body secret'), sender, lid }, 'raw group');
  const packet = groups.privacyLogger(logger, true);
  packet.debug({ xml: `<message from="${jid}">secret body ${sender}</message>` });
  packet.debug({ tag: 'call', attrs: { from: sender }, content: [{ attrs: { 'group-jid': jid, caller_pn: sender } }] });
  assert.deepEqual(output, Array(3).fill(['nexi_groups_packet_filtered']));
  assert.equal(groups.packetLogger(logger, { attrs: { from: sender } }, true), logger);
  packet.debug({ direct: 'operational' }); assert.deepEqual(output[3], [{ direct: 'operational' }]);
  await groups.withPacketScope({ attrs: { from: jid } }, true, () =>
    Promise.reject(new Error(`decrypt failure ${sender} private body`)).catch(error => packet.error(error.message)));
  assert.deepEqual(output[4], ['nexi_groups_packet_filtered']);
  assert.ok(sources[recvFile].includes('() => exec(node, false).catch(err => onUnexpectedError(err, identifier))'),
    'unexpected-error logging must execute inside the same privacy scope');
  const provider = sources[baileysFile];
  for (const event of ['CB:call', 'CB:ack,class:call']) {
    const a = provider.indexOf(`this.client.ws.on('${event}'`), b = provider.indexOf("console.log(", a);
    assert.ok(provider.indexOf('groupSource(packet)', a) < b);
  }
});

test('F11 provider migration parity rejects nonpositive generation, negative revisions/attempts and invalid states', () => {
  const sql = provider => fs.readFileSync(path.join(__dirname, `prisma/${provider}-migrations/20261002000001_harden_groups_wave1/migration.sql`), 'utf8')
    .replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(sql('mysql'), sql('postgresql'));
  for (const fragment of ['generation > 0', 'revision >= 0', 'attempts >= 0', "'quarantined'"]) assert.ok(sql('mysql').includes(fragment));
  const validControl = (generation, revision, state) => generation > 0 && revision >= 0 && ['active', 'revoked'].includes(state);
  for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
    assert.equal(validControl(0, 0, 'active'), false, provider); assert.equal(validControl(-1, 0, 'active'), false, provider);
    assert.equal(validControl(1, -1, 'active'), false, provider); assert.equal(validControl(1, 0, 'unknown'), false, provider);
  }
  const namespaceConstraint = provider => fs.readFileSync(path.join(__dirname,
    `prisma/${provider}-migrations/20261002000002_namespace_groups_source/migration.sql`), 'utf8')
    .split('ADD CONSTRAINT')[1].replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(namespaceConstraint('mysql'), namespaceConstraint('postgresql'));
  for (const fragment of ['sourceGeneration>0', 'legacyGeneration>0', 'LENGTH(sourceSession)=64',
    'sourceSession IS NULL AND sourceGeneration IS NULL']) assert.ok(namespaceConstraint('mysql').includes(fragment));
  assert.match(fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8'),
    /COPY --from=source-builder \/evolution\/node_modules\/libsignal \/evolution\/node_modules\/libsignal/);
});

test('strict self-review reproduces original F1/F2/F3/F4/F5/F6/F9/F10/F11 from the accepted commit', () => withMaster(async () => {
  if (!acceptedGroups) return; // current source-graph image has no overlay history
  const old = acceptedGroups;
  // F1: Group-origin participant event loses room provenance, survives filter.
  const source = acceptedSources['node_modules/baileys/lib/Socket/chats.js'];
  const a = source.indexOf('    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {');
  const b = source.indexOf('        const historyMsg =', a);
  const events = [];
  const derive = new Function('config', 'authState', 'jidNormalizedUser', 'ev', source.slice(a, b) + '\n});return upsertMessage;')(
    { nexiFinancialManaged: true }, { creds }, value => value,
    { createBufferedFunction: fn => fn, emit: (name, data) => events.push({ name, data }) });
  await derive(fixture().received, 'notify');
  const derived = events.find(e => e.name === 'contacts.update').data;
  assert.equal(old.filterGeneric('nexi-wa-synthetic', derived)[0].id, sender);
  // F2: accepted hook follows the irreversible receipt in actual pinned source.
  const receivedSource = acceptedSources[recvFile];
  assert.ok(receivedSource.indexOf('await sendReceipt(msg.key.remoteJid') < receivedSource.indexOf('nexiGroups.observeDecrypted'));
  assert.doesNotMatch(receivedSource, /keys.transaction[\s\S]*nexiGroups.admit/);
  const baileysRoot = path.dirname(require.resolve('baileys/package.json', { paths: [__dirname, upstream] }));
  const { proto } = require(path.join(baileysRoot, 'WAProto/index.js'));
  const packet = fixture(), order = [], logger = Object.fromEntries(['debug', 'info', 'error', 'warn', 'trace'].map(key => [key, () => {}]));
  const oldService = service(); await old.control(oldService, sign(oldService, 'bootstrap', { nonce: 'b'.repeat(64) }));
  await old.control(oldService, sign(oldService, 'room', { group_jid: jid, enabled: true, room_generation: 2, metadata_revision: 1 }));
  const bindings = { nexiGroups: old, nexiIdentity: identity, nexiFinancial: financial, config: { nexiFinancialManaged: true },
    logger, authState: { creds }, signalRepository: {}, getBinaryNodeChild: () => ({ attrs: { type: 'msg' } }),
    decryptMessageNode: () => ({ fullMessage: packet.received, author: sender, decrypt: async () => order.push('decrypt') }),
    messageMutex: { mutex: fn => fn() }, messageRetryManager: null, proto,
    MISSING_KEYS_ERROR_TEXT: 'missing', NO_MESSAGE_FOUND_ERROR_TEXT: 'absent', NACK_REASONS: { UnhandledError: 2 },
    sendMessageAck: async () => order.push('ack'), sendReceipt: async () => order.push('receipt'), sendActiveReceipts: true,
    isJidNewsletter: () => false, isLidUser: () => false, getHistoryMsg: () => false, jidNormalizedUser: value => value,
    binaryNodeToString: () => 'raw', cleanMessage: () => order.push('clean'), upsertMessage: async msg => {
      order.push('volatile'); await old.ingest(oldService, msg, 'notify'); order.push('canonical');
    } };
  const oldStart = receivedSource.indexOf('    const handleMessage = async (node) => {');
  const oldEnd = receivedSource.indexOf('    const handleCall =', oldStart);
  await new Function(...Object.keys(bindings), receivedSource.slice(oldStart, oldEnd) + 'return handleMessage;')(...Object.values(bindings))(packet.node);
  assert.ok(order.indexOf('receipt') < order.indexOf('canonical')); assert.equal(oldService.store.rows.length, 3);
  // F3: concrete target shapes from review bypass the old classifier.
  for (const value of [{ chat: jid }, { numbers: [jid] }, { number: '120363000000000001@unknown' }]) {
    assert.equal(old.hasGroupTarget(value), false); assert.equal(groups.hasGroupTarget(value), true);
  }
  // F4: completion erases an in-flight invalidation and claims fresh catalog.
  const s = service(); await old.control(s, sign(s, 'bootstrap', { nonce: 'b'.repeat(64) }));
  let release; const pending = new Promise(resolve => { release = resolve; });
  s.client.groupFetchAllParticipating = async () => pending;
  const request = old.control(s, sign(s, 'catalog'));
  await new Promise(resolve => setImmediate(resolve));
  s.store.controls.get(s.instanceId).catalogStale = true;
  release({ [jid]: { id: jid, subject: 'STALE', participants: [] } });
  assert.equal((await request).stale, false);
  // F5: target ID with no own-target key proof used to gain a redaction.
  const f = fixture({ message: { protocolMessage: { type: 0, key: { id: 'foreign-target' } } } });
  old.observeDecrypted(f.received, f.node, creds, false, { REVOKE: 0, MESSAGE_EDIT: 14 });
  assert.equal(old.take(f.received, 'notify').target_message_id, 'foreign-target');
  groups.observeDecrypted(f.received, f.node, creds, false, { REVOKE: 0, MESSAGE_EDIT: 14 });
  assert.equal(groups.take(f.received, 'notify'), null);
  // F6: same external identity under a new session used to create another row.
  const scoped = service(), binding = { accountId: '4', managedChannelId: '8', generation: 2 };
  const projection = { event: 'group.message.observed', group_jid: jid, session_identity: session,
    source_id: 'same-id', message: { external_message_id: 'same-id', from_me: false } };
  await old.enqueue(scoped, binding, projection, [projection.event, jid, 'same-id']);
  await old.enqueue(scoped, { ...binding, generation: 3 }, { ...projection, session_identity: 'c'.repeat(64) }, [projection.event, jid, 'same-id']);
  assert.equal(scoped.store.rows.length, 2);
  // F9: large attempt count has no terminal cap and retains canonical payload.
  const queue = service(); await old.control(queue, sign(queue, 'bootstrap', { nonce: 'b'.repeat(64) }));
  queue.store.rows[0].attempts = 100;
  await old.drain(queue, async () => ({ ok: false, status: 503 }));
  assert.equal(queue.store.rows[0].state, 'queued'); assert.ok(queue.store.rows[0].payload.data);
  // F10: raw call callback logs a Group-shaped packet before any gate.
  const provider = acceptedSources[baileysFile];
  const call = provider.indexOf("this.client.ws.on('CB:call'");
  const log = provider.indexOf("console.log('CB:call', packet)", call);
  assert.ok(log > call); assert.ok(!provider.slice(call, log).includes('groupSource'));
  for (const [version, implementation] of [[provider, old], [sources[baileysFile], groups]]) {
    const a = version.indexOf("    this.client.ws.on('CB:call', (packet) => {");
    const b = version.indexOf("    this.client.ws.on('CB:ack,class:call'", a);
    const effects = [], subject = { instance: { name: 'nexi-wa-synthetic' }, sendDataWebhook: () => effects.push('webhook'),
      client: { ws: { on: (_, callback) => callback({ attrs: { from: jid }, content: [{ attrs: { caller_pn: sender } }] }) } } };
    new Function('require', 'console', 'Events', `return function() { ${version.slice(a, b)} };`)(() => implementation,
      { log: () => effects.push('raw-log') }, { CALL: 'call' }).call(subject);
    assert.deepEqual(effects, implementation === old ? ['raw-log', 'webhook'] : []);
  }
  // F11: PostgreSQL had positive generation CHECK, MySQL did not.
  const migration = provider => execFileSync('git', ['show', `c04855465d9e93596f248a73e4e9f8a731053f84:prisma/${provider}-migrations/20261002000000_nexi_groups_wave1/migration.sql`],
    { cwd: __dirname, encoding: 'utf8' });
  assert.match(migration('postgresql'), /CHECK \("generation" > 0\)/);
  assert.doesNotMatch(migration('mysql'), /CHECK/);
}));
