import fs from 'node:fs';

const bundlePath = process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js';
const provider = process.env.EVOLUTION_PROVIDER || 'postgresql';
if (!['postgresql', 'psql_bouncer', 'mysql'].includes(provider)) throw new Error('unsupported Prisma provider');
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

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chatwootServices(source) {
  const wrapper = `${escapePattern(helper)}\\.isolateChatwoot`;
  const instanceCall = `new (${identifier})\\((${identifier}),this\\.configService,this\\.prismaRepository,this\\.chatwootCache\\)`;
  const instancePattern = new RegExp(`(?<![\\w$.])this\\.chatwootService=(?:${instanceCall}|${wrapper}\\(${instanceCall}\\))(?=[,;}])`, 'g');
  const instances = [...source.matchAll(instancePattern)];
  // Controllers also assign an injected service; only constructor assignments
  // belong to this isolation patch, including malformed constructor candidates.
  const assignments = [...source.matchAll(new RegExp(`(?<![\\w$.])this\\.chatwootService=(?:${wrapper}\\()?new ${identifier}\\(`, 'g'))];
  if (instances.length !== 1 || assignments.length !== 1) {
    throw new Error(`per-instance chatwoot service: expected one semantic assignment, found ${instances.length} targets / ${assignments.length} assignments`);
  }
  const instance = instances[0];
  const ctor = instance[1] || instance[3];
  const monitor = instance[2] || instance[4];
  const instanceState = instance[1] ? 'old' : 'corrected';
  // The pinned source constructs the same ChatwootService once at module scope.
  // Bind it to the discovered class and monitor, retaining all four arguments.
  const singletonCall = `new ${escapePattern(ctor)}\\((${identifier}),(${identifier}),(${identifier}),(${identifier})\\)`;
  const singletonPattern = new RegExp(`(?<![\\w$.])(${identifier})=(?:${singletonCall}|${wrapper}\\(${singletonCall}\\))(?=[,;])`, 'g');
  const singletons = [...source.matchAll(singletonPattern)];
  const singletonAssignments = [...source.matchAll(new RegExp(`(?<![\\w$.])${identifier}=(?:${wrapper}\\()?new ${escapePattern(ctor)}\\(`, 'g'))];
  if (singletons.length !== 1 || singletonAssignments.length !== 1) {
    throw new Error(`singleton chatwoot service: expected one semantic assignment, found ${singletons.length} targets / ${singletonAssignments.length} assignments`);
  }
  const singleton = singletons[0];
  const singletonState = singleton[2] ? 'old' : 'corrected';
  if ((singleton[2] || singleton[6]) !== monitor) throw new Error('singleton chatwoot service: monitor binding changed');
  if (instanceState !== singletonState) throw new Error('chatwoot services: mixed isolation state');
  return { instance, singleton, singletonName: singleton[1], state: instanceState };
}

function patchChatwootServices(source) {
  const targets = chatwootServices(source);
  if (targets.state !== 'old') throw new Error('chatwoot services: first application expected unwrapped constructors');
  // Apply by validated offsets; captured identifiers and constructor arguments
  // are copied byte-for-byte. Only the existing isolation wrapper is inserted.
  for (const target of [targets.instance, targets.singleton].sort((a, b) => b.index - a.index)) {
    const equals = target[0].indexOf('=');
    const corrected = target[0].slice(0, equals + 1) + `${helper}.isolateChatwoot(` + target[0].slice(equals + 1) + ')';
    source = source.slice(0, target.index) + corrected + source.slice(target.index + target[0].length);
  }
  return { code: source, singletonName: targets.singletonName };
}

const capture = (name) => `(?<${name}>${identifier})`;
const reference = (name) => `\\k<${name}>`;

function exactlyOne(matches, label) {
  if (matches.length !== 1) throw new Error(`${label}: expected one structural target, found ${matches.length}`);
  return matches[0];
}

function routesContaining(source, token, semanticToken) {
  const routes = [];
  for (let start = source.indexOf(token); start >= 0; start = source.indexOf(token, start + token.length)) {
    const end = callEnd(source, start);
    const route = source.slice(start, end);
    if (semanticToken.some((value) => route.includes(value))) routes.push({ start, end, route });
  }
  return routes;
}

