'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const transportHelper = 'require("/evolution/nexi-transport.cjs")';
function chatwootRouteFixture(symbols = {}, corrected = false, proof = corrected) {
  const { request = 'e', response = 's', result = 'n', schema = 'v', dto = 'b', service = 'pn',
    instance = 'a', payload = 'i', guards = 'g', singleton = 'ig' } = symbols;
  const validation = `this.dataValidate({request:${request},schema:${schema},ClassRef:${dto},execute:(${instance},${payload})=>${service}.receiveWebhook(${instance},${payload})})`;
  const find = `.get(this.routerPath("find"),...${guards},async(${request},${response})=>{let ${result}=await this.dataValidate({request:${request},schema:${schema},ClassRef:${dto},execute:${instance}=>${service}.findChatwoot(${instance})});` +
    (proof ? `${result}.nexi_transport_hardened=true;${result}.nexi_replay_store_ready=await ${transportHelper}.replayStoreReady();` : '') +
    `${response}.status(200).json(${result})})`;
  const route = `.post(this.routerPath("webhook"),async(${request},${response})=>{let ${result}=await ` +
    (corrected ? `${transportHelper}.processChatwootWebhook(${request},await ${singleton}.getProvider({instanceName:${request}.params.instanceName}),()=>${validation});return ${response}.status(${result}.status).json(${result}.body)})`
      : `${validation};${response}.status(200).json(${result})})`);
  return { find, route, source: find + route + '}};', validation };
}

