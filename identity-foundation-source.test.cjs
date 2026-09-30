'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const identity = require('./nexi-identity.cjs');
const transport = require('./nexi-transport.cjs');
const financial = require('./nexi-financial-transport.cjs');
const { withTestRecipient, signedDto, fakeLedger, master } = require('./recipient-contract-test-support.cjs');
const revision = 'e273b904d53f5726970fd6a244ed9caa61dfeb9a';
const upstream = process.env.EVOLUTION_UPSTREAM_SOURCE || path.join(__dirname, '../evolution-upstream');
const baileysPath = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
const mapperPath = 'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts';
const webhookPath = 'src/api/integrations/event/webhook/webhook.controller.ts';
const jidA = '5511999999999@s.whatsapp.net', jidB = '5511888888888@s.whatsapp.net', lid = '100000000000001@lid';
const logger = { verbose() {}, error() {}, warn() {}, info() {}, log() {}, debug() {}, trace() {} };
let scratch, raw, rawSend, originalRecv, originalSend, bufferSource, baileys, mapper, retry, tsup, ts, createJid;
function section(s, a, b) { const start = s.indexOf(a), end = s.indexOf(b, start); assert.ok(start >= 0 && end > start); return s.slice(start, end); }
function helper(name) {
  if (name === '/evolution/nexi-financial-transport.cjs') return financial;
  if (name === '/evolution/nexi-identity.cjs') return identity;
  if (name === '/evolution/nexi-transport.cjs') return transport;
  throw new Error('unexpected dependency');
}
function compile(body, bindings = {}) {
  const result = ts.transpileModule(`class Subject { ${body} }; return Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return new Function('require', ...Object.keys(bindings), result.outputText)(helper, ...Object.values(bindings));
}
before(() => {
  ts = require(require.resolve('typescript', { paths: [__dirname, upstream] }));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexi-identity-source-'));
  const pristine = (file, group = '.financial-upstream', name = file) => fs.existsSync(path.join(__dirname, group, name))
    ? fs.readFileSync(path.join(__dirname, group, name), 'utf8')
    : execFileSync('git', ['show', `${revision}:${file}`], { cwd: upstream, encoding: 'utf8' });
  for (const file of ['src/validate/message.schema.ts', mapperPath, baileysPath, webhookPath]) {
    const target = path.join(scratch, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file === webhookPath ? pristine(file, '.identity-upstream', 'webhook.controller.ts') : pristine(file));
  }
  const rawSource = fs.existsSync(path.join(__dirname, '.identity-upstream/messages-recv.js'))
    ? fs.readFileSync(path.join(__dirname, '.identity-upstream/messages-recv.js'))
    : fs.readFileSync(path.join(upstream, 'node_modules/baileys/lib/Socket/messages-recv.js'));
  const target = path.join(scratch, 'node_modules/baileys/lib/Socket/messages-recv.js');
  originalRecv = rawSource.toString('utf8');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, rawSource);
  bufferSource = fs.existsSync(path.join(__dirname, '.identity-upstream/event-buffer.js'))
    ? fs.readFileSync(path.join(__dirname, '.identity-upstream/event-buffer.js'), 'utf8')
    : fs.readFileSync(path.join(upstream, 'node_modules/baileys/lib/Utils/event-buffer.js'), 'utf8');
  const bufferTarget = path.join(scratch, 'node_modules/baileys/lib/Utils/event-buffer.js');
  fs.mkdirSync(path.dirname(bufferTarget), { recursive: true }); fs.writeFileSync(bufferTarget, bufferSource);
  const sendSource = fs.existsSync(path.join(__dirname, '.identity-upstream/messages-send.js'))
    ? fs.readFileSync(path.join(__dirname, '.identity-upstream/messages-send.js'))
    : fs.readFileSync(path.join(upstream, 'node_modules/baileys/lib/Socket/messages-send.js'));
  const sendTarget = path.join(scratch, 'node_modules/baileys/lib/Socket/messages-send.js');
  originalSend = sendSource.toString('utf8');
  fs.writeFileSync(sendTarget, sendSource);
  fs.writeFileSync(path.join(scratch, 'tsup.config.ts'), pristine('tsup.config.ts', '.identity-upstream', 'tsup.config.ts'));
  for (const patch of ['patch-financial-delivery-source.mjs', 'patch-trusted-baileys.mjs', 'patch-managed-retry.mjs']) {
    execFileSync(process.execPath, [path.join(__dirname, patch), scratch], { stdio: 'pipe' });
  }
  raw = fs.readFileSync(target, 'utf8');
  rawSend = fs.readFileSync(sendTarget, 'utf8');
  tsup = fs.readFileSync(path.join(scratch, 'tsup.config.ts'), 'utf8');
  baileys = fs.readFileSync(path.join(scratch, baileysPath), 'utf8');
  mapper = fs.readFileSync(path.join(scratch, mapperPath), 'utf8');
  retry = fs.readFileSync(path.join(scratch, webhookPath), 'utf8');
  const createJidSource = fs.existsSync(path.join(__dirname, 'src/utils/createJid.ts'))
    ? fs.readFileSync(path.join(__dirname, 'src/utils/createJid.ts'), 'utf8')
    : execFileSync('git', ['show', `${revision}:src/utils/createJid.ts`], { cwd: upstream, encoding: 'utf8' });
  const jidCode = ts.transpileModule(createJidSource.replace('export function createJid', 'function createJid') + '\nreturn createJid;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  createJid = new Function(jidCode)();
});
after(() => {
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('nexi-identity-source-'));
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('actual patched tsup config and lightweight esbuild preserve one shared runtime identity/recipient module', () => {
  const module = { exports: {} };
  const code = ts.transpileModule(tsup, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'process', 'module', 'exports', code)(name => name === 'tsup' ? { defineConfig: v => v } : require(name),
    { env: {}, cwd: () => scratch }, module, module.exports);
  const config = module.exports.default;
  const options = {}; config.esbuildOptions(options);
  const esbuild = require(require.resolve('esbuild', { paths: [__dirname, upstream] }));
  const built = esbuild.buildSync({ stdin: { contents: "module.exports = [require('/evolution/nexi-identity.cjs'), require('/evolution/nexi-financial-transport.cjs'), require('/evolution/nexi-transport.cjs'), require('baileys')];", resolveDir: scratch },
    bundle: true, external: config.external, platform: options.platform, format: 'cjs', write: false });
  const result = { exports: {} }, baileysRuntime = {};
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'baileys' ? baileysRuntime : helper(name), result, result.exports);
  assert.equal(result.exports[0], identity); assert.equal(result.exports[1], financial);
  assert.equal(result.exports[2], transport); assert.equal(result.exports[3], baileysRuntime);
});

async function decryptedFixture({ attrs = {}, key = {}, message = { conversation: 'Synthetic' }, decryptFails = false,
  stub, parameters, history = false, from = jidA, consume = true, retryManager = null, managed = true, recvSource = raw } = {}) {
  const node = { attrs: { from, id: key.id || 'synthetic-wa-id', ...attrs } };
  const msg = { key: { fromMe: false, remoteJid: from, id: node.attrs.id, ...key }, message,
    messageStubType: stub, messageStubParameters: parameters };
  const credentials = { me: { id: '5500000000000@s.whatsapp.net', lid: '200000000000001@lid' },
    registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } };
  let event, captured = null;
  const errors = [];
  const bindings = {
    nexiIdentity: identity, nexiFinancial: financial, config: { nexiFinancialManaged: managed },
    logger: { ...logger, error: (value, text) => { if (text === 'error in handling message') errors.push(value.error); } },
    authState: { creds: credentials }, signalRepository: { lidMapping: {
      getPNForLID: async () => jidA, storeLIDPNMappings: async () => {} }, migrateSession: async () => {} },
    getBinaryNodeChild: () => ({ attrs: { type: 'msg' } }), jidDecode: value => ({ server: value.split('@')[1] }),
    decryptMessageNode: () => ({ fullMessage: msg, category: attrs.category, author: from,
      decrypt: async () => { if (decryptFails) throw new Error('synthetic decrypt failure'); } }),
    messageMutex: { mutex: fn => fn() }, messageRetryManager: retryManager,
    proto: { WebMessageInfo: { StubType: { CIPHERTEXT: 1 } } }, MISSING_KEYS_ERROR_TEXT: 'missing',
    NO_MESSAGE_FOUND_ERROR_TEXT: 'absent', NACK_REASONS: { ParsingError: 1, UnhandledError: 2 },
    sendMessageAck: async () => {}, sendReceipt: async () => {}, sendActiveReceipts: true,
    isNewsletter: () => false, isJidNewsletter: () => false, isLidUser: value => typeof value === 'string' && value.endsWith('@lid'),
    getHistoryMsg: () => history,
    jidNormalizedUser: value => value, cleanMessage: () => {}, binaryNodeToString: () => 'synthetic',
    upsertMessage: async (m, type) => { event = type; if (consume) captured = identity.take(m, type); },
  };
  const fn = new Function(...Object.keys(bindings), section(recvSource, '    const handleMessage = async (node) => {', '    const handleCall =') + 'return handleMessage;')(...Object.values(bindings));
  await fn(node);
  return { msg, event, captured, errors };
}

test('actual patched Baileys decrypt path marks only genuine live peer input, and artificial copies lack provenance', async () => {
  const { msg, captured } = await decryptedFixture();
  assert.equal(captured.pn_jid, jidA); assert.equal(captured.origin, 'baileys.cb_message.decrypt');
  assert.equal(identity.take({ ...msg }, 'notify'), null);
  assert.equal(identity.take(msg, 'notify'), null, 'capability consumed once');
  for (const change of [
    { key: { fromMe: true } }, { attrs: { offline: '1' } }, { attrs: { category: 'peer' } },
    { attrs: { participant: jidB } }, { from: 'group@g.us' }, { from: 'status@broadcast' },
    { from: 'list@broadcast' }, { history: true }, { stub: 1, parameters: ['missing'] },
    { stub: 2 }, { parameters: ['placeholder'] }, { message: null }, { decryptFails: true },
    { message: { protocolMessage: {} } }, { attrs: { recipient: jidB } },
  ]) assert.equal((await decryptedFixture(change)).captured, null);
});

test('raw LID only accepts PN supplied by the stanza; cache, editable fields and ambiguous LID provide no authority', async () => {
  const proven = await decryptedFixture({ from: lid, attrs: { sender_pn: jidA }, key: { remoteJidAlt: jidA } });
  assert.equal(proven.captured.pn_jid, jidA); assert.equal(proven.captured.lid_jid, lid);
  const devicePn = await decryptedFixture({ from: '5511999999999:12@s.whatsapp.net' });
  assert.equal(devicePn.captured.pn_jid, jidA);
  const deviceLid = await decryptedFixture({ from: '100000000000001:12@lid', attrs: { sender_pn: jidA }, key: { remoteJidAlt: jidA } });
  assert.equal(deviceLid.captured.pn_jid, jidA); assert.equal(deviceLid.captured.lid_jid, lid);
  for (const change of [{ from: lid }, { from: lid, key: { remoteJidAlt: jidB } },
    { from: lid, attrs: { sender_pn: jidA }, key: { remoteJidAlt: jidB } },
    { from: lid, attrs: { peer_recipient_pn: jidA }, key: { remoteJidAlt: jidA } }]) {
    assert.equal((await decryptedFixture(change)).captured, null);
  }
});
test('actual pinned event buffer preserves the capability and artificial replacement cannot inherit it', async () => {
  const makeEventBuffer = new Function('EventEmitter',
    bufferSource.replace(/^import .*;\r?\n/gm, '').replace('export const makeEventBuffer', 'const makeEventBuffer') + '\nreturn makeEventBuffer;')
    (require('node:events').EventEmitter);
  for (const artificialReplacement of [false, true]) {
    const { msg } = await decryptedFixture({ consume: false });
    const ev = makeEventBuffer(logger);
    let emitted;
    ev.on('messages.upsert', payload => emitted = payload);
    ev.buffer();
    ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
    if (artificialReplacement) ev.emit('messages.upsert', { messages: [{ ...msg }], type: 'notify' });
    ev.flush();
    assert.equal(identity.take(emitted.messages[0], emitted.type)?.pn_jid || null, artificialReplacement ? null : jidA);
    ev.destroy();
  }
});

function sendSubject(cached = jidA, actualLookup = false) {
  const effects = { writes: 0, reads: 0 };
  class OnWhatsAppDto { constructor(jid, exists, number, name, lid) { Object.assign(this, { jid, exists, number, name, lid }); } }
  const Subject = compile(section(baileys, '  private async sendMessage(', '  // Instance Controller') +
    section(baileys, '  public async whatsappNumber(', '  public async markMessageAsRead('), {
    BadRequestException: Error, isJidGroup: () => false, Long: { isLong: () => false }, Events: { SEND_MESSAGE: 'send.message' },
    generateWAMessageFromContent: (_recipient, message) => ({ message }), isArray: Array.isArray, isPnUser: jid => jid.endsWith('@s.whatsapp.net'),
    createJid, isJidNewsletter: () => false, OnWhatsAppDto,
    getOnWhatsappCache: async () => cached ? [{ remoteJid: cached, jidOptions: [jidA, cached] }] : [],
    saveOnWhatsappCache: async () => effects.writes++,
  });
  const subject = new Subject();
  subject.instance = { name: 'nexi-wa-synthetic', wuid: '5500000000000@s.whatsapp.net' }; subject.instanceId = 'synthetic-instance'; subject.logger = logger;
  if (!actualLookup) subject.whatsappNumber = async () => [{ exists: true, jid: cached }];
  subject.prepareMessage = v => v;
  subject.configService = { get: name => name === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: false } } : { ENABLED: false } };
  subject.localWebhook = { enabled: false }; subject.sendDataWebhook = () => {};
  const recipients = [];
  subject.client = { relayMessage: async (jid) => { recipients.push(jid); return 'synthetic-outgoing-id'; },
    onWhatsApp: async () => { effects.reads++; return [{ exists: true, jid: jidA }]; } };
  subject.prismaRepository = { contact: { findMany: async () => [] } };
  return { subject, recipients, effects };
}
const cta = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_copy', buttonParamsJson: '{}' }] } } };
test('actual transformed validation and relay deny PN A/cache B and ambiguous LID with ZERO relay', async () => {
  for (const divergent of [jidB, lid]) {
    const { subject, recipients } = sendSubject(divergent);
    await assert.rejects(withTestRecipient(subject, () => subject.sendMessageWithTyping('5511999999999', cta, {})));
    assert.deepEqual(recipients, []);
  }
  const { subject, recipients } = sendSubject();
  await assert.rejects(subject.sendMessageWithTyping('5511999999999', cta, {}));
  assert.deepEqual(recipients, []);
});
test('actual whatsappNumber cache alias A to B reaches exact recipient veto; fresh lookup never writes financial aliases/P2002', async () => {
  const divergent = sendSubject(jidB, true);
  await assert.rejects(withTestRecipient(divergent.subject, () => divergent.subject.sendMessageWithTyping('5511999999999', cta, {})));
  assert.deepEqual(divergent.recipients, []);
  assert.equal(divergent.effects.reads, 0);
  assert.equal(divergent.effects.writes, 0);
  const fresh = sendSubject(null, true);
  await withTestRecipient(fresh.subject, () => fresh.subject.sendMessageWithTyping('5511999999999', cta, {}));
  assert.deepEqual(fresh.recipients, [jidA]);
  assert.equal(fresh.effects.reads, 1);
  assert.equal(fresh.effects.writes, 0);
});
test('actual pre-relay guard repeats exact PN check; matching JID relays once, duplicate cannot relay', async () => {
  const { subject, recipients } = sendSubject();
  const store = fakeLedger();
  await withTestRecipient(subject, () => subject.sendMessageWithTyping('5511999999999', cta, {}), {}, store);
  assert.deepEqual(recipients, [jidA]); assert.equal(store.state, 'completed');
  await assert.rejects(withTestRecipient(subject, () => subject.sendMessageWithTyping('5511999999999', cta, {}), {}, store));
  assert.deepEqual(recipients, [jidA]);
  const other = sendSubject();
  await assert.rejects(withTestRecipient(other.subject, () => other.subject.sendMessage(jidB, cta)));
  assert.deepEqual(other.recipients, []);
});
test('recipient signatures bind the actual financial DTO and cannot authorize a browser-selected PN', async () => {
  const { subject, recipients } = sendSubject();
  const old = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  try {
    for (const mutate of [d => d.number = '5511888888888', d => d.buttons[0].copyCode = 'CHANGED',
      d => d.nexiRecipient.signature = '0'.repeat(64), d => d.mentioned = ['synthetic'], d => d.buttons[0].type = 'pix']) {
      const dto = signedDto(subject); mutate(dto);
      await assert.rejects(financial.withRecipient(subject, dto, () => subject.sendMessageWithTyping(dto.number, cta, {}), fakeLedger()));
    }
    assert.deepEqual(recipients, []);
    const unsignedPix = { number: '5511999999999', buttons: [{ type: 'pix', displayText: 'Synthetic' }] };
    await assert.rejects(financial.withRecipient(subject, unsignedPix, () => subject.sendMessageWithTyping(unsignedPix.number, cta, {}), fakeLedger()));
    assert.deepEqual(recipients, []);
  } finally { if (old === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = old; }
});
test('recipient capability cannot cross instance identity or survive its deadline before relay', async () => {
  for (const mutate of [subject => subject.instanceId = 'replaced-instance', subject => subject.instance.name = 'nexi-wa-other',
    subject => subject.client.authState.creds.registrationId++]) {
    const { subject, recipients } = sendSubject();
    await assert.rejects(withTestRecipient(subject, async () => {
      mutate(subject);
      await subject.sendMessage(jidA, cta);
    }));
    assert.deepEqual(recipients, []);
  }
  const { subject, recipients } = sendSubject();
  const oldNow = Date.now;
  await assert.rejects(withTestRecipient(subject, async () => {
    Date.now = () => oldNow() + 300001;
    try { await subject.sendMessage(jidA, cta); } finally { Date.now = oldNow; }
  }));
  assert.deepEqual(recipients, []);
});
test('actual patched Baileys wire boundary rejects changed stanza/device peers and disables native financial retry cache', async () => {
  const wireBody = section(rawSend, '            nexiFinancial.assertWireRecipient(', '            // Fire-and-forget:');
  const sendWire = new Function('nexiFinancial', 'logger', 'sendNode', 'destinationJid', 'stanza', 'authState',
    `return (async () => { const msgId = 'synthetic', message = {}; const config = {}; const participants = []; ${wireBody} })();`);
  const cacheBody = section(rawSend, '            // Add message to retry cache if enabled', '        }, meId);');
  const cacheMessage = new Function('nexiFinancial', 'messageRetryManager',
    `const participant = null, destinationJid = '${jidA}', msgId = 'synthetic', message = {}; ${cacheBody}`);
  let effects = 0, retries = 0;
  const self = { id: '5500000000000:1@s.whatsapp.net', lid: '200000000000001:1@lid' };
  const { subject } = sendSubject();
  subject.client.authState = { creds: { me: self, registrationId: 1, signedIdentityKey: { public: Buffer.alloc(32, 7) } } };
  const node = (to, device = `${jidA.split('@')[0]}:1@s.whatsapp.net`) => ({ attrs: { id: 'synthetic', to },
    content: [{ tag: 'participants', content: [{ tag: 'to', attrs: { jid: device } }, { tag: 'to', attrs: { jid: self.lid } }] }] });
  for (const divergent of [node(jidB), node(jidA, jidB), node(jidA, lid)]) {
    await assert.rejects(withTestRecipient(subject, () => sendWire(financial, logger, async () => effects++, jidA, divergent, subject.client.authState)));
  }
  assert.equal(effects, 0);
  await withTestRecipient(subject, async () => {
    await sendWire(financial, logger, async () => effects++, jidA, node(jidA), subject.client.authState);
    cacheMessage(financial, { addRecentMessage: () => retries++ });
  });
  assert.equal(effects, 1); assert.equal(retries, 0);
  cacheMessage(financial, { addRecentMessage: () => retries++ });
  assert.equal(retries, 1, 'unmanaged native retry cache is preserved');
  // Execute the transformed socket getMessage callback, including the DB-OFF
  // fallback; no managed financial content or placeholder can authorize retry.
  const callbackLine = baileys.split('\n').find(line => line.includes('getMessage: async (key) =>'));
  const callbackCode = ts.transpileModule(`return { ${callbackLine} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const makeCallback = new Function('require', callbackCode);
  for (const message of [cta, { conversation: 'NEXI financial delivery' }, { conversation: '' }]) {
    assert.equal(await makeCallback.call({ instance: subject.instance, getMessage: async () => message }, helper).getMessage({}), undefined);
  }
  const unchanged = { conversation: 'Synthetic ordinary message' };
  assert.equal(await makeCallback.call({ instance: subject.instance, getMessage: async () => unchanged }, helper)
    .getMessage({ id: '3EB0F1A9C7D5E3B1RECONSTRUCTED' }), undefined);
  assert.equal(await makeCallback.call({ instance: { name: 'unmanaged' }, getMessage: async () => unchanged }, helper).getMessage({}), unchanged);
});
test('actual transformed socket creation derives managed retry scope from runtime instance, overriding editable config', () => {
  const socketLine = baileys.split('\n').find(line => line.includes('this.client = makeWASocket('));
  assert.ok(socketLine.includes('.socketConfig(this.instance.name, socketConfig)'));
  const create = new Function('require', 'makeWASocket', 'socketConfig', socketLine + '\nreturn this.client;');
  for (const [name, expected] of [['nexi-wa-runtime', true], ['unmanaged', false]]) {
    const scope = create.call({ instance: { name } }, helper, config => config,
      { nexiFinancialManaged: !expected, enableRecentMessageCache: true });
    assert.equal(scope.nexiFinancialManaged, expected);
    assert.equal(scope.enableRecentMessageCache, true);
  }
});
function nativeRetryFixture({ managed = true, fallback, recvSource = raw, sendSource = rawSend } = {}) {
  const managerFile = 'node_modules/baileys/lib/Utils/message-retry-manager.js';
  const managerSource = fs.readFileSync(fs.existsSync(path.join(__dirname, managerFile))
    ? path.join(__dirname, managerFile) : path.join(upstream, managerFile), 'utf8');
  const { LRUCache } = require(require.resolve('lru-cache', { paths: [__dirname, upstream] }));
  const Manager = new Function('LRUCache', managerSource.replace(/^import .*;\r?\n/gm, '')
    .replaceAll('export var ', 'var ').replaceAll('export class ', 'class ') + '\nreturn MessageRetryManager;')(LRUCache);
  const manager = new Manager(logger, 5);
  const effects = { relay: 0, sendNode: 0, fallback: 0 };
  const wireBody = section(sendSource, sendSource.includes('nexiFinancial.assertWireRecipient(')
    ? '            nexiFinancial.assertWireRecipient('
    : '            logger.debug({ msgId }, `sending message to ${participants.length} devices`);', '            // Fire-and-forget:');
  const wire = new Function('nexiFinancial', 'logger', 'sendNode', 'destinationJid', 'stanza', 'authState', 'message', 'config',
    `return (async () => { const msgId = stanza.attrs.id; const participants = []; ${wireBody} })();`);
  const bindings = {
    nexiFinancial: financial, config: { nexiFinancialManaged: managed }, logger, messageRetryManager: manager,
    getMessage: async key => { effects.fallback++; return typeof fallback === 'function' ? fallback(key) : fallback; },
    jidDecode: () => ({ device: 1 }), signalRepository: {
      jidToSignalProtocolAddress: () => 'synthetic', getSessionInfo: async () => null,
    }, extractE2ESessionFromRetryReceipt: () => null, getBinaryNodeChildUInt: () => undefined,
    enableAutoSessionRecreation: false, assertSessions: async () => {}, isJidGroup: () => false,
    isJidStatusBroadcast: () => false, authState: { creds: { me: { id: jidB } } },
    willSendMessageAgain: async () => true, updateSendMessageAgainCount: async () => {},
    relayMessage: async (jid, message, options) => {
      effects.relay++;
      await wire(financial, logger, async () => effects.sendNode++, jid,
        { attrs: { to: jid, id: options.messageId }, content: [] }, {}, message, { nexiFinancialManaged: managed });
    },
    areJidsSameUser: () => false, getBinaryNodeChildren: () => [], getBinaryNodeChild: () => ({ attrs: { count: '1' } }),
    receiptMutex: { mutex: fn => fn() }, getStatusFromReceiptType: () => undefined,
    ev: { emit() {} }, sendMessageAck: async () => {},
  };
  const receipt = new Function(...Object.keys(bindings),
    section(recvSource, '    const sendMessagesAgain = async', '    const handleNotification =') + '\nreturn handleReceipt;')(...Object.values(bindings));
  return { manager, effects, retry: id => receipt({ attrs: { from: jidA, id, type: 'retry' } }),
    close: () => { for (const value of Object.values(manager)) if (value instanceof LRUCache) value.clear(); } };
}

test('pristine pinned Baileys reproduces financial echo -> recent cache -> retry bypassing getMessage and relaying without ALS', async () => {
  const fixture = nativeRetryFixture({ recvSource: originalRecv, sendSource: originalSend });
  try {
    const echo = await decryptedFixture({ from: '5500000000000:1@s.whatsapp.net', attrs: { recipient: jidA },
      key: { fromMe: true, remoteJid: jidA, id: 'baseline-financial-id' }, message: cta,
      retryManager: fixture.manager, recvSource: originalRecv });
    assert.deepEqual(echo.errors, []); assert.equal(echo.event, 'notify');
    assert.ok(fixture.manager.getRecentMessage(jidA, 'baseline-financial-id'));
    await fixture.retry('baseline-financial-id');
    assert.equal(fixture.effects.fallback, 0);
    assert.equal(fixture.effects.relay, 1); assert.equal(fixture.effects.sendNode, 1);
  } finally { fixture.close(); }
});

test('actual authenticated financial echo and native retry receipt produce ZERO second relay/sendNode with recent cache and DB OFF', async () => {
  const fixture = nativeRetryFixture({ fallback: undefined }); // DB OFF: no stored payload.
  try {
    const { subject } = sendSubject();
    const idLine = rawSend.split('\n').find(line => line.includes('msgId = nexiFinancial.relayMessageId('));
    const assignId = new Function('nexiFinancial', 'message', `const config = { nexiFinancialManaged: true }; let msgId; ${idLine} return msgId;`);
    const wireBody = section(rawSend, '            nexiFinancial.assertWireRecipient(', '            // Fire-and-forget:');
    const send = new Function('nexiFinancial', 'logger', 'sendNode', 'destinationJid', 'stanza', 'authState', 'message',
      `return (async () => { const config = { nexiFinancialManaged: true }, msgId = stanza.attrs.id, participants = []; ${wireBody} })();`);
    let id, firstOutbound = 0;
    subject.client.relayMessage = async (jid, message) => {
      id = assignId(financial, message);
      await send(financial, logger, async () => firstOutbound++, jid,
        { attrs: { id, to: jid }, content: [] }, subject.client.authState, message);
      return id;
    };
    await withTestRecipient(subject, () => subject.sendMessageWithTyping('5511999999999', cta, {}));
    assert.equal(firstOutbound, 1);
    assert.match(id, /^3EB0F1A9C7D5E3B1[0-9A-F]{16}$/);
    const echo = await decryptedFixture({ from: '5500000000000:1@s.whatsapp.net', attrs: { recipient: jidA },
      key: { fromMe: true, remoteJid: jidA, id }, message: cta, retryManager: fixture.manager });
    assert.deepEqual(echo.errors, []); assert.equal(echo.event, 'notify');
    assert.equal(fixture.manager.getRecentMessage(jidA, id), undefined, 'authenticated echo did not repopulate cache');
    await fixture.retry(id);
    assert.equal(fixture.effects.relay, 0); assert.equal(fixture.effects.sendNode, 0);
    assert.equal(firstOutbound + fixture.effects.sendNode, 1, 'no second outbound');
    // Force a stale/alternate cache insertion. The consumer must deny even
    // after the real manager removes the entry on markRetrySuccess.
    fixture.manager.addRecentMessage(jidA, id, cta);
    await fixture.retry(id);
    assert.equal(fixture.effects.relay, 0); assert.equal(fixture.effects.sendNode, 0);
  } finally { fixture.close(); }
});

test('native recent-cache/getMessage consumers deny old CTA, nested representations and reconstructed marked IDs without ALS', async () => {
  const urlCta = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: '{}' }] } } };
  for (const message of [cta, urlCta, { ephemeralMessage: { message: { viewOnceMessageV2Extension: { message: cta } } } },
    { deviceSentMessage: { message: cta } }, { conversation: 'reconstructed without CTA fields' }]) {
    for (const cached of [true, false]) {
      const id = message.conversation ? '3EB0F1A9C7D5E3B1RECONSTRUCTED' : 'old-unmarked-financial-id';
      const fixture = nativeRetryFixture({ fallback: message });
      try {
        if (cached) fixture.manager.addRecentMessage(jidA, id, message);
        await fixture.retry(id);
        assert.equal(fixture.effects.fallback, cached ? 0 : 1, 'recent-cache bypass of getMessage is exercised');
        assert.equal(fixture.effects.relay, 0); assert.equal(fixture.effects.sendNode, 0);
      } finally { fixture.close(); }
    }
  }
});

