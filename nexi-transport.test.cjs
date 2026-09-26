'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { isolateChatwoot, verifyChatwootWebhook, processChatwootWebhook, createReplayLedger, resolveConfiguredInbox,
  prepareEvent, eventKeyProof, redactEventForLog } = require('./nexi-transport.cjs');

// redis.call('SET') returns a Lua status table ({ ok: 'OK' }), not the string 'OK'.
// Match the script's actual branch after the simulated write so the old comparison fails these tests.
function recognizesLuaSetStatus(script, index = 0) {
  const reply = { ok: 'OK' };
  const checks = [...script.matchAll(/local set_result = redis\.call\('SET'[^\n]*\)\s*\n\s*if type\(set_result\) == 'table' and set_result\.ok == 'OK' then return /g)];
  return Boolean(checks[index] && typeof reply === 'object' && reply.ok === 'OK');
}

// One shared deterministic Redis command contract; eval is atomic and has no await points.
class RedisContract {
  records = new Map();
  isReady = true;
  nowMs = Date.now();
  failBegin = false;
  failFinalization = false;
  async eval(script, { keys: [key], arguments: args }) {
    if (!this.isReady) throw new Error('redis unavailable');
    const current = this.records.get(key);
    const record = current && current.expires > this.nowMs ? JSON.parse(current.value) : null;
    if (!record && current) this.records.delete(key);
    if (script.includes('local lease_ms, ttl')) {
      assert.match(script, /'SET', key, value, 'NX', 'EX', ttl/);
      assert.match(script, /'SET', key, cjson\.encode\(record\), 'XX', 'KEEPTTL'/);
      const [bodyHash, ownerToken, leaseMs, ttlSeconds] = args;
      if (!record) {
        this.records.set(key, { value: JSON.stringify({ state: 'reserved', bodyHash, ownerToken,
          reservedUntilMs: this.nowMs + Number(leaseMs) }), expires: this.nowMs + Number(ttlSeconds) * 1000 });
        return recognizesLuaSetStatus(script, 0) ? 'claimed' : 'inconsistent';
      }
      if (record.bodyHash !== bodyHash) return 'identity_conflict';
      if (record.state === 'reserved' && record.reservedUntilMs <= this.nowMs) {
        this.records.set(key, { value: JSON.stringify({ ...record, ownerToken,
          reservedUntilMs: this.nowMs + Number(leaseMs) }), expires: current.expires });
        return recognizesLuaSetStatus(script, 1) ? 'claimed' : 'inconsistent';
      }
      return record.state === 'reserved' ? 'active_reserved' : record.state;
    }
    if (script.includes('local key, hash, owner, target')) {
      if (this.failFinalization) throw new Error('finalization unavailable');
      if (!record || record.state !== 'dispatching' || record.bodyHash !== args[0] ||
          record.ownerToken !== args[1]) return 'inconsistent';
      this.records.set(key, { value: JSON.stringify({ ...record, state: args[2] }), expires: current.expires });
      return recognizesLuaSetStatus(script) ? args[2] : 'inconsistent';
    }
    if (this.failBegin) throw new Error('dispatch marker unavailable');
    assert.match(script, /record\.state, record\.reservedUntilMs = 'dispatching', cjson\.null/);
    if (!record || record.state !== 'reserved' || record.bodyHash !== args[0] ||
        record.ownerToken !== args[1] || record.reservedUntilMs <= this.nowMs) return 'lost_ownership';
    this.records.set(key, { value: JSON.stringify({ ...record, state: 'dispatching', reservedUntilMs: null }),
      expires: current.expires });
    return recognizesLuaSetStatus(script) ? 'dispatching' : 'inconsistent';
  }
  async ping() {
    if (!this.isReady) throw new Error('redis unavailable');
    return 'PONG';
  }
  async configGet() {
    if (!this.isReady) throw new Error('redis unavailable');
    return { 'maxmemory-policy': 'noeviction', appendonly: 'yes', appendfsync: 'always' };
  }
}

const instanceName = 'nexi-wa-test';
const provider = { enabled: true, url: 'https://chatwoot.example', accountId: '4', inboxId: '13',
  token: 'server-token', nameInbox: 'Old name' };
const inbox = { id: 13, name: 'Renamed', channel_type: 'Channel::Api', secret: 'webhook-secret', account_id: 4 };
const fetchInbox = async () => ({ ok: true, json: async () => ({ payload: [
  { ...inbox, id: 99, name: 'Old name' }, inbox,
] }) });

