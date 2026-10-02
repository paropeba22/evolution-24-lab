'use strict';

const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const identity = require('./nexi-identity.cjs');
const transport = require('./nexi-transport.cjs');
const raw = new WeakMap();
const provenance = Symbol('nexi.groups.source');
const privacyScope = new AsyncLocalStorage();
const groupReadScope = new AsyncLocalStorage();
const MAX_ATTEMPTS = 12;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GROUP = /^\d{5,20}(?:-\d{5,20})?@g\.us$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const events = new Set(['group.session.proved', 'group.message.observed', 'group.message.redacted', 'group.metadata.invalidated', 'group.metadata.snapshot']);
const managed = name => typeof name === 'string' && name.startsWith('nexi-wa-');
const isGroup = jid => typeof jid === 'string' && GROUP.test(jid);
const groupLike = jid => typeof jid === 'string' && jid.includes('@g.us');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function groupEventPayload(event, data) {
  if (!events.has(event)) return null;
  if (data?.version !== 1 || !HASH.test(data.session_identity || '')) throw new Error('nexi_groups_event_invalid');
  return data;
}

function groupSource(value) {
  if (!value || typeof value !== 'object') return false;
  if (value[provenance] || value.isGroup === true) return true;
  if (value.attrs?.type === 'group') return true;
  if (Array.isArray(value)) return value.some(groupSource);
  return Object.entries(value).some(([key, child]) =>
    (['from', 'to', 'id', 'jid', 'remoteJid', 'groupJid', 'group_jid', 'group-jid', 'chatId'].includes(key) && groupLike(child)) ||
    (child && typeof child === 'object' && groupSource(child)));
}

// Called at the derivation site, before buffering can combine a participant
// update with a legitimate direct update for the same PN/LID.
function deriveContact(message, contact) {
  if (groupSource(message)) Object.defineProperty(contact, provenance, { value: true, enumerable: true });
  return contact;
}

function packetLogger(logger, node, isManaged) {
  if (!isManaged || !groupSource(node)) return logger;
  return new Proxy(logger, { get(target, key) {
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(key)) {
      return () => target[key]?.('nexi_groups_packet_filtered');
    }
    return target[key];
  } });
}

function privacyLogger(logger, isManaged) {
  if (!isManaged) return logger;
  return new Proxy(logger, { get(target, key) {
    if (key === 'child') return (...args) => privacyLogger(target.child(...args), true);
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(key)) return (...args) => {
      const contains = value => typeof value === 'string' ? value.includes('@g.us')
        : value && typeof value === 'object' && !ArrayBuffer.isView(value) && Object.values(value).some(contains);
      if (privacyScope.getStore() || args.some(value => groupSource(value) || contains(value))) {
        return target[key]('nexi_groups_packet_filtered');
      }
      return target[key](...args);
    };
    return target[key];
  } });
}

function withPacketScope(node, isManaged, work) {
  return privacyScope.run(isManaged && groupSource(node), work);
}

function groupRead(work) {
  return privacyScope.run(true, () => groupReadScope.run(true, work));
}

function guardSocket(socket, isManaged) {
  if (!isManaged) return socket;
  const targetIndexes = { sendMessage: 0, relayMessage: 0, chatModify: 1, sendPresenceUpdate: 1,
    readMessages: 0, sendReceipt: 0, sendReceipts: 0, updateBlockStatus: 0, rejectCall: 1,
    star: 0, updateMediaMessage: 0, onWhatsApp: 0, fetchStatus: 0, profilePictureUrl: 0,
    groupParticipantsUpdate: 0, groupLeave: 0, groupUpdateSubject: 0, groupUpdateDescription: 0,
    groupSettingUpdate: 0, groupToggleEphemeral: 0 };
  return new Proxy(socket, { get(target, key) {
    const original = target[key];
    if (typeof original !== 'function') return original;
    if (String(key).startsWith('group')) return (...args) => {
      if (!['groupMetadata', 'groupFetchAllParticipating'].includes(key) || !groupReadScope.getStore()) {
        throw new Error('nexi_groups_outbound_disabled_wave1');
      }
      return original.apply(target, args);
    };
    if (!(key in targetIndexes)) return original;
    return (...args) => {
      const candidate = args[targetIndexes[key]];
      validateTargets(true, { target: typeof candidate === 'string' ? { jid: candidate } : candidate });
      return original.apply(target, args);
    };
  } });
}

