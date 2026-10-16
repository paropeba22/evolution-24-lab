'use strict';

const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const canonical = require('./nexi-canonical-json.cjs');
const runtime = () => require('./nexi-ingress.cjs').secondaryRuntime;
const MAX_PENDING = 10000, CONCURRENT = 2, LEASE_MS = 60000, MAX_RESULT = 8 * 1024 * 1024;
const terminal = ['succeeded', 'outcome_unknown', 'blocked_contract', 'blocked_dependency'];
let active = 0, pumping = false, queued = false, cursor = 0;
const instanceActive = new Map();
const retaining = new Set();
const fail = code => { throw Object.assign(new Error(code), { code }); };
function signature(name, intent) {
  const master = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(master) < 32) fail('nexi_ingress_secret_missing');
  const key = createHmac('sha256', master).update(`ingress-effect:v1:${name}`).digest();
  return createHmac('sha256', key).update(canonical.bytes(intent)).digest('hex');
}
async function plan(tx, ctx, policy, definitions) {
  const { row, claims } = ctx;
  const selectedDefinitions = row.continuationStartedAt ? { ...definitions,
    legacy_tail: { mode: 'blocked', selected: () => true } } : definitions;
  for (const [kind, definition] of Object.entries(selectedDefinitions)) {
    if (!definition.selected(policy, ctx.message) && kind !== ctx.legacyControlUnknown) continue;
    if (await tx.nexiIngressEffect.findUnique({ where: { journalId_kind: { journalId: row.id, kind } } })) continue;
    const laneId = canonical.digest([row.laneId, kind, definition.independent ? row.id : null,
      ...(definition.contractVersion ? [definition.contractVersion] : [])]);
    const lane = await tx.nexiIngressEffectLane.upsert({ where: { id: laneId },
      create: { id: laneId, instanceId: row.instanceId, kind }, update: {} });
    // An S4 monolithic tail might already have executed ANY of its effects.
    // Record individual uncertainty, never restart those physical operations.
    const state = row.continuationStartedAt || kind === ctx.legacyControlUnknown ? 'outcome_unknown' : definition.mode === 'blocked' ? 'blocked_contract' :
      lane.blockedBy ? 'blocked_dependency' : 'pending';
    const id = randomUUID();
    const intent = { version: 1, operation_id: id, journal_id: row.id, kind, lane_id: laneId,
      local_message_id: row.id, chatwoot_message_id: row.association.message_id,
      source_digest: claims.payload_digest, instance_id: row.instanceId,
      session_identity: row.sessionIdentity, policy };
    await tx.nexiIngressEffect.create({ data: { id, journalId: row.id, laneId, scopeId: row.scopeId,
      instanceId: row.instanceId, kind, sequence: row.sequence, intent,
      conversationLaneId: row.laneId, contractVersion: definition.contractVersion || 1,
      intentDigest: canonical.digest(intent), intentSignature: signature(claims.instance_name, intent), state,
      lastError: state === 'outcome_unknown' ? 'legacy_effect_execution_unproved' : definition.mode === 'blocked' ?
        'completion_or_idempotency_contract_missing' : lane.blockedBy ? 'earlier_effect_unresolved' : null } });
    if (state === 'pending') {
      const capacity = await tx.nexiIngressScope.updateMany({ where: { id: row.scopeId, secondaryPending: { lt: MAX_PENDING } },
        data: { secondaryPending: { increment: 1 } } });
      if (capacity.count !== 1) fail('nexi_ingress_secondary_capacity');
      await tx.nexiIngressEffectLane.update({ where: { id: laneId }, data: { pending: { increment: 1 } } });
    } else if (!definition.independent && !lane.blockedBy) {
      await tx.nexiIngressEffectLane.update({ where: { id: laneId }, data: { blockedBy: id, blockedReason: state } });
    }
  }
}
async function held(ctx, work) {
  const { parent, effect, service, token } = ctx;
  // Same scope -> lane order as intent creation. Only bookkeeping uses this
  // lease; it is never a writer capability or a replacement session grant.
  return service.prismaRepository.$transaction(async tx => {
    await tx.nexiIngressScope.update({ where: { id: parent.scopeId }, data: { revision: { increment: 1 } } });
    const lock = await tx.nexiIngressEffectLane.updateMany({ where: { id: effect.laneId,
      leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (lock.count !== 1) fail('nexi_ingress_effect_lease_lost');
    return work(tx);
  });
}
async function checkpoint(ctx, data) {
  if (ctx.lost) fail('nexi_ingress_effect_lease_lost');
  await held(ctx, tx => tx.nexiIngressEffect.update({ where: { id: ctx.effect.id }, data }));
  Object.assign(ctx.effect, data);
}
async function close(ctx, state, reason = null) {
  await held(ctx, async tx => {
    const previous = await tx.nexiIngressEffect.findUnique({ where: { id: ctx.effect.id } });
    if (terminal.includes(previous.state)) return;
    await tx.nexiIngressEffect.update({ where: { id: ctx.effect.id }, data: { state, lastError: reason,
      completedAt: state === 'succeeded' ? new Date() : null } });
    let count = 1;
    if (state === 'outcome_unknown') {
      await tx.nexiIngressEffectLane.update({ where: { id: ctx.effect.laneId },
        data: { blockedBy: ctx.effect.id, blockedReason: reason } });
      // Later causal effects are retained explicitly, rather than occupying
      // runnable capacity or blocking primary intake forever.
      const blocked = await tx.nexiIngressEffect.updateMany({ where: { laneId: ctx.effect.laneId,
        sequence: { gt: ctx.effect.sequence }, state: { in: ['pending', 'recoverable_failure'] } },
        data: { state: 'blocked_dependency', lastError: 'earlier_effect_unresolved' } });
      count += blocked.count;
    }
    await tx.nexiIngressEffectLane.update({ where: { id: ctx.effect.laneId }, data: { pending: { decrement: count } } });
    await tx.nexiIngressScope.update({ where: { id: ctx.parent.scopeId }, data: { secondaryPending: { decrement: count } } });
  });
  ctx.effect.state = state;
}
function verifyIntent(effect, parent, claims) {
  const expected = signature(claims.instance_name, effect.intent);
  if (effect.intentDigest !== canonical.digest(effect.intent) || !/^[a-f0-9]{64}$/.test(effect.intentSignature || '') ||
      !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(effect.intentSignature, 'hex')) ||
      effect.intent.operation_id !== effect.id || effect.intent.kind !== effect.kind || effect.intent.lane_id !== effect.laneId ||
      effect.intent.journal_id !== parent.id || effect.intent.local_message_id !== parent.id ||
      effect.intent.instance_id !== parent.instanceId || effect.intent.session_identity !== parent.sessionIdentity ||
      effect.intent.source_digest !== claims.payload_digest || effect.scopeId !== parent.scopeId ||
      effect.intent.chatwoot_message_id !== parent.association?.message_id)
    fail('nexi_ingress_effect_proof_invalid');
}
async function applyResult(ctx) {
  const { service, parent, effect } = ctx, result = effect.result || {};
  await runtime().ownerCheck(service, ctx.owner, parent.sessionIdentity);
  await held(ctx, async tx => {
    const fence = await tx.instance.updateMany({ where: { id: parent.instanceId, nexiGroupsSocketOwner: ctx.owner.token },
      data: { nexiGroupsSocketOwner: ctx.owner.token } });
    if (fence.count !== 1) fail('nexi_ingress_session_fenced');
    const message = await tx.message.findUnique({ where: { id: parent.id } });
    if (!message || message.instanceId !== parent.instanceId || message.chatwootMessageId !== effect.intent.chatwoot_message_id ||
        message.key?.id !== ctx.claims.observation.external_message_id) fail('nexi_ingress_effect_target_conflict');
    if (result.media) {
      const media = await tx.media.upsert({ where: { messageId: parent.id },
        create: { ...result.media, messageId: parent.id, instanceId: parent.instanceId }, update: {} });
      if (media.instanceId !== parent.instanceId || media.fileName !== result.media.fileName)
        fail('nexi_ingress_effect_target_conflict');
    }
    // Merge only complementary fields into the exact original Message.
    const patch = {};
    for (const field of ['speechToText', 'mediaUrl']) if (typeof result[field] === 'string') patch[field] = result[field];
    if (Object.keys(patch).length) await tx.message.update({ where: { id: parent.id }, data: { message: { ...message.message, ...patch } } });
  });
}
async function run(registration, lane, token) {
  const { service } = registration, repo = service.prismaRepository;
  let ctx, timer, delay = 0;
  try {
    const effect = await repo.nexiIngressEffect.findFirst({ where: { laneId: lane.id, state: { notIn: terminal } }, orderBy: { sequence: 'asc' } });
    if (!effect) return;
    const parent = await repo.nexiIngressJournal.findUnique({ where: { id: effect.journalId } });
    if (!parent || parent.state !== 'succeeded' || !parent.mainMaterializedAt) { delay = 5000; return; }
    const claims = runtime().verify(parent), owner = require('./nexi-groups.cjs').lifecycleCapture(service, registration.socket);
    ctx = { service, row: parent, parent, effect, claims, token, owner, providers: new Map(), secondary: true, lost: false };
    verifyIntent(effect, parent, claims);
    if (service.instanceId !== parent.instanceId || service.instance.name !== claims.instance_name) fail('nexi_ingress_binding_fenced');
    await runtime().ownerCheck(service, owner, parent.sessionIdentity);
    const definition = registration.effects[effect.kind];
    if (!definition || definition.mode === 'blocked') fail('nexi_ingress_effect_contract_missing');
    // Finish earlier manifests before starting a later message in this family.
    // Unknown destinations hold their own target lane, not healthy siblings.
    if (definition.orderedTargets && await repo.nexiIngressEffect.findFirst({ where: {
      conversationLaneId: parent.laneId, kind: effect.kind, contractVersion: effect.contractVersion,
      sequence: { lt: effect.sequence }, state: { notIn: terminal } }, select: { id: true } })) {
      delay = 1000; return;
    }
    timer = setInterval(() => {
      if (ctx.renewing) return;
      ctx.renewing = true;
      repo.nexiIngressEffectLane.updateMany({ where: { id: lane.id, leaseToken: token,
        leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
        .then(result => { if (result.count !== 1) ctx.lost = true; }, () => { ctx.lost = true; })
        .finally(() => { ctx.renewing = false; });
    }, LEASE_MS / 3); timer.unref?.();
    if (effect.state === 'inflight' && !['local', 'dispatch', 'reconciled'].includes(definition.mode)) {
      await close(ctx, 'outcome_unknown', 'interrupted_external_effect'); return;
    }
    if (effect.state !== 'result_confirmed') {
      const recovery = canonical.parse(Buffer.from(parent.payload, 'base64').toString('utf8'));
      const received = registration.decode(Buffer.from(recovery.protobuf, 'base64'), owner.socket.authState.creds,
        recovery.transport_key, recovery.content_digest);
      if (received.key?.id !== claims.observation.external_message_id || received.key?.fromMe !== false ||
          ![claims.observation.pn_jid, claims.observation.lid_jid].includes(received.key.remoteJid))
        fail('nexi_ingress_effect_proof_invalid');
      ctx.message = received;
      await checkpoint(ctx, { state: 'inflight', startedAt: new Date(), attempts: effect.attempts + 1 });
      await runtime().ownerCheck(service, owner, parent.sessionIdentity);
      const args = {
        received, policy: effect.intent.policy, operationId: effect.id, journalId: parent.id,
        guard: () => runtime().ownerCheck(service, owner, parent.sessionIdentity),
      };
      const result = await runtime().context.run(ctx, () => definition.mode === 'local' ? held(ctx, async tx => {
        const fence = await tx.instance.updateMany({ where: { id: parent.instanceId, nexiGroupsSocketOwner: owner.token },
          data: { nexiGroupsSocketOwner: owner.token } });
        if (fence.count !== 1) fail('nexi_ingress_session_fenced');
        require('./nexi-groups.cjs').lifecycleCheck(owner);
        const value = await definition.run({ ...args, tx });
        require('./nexi-groups.cjs').lifecycleCheck(owner);
        return value;
      }) : definition.run(args));
      const normalized = result === undefined ? { completed: true } : result;
      if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_RESULT) fail('nexi_ingress_effect_result_capacity');
      await checkpoint(ctx, { state: 'result_confirmed', result: normalized });
    }
    await applyResult(ctx);
    await close(ctx, effect.result?.uncertain ? 'outcome_unknown' : 'succeeded',
      effect.result?.uncertain ? 'destination_result_unconfirmed' : null);
  } catch (error) {
    delay = Math.min(300000, 1000 * 2 ** Math.min(ctx?.effect.attempts || 1, 8));
    if (ctx && !ctx.lost) {
      const localRetry = ['local', 'dispatch', 'reconciled'].includes(registration.effects[ctx.effect.kind]?.mode) || ctx.effect.state === 'result_confirmed';
      try {
        if (localRetry && !/fenced|STALE|proof_invalid|target_conflict/.test(error.code || ''))
          await checkpoint(ctx, { state: ctx.effect.state === 'result_confirmed' ? 'result_confirmed' : 'recoverable_failure', lastError: error.code || 'effect_unavailable' });
        else await close(ctx, 'outcome_unknown', error.code || 'external_effect_unconfirmed');
      } catch { /* The durable inflight marker forces conservative recovery. */ }
    }
    runtime().log(service, 'ingress.secondary_pending', ctx?.parent, error.code || 'effect_unavailable');
  } finally {
    if (timer) clearInterval(timer);
    await repo.nexiIngressEffectLane.updateMany({ where: { id: lane.id, leaseToken: token },
      data: { leaseToken: null, leaseUntil: null, servedAt: new Date(), nextAttemptAt: new Date(Date.now() + delay) } });
  }
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const all = [...runtime().registrations.values()];
    for (let offset = 0; offset < all.length && active < CONCURRENT; offset++) {
      const registration = all[(cursor + offset) % all.length], { service } = registration;
      if (!registration.effects || instanceActive.get(service.instanceId) || registration.socket !== service.client || !registration.socket?.ws?.isOpen) continue;
      const now = new Date();
      const lanes = await service.prismaRepository.nexiIngressEffectLane.findMany({ where: { instanceId: service.instanceId,
        pending: { gt: 0 }, blockedBy: null, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        orderBy: [{ servedAt: 'asc' }, { id: 'asc' }], take: 1 });
      for (const lane of lanes) {
        const token = randomUUID();
        const held = await service.prismaRepository.nexiIngressEffectLane.updateMany({ where: { id: lane.id, blockedBy: null,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) } });
        if (held.count !== 1) continue;
        active++; instanceActive.set(service.instanceId, true);
        void run(registration, lane, token).catch(() => runtime().log(service, 'ingress.secondary_pending', null, 'storage_unavailable'))
          .finally(() => { active--; instanceActive.delete(service.instanceId); wake(); });
      }
    }
    cursor = (cursor + 1) % Math.max(1, all.length);
  } finally { pumping = false; }
}
function wake() {
  if (queued) return;
  queued = true;
  setImmediate(() => { queued = false; void pump().catch(() => {
    for (const { service } of runtime().registrations.values())
      runtime().log(service, 'ingress.secondary_recovery_pending', null, 'storage_unavailable');
  }); });
}
async function retain(service, cutoff) {
  if (retaining.has(service.instanceId)) return;
  retaining.add(service.instanceId);
  const repo = service.prismaRepository;
  let after;
  try {
    for (;;) {
      const rows = await repo.nexiIngressJournal.findMany({ where: { instanceId: service.instanceId,
        state: 'succeeded', payloadPrunedAt: null, completedAt: { lt: cutoff }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' }, take: 100 });
      for (const row of rows) await repo.$transaction(async tx => {
        // Active effects need their exact recovery payload. Uncertain/blocked
        // effects are never replayed and retain their audit/proof metadata.
        if (await tx.nexiIngressEffect.count({ where: { journalId: row.id, state: { notIn: terminal } } })) return;
        const claims = runtime().verify(row);
        const effects = await tx.nexiIngressEffect.findMany({ where: { journalId: row.id } });
        for (const effect of effects) if (effect.result) await tx.nexiIngressEffect.update({ where: { id: effect.id },
          data: { result: effect.result.dispatch
            ? require('./nexi-ingress-dispatch.cjs').prune(effect.result, claims, row.id)
            : { retained_digest: canonical.digest(effect.result), payload_pruned: true } } });
        await tx.nexiIngressJournal.update({ where: { id: row.id }, data: { payload: '', payloadPrunedAt: new Date() } });
      });
      if (rows.length < 100) break;
      after = rows[rows.length - 1].id;
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { retaining.delete(service.instanceId); }
}
module.exports = { plan, wake, retain, checkpoint, held };
