'use strict';

const { createHash } = require('node:crypto');
// Object identity is the capability. Neither a serializable flag nor notify
// alone can manufacture it. Only the patched CB:message decrypt path marks it.
const observations = new WeakMap();
const routing = new WeakMap();
const PN = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
// Device suffix removal is a deterministic parse of the authenticated raw
// stanza, not a cache alias, regional number guess or PN/LID equivalence.
function pnFromStanza(value) {
  const match = typeof value === 'string' && value.match(/^([1-9]\d{7,14})(?::\d{1,5})?@s\.whatsapp\.net$/);
  return match ? `${match[1]}@s.whatsapp.net` : null;
}
function lidFromStanza(value) {
  const match = typeof value === 'string' && value.match(/^(\d{1,20})(?::\d{1,5})?@lid$/);
  return match ? `${match[1]}@lid` : null;
}

function sessionFingerprint(credentials) {
  const self = credentials?.me, publicKey = credentials?.signedIdentityKey?.public;
  if (!self?.id || !Number.isSafeInteger(credentials.registrationId) || credentials.registrationId <= 0 ||
      !(publicKey instanceof Uint8Array) || publicKey.length !== 32) return null;
  const publicKeyHash = createHash('sha256').update(publicKey).digest('hex');
  return createHash('sha256').update(JSON.stringify([self.id, self.lid || null,
    credentials.registrationId, publicKeyHash])).digest('hex');
}

function observeDecrypted(message, node, credentials, history) {
  const self = credentials?.me;
  const a = node?.attrs;
  const key = message?.key;
  if (!a || !key || key.fromMe !== false || a.offline || a.recipient || a.participant ||
      a.category === 'peer' || message.category === 'peer' || history || message.messageStubType != null ||
      message.messageStubParameters?.length || !message.message || message.broadcast ||
      message.message.protocolMessage || message.message.editedMessage ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(a.id || '') || key.id !== a.id || key.remoteJid !== a.from) return;
  // Accept only stanza-supplied PN/LID, never peer_recipient_* or a cache.
  const fromPn = pnFromStanza(a.from), fromLid = lidFromStanza(a.from);
  const pn = PN.test(fromPn || '') ? fromPn : fromLid ? pnFromStanza(a.sender_pn) : null;
  const lid = fromLid || lidFromStanza(a.sender_lid);
  if (!PN.test(pn || '') || (fromPn && a.sender_pn && pnFromStanza(a.sender_pn) !== pn) ||
      !self?.id || !credentials.signedIdentityKey?.public ||
      (lid && (fromLid ? pnFromStanza(key.remoteJidAlt) !== pn : lidFromStanza(key.remoteJidAlt) !== lid))) return;
  // Only a digest of the public session identity leaves this process.
  const session = sessionFingerprint(credentials);
  if (!session) return;
  observations.set(message, Object.freeze({ version: 1, origin: 'baileys.cb_message.decrypt',
    external_message_id: a.id, pn_jid: pn, lid_jid: lid, session_identity: session }));
}

function take(message, type, requestId) {
  const observation = observations.get(message);
  observations.delete(message);
  return type === 'notify' && !requestId && message?.key?.fromMe === false &&
    message.messageStubType == null && !message.messageStubParameters?.length && !message.broadcast &&
    message.message && !message.message.protocolMessage && !message.message.editedMessage &&
    message.key.id === observation?.external_message_id ? observation : null;
}

function bind(body, association) { routing.set(body, Object.freeze(association)); }
function associationFor(body) { return routing.get(body); }

async function managedObservation(service, observation, acknowledgement, fetchImpl = fetch) {
  const webhook = await service.prismaRepository.webhook.findUnique({ where: { instanceId: service.instanceId } });
  if (!webhook?.enabled || webhook.webhookByEvents || webhook.webhookBase64) throw new Error('nexi_identity_binding_unavailable');
  const url = new URL(webhook.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/webhooks/nexi/channels/evolution') throw new Error('nexi_identity_binding_unavailable');
  const headers = webhook.headers || {};
  const account = Number(headers['X-Nexi-Chatwoot-Account-Id']);
  const inbox = Number(headers['X-Nexi-Chatwoot-Inbox-Id']);
  if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(inbox) || inbox <= 0) {
    throw new Error('nexi_identity_binding_unavailable');
  }
  const event = acknowledgement ? 'identity.correlated' : 'identity.observed';
  const data = { ...observation, account_id: account, inbox_id: inbox };
  if (acknowledgement) data.ack = acknowledgement;
  const transport = require('./nexi-transport.cjs');
  const prepared = transport.prepareEvent(headers, { event, instance: service.instance.name, data },
    service.instance.name, service.instanceId);
  // Bounded retries only for the signed metadata request. Never retry CW
  // message creation or a WhatsApp send after an uncertain external response.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: transport.freshEventHeaders(prepared.headers, prepared.body),
        body: JSON.stringify(prepared.body), signal: AbortSignal.timeout(10000) });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) throw new Error('nexi_identity_rejected');
    } catch (error) {
      if (error.message === 'nexi_identity_rejected') throw error;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt + Math.random() * 500));
  }
  throw new Error('nexi_identity_unavailable');
}

module.exports = { observeDecrypted, take, bind, associationFor, managedObservation, sessionFingerprint };