function chatwootFindRoute(source) {
  const label = 'chatwoot transport proof';
  const target = exactlyOne(routesContaining(source, '.get(this.routerPath("find"),', ['.findChatwoot(']), label);
  const shape = new RegExp(String.raw`^\.get\(this\.routerPath\("find"\),\.\.\.${capture('guards')},async\(${capture('request')},${capture('response')}\)=>\{let ${capture('result')}=await this\.dataValidate\(\{request:${reference('request')},schema:${capture('schema')},ClassRef:${capture('dto')},execute:${capture('instance')}=>${capture('service')}\.findChatwoot\(${reference('instance')}\)\}\);(?<proof>.*?)${reference('response')}\.status\(200\)\.json\(${reference('result')}\)\}\)$`);
  const match = target.route.match(shape);
  if (!match) throw new Error(`${label}: owning find route shape changed`);
  const g = match.groups;
  const proof = `${g.result}.nexi_transport_hardened=true;${g.result}.nexi_replay_store_ready=await ${helper}.replayStoreReady();`;
  const state = g.proof === '' ? 'old' : g.proof === proof ? 'corrected' : null;
  if (!state) throw new Error(`${label}: unexpected proof state`);
  const suffix = `${g.response}.status(200).json(${g.result})})`;
  return { ...target, ...g, state, corrected: target.route.slice(0, -suffix.length - g.proof.length) + proof + suffix };
}

function authenticatedChatwootRoute(source, singleton) {
  const label = 'authenticated chatwoot webhook route';
  const target = exactlyOne(routesContaining(source, '.post(this.routerPath("webhook"),',
    ['.receiveWebhook(', '.processChatwootWebhook(']), label);
  const header = target.route.match(new RegExp(String.raw`^\.post\(this\.routerPath\("webhook"\),async\(${capture('request')},${capture('response')}\)=>\{let ${capture('result')}=await `));
  if (!header) throw new Error(`${label}: handler header changed`);
  const g = header.groups;
  const validationPattern = String.raw`this\.dataValidate\(\{request:${escapePattern(g.request)},schema:${capture('schema')},ClassRef:${capture('dto')},execute:\(${capture('instance')},${capture('payload')}\)=>${capture('service')}\.receiveWebhook\(${reference('instance')},${reference('payload')}\)\}\)`;
  const old = target.route.slice(header[0].length).match(new RegExp(`^(${validationPattern});${escapePattern(g.response)}\\.status\\(200\\)\\.json\\(${escapePattern(g.result)}\\)\\}\\)$`));
  const corrected = target.route.slice(header[0].length).match(new RegExp(`^${escapePattern(helper)}\\.processChatwootWebhook\\(${escapePattern(g.request)},await ${escapePattern(singleton)}\\.getProvider\\(\\{instanceName:${escapePattern(g.request)}\\.params\\.instanceName\\}\\),\\(\\)=>(${validationPattern})\\);return ${escapePattern(g.response)}\\.status\\(${escapePattern(g.result)}\\.status\\)\\.json\\(${escapePattern(g.result)}\\.body\\)\\}\\)$`));
  const match = old || corrected;
  if (!match) throw new Error(`${label}: validation/dispatch/response shape changed`);
  const find = chatwootFindRoute(source);
  if (find.end !== target.start || find.service !== match.groups.service ||
      find.schema !== match.groups.schema || find.dto !== match.groups.dto || !source.startsWith('}};', target.end)) {
    throw new Error(`${label}: owning Chatwoot router context changed`);
  }
  const validation = match[1];
  return { ...target, ...g, ...match.groups, state: old ? 'old' : 'corrected',
    corrected: header[0] + `${helper}.processChatwootWebhook(${g.request},await ${singleton}.getProvider({instanceName:${g.request}.params.instanceName}),()=>${validation});return ${g.response}.status(${g.result}.status).json(${g.result}.body)})` };
}

function patchRoute(source, target, label) {
  if (target.state !== 'old') throw new Error(`${label}: first application expected old route`);
  return source.slice(0, target.start) + target.corrected + source.slice(target.end);
}