async function metadataWatermark(service) {
  const binding = managed(service.instance.name) ? await bindingFor(service) : null;
  return { session: identity.sessionFingerprint(service.instance?.authState?.state?.creds) || 'unproved',
    instanceId: service.instanceId, name: service.instance.name, generation: binding?.generation, revision: binding?.revision };
}
async function metadataCurrent(service, watermark) {
  const current = await metadataWatermark(service);
  return current.session === watermark.session && current.instanceId === watermark.instanceId && current.name === watermark.name &&
    current.generation === watermark.generation && current.revision === watermark.revision;
}

function admissionError() {
  const error = new Error('nexi_groups_admission_suspended');
  error.code = 'NEXI_GROUPS_ADMISSION_SUSPENDED';
  return error;
}

async function admit(config, message, node, credentials, history, protocolTypes) {
  if (!config.nexiFinancialManaged || !groupLike(node?.attrs?.from)) return;
  observeDecrypted(message, node, credentials, history, protocolTypes);
  const projection = take(message, 'notify');
  if (!projection) return;
  try {
    if (typeof config.nexiGroupsAdmit !== 'function') throw admissionError();
    await config.nexiGroupsAdmit(projection);
  } catch {
    const error = admissionError();
    throw error;
  }
}

async function admitProjection(service, projection) {
  return service.prismaRepository.$transaction(async tx => {
    const binding = await bindingFor({ ...service, prismaRepository: tx });
    const room = binding?.rooms?.[projection.group_jid];
    if (!binding || !room?.enabled) return; // explicitly outside admitted authority
    if (projection.session_identity !== binding.sessionIdentity) throw admissionError();
    // Take a DB write lock via CAS in the same transaction as enqueue. A revoke
    // cannot race admission into an incompatible binding or room generation.
    const fence = await tx.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId,
      revision: binding.revision, generation: binding.generation, sessionIdentity: binding.sessionIdentity, state: 'active' },
    data: { revision: { increment: 1 } } });
    if (fence.count !== 1) throw admissionError();
    await enqueue({ ...service, prismaRepository: tx }, binding, { ...projection, room_generation: room.generation },
      [projection.event, projection.group_jid, projection.source_id]);
    if (projection.reason === 'local_left') {
      const result = await tx.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId,
        revision: binding.revision + 1, generation: binding.generation, sessionIdentity: binding.sessionIdentity },
      data: { rooms: { ...binding.rooms, [projection.group_jid]: { ...room, enabled: false } }, revision: { increment: 1 } } });
      if (result.count !== 1) throw admissionError();
    }
  });
}

function participant(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,20})(?::\d{1,5})?@(s\.whatsapp\.net|lid)$/);
  return match ? `${match[1]}@${match[2]}` : null;
}

// rc13 participants are objects. A LID's numeric portion is never a phone.
function participants(values) {
  if (!Array.isArray(values) || values.length > 2048) throw new Error('nexi_groups_participants_invalid');
  return values.map(value => {
    const id = participant(value?.id);
    if (!id) throw new Error('nexi_groups_participant_invalid');
    const pn = participant(value.phoneNumber);
    const lid = participant(value.lid);
    return { id, alternate_id: id.endsWith('@lid') && pn?.endsWith('@s.whatsapp.net') ? pn
      : id.endsWith('@s.whatsapp.net') && lid?.endsWith('@lid') ? lid : null,
    admin: value.admin === 'admin' || value.admin === 'superadmin',
    display_name: typeof value.name === 'string' ? value.name.slice(0, 128) : null };
  });
}

function seconds(value) {
  const number = Number(value?.toNumber ? value.toNumber() : value);
  return Number.isSafeInteger(number) && number > 0 && number <= 4102444800 ? number : null;
}

function content(message, groupJid) {
  // Ephemeral/view-once content is deliberately not persisted in Wave 1.
  if (message?.ephemeralMessage || message?.viewOnceMessage || message?.viewOnceMessageV2 || message?.viewOnceMessageV2Extension) {
    return { kind: 'unsupported', body: null, quote: null };
  }
  const text = message?.conversation ?? message?.extendedTextMessage?.text;
  const context = message?.extendedTextMessage?.contextInfo;
  const quote = ID.test(context?.stanzaId || '') && (!context.remoteJid || context.remoteJid === groupJid)
    ? { external_message_id: context.stanzaId, sender_id: participant(context.participant) } : null;
  return typeof text === 'string' && Buffer.byteLength(text) <= 16384
    ? { kind: 'text', body: text, quote }
    : { kind: 'unsupported', body: null, quote: null };
}

