'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const context = new AsyncLocalStorage();
const MAX_SKEW_MS = 5 * 60 * 1000;
const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;
const RESERVED_LEASE_MS = 30 * 1000;

const CLAIM_SCRIPT = `
local key, hash, owner = KEYS[1], ARGV[1], ARGV[2]
local lease_ms, ttl = tonumber(ARGV[3]), tonumber(ARGV[4])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local existing = redis.call('GET', key)
if not existing then
  local value = cjson.encode({state='reserved', bodyHash=hash, ownerToken=owner, reservedUntilMs=now+lease_ms})
  local set_result = redis.call('SET', key, value, 'NX', 'EX', ttl)
  if type(set_result) == 'table' and set_result.ok == 'OK' then return 'claimed' end
  return 'inconsistent'
end
local ok, record = pcall(cjson.decode, existing)
if not ok or type(record) ~= 'table' or type(record.state) ~= 'string' or type(record.bodyHash) ~= 'string' then return 'inconsistent' end
if record.bodyHash ~= hash then return 'identity_conflict' end
if record.state == 'reserved' then
  if type(record.reservedUntilMs) ~= 'number' or type(record.ownerToken) ~= 'string' then return 'inconsistent' end
  if record.reservedUntilMs > now then return 'active_reserved' end
  record.ownerToken, record.reservedUntilMs = owner, now + lease_ms
  local set_result = redis.call('SET', key, cjson.encode(record), 'XX', 'KEEPTTL')
  if type(set_result) == 'table' and set_result.ok == 'OK' then return 'claimed' end
  return 'inconsistent'
end
if record.state == 'dispatching' or record.state == 'completed' or record.state == 'ambiguous' then return record.state end
return 'inconsistent'
`;

const BEGIN_SCRIPT = `
local key, hash, owner = KEYS[1], ARGV[1], ARGV[2]
local existing = redis.call('GET', key)
if not existing then return 'lost_ownership' end
local ok, record = pcall(cjson.decode, existing)
if not ok or type(record) ~= 'table' then return 'inconsistent' end
if record.state ~= 'reserved' or record.bodyHash ~= hash or record.ownerToken ~= owner then return 'lost_ownership' end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if type(record.reservedUntilMs) ~= 'number' or record.reservedUntilMs <= now then return 'lost_ownership' end
record.state, record.reservedUntilMs = 'dispatching', cjson.null
local set_result = redis.call('SET', key, cjson.encode(record), 'XX', 'KEEPTTL')
if type(set_result) == 'table' and set_result.ok == 'OK' then return 'dispatching' end
return 'inconsistent'
`;

const FINISH_SCRIPT = `
local key, hash, owner, target = KEYS[1], ARGV[1], ARGV[2], ARGV[3]
local existing = redis.call('GET', key)
if not existing then return 'inconsistent' end
local ok, record = pcall(cjson.decode, existing)
if not ok or type(record) ~= 'table' then return 'inconsistent' end
if record.state ~= 'dispatching' or record.bodyHash ~= hash or record.ownerToken ~= owner then return 'inconsistent' end
record.state = target
local set_result = redis.call('SET', key, cjson.encode(record), 'XX', 'KEEPTTL')
if type(set_result) == 'table' and set_result.ok == 'OK' then return target end
return 'inconsistent'
`;