// These are narrow pinned shapes, not a JavaScript parser. Named captures and
// backreferences bind every reused value; no minified identifier is authority.
const anchorPatches = [
  {
    label: 'managed Chatwoot Inbox ID required',
    pattern: String.raw`async setChatwoot\(${capture('input')}\)\{if\(!this\.configService\.get\("CHATWOOT"\)\.ENABLED\)return;(?!if\(this\.instanceName\.startsWith\("nexi-wa-"\))`,
    transform: (m, g) => m + `if(this.instanceName.startsWith("nexi-wa-")&&!/^[1-9][0-9]{0,18}$/.test(String(${g.input}.inboxId||"")))throw new Error("chatwoot_inbox_id_required");`,
  },
  {
    label: 'Chatwoot Inbox ID storage and readback', expected: 3,
    pattern: String.raw`nameInbox:${capture('input')}\.nameInbox,signMsg`,
    transform: (_m, g) => `nameInbox:${g.input}.nameInbox,inboxId:${g.input}.inboxId,signMsg`,
  },
  {
    label: 'cached Inbox ID validation',
    pattern: String.raw`if\(await this\.cache\.has\(${capture('key')}\)\)return await this\.cache\.get\(${reference('key')}\);let ${capture('client')}=await this\.clientCw\(${capture('input')}\);if\(!${reference('client')}\)return this\.logger\.warn\("client not found"\),null;`,
    transform: (_m, g) => {
      const cached = [g.key, g.client, g.input].includes('c') ? '__nexiCachedInbox' : 'c';
      if ([g.key, g.client, g.input].includes(cached)) throw new Error('cached Inbox ID validation: local binding collision');
      return `let ${g.client}=await this.clientCw(${g.input});if(!${g.client})return this.logger.warn("client not found"),null;if(await this.cache.has(${g.key})){let ${cached}=await this.cache.get(${g.key});if(${helper}.inboxMatches(${cached},this.provider,${g.input}.instanceName))return ${cached};await this.cache.delete(${g.key})}`;
    },
  },
  {
    label: 'stable Inbox ID resolution',
    pattern: String.raw`let ${capture('inbox')}=${capture('list')}\.payload\.find\(${capture('item')}=>${reference('item')}\.name===this\.getClientCwConfig\(\)\.nameInbox\);return ${reference('inbox')}\?\(this\.cache\.set\(${capture('key')},${reference('inbox')}\),${reference('inbox')}\):\(this\.logger\.warn\("inbox not found"\),null\)`,
    transform: (m, g, source) => {
      // Bind the instance parameter from the owning getInbox method, not a letter.
      const method = source.lastIndexOf('async getInbox(', source.indexOf(m));
      const header = source.slice(method).match(new RegExp(String.raw`^async getInbox\(${capture('input')}\)\{`));
      if (method < 0 || !header || source.indexOf('}async ', method) < source.indexOf(m)) throw new Error('stable Inbox ID resolution: owning getInbox method changed');
      return m.replace(`${g.list}.payload.find(${g.item}=>${g.item}.name===this.getClientCwConfig().nameInbox)`, () => `${helper}.resolveConfiguredInbox(${g.list}.payload,this.provider,${header.groups.input}.instanceName)`);
    },
  },
  {
    label: 'local event log redaction',
    pattern: String.raw`let ${capture('log')}=\{local:\`\$\{${capture('origin')}\}\.sendData-Webhook\`,url:${capture('url')},\.\.\.${capture('payload')}\};this\.logger\.log\(${reference('log')}\)\}try\{if\(${capture('instance')}\?\.enabled&&${capture('regex')}\.test\(${reference('instance')}\.url\)\)`,
    transform: (m, g) => m.replace(`...${g.payload}`, () => `...${helper}.redactEventForLog(${g.payload})`),
  },
  {
    label: 'global event log redaction',
    pattern: String.raw`let ${capture('log')}=\{local:\`\$\{${capture('origin')}\}\.sendData-Webhook-Global\`,url:${capture('url')},\.\.\.${capture('payload')}\};this\.logger\.log\(${reference('log')}\)\}try\{if\(${capture('regex')}\.test\(${reference('url')}\)\)`,
    transform: (m, g) => m.replace(`...${g.payload}`, () => `...${helper}.redactEventForLog(${g.payload})`),
  },
  {
    label: 'QR terminal log',
    pattern: String.raw`(?<![\w$.])${capture('module')}\.default\.generate\(${capture('qr')},\{small:!0\},${capture('output')}=>this\.logger\.log\(\`\n\{ instance: \$\{this\.instance\.name\} pairingCode: \$\{this\.instance\.qrcode\.pairingCode\}, qrcodeCount: \$\{this\.instance\.qrcode\.count\} \}\n\`\+${reference('output')}\)\)`,
    transform: () => 'this.logger.info({message:"QR generated",instanceName:this.instance.name,qrcodeCount:this.instance.qrcode.count})',
  },
  {
    label: 'missing chatwoot client failure',
    pattern: String.raw`if\(await new Promise\(${capture('resolve')}=>setTimeout\(${reference('resolve')},500\)\),!await this\.clientCw\(${capture('input')}\)\)return this\.logger\.warn\("client not found"\),null;`,
    transform: (m) => m.replace('return this.logger.warn("client not found"),null;', 'throw new Error("chatwoot_provider_unavailable");'),
  },
  {
    label: 'missing WhatsApp instance failure',
    pattern: String.raw`if\(!${capture('wa')}&&${capture('body')}\.conversation\?\.id\)return this\.onSendMessageError\(${capture('input')},${reference('body')}\.conversation\?\.id,"Instance not found"\),\{message:"bot"\};`,
    transform: (_m, g) => `if(!${g.wa}){${g.body}.conversation?.id&&this.onSendMessageError(${g.input},${g.body}.conversation?.id,"Instance not found");throw new Error("chatwoot_instance_unavailable")}`,
  },
  {
    label: 'media send failure',
    pattern: String.raw`!${capture('sent')}&&${capture('body')}\.conversation\?\.id&&this\.onSendMessageError\(${capture('input')},${reference('body')}\.conversation\?\.id\),await this\.updateChatwootMessageId\(\{\.\.\.${reference('sent')}\}`,
    transform: (_m, g) => `if(!${g.sent}){${g.body}.conversation?.id&&this.onSendMessageError(${g.input},${g.body}.conversation?.id);throw new Error("chatwoot_media_send_failed")}await this.updateChatwootMessageId({...${g.sent}}`,
  },
  {
    label: 'delete send failure',
    pattern: String.raw`await ${capture('wa')}\?\.client\.sendMessage\(${capture('key')}\.remoteJid,\{delete:${reference('key')}\}\),await this\.prismaRepository\.message\.deleteMany`,
    transform: (_m, g) => `if(!await ${g.wa}?.client.sendMessage(${g.key}.remoteJid,{delete:${g.key}}))throw new Error("chatwoot_delete_failed");await this.prismaRepository.message.deleteMany`,
  },
  {
    label: 'template send failure',
    pattern: String.raw`(?<![\w$.])${capture('telemetry')}\("/message/sendText"\),await ${capture('wa')}\?\.textMessage\(${capture('data')}\)\}return\{message:"bot"\}`,
    transform: (_m, g) => `${g.telemetry}("/message/sendText");if(!await ${g.wa}?.textMessage(${g.data}))throw new Error("chatwoot_template_send_failed")}return{message:"bot"}`,
  },
  {
    label: 'outbound failure response',
    pattern: String.raw`catch\(${capture('error')}\)\{return this\.logger\.error\(${reference('error')}\),\{message:"bot"\}\}\}async updateChatwootMessageId`,
    transform: (_m, g) => `catch(${g.error}){this.logger.error("chatwoot_transport_failed");throw new Error("chatwoot_transport_failed")}}async updateChatwootMessageId`,
  },
  {
    label: 'signed Evolution event',
    pattern: String.raw`let ${capture('headers')}=\{\.\.\.${capture('custom')},"Content-Type":"application/json","X-Instance-ID":this\.monitor\.waInstances\[${capture('instance')}\]\.instanceId,"X-Instance-Name":${reference('instance')},"X-Event-Type":${capture('event')},"X-Timestamp":Date\.now\(\)\.toString\(\),"User-Agent":"EvolutionAPI-Webhook/2\.3\.7"\},${capture('client')}=${capture('axios')}\.default\.create\(\{baseURL:${capture('url')},headers:${reference('headers')},timeout:${capture('config')}\.REQUEST\?\.TIMEOUT_MS\?\?3e4\}\);await this\.retryWebhookRequest\(${reference('client')},${capture('payload')},\`\$\{${capture('origin')}\}\.sendData-Webhook\`,${reference('url')},${capture('server')}\)`,
    transform: (m, g, source) => {
      if (new RegExp(`(?<![\\w$])__nexiPrepared(?![\\w$])`).test(source)) throw new Error('signed Evolution event: prepared binding collision');
      return m.replace(`},${g.client}=`, () => `},__nexiPrepared=${helper}.prepareEvent(${g.headers},${g.payload},${g.instance},this.monitor.waInstances[${g.instance}].instanceId),${g.client}=`)
        .replace(`headers:${g.headers},`, 'headers:__nexiPrepared.headers,')
        .replace(`this.retryWebhookRequest(${g.client},${g.payload},`, () => `this.retryWebhookRequest(${g.client},__nexiPrepared.body,`);
    },
  },
  {
    label: 'fresh retry auth',
    // The existing interceptor renews authentication on each upstream retry;
    // the prepared UUID/body remain fixed. Only the client name is captured.
    pattern: String.raw`this\.retryWebhookRequest\(${capture('client')},__nexiPrepared\.body,`,
    transform: (_m, g) => `this.retryWebhookRequest(${helper}.signedEventClient(${g.client},__nexiPrepared),__nexiPrepared.body,`,
  },
];

