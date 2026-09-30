'use strict';
// Synthetic fixtures only. No socket, database, Redis or WhatsApp connection.
const { createHmac } = require('node:crypto');
const financial = require('./nexi-financial-transport.cjs');
const master = 'synthetic-identity-test-secret-at-least-32-bytes';
function signedDto(service, number = '5511999999999', changes = {}) {
  service.client ||= {};
  service.client.authState ||= { creds: { me: { id: '5500000000000@s.whatsapp.net', lid: '200000000000001@lid' },
    registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } } };
  const data = { number, title: 'Pagamento da fatura', description: 'Synthetic', footer: 'Provider',
    buttons: [{ type: 'copy', displayText: 'Copiar PIX', copyCode: 'FINANCIAL_SECRET_NEVER_LOG' }], ...changes };
  const claims = Buffer.from(JSON.stringify([1, service.instance.name, service.instanceId, `${number}@s.whatsapp.net`,
    11, 1, 21, 1, 10, Date.now() + 120000, financial.dtoHash(data),
    require('./nexi-identity.cjs').sessionFingerprint(service.client.authState.creds)])).toString('base64url');
  const secret = createHmac('sha256', master).update(`event:${service.instance.name}`).digest();
  data.nexiRecipient = { claims, signature: createHmac('sha256', secret).update(`financial-recipient:v1:${claims}`).digest('hex') };
  return data;
}
function fakeLedger() {
  let state;
  return {
    async claim() { if (state) return { kind: 'duplicate', state }; state = 'dispatching'; return { kind: 'claimed' }; },
    async beginDispatch() { if (state !== 'reserved') throw new Error('boundary'); state = 'dispatching'; },
    async finish(_claim, result) { state = result; },
    get state() { return state; },
  };
}
async function withTestRecipient(service, operation, changes = {}, store = fakeLedger()) {
  const old = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  try { return await financial.withRecipient(service, signedDto(service, changes.number, changes), operation, store); }
  finally {
    if (old === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
    else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = old;
  }
}
module.exports = { signedDto, fakeLedger, master, withTestRecipient };
