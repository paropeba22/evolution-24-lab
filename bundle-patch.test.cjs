'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('patched image bundle preserves the direct message path and fails closed', { skip: !process.env.EVOLUTION_BUNDLE_PATH }, () => {
  const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
  const mysql = process.env.EVOLUTION_PROVIDER === 'mysql';
  const route = bundle.indexOf('processChatwootWebhook(e,await ig.getProvider');
  const dispatchCall = `execute:(a,i)=>${mysql ? 'pn' : 'Cn'}.receiveWebhook(a,i)`;
  const dispatch = bundle.indexOf(dispatchCall, route);
  assert.ok(route >= 0 && dispatch > route);
  assert.match(bundle.slice(route, dispatch), /\(\)=>this\.dataValidate\(/);
  assert.ok(bundle.slice(dispatch, dispatch + 100).includes('receiveWebhook(a,i)}));return s.status(v.status).json(v.body)'));
  assert.doesNotMatch(bundle.slice(route, route + 700), /delivery_already_recorded/);
  assert.match(bundle, /inboxId:t\.inboxId/);
  assert.match(bundle, /resolveConfiguredInbox\(s\.payload,this\.provider,t\.instanceName\)/);
  assert.match(bundle, /A\.private\|\|A\.event==="message_updated"/);
  assert.match(bundle, /substring\(0,5\)==="WAID:"/);
  assert.ok(bundle.includes(`await i?.textMessage(${mysql ? 'p' : 'C'},!0)`));
  assert.match(bundle, /chatwoot_media_send_failed/);
  assert.match(bundle, /chatwoot_template_send_failed/);
  assert.match(bundle, /chatwoot_delete_failed/);
  assert.match(bundle, /catch\(e\)\{this\.logger\.error\("chatwoot_transport_failed"\);throw new Error\("chatwoot_transport_failed"\)/);
  assert.doesNotMatch(bundle, /catch\(e\)\{return this\.logger\.error\(e\),\{message:"bot"\}\}\}async updateChatwootMessageId/);
  assert.ok(bundle.includes(`prepareEvent(${mysql ? 'M' : 'U'},f,A,this.monitor.waInstances[A].instanceId)`));
  assert.doesNotMatch(bundle, /qrcodeCount: \$\{this\.instance\.qrcode\.count\}/);
});

