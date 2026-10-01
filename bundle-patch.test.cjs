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
    /catch\([\w$]+\)\{this\.logger\.error\("chatwoot_transport_failed"\);throw new Error\("chatwoot_transport_failed"\)/,
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