// This function is called only at the pinned, successfully decrypted CB node,
// BEFORE cleanMessage. Copying a public message object cannot copy provenance.
function observeDecrypted(message, node, credentials, history, protocolTypes) {
  const a = node?.attrs, key = message?.key;
  if (!a || !key || !isGroup(a.from) || a.from !== key.remoteJid || !ID.test(a.id || '') || key.id !== a.id ||
      a.category === 'peer' || history || message.broadcast || message.messageStubType != null ||
      !message.message) return;
  const sender = participant(a.participant), session = identity.sessionFingerprint(credentials), timestamp = seconds(a.t);
  if (!sender || sender !== participant(key.participant) || !session || !timestamp || typeof key.fromMe !== 'boolean') return;
  const alternate = sender.endsWith('@lid') ? participant(a.participant_pn || a.sender_pn)
    : participant(a.participant_lid || a.sender_lid);
  if (alternate && (alternate.endsWith('@lid') === sender.endsWith('@lid') || participant(key.participantAlt) !== alternate)) return;
  const self = [participant(credentials.me.id), participant(credentials.me.lid)];
  if (key.fromMe !== Boolean(self.includes(sender) || (alternate && self.includes(alternate)))) return;
  const protocol = message.message.protocolMessage || message.message.editedMessage?.message?.protocolMessage;
  if (protocol) {
    if (protocolTypes && [protocolTypes.REVOKE, protocolTypes.MESSAGE_EDIT].includes(protocol.type) &&
        ID.test(protocol.key?.id || '') && (!protocol.key.remoteJid || protocol.key.remoteJid === a.from)) {
      const targetSender = participant(protocol.key.participant);
      // rc13 does not authenticate moderator privilege. Support only self
      // mutations: explicit target participant or the author's own-key bit.
      if (targetSender ? ![sender, alternate].includes(targetSender) : protocol.key.fromMe !== true) return;
      raw.set(message, Object.freeze({ event: 'group.message.redacted', group_jid: a.from, session_identity: session,
        source_id: a.id, occurred_at: timestamp, target_message_id: protocol.key.id, actor_id: sender,
        target_sender_id: sender, target_sender_alternate_id: alternate || null, actor_from_me: key.fromMe,
        reason: protocol.type === protocolTypes.REVOKE ? 'deleted' : 'edited' }));
    }
    return;
  }
  if (message.message.editedMessage) return;
  raw.set(message, Object.freeze({ event: 'group.message.observed', group_jid: a.from, session_identity: session,
    source_id: a.id, occurred_at: timestamp, message: { external_message_id: a.id, sender_id: sender,
      sender_alternate_id: alternate || null, from_me: key.fromMe,
      display_name: typeof message.pushName === 'string' ? message.pushName.slice(0, 128) : null, ...content(message.message, a.from) } }));
}

function observeNotification(message, node, credentials) {
  const a = node?.attrs, session = identity.sessionFingerprint(credentials), timestamp = seconds(a?.t);
  if (!isGroup(a?.from) || !ID.test(a.id || '') || !session || !timestamp) return;
  // The public participant/update event has no notification ID. Retain the
  // authenticated raw ID and invalidate a snapshot; never invent member history.
  const self = [participant(credentials.me?.id), participant(credentials.me?.lid)].filter(Boolean);
  const left = Array.isArray(node.content) && node.content.some(child => ['remove', 'leave'].includes(child.tag) &&
    Array.isArray(child.content) && child.content.some(p => p.tag === 'participant' &&
      [p.attrs?.jid, p.attrs?.phone_number, p.attrs?.lid].some(id => self.includes(participant(id)))));
  raw.set(message, Object.freeze({ event: 'group.metadata.invalidated', group_jid: a.from,
    session_identity: session, source_id: a.id, occurred_at: timestamp, reason: left ? 'local_left' : 'notification' }));
}

function take(message, type, requestId) {
  const projection = raw.get(message);
  raw.delete(message);
  if (!projection || requestId || (projection.event !== 'group.metadata.invalidated' && type !== 'notify')) return null;
  return projection;
}

