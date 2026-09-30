import fs from 'node:fs';

const bundlePath = process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js';
const provider = process.env.EVOLUTION_PROVIDER || 'postgresql';
if (!['postgresql', 'psql_bouncer', 'mysql'].includes(provider)) throw new Error('unsupported Prisma provider');
const mysql = provider === 'mysql';
const marker = 'nexi-p3-chatwoot-transport';
const helper = 'require("/evolution/nexi-transport.cjs")';
let code = fs.readFileSync(bundlePath, 'utf8');

const identifier = '[A-Za-z_$][\\w$]*';
const webhookSet = new RegExp(`(${identifier})\\.webhook\\.set\\((${identifier})\\.instanceName,(${identifier})\\)`, 'g');
const findHeader = new RegExp(`^\\.get\\(this\\.routerPath\\("find"\\),\\.\\.\\.(${identifier}),async\\((${identifier}),(${identifier})\\)=>\\{let (${identifier})=await this\\.dataValidate\\(\\{request:(${identifier}),schema:(${identifier}),ClassRef:(${identifier}),`);

function callEnd(source, start) {
  const open = source.indexOf('(', start);
  let depth = 0;
  let quote = null;
  for (let pos = open; pos < source.length; pos++) {
    const char = source[pos];
    if (quote) {
      if (char === '\\') pos++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && --depth === 0) {
      return pos + 1;
    }
  }
  throw new Error('webhook/find: unclosed route call');
}

function webhookFindRoute(source) {
  const setCalls = [...source.matchAll(webhookSet)];
  if (setCalls.length !== 1) throw new Error(`webhook/find: expected one owning webhook/set route, found ${setCalls.length}`);
  const setCall = setCalls[0];
  const service = setCall[1];
  const findToken = '.get(this.routerPath("find"),';
  const webhookFindStarts = [];
  for (let start = source.indexOf(findToken); start >= 0;
    start = source.indexOf(findToken, start + findToken.length)) {
    if (source.slice(start, callEnd(source, start)).includes(`${service}.webhook.get(`)) webhookFindStarts.push(start);
  }
  if (webhookFindStarts.length !== 1) {
    throw new Error(`webhook/find: expected one webhook.get find route, found ${webhookFindStarts.length}`);
  }
  const postStart = source.lastIndexOf('.post(this.routerPath("set"),', setCall.index);
  if (postStart < 0) throw new Error('webhook/find: owning webhook/set route absent');
  const postEnd = callEnd(source, postStart);
  if (setCall.index + setCall[0].length > postEnd) throw new Error('webhook/find: webhook/set is outside set route');
  const post = source.slice(postStart, postEnd);
  const postHeader = post.match(new RegExp(`^\\.post\\(this\\.routerPath\\("set"\\),\\.\\.\\.(${identifier}),async\\((${identifier}),(${identifier})\\)=>\\{`));
  if (!postHeader) throw new Error('webhook/find: webhook/set route shape changed');

  const getStart = postEnd;
  if (!source.startsWith('.get(this.routerPath("find"),', getStart)) throw new Error('webhook/find: chained find route absent');
  if (webhookFindStarts[0] !== getStart) throw new Error('webhook/find: find route is outside owning router');
  const getEnd = callEnd(source, getStart);
  if (!source.startsWith('}};', getEnd)) throw new Error('webhook/find: find route is duplicated or boundary changed');
  const route = source.slice(getStart, getEnd);
  const header = route.match(findHeader);
  if (!header || header[1] !== postHeader[1] || header[2] !== header[5]) {
    throw new Error('webhook/find: find route validation shape changed');
  }
  const [, , , response, result] = header;
  const suffix = `});${response}.status(200).json(${result})})`;
  if (!route.endsWith(suffix)) throw new Error('webhook/find: find route response changed');
  const execute = route.slice(header[0].length, -suffix.length);
  const oldCallback = execute.match(new RegExp(`^execute:(${identifier})=>`));
  const newCallback = execute.match(new RegExp(`^execute:async (${identifier})=>`));
  const instance = oldCallback?.[1] || newCallback?.[1];
  const resultName = instance === 'r' ? '__nexiWebhookResult' : 'r';
  const oldExecute = `execute:${instance}=>${service}.webhook.get(${instance}.instanceName)`;
  const newExecute = `execute:async ${instance}=>{let ${resultName}=await ${service}.webhook.get(${instance}.instanceName);if(${resultName}){${resultName}.nexi_event_signed=${helper}.eventSigningReady();${resultName}.nexi_event_key_check=${helper}.eventKeyProof(${instance}.instanceName)}return ${resultName}}`;
  const state = execute === oldExecute ? 'old' : execute === newExecute ? 'corrected' : null;
  if (!state) throw new Error('webhook/find: expected one exact webhook.get transformation point');
  return { start: getStart, end: getEnd, route, corrected: header[0] + newExecute + suffix, state };
}

