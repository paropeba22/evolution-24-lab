'use strict';
// Ingress evidence is never a send capability. Each destination gets a sealed
// manifest and a single durable attempt, independently of its siblings.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHmac, timingSafeEqual } = require('node:crypto');
const canonical = require('./nexi-canonical-json.cjs');
const scope = new AsyncLocalStorage();
let transports = 0;
const transportWaiters = [];
function acquireTransport() {
  return new Promise(resolve => {
    const enter = () => {
      transports++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; transports--;
        transportWaiters.shift()?.();
      });
    };
    if (transports < 2) enter(); else transportWaiters.push(enter);
  });
}
const runtime = () => require('./nexi-ingress.cjs').secondaryRuntime;
const effects = () => require('./nexi-ingress-effects.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const json = value => JSON.parse(JSON.stringify(value ?? null));
// Arbitrary integration JSON can contain fractional numbers. Sign its stable
// opaque JSON string, never weaken the integer-only authority canonicalizer.
function stableJson(value) {
  const sort = item => Array.isArray(item) ? Array.from(item, sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(json(value)));
}
function current() { const ctx = runtime().context.getStore(); return ctx?.secondary ? ctx : null; }
function sign(ctx, value) {
  const secret = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET || '';
  if (Buffer.byteLength(secret) < 32) fail('nexi_ingress_secret_missing');
  const key = createHmac('sha256', secret).update(`ingress-dispatch:v1:${ctx.claims.instance_name}`).digest();
  return createHmac('sha256', key).update(canonical.bytes(value)).digest('hex');
}
async function guard() {
  const ctx = current();
  if (!ctx || ctx.lost) fail('nexi_ingress_dispatch_context_missing');
  await runtime().ownerCheck(ctx.service, ctx.owner, ctx.parent.sessionIdentity);
  const lane = await ctx.service.prismaRepository.nexiIngressEffectLane.findUnique({ where: { id: ctx.effect.laneId } });
  if (lane?.leaseToken !== ctx.token || lane.leaseUntil <= new Date()) fail('nexi_ingress_effect_lease_lost');
}
// Serialize JSON checkpoint merges, including callbacks ignored by legacy
// callers. A failed storage write prevents all later physical dispatch.
function mutate(ctx, work) {
  const next = (ctx.dispatchWrites || Promise.resolve()).then(async () => {
    if (ctx.dispatchStorageFailed) fail('nexi_ingress_dispatch_storage_failed');
    await guard();
    const result = json(ctx.effect.result || { dispatch: {} });
    const value = work(result.dispatch);
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) fail('nexi_ingress_effect_result_capacity');
    await effects().checkpoint(ctx, { result });
    return value;
  });
  ctx.dispatchWrites = next.catch(() => { ctx.dispatchStorageFailed = true; });
  return next;
}
function noteFailure() { const active = scope.getStore(); if (active) active.failed = true; }
function track(work) {
  const active = scope.getStore();
  const task = Promise.resolve().then(work);
  if (active) {
    active.pending.add(task);
    task.then(() => active.pending.delete(task), () => { active.failed = true; active.pending.delete(task); });
  }
  return task;
}
async function drain(active) {
  while (active.pending.size) await Promise.allSettled([...active.pending]);
}
async function destinationLane(ctx, target, block = false) {
  const id = canonical.digest(['dispatch-destination:v2', ctx.parent.laneId, ctx.effect.kind, target.target, target.binding]);
  return effects().held(ctx, async tx => {
    const lane = await tx.nexiIngressEffectLane.upsert({ where: { id }, create: {
      id, instanceId: ctx.parent.instanceId, kind: 'dispatch_destination' }, update: {} });
    if (block && !lane.blockedBy) await tx.nexiIngressEffectLane.update({ where: { id }, data: {
      blockedBy: ctx.effect.id, blockedReason: 'destination_result_unconfirmed' } });
    return lane.blockedBy || (block ? ctx.effect.id : null);
  });
}
async function batch(name, tasks) {
  const ctx = current();
  if (!ctx) fail('nexi_ingress_dispatch_context_missing');
  const parent = scope.getStore();
  const ordinal = parent ? (parent.calls[name] = (parent.calls[name] || 0) + 1) : 1;
  const path = `${parent?.id || ctx.effect.id}/${name}/${ordinal}`;
  const manifestKey = canonical.digest(path);
  const description = Array.from(tasks, task => ({ target: task.target, binding: canonical.digest(stableJson(task.binding)),
    destination_json: stableJson(task.destination || task.target), causal: task.causal !== false }));
  await mutate(ctx, manifests => {
    if (manifests[manifestKey]) {
      if (canonical.digest(manifests[manifestKey].targets) !== canonical.digest(description)) fail('nexi_ingress_destination_fenced');
      return;
    }
    const intent = { version: 1, effect_id: ctx.effect.id, journal_id: ctx.parent.id,
      instance_id: ctx.parent.instanceId, session: ctx.parent.sessionIdentity, path, targets: description,
      input_json: Array.from(tasks, task => stableJson(task.input)) };
    manifests[manifestKey] = { ...intent, signature: sign(ctx, intent), entries: Array.from(tasks, (task, index) => ({
      id: canonical.digest([ctx.effect.id, path, index, task.target]), target: task.target, state: 'pending', attempts: 0,
    })) };
  });
  let manifest = ctx.effect.result.dispatch[manifestKey];
  const { signature, entries, ...intent } = manifest;
  const expected = sign(ctx, intent);
  if (intent.effect_id !== ctx.effect.id || intent.journal_id !== ctx.parent.id || intent.path !== path ||
      intent.instance_id !== ctx.parent.instanceId || intent.session !== ctx.parent.sessionIdentity ||
      !/^[a-f0-9]{64}$/.test(signature || '') ||
      !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) fail('nexi_ingress_dispatch_proof_invalid');
  for (let index = 0; index < tasks.length; index++) {
    manifest = ctx.effect.result.dispatch[manifestKey];
    const entry = manifest.entries[index], task = tasks[index];
    if (entry.id !== canonical.digest([ctx.effect.id, path, index, task.target])) fail('nexi_ingress_dispatch_proof_invalid');
    if (entry.state === 'inflight') {
      await destinationLane(ctx, manifest.targets[index], true);
      await mutate(ctx, all => Object.assign(all[manifestKey].entries[index], {
        state: 'outcome_unknown', error: 'interrupted_destination', ended_at: new Date().toISOString() }));
      continue;
    }
    if (entry.state === 'outcome_unknown') { await destinationLane(ctx, manifest.targets[index], true); continue; }
    if (entry.state !== 'pending') continue;
    await guard();
    if (await destinationLane(ctx, manifest.targets[index])) {
      await mutate(ctx, all => Object.assign(all[manifestKey].entries[index], {
        state: 'blocked_dependency', error: 'earlier_destination_unresolved', ended_at: new Date().toISOString() }));
      continue;
    }
    const release = task.transport ? await acquireTransport() : () => {};
    try {
    await guard();
    await mutate(ctx, all => Object.assign(all[manifestKey].entries[index], {
      state: 'inflight', attempts: 1, started_at: new Date().toISOString() }));
    const active = { id: entry.id, pending: new Set(), failed: false, calls: {} };
    let value, error;
    try { value = await scope.run(active, async () => {
      await guard();
      try { return await task.run(JSON.parse(manifest.input_json[index]), entry.id); }
      finally { await drain(active); }
    }); } catch (caught) { error = caught; }
    // A swallowed legacy error is not a success. All actual promises have
    // settled before this checkpoint and before releasing worker capacity.
    if (error || active.failed) await destinationLane(ctx, manifest.targets[index], true);
    await mutate(ctx, all => Object.assign(all[manifestKey].entries[index], {
      state: error || active.failed ? 'outcome_unknown' : 'succeeded',
      result: value ?? null, error: error ? error.code || 'destination_unconfirmed' : active.failed ? 'legacy_failure_reported' : null,
      ended_at: new Date().toISOString() }));
    } finally { release(); }
  }
  return ctx.effect.result.dispatch[manifestKey].entries.map(({ id, target, state, result, error }) => ({ id, target, state, result, error }));
}
function summary(ctx) {
  const entries = Object.values(ctx.effect.result?.dispatch || {}).flatMap(item => item.entries
    .filter((_entry, index) => item.targets[index].causal));
  return { dispatch: ctx.effect.result?.dispatch || {},
    uncertain: entries.some(entry => entry.state !== 'succeeded'), destinations: entries.length };
}
function prune(result, claims, journalId) {
  const audit = Object.values(result.dispatch || {}).map(manifest => {
    const { signature, entries, ...intent } = manifest;
    if (sign({ claims }, intent) !== signature) fail('nexi_ingress_dispatch_proof_invalid');
    return { path: intent.path, targets: intent.targets, original_signature: signature,
      original_intent_digest: canonical.digest(intent), input_digests: intent.input_json.map(value => canonical.digest(value)),
      entries: entries.map(({ result: output, ...entry }) => ({ ...entry, result_digest: canonical.digest(stableJson(output)) })) };
  });
  const retained = { type: 'retained_dispatch_audit', journal_id: journalId,
    retained_digest: canonical.digest(stableJson(result)), payload_pruned: true, audit };
  return { ...retained, signature: sign({ claims }, retained) };
}
function instance(service) {
  const ctx = current();
  if (!ctx) return service;
  if (!service || service.instanceId !== ctx.parent.instanceId) fail('nexi_ingress_binding_fenced');
  return new Proxy(service, { get(target, property, receiver) {
    if (property === 'client') return require('./nexi-ingress.cjs').socket(target);
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    if (value.constructor.name === 'AsyncFunction') return (...args) => track(async () => { await guard(); return value.apply(receiver, args); });
    return (...args) => { require('./nexi-groups.cjs').lifecycleCheck(ctx.owner); return value.apply(receiver, args); };
  } });
}
module.exports = { current, guard, batch, track, noteFailure, summary, instance, prune, inDestination: () => !!scope.getStore() };