function denyOutbound(isManaged, jid) {
  validateTargets(isManaged, { jid }, jid);
}

function filterGeneric(name, data) {
  if (!managed(name)) return data;
  if (Array.isArray(data)) {
    const result = data.filter(value => !(typeof value === 'string' && groupLike(value)))
      .map(value => filterGeneric(name, value)).filter(value => value !== null);
    return result.length === data.length && result.every((value, index) => value === data[index]) ? data : result;
  }
  if (!data || typeof data !== 'object') return data;
  if (data[provenance] || data.isGroup === true) return null;
  if (['remoteJid', 'groupJid', 'group_jid', 'jid', 'id', 'chatId', 'from', 'to'].some(key => groupLike(data[key])) ||
      groupLike(data.key?.remoteJid) || groupLike(data.message?.protocolMessage?.key?.remoteJid)) return null;
  if (ArrayBuffer.isView(data) || data instanceof Date) return data;
  const result = {};
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    result[key] = filterGeneric(name, value);
    if (result[key] !== value) changed = true;
  }
  return changed ? result : data;
}

const targetFields = new Set(['chat', 'number', 'numbers', 'groupJid', 'group_jid', 'remoteJid', 'jid', 'jids',
  'chatId', 'id', 'identifier', 'source_id', 'to', 'recipient', 'participants', 'mentions']);
function normalizedGroup(target) {
  if (typeof target !== 'string') return false;
  if (groupLike(target)) return true;
  if (/@(s\.whatsapp\.net|lid|newsletter|broadcast)/.test(target)) return false;
  const number = target.replace(/:\d+/, '').replace(/[\s+()]/g, '').split(':')[0].split('@')[0];
  return (number.includes('-') && number.length >= 24) || number.replace(/\D/g, '').length >= 18;
}
function hasGroupTarget(value, targetContext = false) {
  if (typeof value === 'string') return targetContext && normalizedGroup(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => hasGroupTarget(child, targetContext));
  return Object.entries(value).some(([key, target]) => hasGroupTarget(target, targetFields.has(key)));
}
function validateTargets(isManaged, value, normalized) {
  if (isManaged && (hasGroupTarget(value) || (normalized !== undefined && normalizedGroup(normalized)))) {
    throw new Error('nexi_groups_outbound_disabled_wave1');
  }
  return normalized;
}

async function bindingFor(service) {
  const binding = await service.prismaRepository.nexiGroupControl.findUnique({ where: { instanceId: service.instanceId } });
  const session = identity.sessionFingerprint(service.instance?.authState?.state?.creds);
  return binding?.state === 'active' && session && binding.sessionIdentity === session ? binding : null;
}

async function enqueue(service, binding, projection, sourceKey) {
  if (!events.has(projection.event) || !HASH.test(projection.session_identity)) throw new Error('nexi_groups_event_invalid');
  const data = { version: 1, account_id: Number(binding.accountId), managed_channel_id: Number(binding.managedChannelId),
    binding_generation: binding.generation, ...projection };
  delete data.event;
  const payload = { event: projection.event, instance: service.instance.name, data };
  // Message IDs collide closed across session/generation/direction. Metadata
  // controls retain their explicit generation namespace.
  const sourceIdentity = hash(projection.event.startsWith('group.message.') ? sourceKey
    : [binding.generation, projection.session_identity, sourceKey]);
  const fingerprint = hash(projection.event === 'group.message.observed'
    ? { ...payload, data: { ...data, message: { ...data.message, display_name: null } } } : payload);
  const row = await service.prismaRepository.nexiGroupEventOutbox.upsert({
    where: { instanceId_sourceKey: { instanceId: service.instanceId, sourceKey: sourceIdentity } },
    create: { instanceId: service.instanceId, eventId: randomUUID(), sourceKey: sourceIdentity, fingerprint,
      payload, nextAttemptAt: new Date(), state: 'queued' }, update: {} });
  if (row.fingerprint !== fingerprint) throw new Error('nexi_groups_source_conflict');
  return row;
}

async function ingest(service, message, type, requestId) {
  if (!managed(service.instance.name) || !groupLike(message?.key?.remoteJid)) return false;
  // A group always terminates this branch, including unknown/malformed/history
  // or storage failures. The caller must not re-enter any direct handler.
  const projection = take(message, type, requestId);
  if (!projection) return true;
  await admitProjection(service, projection);
  return true;
}

