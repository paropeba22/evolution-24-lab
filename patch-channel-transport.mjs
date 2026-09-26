import fs from 'node:fs';

const bundlePath = process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js';
const marker = 'nexi-p3-chatwoot-transport';
let code = fs.readFileSync(bundlePath, 'utf8');
if (code.includes(marker)) process.exit(0);

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

const helper = 'require("/evolution/nexi-transport.cjs")';
replaceOnce('this.chatwootService=new ye(O,this.configService,this.prismaRepository,this.chatwootCache)',
  `this.chatwootService=${helper}.isolateChatwoot(new ye(O,this.configService,this.prismaRepository,this.chatwootCache))`,
  'per-instance chatwoot service');
replaceOnce('ig=new ye(O,E,J,cn)', `ig=${helper}.isolateChatwoot(new ye(O,E,J,cn))`, 'singleton chatwoot service');

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

replaceOnce('.post(this.routerPath("webhook"),async(e,s)=>{let n=await this.dataValidate({request:e,schema:T,ClassRef:P,execute:(a,i)=>Cn.receiveWebhook(a,i)});s.status(200).json(n)})',
  `.post(this.routerPath("webhook"),async(e,s)=>{let v=await ${helper}.verifyChatwootWebhook(e,await ig.getProvider({instanceName:e.params.instanceName}));if(v.replay)return s.status(200).json({message:"delivery_already_recorded"});if(!v.ok)return s.status(v.status).json({error:v.status===503?"chatwoot_replay_store_unavailable":"chatwoot_transport_auth_failed"});try{let n=await this.dataValidate({request:e,schema:T,ClassRef:P,execute:(a,i)=>Cn.receiveWebhook(a,i)});await ${helper}.finishChatwootDelivery(v.claim,"completed");return s.status(200).json(n)}catch(n){await ${helper}.finishChatwootDelivery(v.claim,"ambiguous").catch(()=>{});throw n}})`,
  'authenticated chatwoot webhook route');

replaceOnce('execute:a=>Cn.findChatwoot(a)});s.status(200).json(n)',
  `execute:a=>Cn.findChatwoot(a)});n.nexi_transport_hardened=true;n.nexi_replay_store_ready=await ${helper}.replayStoreReady();s.status(200).json(n)`,
  'chatwoot transport proof');
replaceOnce('execute:i=>z.webhook.get(i.instanceName)});n.status(200).json(a)',
  `execute:i=>z.webhook.get(i.instanceName)});if(a){a.nexi_event_signed=${helper}.eventSigningReady();a.nexi_event_key_check=${helper}.eventKeyProof(e.params.instanceName)}n.status(200).json(a)`,
  'event signing proof');

replaceOnce('url:D,...f};this.logger.log(U)}try{if(u?.enabled&&S.test(u.url))',
  `url:D,...${helper}.redactEventForLog(f)};this.logger.log(U)}try{if(u?.enabled&&S.test(u.url))`,
  'local event log redaction');
replaceOnce('url:D,...f};this.logger.log(U)}try{if(S.test(D))',
  `url:D,...${helper}.redactEventForLog(f)};this.logger.log(U)}try{if(S.test(D))`,
  'global event log redaction');

const qrTerminalLog = /xo\.default\.generate\(A,\{small:!0\},r=>this\.logger\.log\(`[\s\S]*?\+r\)\)/g;
const qrMatches = [...code.matchAll(qrTerminalLog)];
if (qrMatches.length !== 1) throw new Error('QR terminal log: exact bundle pattern changed');
code = code.replace(qrTerminalLog, 'this.logger.info({message:"QR generated",instanceName:this.instance.name,qrcodeCount:this.instance.qrcode.count})');

replaceOnce('if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))return this.logger.warn("client not found"),null;',
  'if(await new Promise(g=>setTimeout(g,500)),!await this.clientCw(t))throw new Error("chatwoot_provider_unavailable");',
  'missing chatwoot client failure');
replaceOnce('if(!i&&A.conversation?.id)return this.onSendMessageError(t,A.conversation?.id,"Instance not found"),{message:"bot"};',
  'if(!i){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id,"Instance not found");throw new Error("chatwoot_instance_unavailable")}',
  'missing WhatsApp instance failure');
replaceOnce('!m&&A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id),await this.updateChatwootMessageId({...m}',
  'if(!m){A.conversation?.id&&this.onSendMessageError(t,A.conversation?.id);throw new Error("chatwoot_media_send_failed")}await this.updateChatwootMessageId({...m}',
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

replaceOnce('let U={...h,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},k=_i.default.create({baseURL:D,headers:U,timeout:m.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(k,f,`${e}.sendData-Webhook`,D,a)',
  `let U={...h,"Content-Type":"application/json","X-Instance-ID":this.monitor.waInstances[A].instanceId,"X-Instance-Name":A,"X-Event-Type":s,"X-Timestamp":Date.now().toString(),"User-Agent":"EvolutionAPI-Webhook/2.3.7"},__nexiPrepared=${helper}.prepareEvent(U,f,A,this.monitor.waInstances[A].instanceId),k=_i.default.create({baseURL:D,headers:__nexiPrepared.headers,timeout:m.REQUEST?.TIMEOUT_MS??3e4});await this.retryWebhookRequest(k,__nexiPrepared.body,\`\${e}.sendData-Webhook\`,D,a)`,
  'signed Evolution event');

code = `/* ${marker} */\n` + code;
fs.writeFileSync(bundlePath, code);
console.log('[evolution-24-lab] hardened Chatwoot and signed NEXI channel events');
