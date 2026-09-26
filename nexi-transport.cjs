'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, createHash, timingSafeEqual } = require('node:crypto');

const context = new AsyncLocalStorage();
const replay = new Map();
const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_REPLAY = 10_000;

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

async function verifyChatwootWebhook(request, provider, fetchImpl = fetch) {
  const fail = (status = 401) => ({ ok: false, status });
  if (!provider?.enabled || !provider.url || !provider.accountId || !provider.token || !provider.nameInbox) return fail();
  const raw = request.rawBody;
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 1_048_576) return fail();

  const timestamp = request.headers['x-chatwoot-timestamp'];
  const signature = request.headers['x-chatwoot-signature'];
  const delivery = request.headers['x-chatwoot-delivery'];
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature) ||
      typeof delivery !== 'string' || !/^[0-9a-f-]{36}$/i.test(delivery)) return fail();
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
    const matches = data?.payload?.filter((item) => item.name === provider.nameInbox &&
      item.channel_type === 'Channel::Api');
    if (!Array.isArray(matches) || matches.length !== 1) return fail();
    inbox = matches[0];
  } catch {
    return fail(503);
  }
  if (!inbox?.secret || !Number.isSafeInteger(inbox.id)) return fail();

  const expected = 'sha256=' + createHmac('sha256', inbox.secret).update(timestamp).update('.').update(raw).digest('hex');
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

  const key = createHash('sha256').update(String(provider.accountId)).update(':').update(String(inbox.id))
    .update(':').update(delivery).digest('hex');
  const now = Date.now();
  for (const [seen, expires] of replay) if (expires <= now) replay.delete(seen);
  if (replay.has(key)) return fail(409);
  if (replay.size >= MAX_REPLAY) replay.delete(replay.keys().next().value);
  replay.set(key, now + MAX_SKEW_MS);
  return { ok: true, status: 200 };
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
  const secret = createHmac('sha256', master).update(`event:${instanceName}`).digest();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${instanceName}.${instanceId}.${JSON.stringify(payload)}`).digest('hex');
  return {
    headers: { ...headers, 'X-Nexi-Event-Timestamp': timestamp,
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

module.exports = { isolateChatwoot, verifyChatwootWebhook, prepareEvent, eventSigningReady, eventKeyProof, redactEventForLog };