test('native retry cannot borrow expired/replaced financial context, and final wire denies managed content without ALS', async () => {
  const fixture = nativeRetryFixture({ fallback: cta });
  try {
    const { subject } = sendSubject();
    const oldNow = Date.now;
    await withTestRecipient(subject, async () => {
      subject.instanceId = 'revoked-runtime-binding';
      Date.now = () => oldNow() + 300001;
      try { await fixture.retry('old-financial-id'); } finally { Date.now = oldNow; }
    });
    assert.equal(fixture.effects.relay, 0); assert.equal(fixture.effects.sendNode, 0);
    const wireBody = section(rawSend, '            nexiFinancial.assertWireRecipient(', '            // Fire-and-forget:');
    const wire = new Function('nexiFinancial', 'logger', 'sendNode', 'message', 'stanza',
      `return (async () => { const config = { nexiFinancialManaged: true }, authState = { creds: {} };
        const destinationJid = '${jidA}', msgId = stanza.attrs.id, participants = []; ${wireBody} })();`);
    for (const [id, message] of [['3EB0F1A9C7D5E3B1RECONSTRUCTED', {}], ['old-financial-id', cta]]) {
      await assert.rejects(wire(financial, logger, async () => fixture.effects.sendNode++, message,
        { attrs: { id, to: jidA } }), /native_retry_denied/);
      assert.throws(() => financial.relayMessageId(true, id, message), /native_retry_denied/);
    }
    assert.equal(fixture.effects.sendNode, 0);
  } finally { fixture.close(); }
});