function createReplayLedger({ client: suppliedClient, prefix = process.env.CACHE_REDIS_PREFIX_KEY || 'evolution-cache',
  ttlSeconds = DELIVERY_TTL_SECONDS, reservedLeaseMs = RESERVED_LEASE_MS } = {}) {
  let client = suppliedClient;
  let connecting;

  async function connection() {
    if (!client) {
      if (process.env.CACHE_REDIS_ENABLED !== 'true' || !process.env.CACHE_REDIS_URI) {
        throw new Error('chatwoot_replay_store_not_configured');
      }
      const { createClient } = require('redis');
      client = createClient({ url: process.env.CACHE_REDIS_URI,
        socket: { connectTimeout: 3000, reconnectStrategy: false } });
      client.on('error', () => {}); // Each failed command is handled by its caller.
      connecting = client.connect().catch((error) => {
        client = undefined;
        connecting = undefined;
        throw error;
      });
    }
    if (connecting) await connecting;
    if (client.isReady === false) throw new Error('chatwoot_replay_store_unavailable');
    const settings = await client.configGet(['maxmemory-policy', 'appendonly', 'appendfsync']);
    const get = (name) => settings instanceof Map ? settings.get(name) : settings?.[name];
    if (get('maxmemory-policy') !== 'noeviction' || get('appendonly') !== 'yes' ||
        get('appendfsync') !== 'always') throw new Error('chatwoot_replay_store_not_durable');
    return client;
  }

  function keyFor(instanceName, accountId, inboxId, deliveryId) {
    const scope = JSON.stringify([instanceName, String(accountId), String(inboxId), deliveryId]);
    return `${prefix}:nexi:chatwoot-delivery:v1:${createHash('sha256').update(scope).digest('hex')}`;
  }

  return {
    async ready() {
      try {
        return await (await connection()).ping() === 'PONG';
      } catch {
        return false;
      }
    },
    async claim(instanceName, accountId, inboxId, deliveryId, rawBody) {
      const redis = await connection();
      const key = keyFor(instanceName, accountId, inboxId, deliveryId);
      const bodyHash = createHash('sha256').update(rawBody).digest('hex');
      const ownerToken = randomUUID();
      const state = await redis.eval(CLAIM_SCRIPT, { keys: [key],
        arguments: [bodyHash, ownerToken, String(reservedLeaseMs), String(ttlSeconds)] });
      if (state === 'claimed') return { kind: 'claimed', key, bodyHash, ownerToken };
      if (state === 'identity_conflict') return { kind: 'identity_conflict' };
      if (['active_reserved', 'dispatching', 'completed', 'ambiguous'].includes(state)) {
        return { kind: 'duplicate', state };
      }
      throw new Error('chatwoot_replay_store_inconsistent');
    },
    async beginDispatch(claim) {
      const redis = await connection();
      const result = await redis.eval(BEGIN_SCRIPT, { keys: [claim.key],
        arguments: [claim.bodyHash, claim.ownerToken] });
      if (result !== 'dispatching') throw new Error('chatwoot_delivery_dispatch_boundary_unavailable');
    },
    async finish(claim, state) {
      if (!['completed', 'ambiguous'].includes(state)) throw new Error('chatwoot_delivery_state_invalid');
      const redis = await connection();
      const result = await redis.eval(FINISH_SCRIPT, { keys: [claim.key],
        arguments: [claim.bodyHash, claim.ownerToken, state] });
      if (result !== state) throw new Error('chatwoot_replay_store_inconsistent');
    },
  };
}

const defaultLedger = createReplayLedger();

function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isolateChatwoot(service) {
  Object.defineProperty(service, 'provider', {
    configurable: false,
    get() { return context.getStore()?.provider; },
    set(value) {
      const store = context.getStore();
      if (!store) throw new Error('chatwoot_context_missing');
      store.provider = value;
    },
  });

  return new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args) => context.getStore()
        ? value.apply(target, args)
        : context.run({ provider: null }, () => value.apply(target, args));
    },
  });
}

function inboxMatches(inbox, provider, instanceName) {
  if (!inbox || inbox.channel_type !== 'Channel::Api') return false;
  if (inbox.account_id != null && String(inbox.account_id) !== String(provider.accountId)) return false;
  if (provider.inboxId) return String(inbox.id) === String(provider.inboxId);
  if (instanceName.startsWith('nexi-wa-')) return false;
  return inbox.name === provider.nameInbox;
}

function resolveConfiguredInbox(inboxes, provider, instanceName) {
  if (!Array.isArray(inboxes)) return null;
  return inboxes.find((inbox) => inboxMatches(inbox, provider, instanceName)) || null;
}

