// Finite offline checks: no database, server, network or physical send.
// node verify-ingress-r2.mjs <composed source> <TypeScript 6.0.3 root>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), [fixture, tsRoot] = process.argv.slice(2);
const ts = require(path.resolve(tsRoot, 'lib/typescript.js'));
const files = ['tsup.config.ts', 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', 'src/api/services/channel.service.ts',
  'src/config/logger.config.ts', 'src/api/integrations/event/event.manager.ts',
  'src/utils/sendTelemetry.ts',
  'src/api/integrations/event/rabbitmq/rabbitmq.controller.ts', 'src/api/integrations/chatbot/chatbot.controller.ts',
  'src/api/integrations/chatbot/base-chatbot.controller.ts', 'src/api/integrations/chatbot/base-chatbot.service.ts',
  'src/api/integrations/chatbot/typebot/services/typebot.service.ts', 'src/api/integrations/chatbot/openai/services/openai.service.ts'];
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(fixture, file), 'utf8'), ts.ScriptTarget.Latest, true);
  assert.deepEqual(source.parseDiagnostics.map(item => ({ file, line: source.getLineAndCharacterOfPosition(item.start || 0).line + 1,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n') })), []);
}
assert.match(fs.readFileSync(path.join(fixture, 'tsup.config.ts'), 'utf8'), /external: \['\/evolution\/nexi-ingress-dispatch.cjs'/);
assert.match(fs.readFileSync(path.join(fixture, 'src/api/integrations/chatbot/base-chatbot.controller.ts'), 'utf8'), /await this\.processDebounce/);
assert.ok(!fs.readFileSync('ingress-effects.ts.inc', 'utf8').includes("mode: 'blocked'"));
console.log('PASS: R1/R2 patch composition, all changed TypeScript syntax, external runtime and enabled family anchors');

const ingress = require('./nexi-ingress.cjs'), dispatch = require('./nexi-ingress-dispatch.cjs'), canonical = require('./nexi-canonical-json.cjs');
const runtime = ingress.secondaryRuntime, savedOwnerCheck = runtime.ownerCheck;
process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'offline-only-fixture-key-with-at-least-thirty-two-bytes';
runtime.ownerCheck = async () => {};
const destinationLanes = new Map();
function context(id) {
  const ctx = { secondary: true, lost: false, token: id, owner: {},
    parent: { id: `journal-${id}`, instanceId: 'instance', sessionIdentity: 'session', laneId: 'conversation' },
    claims: { instance_name: 'fixture', accepted_at: '2026-10-15T00:00:00.000Z' },
    effect: { id, kind: 'message_webhook', laneId: `lane-${id}`, state: 'inflight', result: null } };
  ctx.service = { prismaRepository: {
    nexiIngressEffectLane: { findUnique: async () => ({ leaseToken: id, leaseUntil: new Date(Date.now() + 60000) }), updateMany: async () => ({ count: 1 }),
      upsert: async ({ create }) => { if (!destinationLanes.has(create.id)) destinationLanes.set(create.id, create); return destinationLanes.get(create.id); },
      update: async ({ where, data }) => Object.assign(destinationLanes.get(where.id), data) },
    nexiIngressScope: { update: async () => ({}) },
    nexiIngressEffect: { update: async ({ data }) => ({ ...ctx.effect, ...data }) },
    $transaction: async work => work(ctx.service.prismaRepository),
  } };
  return ctx;
}
const pause = () => new Promise(resolve => setImmediate(resolve));
const ctx = context('completion'); let release, finished = false, calls = 0;
const tasks = [
  { target: 'one', binding: { url: 'https://offline.invalid' }, input: { value: 7 }, run: async (input, id) => {
    calls++; assert.equal(input.value, 7); assert.equal(id.length, 64);
    dispatch.track(() => new Promise(resolve => { release = resolve; }));
    return { accepted: true };
  } },
  { target: 'two', binding: null, input: null, run: async () => { calls++; return { accepted: true }; } },
];
const pending = runtime.context.run(ctx, () => dispatch.batch('destinations', tasks)).finally(() => { finished = true; });
for (let i = 0; i < 4; i++) await pause();
assert.equal(finished, false); assert.equal(calls, 1, 'no first-destination shortcut');
release();
assert.ok((await pending).every(item => item.state === 'succeeded')); assert.equal(calls, 2);
await runtime.context.run(ctx, () => dispatch.batch('destinations', tasks)); assert.equal(calls, 2, 'confirmed destinations are not executed again');
console.log('PASS: ignored nested callbacks are drained; all destinations settle; duplicate callbacks cannot dispatch twice');

const persisted = Object.values(ctx.effect.result.dispatch)[0];
persisted.entries[0].state = 'inflight'; persisted.entries[1].state = 'pending';
await runtime.context.run(ctx, () => dispatch.batch('destinations', tasks));
assert.equal(calls, 3); assert.equal(persisted.entries[0].attempts, 1);
assert.ok(dispatch.summary(ctx).uncertain);
const resumed = Object.values(ctx.effect.result.dispatch)[0].entries;
assert.equal(resumed[0].state, 'outcome_unknown'); assert.equal(resumed[1].state, 'succeeded');
await runtime.context.run(ctx, () => dispatch.batch('destinations', tasks)); assert.equal(calls, 3);
await assert.rejects(runtime.context.run(ctx, () => dispatch.batch('destinations', [{ ...tasks[0], binding: { url: 'changed' } }, tasks[1]])), /destination_fenced/);
assert.equal(calls, 3);
console.log('PASS: interrupted HTTP is never repeated; unstarted sibling recovers; changed destination is fenced');
const nextMessage = context('next-message');
const nextEntries = await runtime.context.run(nextMessage, () => dispatch.batch('destinations', tasks));
assert.equal(nextEntries[0].state, 'blocked_dependency'); assert.equal(nextEntries[1].state, 'succeeded'); assert.equal(calls, 4);
const otherConversation = context('other-conversation'); otherConversation.parent.laneId = 'other-conversation';
await runtime.context.run(otherConversation, () => dispatch.batch('destinations', tasks.map(task => ({ ...task, run: async () => { calls++; return {}; } }))));
assert.equal(calls, 6);
console.log('PASS: target uncertainty holds only that destination; healthy siblings and other conversations still execute');

const bad = context('tamper');
await runtime.context.run(bad, () => dispatch.batch('sealed', [{ target: 'only', input: { value: 1 }, run: async () => ({}) }]));
Object.values(bad.effect.result.dispatch)[0].input_json[0] = '{"value":2}';
await assert.rejects(runtime.context.run(bad, () => dispatch.batch('sealed', [{ target: 'only', input: { value: 1 }, run: async () => { throw new Error('must not run'); } }])), /proof_invalid/);
console.log('PASS: persisted input/target manifest is HMAC verified before use');

// Exercise the actual new EventManager adapter with two configured webhook
// destinations and fake Axios. A partial remote effect followed by 500 is
// unknown, yet the other selected destination still executes exactly once.
const config = { WEBHOOK: { GLOBAL: { ENABLED: true, URL: 'https://global.invalid', WEBHOOK_BY_EVENTS: false },
  EVENTS: { MESSAGES_UPSERT: true }, REQUEST: { TIMEOUT_MS: 30000 } } };
const posts = [];
const code = ts.transpileModule(`class Adapter { ${fs.readFileSync('ingress-event-adapters.ts.inc', 'utf8')} }; exports.Adapter = Adapter;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(code, { exports, Buffer, URL, require: name => {
  if (name === '/evolution/nexi-ingress-dispatch.cjs') return dispatch;
  if (name === '@config/env.config') return { configService: { get: key => config[key] } };
  if (name === 'axios') return { default: { post: async (url, body, options) => {
    posts.push({ url, body, options }); if (url.includes('local')) throw new Error('effect happened then response lost'); return { status: 202 };
  } } };
  if (name === '/evolution/nexi-transport.cjs') return require('./nexi-transport.cjs');
  throw new Error(`Unexpected offline dependency: ${name}`);
} });
const adapter = new exports.Adapter();
adapter.webhook = { get: async () => ({ enabled: true, events: ['MESSAGES_UPSERT'], url: 'https://local.invalid', headers: {} }) };
for (const name of ['websocket', 'nats', 'rabbitmq', 'pusher', 'sqs', 'kafka']) adapter[name] = { status: false };
const eventCtx = context('webhook');
const packet = { instanceName: 'fixture', event: 'messages.upsert', data: { key: { id: 'original' } }, local: true };
await runtime.context.run(eventCtx, () => adapter.emitIngress(packet));
assert.equal(posts.length, 2); assert.equal(posts[0].options.maxRedirects, 0);
assert.equal(posts[0].options.headers['X-Nexi-Attempt'], '1');
assert.equal(posts[0].options.headers['X-Nexi-Operation-Id'], posts[0].body.nexi_operation_id);
assert.equal(posts[0].options.timeout, 30000); assert.equal(dispatch.summary(eventCtx).uncertain, true);
await runtime.context.run(eventCtx, () => adapter.emitIngress(packet)); assert.equal(posts.length, 2);
console.log('PASS: actual webhook adapter executes local/global, preserves operation IDs and never retries ambiguous effects');
const bounded = [], releases = []; let starts = 0;
for (let index = 0; index < 3; index++) {
  const transportCtx = context(`transport-${index}`); transportCtx.parent.laneId = `transport-${index}`;
  bounded.push(runtime.context.run(transportCtx, () => dispatch.batch('capacity', [{ target: 'transport', transport: true,
    run: async () => { starts++; await new Promise(resolve => releases.push(resolve)); return { complete: true }; } }])));
}
for (let index = 0; index < 4; index++) await pause();
assert.equal(starts, 2); releases[0]();
for (let index = 0; index < 4; index++) await pause();
assert.equal(starts, 3); releases[1](); releases[2](); await Promise.all(bounded);
console.log('PASS: nested fanout transport capacity stays bounded until actual settlement');
const reported = context('reported');
const reportedResult = await runtime.context.run(reported, () => dispatch.batch('reported', [{ target: 'reported', run: async () => {
  dispatch.noteFailure(); return { returned: true };
} }]));
assert.equal(reportedResult[0].state, 'outcome_unknown');
runtime.ownerCheck = async () => { throw Object.assign(new Error('replaced'), { code: 'nexi_ingress_session_fenced' }); };
await assert.rejects(runtime.context.run(context('fenced'), () => dispatch.batch('fenced', [{ target: 'fenced', run: async () => { throw new Error('must not run'); } }])), /replaced/);
runtime.ownerCheck = async () => {};
console.log('PASS: reported legacy failure is uncertain and replaced session prevents dispatch');
const nonCausal = context('noncausal');
await runtime.context.run(nonCausal, () => dispatch.batch('notification', [{ target: 'optional', causal: false, input: { secret_content: 'raw payload' },
  run: async () => { throw new Error('notification unavailable'); } }]));
assert.equal(dispatch.summary(nonCausal).uncertain, false, 'independent notification must not poison chatbot causality');
const retained = dispatch.prune(nonCausal.effect.result, nonCausal.claims, nonCausal.parent.id);
assert.equal(retained.audit[0].entries[0].state, 'outcome_unknown');
assert.ok(!JSON.stringify(retained).includes('raw payload')); assert.equal(retained.signature.length, 64);
console.log('PASS: independent notifications do not block chatbot; retention preserves signed individual uncertainty without raw payload');

// Run the actual patched debounce method without loading the application.
const controller = fs.readFileSync(path.join(fixture, 'src/api/integrations/chatbot/chatbot.controller.ts'), 'utf8');
const start = controller.indexOf('  public processDebounce('), end = controller.indexOf('  public checkIgnoreJids(', start);
const debounceCode = ts.transpileModule(`class Debounce { ${controller.slice(start, end)} }; exports.Debounce = Debounce;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const debounceExports = {};
vm.runInNewContext(debounceCode, { exports: debounceExports, setTimeout, clearTimeout });
const debounce = new debounceExports.Debounce(), state = {}; let content, done = false;
const first = debounce.processDebounce(state, 'one', 'instance:pn', 0.001, async value => { content = value; });
const second = debounce.processDebounce(state, 'two', 'instance:pn', 0.001, async value => { content = value; }).then(() => { done = true; });
assert.equal(done, false); await Promise.all([first, second]); assert.equal(content, 'one\ntwo'); assert.equal(done, true);
await assert.rejects(debounce.processDebounce(state, 'failure', 'instance:pn', 0.001, async () => { throw new Error('callback failed'); }), /callback failed/);
console.log('PASS: real debounce awaits combined callback and propagates callback rejection');

runtime.ownerCheck = savedOwnerCheck;
assert.equal(typeof canonical.digest({ complete: true }), 'string');