function applyAnchor(source, label) {
  const patch = anchorPatches.find((entry) => entry.label === label);
  if (!patch) throw new Error('unknown structural patch label');
  const matches = [...source.matchAll(new RegExp(patch.pattern, 'g'))];
  if (matches.length !== (patch.expected || 1)) throw new Error(`${label}: expected ${patch.expected || 1} structural targets, found ${matches.length}`);
  const replacements = matches.map((m) => ({ start: m.index, end: m.index + m[0].length, after: patch.transform(m[0], m.groups, source) }));
  for (const target of replacements.reverse()) source = source.slice(0, target.start) + target.after + source.slice(target.end);
  return source;
}

if (code.includes(marker)) {
  const services = chatwootServices(code);
  if (services.state !== 'corrected') throw new Error('chatwoot services: marked bundle is not corrected');
  if (webhookFindRoute(code).state !== 'corrected') throw new Error('webhook/find: marked bundle is not corrected');
  if (authenticatedChatwootRoute(code, services.singletonName).state !== 'corrected') throw new Error('authenticated chatwoot webhook route: marked bundle is not corrected');
  if (chatwootFindRoute(code).state !== 'corrected') throw new Error('chatwoot transport proof: marked bundle is not corrected');
  process.exit(0);
}
// Exercises the same route transformation on representative bundles without replaying unrelated P3 patches.
if (process.argv[2] === '--webhook-route-only') {
  fs.writeFileSync(bundlePath, patchWebhookFindRoute(code));
  process.exit(0);
}
// Focal fixtures exercise both service anchors through the production matcher.
if (process.argv[2] === '--chatwoot-services-only') {
  fs.writeFileSync(bundlePath, patchChatwootServices(code).code);
  process.exit(0);
}
if (process.argv[2] === '--authenticated-webhook-only') {
  code = patchRoute(code, authenticatedChatwootRoute(code, chatwootServices(code).singletonName), 'authenticated chatwoot webhook route');
  fs.writeFileSync(bundlePath, code);
  process.exit(0);
}
if (process.argv[2]?.startsWith('--anchor-only=')) {
  fs.writeFileSync(bundlePath, applyAnchor(code, process.argv[2].slice('--anchor-only='.length)));
  process.exit(0);
}

const isolatedServices = patchChatwootServices(code);
code = isolatedServices.code;
code = patchRoute(code, authenticatedChatwootRoute(code, isolatedServices.singletonName), 'authenticated chatwoot webhook route');
code = patchRoute(code, chatwootFindRoute(code), 'chatwoot transport proof');
code = patchWebhookFindRoute(code);
for (const patch of anchorPatches) code = applyAnchor(code, patch.label);

code = `/* ${marker} */\n` + code;
fs.writeFileSync(bundlePath, code);
console.log('[evolution-24-lab] hardened Chatwoot and signed NEXI channel events');
