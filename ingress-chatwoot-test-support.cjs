'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

// Execute production TS methods and the installed SDK serializer/request path.
// Only the Axios I/O boundary and APP persistence are synthetic; no live HTTP.
function install({ root, ingress, service, repo, app, options, posts }) {
  const sourceRequire = createRequire(path.resolve(root, 'package.json'));
  const ts = sourceRequire('typescript');
  const sdkRoot = path.join(root, 'node_modules/@figuro/chatwoot-sdk');
  const sdkRequire = createRequire(path.resolve(sdkRoot, 'dist/core/request.js'));
  const load = (file, dependencies) => {
    const module = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports,Buffer) {\n${fs.readFileSync(path.join(sdkRoot, file), 'utf8')}\n})`)(
      name => name in dependencies ? dependencies[name] : sdkRequire(name), module, module.exports, Buffer);
    return module.exports;
  };
  function fields(form) {
    if (form._streams.some(item => typeof item !== 'string' && typeof item !== 'function' && !Buffer.isBuffer(item))) {
      const result = {};
      form._streams.forEach((item, index) => {
        const match = typeof item === 'string' && item.match(/name="([^"]+)"\r\n\r\n$/);
        if (match && typeof form._streams[index + 1] === 'string') result[match[1]] = form._streams[index + 1];
      });
      return result;
    }
    const text = form.getBuffer().toString('utf8'), result = {};
    for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) result[match[1]] = match[2];
    return result;
  }
  const axios = { ...sdkRequire('axios'), async request(config) {
    assert.equal(config.method.toUpperCase(), 'POST');
    assert.equal(config.url, 'https://offline.invalid/api/v1/accounts/1/conversations/6/messages');
    assert.equal(config.headers.api_access_token, 'synthetic-chatwoot-token');
    const data = fields(config.data);
    posts.push({ method: config.method, url: config.url, data });
    if (options.post) return options.post({ app, data, posts, config });
    if (!app.message_id) { app.message_id = 77; app.creates++; }
    return { status: 200, statusText: 'OK', headers: {}, data: { id: app.message_id, inbox_id: 2, conversation_id: 6 } };
  } };
  const request = load('dist/core/request.js', { axios, '/evolution/nexi-ingress.cjs': ingress });
  const { Messages } = load('dist/services/Messages.js', { '../core/request': request });
  const ChatwootClient = class { constructor({ config }) { this.messages = new Messages({ config }); } };
  const file = path.join(root, 'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts');
  const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['eventWhatsapp', 'createMessage', 'getProvider', 'clientCw', 'getClientCwConfig',
    'createConversation', 'getReplyToIds', 'getConversationMessage', 'getTypeMessage', 'getMessageContent',
    'isMediaMessage', 'isInteractiveButtonMessage', 'getAdsMessage', 'getReactionMessage', 'provider', 'sendData']);
  const definition = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'ChatwootService');
  const members = definition.members.filter(node => node.name && names.has(node.name.getText(parsed)));
  const module = { exports: {} };
  const code = ts.transpileModule(`class Boundary { ${members.map(node => node.getText(parsed)).join('\n')} }; module.exports = Boundary;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInThisContext(`(function(require,module,ChatwootClient,Events,axios,FormData,Readable,path,mimeTypes) {\n${code}\n})`)(
    name => name === '/evolution/nexi-ingress.cjs' ? ingress : name.startsWith('/evolution/') ? require('./' + path.basename(name)) : sourceRequire(name),
    module, ChatwootClient, { MESSAGES_UPSERT: 'messages.upsert' }, axios, sdkRequire('form-data'), require('node:stream').Readable, path, sourceRequire('mime-types'));
  const client = new module.exports(), cache = new Map();
  service.findChatwoot = async () => options.providerMissing ? null : { accountId: 1, inboxId: options.foreignInbox ? 99 : 2,
    url: 'https://offline.invalid', token: 'synthetic-chatwoot-token', ignoreJids: options.ignoreJids || [] };
  Object.assign(client, { waMonitor: { waInstances: { [service.instance.name]: service } },
    prismaRepository: repo, logger: service.logger, cache: { async has(key) { return cache.has(key); },
      async get(key) { return cache.get(key); }, set(key, value) { cache.set(key, value); } } });
  client.isImportHistoryAvailable = () => false;
  service.getBase64FromMediaMessage = async () => ({ base64: Buffer.from('SYNTHETIC_MEDIA_BYTES').toString('base64'), mimetype: 'image/jpeg' });
  service.chatwootService = client;
}
module.exports = { install };
