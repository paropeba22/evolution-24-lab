// Short, offline verification. No server, database, network or message send.
// Usage: node verify-ingress-r1.mjs <composed-source> <pristine-sdk> <typescript>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchChatwootCompletion } from './patch-chatwoot-completion.mjs';
const require = createRequire(import.meta.url);
const [fixture, sdk, tsRoot] = process.argv.slice(2);
const ts = require(path.resolve(tsRoot, 'lib/typescript.js'));
for (const relative of ['src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'tsup.config.ts']) {
  const code = fs.readFileSync(path.join(fixture, relative), 'utf8');
  const parsed = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(parsed.parseDiagnostics.map(item => ({
    line: parsed.getLineAndCharacterOfPosition(item.start || 0).line + 1,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  })), [], relative);
  if (relative.includes('whatsapp.baileys')) {
    assert.match(code, /timedInbound\(nexiInboundSpan,\s+'message_persist', \(\) => [^\n]+\.materializePrimary\(this, messageRaw\)\)\) continue;/);
    assert.ok(!code.includes('.beginContinuation(this)'));
    assert.ok(code.includes('.socket(this).updateMediaMessage'));
  }
}
const recv = fs.readFileSync(path.join(fixture, 'node_modules/baileys/lib/Socket/messages-recv.js'), 'utf8');
assert.equal(recv.split('await nexiIngress.capture(config, msg, proto);').length, 2);
assert.match(recv, /else \{\s+await decrypt\(\);\s+nexiIdentity\.observeDecrypted[\s\S]*?await nexiIngress\.capture/);
assert.ok(recv.indexOf('await nexiIngress.capture(') < recv.indexOf('await sendReceipt(', recv.indexOf('const handleMessage =')));
console.log('PASS: composed S1/S2/S3/S4-R1 anchors and generated TypeScript syntax');

function evaluate(code, dependencies) {
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected offline dependency: ${name}`);
  }, Buffer, console, Promise }, { timeout: 1000 });
  return exports;
}
const raw = fs.readFileSync(path.join(sdk, 'dist/core/request.js'), 'utf8').replaceAll('\r\n', '\n');
const cancelable = evaluate(fs.readFileSync(path.join(sdk, 'dist/core/CancelablePromise.js'), 'utf8'), {});
let releaseTransport, aborted = false;
const transport = new Promise((_resolve, reject) => { releaseTransport = () => reject(new Error('transport actually settled')); });
const request = evaluate(patchChatwootCompletion(raw), {
  '/evolution/nexi-ingress.cjs': { creationHttp() {}, creationStep() {} },
  axios: { CancelToken: { source: () => ({ token: {}, cancel: () => { aborted = true; } }) }, request: () => transport },
  'form-data': class { append() {} }, './ApiError': { ApiError: Error }, './CancelablePromise': cancelable,
}).request;
const Messages = evaluate(fs.readFileSync(path.join(sdk, 'dist/services/Messages.js'), 'utf8'), {
  '../core/request': { request }, stream: require('node:stream'),
}).Messages;
const ingress = require('./nexi-ingress.cjs');
const pause = () => new Promise(resolve => setImmediate(resolve));
const service = { instanceId: 'fixture-instance', instance: { name: 'fixture' }, logger: { warn() {} } };
let deadline, settled = false;
const savedTimer = globalThis.setTimeout;
const operation = new Messages({ config: { basePath: 'https://offline.invalid' } }).create({ accountId: 1, conversationId: 2, data: {} });
assert.equal(typeof operation.cancel, 'function');
assert.equal(typeof operation.nexiTransportSettled.then, 'function');
globalThis.setTimeout = callback => { deadline = callback; return {}; };
const result = ingress.secondaryRuntime.context.run({ service, row: { id: 'fixture' } }, () => ingress.cancellable(() => operation))
  .catch(error => error).finally(() => { settled = true; });
globalThis.setTimeout = savedTimer;
await pause();
deadline();
await pause();
assert.ok(aborted, 'cooperative Axios cancellation requested');
assert.equal(settled, false, 'facade rejection must retain the occupied operation until transport settlement');
releaseTransport();
assert.equal((await result).name, 'CancelError');
assert.equal(settled, true);
console.log('PASS: actual SDK Messages.create cancellation retains capacity until HTTP executor settlement');

let resolveFallback;
const fallback = new Promise(resolve => { resolveFallback = resolve; });
settled = false;
globalThis.setTimeout = callback => { deadline = callback; return {}; };
const fallbackResult = ingress.secondaryRuntime.context.run({ service, row: { id: 'fixture' } },
  () => ingress.cancellable(() => fallback)).finally(() => { settled = true; });
globalThis.setTimeout = savedTimer;
deadline(); await pause(); assert.equal(settled, false);
resolveFallback(42); assert.equal(await fallbackResult, 42);
console.log('PASS: unsupported cancellation awaits the real operation, without a synthetic timeout completion');

process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'offline-fixture-key-only-never-used-outside-this-process';
const effects = require('./nexi-ingress-effects.cjs');
const jobs = new Map(), lanes = new Map(); let pending = 0, calls = 0;
const tx = {
  nexiIngressEffect: {
    findUnique: async ({ where }) => jobs.get(`${where.journalId_kind.journalId}:${where.journalId_kind.kind}`),
    create: async ({ data }) => { jobs.set(`${data.journalId}:${data.kind}`, data); return data; },
  },
  nexiIngressEffectLane: {
    upsert: async ({ create }) => { if (!lanes.has(create.id)) lanes.set(create.id, { ...create }); return lanes.get(create.id); },
    update: async ({ where, data }) => Object.assign(lanes.get(where.id), data),
  },
  nexiIngressScope: { updateMany: async () => { pending++; return { count: 1 }; } },
};
const definition = mode => ({ mode, selected: () => true, run: () => { calls++; } });
const definitions = { projection: definition('local'), transcription: definition('external'), chatbot: definition('blocked') };
const ctx = { row: { id: 'one', laneId: 'conversation', scopeId: 'scope', instanceId: 'instance',
  sessionIdentity: 'session', sequence: 1n, association: { message_id: 77 } },
  claims: { instance_name: 'instance', payload_digest: 'digest' }, message: {} };
await effects.plan(tx, ctx, {}, definitions);
await effects.plan(tx, ctx, {}, definitions);
assert.equal(jobs.size, 3); assert.equal(pending, 2); assert.equal(calls, 0);
assert.equal(jobs.get('one:chatbot').state, 'blocked_contract');
assert.equal(jobs.get('one:projection').intent.chatwoot_message_id, 77);
ctx.row = { ...ctx.row, id: 'two', sequence: 2n, continuationStartedAt: new Date() };
await effects.plan(tx, ctx, {}, definitions);
assert.equal(calls, 0); assert.equal(pending, 2);
assert.ok([...jobs.values()].filter(job => job.journalId === 'two').every(job => job.state === 'outcome_unknown'));
console.log('PASS: individual stable intents, deduplication, no dispatch during planning and conservative S4-tail recovery');

// Exercise the actual mandatory materializer with in-memory persistence only.
// This verifies its gate/dispatch boundary, not database transaction semantics.
const groups = require('./nexi-groups.cjs'), identity = require('./nexi-identity.cjs');
const savedOwnerCheck = groups.operationCheck;
groups.operationCheck = async () => {};
const creds = { me: { id: '5511999999999@s.whatsapp.net' }, registrationId: 9, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
const socket = { authState: { creds }, ws: { isOpen: false } };
service.client = socket;
const mainRow = { ...ctx.row, id: 'mandatory', instanceId: service.instanceId, continuationStartedAt: null,
  sessionIdentity: identity.sessionFingerprint(creds), checkpoint: 'correlation_confirmed', acknowledgement: { id: 77 } };
const mainCtx = { service, row: mainRow, claims: { instance_name: service.instance.name, payload_digest: 'digest',
  observation: { external_message_id: 'external' } }, owner: { socket, token: 'owner' }, token: 'lease', message: {} };
const stored = new Map();
const repo = { ...tx,
  nexiIngressEffect: { ...tx.nexiIngressEffect, findFirst: async () => null },
  contact: { findFirst: async () => null }, chat: { findFirst: async () => null },
  $transaction: work => work(repo),
  instance: { updateMany: async () => ({ count: 1 }) },
  nexiIngressScope: { ...tx.nexiIngressScope, update: async () => ({}) },
  nexiIngressLane: { findUnique: async () => ({ leaseToken: 'lease', leaseUntil: new Date(Date.now() + 60000) }),
    updateMany: async () => ({ count: 1 }) },
  message: { upsert: async ({ create }) => { stored.set(create.id, create); return create; } },
  nexiIngressJournal: { update: async ({ data }) => Object.assign(mainRow, data) },
};
service.prismaRepository = repo;
ingress.secondaryRuntime.registrations.set(service.instanceId, { service, socket, effects: definitions, policy: () => ({}) });
const body = { instanceId: service.instanceId, chatwootMessageId: 77, key: { id: 'external', fromMe: false } };
assert.equal(await ingress.secondaryRuntime.context.run(mainCtx, () => ingress.materializePrimary(service, body)), true);
assert.ok(mainRow.mainMaterializedAt); assert.equal(stored.get('mandatory').chatwootMessageId, 77);
assert.equal(calls, 0, 'materialization never invokes secondary integrations');
mainRow.checkpoint = 'correlation_confirmed';
await assert.rejects(ingress.secondaryRuntime.context.run(mainCtx,
  () => ingress.materializePrimary(service, { ...body, chatwootMessageId: 78 })), /primary_requirements_missing/);
groups.operationCheck = savedOwnerCheck;
ingress.secondaryRuntime.registrations.clear();
console.log('PASS: main persistence requires the same confirmed Message ID and atomically plans secondary intents without dispatch');
