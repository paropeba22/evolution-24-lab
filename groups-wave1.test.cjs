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
  'src/api/abstract/abstract.router.ts', 'node_modules/baileys/lib/Socket/chats.js', 'node_modules/baileys/lib/Socket/socket.js',
  'src/api/integrations/chatbot/chatbot.controller.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', recvFile, sendFile, 'tsup.config.ts',
  ...['postgresql', 'psql_bouncer', 'mysql'].map(provider => `prisma/${provider}-schema.prisma`)];
const master = 'synthetic-groups-secret-at-least-32-bytes';
const jid = '120363000000000001@g.us', otherJid = '120363000000000002@g.us';
const sender = '5511999999999@s.whatsapp.net', lid = '100000000000001@lid';
const creds = { me: { id: '5500000000000:1@s.whatsapp.net', lid: '200000000000001@lid' },
  registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
const session = identity.sessionFingerprint(creds);
let scratch, sources, ts, acceptedSources, acceptedGroups;

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
  }
  execFileSync(process.execPath, [path.join(__dirname, 'patch-groups-source.mjs'), scratch, '--snapshot']);
  sources = Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(scratch, file), 'utf8')]));
});
after(() => {
  assert.equal(path.dirname(scratch), os.tmpdir());
  assert.ok(path.basename(scratch).startsWith('nexi-groups-wave1-'));
  fs.rmSync(scratch, { recursive: true, force: true });
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

test('F6 source collisions reject incompatible session/direction while valid retransmission is idempotent', () => withMaster(async () => {
  const s = service(); await enabled(s);
  const f = fixture(); groups.observeDecrypted(f.received, f.node, creds, false);
  const projection = groups.take(f.received, 'notify');
  await groups.admitProjection(s, projection);
  await groups.admitProjection(s, { ...projection, message: { ...projection.message, display_name: 'Different display' } });
  assert.equal(s.store.rows.length, 3);
  await assert.rejects(groups.admitProjection(s, { ...projection, message: { ...projection.message, from_me: true } }), /source_conflict/);
  const binding = s.store.controls.get(s.instanceId);
  const replaced = { ...binding, generation: binding.generation + 1, sessionIdentity: 'c'.repeat(64) };
  await assert.rejects(groups.enqueue(s, replaced, { ...projection, session_identity: replaced.sessionIdentity, room_generation: 2 },
    [projection.event, jid, projection.source_id]), /source_conflict/);
  assert.equal(s.store.rows.length, 3);
}));

function independentGroups() {
  const Module = require('node:module');
  const isolated = new Module(path.join(__dirname, 'nexi-groups.cjs'), module);
  isolated.filename = path.join(__dirname, 'nexi-groups.cjs'); isolated.paths = module.paths;
  isolated._compile(fs.readFileSync(isolated.filename, 'utf8'), isolated.filename);
  return isolated.exports;
}

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