function patchWebhookFindRoute(source) {
  const target = webhookFindRoute(source);
  if (target.state !== 'old') throw new Error('webhook/find: first application expected old route');
  return source.slice(0, target.start) + target.corrected + source.slice(target.end);
}

if (code.includes(marker)) {
  if (webhookFindRoute(code).state !== 'corrected') throw new Error('webhook/find: marked bundle is not corrected');
  process.exit(0);
}
// Exercises the same route transformation on representative bundles without replaying unrelated P3 patches.
if (process.argv[2] === '--webhook-route-only') {
  fs.writeFileSync(bundlePath, patchWebhookFindRoute(code));
  process.exit(0);
}

function replaceOnce(before, after, label) {
  const first = code.indexOf(before);
  if (first < 0 || code.indexOf(before, first + 1) >= 0) throw new Error(`${label}: exact bundle pattern changed`);
  code = code.replace(before, after);
}

function replaceCount(before, after, expected, label) {
  const actual = code.split(before).length - 1;
  if (actual !== expected) throw new Error(`${label}: expected ${expected} exact patterns, found ${actual}`);
  code = code.split(before).join(after);
}

const chatwootCtor = provider === 'mysql' ? 'Qe(R' : 'ye(O';
const singletonCtor = provider === 'mysql' ? 'Qe(R,y,x,cn)' : 'ye(O,E,J,cn)';
replaceOnce(`this.chatwootService=new ${chatwootCtor},this.configService,this.prismaRepository,this.chatwootCache)`,
  `this.chatwootService=${helper}.isolateChatwoot(new ${chatwootCtor},this.configService,this.prismaRepository,this.chatwootCache))`,
  'per-instance chatwoot service');
replaceOnce(`ig=new ${singletonCtor}`, `ig=${helper}.isolateChatwoot(new ${singletonCtor})`, 'singleton chatwoot service');

replaceOnce('async setChatwoot(t){if(!this.configService.get("CHATWOOT").ENABLED)return;',
  'async setChatwoot(t){if(!this.configService.get("CHATWOOT").ENABLED)return;if(this.instanceName.startsWith("nexi-wa-")&&!/^[1-9][0-9]{0,18}$/.test(String(t.inboxId||"")))throw new Error("chatwoot_inbox_id_required");',
  'managed Chatwoot Inbox ID required');
replaceCount('nameInbox:t.nameInbox,signMsg', 'nameInbox:t.nameInbox,inboxId:t.inboxId,signMsg', 3,
  'Chatwoot Inbox ID storage and readback');
replaceOnce('if(await this.cache.has(A))return await this.cache.get(A);let e=await this.clientCw(t);if(!e)return this.logger.warn("client not found"),null;',
  `let e=await this.clientCw(t);if(!e)return this.logger.warn("client not found"),null;if(await this.cache.has(A)){let c=await this.cache.get(A);if(${helper}.inboxMatches(c,this.provider,t.instanceName))return c;await this.cache.delete(A)}`,
  'cached Inbox ID validation');
replaceOnce('let n=s.payload.find(a=>a.name===this.getClientCwConfig().nameInbox);return n?(this.cache.set(A,n),n):(this.logger.warn("inbox not found"),null)',
  `let n=${helper}.resolveConfiguredInbox(s.payload,this.provider,t.instanceName);return n?(this.cache.set(A,n),n):(this.logger.warn("inbox not found"),null)`,
  'stable Inbox ID resolution');

replaceOnce(mysql
  ? '.post(this.routerPath("webhook"),async(e,s)=>{let n=await this.dataValidate({request:e,schema:v,ClassRef:b,execute:(a,i)=>pn.receiveWebhook(a,i)});s.status(200).json(n)})'
  : '.post(this.routerPath("webhook"),async(e,s)=>{let n=await this.dataValidate({request:e,schema:T,ClassRef:P,execute:(a,i)=>Cn.receiveWebhook(a,i)});s.status(200).json(n)})',
  mysql
    ? `.post(this.routerPath("webhook"),async(e,s)=>{let v=await ${helper}.processChatwootWebhook(e,await ig.getProvider({instanceName:e.params.instanceName}),()=>this.dataValidate({request:e,schema:v,ClassRef:b,execute:(a,i)=>pn.receiveWebhook(a,i)}));return s.status(v.status).json(v.body)})`
    : `.post(this.routerPath("webhook"),async(e,s)=>{let v=await ${helper}.processChatwootWebhook(e,await ig.getProvider({instanceName:e.params.instanceName}),()=>this.dataValidate({request:e,schema:T,ClassRef:P,execute:(a,i)=>Cn.receiveWebhook(a,i)}));return s.status(v.status).json(v.body)})`,
  'authenticated chatwoot webhook route');

replaceOnce(mysql ? 'execute:a=>pn.findChatwoot(a)});s.status(200).json(n)' : 'execute:a=>Cn.findChatwoot(a)});s.status(200).json(n)',
  `execute:a=>${mysql ? 'pn' : 'Cn'}.findChatwoot(a)});n.nexi_transport_hardened=true;n.nexi_replay_store_ready=await ${helper}.replayStoreReady();s.status(200).json(n)`,
  'chatwoot transport proof');
