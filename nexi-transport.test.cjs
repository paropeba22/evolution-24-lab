'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { isolateChatwoot, verifyChatwootWebhook, prepareEvent, eventKeyProof,
  redactEventForLog } = require('./nexi-transport.cjs');

const provider = { enabled: true, url: 'https://chatwoot.example', accountId: '4', token: 'server-token', nameInbox: 'Support' };
const inbox = { id: 13, name: 'Support', channel_type: 'Channel::Api', secret: 'webhook-secret' };
const fetchInbox = async () => ({ ok: true, json: async () => ({ payload: [inbox] }) });

function request(body, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', inbox.secret).update(timestamp).update('.').update(rawBody).digest('hex')}`;
  return {
    rawBody,
    body,
    headers: { 'x-chatwoot-timestamp': timestamp, 'x-chatwoot-signature': signature,
      'x-chatwoot-delivery': '10eb4a77-8c84-487c-a4bd-d2a915b21f44', ...overrides },
  };
}

test('valid signature, private note, and account/inbox binding', async () => {
  const body = { event: 'message_created', account: { id: 4 }, inbox: { id: 13 }, private: true };
  const result = await verifyChatwootWebhook(request(body), provider, fetchInbox);
  assert.equal(result.ok, true);
});

test('rejects missing, invalid, expired, foreign, and replayed deliveries', async () => {
  const body = { event: 'message_created', account: { id: 4 }, inbox: { id: 13 } };
  const cases = [
    request(body, { 'x-chatwoot-signature': undefined }),
    request(body, { 'x-chatwoot-signature': `sha256=${'0'.repeat(64)}` }),
    request(body, { 'x-chatwoot-timestamp': '1000000000' }),
    request({ ...body, inbox: { id: 99 } }),
    request({ ...body, account: { id: 99 } }),
  ];
  for (const item of cases) assert.equal((await verifyChatwootWebhook(item, provider, fetchInbox)).ok, false);
  assert.equal((await verifyChatwootWebhook(request(body), { ...provider, url: 'http://chatwoot.example' },
    fetchInbox)).ok, false);
  const repeated = request(body, { 'x-chatwoot-delivery': 'a37696c7-aefc-46a1-bfd9-77148a1af795' });
  assert.equal((await verifyChatwootWebhook(repeated, provider, fetchInbox)).ok, true);
  assert.equal((await verifyChatwootWebhook(repeated, provider, fetchInbox)).status, 409);
});

test('signed but malformed outbound message fails before dispatch', async () => {
  const malformed = request({ event: 'message_created', account: { id: 4 }, inbox: { id: 13 },
    message_type: 'outgoing', private: false },
  { 'x-chatwoot-delivery': '90c64624-e737-446e-9a10-39ca290e460e' });
  assert.equal((await verifyChatwootWebhook(malformed, provider, fetchInbox)).status, 422);
});

test('interleaved providers retain their own credentials and inbox', async () => {
  let releaseA;
  const pausedA = new Promise((resolve) => { releaseA = resolve; });
  const service = isolateChatwoot({
    async process(config, pause) {
      this.provider = config;
      if (pause) await pausedA;
      return `${this.provider.token}:${this.provider.accountId}:${this.provider.nameInbox}`;
    },
  });
  const a = service.process({ token: 'a', accountId: 1, nameInbox: 'A' }, true);
  const b = await service.process({ token: 'b', accountId: 2, nameInbox: 'B' }, false);
  releaseA();
  assert.equal(await a, 'a:1:A');
  assert.equal(b, 'b:2:B');
});

test('NEXI event carries only state metadata and authenticates exact body', () => {
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'a'.repeat(40);
  const prepared = prepareEvent({ 'X-Nexi-Chatwoot-Inbox-Id': '13', 'X-Nexi-Chatwoot-Account-Id': '4' },
    { event: 'qrcode.updated', instance: 'nexi-wa-example', apikey: 'do-not-send',
      data: { qrcode: { base64: 'secret-qr', code: 'qr-code' } } }, 'nexi-wa-example', 'instance-id');
  assert.equal(JSON.stringify(prepared.body).includes('secret-qr'), false);
  assert.equal(JSON.stringify(prepared.body).includes('do-not-send'), false);
  const secret = createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET).update('event:nexi-wa-example').digest();
  const expected = createHmac('sha256', secret).update(`${prepared.headers['X-Nexi-Event-Timestamp']}.nexi-wa-example.instance-id.${JSON.stringify(prepared.body)}`).digest('hex');
  assert.equal(prepared.headers['X-Nexi-Event-Signature'], `sha256=${expected}`);
  assert.equal(eventKeyProof('nexi-wa-example'),
    createHmac('sha256', process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET).update('proof:nexi-wa-example').digest('hex'));
  assert.equal(JSON.stringify(redactEventForLog({ event: 'qrcode.updated', instance: 'nexi-wa-example',
    apikey: 'do-not-log', data: { qrcode: { base64: 'secret-qr' } } })).includes('secret-qr'), false);
});
