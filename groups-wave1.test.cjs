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
  'src/api/integrations/chatbot/chatbot.controller.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', recvFile, sendFile, 'tsup.config.ts',
  ...['postgresql', 'psql_bouncer', 'mysql'].map(provider => `prisma/${provider}-schema.prisma`)];
const master = 'synthetic-groups-secret-at-least-32-bytes';
const jid = '120363000000000001@g.us', otherJid = '120363000000000002@g.us';
const sender = '5511999999999@s.whatsapp.net', lid = '100000000000001@lid';
const creds = { me: { id: '5500000000000:1@s.whatsapp.net', lid: '200000000000001@lid' },
  registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
const session = identity.sessionFingerprint(creds);
let scratch, sources, ts;

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
    async findUnique({ where }) { return controls.get(where.instanceId) || null; },
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
      const next = { id: BigInt(rows.length + 1), attempts: 0, leaseUntil: null, leaseToken: null, ...structuredClone(create) };
      rows.push(next); return structuredClone(next);
    },
    async findFirst({ where }) { return structuredClone(rows.find(r => r.instanceId === where.instanceId && r.state === where.state) || null); },
    async updateMany({ where, data }) {
      const row = rows.find(r => r.id === where.id);
      if (!row || (where.state && row.state !== where.state) || (where.leaseToken && row.leaseToken !== where.leaseToken) ||
          (where.OR && row.leaseUntil && row.leaseUntil > new Date())) return { count: 0 };
      for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? row[key] + value.increment : structuredClone(value);
      return { count: 1 };
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
  for (const change of [{ attrs: { offline: '1' } }, { attrs: { category: 'peer' } }, { fromMe: true },
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
  const row = s.store.rows[0]; row.leaseUntil = new Date(Date.now() + 60000); row.leaseToken = 'old-worker';
  let calls = 0;
  await groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; }); assert.equal(calls, 0);
  row.leaseUntil = new Date(0);
  await Promise.all([groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; }),
    groups.drain(s, async () => { calls++; return { ok: false, status: 401 }; })]);
  assert.equal(calls, 2); assert.equal(s.store.rows.length, 2);
  assert.equal(row.state, 'rejected'); assert.ok(row.fingerprint); assert.ok(row.sourceKey);
}));

test('catalog performs no photo fanout and uses persistent instance/session cache; rc13 participants never invent phones', () => withMaster(async () => {
  const s = service(); let catalogs = 0, metadata = 0;
  s.client.groupFetchAllParticipating = async () => { catalogs++; return { [jid]: { id: jid, subject: 'A', participants: [] },
    [otherJid]: { id: otherJid, isCommunityAnnounce: true, participants: [] } }; };
  s.client.groupMetadata = async () => { metadata++; throw new Error('not for discovery'); };
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
    const f = fixture({ message: { protocolMessage: { type, key: { id: 'original-id', remoteJid: jid }, editedMessage: { conversation: 'secret' } } } });
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
  assert.ok(recv.indexOf('nexiGroups.observeDecrypted') < recv.indexOf('cleanMessage(msg,'));
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
      config: { nexiFinancialManaged: true }, logger, authState: { creds },
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
      upsertMessage: async (message, type) => { projection = groups.take(message, type); },
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