async function verifyChatwootWebhook(request, provider, fetchImpl = fetch, ledger = defaultLedger) {
  const fail = (status = 401) => ({ ok: false, status });
  const instanceName = request.params?.instanceName;
  if (!instanceName || !provider?.enabled || !provider.url || !provider.accountId || !provider.token) return fail();
  const managed = instanceName.startsWith('nexi-wa-');
  if (managed && !/^[1-9]\d{0,18}$/.test(String(provider.inboxId || ''))) return fail();
  if (!managed && !provider.inboxId && !provider.nameInbox) return fail();
  const raw = request.rawBody;
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 1_048_576) return fail();

  const timestamp = request.headers['x-chatwoot-timestamp'];
  const signature = request.headers['x-chatwoot-signature'];
  const delivery = request.headers['x-chatwoot-delivery'];
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature) ||
      typeof delivery !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(delivery)) return fail();
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > MAX_SKEW_MS) return fail();

  let inbox;
  try {
    const origin = new URL(provider.url);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) return fail();
    const url = new URL(`/api/v1/accounts/${encodeURIComponent(provider.accountId)}/inboxes`, origin);
    const response = await fetchImpl(url, {
      headers: { api_access_token: provider.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return fail(503);
    const data = await response.json();
    const matches = data?.payload?.filter((item) => inboxMatches(item, provider, instanceName));
    if (!Array.isArray(matches) || matches.length !== 1) return fail();
    inbox = matches[0];
  } catch {
    return fail(503);
  }
  if (!inbox?.secret || !Number.isSafeInteger(inbox.id)) return fail();

  const expected = 'sha256=' + createHmac('sha256', inbox.secret)
    .update(timestamp).update('.').update(delivery).update('.').update(raw).digest('hex');
  if (!equal(expected, signature)) return fail();

  const body = request.body;
  if (!body || (body.account != null && Number(body.account.id) !== Number(provider.accountId)) ||
      (body.inbox != null && Number(body.inbox.id) !== inbox.id)) return fail();
  if (['message_created', 'message_updated'].includes(body.event) && (!body.account || !body.inbox)) return fail();
  if (body.conversation?.inbox_id != null && Number(body.conversation.inbox_id) !== inbox.id) return fail();
  if (['message_created', 'message_updated'].includes(body.event) &&
      (body.message_type === 'outgoing' || body.message_type === 'template') && !body.private) {
    const sender = body.conversation?.meta?.sender;
    if (!sender || !(sender.identifier || sender.phone_number) ||
        !Array.isArray(body.conversation?.messages) || body.conversation.messages.length === 0) return fail(422);
  }

  try {
    const claim = await ledger.claim(instanceName, provider.accountId, inbox.id, delivery, raw);
    if (claim.kind === 'duplicate') return { ok: false, replay: true, state: claim.state };
    if (claim.kind === 'identity_conflict') return fail(409);
    return { ok: true, status: 200, claim };
  } catch {
    return fail(503);
  }
}

async function processChatwootWebhook(request, provider, execute, fetchImpl = fetch, ledger = defaultLedger) {
  const verified = await verifyChatwootWebhook(request, provider, fetchImpl, ledger);
  if (verified.replay) {
    if (verified.state === 'completed') return { status: 200, body: { message: 'delivery_completed' } };
    if (verified.state === 'active_reserved') return { status: 409, body: { error: 'delivery_in_progress' } };
    return { status: 409, body: { error: 'dispatch_outcome_unknown' } };
  }
  if (!verified.ok) return { status: verified.status,
    body: { error: verified.status === 503 ? 'chatwoot_replay_store_unavailable' :
      verified.status === 409 ? 'delivery_identity_conflict' : 'chatwoot_transport_auth_failed' } };
  try {
    await ledger.beginDispatch(verified.claim);
  } catch {
    return { status: 503, body: { error: 'chatwoot_replay_store_unavailable' } };
  }
  let result;
  try {
    result = await execute();
  } catch (error) {
    await ledger.finish(verified.claim, 'ambiguous').catch(() => {});
    throw error;
  }
  try {
    await ledger.finish(verified.claim, 'completed');
  } catch {
    return { status: 503, body: { error: 'dispatch_outcome_unknown' } };
  }
  return { status: 200, body: result };
}

function prepareEvent(headers, body, instanceName, instanceId) {
  if (!headers['X-Nexi-Chatwoot-Account-Id'] || !headers['X-Nexi-Chatwoot-Inbox-Id']) {
    return { headers, body };
  }
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) throw new Error('nexi_event_secret_missing');
  const payload = {
    event: body.event,
    instance: body.instance,
    date_time: body.date_time,
    data: body.event === 'qrcode.updated'
      ? { qrcode: { instance: instanceName } }
      : body.event === 'connection.update'
        ? { state: body.data?.state }
        : {},
  };
  const timestamp = String(Date.now());
  const eventId = randomUUID();
  const secret = createHmac('sha256', master).update(`event:${instanceName}`).digest();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.${instanceName}.${instanceId}.${JSON.stringify(payload)}`).digest('hex');
  return {
    headers: { ...headers, 'X-Nexi-Event-Timestamp': timestamp,
      'X-Nexi-Event-Id': eventId,
      'X-Nexi-Event-Signature': `sha256=${signature}` },
    body: payload,
  };
}

function eventSigningReady() {
  return Buffer.byteLength(process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '') >= 32;
}

function eventKeyProof(instanceName) {
  if (!eventSigningReady()) return null;
  return createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET)
    .update(`proof:${instanceName}`).digest('hex');
}

function redactEventForLog(body) {
  if (body.event === 'qrcode.updated') {
    return { event: body.event, instance: body.instance, data: { qrcode: { instance: body.instance } } };
  }
  return { ...body, apikey: undefined };
}

async function replayStoreReady() {
  return defaultLedger.ready();
}

module.exports = { isolateChatwoot, verifyChatwootWebhook, processChatwootWebhook, replayStoreReady, createReplayLedger,
  inboxMatches, resolveConfiguredInbox, prepareEvent, eventSigningReady, eventKeyProof, redactEventForLog };