async function interceptEvents(service, original) {
  if (!managed(service.instance.name)) return original;
  const result = { ...original };
  if (original['messages.upsert']) {
    const payload = original['messages.upsert'], direct = [];
    for (const message of payload.messages) {
      if (groupLike(message?.key?.remoteJid)) {
        try { await ingest(service, message, payload.type, payload.requestId); }
        catch { service.logger?.warn('nexi_groups_ingress_unavailable'); }
      } else direct.push(message);
    }
    result['messages.upsert'] = { ...payload, messages: direct };
  }
  // Metadata/member/photo events invalidate the instance+session cache. Public
  // deltas are NOT authoritative history; a bounded explicit snapshot reconciles.
  const ids = new Set();
  if (original['connection.update']?.connection === 'open') {
    try {
      const binding = await bindingFor(service);
      for (const [jid, room] of Object.entries(binding?.rooms || {})) if (room.enabled && isGroup(jid)) ids.add(jid);
    } catch { service.logger?.warn('nexi_groups_metadata_unavailable'); }
  }
  for (const key of ['groups.upsert', 'groups.update']) for (const value of original[key] || []) if (isGroup(value.id)) ids.add(value.id);
  if (isGroup(original['group-participants.update']?.id)) {
    try { participants(original['group-participants.update'].participants); } // rc13 object contract
    catch { service.logger?.warn('nexi_groups_participants_invalid'); }
    ids.add(original['group-participants.update'].id);
  }
  for (const value of original['contacts.update'] || []) if (isGroup(value.id)) ids.add(value.id);
  if (ids.size) {
    try {
      const binding = await bindingFor(service);
      for (const jid of ids) if (binding?.rooms?.[jid]?.enabled) {
        await enqueue(service, binding, { event: 'group.metadata.invalidated', session_identity: binding.sessionIdentity,
          group_jid: jid, room_generation: binding.rooms[jid].generation, source_id: randomUUID(),
          occurred_at: Math.floor(Date.now() / 1000), reason: 'public_event' }, ['invalidation', randomUUID()]);
      }
      if (binding) {
        const changed = await service.prismaRepository.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId,
        sessionIdentity: binding.sessionIdentity, generation: binding.generation },
        data: { catalogStale: true, revision: { increment: 1 } } });
        if (changed.count !== 1) throw new Error('nexi_groups_invalidation_superseded');
      }
    } catch { service.logger?.warn('nexi_groups_metadata_unavailable'); }
  }
  for (const key of ['groups.upsert', 'groups.update', 'group-participants.update']) delete result[key];
  for (const key of ['call', 'messages.update', 'message-receipt.update', 'chats.upsert', 'chats.update', 'chats.delete', 'contacts.upsert', 'contacts.update', 'labels.association']) {
    if (result[key]) result[key] = filterGeneric(service.instance.name, result[key]);
  }
  if (result.call?.length === 0) delete result.call;
  if (result['messaging-history.set']) result['messaging-history.set'] = filterGeneric(service.instance.name, result['messaging-history.set']);
  for (const key of ['presence.update', 'messages.delete']) if (result[key]) {
    result[key] = filterGeneric(service.instance.name, result[key]);
    if (result[key] === null) delete result[key];
  }
  return result;
}