function request(body, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = overrides.delivery || '10eb4a77-8c84-487c-a4bd-d2a915b21f44';
  const signature = `sha256=${createHmac('sha256', inbox.secret)
    .update(timestamp).update('.').update(delivery).update('.').update(rawBody).digest('hex')}`;
  return { params: { instanceName }, rawBody, body, headers: {
    'x-chatwoot-timestamp': timestamp, 'x-chatwoot-signature': signature,
    'x-chatwoot-delivery': delivery, ...overrides.headers,
  } };
}

const privateNote = { event: 'message_created', account: { id: 4 }, inbox: { id: 13 }, private: true };

test('delivery ID is signed: changing only D1 to D2 rejects before dispatch or ledger claim', async () => {
  const redis = new RedisContract();
  const ledger = createReplayLedger({ client: redis });
  const original = request(privateNote);
  assert.equal((await verifyChatwootWebhook(original, provider, fetchInbox, ledger)).ok, true);
  const changed = { ...original, headers: { ...original.headers,
    'x-chatwoot-delivery': 'a37696c7-aefc-46a1-bfd9-77148a1af795' } };
  let sends = 0;
  const result = await verifyChatwootWebhook(changed, provider, fetchInbox, ledger);
  if (result.ok) sends++;
  assert.equal(result.status, 401);
  assert.equal(sends, 0);
  assert.equal(redis.records.size, 1);
});

test('exact stable Inbox ID survives rename and duplicate name; wrong ID fails', async () => {
  const ledger = createReplayLedger({ client: new RedisContract() });
  assert.equal(resolveConfiguredInbox([inbox, { ...inbox, id: 99, name: 'Old name' }],
    provider, instanceName).id, 13);
  assert.equal((await verifyChatwootWebhook(request(privateNote), provider, fetchInbox, ledger)).ok, true);
  assert.equal((await verifyChatwootWebhook(request({ ...privateNote, inbox: { id: 99 } },
    { delivery: 'a37696c7-aefc-46a1-bfd9-77148a1af795' }), provider, fetchInbox, ledger)).ok, false);
  assert.equal((await verifyChatwootWebhook(request(privateNote, {
    delivery: '8b93dd39-74ab-4227-b37a-e3fb451400a1' }),
  { ...provider, inboxId: '99' }, fetchInbox, ledger)).ok, false);
});

test('shared Redis claim survives new ledger client and concurrent workers', async () => {
  const redis = new RedisContract();
  const a = createReplayLedger({ client: redis });
  const b = createReplayLedger({ client: redis });
  const raw = Buffer.from('body');
  const claims = await Promise.all([
    a.claim(instanceName, 4, 13, '10eb4a77-8c84-487c-a4bd-d2a915b21f44', raw),
    b.claim(instanceName, 4, 13, '10eb4a77-8c84-487c-a4bd-d2a915b21f44', raw),
  ]);
  assert.deepEqual(claims.map((item) => item.kind).sort(), ['claimed', 'duplicate']);
  assert.equal(claims.find((item) => item.kind === 'duplicate').state, 'active_reserved');
  await a.beginDispatch(claims.find((item) => item.kind === 'claimed'));
  await a.finish(claims.find((item) => item.kind === 'claimed'), 'completed');
  const restarted = createReplayLedger({ client: redis });
  const replay = await restarted.claim(instanceName, 4, 13,
    '10eb4a77-8c84-487c-a4bd-d2a915b21f44', raw);
  assert.equal(replay.kind, 'duplicate');
  assert.equal(replay.state, 'completed');
  assert.equal(redis.records.size, 1);
  assert.equal(redis.records.values().next().value.expires > Date.now() + 29 * 86400 * 1000, true);
});

test('active reservation is not success; a pre-dispatch crash can be reclaimed after its lease', async () => {
  const redis = new RedisContract();
  const ledger = createReplayLedger({ client: redis });
  const delivery = request(privateNote);
  const first = await verifyChatwootWebhook(delivery, provider, fetchInbox, ledger);
  assert.equal(first.ok, true);
  let sends = 0;
  const active = await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis }));
  assert.deepEqual(active, { status: 409, body: { error: 'delivery_in_progress' } });
  assert.equal(sends, 0);
  redis.nowMs += 31_000;
  assert.deepEqual(await processChatwootWebhook(request({ ...privateNote, changed: true }), provider,
    () => { sends++; }, fetchInbox, createReplayLedger({ client: redis })),
  { status: 409, body: { error: 'delivery_identity_conflict' } });
  const recovered = await processChatwootWebhook(delivery, provider, () => {
    assert.equal(JSON.parse(redis.records.values().next().value.value).state, 'dispatching');
    sends++;
    return { message: 'sent' };
  },
    fetchInbox, createReplayLedger({ client: redis }));
  assert.deepEqual(recovered, { status: 200, body: { message: 'sent' } });
  assert.equal(sends, 1);
  await assert.rejects(ledger.beginDispatch(first.claim), /dispatch_boundary_unavailable/);
});

