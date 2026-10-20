'use strict';
require('./attendance-test-network-trap.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHmac } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const groups = require('./nexi-groups.cjs');
const identity = require('./nexi-identity.cjs');
const attendance = require('./nexi-attendance.cjs');
const root = process.env.NEXI_INGRESS_SOURCE_ROOT || '/evolution';
const sourceRequire = createRequire(path.resolve(root, 'package.json'));
const ts = sourceRequire('typescript');
const source = fs.readFileSync(path.join(root, 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'), 'utf8');
const parsed = ts.createSourceFile('provider.ts', source, ts.ScriptTarget.Latest, true);
let handler, decoder;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === "'messages.upsert'") handler = node.initializer.getText(parsed);
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "require('/evolution/nexi-ingress.cjs').register") decoder = node.arguments[1].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(handler && decoder, 'run the actual composed handler and registered recovery decoder');

// Expose the lexical worker only inside the offline VM. No production testing
// export, timer, server or consumer is added. Security helpers stay unmodified.
function runtime() {
  const module = { exports: {} };
  const dependencies = {
    module, exports: module.exports, require, Buffer, URL, AbortSignal, console, process,
    fetch: (...args) => global.fetch(...args), setInterval: () => ({ unref() {} }), clearInterval() {},
    setImmediate() {}, // Workers are driven explicitly, never by a background pump.
  };
  vm.runInThisContext(`(function(${Object.keys(dependencies).join(',')}) {\n` +
    fs.readFileSync(path.join(__dirname, 'nexi-ingress.cjs'), 'utf8') + '\nmodule.exports.testRun = run; module.exports.testPump = pump;\n})')(...Object.values(dependencies));
  return module.exports;
}
function evaluate(expression, ingress, extra = {}) {
  const exports = {};
  const code = ts.transpileModule(`exports.value = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const dependencies = { exports, Buffer, console, require: name =>
    name === '/evolution/nexi-ingress.cjs' ? ingress : name.startsWith('/evolution/') ? require('./' + path.basename(name)) : require(name),
    Long: { isLong: () => false }, Events: { MESSAGES_UPSERT: 'messages.upsert', CONTACTS_UPSERT: 'contacts.upsert' },
    sendTelemetry() {}, chatbotController: { async emit() {} }, async saveOnWhatsappCache() {}, ...extra };
  vm.runInThisContext(`(function(${Object.keys(dependencies).join(',')}) {\n${code}\n})`)(...Object.values(dependencies));
  return exports.value;
}
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return value.some(item => matches(row, item));
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, wanted]) =>
    op === 'gt' ? row[key] > wanted : op === 'lt' ? row[key] < wanted : op === 'lte' ? row[key] <= wanted : op === 'not' ? row[key] !== wanted : op === 'in' ? wanted.includes(row[key]) : false);
  return row[key] === value || value === null && row[key] == null;
});
function assign(row, data) {
  for (const [key, value] of Object.entries(data)) row[key] = value?.increment !== undefined ? (row[key] ?? 0) + (typeof row[key] === 'bigint' ? BigInt(value.increment) : value.increment) :
    value?.decrement !== undefined ? row[key] - value.decrement : structuredClone(value);
  return row;
}
function collection(defaults = {}) {
  const rows = new Map();
  const find = where => [...rows.values()].find(row => matches(row, where));
  return { rows,
    async findUnique({ where }) { return structuredClone(find(where) || null); },
    async findFirst({ where }) { return structuredClone(find(where) || null); },
    async findMany({ where, take }) { return structuredClone([...rows.values()].filter(row => matches(row, where)).slice(0, take)); },
    async create({ data }) { const row = { ...structuredClone(defaults), ...structuredClone(data) }; rows.set(row.id, row); return structuredClone(row); },
    async upsert({ where, create, update }) { const row = find(where); return row ? structuredClone(assign(row, update)) : this.create({ data: create }); },
    async update({ where, data }) { const row = find(where); assert.ok(row, 'update must find a row'); return structuredClone(assign(row, data)); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows.values()) if (matches(row, where)) { assign(row, data); count++; } return { count }; },
  };
}
async function fixture(t, options = {}) {
  const oldFetch = global.fetch, oldSecret = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET, oldHold = process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'synthetic-ingress-recovery-offline-test-master';
  process.env.NEXI_ATTENDANCE_CUTOVER_HOLD = 'true';
  let ingress = runtime(), registration;
  const events = [], materializations = [], checkpoints = [], failures = [], legacyEvents = [], logs = [], posts = [];
  const { proto } = await import(pathToFileURL(path.join(root, 'node_modules/baileys/WAProto/index.js')));
  const { cleanMessage } = await import(pathToFileURL(path.join(root, 'node_modules/baileys/lib/Utils/process-message.js')));
  const decode = evaluate(decoder, ingress, { proto, cleanMessage });
  const repo = {
    instance: collection(), nexiIngressScope: collection({ pending: 0, nextSequence: 0n, revision: 0 }),
    nexiIngressLane: collection({ pending: 0, leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(0) }), nexiIngressJournal: collection({ state: 'pending', checkpoint: 'persisted', attempts: 0 }),
    message: collection(), contact: collection(), chat: collection(), nexiIngressEffect: collection(),
    webhook: { async findUnique() { return { enabled: true, url: 'https://offline.invalid/webhooks/nexi/channels/evolution',
      headers: { 'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '2' } }; } },
  };
  // Keep rollback references used by collection methods valid.
  repo.$transaction = async work => {
    const snapshots = Object.values(repo).filter(value => value?.rows).map(value => [value.rows, structuredClone(value.rows)]);
    try { return await work(repo); } catch (error) { for (const [rows, snapshot] of snapshots) { rows.clear(); for (const entry of snapshot) rows.set(...entry); } throw error; }
  };
  const updateJournal = repo.nexiIngressJournal.update.bind(repo.nexiIngressJournal);
  repo.nexiIngressJournal.update = async args => {
    if (options.failCheckpoint?.(args.data)) throw Object.assign(Error('synthetic checkpoint unavailable'), { code: 'synthetic_storage_unavailable' });
    checkpoints.push(structuredClone(args.data)); return updateJournal(args);
  };
  const creds = { me: { id: '5511999999999:1@s.whatsapp.net', lid: '100001@lid' }, registrationId: 9, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
  let socket = { authState: { creds }, ws: { isOpen: true }, end() { options.socketCloses = (options.socketCloses || 0) + 1; } };
  const service = { instanceId: 'synthetic-instance', instance: { name: 'nexi-wa-offline', id: 'synthetic-instance' },
    client: socket, prismaRepository: repo, logger: { warn(value) { logs.push(value); }, info(value) { logs.push(value); }, error(error) { failures.push(error); }, verbose() {} }, localSettings: {}, localWebhook: { enabled: false },
    async sendDataWebhook(event) { legacyEvents.push(event); },
    localChatwoot: options.local === undefined ? null : { enabled: options.local },
    configService: { get: () => ({ ENABLED: options.global !== false, SAVE_DATA: {} }) },
    prepareMessage: message => ({ key: { ...message.key }, message: message.message, messageType: 'conversation', instanceId: service.instanceId }),
    chatwootService: { async eventWhatsapp(_event, _instance, body) {
      assert.equal(attendance.cutoverHeld(), true);
      assert.ok(identity.associationFor(body), 'only the real observed/reconciled association routes creation');
      if (options.providerMissing) return null;
      if (!app.message_id) { app.message_id = 77; app.creates++; }
      if (options.lostCreationResponse) throw Error('synthetic lost HTTP response after commit');
      return { id: app.message_id, inbox_id: 2, conversation_id: 6 };
    } },
  };
  await repo.instance.create({ data: { id: service.instanceId, nexiGroupsSocketOwner: null, connectionStatus: 'open' } });
  const config = { auth: { creds }, logger: { level: 'silent', warn() {} } };
  await groups.installAdmissionSocket(service, config, () => socket);
  socket = service.client;
  ingress.configure(service, config); ingress.trackSocket(socket, config);
  const received = { key: { id: 'SYNTHETIC_INGRESS_1', remoteJid: options.pn || '5511987654321@s.whatsapp.net', fromMe: false },
    message: { conversation: 'offline synthetic message' }, messageTimestamp: 100 };
  if (options.media) received.message = { imageMessage: { caption: 'SYNTHETIC_PRIVATE_MEDIA_CAPTION', fileName: 'synthetic.jpg' } };
  const app = { message_id: null, creates: 0, observed: false };
  global.fetch = async (url, request) => {
    assert.equal(String(url), 'https://offline.invalid/webhooks/nexi/channels/evolution');
    const body = JSON.parse(request.body), headers = request.headers, claims = body.data.ingress?.claims;
    const secret = createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET).update(`event:${service.instance.name}`).digest();
    const signature = createHmac('sha256', secret).update(`${headers['X-Nexi-Event-Timestamp']}.${headers['X-Nexi-Event-Id']}.${service.instance.name}.${service.instanceId}.${request.body}`).digest('hex');
    assert.equal(headers['X-Nexi-Event-Signature'], `sha256=${signature}`);
    if (claims) assert.equal(claims.journal_id, row().id);
    assert.equal(body.data.external_message_id, received.key.id);
    assert.equal(body.data.pn_jid, received.key.remoteJid);
    events.push({ event: body.event, id: headers['X-Nexi-Event-Id'], journal: claims?.journal_id });
    const status = options.status?.(body.event, events) || 200;
    if (status !== 200) return { ok: false, status };
    if (['ingress.observed', 'identity.observed'].includes(body.event)) app.observed = true;
    else assert.ok(app.observed, 'observation must precede reconciliation and correlation');
    const association = { account_id: 1, inbox_id: 2, association_id: 3, generation: 1, contact_id: 4,
      contact_inbox_id: 5, conversation_id: 60, conversation_display_id: 6, ...(app.message_id ? { message_id: app.message_id } : {}) };
    if (body.event === 'ingress.reconcile') association.creation_state = app.message_id ? 'confirmed' : 'absent_retry_safe';
    if (['ingress.correlated', 'identity.correlated'].includes(body.event)) {
      assert.equal(body.data.ack.message_id, app.message_id); assert.ok(app.message_id);
      assert.deepEqual(body.data.ack, association, 'APP contract requires the exact full association ACK');
    }
    return { ok: true, status: 200, json: async () => options.reply ? options.reply(association) : association };
  };
  const row = () => [...repo.nexiIngressJournal.rows.values()][0];
  identity.observeDecrypted(received, { attrs: { id: received.key.id, from: received.key.remoteJid } }, creds, false);
  // Admission is exercised through the genuine live-object capability.
  // Only scheduling is suppressed; explicit recovery below uses the real worker.
  function wire() {
    const processMessage = evaluate(`(function() { return ${handler}; }).call(service)`, ingress, { service, console: { log() {} } });
    const materialize = ingress.materializePrimary;
    ingress.materializePrimary = async (...args) => {
      materializations.push({ checkpoint: row().checkpoint, association: structuredClone(row().association), acknowledgement: structuredClone(row().acknowledgement) });
      return materialize(...args);
    };
    registration = { service, socket, decode, process: async message => {
      try { return await processMessage({ messages: [message], type: 'notify' }, {}); }
      catch (error) { failures.push(error); throw error; }
    }, effects: {}, policy: () => ({}) };
    ingress.secondaryRuntime.registrations.set(service.instanceId, registration);
    if (options.actualChatwoot) require('./ingress-chatwoot-test-support.cjs').install({ root, ingress, service, repo, app, options, posts });
  }
  wire();
  t.after(() => {
    global.fetch = oldFetch; attendance.clearInstanceDiagnostics(service);
    for (const [key, value] of [['NEXI_CHANNELS_EVENT_MASTER_SECRET', oldSecret], ['NEXI_ATTENDANCE_CUTOVER_HOLD', oldHold]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  return { get ingress() { return ingress; }, get registration() { return registration; },
    repo, received, config, proto, service, app, events, checkpoints, materializations, failures, legacyEvents, logs, posts, row,
    async direct() { return registration.process(received); },
    restart() { ingress = runtime(); ingress.configure(service, config); ingress.trackSocket(socket, config); wire(); },
    async admit() { await ingress.capture(config, received, proto); },
    async recover() {
      const lane = repo.nexiIngressLane.rows.get(row().laneId), token = 'synthetic-lease';
      assign(lane, { leaseToken: token, leaseUntil: new Date(Date.now() + 60000) });
      await ingress.testRun(registration, lane, token);
    } };
}
test('actual eventWhatsapp/SDK POST rejection from chatwoot_inflight must expose HTTP result', async t => {
  const f = await fixture(t, { actualChatwoot: true, post: async () => ({ status: 422, statusText: 'Unprocessable Entity', headers: {},
    data: { error: 'SYNTHETIC_PRIVATE_VALIDATION_BODY' } }) });
  await f.admit(); f.app.observed = true;
  Object.assign(f.row(), { state: 'result_uncertain', checkpoint: 'chatwoot_inflight', attempts: 41,
    association: { account_id: 1, inbox_id: 2, association_id: 3, generation: 1, contact_id: 4, contact_inbox_id: 5,
      conversation_id: 60, conversation_display_id: 6 } });
  await f.recover();
  assert.equal(f.row().attempts, 42); assert.equal(f.row().state, 'result_uncertain');
  assert.equal(f.row().checkpoint, 'chatwoot_inflight'); assert.equal(f.row().lastError, 'nexi_ingress_chatwoot_unconfirmed');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].data.source_id, 'WAID:SYNTHETIC_INGRESS_1');
  assert.equal(f.posts[0].data.message_type, 'incoming'); assert.equal(f.posts[0].data.private, 'false');
  assert.equal(f.materializations.length, 0); assert.equal(f.row().acknowledgement, undefined);
  assert.ok(f.logs.some(item => item?.event === 'ingress.creation' && item.http_status === 422), 'HTTP 422 must be observable without logging the response body');
  assert.ok(!JSON.stringify(f.logs).includes('SYNTHETIC_PRIVATE_VALIDATION_BODY'));
});
function commitPost(app, data) {
  assert.equal(data.source_id, 'WAID:SYNTHETIC_INGRESS_1');
  assert.equal(data.message_type, 'incoming'); assert.equal(data.private, 'false');
  if (!app.message_id) { app.message_id = 77; app.creates++; }
  return app.message_id;
}
const postResponse = (status, data = {}) => ({ status, statusText: 'SYNTHETIC_STATUS', headers: {}, data });
async function inflight(t, options = {}) {
  const f = await fixture(t, { actualChatwoot: true, ...options }); await f.admit();
  f.app.observed = true;
  Object.assign(f.row(), { state: 'result_uncertain', checkpoint: 'chatwoot_inflight', attempts: 41,
    association: { account_id: 1, inbox_id: 2, association_id: 3, generation: 1, contact_id: 4, contact_inbox_id: 5,
      conversation_id: 60, conversation_display_id: 6 } });
  return f;
}
for (const status of [401, 403, 422, 503]) {
  test(`actual SDK POST ${status} preserves uncertainty and reports its classification`, async t => {
    const f = await inflight(t, { post: async () => postResponse(status, { error: 'PRIVATE_ERROR_SENTINEL' }) });
    await f.recover(); await f.recover();
    assert.equal(f.row().lastError, 'nexi_ingress_chatwoot_unconfirmed'); assert.equal(f.app.creates, 0);
    assert.equal(f.posts.length, 2, 'retry can POST only after APP confirms absent_retry_safe');
    assert.equal(f.events.filter(item => item.event === 'ingress.reconcile').length, 4);
    assert.equal(f.materializations.length, 0); assert.equal(f.row().acknowledgement, undefined);
    assert.ok(f.logs.some(item => item?.http_status === status && item.error_class));
    assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_ERROR_SENTINEL'));
  });
}
test('actual POST accepted is reconciled and ACK is persisted before materialization', async t => {
  const f = await inflight(t); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 1); assert.equal(f.app.creates, 1);
  assert.equal(f.repo.message.rows.size, 1); assert.equal(f.row().acknowledgement.id, 77);
  assert.ok(f.logs.some(item => item?.event === 'ingress.creation' && item.http_status === 200));
  assert.ok(f.logs.some(item => item?.stage === 'ack_persisted'));
});
for (const committed of [false, true]) {
  test(`actual POST timeout ${committed ? 'after' : 'before'} APP creation is distinguished by reconciliation`, async t => {
    const f = await inflight(t, { post: async ({ app, data }) => {
      if (committed) commitPost(app, data);
      throw Object.assign(Error('PRIVATE_TIMEOUT_SENTINEL'), { code: 'ETIMEDOUT' });
    } });
    await f.recover();
    assert.equal(f.app.creates, committed ? 1 : 0); assert.equal(f.row().state, committed ? 'succeeded' : 'result_uncertain');
    assert.equal(f.materializations.length, committed ? 1 : 0);
    assert.ok(f.logs.some(item => item?.stage === 'transport_error' && item.error_class === 'timeout'));
    assert.ok(f.logs.some(item => item?.stage === 'after_creation' && item.has_message_id === committed));
    assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_TIMEOUT_SENTINEL'));
  });
}
for (const committed of [false, true]) {
  test(`actual HTTP 200 without id ${committed ? 'with' : 'without'} APP commit cannot manufacture an ACK`, async t => {
    const f = await inflight(t, { post: async ({ app, data }) => {
      if (committed) commitPost(app, data);
      return postResponse(200);
    } });
    await f.recover();
    assert.equal(f.row().state, committed ? 'succeeded' : 'result_uncertain');
    assert.equal(f.row().acknowledgement?.id, committed ? 77 : undefined);
    assert.ok(f.logs.some(item => item?.stage === 'event_whatsapp_returned' && item.has_message_id === false));
  });
}
test('an HTTP 200 carrying an id without a committed reservation is insufficient for ACK or materialization', async t => {
  const f = await inflight(t, { post: async () => postResponse(200, { id: 77, inbox_id: 2, conversation_id: 6 }) });
  await f.recover();
  assert.equal(f.row().lastError, 'nexi_ingress_chatwoot_unconfirmed'); assert.equal(f.row().acknowledgement, undefined);
  assert.equal(f.materializations.length, 0); assert.equal(f.app.creates, 0);
});
test('a POST ACK conflicting with the APP reservation remains uncertain', async t => {
  const f = await inflight(t, { post: async ({ app, data }) => {
    commitPost(app, data); return postResponse(200, { id: 78, inbox_id: 2, conversation_id: 6 });
  } });
  await f.recover();
  assert.equal(f.row().state, 'result_uncertain'); assert.equal(f.row().lastError, 'nexi_ingress_ack_conflict');
  assert.equal(f.row().acknowledgement, undefined); assert.equal(f.materializations.length, 0); assert.equal(f.app.creates, 1);
});
test('actual creation result survives ACK persistence failure and a fresh worker skips the second POST', async t => {
  let fail = true;
  const f = await inflight(t, { failCheckpoint: data => fail && data.checkpoint === 'chatwoot_confirmed' });
  await f.recover();
  assert.equal(f.app.creates, 1); assert.equal(f.row().acknowledgement, undefined); assert.equal(f.row().state, 'result_uncertain');
  assert.ok(f.logs.some(item => item?.stage === 'ack_persistence_failed'));
  fail = false; f.restart(); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 1); assert.equal(f.app.creates, 1);
});
test('existing admission Message is confirmed without invoking the SDK creation path', async t => {
  const f = await inflight(t); f.app.message_id = 77; f.app.creates = 1;
  await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 0); assert.equal(f.app.creates, 1);
  assert.ok(f.logs.some(item => item?.stage === 'before_creation' && item.has_message_id === true));
});
test('reconciliation outage after actual commit retains uncertainty and resumes without duplicate POST', async t => {
  let failReconciliation = true;
  const f = await inflight(t, { status: (event, events) => failReconciliation && event === 'ingress.reconcile' &&
    events.filter(item => item.event === 'ingress.reconcile').length === 2 ? 503 : 200 });
  await f.recover();
  assert.equal(f.app.creates, 1); assert.equal(f.row().state, 'result_uncertain');
  assert.equal(f.row().lastError, 'nexi_ingress_remote_unavailable');
  assert.ok(f.logs.some(item => item?.stage === 'after_creation' && item.result === 'failed' && item.http_status === 503));
  failReconciliation = false; f.restart(); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 1);
});
test('incompatible source reservation rejects the actual emitted WAID without phone fallback', async t => {
  const f = await inflight(t, { post: async ({ data }) => {
    assert.equal(data.source_id, 'WAID:SYNTHETIC_INGRESS_1');
    return postResponse(422, { error: 'SYNTHETIC_SOURCE_RESERVATION_MISMATCH' });
  } });
  await f.recover(); assert.equal(f.row().state, 'result_uncertain');
  assert.equal(f.row().acknowledgement, undefined); assert.equal(f.app.creates, 0);
});
for (const options of [{ providerMissing: true }, { foreignInbox: true }, { ignoreJids: ['@s.whatsapp.net'] }]) {
  test(`eventWhatsapp preflight without POST is observable (${JSON.stringify(options)})`, async t => {
    const f = await inflight(t, options); await f.recover();
    assert.equal(f.posts.length, 0); assert.equal(f.row().lastError, 'nexi_ingress_chatwoot_unconfirmed');
    assert.ok(f.logs.some(item => item?.stage === 'event_whatsapp_returned' && item.request_started === false && item.skip_reason));
  });
}
test('concurrent pump invocations share the production lane CAS and create one Message', async t => {
  const f = await inflight(t);
  await Promise.all([f.ingress.testPump(), f.ingress.testPump()]);
  const deadline = Date.now() + 2000;
  while (f.row().state !== 'succeeded' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 1); assert.equal(f.app.creates, 1);
  assert.equal(f.repo.message.rows.size, 1); assert.equal(f.row().acknowledgement.id, 77);
});
test('a late committed first POST and its retry use the same source reservation and one APP result', async t => {
  let lateCommit;
  const f = await inflight(t, { post: async ({ app, data, posts }) => {
    if (posts.length === 1) {
      lateCommit = () => commitPost(app, data);
      throw Object.assign(Error('synthetic timeout while server may continue'), { code: 'ETIMEDOUT' });
    }
    lateCommit();
    return postResponse(200, { id: commitPost(app, data), inbox_id: 2, conversation_id: 6 });
  } });
  await f.recover(); assert.equal(f.row().state, 'result_uncertain'); assert.equal(f.app.creates, 0);
  await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.posts.length, 2); assert.equal(f.app.creates, 1);
  assert.equal(f.posts[0].data.source_id, f.posts[1].data.source_id); assert.equal(f.repo.message.rows.size, 1);
});
test('actual media Axios rejection emits only HTTP metadata, never the error config or private body', async t => {
  const f = await inflight(t, { media: true, post: async () => { throw { response: { status: 422, data: 'PRIVATE_MEDIA_ERROR_BODY' },
    config: { headers: { api_access_token: 'PRIVATE_MEDIA_TOKEN' } } }; } });
  await f.recover();
  assert.equal(f.row().state, 'result_uncertain'); assert.equal(f.posts.length, 1); assert.equal(f.app.creates, 0);
  assert.ok(f.logs.some(item => item?.transport === 'media_message_post' && item.http_status === 422));
  const logged = JSON.stringify([...f.logs, ...f.failures]);
  for (const secret of ['PRIVATE_MEDIA_ERROR_BODY', 'PRIVATE_MEDIA_TOKEN', 'SYNTHETIC_PRIVATE_MEDIA_CAPTION', 'SYNTHETIC_MEDIA_BYTES'])
    assert.ok(!logged.includes(secret));
});
test('diagnostic logger failure cannot turn a confirmed actual POST into a failed result', async t => {
  const f = await inflight(t);
  f.service.logger.warn = () => { throw Error('synthetic logger unavailable'); };
  await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1); assert.equal(f.repo.message.rows.size, 1);
});
test('actual legacy SDK receive outside durable context retains its result without ingress diagnostics', async t => {
  const f = await fixture(t, { actualChatwoot: true, local: true }); await f.direct();
  assert.deepEqual(f.failures, []); assert.equal(f.posts.length, 1); assert.equal(f.app.creates, 1);
  assert.ok(f.legacyEvents.includes('contacts.upsert'));
  assert.ok(!f.logs.some(item => ['ingress.creation', 'ingress.reconciliation'].includes(item?.event)));
});
test('SDK HTTP instrumentation requires one exact anchor and rejects drift', async () => {
  const { patchChatwootCompletion } = await import('./patch-chatwoot-completion.mjs');
  const pristine = path.join(process.env.NEXI_INGRESS_PRISTINE_SDK || path.join(__dirname, '.test-runtime/chatwoot-sdk-pristine'), 'dist/core/request.js');
  // Local package fixture used by the finite SDK verifier; no dependency download.
  const original = fs.readFileSync(pristine, 'utf8').replaceAll('\r\n', '\n');
  const anchor = '        return await axios_1.default.request(requestConfig);';
  assert.throws(() => patchChatwootCompletion(original.replace(anchor, '        return null;')), /HTTP diagnostic anchor changed/);
  const block = original.slice(original.indexOf('    try {\n' + anchor), original.indexOf('\n};\nconst getResponseHeader'));
  assert.ok(block.includes(anchor));
  assert.throws(() => patchChatwootCompletion(original + '\n' + block), /HTTP diagnostic anchor changed/);
  assert.ok(patchChatwootCompletion(original).includes('nexiTransportSettled'));
});

test('persisted recoverable journal without association/ACK recovers with HOLD and instance Chatwoot absent', async t => {
  const f = await fixture(t);
  await f.admit(); Object.assign(f.row(), { state: 'recoverable_failure', attempts: 8, lastError: 'nexi_ingress_primary_requirements_missing' });
  assert.equal(f.row().checkpoint, 'persisted'); assert.equal(f.row().association, undefined); assert.equal(f.row().acknowledgement, undefined);
  await f.recover();
  assert.equal(f.row().lastError, null, `worker: ${f.row().state}/${f.row().checkpoint}/${f.row().lastError}: ${f.failures[0]?.stack}`);
  assert.deepEqual(f.events.map(item => item.event), ['ingress.observed', 'ingress.reconcile', 'ingress.reconcile', 'ingress.correlated']);
  assert.equal(f.materializations[0]?.checkpoint, 'correlation_confirmed');
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.repo.message.rows.size, 1); assert.equal(f.app.creates, 1);
  assert.equal(attendance.cutoverHeld(), true);
});

for (const flags of [{ local: true, global: true }, { local: false, global: true }, { local: true, global: false }]) {
  test(`durable ingress completes with flags ${JSON.stringify(flags)} and HOLD active`, async t => {
    const f = await fixture(t, flags); await f.admit(); await f.recover();
    assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1);
    assert.equal(f.materializations.length, 1); assert.equal(f.materializations[0].checkpoint, 'correlation_confirmed');
    assert.equal(f.materializations[0].acknowledgement.id, f.materializations[0].association.message_id);
  });
}
test('temporary APP outage and late association retry the same immutable observation', async t => {
  let unavailable = true;
  const f = await fixture(t, { status: () => unavailable ? 503 : 200 }); await f.admit();
  const id = f.row().id, envelope = structuredClone(f.row().envelope);
  await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().checkpoint, 'identity_pending');
  assert.equal(f.row().lastError, 'nexi_ingress_remote_unavailable');
  assert.equal(f.materializations.length, 0); assert.equal(f.row().association, undefined); assert.equal(f.app.creates, 0);
  unavailable = false; await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.row().id, id); assert.deepEqual(f.row().envelope, envelope);
  assert.equal(f.events[0].id, f.events[1].id); assert.equal(f.app.creates, 1);
});
test('reconciliation outage after observation resumes without premature materialization', async t => {
  let unavailable = true;
  const f = await fixture(t, { status: event => unavailable && event === 'ingress.reconcile' ? 503 : 200 });
  await f.admit(); await f.recover();
  assert.equal(f.row().checkpoint, 'identity_confirmed'); assert.equal(f.row().state, 'recoverable_failure');
  assert.ok(f.row().association); assert.equal(f.row().acknowledgement, undefined); assert.equal(f.materializations.length, 0);
  unavailable = false; await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1);
});
test('lost creation response is reconciled against the committed APP result', async t => {
  const f = await fixture(t, { lostCreationResponse: true }); await f.admit(); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1); assert.equal(f.row().acknowledgement.id, 77);
});
test('restart after APP commit but before ACK checkpoint recovers the existing Message', async t => {
  let failCommit = true;
  const f = await fixture(t, { failCheckpoint: data => failCommit && data.checkpoint === 'chatwoot_confirmed' });
  await f.admit(); await f.recover();
  assert.equal(f.row().state, 'result_uncertain'); assert.equal(f.row().checkpoint, 'chatwoot_inflight');
  assert.equal(f.row().acknowledgement, undefined); assert.equal(f.app.creates, 1); assert.equal(f.materializations.length, 0);
  failCommit = false; f.restart(); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1); assert.equal(f.repo.message.rows.size, 1);
});
test('failed local materialization transaction rolls back and resumes without a second APP Message', async t => {
  let failCommit = true;
  const f = await fixture(t, { failCheckpoint: data => failCommit && data.checkpoint === 'main_materialized' });
  await f.admit(); await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().checkpoint, 'correlation_confirmed');
  assert.equal(f.row().lastError, 'synthetic_storage_unavailable'); assert.equal(f.repo.message.rows.size, 0);
  assert.equal(f.app.creates, 1);
  failCommit = false; f.restart(); await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.repo.message.rows.size, 1); assert.equal(f.app.creates, 1);
});
test('retry after correlation rejection retains genuine ACK and preserves stage event IDs', async t => {
  let rejected = true;
  const f = await fixture(t, { status: event => rejected && event === 'ingress.correlated' ? 422 : 200 });
  await f.admit(); await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().checkpoint, 'correlation_pending');
  assert.equal(f.row().lastError, 'nexi_ingress_remote_rejected'); assert.equal(f.row().acknowledgement.id, 77);
  assert.equal(f.materializations.length, 0);
  rejected = false; await f.recover();
  assert.equal(f.row().state, 'succeeded'); assert.equal(f.app.creates, 1);
  const correlations = f.events.filter(item => item.event === 'ingress.correlated');
  assert.equal(correlations[0].id, correlations[1].id);
});
test('duplicate admission and repeated recovery retain one journal and one local/APP Message', async t => {
  const f = await fixture(t); await f.admit(); const id = f.row().id;
  await f.admit(); assert.equal(f.repo.nexiIngressJournal.rows.size, 1);
  await f.recover(); await f.admit(); await f.recover();
  assert.equal(f.row().id, id); assert.equal(f.row().state, 'succeeded');
  assert.equal(f.app.creates, 1); assert.equal(f.repo.message.rows.size, 1);
  assert.equal([...f.repo.nexiIngressScope.rows.values()][0].pending, 0);
});
test('absent Chatwoot creation provider is a legitimate unresolved result, never a fabricated ACK', async t => {
  const f = await fixture(t, { providerMissing: true }); await f.admit(); await f.recover();
  assert.equal(f.row().state, 'result_uncertain'); assert.equal(f.row().checkpoint, 'chatwoot_inflight');
  assert.equal(f.row().lastError, 'nexi_ingress_chatwoot_unconfirmed');
  assert.equal(f.row().acknowledgement, undefined); assert.equal(f.materializations.length, 0);
  assert.equal(f.repo.message.rows.size, 0); assert.equal(f.app.creates, 0);
});
test('APP authentication rejection remains recoverable and cannot materialize', async t => {
  const f = await fixture(t, { status: () => 401 }); await f.admit(); await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().lastError, 'nexi_ingress_remote_rejected');
  assert.equal(f.row().association, undefined); assert.equal(f.materializations.length, 0);
});
test('foreign APP response is rejected without storing association or ACK', async t => {
  const f = await fixture(t, { reply: association => ({ ...association, account_id: 99 }) });
  await f.admit(); await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().lastError, 'nexi_ingress_ack_invalid');
  assert.equal(f.row().association, undefined); assert.equal(f.row().acknowledgement, undefined);
  assert.equal(f.materializations.length, 0);
});
for (const foreign of [false, true]) {
  test(`journal ${foreign ? 'foreign instance' : 'invalid signature'} is fenced before any APP request`, async t => {
    const f = await fixture(t); await f.admit();
    if (foreign) f.row().instanceId = 'foreign-instance'; else f.row().envelope.signature = '0'.repeat(64);
    await f.recover();
    assert.equal(f.row().state, 'outcome_unknown'); assert.equal(f.row().lastError, 'session_or_proof_fenced');
    assert.equal(f.events.length, 0); assert.equal(f.materializations.length, 0); assert.equal(f.repo.message.rows.size, 0);
  });
}
test('unresolved legacy outcome_unknown is retained for manual reconciliation', async t => {
  const f = await fixture(t); await f.admit(); Object.assign(f.row(), { state: 'outcome_unknown', checkpoint: 'legacy_unknown' });
  await f.recover();
  assert.equal(f.row().state, 'outcome_unknown'); assert.equal(f.row().lastError, 'manual_reconciliation_required');
  assert.equal(f.events.length, 0); assert.equal(f.materializations.length, 0);
});
test('primary requirements guard still rejects direct materialization without association/ACK', async t => {
  const f = await fixture(t); await f.admit();
  f.registration.process = () => f.ingress.materializePrimary(f.service, {});
  await f.recover();
  assert.equal(f.row().state, 'recoverable_failure'); assert.equal(f.row().checkpoint, 'persisted');
  assert.equal(f.row().lastError, 'nexi_ingress_primary_requirements_missing'); assert.equal(f.repo.message.rows.size, 0);
});
for (const pn of ['551187654321@s.whatsapp.net', '5511987654321@s.whatsapp.net']) {
  test(`authenticated PN remains exact across recovery: ${pn}`, async t => {
    const f = await fixture(t, { pn }); await f.admit(); await f.recover();
    assert.equal(f.row().state, 'succeeded'); assert.equal(f.row().envelope.claims.observation.pn_jid, pn);
    assert.equal([...f.repo.message.rows.values()][0].key.remoteJid, pn);
  });
}
for (const enabled of [true, false]) {
  test(`non-journal legacy receive retains its configured Chatwoot policy (${enabled})`, async t => {
    const f = await fixture(t, { local: enabled }); await f.direct();
    assert.deepEqual(f.failures, []); assert.ok(f.legacyEvents.includes('contacts.upsert'), 'entire normal handler must finish');
    assert.deepEqual(f.events.map(item => item.event), enabled ? ['identity.observed', 'identity.correlated'] : []);
    assert.equal(f.app.creates, enabled ? 1 : 0); assert.equal(f.materializations.length, 0);
  });
}