code = patchWebhookFindRoute(code);

replaceOnce(`url:D,...f};this.logger.log(${mysql ? 'M' : 'U'})}try{if(u?.enabled&&S.test(u.url))`,
  `url:D,...${helper}.redactEventForLog(f)};this.logger.log(${mysql ? 'M' : 'U'})}try{if(u?.enabled&&S.test(u.url))`,
  'local event log redaction');
replaceOnce(`url:D,...f};this.logger.log(${mysql ? 'M' : 'U'})}try{if(S.test(D))`,
  `url:D,...${helper}.redactEventForLog(f)};this.logger.log(${mysql ? 'M' : 'U'})}try{if(S.test(D))`,
  'global event log redaction');

const qrTerminalLog = mysql
  ? /_o\.default\.generate\(A,\{small:!0\},r=>this\.logger\.log\(`[\s\S]*?\+r\)\)/g
  : /xo\.default\.generate\(A,\{small:!0\},r=>this\.logger\.log\(`[\s\S]*?\+r\)\)/g;
const qrMatches = [...code.matchAll(qrTerminalLog)];
if (qrMatches.length !== 1) throw new Error('QR terminal log: exact bundle pattern changed');
code = code.replace(qrTerminalLog, 'this.logger.info({message:"QR generated",instanceName:this.instance.name,qrcodeCount:this.instance.qrcode.count})');

replaceOnce('if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))return this.logger.warn("client not found"),null;',
  'if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))throw new Error("chatwoot_provider_unavailable");',
  'missing chatwoot client failure');
replaceOnce('if(!i&&A.conversation?.id)return this.onSendMessageError(t,A.conversation?.id,"Instance not found"),{message:"bot"};',
  'if(!i){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id,"Instance not found");throw new Error("chatwoot_instance_unavailable")}',
  'missing WhatsApp instance failure');
replaceOnce(mysql
  ? '!I&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id),await this.updateChatwootMessageId({...I}'
  : '!m&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id),await this.updateChatwootMessageId({...m}',
  mysql
    ? 'if(!I){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id);throw new Error("chatwoot_media_send_failed")}await this.updateChatwootMessageId({...I}'
    : 'if(!m){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id);throw new Error("chatwoot_media_send_failed")}await this.updateChatwootMessageId({...m}',
  'media send failure');
replaceOnce('await i?.client.sendMessage(c.remoteJid,{delete:c}),await this.prismaRepository.message.deleteMany',
  'if(!await i?.client.sendMessage(c.remoteJid,{delete:c}))throw new Error("chatwoot_delete_failed");await this.prismaRepository.message.deleteMany',
  'delete send failure');
replaceOnce('q("/message/sendText"),await i?.textMessage(g)}return{message:"bot"}',
  'q("/message/sendText");if(!await i?.textMessage(g))throw new Error("chatwoot_template_send_failed")}return{message:"bot"}',
  'template send failure');
replaceOnce('catch(e){return this.logger.error(e),{message:"bot"}}}async updateChatwootMessageId',
  'catch(e){this.logger.error("chatwoot_transport_failed");throw new Error("chatwoot_transport_failed")}}async updateChatwootMessageId',
  'outbound failure response');

replaceOnce(mysql
  ? 'let M={...E,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},U=Li.default.create({baseURL:D,headers:M,timeout:I.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(U,f,`${e}.sendData-Webhook`,D,a)'
  : 'let U={...h,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},k=_i.default.create({baseURL:D,headers:U,timeout:m.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(k,f,`${e}.sendData-Webhook`,D,a)',
  mysql
    ? `let M={...E,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},__nexiPrepared=${helper}.prepareEvent(M,f,A,this.monitor.waInstances[A].instanceId),U=Li.default.create({baseURL:D,headers:__nexiPrepared.headers,timeout:I.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(U,__nexiPrepared.body,\`\${e}.sendData-Webhook\`,D,a)`
    : `let U={...h,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},__nexiPrepared=${helper}.prepareEvent(U,f,A,this.monitor.waInstances[A].instanceId),k=_i.default.create({baseURL:D,headers:__nexiPrepared.headers,timeout:m.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(k,__nexiPrepared.body,\`\${e}.sendData-Webhook\`,D,a)`,
  'signed Evolution event');

// Axios invokes this request interceptor for every post in the upstream retry
// loop, before serialization. UUID/body stay fixed; authentication is renewed.
replaceOnce(mysql ? 'this.retryWebhookRequest(U,__nexiPrepared.body,' : 'this.retryWebhookRequest(k,__nexiPrepared.body,',
  `this.retryWebhookRequest(${helper}.signedEventClient(${mysql ? 'U' : 'k'},__nexiPrepared),__nexiPrepared.body,`, 'fresh retry auth');

code = `/* ${marker} */\n` + code;
fs.writeFileSync(bundlePath, code);
console.log('[evolution-24-lab] hardened Chatwoot and signed NEXI channel events');