test('final webhook/find route binds event proof to the validated instance', { skip: !process.env.EVOLUTION_BUNDLE_PATH }, async () => {
  const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
  const mysql = process.env.EVOLUTION_PROVIDER === 'mysql';
  const startPattern = '.get(this.routerPath("find"),...e,async(s,n)=>{';
  const endPattern = 'n.status(200).json(a)})';
  const routes = [];
  for (let start = bundle.indexOf(startPattern); start >= 0;
    start = bundle.indexOf(startPattern, start + startPattern.length)) {
    const end = bundle.indexOf(endPattern, start);
    const nextStart = bundle.indexOf(startPattern, start + startPattern.length);
    if (end < 0 || (nextStart >= 0 && end > nextStart)) continue;
    const candidate = bundle.slice(start, end + endPattern.length);
    if (candidate.includes(`${mysql ? 'X' : 'z'}.webhook.get(i.instanceName)`)) routes.push(candidate);
  }
  assert.equal(routes.length, 1, 'one exact webhook/find route');
  const route = routes[0];

  // Execute the route expression from the final bundle with only its external services stubbed.
  const compile = new Function('require', 'webhook', 'dataValidate', 'capture', `
    const ${mysql ? 'X' : 'z'} = { webhook };
    const ${mysql ? 'v' : 'T'} = null, ${mysql ? 'b' : 'P'} = null;
    const e = [() => {}];
    const owner = {
      router: { get: (_path, ...handlers) => capture(handlers.at(-1)) },
      routerPath: () => '/webhook/find', dataValidate,
    };
    (function () { this.router${route} }).call(owner);
  `);

  async function invoke({ result, ready, validatedName = 'nexi-wa-test', requestName = 'nexi-wa-test' }) {
    const received = [];
    const proofNames = [];
    const helper = {
      eventSigningReady: () => ready,
      eventKeyProof: (name) => { proofNames.push(name); return ready ? `proof:${name}` : null; },
    };
    let handler;
    compile(() => helper,
      { get: async (name) => { received.push(name); return result; } },
      ({ execute }) => execute({ instanceName: validatedName }),
      (registered) => { handler = registered; });
    assert.equal(typeof handler, 'function');
    const response = { statusCode: null, body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler({ params: { instanceName: requestName } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, [validatedName]);
    return { response, proofNames };
  }

  const object = await invoke({ result: {}, ready: true });
  assert.deepEqual(object.response.body, {
    nexi_event_signed: true, nexi_event_key_check: 'proof:nexi-wa-test',
  });
  assert.deepEqual(object.proofNames, ['nexi-wa-test']);

  const empty = await invoke({ result: null, ready: true });
  assert.equal(empty.response.body, null);
  assert.deepEqual(empty.proofNames, []);

  const unavailable = await invoke({ result: {}, ready: false });
  assert.deepEqual(unavailable.response.body, {
    nexi_event_signed: false, nexi_event_key_check: null,
  });
  assert.deepEqual(unavailable.proofNames, ['nexi-wa-test']);

  const validated = await invoke({ result: {}, ready: true,
    validatedName: 'validated-instance', requestName: 'outer-instance' });
  assert.equal(validated.response.body.nexi_event_key_check, 'proof:validated-instance');
  assert.deepEqual(validated.proofNames, ['validated-instance']);
  assert.doesNotMatch(route, /eventKeyProof\([^)]*\.params\.instanceName\)/);
});

test('webhook/find patch targets only its owning route and fails closed',
  { skip: !process.env.EVOLUTION_BUNDLE_PATH }, async (t) => {
    const marked = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
    const mysql = process.env.EVOLUTION_PROVIDER === 'mysql';
    const service = mysql ? 'X' : 'z';
    const routeStart = '.get(this.routerPath("find"),...e,async(s,n)=>{';
    const routeEnd = 'n.status(200).json(a)})';
    const executeStart = `execute:async i=>{let r=await ${service}.webhook.get(i.instanceName)`;
    const executeAt = marked.indexOf(executeStart);
    assert.ok(executeAt >= 0 && marked.indexOf(executeStart, executeAt + 1) < 0);
    const start = marked.lastIndexOf(routeStart, executeAt);
    const end = marked.indexOf(routeEnd, executeAt) + routeEnd.length;
    assert.ok(start >= 0 && end > executeAt);
    const route = marked.slice(start, end);
    const executeEnd = route.indexOf('});n.status(200).json(a)');
    const correctedExecute = route.slice(route.indexOf('execute:async i=>'), executeEnd);
    const oldExecute = `execute:i=>${service}.webhook.get(i.instanceName)`;
    const oldRoute = route.replace(correctedExecute, oldExecute);
    const unmarked = marked.replace(/^\/\* nexi-p3-chatwoot-transport \*\/\r?\n/, '');
    assert.notEqual(unmarked, marked, 'final representative bundle has the marker');
    const oldBundle = unmarked.replace(route, oldRoute);
    assert.notEqual(oldBundle, unmarked);
    const unrelatedOld = route.replace('routerPath("find")', 'routerPath("other")')
      .replace(correctedExecute, oldExecute);
    const unrelatedCorrected = route.replace('routerPath("find")', 'routerPath("other")');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-webhook-find-'));

    function run(source, routeOnly = true) {
      const target = path.join(directory, 'candidate.js');
      fs.writeFileSync(target, source);
      const result = spawnSync(process.execPath,
        [path.join(__dirname, 'patch-channel-transport.mjs'), ...(routeOnly ? ['--webhook-route-only'] : [])],
        { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target }, encoding: 'utf8' });
      return { status: result.status, output: fs.readFileSync(target, 'utf8'), stderr: result.stderr };
    }

    function rejected(source, routeOnly = true) {
      const result = run(source, routeOnly);
      assert.notEqual(result.status, 0, 'patch must reject the candidate');
      assert.match(result.stderr, /webhook\/find:/);
      assert.equal(result.output, source, 'failed patch must not write the bundle');
    }

    try {
      await t.test('unique correct route is patched', () => {
        const result = run(oldBundle);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, unmarked);
      });
      await t.test('absent find route fails', () => {
        rejected(oldBundle.replace(oldRoute, oldRoute.replace('routerPath("find")', 'routerPath("missing")')));
      });
      await t.test('duplicate find route fails', () => {
        rejected(oldBundle.replace(oldRoute + '}};', oldRoute + oldRoute + '}};'));
      });
      await t.test('unrelated identical suffix is untouched', () => {
        const result = run(oldBundle + unrelatedOld);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, unmarked + unrelatedOld);
      });
      await t.test('changed intended route with unrelated suffix fails', () => {
        rejected(oldBundle.replace(oldRoute, oldRoute.replace(oldExecute,
          oldExecute.replace('i.instanceName', 'i.name'))) + unrelatedOld);
      });
      await t.test('duplicated transformation point inside intended route fails', () => {
        rejected(oldBundle.replace(oldRoute, oldRoute.replace(oldExecute, `${oldExecute},${oldExecute}`)));
      });
      await t.test('correct marked bundle is byte-identical on rerun', () => {
        const result = run(marked, false);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, marked);
        assert.equal(createHash('sha256').update(result.output).digest('hex'),
          createHash('sha256').update(marked).digest('hex'));
      });
      await t.test('stale marked route with outer-variable proof fails', () => {
        const prefix = route.slice(0, route.indexOf(correctedExecute));
        const oldProof = `${oldExecute}});if(a){a.nexi_event_signed=require("/evolution/nexi-transport.cjs").eventSigningReady();` +
          `a.nexi_event_key_check=require("/evolution/nexi-transport.cjs").eventKeyProof(${mysql ? 's' : 'e'}.params.instanceName)}n.status(200).json(a)})`;
        rejected(marked.replace(route, prefix + oldProof), false);
      });
      await t.test('proof only in unrelated route cannot validate marker', () => {
        rejected(marked.replace(route, oldRoute) + unrelatedCorrected, false);
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