test('two workers racing to reclaim one stale reservation have one owner', async () => {
  const redis = new RedisContract();
  const a = createReplayLedger({ client: redis });
  const b = createReplayLedger({ client: redis });
  const raw = Buffer.from('body');
  const args = [instanceName, 4, 13, '10eb4a77-8c84-487c-a4bd-d2a915b21f44', raw];
  await a.claim(...args);
  redis.nowMs += 31_000;
  const claims = await Promise.all([a.claim(...args), b.claim(...args)]);
  assert.deepEqual(claims.map((item) => item.kind).sort(), ['claimed', 'duplicate']);
  assert.equal(claims.find((item) => item.kind === 'duplicate').state, 'active_reserved');
  await b.beginDispatch(claims.find((item) => item.kind === 'claimed'));
  assert.equal((await a.claim(...args)).state, 'dispatching');
});

test('dispatching crash and ambiguous outcome never redispatch or return success', async () => {
  const redis = new RedisContract();
  const ledger = createReplayLedger({ client: redis });
  const delivery = request(privateNote);
  const first = await verifyChatwootWebhook(delivery, provider, fetchInbox, ledger);
  await ledger.beginDispatch(first.claim);
  let sends = 0;
  const dispatching = await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis }));
  assert.deepEqual(dispatching, { status: 409, body: { error: 'dispatch_outcome_unknown' } });
  await ledger.finish(first.claim, 'ambiguous');
  const ambiguous = await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis }));
  assert.deepEqual(ambiguous, { status: 409, body: { error: 'dispatch_outcome_unknown' } });
  assert.equal(sends, 0);
});

test('a first-attempt transport error marks the dispatch ambiguous and remains an HTTP failure', async () => {
  const redis = new RedisContract();
  const ledger = createReplayLedger({ client: redis });
  const delivery = request(privateNote);
  let sends = 0;
  await assert.rejects(processChatwootWebhook(delivery, provider, () => {
    sends++;
    throw new Error('send failed');
  }, fetchInbox, ledger), /send failed/);
  assert.equal(sends, 1);
  assert.deepEqual(await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis })), { status: 409, body: { error: 'dispatch_outcome_unknown' } });
  assert.equal(sends, 1);
});

test('completed delivery alone receives idempotent 200; different body remains conflict', async () => {
  const redis = new RedisContract();
  const ledger = createReplayLedger({ client: redis });
  const delivery = request(privateNote);
  const first = await verifyChatwootWebhook(delivery, provider, fetchInbox, ledger);
  await ledger.beginDispatch(first.claim);
  await ledger.finish(first.claim, 'completed');
  let sends = 0;
  assert.deepEqual(await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis })), { status: 200, body: { message: 'delivery_completed' } });
  assert.deepEqual(await processChatwootWebhook(request({ ...privateNote, changed: true }), provider,
    () => { sends++; }, fetchInbox, createReplayLedger({ client: redis })),
  { status: 409, body: { error: 'delivery_identity_conflict' } });
  assert.equal(sends, 0);
});

test('Redis transition failure prevents side effect; completed write failure stays unresolved', async () => {
  const redis = new RedisContract();
  redis.failBegin = true;
  let sends = 0;
  const ledger = createReplayLedger({ client: redis });
  const delivery = request(privateNote);
  assert.deepEqual(await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox, ledger),
    { status: 503, body: { error: 'chatwoot_replay_store_unavailable' } });
  assert.equal(sends, 0);
  redis.failBegin = false;
  redis.nowMs += 31_000;
  redis.failFinalization = true;
  assert.deepEqual(await processChatwootWebhook(delivery, provider, () => { sends++; return { message: 'sent' }; },
    fetchInbox, createReplayLedger({ client: redis })),
  { status: 503, body: { error: 'dispatch_outcome_unknown' } });
  assert.equal(sends, 1);
  assert.deepEqual(await processChatwootWebhook(delivery, provider, () => { sends++; }, fetchInbox,
    createReplayLedger({ client: redis })), { status: 409, body: { error: 'dispatch_outcome_unknown' } });
  assert.equal(sends, 1);
});

