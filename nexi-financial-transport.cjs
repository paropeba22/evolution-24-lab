'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, createHash, timingSafeEqual, randomBytes } = require('node:crypto');
const { sessionFingerprint } = require('./nexi-identity.cjs');
const recipientContext = new AsyncLocalStorage();
const ledger = require('./nexi-transport.cjs').createReplayLedger({ consumeOnClaim: true });

function dtoHash(data) {
  return createHash('sha256').update(JSON.stringify([data.number, data.title, data.description, data.footer,
    data.buttons.map(b => [b.type, b.displayText, b.copyCode ?? null, b.url ?? null])])).digest('hex');
}

async function withRecipient(service, data, operation, store = ledger) {
  if (!service.instance.name.startsWith('nexi-wa-') ||
      (!data.nexiRecipient && !data.buttons?.some(b => ['copy', 'url', 'pix'].includes(b.type)))) {
    return operation();
  }
  const fail = () => { throw new Error('nexi_financial_recipient_unverified'); };
  const token = data.nexiRecipient;
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32 || typeof token?.claims !== 'string' || token.claims.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(token.claims) || !/^[a-f0-9]{64}$/.test(token.signature || '')) fail();
  const secret = createHmac('sha256', master).update(`event:${service.instance.name}`).digest();
  const expected = createHmac('sha256', secret).update(`financial-recipient:v1:${token.claims}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(token.signature, 'hex'))) fail();
  let c;
  try { c = JSON.parse(Buffer.from(token.claims, 'base64url').toString('utf8')); } catch { fail(); }
  // Version, instance, JID, ledger revision, delivery, tenant, deadline, DTO hash.
  if (!Array.isArray(c) || c.length !== 12 || c[0] !== 1 || c[1] !== service.instance.name || c[2] !== service.instanceId ||
      !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(c[3]) || `${data.number}@s.whatsapp.net` !== c[3] ||
      !Number.isSafeInteger(c[4]) || c[4] <= 0 || !Number.isSafeInteger(c[5]) || c[5] <= 0 ||
      !Number.isSafeInteger(c[6]) || c[6] <= 0 || !Number.isSafeInteger(c[7]) || c[7] <= 0 ||
      !Number.isSafeInteger(c[8]) || c[8] <= 0 || !Number.isSafeInteger(c[9]) ||
      c[9] <= Date.now() || c[9] > Date.now() + 300000 || c[10] !== dtoHash(data) ||
      Object.keys(data).some(k => !['number', 'title', 'description', 'footer', 'buttons', 'nexiRecipient'].includes(k)) ||
      data.buttons.length !== 1 || !['copy', 'url'].includes(data.buttons[0].type) ||
      !/^[a-f0-9]{64}$/.test(c[11] || '') || c[11] !== sessionFingerprint(service.client?.authState?.creds)) fail();
  const claim = await store.claim(c[1], c[7], c[8], String(c[6]), JSON.stringify(c));
  if (claim.kind !== 'claimed') fail();
  const state = { instance: service.instance.name, instanceId: service.instanceId, jid: c[3], deadline: c[9],
    session: c[11], credentials: () => service.client?.authState?.creds,
    currentBinding: () => service.instance.name === c[1] && service.instanceId === c[2], claim, store, crossed: false };
  return recipientContext.run(state, async () => {
    try {
      const result = await operation();
      await store.finish(claim, 'completed');
      return result;
    } catch {
      await store.finish(claim, 'ambiguous').catch(() => {});
      throw new Error('nexi_financial_transport_failed');
    }
  });
}

function assertRecipient(instance, message, recipient, instanceId) {
  const state = recipientContext.getStore();
  if (!isManagedCta(instance, message) && !state) return;
  if (!state || state.instance !== instance || state.instanceId !== instanceId || state.deadline <= Date.now() ||
      !state.currentBinding() || sessionFingerprint(state.credentials()) !== state.session ||
      recipient !== state.jid) throw new Error('nexi_financial_recipient_mismatch');
}

function managedLookup(instance) { return recipientContext.getStore()?.instance === instance; }
function currentOperation() { return !!recipientContext.getStore(); }
// A reserved, runtime-generated WA message ID survives encryption, fromMe
// echoes, cache storage keys and DB reconstruction. It is a denial marker,
// never authority, and contains no financial value or recipient information.
const financialIdPrefix = '3EB0F1A9C7D5E3B1';
function socketConfig(instance, config) {
  return { ...config, nexiFinancialManaged: instance.startsWith('nexi-wa-') };
}
function nativeFinancial(managed, key, message) {
  return managed === true && (typeof key?.id === 'string' && key.id.startsWith(financialIdPrefix) ||
    isManagedCta('nexi-wa-runtime', message));
}
function relayMessageId(managed, id, message) {
  const state = recipientContext.getStore();
  if (state) {
    state.messageId ||= financialIdPrefix + randomBytes(8).toString('hex').toUpperCase();
    return state.messageId;
  }
  if (nativeFinancial(managed, { id }, message)) throw new Error('nexi_financial_native_retry_denied');
  return id;
}
function retryMessage(instance, message, key) {
  if (nativeFinancial(instance.startsWith('nexi-wa-'), key, message)) return undefined;
  if (instance.startsWith('nexi-wa-') && (isManagedCta(instance, message) ||
      !message || message.conversation === '' || message.conversation === 'NEXI financial delivery')) return undefined;
  return message;
}
function assertWireRecipient(jid, stanza, credentials, message, managed = false) {
  const state = recipientContext.getStore();
  if (!state) {
    if (nativeFinancial(managed, stanza?.attrs, message)) throw new Error('nexi_financial_native_retry_denied');
    return;
  }
  const self = credentials?.me;
  if (state.deadline <= Date.now() || jid !== state.jid || stanza?.attrs?.to !== state.jid ||
      !state.currentBinding() || sessionFingerprint(credentials) !== state.session ||
      sessionFingerprint(state.credentials()) !== state.session ||
      stanza.attrs.participant || stanza.attrs.recipient) throw new Error('nexi_financial_recipient_mismatch');
  const base = value => typeof value === 'string' ? value.replace(/:\d+(?=@)/, '') : null;
  const own = new Set([base(self?.id), base(self?.lid)].filter(Boolean));
  // Cached device fanout must not introduce another peer or an unproved LID.
  // Own authenticated companion identities are separate, explicit recipients.
  const recipients = stanza.content?.filter(n => n.tag === 'participants').flatMap(n => n.content || []) || [];
  for (const recipient of recipients) {
    const target = base(recipient.attrs?.jid);
    if (target !== state.jid && !own.has(target)) throw new Error('nexi_financial_recipient_mismatch');
  }
}
function resolutionInput(instance, number, instanceId) {
  const state = recipientContext.getStore();
  if (!state || state.instance !== instance || state.instanceId !== instanceId || state.deadline <= Date.now() ||
      !state.currentBinding() || sessionFingerprint(state.credentials()) !== state.session ||
      `${number}@s.whatsapp.net` !== state.jid) {
    throw new Error('nexi_financial_recipient_unverified');
  }
  // A transport-proven PN is already a complete logical JID. Do not guess BR,
  // MX or AR number variants; the subsequent resolver/cache is still checked.
  return state.jid;
}

async function beginRelay(instance, message, recipient, instanceId) {
  assertRecipient(instance, message, recipient, instanceId);
  if (!isManagedCta(instance, message) && !recipientContext.getStore()) return;
  const state = recipientContext.getStore();
  if (state.crossed) throw new Error('nexi_financial_duplicate_relay');
  // Claim already atomically consumed this signed operation in Redis. Even
  // pre-relay failures cannot reopen it or authorize an automatic retry.
  state.crossed = true;
  assertRecipient(instance, message, recipient, instanceId);
}

// Classification limits redaction scope; it is never destination authority.
function isManagedCta(instanceName, message) {
  let content = message;
  for (let depth = 0; depth < 8; depth++) {
    const inner = content?.viewOnceMessage?.message || content?.viewOnceMessageV2?.message ||
      content?.viewOnceMessageV2Extension?.message || content?.ephemeralMessage?.message || content?.deviceSentMessage?.message;
    if (!inner) break;
    content = inner;
  }
  return typeof instanceName === 'string' && instanceName.startsWith('nexi-wa-') &&
    content?.interactiveMessage?.nativeFlowMessage?.buttons?.some(
      (button) => button.name === 'cta_copy' || button.name === 'cta_url',
    ) === true;
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

function failureMetadata(instanceId, messageId, stage, error) {
  // Never read message, stack, toString, request, body or Prisma arguments.
  const category = ['P2002', 'P2003', 'P2025'].includes(error?.code) ? 'persistence' :
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code) ? 'transport' : 'unknown';
  return { code: 'nexi_financial_transport_failed', operation: 'sendButtons',
    instanceId: safeId(instanceId), deliveryId: safeId(messageId),
    stage: ['lookup', 'dispatch', 'persistence', 'webhook', 'response'].includes(stage) ? stage : 'unknown',
    category, status: 400 };
}

module.exports = { isManagedCta, failureMetadata, withRecipient, assertRecipient, beginRelay, dtoHash, managedLookup, resolutionInput,
  currentOperation, retryMessage, assertWireRecipient, socketConfig, nativeFinancial, relayMessageId };