async function endpoint(service) {
  const webhook = await service.prismaRepository.webhook.findUnique({ where: { instanceId: service.instanceId } });
  if (!webhook?.enabled || webhook.webhookByEvents || webhook.webhookBase64) throw new Error('nexi_groups_boundary_unavailable');
  const url = new URL(webhook.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/webhooks/nexi/channels/evolution') throw new Error('nexi_groups_boundary_unavailable');
  return { url, headers: webhook.headers || {} };
}

function controlClaims(service, dto, now = Date.now()) {
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (!managed(service.instance.name) || Buffer.byteLength(master) < 32 || typeof dto?.claims !== 'string' ||
      dto.claims.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(dto.claims) || !HASH.test(dto.signature || '')) throw new Error('nexi_groups_control_rejected');
  const secret = createHmac('sha256', master).update(`event:${service.instance.name}`).digest();
  const expected = createHmac('sha256', secret).update(`groups-control:v1:${dto.claims}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(dto.signature, 'hex'))) throw new Error('nexi_groups_control_rejected');
  const claims = JSON.parse(Buffer.from(dto.claims, 'base64url').toString());
  if (!claims || Object.keys(claims).sort().join(',') !== 'account_id,binding_generation,expires_at,external_instance_id,instance,managed_channel_id,operation,parameters,version' ||
      claims.version !== 1 || claims.instance !== service.instance.name || claims.external_instance_id !== service.instanceId ||
      !Number.isSafeInteger(claims.account_id) || claims.account_id <= 0 || !Number.isSafeInteger(claims.managed_channel_id) || claims.managed_channel_id <= 0 ||
      !Number.isSafeInteger(claims.binding_generation) || claims.binding_generation <= 0 || claims.binding_generation > 2147483647 ||
      !Number.isSafeInteger(claims.expires_at) || claims.expires_at < now || claims.expires_at > now + 60000 ||
      !['bootstrap', 'catalog', 'room'].includes(claims.operation) || !claims.parameters || typeof claims.parameters !== 'object' || Array.isArray(claims.parameters)) {
    throw new Error('nexi_groups_control_rejected');
  }
  return claims;
}

async function control(service, dto) {
  const claims = controlClaims(service, dto), boundary = await endpoint(service), p = claims.parameters;
  const instanceId = service.instanceId, instanceName = service.instance.name;
  if (String(claims.account_id) !== boundary.headers['X-Nexi-Chatwoot-Account-Id']) throw new Error('nexi_groups_control_rejected');
  const session = identity.sessionFingerprint(service.instance?.authState?.state?.creds);
  if (!session || service.client?.ws?.isOpen !== true) throw new Error('nexi_groups_session_unavailable');
  const store = service.prismaRepository;
  if (claims.operation === 'bootstrap') {
    if (Object.keys(p).join(',') !== 'nonce' || !HASH.test(p.nonce || '')) throw new Error('nexi_groups_control_rejected');
    const binding = await store.$transaction(async tx => {
      const previous = await tx.nexiGroupControl.findUnique({ where: { instanceId: service.instanceId } });
      if (previous && (previous.accountId !== String(claims.account_id) || previous.managedChannelId !== String(claims.managed_channel_id) ||
          previous.generation > claims.binding_generation || (previous.generation === claims.binding_generation &&
          (previous.sessionIdentity !== session || previous.nonce !== p.nonce)))) throw new Error('nexi_groups_control_rejected');
      let current = previous;
      if (!previous) current = await tx.nexiGroupControl.create({ data: { instanceId: service.instanceId,
        accountId: String(claims.account_id), managedChannelId: String(claims.managed_channel_id),
        generation: claims.binding_generation, sessionIdentity: session, nonce: p.nonce, state: 'active', rooms: {} } });
      else if (previous.generation !== claims.binding_generation) {
        const updated = await tx.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId,
          revision: previous.revision, generation: previous.generation }, data: { generation: claims.binding_generation,
          revision: { increment: 1 }, sessionIdentity: session, nonce: p.nonce, rooms: {}, catalog: [], catalogStale: true, catalogAt: null, state: 'active' } });
        if (updated.count !== 1) throw new Error('nexi_groups_control_conflict');
        current = await tx.nexiGroupControl.findUnique({ where: { instanceId: service.instanceId } });
      }
      await enqueue({ prismaRepository: tx, instanceId: service.instanceId, instance: service.instance }, current,
        { event: 'group.session.proved', session_identity: session, nonce: p.nonce }, ['bootstrap', p.nonce]);
      return current;
    });
    return { accepted: true };
  }
  const binding = await bindingFor(service);
  if (!binding || binding.generation !== claims.binding_generation || binding.accountId !== String(claims.account_id) ||
      binding.managedChannelId !== String(claims.managed_channel_id)) throw new Error('nexi_groups_control_rejected');
  if (claims.operation === 'catalog') {
    if (Object.keys(p).length) throw new Error('nexi_groups_control_rejected');
    // No photos or per-group network fanout. The persistent cache is already
    // scoped by instance+session; stale returns do not prove local membership.
    if (!binding.catalogAt || binding.catalogAt.getTime() < Date.now() - 15 * 60000) {
      const metadata = await groupRead(() => service.client.groupFetchAllParticipating());
      const catalog = Object.values(metadata).filter(m => isGroup(m.id) && !m.isCommunity && !m.isCommunityAnnounce)
        .map(m => ({ group_jid: m.id, name: typeof m.subject === 'string' ? m.subject.slice(0, 256) : '',
          participant_count: Array.isArray(m.participants) ? m.participants.length : 0 })).sort((a, b) => a.group_jid.localeCompare(b.group_jid));
      if (catalog.length > 2000) throw new Error('nexi_groups_catalog_limit');
      if (service.instanceId !== instanceId || service.instance.name !== instanceName ||
          identity.sessionFingerprint(service.instance?.authState?.state?.creds) !== session) throw new Error('nexi_groups_fetch_superseded');
      const result = await store.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId, generation: binding.generation,
        sessionIdentity: session, revision: binding.revision, state: 'active' },
        data: { catalog, catalogAt: new Date(), catalogStale: false, revision: { increment: 1 } } });
      if (result.count !== 1) throw new Error('nexi_groups_fetch_superseded');
      return { groups: catalog, stale: false };
    }
    return { groups: binding.catalog || [], stale: binding.catalogStale };
  }
  if (Object.keys(p).sort().join(',') !== 'enabled,group_jid,metadata_revision,room_generation' || !isGroup(p.group_jid) ||
      typeof p.enabled !== 'boolean' || !Number.isSafeInteger(p.room_generation) || p.room_generation <= 0 ||
      p.room_generation > 2147483647 || !Number.isSafeInteger(p.metadata_revision) || p.metadata_revision <= 0 ||
      p.metadata_revision > 2147483647) throw new Error('nexi_groups_control_rejected');
  let snapshot = null;
  if (p.enabled) {
    const meta = await groupRead(() => service.client.groupMetadata(p.group_jid));
    if (!meta || meta.id !== p.group_jid || meta.isCommunity || meta.isCommunityAnnounce) throw new Error('nexi_groups_room_unavailable');
    const members = participants(meta.participants), self = [participant(service.client.user?.id), participant(service.client.user?.lid)];
    if (!members.some(m => self.includes(m.id) || (m.alternate_id && self.includes(m.alternate_id)))) throw new Error('nexi_groups_membership_unavailable');
    snapshot = { group_jid: p.group_jid, name: typeof meta.subject === 'string' ? meta.subject.slice(0, 256) : '',
      participants: members, local_member: true };
  }
  await store.$transaction(async tx => {
    // CAS prevents concurrent JSON updates from dropping another room or
    // restoring an older authorization after a newer disable.
    const current = await tx.nexiGroupControl.findUnique({ where: { instanceId: service.instanceId } });
    const old = current?.rooms?.[p.group_jid];
    if (!current || current.generation !== binding.generation || current.sessionIdentity !== session || current.state !== 'active' ||
        service.instanceId !== instanceId || service.instance.name !== instanceName ||
        identity.sessionFingerprint(service.instance?.authState?.state?.creds) !== session ||
        (p.enabled && current.revision !== binding.revision) ||
        (old && (old.generation > p.room_generation || (old.generation === p.room_generation &&
        (old.enabled !== p.enabled || old.metadata_revision > p.metadata_revision))))) throw new Error('nexi_groups_control_rejected');
    const result = await tx.nexiGroupControl.updateMany({ where: { instanceId: service.instanceId, revision: current.revision },
      data: { revision: { increment: 1 }, rooms: { ...current.rooms, [p.group_jid]: {
        generation: p.room_generation, metadata_revision: p.metadata_revision, enabled: p.enabled } } } });
    if (result.count !== 1) throw new Error('nexi_groups_control_conflict');
    if (snapshot) await enqueue({ ...service, prismaRepository: tx, instanceId: service.instanceId, instance: service.instance }, binding,
      { event: 'group.metadata.snapshot', session_identity: session, ...snapshot, room_generation: p.room_generation,
        metadata_revision: p.metadata_revision }, ['snapshot', p.group_jid, p.room_generation, p.metadata_revision]);
  });
  return { accepted: true };
}

async function expireOutbox(db, instanceId) {
    const now = new Date();
    // Runs even with an unavailable webhook. Expired content is observable as
    // quarantined; opaque sourceKey/fingerprint/eventId are never purged.
    return db.updateMany({ where: { ...(instanceId ? { instanceId } : {}), state: 'queued',
      AND: [{ OR: [{ attempts: { gte: MAX_ATTEMPTS } }, { createdAt: { lte: new Date(+now - MAX_AGE_MS) } }] },
        { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }] },
    data: { state: 'quarantined', payload: {}, leaseToken: null, leaseUntil: null } });
}

async function drain(service, fetchImpl = fetch, limit = 20) {
    const db = service.prismaRepository.nexiGroupEventOutbox;
    await expireOutbox(db, service.instanceId);
    const boundary = await endpoint(service);
    for (let i = 0; i < limit; i++) {
      const clock = new Date();
      const eligible = { instanceId: service.instanceId, state: 'queued', nextAttemptAt: { lte: clock },
        attempts: { lt: MAX_ATTEMPTS }, createdAt: { gt: new Date(+clock - MAX_AGE_MS) },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: clock } }] };
      const row = await db.findFirst({ where: eligible, orderBy: { id: 'asc' } });
      if (!row) break;
      const token = randomUUID();
      const claim = await db.updateMany({ where: { id: row.id, ...eligible },
        data: { leaseToken: token, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
      if (claim.count !== 1) continue;
      try {
        const prepared = transport.prepareEvent(boundary.headers, row.payload, service.instance.name, service.instanceId);
        prepared.headers['X-Nexi-Event-Id'] = row.eventId;
        const response = await fetchImpl(boundary.url, { method: 'POST', redirect: 'error',
          headers: transport.freshEventHeaders(prepared.headers, row.payload), body: JSON.stringify(row.payload), signal: AbortSignal.timeout(10000) });
        if (response.ok || [400, 401, 403, 404, 409, 410, 422].includes(response.status)) {
          await db.updateMany({ where: { id: row.id, state: 'queued', leaseToken: token, leaseUntil: { gt: new Date() } }, data: { state: response.ok ? 'delivered' : 'rejected',
            payload: {}, leaseToken: null, leaseUntil: null } });
          continue;
        }
      } catch { /* Durable retry: exact UUID/body; never a transport send. */ }
      const terminal = row.attempts + 1 >= MAX_ATTEMPTS || Date.now() - +row.createdAt >= MAX_AGE_MS;
      await db.updateMany({ where: { id: row.id, state: 'queued', leaseToken: token, leaseUntil: { gt: new Date() } }, data: {
        ...(terminal ? { state: 'quarantined', payload: {} } : {}), leaseToken: null, leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6))) } });
      break;
    }
}

function installRoutes(router, monitor, guard, repository) {
  // Reject managed legacy group operations before validation, media download,
  // chatbot dispatch, read receipts or any WhatsApp network call.
  for (const prefix of ['group', 'message', 'chat', 'call']) router.use(`/${prefix}/:operation/:instanceName`, guard, (req, res, next) => {
    if (managed(req.params.instanceName) && (prefix === 'group' || hasGroupTarget(req.body) || hasGroupTarget(req.query))) {
      return res.status(403).json({ error: 'nexi_groups_outbound_disabled_wave1' });
    }
    return next();
  });
  router.post('/nexi/groups/control/:instanceName', guard, async (req, res) => {
    try {
      const service = monitor.waInstances[req.params.instanceName];
      if (!service || !managed(req.params.instanceName)) return res.status(404).json({ error: 'nexi_groups_instance_unavailable' });
      return res.json(await control(service, req.body));
    } catch { return res.status(422).json({ error: 'nexi_groups_control_rejected' }); }
  });
  const timer = setInterval(async () => {
    // Sweep EVERY instance, even disconnected/unloaded ones. Retention must not
    // depend on a live WhatsApp socket or a successfully configured webhook.
    try { await expireOutbox(repository.nexiGroupEventOutbox); }
    catch { console.warn('nexi_groups_retention_unavailable'); }
    for (const service of Object.values(monitor.waInstances)) if (managed(service?.instance?.name)) {
      try { await drain(service); } catch { service.logger?.warn('nexi_groups_outbox_unavailable'); }
    }
  }, 15000);
  timer.unref();
}

module.exports = { managed, isGroup, groupLike, participant, participants, observeDecrypted, observeNotification, take, groupEventPayload,
  denyOutbound, filterGeneric, hasGroupTarget, validateTargets, groupSource, deriveContact, packetLogger, privacyLogger,
  guardSocket, withPacketScope, metadataWatermark, metadataCurrent, admit, admitProjection,
  MAX_ATTEMPTS, MAX_AGE_MS, ingest, interceptEvents, bindingFor, enqueue, controlClaims, control, drain, expireOutbox, installRoutes, content };