test('missing or unavailable shared replay authority fails before send', async () => {
  const unavailable = new RedisContract();
  unavailable.isReady = false;
  assert.equal(await createReplayLedger({ client: unavailable }).ready(), false);
  assert.equal((await verifyChatwootWebhook(request(privateNote), provider, fetchInbox,
    createReplayLedger({ client: unavailable }))).status, 503);
  const evicting = new RedisContract();
  evicting.configGet = async () => ({ 'maxmemory-policy': 'allkeys-lru', appendonly: 'yes', appendfsync: 'always' });
  assert.equal((await verifyChatwootWebhook(request(privateNote), provider, fetchInbox,
    createReplayLedger({ client: evicting }))).status, 503);
  const previous = process.env.CACHE_REDIS_ENABLED;
  process.env.CACHE_REDIS_ENABLED = 'false';
  try {
    assert.equal((await verifyChatwootWebhook(request(privateNote), provider, fetchInbox,
      createReplayLedger())).status, 503);
  } finally {
    if (previous === undefined) delete process.env.CACHE_REDIS_ENABLED;
    else process.env.CACHE_REDIS_ENABLED = previous;
  }
});

test('rejects malformed, expired, foreign, and malformed outbound requests', async () => {
  const ledger = createReplayLedger({ client: new RedisContract() });
  const bad = [
    request(privateNote, { headers: { 'x-chatwoot-signature': undefined } }),
    request(privateNote, { headers: { 'x-chatwoot-timestamp': '1000000000' } }),
    request(privateNote, { headers: { 'x-chatwoot-delivery': 'bad' } }),
    request({ ...privateNote, account: { id: 99 } }),
    request({ ...privateNote, inbox: { id: 99 } }),
  ];
  for (const item of bad) assert.equal((await verifyChatwootWebhook(item, provider, fetchInbox, ledger)).ok, false);
  const malformed = request({ ...privateNote, private: false, message_type: 'outgoing' });
  assert.equal((await verifyChatwootWebhook(malformed, provider, fetchInbox, ledger)).status, 422);
});

test('interleaved providers retain their own credentials and inbox', async () => {
  let releaseA;
  const pausedA = new Promise((resolve) => { releaseA = resolve; });
  const service = isolateChatwoot({
    async process(config, pause) {
      this.provider = config;
      if (pause) await pausedA;
      return `${this.provider.token}:${this.provider.accountId}:${this.provider.inboxId}`;
    },
  });
  const a = service.process({ token: 'a', accountId: 1, inboxId: 13 }, true);
  const b = await service.process({ token: 'b', accountId: 2, inboxId: 99 }, false);
  releaseA();
  assert.equal(await a, 'a:1:13');
  assert.equal(b, 'b:2:99');
});

test('each event emission gets a signed ID, retry keeps object, QR is stripped', () => {
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'a'.repeat(40);
  const headers = { 'X-Nexi-Chatwoot-Inbox-Id': '13', 'X-Nexi-Chatwoot-Account-Id': '4' };
  const event = { event: 'qrcode.updated', instance: instanceName, date_time: 'same', apikey: 'do-not-send',
    data: { qrcode: { base64: 'secret-qr', code: 'qr-code' } } };
  const first = prepareEvent(headers, event, instanceName, 'instance-id');
  const second = prepareEvent(headers, event, instanceName, 'instance-id');
  assert.notEqual(first.headers['X-Nexi-Event-Id'], second.headers['X-Nexi-Event-Id']);
  const retryObject = first;
  assert.equal(retryObject.headers['X-Nexi-Event-Id'], first.headers['X-Nexi-Event-Id']);
  assert.equal(JSON.stringify(first.body).includes('secret-qr'), false);
  assert.equal(JSON.stringify(first.body).includes('do-not-send'), false);
  const secret = createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET)
    .update(`event:${instanceName}`).digest();
  const expected = createHmac('sha256', secret).update(`${first.headers['X-Nexi-Event-Timestamp']}.` +
    `${first.headers['X-Nexi-Event-Id']}.${instanceName}.instance-id.${JSON.stringify(first.body)}`).digest('hex');
  assert.equal(first.headers['X-Nexi-Event-Signature'], `sha256=${expected}`);
  assert.equal(eventKeyProof(instanceName), createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET)
    .update(`proof:${instanceName}`).digest('hex'));
  assert.equal(JSON.stringify(redactEventForLog({ event: 'qrcode.updated', instance: instanceName,
    apikey: 'do-not-log', data: { qrcode: { base64: 'secret-qr' } } })).includes('secret-qr'), false);
});