test('actual unmanaged echoes, recent-cache and getMessage retries retain native relay/sendNode baseline', async () => {
  for (const managed of [false, true]) {
    for (const cached of [false, true]) {
      // Unmanaged CTAs are generic Evolution traffic; managed plain messages
      // also retain native retries. The marker only denies in managed scope.
      const message = managed ? { conversation: 'ordinary' } : cta;
      const id = managed ? 'ordinary-id' : '3EB0F1A9C7D5E3B1UNMANAGED';
      const fixture = nativeRetryFixture({ managed, fallback: message });
      try {
        if (cached) {
          const echo = await decryptedFixture({ from: '5500000000000:1@s.whatsapp.net', attrs: { recipient: jidA },
            key: { fromMe: true, remoteJid: jidA, id }, message, managed, retryManager: fixture.manager });
          assert.deepEqual(echo.errors, []); assert.equal(echo.event, 'notify');
          assert.ok(fixture.manager.getRecentMessage(jidA, id));
        }
        await fixture.retry(id);
        assert.equal(fixture.effects.fallback, cached ? 0 : 1);
        assert.equal(fixture.effects.relay, 1); assert.equal(fixture.effects.sendNode, 1);
      } finally { fixture.close(); }
    }
  }
});

test('actual managed conversation path ignores telephone/cache lookup and requires server-owned Inbox/CI association', async () => {
  const Subject = compile(section(mapper, '  public async createConversation(', '  public async getInbox('));
  const subject = new Subject(); subject.logger = logger; subject.provider = { accountId: 1, inboxId: 10 };
  subject.cache = { has: async () => true, get: async () => 901 }; subject.findContact = async () => null;
  subject.clientCw = async () => ({ conversations: { get: async () => ({ id: 901, inbox_id: 11, meta: { sender: {} } }) } });
  const body = { key: { fromMe: false, remoteJid: jidA } };
  assert.equal(await subject.createConversation({ instanceName: 'nexi-wa-synthetic' }, body), null);
  identity.bind(body, { account_id: 1, inbox_id: 11, conversation_display_id: 901 });
  assert.equal(await subject.createConversation({ instanceName: 'nexi-wa-synthetic' }, body), null);
  identity.bind(body, { account_id: 1, inbox_id: 10, contact_inbox_id: 4, conversation_display_id: 902 });
  assert.equal(await subject.createConversation({ instanceName: 'nexi-wa-synthetic' }, body), 902);
  assert.equal(await subject.createConversation({ instanceName: 'nexi-wa-synthetic' }, { key: { fromMe: true, remoteJid: jidA } }), null);
  assert.equal(await subject.createConversation({ instanceName: 'unmanaged' }, { key: { fromMe: false, remoteJid: jidA } }), 901);
});
test('each actual retry post gets fresh HMAC, stable UUID/body and bounded exponential backoff; 401 stops', async () => {
  const Subject = compile(section(retry, '  private async retryWebhookRequest(', '  private generateJwtToken('), {
    configService: { get: () => ({ RETRY: { MAX_ATTEMPTS: 1000, INITIAL_DELAY_SECONDS: 0 } }) },
    setTimeout: fn => { fn(); },
  });
  const subject = new Subject(); subject.logger = logger;
  const oldSecret = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  const oldNow = Date.now; let now = 1800000000000; Date.now = () => now;
  try {
    const headers = { 'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '10' };
    const prepared = transport.prepareEvent(headers, { event: 'connection.update', instance: 'nexi-wa-synthetic', data: { state: 'open' } }, 'nexi-wa-synthetic', 'synthetic-instance');
    const requests = []; let interceptor;
    const http = { interceptors: { request: { use: fn => interceptor = fn } }, post: async (_url, data) => {
      const c = interceptor({ data }); requests.push(c); now += 360000;
      if (requests.length < 3) throw Object.assign(new Error('synthetic'), { response: { status: 503 } });
    } };
    await subject.retryWebhookRequest(transport.signedEventClient(http, prepared), prepared.body, 'synthetic', 'https://example.test', 'synthetic');
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map(c => c.headers['X-Nexi-Event-Id'])).size, 1);
    assert.equal(new Set(requests.map(c => c.headers['X-Nexi-Event-Timestamp'])).size, 3);
    assert.equal(new Set(requests.map(c => JSON.stringify(c.data))).size, 1);
    for (const c of requests) {
      const h = c.headers; const secret = createHmac('sha256', master).update('event:nexi-wa-synthetic').digest();
      const expected = createHmac('sha256', secret).update(`${h['X-Nexi-Event-Timestamp']}.${h['X-Nexi-Event-Id']}.nexi-wa-synthetic.synthetic-instance.${JSON.stringify(c.data)}`).digest('hex');
      assert.equal(h['X-Nexi-Event-Signature'], `sha256=${expected}`);
    }
    assert.throws(() => interceptor({ data: { ...prepared.body, data: { state: 'close' } } }), /payload_conflict/);
    let attempts = 0;
    await assert.rejects(subject.retryWebhookRequest({ post: async () => { attempts++; throw { response: { status: 401 } }; } }, prepared.body, 'synthetic', 'synthetic', 'synthetic'));
    assert.equal(attempts, 1);
    const policy = transport.retryPolicy(prepared.body, { RETRY: { MAX_ATTEMPTS: 10000, INITIAL_DELAY_SECONDS: 0 } });
    assert.equal(policy.maxRetryAttempts, 6); assert.equal(policy.initialDelay, 5);
  } finally { Date.now = oldNow; if (oldSecret === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = oldSecret; }
});
test('identity event allowlist never serializes message/media/PIX/session keys; unmanaged projection unchanged', () => {
  const old = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  try {
    const body = { event: 'identity.observed', instance: 'nexi-wa-synthetic', data: { version: 1,
      origin: 'baileys.cb_message.decrypt', external_message_id: 'synthetic-id', pn_jid: jidA, lid_jid: null,
      session_identity: 'a'.repeat(64), account_id: 1, inbox_id: 10, message: 'FINANCIAL_SECRET_NEVER_LOG',
      media: 'FINANCIAL_SECRET_NEVER_LOG', key: 'FINANCIAL_SECRET_NEVER_LOG' } };
    const signed = transport.prepareEvent({ 'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '10' }, body, body.instance, 'synthetic-instance');
    assert.doesNotMatch(JSON.stringify(signed), /FINANCIAL_SECRET_NEVER_LOG/);
    assert.doesNotMatch(JSON.stringify(transport.redactEventForLog(signed.body)), /551199|session_identity|pn_jid/);
    assert.equal(transport.prepareEvent({}, body, 'unmanaged', 'synthetic').body, body);
  } finally { if (old === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET; else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = old; }
});