test('Chatwoot service anchors preserve isolation and reject structural ambiguity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-chatwoot-anchors-'));
  const helper = 'require("/evolution/nexi-transport.cjs")';
  const marker = '/* nexi-p3-chatwoot-transport */\n';

  function fixture({ ctor = 'Qe', monitor = 'R', config = 'y', repository = 'x', cache = 'cn', singleton = 'ig' } = {}) {
    const instance = `this.chatwootService=new ${ctor}(${monitor},this.configService,this.prismaRepository,this.chatwootCache)`;
    const shared = `${singleton}=new ${ctor}(${monitor},${config},${repository},${cache})`;
    const correctedInstance = instance.replace('=new ', `=${helper}.isolateChatwoot(new `) + ')';
    const correctedShared = shared.replace('=new ', `=${helper}.isolateChatwoot(new `) + ')';
    // Include unrelated constructor calls with the same arity and argument names.
    const source = `class Channel{constructor(){${instance};this.openaiService=new Other(${monitor},this.configService,this.prismaRepository,this.chatwootCache);}};class Controller{constructor(service){this.chatwootService=service;}};let ${shared},other=new Other(${monitor},${config},${repository},${cache});`;
    const corrected = source.replace(instance, () => correctedInstance).replace(shared, () => correctedShared);
    return { source, corrected, instance, shared, correctedInstance, correctedShared };
  }

  function run(source, provider = 'mysql', full = false) {
    const target = path.join(directory, 'candidate.js');
    fs.writeFileSync(target, source);
    const result = spawnSync(process.execPath,
      [path.join(__dirname, 'patch-channel-transport.mjs'), ...(full ? [] : ['--chatwoot-services-only'])],
      { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target, EVOLUTION_PROVIDER: provider }, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(target, 'utf8') };
  }

  function rejected(source, label, full = false) {
    const result = run(source, 'mysql', full);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, label);
    assert.equal(result.output, source, 'failure must leave the bundle byte-identical');
  }

  function webhookRoute(corrected) {
    const execute = corrected
      ? `execute:async i=>{let r=await svc.webhook.get(i.instanceName);if(r){r.nexi_event_signed=${helper}.eventSigningReady();r.nexi_event_key_check=${helper}.eventKeyProof(i.instanceName)}return r}`
      : 'execute:i=>svc.webhook.get(i.instanceName)';
    return '.post(this.routerPath("set"),...g,async(req,res)=>{svc.webhook.set(a.instanceName,b)})' +
      '.get(this.routerPath("find"),...g,async(req,res)=>{let result=await this.dataValidate({request:req,schema:Schema,ClassRef:Dto,' +
      execute + '});res.status(200).json(result)})}};';
  }

  try {
    for (const [provider, symbols] of [
      ['mysql', {}],
      ['postgresql', { ctor: 'ye', monitor: 'O', config: 'E', repository: 'J' }],
      ['psql_bouncer', { ctor: 'ye', monitor: 'O', config: 'E', repository: 'J' }],
      ['mysql', { ctor: '$Renamed_42', monitor: '_monitor', config: '$config', repository: 'repo42', cache: '$cache', singleton: '_shared' }],
      ['postgresql', { ctor: 'DifferentCtor', monitor: '$m', config: '_cfg', repository: '$repo', cache: '_cache', singleton: '$singleton' }],
    ]) {
      await t.test(`${provider}: unique targets with constructor ${symbols.ctor || 'Qe'}`, () => {
        const f = fixture(symbols);
        const result = run(f.source, provider);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, f.corrected, 'only the two isolation wrappers change');
        const marked = marker + result.output + webhookRoute(true) + chatwootRouteFixture({ singleton: symbols.singleton || 'ig' }, true).source;
        const rerun = run(marked, provider, true);
        assert.equal(rerun.status, 0, rerun.stderr);
        assert.equal(rerun.output, marked, 'corrected marked bundle is byte-identical');
      });
    }

    const f = fixture();
    await t.test('wrapper receives both original constructor results and arguments', () => {
      const result = run(f.source);
      assert.equal(result.status, 0, result.stderr);
      const seen = [];
      const wrapped = [];
      class Chatwoot { constructor(...args) { seen.push(args); } }
      const monitor = {}, config = {}, repository = {}, cache = {};
      const evaluate = new Function('require', 'Qe', 'Other', 'R', 'y', 'x', 'cn',
        result.output.replace('constructor(){', 'constructor(){this.configService=y;this.prismaRepository=x;this.chatwootCache=cn;') + 'return {Channel,ig};');
      const exports = evaluate(() => ({ isolateChatwoot(service) { wrapped.push(service); return service; } }),
        Chatwoot, class Other {}, monitor, config, repository, cache);
      const instance = new exports.Channel();
      assert.deepEqual(seen, [[monitor, config, repository, cache], [monitor, config, repository, cache]]);
      assert.equal(wrapped.length, 2);
      assert.equal(exports.ig, wrapped[0]);
      assert.equal(instance.chatwootService, wrapped[1]);
    });

    for (const [name, source, label] of [
      ['absent instance', f.source.replace(f.instance, 'this.chatwootService=null'), /per-instance chatwoot service:/],
      ['duplicate instance', f.source + `class Duplicate{constructor(){${f.instance};}}`, /per-instance chatwoot service:/],
      ['changed instance cache', f.source.replace('this.chatwootCache)', 'this.otherCache)'), /per-instance chatwoot service:/],
      ['missing monitor argument', f.source.replace('new Qe(R,this.configService', 'new Qe(this.configService'), /per-instance chatwoot service:/],
      ['extra instance argument', f.source.replace('this.chatwootCache)', 'this.chatwootCache,extra)'), /per-instance chatwoot service:/],
      ['valid instance plus malformed assignment', f.source + 'this.chatwootService=new Wrong();', /per-instance chatwoot service:/],
      ['absent singleton', f.source.replace(f.shared, 'ig=null'), /singleton chatwoot service:/],
      ['duplicate singleton', f.source + `let duplicate=new Qe(R,y,x,cn);`, /singleton chatwoot service:/],
      ['changed singleton constructor', f.source.replace(f.shared, 'ig=new Wrong(R,y,x,cn)'), /singleton chatwoot service:/],
      ['changed singleton monitor', f.source.replace(f.shared, 'ig=new Qe(other,y,x,cn)'), /singleton chatwoot service:/],
      ['extra singleton argument', f.source.replace(f.shared, 'ig=new Qe(R,y,x,cn,extra)'), /singleton chatwoot service:/],
      ['valid singleton plus malformed assignment', f.source + 'let malformed=new Qe(R,y,x);', /singleton chatwoot service:/],
      ['only instance corrected', f.source.replace(f.instance, f.correctedInstance), /mixed isolation state/],
      ['only singleton corrected', f.source.replace(f.shared, f.correctedShared), /mixed isolation state/],
      ['unmarked already corrected', f.corrected, /first application expected unwrapped constructors/],
    ]) {
      await t.test(name, () => rejected(source, label));
    }

    for (const [name, services, route, label] of [
      ['marked unwrapped services', f.source, webhookRoute(true), /marked bundle is not corrected/],
      ['marked missing instance', f.corrected.replace(f.correctedInstance, 'this.chatwootService=null'), webhookRoute(true), /per-instance chatwoot service:/],
      ['marked duplicate corrected instance', f.corrected + `class Duplicate{constructor(){${f.correctedInstance};}}`, webhookRoute(true), /per-instance chatwoot service:/],
      ['marked duplicate corrected singleton', f.corrected + `let duplicate=${helper}.isolateChatwoot(new Qe(R,y,x,cn));`, webhookRoute(true), /singleton chatwoot service:/],
      ['marked stale webhook proof', f.corrected, webhookRoute(false), /webhook\/find: marked bundle is not corrected/],
    ]) {
      await t.test(name, () => rejected(marker + services + route, label, true));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('authenticated Chatwoot route captures symbols, dispatches lazily and rejects ambiguity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-auth-route-'));
  const services = 'class Channel{constructor(){this.chatwootService=new Ctor(monitor,this.configService,this.prismaRepository,this.chatwootCache);}};let shared=new Ctor(monitor,config,repo,cache);';
  function run(source, full = false) {
    const target = path.join(directory, 'candidate.js');
    fs.writeFileSync(target, source);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'patch-channel-transport.mjs'), ...(full ? [] : ['--authenticated-webhook-only'])],
      { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target }, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(target, 'utf8') };
  }
  function rejected(source, label = /authenticated chatwoot webhook route:/) {
    const result = run(source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, label);
    assert.equal(result.output, source);
  }
  try {
    for (const symbols of [
      { singleton: 'shared' },
      { singleton: 'shared', schema: 'T', dto: 'P', service: 'Cn' },
      { singleton: 'shared', request: '$$request', response: '_response', result: '$$result', schema: '$$Schema', dto: '_Dto', service: '$$Controller', instance: '_instance', payload: '$$body', guards: '$$guards' },
    ]) {
      await t.test(`unique route with schema ${symbols.schema || 'v'}`, async () => {
        const old = chatwootRouteFixture(symbols);
        const patched = chatwootRouteFixture(symbols, true, false);
        const result = run(services + old.source);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, services + patched.source);
        rejected(result.output, /first application expected old route/);

        const g = { request: 'e', response: 's', result: 'n', schema: 'v', dto: 'b', service: 'pn', instance: 'a', payload: 'i', ...symbols };
        let handler;
        const controller = { receiveWebhook: async (...args) => ({ received: args }) };
        const schema = {}, dto = {};
        const observed = [];
        const compile = new Function('require', g.singleton, g.schema, g.dto, g.service, 'captureHandler', 'validate',
          `const owner={router:{post:(_path,fn)=>captureHandler(fn)},routerPath:()=>"/webhook",dataValidate:validate};(function(){this.router${patched.route}}).call(owner);`);
        const request = { params: { instanceName: 'nexi-wa-route-test' } };
        const validated = { instanceName: 'validated-instance' }, payload = { content: 'test' };
        let permitDispatch = true;
        compile(() => ({ processChatwootWebhook: async (req, provider, next) => {
          assert.equal(req, request); assert.deepEqual(provider, { inboxId: 42 });
          return { status: 202, body: permitDispatch ? await next() : 'rejected-before-dispatch' };
        } }), { getProvider: async (instance) => { observed.push(instance); return { inboxId: 42 }; } }, schema, dto, controller,
        (fn) => { handler = fn; }, async (input) => {
          assert.equal(input.request, request); assert.equal(input.schema, schema); assert.equal(input.ClassRef, dto);
          observed.push('validated'); return input.execute(validated, payload);
        });
        const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        await handler(request, response);
        assert.equal(response.code, 202);
        assert.deepEqual(response.body, { received: [validated, payload] });
        assert.deepEqual(observed, [{ instanceName: 'nexi-wa-route-test' }, 'validated']);
        permitDispatch = false; observed.length = 0;
        await handler(request, response);
        assert.equal(response.body, 'rejected-before-dispatch');
        assert.deepEqual(observed, [{ instanceName: 'nexi-wa-route-test' }]);
      });
    }
    const f = chatwootRouteFixture({ singleton: 'shared' });
    for (const [name, source] of [
      ['zero target', f.source.replace('routerPath("webhook")', 'routerPath("other")')],
      ['duplicate target', f.source + f.source],
      ['malformed request binding', f.source.replace('request:e,schema:v,ClassRef:b,execute:(a,i)', 'request:wrong,schema:v,ClassRef:b,execute:(a,i)')],
      ['malformed payload binding', f.source.replace('receiveWebhook(a,i)', 'receiveWebhook(a,wrong)')],
      ['malformed response', f.source.replace('receiveWebhook(a,i)});s.status(200)', 'receiveWebhook(a,i)});s.status(201)')],
      ['duplicate dispatch point', f.source.replace('receiveWebhook(a,i)', 'receiveWebhook(a,i),pn.receiveWebhook(a,i)')],
      ['wrong controller context', f.source.replace('pn.findChatwoot(a)', 'other.findChatwoot(a)')],
      ['wrong schema context', f.source.replace('schema:v,ClassRef:b,execute:(a,i)', 'schema:Other,ClassRef:b,execute:(a,i)')],
      ['changed router boundary', f.source.replace('}};', '}')],
    ]) await t.test(name, () => rejected(services + source));
    await t.test('unrelated webhook route remains untouched', () => {
      const unrelated = '.post(this.routerPath("webhook"),async(req,res)=>res.status(200).json({ok:true}))';
      const result = run(services + f.source + unrelated);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, services + chatwootRouteFixture({ singleton: 'shared' }, true, false).source + unrelated);
    });
    const signedFind = '.post(this.routerPath("set"),...g,async(req,res)=>{svc.webhook.set(a.instanceName,b)})' +
      `.get(this.routerPath("find"),...g,async(req,res)=>{let result=await this.dataValidate({request:req,schema:Schema,ClassRef:Dto,execute:async i=>{let r=await svc.webhook.get(i.instanceName);if(r){r.nexi_event_signed=${transportHelper}.eventSigningReady();r.nexi_event_key_check=${transportHelper}.eventKeyProof(i.instanceName)}return r}});res.status(200).json(result)})}};`;
    const isolated = services.replace(/=(new Ctor\([^)]*\))/g, (_m, call) => `=${transportHelper}.isolateChatwoot(${call})`);
    const corrected = chatwootRouteFixture({ singleton: 'shared' }, true);
    const marked = '/* nexi-p3-chatwoot-transport */\n' + isolated + signedFind + corrected.source;
    await t.test('marked corrected route is byte-identical on reapplication', () => {
      const result = run(marked, true);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, marked);
    });
    for (const [name, source] of [
      ['marked old route rejected', marked.replace(corrected.route, f.route)],
      ['marked duplicate route rejected', marked + corrected.source],
      ['marked incorrect singleton rejected', marked.replace('await shared.getProvider', 'await wrong.getProvider')],
      ['marked malformed response rejected', marked.replace('json(n.body)', 'json(n.other)')],
    ]) await t.test(name, () => {
      const result = run(source, true);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /authenticated chatwoot webhook route:/);
      assert.equal(result.output, source);
    });
    await t.test('marked stale transport proof rejected', () => {
      const source = marked.replace('n.nexi_transport_hardened=true;n.nexi_replay_store_ready=await ' + transportHelper + '.replayStoreReady();', '');
      const result = run(source, true);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /chatwoot transport proof: marked bundle is not corrected/);
      assert.equal(result.output, source);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('remaining anchors bind renamed identifiers and fail closed', async (t) => {
  const h = transportHelper;
  const fixtures = [
    ['managed Chatwoot Inbox ID required', 'async setChatwoot(t){if(!this.configService.get("CHATWOOT").ENABLED)return;',
      `async setChatwoot(t){if(!this.configService.get("CHATWOOT").ENABLED)return;if(this.instanceName.startsWith("nexi-wa-")&&!/^[1-9][0-9]{0,18}$/.test(String(t.inboxId||"")))throw new Error("chatwoot_inbox_id_required");`, 'setChatwoot', 'setOther'],
    ['Chatwoot Inbox ID storage and readback', 'nameInbox:t.nameInbox,signMsg;nameInbox:r.nameInbox,signMsg;nameInbox:x.nameInbox,signMsg',
      'nameInbox:t.nameInbox,inboxId:t.inboxId,signMsg;nameInbox:r.nameInbox,inboxId:r.inboxId,signMsg;nameInbox:x.nameInbox,inboxId:x.inboxId,signMsg', 'nameInbox', 'otherInbox'],
    ['cached Inbox ID validation', 'if(await this.cache.has(A))return await this.cache.get(A);let e=await this.clientCw(t);if(!e)return this.logger.warn("client not found"),null;',
      `let e=await this.clientCw(t);if(!e)return this.logger.warn("client not found"),null;if(await this.cache.has(A)){let c=await this.cache.get(A);if(${h}.inboxMatches(c,this.provider,t.instanceName))return c;await this.cache.delete(A)}`, 'cache.get(A)', 'cache.get(wrong)'],
    ['stable Inbox ID resolution', 'async getInbox(t){let n=s.payload.find(a=>a.name===this.getClientCwConfig().nameInbox);return n?(this.cache.set(A,n),n):(this.logger.warn("inbox not found"),null)}async next(){}',
      `async getInbox(t){let n=${h}.resolveConfiguredInbox(s.payload,this.provider,t.instanceName);return n?(this.cache.set(A,n),n):(this.logger.warn("inbox not found"),null)}async next(){}`, 'a.name', 'wrong.name'],
    ['local event log redaction', 'let M={local:`${e}.sendData-Webhook`,url:D,...f};this.logger.log(M)}try{if(u?.enabled&&S.test(u.url))',
      `let M={local:\`\${e}.sendData-Webhook\`,url:D,...${h}.redactEventForLog(f)};this.logger.log(M)}try{if(u?.enabled&&S.test(u.url))`, 'logger.log(M)', 'logger.log(wrong)'],
    ['global event log redaction', 'let U={local:`${e}.sendData-Webhook-Global`,url:D,...f};this.logger.log(U)}try{if(S.test(D))',
      `let U={local:\`\${e}.sendData-Webhook-Global\`,url:D,...${h}.redactEventForLog(f)};this.logger.log(U)}try{if(S.test(D))`, 'S.test(D)', 'S.test(wrong)'],
    ['QR terminal log', '_o.default.generate(A,{small:!0},r=>this.logger.log(`\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n`+r))',
      'this.logger.info({message:"QR generated",instanceName:this.instance.name,qrcodeCount:this.instance.qrcode.count})', '`+r)', '`+wrong)'],
    ['missing chatwoot client failure', 'if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))return this.logger.warn("client not found"),null;',
      'if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))throw new Error("chatwoot_provider_unavailable");', 'setTimeout(g,500)', 'setTimeout(wrong,500)'],
    ['missing WhatsApp instance failure', 'if(!i&&A.conversation?.id)return this.onSendMessageError(t,A.conversation?.id,"Instance not found"),{message:"bot"};',
      'if(!i){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id,"Instance not found");throw new Error("chatwoot_instance_unavailable")}', 'onSendMessageError(t,A.', 'onSendMessageError(t,wrong.'],
    ['media send failure', '!I&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id),await this.updateChatwootMessageId({...I}',
      'if(!I){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id);throw new Error("chatwoot_media_send_failed")}await this.updateChatwootMessageId({...I}', '{...I}', '{...wrong}'],
    ['delete send failure', 'await i?.client.sendMessage(c.remoteJid,{delete:c}),await this.prismaRepository.message.deleteMany',
      'if(!await i?.client.sendMessage(c.remoteJid,{delete:c}))throw new Error("chatwoot_delete_failed");await this.prismaRepository.message.deleteMany', 'delete:c', 'delete:wrong'],
    ['template send failure', 'q("/message/sendText"),await i?.textMessage(g)}return{message:"bot"}',
      'q("/message/sendText");if(!await i?.textMessage(g))throw new Error("chatwoot_template_send_failed")}return{message:"bot"}', '"/message/sendText"', '"/message/other"'],
    ['outbound failure response', 'catch(e){return this.logger.error(e),{message:"bot"}}}async updateChatwootMessageId',
      'catch(e){this.logger.error("chatwoot_transport_failed");throw new Error("chatwoot_transport_failed")}}async updateChatwootMessageId', 'logger.error(e)', 'logger.error(wrong)'],
    ['signed Evolution event', 'let M={...E,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},U=Li.default.create({baseURL:D,headers:M,timeout:I.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(U,f,`${e}.sendData-Webhook`,D,a)',
      `let M={...E,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},__nexiPrepared=${h}.prepareEvent(M,f,A,this.monitor.waInstances[A].instanceId),U=Li.default.create({baseURL:D,headers:__nexiPrepared.headers,timeout:I.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(U,__nexiPrepared.body,\`\${e}.sendData-Webhook\`,D,a)`, 'headers:M', 'headers:wrong'],
    ['fresh retry auth', 'this.retryWebhookRequest(U,__nexiPrepared.body,',
      `this.retryWebhookRequest(${h}.signedEventClient(U,__nexiPrepared),__nexiPrepared.body,`, '__nexiPrepared.body', 'wrong.body'],
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-remaining-anchors-'));
  function run(source, label) {
    const target = path.join(directory, 'candidate.js'); fs.writeFileSync(target, source);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'patch-channel-transport.mjs'), '--anchor-only=' + label],
      { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target }, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(target, 'utf8') };
  }
  const names = new Set(['t', 'r', 'x', 'A', 'e', 'a', 's', 'M', 'U', 'D', 'f', 'u', 'S', '_o', 'g', 'i', 'I', 'c', 'q', 'E', 'Li', 'n']);
  // Fixtures contain no sensitive strings. Rename only complete identifier tokens
  // outside property accesses; properties and diagnostic literals stay stable.
  function rename(source) {
    return source.replace(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g, (token, offset) =>
      source[offset - 1] === '.' && source.slice(offset - 3, offset) !== '...' ? token : names.has(token) ? '$$renamed_' + token : token);
  }
  try {
    for (const [label, old, expected, malformedBefore, malformedAfter] of fixtures) {
      await t.test(label, () => {
        for (const renamed of [false, true]) {
          const source = renamed ? rename(old) : old;
          let wanted = renamed ? rename(expected) : expected;
          // The cache-local binding is patcher-owned, not an upstream symbol.
          if (renamed && label === 'cached Inbox ID validation') wanted = wanted.replaceAll('$$renamed_c', 'c');
          const result = run(source, label);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.output, wanted);
        }
        for (const source of ['const unrelated=1;', old + ';' + old, old.replace(malformedBefore, malformedAfter), expected]) {
          const result = run(source, label);
          assert.notEqual(result.status, 0, `${label} must reject missing/duplicate/malformed/repeated target`);
          assert.ok(result.stderr.includes(label));
          assert.equal(result.output, source, 'failed patch never writes a partial bundle');
        }
      });
    }
    await t.test('cache local name avoids a captured input collision', () => {
      const source = fixtures.find(([label]) => label === 'cached Inbox ID validation')[1].replaceAll('clientCw(t)', 'clientCw(c)');
      const result = run(source, 'cached Inbox ID validation');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.output.includes('let __nexiCachedInbox='));
      assert.ok(result.output.includes('inboxMatches(__nexiCachedInbox,this.provider,c.instanceName)'));
    });
    await t.test('signing refuses a pre-existing helper binding', () => {
      const source = 'let __nexiPrepared=other;' + fixtures.find(([label]) => label === 'signed Evolution event')[1];
      const result = run(source, 'signed Evolution event');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /prepared binding collision/);
      assert.equal(result.output, source);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('compiled QR callback preserves its lifecycle fence and fails closed', async (t) => {
  // Byte-for-byte connectionUpdate method from the pinned MySQL tsup bundle,
  // after all accepted source overlays and patch-instance-create, before P3.
  // Keeping the owning method includes pairing, QR events and persistence;
  // these bytes must remain unchanged outside the terminal diagnostic.
  const compiled = "async connectionUpdate({qr:A,connection:e,lastDisconnect:s},n=require(\"/evolution/nexi-groups.cjs\").lifecycleCapture(this)){if(require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n))try{let a=s?.error?.output?.statusCode;if(this.logger.info({message:\"Connection update received\",connection:e,hasQr:!!A,statusCode:a,instanceName:this.instance.name,isDeleting:this.isDeleting,endSession:this.endSession}),A){if(this.instance.qrcode.count===this.configService.get(\"QRCODE\").LIMIT)return this.sendDataWebhook(\"qrcode.updated\",{message:\"QR code limit reached, please login again\",statusCode:T.DisconnectReason.badSession}),this.configService.get(\"CHATWOOT\").ENABLED&&this.localChatwoot?.enabled&&this.chatwootService.eventWhatsapp(\"qrcode.updated\",{instanceName:this.instance.name,instanceId:this.instanceId},{message:\"QR code limit reached, please login again\",statusCode:T.DisconnectReason.badSession}),this.sendDataWebhook(\"connection.update\",{instance:this.instance.name,state:\"refused\",statusReason:T.DisconnectReason.connectionClosed,wuid:this.instance.wuid,profileName:await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>this.getProfileName()),profilePictureUrl:this.instance.profilePictureUrl}),require(\"/evolution/nexi-groups.cjs\").cancelLifecycle(n),this.endSession=!0,this.eventEmitter.emit(\"no.connection\",this.instance.name,require(\"/evolution/nexi-groups.cjs\").lifecycleCapture(this,n.socket,!0));this.instance.qrcode.count++;let r={margin:3,scale:4,errorCorrectionLevel:\"H\",color:{light:\"#ffffff\",dark:this.configService.get(\"QRCODE\").COLOR}};this.phoneNumber?(await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>(0,T.delay)(1e3)),this.instance.qrcode.pairingCode=await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>n.socket.requestPairingCode(this.phoneNumber))):this.instance.qrcode.pairingCode=null,_o.default.toDataURL(A,r,(g,c)=>{if(require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n)){if(g){this.logger.error(\"Qrcode generate failed:\"+g.toString());return}this.instance.qrcode.base64=c,this.instance.qrcode.code=A,this.sendDataWebhook(\"qrcode.updated\",{qrcode:{instance:this.instance.name,pairingCode:this.instance.qrcode.pairingCode,code:A,base64:c}}),this.configService.get(\"CHATWOOT\").ENABLED&&this.localChatwoot?.enabled&&this.chatwootService.eventWhatsapp(\"qrcode.updated\",{instanceName:this.instance.name,instanceId:this.instanceId},{qrcode:{instance:this.instance.name,pairingCode:this.instance.qrcode.pairingCode,code:A,base64:c}})}}),Lo.default.generate(A,{small:!0},g=>require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n)&&this.logger.log(`\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n`+g)),await require(\"/evolution/nexi-groups.cjs\").persistLifecycle(n,{where:{id:this.instanceId},data:{connectionStatus:\"connecting\"}})}if(e&&(this.stateConnection={state:e,statusReason:s?.error?.output?.statusCode??200}),e===\"close\"){if(await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>require(\"/evolution/nexi-groups.cjs\").recordSuspension(this,s?.error,\"connection.update\")))return;if(this.isDeleting||this.endSession){this.logger.info(\"Instance is being deleted/ended, skipping reconnection attempt\");return}let i=s?.error?.output?.statusCode,r=[T.DisconnectReason.loggedOut,T.DisconnectReason.forbidden,402,406,408];if(!this.instance.wuid&&(this.instance.qrcode?.count??0)===0){this.logger.info(\"Initial connection closed, waiting for QR code generation...\");return}let c=Date.now()-this._lastStream515At<qe.STREAM_515_RECONNECT_GRACE_MS,l=!r.includes(i)||i===T.DisconnectReason.loggedOut&&c;if(this.logger.info({message:\"Connection closed, evaluating reconnection\",statusCode:i,shouldReconnect:l,instanceName:this.instance.name}),l)this.logger.info(\"Reconnecting in 3 seconds...\"),require(\"/evolution/nexi-groups.cjs\").scheduleLifecycle(n,async()=>{await this.connectToWhatsapp(this.phoneNumber)},3e3);else{if(this.logger.info(`Skipping reconnection for status code ${i} (code is in codesToNotReconnect list)`),this.sendDataWebhook(\"status.instance\",{instance:this.instance.name,status:\"closed\",disconnectionAt:new Date,disconnectionReasonCode:i,disconnectionObject:JSON.stringify(s)}),await require(\"/evolution/nexi-groups.cjs\").persistLifecycle(n,{where:{id:this.instanceId},data:{connectionStatus:\"close\",disconnectionAt:new Date,disconnectionReasonCode:i,disconnectionObject:JSON.stringify(s)}}),this.configService.get(\"CHATWOOT\").ENABLED&&this.localChatwoot?.enabled&&this.chatwootService.eventWhatsapp(\"status.instance\",{instanceName:this.instance.name,instanceId:this.instanceId},{instance:this.instance.name,status:\"closed\"}),require(\"/evolution/nexi-groups.cjs\").cancelLifecycle(n),n=require(\"/evolution/nexi-groups.cjs\").lifecycleCapture(this,n.socket,!0),this.eventEmitter.emit(\"logout.instance\",this.instance.name,\"inner\",n),!require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n)||(n.socket?.ws?.close(),!require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n)))return;n.socket.end(new Error(\"Close connection\")),this.sendDataWebhook(\"connection.update\",{instance:this.instance.name,...this.stateConnection})}}if(e===\"open\"){if(!n.socket?.user?.id){this.logger.warn(\"connectionUpdate: connection open but client.user is undefined, skipping\");return}this.instance.wuid=n.socket.user.id.replace(/:\\d+/,\"\");try{let g=await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>this.profilePicture(this.instance.wuid));this.instance.profilePictureUrl=g.profilePictureUrl}catch{if(!require(\"/evolution/nexi-groups.cjs\").lifecycleCurrent(n))return;this.instance.profilePictureUrl=null}let i=this.instance.wuid.split(\"@\")[0].padEnd(30,\" \"),r=this.instance.name;this.logger.info(`\n        \\u250C\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2510\n        \\u2502    CONNECTED TO WHATSAPP     \\u2502\n        \\u2514\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2518`.replace(/^ +/gm,\"  \")),this.logger.info(`\n        wuid: ${i}\n        name: ${r}\n      `),await require(\"/evolution/nexi-groups.cjs\").persistLifecycle(n,{where:{id:this.instanceId},data:{ownerJid:this.instance.wuid,profileName:await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>this.getProfileName()),profilePicUrl:this.instance.profilePictureUrl,connectionStatus:\"open\"}}),this.configService.get(\"CHATWOOT\").ENABLED&&this.localChatwoot?.enabled&&(this.chatwootService.eventWhatsapp(\"connection.update\",{instanceName:this.instance.name,instanceId:this.instanceId},{instance:this.instance.name,status:\"open\"}),this.syncChatwootLostMessages()),this.sendDataWebhook(\"connection.update\",{instance:this.instance.name,wuid:this.instance.wuid,profileName:await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(n,()=>this.getProfileName()),profilePictureUrl:this.instance.profilePictureUrl,...this.stateConnection})}e===\"connecting\"&&this.sendDataWebhook(\"connection.update\",{instance:this.instance.name,...this.stateConnection})}catch(a){if(a?.code===\"NEXI_SOCKET_LIFECYCLE_STALE\")return;throw a}}";
  const current = 'Lo.default.generate(A,{small:!0},g=>require("/evolution/nexi-groups.cjs").lifecycleCurrent(n)&&this.logger.log(`\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n`+g))';
  const guard = 'require("/evolution/nexi-groups.cjs").lifecycleCurrent(n)&&';
  const historical = current.replace(guard, '');
  const info = 'this.logger.info({message:"QR generated",instanceName:this.instance.name,qrcodeCount:this.instance.qrcode.count})';
  // Frozen pre-correction anchor, with the same captures/backreferences.
  const oldPattern = /(?<![\w$.])(?<module>[A-Za-z_$][\w$]*)\.default\.generate\((?<qr>[A-Za-z_$][\w$]*),\{small:!0\},(?<output>[A-Za-z_$][\w$]*)=>this\.logger\.log\(`\n\{ instance: \$\{this\.instance\.name\} pairingCode: \$\{this\.instance\.qrcode\.pairingCode\}, qrcodeCount: \$\{this\.instance\.qrcode\.count\} \}\n`\+\k<output>\)\)/g;
  assert.equal(compiled.split(current).length, 2, 'fixture contains the actual unique terminal callback');
  assert.equal([...compiled.matchAll(oldPattern)].length, 0, 'historical matcher reproduces EasyPanel zero matches');
  assert.equal([...historical.matchAll(oldPattern)].length, 1, 'historical supported callback is unchanged');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-compiled-qr-'));
  function run(source, provider = 'mysql') {
    const target = path.join(directory, 'candidate.js'); fs.writeFileSync(target, source);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'patch-channel-transport.mjs'), '--anchor-only=QR terminal log'],
      { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target, EVOLUTION_PROVIDER: provider }, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(target, 'utf8') };
  }
  try {
    for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
      await t.test(`${provider}: exactly one current callback; only terminal diagnostic changes`, () => {
        const result = run(compiled, provider);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, compiled.replace(current, guard + info));
        assert.equal(result.output.split(info).length, 2);
      });
    }
    await t.test('historical callback remains supported', () => {
      const source = compiled.replace(current, historical), result = run(source);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, source.replace(historical, info));
    });
    await t.test('renamed QR, renderer, output and lifecycle bindings', () => {
      const source = current.replace('Lo.default', '$renderer.default').replace('(A,', '(_qr,')
        .replace('g=>', '$output=>').replace('+g)', '+$output)').replace('lifecycleCurrent(n)', 'lifecycleCurrent($owner)');
      const result = run(source);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, guard.replace('(n)', '($owner)') + info);
    });
    const unrelated = current.replace('pairingCode:', 'unrelatedCode:');
    await t.test('superficially similar QR diagnostic is left byte-identical', () => {
      const source = compiled + ';' + unrelated, result = run(source);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output, compiled.replace(current, guard + info) + ';' + unrelated);
    });
    for (const [name, source, count] of [
      ['target absent', compiled.replace(current, 'unrelated()'), 0],
      ['two current targets', compiled + ';' + current, 2],
      ['current and historical targets', compiled + ';' + historical, 2],
      ['unrelated QR/log only', unrelated, 0],
      ['wrong helper module', current.replace('nexi-groups.cjs', 'other.cjs'), 0],
      ['wrong lifecycle predicate', current.replace('lifecycleCurrent', 'lifecycleCapture'), 0],
      ['missing lifecycle argument', current.replace('lifecycleCurrent(n)', 'lifecycleCurrent()'), 0],
      ['extra lifecycle argument', current.replace('lifecycleCurrent(n)', 'lifecycleCurrent(n,other)'), 0],
      ['wrong short-circuit operator', current.replace('&&this.logger', '||this.logger'), 0],
      ['wrong output binding', current.replace('+g)', '+wrong)'), 0],
      ['wrong instance context', current.replace('this.instance.name', 'other.instance.name'), 0],
      ['malformed callback boundary', current.slice(0, -1), 0],
      ['already corrected', guard + info, 0],
    ]) await t.test(name, () => {
      const result = run(source);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`QR terminal log: expected 1 structural targets, found ${count}`), result.stderr);
      assert.equal(result.output, source, 'failure leaves the artifact byte-identical');
    });
    await t.test('current owner logs only safe metadata; stale owner emits nothing', () => {
      const result = run(current);
      assert.equal(result.status, 0, result.stderr);
      const owner = {}, calls = [], subject = { instance: { name: 'synthetic', qrcode: { count: 3 } },
        logger: { info: value => calls.push(value) } };
      const evaluate = new Function('require', 'n', result.output);
      for (const valid of [false, true]) {
        evaluate.call(subject, module => {
          assert.equal(module, '/evolution/nexi-groups.cjs');
          return { lifecycleCurrent: value => { assert.equal(value, owner); return valid; } };
        }, owner);
        assert.equal(calls.length, valid ? 1 : 0);
      }
      assert.deepEqual(calls, [{ message: 'QR generated', instanceName: 'synthetic', qrcodeCount: 3 }]);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('compiled Chatwoot control fences retain the existing failure contracts', async (t) => {
  // Actual owning receiveWebhook method from the same pre-channel MySQL bundle.
  const compiled = "async receiveWebhook(t,A){require(\"/evolution/nexi-groups.cjs\").validateTargets(require(\"/evolution/nexi-groups.cjs\").managed(t.instanceName),{jid:A?.conversation?.meta?.sender?.identifier,number:A?.conversation?.meta?.sender?.phone_number,target:A?.meta?.sender?.identifier,payload:A});let e=this.waMonitor?.waInstances?.[t.instanceName],s=e&&require(\"/evolution/nexi-groups.cjs\").lifecycleCapture(e,e.client,!0),n=A?.message_type===\"outgoing\"&&A?.conversation?.meta?.sender?.identifier===\"123456\",a=!1,i=()=>{n&&require(\"/evolution/nexi-groups.cjs\").lifecycleCheck(s)};try{await new Promise(m=>setTimeout(m,500)),i();let r=await this.clientCw(t);if(i(),!r)return this.logger.warn(\"client not found\"),null;if(this.provider.reopenConversation===!1&&A.event===\"conversation_status_changed\"&&A.status===\"resolved\"&&A.meta?.sender?.identifier){let m=`${t.instanceName}:createConversation-${A.meta.sender.identifier}`;this.cache.delete(m)}if(!A?.conversation||A.private||A.event===\"message_updated\"&&!A.content_attributes?.deleted)return{message:\"bot\"};let g=A.conversation.meta.sender?.identifier||A.conversation.meta.sender?.phone_number.replace(\"+\",\"\"),c=A.content?A.content.replaceAll(/(?<!\\*)\\*((?!\\s)([^\\n*]+?)(?<!\\s))\\*(?!\\*)/g,\"_$1_\").replaceAll(/\\*{2}((?!\\s)([^\\n*]+?)(?<!\\s))\\*{2}/g,\"*$1*\").replaceAll(/~{2}((?!\\s)([^\\n*]+?)(?<!\\s))~{2}/g,\"~$1~\").replaceAll(/(?<!`)`((?!\\s)([^`*]+?)(?<!\\s))`(?!`)/g,\"```$1```\"):A.content,l=A?.conversation?.messages[0]?.sender?.available_name||A?.sender?.name,C=this.waMonitor.waInstances[t.instanceName];if(t.instanceId=C.instanceId,A.event===\"message_updated\"&&A.content_attributes?.deleted){let m=await this.prismaRepository.message.findFirst({where:{chatwootMessageId:A.id,instanceId:t.instanceId}});if(m){let d=m.key;await C?.client.sendMessage(d.remoteJid,{delete:d}),await this.prismaRepository.message.deleteMany({where:{instanceId:t.instanceId,chatwootMessageId:A.id}})}return{message:\"bot\"}}let u=this.configService.get(\"CHATWOOT\").BOT_CONTACT;if(g===\"123456\"&&A.message_type===\"outgoing\"){i();let m=c.replace(\"/\",\"\");if(u&&(m.includes(\"init\")||m.includes(\"iniciar\")))if(C?.connectionStatus?.state!==\"open\"){let I=m.split(\":\")[1];await require(\"/evolution/nexi-groups.cjs\").controlConnect(s,I)}else await this.createBotMessage(t,H.t(\"cw.inbox.alreadyConnected\",{inboxName:A.inbox.name}),\"incoming\");if(m===\"clearcache\"&&(C.clearCacheChatwoot(),await this.createBotMessage(t,H.t(\"cw.inbox.clearCache\",{inboxName:A.inbox.name}),\"incoming\")),m===\"status\"){let d=C?.connectionStatus?.state;d||await this.createBotMessage(t,H.t(\"cw.inbox.notFound\",{inboxName:A.inbox.name}),\"incoming\"),d&&await this.createBotMessage(t,H.t(\"cw.inbox.status\",{inboxName:A.inbox.name,state:d}),\"incoming\")}if(u&&(m===\"disconnect\"||m===\"desconectar\")){let d=H.t(\"cw.inbox.disconnect\",{inboxName:A.inbox.name});return a=!0,await require(\"/evolution/nexi-groups.cjs\").manualLifecycle(s,async()=>{await require(\"/evolution/nexi-groups.cjs\").cleanupLifecycle(s,async h=>require(\"/evolution/nexi-groups.cjs\").persistLifecycle(s,{data:{connectionStatus:\"close\",disconnectionObject:\"nexi_socket_manual_close\",disconnectionReasonCode:401}},h));try{await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(s,()=>this.createBotMessage(t,H.t(\"cw.inbox.status\",{inboxName:A.inbox.name,state:\"pending\"}),\"incoming\"))}catch{require(\"/evolution/nexi-groups.cjs\").lifecycleCheck(s),this.logger.warn(\"nexi_socket_control_response_unavailable\")}await require(\"/evolution/nexi-groups.cjs\").cleanupLifecycle(s,async()=>{});let B=\"transport_unavailable\";if(s.socket?.ws&&s.socket.ws.isClosed!==!0&&s.socket.ws.isClosing!==!0)try{await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(s,()=>s.socket?.logout(\"Log out instance: \"+t.instanceName)),B=\"succeeded\"}catch(h){if(h?.code===\"NEXI_SOCKET_LIFECYCLE_STALE\")throw h;require(\"/evolution/nexi-groups.cjs\").lifecycleCheck(s),B=h?.output?.statusCode===428?\"transport_unavailable\":\"failed\",this.logger.warn(B===\"transport_unavailable\"?\"nexi_socket_remote_logout_transport_unavailable\":\"nexi_socket_remote_logout_failed\")}await require(\"/evolution/nexi-groups.cjs\").cleanupLifecycle(s,async()=>{}),await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(s,()=>s.socket?.end(new Error(\"nexi_socket_manual_close\"))),s.socket?.ws?.isClosed!==!0&&s.socket?.ws?.isClosing!==!0&&await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(s,()=>s.socket?.ws?.close()),await require(\"/evolution/nexi-groups.cjs\").cleanupLifecycle(s,async h=>require(\"/evolution/nexi-groups.cjs\").persistLifecycle(s,{data:{connectionStatus:\"close\",disconnectionObject:\"nexi_socket_manual_close\",disconnectionReasonCode:401}},h)),require(\"/evolution/nexi-groups.cjs\").lifecycleCheck(s),s.service.stateConnection.state=\"close\";try{await require(\"/evolution/nexi-groups.cjs\").lifecycleAwait(s,()=>this.createBotMessage(t,d,\"incoming\"))}catch{require(\"/evolution/nexi-groups.cjs\").lifecycleCheck(s),this.logger.warn(\"nexi_socket_control_response_unavailable\")}return{message:\"bot\",lifecycle:\"disconnected\",remoteLogout:B}})||{message:\"bot\",lifecycle:\"superseded\"}}}if(A.message_type===\"outgoing\"&&A?.conversation?.messages?.length&&g!==\"123456\"){if(A?.conversation?.messages[0]?.source_id?.substring(0,5)===\"WAID:\")return{message:\"bot\"};if(!C&&A.conversation?.id)return this.onSendMessageError(t,A.conversation?.id,\"Instance not found\"),{message:\"bot\"};let m;if(l==null)m=c;else{let I=this.provider.signDelimiter?this.provider.signDelimiter.replaceAll(\"\\\\n\",`\n`):`\n`,B=this.provider.signMsg?[`*${l}:*`]:[];B.push(c),m=B.join(I)}for(let I of A.conversation.messages)if(I.attachments&&I.attachments.length>0)for(let B of I.attachments){c||(m=null);let h={quoted:await this.getQuotedMessage(A,t)},y=await this.sendAttachment(C,g,B.data_url,m,h);!y&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id),await this.updateChatwootMessageId({...y},{messageId:A.id,inboxId:A.inbox?.id,conversationId:A.conversation?.id,contactInboxSourceId:A.conversation?.contact_inbox?.source_id},t)}else{let B={number:g,text:m,delay:Math.floor(Math.random()*1501)+500,quoted:await this.getQuotedMessage(A,t)};Z(\"/message/sendText\");let h;try{if(h=await C?.textMessage(B,!0),!h)throw new Error(\"Message not sent\");ye.default.isLong(h?.messageTimestamp)&&(h.messageTimestamp=h.messageTimestamp?.toNumber()),await this.updateChatwootMessageId({...h},{messageId:A.id,inboxId:A.inbox?.id,conversationId:A.conversation?.id,contactInboxSourceId:A.conversation?.contact_inbox?.source_id},t)}catch(y){throw!h&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id,y),y}}if(this.configService.get(\"CHATWOOT\").MESSAGE_READ){let I=await this.prismaRepository.message.findFirst({where:{key:{path:[\"fromMe\"],equals:!1},instanceId:t.instanceId}});if(I&&!I.chatwootIsRead){let B=I.key;C?.markMessageAsRead({readMessages:[{id:B.id,fromMe:B.fromMe,remoteJid:B.remoteJid}]});let h={chatwootMessageId:I.chatwootMessageId,chatwootConversationId:I.chatwootConversationId,chatwootInboxId:I.chatwootInboxId,chatwootContactInboxSourceId:I.chatwootContactInboxSourceId,chatwootIsRead:!0};await this.prismaRepository.message.updateMany({where:{instanceId:t.instanceId,key:{path:[\"id\"],equals:B.id}},data:h})}}}if(A.message_type===\"template\"&&A.event===\"message_created\"){let m={number:g,text:A.content.replace(/\\\\\\r\\n|\\\\\\n|\\n/g,`\n`),delay:Math.floor(Math.random()*1501)+500};Z(\"/message/sendText\"),await C?.textMessage(m)}return{message:\"bot\"}}catch(r){return r?.code===\"NEXI_SOCKET_LIFECYCLE_STALE\"?{message:\"bot\",lifecycle:\"superseded\"}:a?(this.logger.warn(\"nexi_socket_manual_disconnect_unavailable\"),{message:\"bot\",lifecycle:\"disconnect_failed\"}):(this.logger.error(r),{message:\"bot\"})}}";
  const lookup = 'i=()=>{n&&require("/evolution/nexi-groups.cjs").lifecycleCheck(s)};try{await new Promise(m=>setTimeout(m,500)),i();let r=await this.clientCw(t);if(i(),!r)return this.logger.warn("client not found"),null;';
  const caught = 'catch(r){return r?.code==="NEXI_SOCKET_LIFECYCLE_STALE"?{message:"bot",lifecycle:"superseded"}:a?(this.logger.warn("nexi_socket_manual_disconnect_unavailable"),{message:"bot",lifecycle:"disconnect_failed"}):(this.logger.error(r),{message:"bot"})}}async updateChatwootMessageId';
  const lookupAfter = lookup.replace('return this.logger.warn("client not found"),null;', 'throw new Error("chatwoot_provider_unavailable");');
  const caughtAfter = caught.replace('this.logger.error(r),{message:"bot"})', '()=>{this.logger.error("chatwoot_transport_failed");throw new Error("chatwoot_transport_failed")})()');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-compiled-chatwoot-'));
  function run(source, label) {
    const target = path.join(directory, 'candidate.js'); fs.writeFileSync(target, source);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'patch-channel-transport.mjs'), '--anchor-only=' + label],
      { env: { ...process.env, EVOLUTION_BUNDLE_PATH: target }, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(target, 'utf8') };
  }
  try {
    for (const [label, before, after, source, malformed] of [
      ['missing chatwoot client failure', lookup, lookupAfter, compiled, [
        lookup.replace('if(i(),!r)', 'if(other(),!r)'), lookup.replace('setTimeout(m,500)', 'setTimeout(other,500)'),
        lookup.replace('!r)', '!other)'), lookup.replace('lifecycleCheck(s)', 'otherCheck(s)'),
        lookup.replace('try{', 'try('),
      ]],
      ['outbound failure response', caught, caughtAfter, compiled + 'async updateChatwootMessageId', [
        caught.replace('r?.code', 'other?.code'), caught.replace('this.logger.error(r)', 'this.logger.error(other)'),
        caught.replace('"superseded"', '"other"'), caught.replace('"disconnect_failed"', '"other"'),
        caught.replace('})}}async', '}}}async'),
      ]],
    ]) {
      await t.test(`${label}: exactly one owning target; accepted checks/responses unchanged`, () => {
        assert.equal(source.split(before).length, 2);
        const result = run(source, label);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, source.replace(before, after));
      });
      for (const [index, candidate] of [source.replace(before, ''), source + ';' + before, after, ...malformed].entries()) {
        await t.test(`${label}: absent/ambiguous/malformed/repeated ${index}`, () => {
          const result = run(candidate, label);
          assert.notEqual(result.status, 0);
          assert.ok(result.stderr.includes(label));
          assert.equal(result.output, candidate);
        });
      }
    }
    await t.test('control catch preserves stale/disconnect responses and throws generic transport failures', () => {
      const result = run(caught, 'outbound failure response');
      assert.equal(result.status, 0, result.stderr);
      const body = result.output.slice(0, -'}async updateChatwootMessageId'.length);
      const effects = [], subject = { logger: { warn: value => effects.push(value), error: value => effects.push(value) } };
      const execute = new Function('failure', 'a', 'try{throw failure}' + body);
      assert.deepEqual(execute.call(subject, { code: 'NEXI_SOCKET_LIFECYCLE_STALE' }, true), { message: 'bot', lifecycle: 'superseded' });
      assert.deepEqual(effects, []);
      assert.deepEqual(execute.call(subject, new Error('synthetic'), true), { message: 'bot', lifecycle: 'disconnect_failed' });
      assert.deepEqual(effects, ['nexi_socket_manual_disconnect_unavailable']);
      assert.throws(() => execute.call(subject, new Error('synthetic'), false), { message: 'chatwoot_transport_failed' });
      assert.deepEqual(effects, ['nexi_socket_manual_disconnect_unavailable', 'chatwoot_transport_failed']);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('patched image bundle preserves the direct message path and fails closed', { skip: !process.env.EVOLUTION_BUNDLE_PATH }, () => {
  const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
  const route = bundle.search(/processChatwootWebhook\([\w$]+,await [A-Za-z_$][\w$]*\.getProvider/);
  const dispatchMatch = /execute:\(([\w$]+),([\w$]+)\)=>[\w$]+\.receiveWebhook\(\1,\2\)/.exec(bundle.slice(route));
  const dispatch = route + (dispatchMatch?.index ?? -1);
  assert.ok(route >= 0 && dispatch > route);
  assert.match(bundle.slice(route, dispatch), /\(\)=>this\.dataValidate\(/);
  assert.match(bundle.slice(dispatch, dispatch + 300), /receiveWebhook\([\w$]+,[\w$]+\)\}\)\);return [\w$]+\.status\(([\w$]+)\.status\)\.json\(\1\.body\)/);
  assert.doesNotMatch(bundle.slice(route, route + 700), /delivery_already_recorded/);
  for (const pattern of [
    /inboxId:[\w$]+\.inboxId/,
    /resolveConfiguredInbox\([\w$]+\.payload,this\.provider,[\w$]+\.instanceName\)/,
    /([\w$]+)\.private\|\|\1\.event==="message_updated"/,
    /substring\(0,5\)==="WAID:"/,
    /await [\w$]+\?\.textMessage\([\w$]+,!0\)/,
    /chatwoot_media_send_failed/, /chatwoot_template_send_failed/, /chatwoot_delete_failed/,
    /catch\((?<error>[\w$]+)\)\{(?:return \k<error>\?\.code==="NEXI_SOCKET_LIFECYCLE_STALE"\?\{message:"bot",lifecycle:"superseded"\}:[\w$]+\?\(this\.logger\.warn\("nexi_socket_manual_disconnect_unavailable"\),\{message:"bot",lifecycle:"disconnect_failed"\}\):\(\(\)=>\{this\.logger\.error\("chatwoot_transport_failed"\);throw new Error\("chatwoot_transport_failed"\)\}\)\(\)|this\.logger\.error\("chatwoot_transport_failed"\);throw new Error\("chatwoot_transport_failed"\))\}\}async updateChatwootMessageId/,
    /prepareEvent\([\w$]+,[\w$]+,([\w$]+),this\.monitor\.waInstances\[\1\]\.instanceId\)/,
  ]) assert.ok(pattern.test(bundle), `missing bundle contract: ${pattern}`);
  assert.ok(!/catch\(([\w$]+)\)\{return this\.logger\.error\(\1\),\{message:"bot"\}\}\}async updateChatwootMessageId/.test(bundle));
  assert.ok(!/qrcodeCount: \$\{this\.instance\.qrcode\.count\}/.test(bundle));
});

function finalWebhookFind(bundle) {
  const id = '[A-Za-z_$][\\w$]*';
  const matches = [...bundle.matchAll(new RegExp(`execute:async (?<instance>${id})=>\\{let (?<inner>${id})=await (?<service>${id})\\.webhook\\.get\\(\\k<instance>\\.instanceName\\)`, 'g'))];
  assert.equal(matches.length, 1);
  const match = matches[0];
  const start = bundle.lastIndexOf('.get(this.routerPath("find"),', match.index);
  const header = bundle.slice(start).match(new RegExp(`^\\.get\\(this\\.routerPath\\("find"\\),\\.\\.\\.(?<guards>${id}),async\\((?<request>${id}),(?<response>${id})\\)=>\\{let (?<result>${id})=await this\\.dataValidate\\(\\{request:\\k<request>,schema:(?<schema>${id}),ClassRef:(?<dto>${id}),`));
  assert.ok(header);
  const g = { ...match.groups, ...header.groups };
  const suffix = `});${g.response}.status(200).json(${g.result})})`;
  const end = bundle.indexOf(suffix, match.index) + suffix.length;
  assert.ok(start >= 0 && end > match.index);
  const route = bundle.slice(start, end);
  const correctedExecute = route.slice(header[0].length, -suffix.length);
  const oldExecute = `execute:${g.instance}=>${g.service}.webhook.get(${g.instance}.instanceName)`;
  return { ...g, route, correctedExecute, oldExecute, oldRoute: route.replace(correctedExecute, () => oldExecute) };
}

test('final webhook/find route binds event proof to the validated instance', { skip: !process.env.EVOLUTION_BUNDLE_PATH }, async () => {
  const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
  const g = finalWebhookFind(bundle);
  const { route } = g;

  // Execute the route expression from the final bundle with only its external services stubbed.
  const compile = new Function('require', g.service, g.schema, g.dto, g.guards, 'dataValidate', 'capture', `
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
      { webhook: { get: async (name) => { received.push(name); return result; } } }, null, null, [() => {}],
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
    const g = finalWebhookFind(marked);
    const { route, correctedExecute, oldExecute, oldRoute } = g;
    const unmarked = marked.replace(/^\/\* nexi-p3-chatwoot-transport \*\/\r?\n/, '');
    assert.notEqual(unmarked, marked, 'final representative bundle has the marker');
    const oldBundle = unmarked.replace(route, () => oldRoute);
    assert.notEqual(oldBundle, unmarked);
    const unrelatedOld = route.replace('routerPath("find")', 'routerPath("other")')
      .replace(correctedExecute, () => oldExecute);
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
      assert.equal(result.output === source, true, 'failed patch must not write the bundle');
    }

    try {
      await t.test('unique correct route is patched', () => {
        const result = run(oldBundle);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output === unmarked, true);
      });
      await t.test('absent find route fails', () => {
        rejected(oldBundle.replace(oldRoute, () => oldRoute.replace('routerPath("find")', 'routerPath("missing")')));
      });
      await t.test('duplicate find route fails', () => {
        rejected(oldBundle.replace(oldRoute + '}};', () => oldRoute + oldRoute + '}};'));
      });
      await t.test('unrelated identical suffix is untouched', () => {
        const result = run(oldBundle + unrelatedOld);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output === unmarked + unrelatedOld, true);
      });
      await t.test('changed intended route with unrelated suffix fails', () => {
        rejected(oldBundle.replace(oldRoute, () => oldRoute.replace(oldExecute,
          () => oldExecute.replace(`${g.instance}.instanceName`, () => `${g.instance}.name`))) + unrelatedOld);
      });
      await t.test('duplicated transformation point inside intended route fails', () => {
        rejected(oldBundle.replace(oldRoute, () => oldRoute.replace(oldExecute, () => `${oldExecute},${oldExecute}`)));
      });
      await t.test('correct marked bundle is byte-identical on rerun', () => {
        const result = run(marked, false);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output === marked, true);
        assert.equal(createHash('sha256').update(result.output).digest('hex'),
          createHash('sha256').update(marked).digest('hex'));
      });
      await t.test('stale marked route with outer-variable proof fails', () => {
        const prefix = route.slice(0, route.indexOf(correctedExecute));
        const oldProof = `${oldExecute}});if(${g.result}){${g.result}.nexi_event_signed=require("/evolution/nexi-transport.cjs").eventSigningReady();` +
          `${g.result}.nexi_event_key_check=require("/evolution/nexi-transport.cjs").eventKeyProof(${g.request}.params.instanceName)}${g.response}.status(200).json(${g.result})})`;
        rejected(marked.replace(route, () => prefix + oldProof), false);
      });
      await t.test('proof only in unrelated route cannot validate marker', () => {
        rejected(marked.replace(route, () => oldRoute) + unrelatedCorrected, false);
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
