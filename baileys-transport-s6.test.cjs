'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const transport = require('./nexi-baileys-transport.cjs');
const { DeviceCache } = require('./nexi-baileys-device-cache.cjs');
const fixture = process.env.S6_COMPOSED_ROOT;
assert.ok(fixture, 'S6_COMPOSED_ROOT must point to the composed, patched fixture');
const deps = process.env.S6_DEPENDENCIES || path.join(__dirname, '.test-runtime/dependencies/node_modules');
const ts = require(path.join(deps, 'typescript/lib/typescript.js'));
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url.toString()).hostname, '127.0.0.1', 'S6_EXTERNAL_NETWORK_TRAP');
  return nativeFetch(url, options);
};
test.after(() => { globalThis.fetch = nativeFetch; });
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('/evolution/')) return next(pathToFileURL(path.join(__dirname, specifier.slice(11))).href, context);
  return next(specifier, context);
} });
let media, binary, usync, makeMutex;
test.before(async () => {
  media = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/Utils/messages-media.js')));
  binary = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/WABinary/index.js')));
  usync = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/WAUSync/index.js')));
  ({ makeMutex } = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/Utils/make-mutex.js'))));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function response(body = 'complete') { return new Response(body); }
function device(user = '123', server = 's.whatsapp.net', id = 1) { return { user, server, device: id }; }
function socketScope(service = {}) {
  const scope = transport.createSocketTransport();
  let end;
  const native = { registerSocketEndHandler(fn) { end = fn; } };
  const socket = { updateMediaMessage: async message => message };
  transport.bindSocket(scope, native); // Real Baileys layers spread into a different final socket/proxy.
  service.client = socket;
  transport.activateSocket(scope, service, socket, () => service.client === socket);
  return { scope, socket, service, end: () => end() };
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
function initializer(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(parsed.parseDiagnostics, []);
  const found = [];
  function visit(node) { if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText(parsed) === name) found.push(node.initializer.getText(parsed)); ts.forEachChild(node, visit); }
  visit(parsed);
  assert.equal(found.length, 1, `unique ${name} anchor`);
  return found[0];
}

test('real rc13 native fetch completes and honors byte limits', { timeout: 4000 }, async t => {
  const url = await server(t, (_req, res) => res.end('transport-body'));
  const start = performance.now();
  assert.equal((await collect(await media.getHttpStream(url, { timeoutMs: 1000 }))).toString(), 'transport-body');
  await assert.rejects(async () => collect(await media.getHttpStream(url, { timeoutMs: 1000, maxContentLength: 4 })),
    { code: 'NEXI_DOWNLOAD_MAX_BYTES' });
  t.diagnostic(`fixture completed/limited in ${Math.round(performance.now() - start)} ms; no WhatsApp transport`);
});

test('real rc13 deadline covers time before headers with native cooperative cancellation', { timeout: 4000 }, async t => {
  let closed = false;
  const url = await server(t, (_req, res) => { res.on('close', () => { closed = true; }); });
  const start = performance.now();
  await assert.rejects(media.getHttpStream(url, { timeoutMs: 80 }), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  for (let i = 0; i < 20 && !closed; i++) await pause(5);
  assert.equal(closed, true);
  assert.ok(performance.now() - start < 1500);
  t.diagnostic(`fixture headers timeout + close ${Math.round(performance.now() - start)} ms`);
});

test('real rc13 body stall after partial data is bounded and closes the stream', { timeout: 4000 }, async t => {
  let bytes = 0;
  const url = await server(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  const start = performance.now();
  const stream = await media.getHttpStream(url, { timeoutMs: 120 });
  await assert.rejects(async () => { for await (const chunk of stream) bytes += chunk.length; }, { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  assert.equal(bytes, 7);
  t.diagnostic(`fixture body timeout ${Math.round(performance.now() - start)} ms`);
});

test('actual rc13 decrypts AES-CBC and propagates interrupted/range failures', { timeout: 4000 }, async t => {
  const cipherKey = crypto.randomBytes(32), iv = crypto.randomBytes(16), plain = Buffer.from('verified media fixture');
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const url = await server(t, (req, res) => {
    if (req.url === '/stall') { res.writeHead(200); res.write(ciphertext.subarray(0, 16)); }
    else if (req.url === '/short') res.end(Buffer.from([1, 2, 3]));
    else res.end(ciphertext);
  });
  assert.deepEqual(await collect(await media.downloadEncryptedContent(url, { cipherKey, iv }, { options: { timeout: 1000 } })), plain);
  await assert.rejects(async () => collect(await media.downloadEncryptedContent(url + '/stall', { cipherKey, iv },
    { options: { timeout: 100 } })), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  await assert.rejects(async () => collect(await media.downloadEncryptedContent(url + '/short', { cipherKey, iv },
    { startByte: 32, options: { timeout: 1000 } })));
});

test('actual rc13 media encryption accepts the exact declared byte limit', { timeout: 4000 }, async t => {
  const body = Buffer.alloc(100, 7);
  const url = await server(t, (_req, res) => res.end(body));
  const encrypted = await media.encryptedStream({ url }, 'document', { opts: { maxContentLength: 100, timeout: 1000 } });
  t.after(() => fs.unlinkSync(encrypted.encFilePath));
  assert.equal(encrypted.fileLength, 100);
  await assert.rejects(media.encryptedStream({ url }, 'document', { opts: { maxContentLength: 99, timeout: 1000 } }),
    { code: 'NEXI_DOWNLOAD_MAX_BYTES' });
});

test('response without content-length is still byte bounded and upstream cancellation is awaited', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, timeoutMs: 1000, maxBytes: 4 });
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
  await assert.rejects(async () => collect(await transport.download('https://fixture.invalid', {},
    { downloadPool: pool, fetcher: async () => response(body) })), { code: 'NEXI_DOWNLOAD_MAX_BYTES' });
  await tick();
  assert.equal(cancelled, true);
  assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
});

test('aborted facade does not free capacity while fetch ignores cancellation', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, maxQueued: 0, timeoutMs: 40 });
  const pending = deferred(); let calls = 0;
  await assert.rejects(transport.download('https://fixture.invalid', {}, { downloadPool: pool,
    fetcher: () => { calls++; return pending.promise; } }), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  assert.equal(pool.stats().active, 1);
  await assert.rejects(transport.download('https://fixture.invalid', {}, { downloadPool: pool,
    fetcher: async () => { calls++; return response(); } }), { code: 'NEXI_DOWNLOAD_BACKPRESSURE' });
  assert.equal(calls, 1, 'no extra request while the real slot remains occupied');
  pending.resolve(response());
  await tick(); await tick();
  assert.equal(pool.stats().active, 0);
});

test('pending stream cancellation also retains its slot until cancellation actually settles', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, timeoutMs: 40 });
  const cancel = deferred(); let cancellationRequested = false;
  const body = new ReadableStream({ cancel() { cancellationRequested = true; return cancel.promise; } });
  const stream = await transport.download('https://fixture.invalid', {}, { downloadPool: pool, fetcher: async () => response(body) });
  await assert.rejects(collect(stream), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  assert.equal(cancellationRequested, true);
  assert.equal(pool.stats().active, 1);
  cancel.resolve();
  await tick(); await tick();
  assert.equal(pool.stats().active, 0);
});

test('failed underlying cancellation is uncertain even if Web Streams synthesizes EOF', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, timeoutMs: 40 });
  const body = new ReadableStream({ cancel() { return Promise.reject(new Error('transport did not cancel')); } });
  const stream = await transport.download('https://fixture.invalid', {}, { downloadPool: pool, fetcher: async () => response(body) });
  await assert.rejects(collect(stream), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  await tick(); await tick();
  assert.equal(pool.stats().active, 1);
  assert.equal([...pool.active][0].cancellationUnconfirmed, true);
});

test('consumer cancellation cleans up the source without leaving a pipeline occupied', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, timeoutMs: 1000 });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const stream = await transport.download('https://fixture.invalid', {}, { downloadPool: pool, fetcher: async () => response(body) });
  stream.destroy();
  await tick(); await tick();
  assert.equal(cancelled, true);
  assert.equal(pool.stats().active, 0);
});

test('independent contacts progress; same-contact queue is bounded and app-state has reserved capacity', async () => {
  const owner = socketScope(), options = transport.optionsFor(owner.socket);
  const pool = new transport.DownloadPool({ concurrency: 4, perScope: 2, timeoutMs: 1000, maxQueued: 1 });
  const held = deferred();
  const slow = transport.download('https://fixture.invalid', { ...options, nexiDownloadLane: 'first@s.whatsapp.net' },
    { downloadPool: pool, fetcher: () => held.promise });
  const fast = await transport.download('https://fixture.invalid', { ...options, nexiDownloadLane: 'second@s.whatsapp.net' },
    { downloadPool: pool, fetcher: async () => response('other contact') });
  assert.equal((await collect(fast)).toString(), 'other contact');
  const secondSame = transport.download('https://fixture.invalid', { ...options, nexiDownloadLane: 'first@s.whatsapp.net' },
    { downloadPool: pool, fetcher: async () => response('queued') });
  await assert.rejects(transport.download('https://fixture.invalid', { ...options, nexiDownloadLane: 'first@s.whatsapp.net' },
    { downloadPool: pool, fetcher: async () => response('must not start') }), { code: 'NEXI_DOWNLOAD_BACKPRESSURE' });
  const state = await transport.download('https://fixture.invalid', { ...options, nexiDownloadClass: 'key_state' },
    { downloadPool: pool, fetcher: async () => response('app state') });
  assert.equal((await collect(state)).toString(), 'app state');
  held.resolve(response('first'));
  assert.equal((await collect(await slow)).toString(), 'first');
  assert.equal((await collect(await secondSame)).toString(), 'queued');
  owner.end();
});

test('queued deadline and already aborted signals never start a network operation', async () => {
  const pool = new transport.DownloadPool({ concurrency: 2, timeoutMs: 1000 });
  const held = deferred(); let queuedCalls = 0;
  const first = transport.download('https://fixture.invalid', {}, { downloadPool: pool, fetcher: () => held.promise });
  first.catch(() => {});
  await assert.rejects(transport.download('https://fixture.invalid', { timeout: 20 }, { downloadPool: pool,
    fetcher: async () => { queuedCalls++; return response(); } }), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport.download('https://fixture.invalid', { signal: controller.signal }, { downloadPool: pool,
    fetcher: async () => { queuedCalls++; return response(); } }));
  assert.equal(queuedCalls, 0);
  held.resolve(response());
  await collect(await first);
});

test('custom caller abort reasons stay classified as cancellation, without fallback retries', async () => {
  const controller = new AbortController(), pool = new transport.DownloadPool({ timeoutMs: 1000 });
  const stream = await transport.download('https://fixture.invalid', { signal: controller.signal },
    { downloadPool: pool, fetcher: async () => response(new ReadableStream({})) });
  const rejected = assert.rejects(collect(stream), error => transport.terminalDownloadError(error) && error.code === 'NEXI_DOWNLOAD_ABORTED');
  controller.abort(new Error('caller requested cancellation'));
  await rejected;
  await tick();
  assert.equal(pool.stats().active, 0);
});

test('media saturation cannot consume the reserved app-state slot', async () => {
  const pool = new transport.DownloadPool({ concurrency: 4, timeoutMs: 1000 });
  const owners = Array.from({ length: 5 }, () => socketScope());
  const held = Array.from({ length: 3 }, () => deferred());
  const running = held.map((pending, index) => transport.download('https://fixture.invalid', owners[index].scope.options,
    { downloadPool: pool, fetcher: () => pending.promise }));
  let fourthStarted = false;
  const fourth = transport.download('https://fixture.invalid', owners[3].scope.options, { downloadPool: pool,
    fetcher: async () => { fourthStarted = true; return response('fourth'); } });
  assert.equal(pool.stats().active, 3);
  assert.equal(fourthStarted, false);
  const appState = await transport.download('https://fixture.invalid', { ...owners[4].scope.options, nexiDownloadClass: 'key_state' },
    { downloadPool: pool, fetcher: async () => response('key state') });
  assert.equal((await collect(appState)).toString(), 'key state');
  assert.equal(fourthStarted, false);
  held.forEach(pending => pending.resolve(response('media')));
  for (const operation of running) await collect(await operation);
  assert.equal((await collect(await fourth)).toString(), 'fourth');
  owners.forEach(owner => owner.end());
});

test('new socket cancels old downloads, fences late headers and discards only the old device cache', async () => {
  const service = {}, old = socketScope(service), pending = deferred();
  old.scope.devices.set('123@s.whatsapp.net', [device()]);
  const pool = new transport.DownloadPool({ timeoutMs: 1000 });
  const operation = transport.download('https://fixture.invalid', transport.optionsFor(old.socket),
    { downloadPool: pool, fetcher: () => pending.promise });
  const replacement = socketScope(service);
  await assert.rejects(operation, { code: 'NEXI_DOWNLOAD_SESSION_FENCED' });
  assert.equal(pool.stats().active, 1);
  assert.equal(old.scope.devices.get('123@s.whatsapp.net'), undefined);
  assert.throws(() => transport.optionsFor(old.socket), { code: 'NEXI_DOWNLOAD_SESSION_FENCED' });
  replacement.scope.devices.set('123@s.whatsapp.net', [device('123', 's.whatsapp.net', 2)]);
  pending.resolve(response('old socket bytes'));
  await tick(); await tick();
  assert.equal(pool.stats().active, 0);
  old.end();
  assert.equal(replacement.scope.devices.get('123@s.whatsapp.net')[0].device, 2);
  replacement.end();
});

test('media wrapper captures socket/proxy options and never invents a retry after interruption', async () => {
  const owner = socketScope(); let calls = 0, repairs = 0;
  const dispatcher = {};
  owner.scope.options.dispatcher = dispatcher;
  owner.socket.updateMediaMessage = async value => { repairs++; return value; };
  await assert.rejects(transport.downloadMedia(owner.socket, { key: { remoteJid: '123@lid' } }, 'buffer',
    async (_message, _type, { options }) => {
      calls++;
      assert.equal(options.dispatcher, dispatcher);
      assert.equal(options.nexiDownloadLane, '123@lid');
      throw Object.assign(new Error('partial response lost'), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
    }, {}), { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(repairs, 0);
  assert.equal(transport.terminalDownloadError(Object.assign(new Error(), { code: 'NEXI_DOWNLOAD_MAX_BYTES' })), true);
  owner.end();
});

test('fencing during a body read prevents late bytes from reaching the decrypt/consumer', async () => {
  const owner = socketScope(), pool = new transport.DownloadPool({ timeoutMs: 1000 });
  let source;
  const body = new ReadableStream({ start(controller) { source = controller; controller.enqueue(Buffer.from('first')); } });
  const stream = await transport.download('https://fixture.invalid', owner.scope.options,
    { downloadPool: pool, fetcher: async () => response(body) });
  let received = '';
  const result = assert.rejects(async () => { for await (const chunk of stream) received += chunk.toString(); },
    { code: 'NEXI_DOWNLOAD_SESSION_FENCED' });
  await tick();
  owner.service.client = {};
  source.enqueue(Buffer.from('late must be ignored'));
  await result;
  assert.equal(received, 'first');
  await tick();
  assert.equal(pool.stats().active, 0);
  assert.equal(owner.scope.closed, true);
});

test('cache matches exact rc13 value contract, legacy val, TTL seconds, missing keys and clone isolation', () => {
  const legacy = require(path.join(deps, 'node-cache'));
  const real = new legacy({ stdTTL: 300000 });
  real.mset([{ key: '123', value: [device()] }]);
  assert.equal(real.get('123'), null, 'legacy node-cache stores null when only rc13 value is supplied');
  assert.ok(real.getTtl('123') - Date.now() > 299999000, 'legacy stdTTL is seconds, not milliseconds');
  const Cacheable = require(path.join(deps, '@cacheable/node-cache')).default;
  const native = new Cacheable({ stdTTL: 300 });
  native.mset([{ key: '123', value: [device()] }]);
  assert.equal(native.get('123')[0].device, 1);
  native.close();
  real.close();
  let clock = 0;
  const cache = new DeviceCache({ now: () => clock });
  cache.mset([{ key: '123@s.whatsapp.net', value: [device()] }, { key: '123@lid', val: [device('123', 'lid', 7)] }]);
  const fetched = cache.mget(['123@s.whatsapp.net', '123@lid', 'absent@lid']);
  assert.equal(fetched['123@s.whatsapp.net'][0].server, 's.whatsapp.net');
  assert.equal(fetched['123@lid'][0].device, 7);
  assert.equal(fetched['absent@lid'], undefined);
  fetched['123@lid'][0].device = 99;
  assert.equal(cache.get('123@lid')[0].device, 7);
  clock = 299999; assert.ok(cache.has('123@lid'));
  clock = 300000; assert.equal(cache.get('123@lid'), undefined);
  cache.set('123@lid', [device('123', 'lid')], 1);
  clock += 1000; assert.equal(cache.get('123@lid'), undefined);
});

test('cache invalidation fences in-flight queries and memory has explicit bounds', () => {
  const cache = new DeviceCache({ maxKeys: 2, maxDevices: 2, maxBytes: 2000 });
  const epoch = cache.revision();
  cache.del('123@lid');
  assert.equal(cache.msetIfRevision(epoch, [{ key: '123@lid', value: [device('123', 'lid')] }]), false);
  assert.equal(cache.get('123@lid'), undefined);
  cache.set('1@lid', [device('1', 'lid')]); cache.set('2@lid', [device('2', 'lid')]); cache.set('3@lid', [device('3', 'lid')]);
  assert.equal(cache.has('1@lid'), false);
  assert.ok(cache.entries.size <= 2 && cache.devices <= 2 && cache.bytes <= 2000);
  assert.throws(() => cache.mset([{ key: '3@lid', value: [device()], val: [] }]));
  assert.equal(cache.set('123@lid', [device('123', 's.whatsapp.net')]), false, 'a PN descriptor cannot be cached as LID');
  assert.equal(cache.get('123@lid'), undefined);
  cache.close(); assert.equal(cache.get('3@lid'), undefined);
  assert.equal(cache.msetIfRevision(cache.revision(), [{ key: '3@lid', value: [device()] }]), false);
});

test('actual rc13 USync cache hit preserves PN/LID domains and concurrent invalidation prevents stale caching', async () => {
  const code = initializer(path.join(fixture, 'node_modules/baileys/lib/Socket/messages-send.js'), 'getUSyncDevices');
  const cache = new DeviceCache(); let calls = 0, pending;
  const scope = { ...binary, ...usync, Set, Object, Array, nexiTransport: transport,
    logger: { debug() {}, trace() {}, warn() {} }, userDevicesCache: cache, devicesMutex: makeMutex(),
    authState: { creds: { me: { id: '999@s.whatsapp.net', lid: '999@lid' } }, keys: { async set() {} } },
    signalRepository: { lidMapping: { async storeLIDPNMappings() {} } }, assertSessions: async () => {},
    extractDeviceJids: () => [device('123', 's.whatsapp.net', 1), device('123', 'lid', 7)],
    sock: { executeUSyncQuery: async () => { calls++; return pending ? pending.promise : { list: [] }; } } };
  const getDevices = vm.runInNewContext(`(${code})`, scope);
  await getDevices(['123@s.whatsapp.net', '123@lid'], true, false);
  assert.equal(calls, 1);
  const pn = await getDevices(['123@s.whatsapp.net'], true, false);
  const lid = await getDevices(['123@lid'], true, false);
  assert.equal(calls, 1, 'actual cache hits skip the network query');
  assert.equal(pn[0].jid, '123:1@s.whatsapp.net');
  assert.equal(lid[0].jid, '123:7@lid');
  cache.del('123@s.whatsapp.net');
  pending = deferred();
  const inflight = getDevices(['123@s.whatsapp.net'], true, false);
  await tick();
  cache.del('123@s.whatsapp.net'); // Authenticated device notification while USync is awaiting its reply.
  pending.resolve({ list: [] });
  await inflight;
  assert.equal(cache.get('123@s.whatsapp.net'), undefined);
  assert.ok(cache.has('123@lid'), 'PN invalidation cannot evict the LID namespace');
});

test('actual rc13 device notification invalidates only its complete JID and preserves native session deletion', async () => {
  const code = initializer(path.join(fixture, 'node_modules/baileys/lib/Socket/messages-recv.js'), 'handleDevicesNotification');
  const cache = new DeviceCache();
  cache.set('123@s.whatsapp.net', [device()]); cache.set('123@lid', [device('123', 'lid', 7)]);
  const deleted = [];
  const handle = vm.runInNewContext(`(${code})`, { ...binary, Map, Set,
    userDevicesCache: cache, devicesMutex: makeMutex(), authState: { creds: { me: { id: '999@s.whatsapp.net', lid: '999@lid' } } },
    logger: { debug() {}, trace() {}, warn() {}, info() {} }, signalRepository: { async deleteSession(jids) { deleted.push(...jids); } } });
  await handle({ tag: 'notification', attrs: { from: '123@s.whatsapp.net' }, content: [
    { tag: 'update', attrs: {}, content: [{ tag: 'device', attrs: { jid: '123:1@s.whatsapp.net' } }] },
  ] });
  assert.equal(cache.has('123@s.whatsapp.net'), false);
  assert.equal(cache.has('123@lid'), true);
  await handle({ tag: 'notification', attrs: { from: '123@lid' }, content: [
    { tag: 'remove', attrs: {}, content: [{ tag: 'device', attrs: { jid: '123:7@lid' } }] },
  ] });
  assert.deepEqual(deleted, ['123:7@lid']);
  assert.equal(cache.has('123@lid'), false);
});

test('real keystore mutex releases through an actual download error; no forced transaction abandonment', { timeout: 4000 }, async t => {
  const { addTransactionCapability } = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/Utils/auth-utils.js')));
  const writes = [];
  const store = addTransactionCapability({ async get() { return {}; }, async set(value) { writes.push(value); } },
    { trace() {}, error() {} }, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
  const url = await server(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  let holding = false;
  const held = store.transaction(async () => {
    holding = true;
    await store.set({ 'fixture-state': { interrupted: { value: 1 } } });
    try { await collect(await media.getHttpStream(url, { timeoutMs: 100 })); } finally { holding = false; }
  }, 'fixture-own-jid');
  const rejection = assert.rejects(held, { code: 'NEXI_DOWNLOAD_TIMEOUT' });
  const next = store.transaction(async () => {
    assert.equal(holding, false);
    await store.set({ 'fixture-state': { completed: { value: 2 } } });
  }, 'fixture-own-jid');
  await rejection; await next;
  assert.equal(writes.length, 1);
  assert.equal(writes[0]['fixture-state'].interrupted, undefined);
  assert.equal(writes[0]['fixture-state'].completed.value, 2);
});

test('upstream photo backport nests tokens without changing recipient or querying from ingress', () => {
  const token = { tag: 'tctoken', attrs: {}, content: Buffer.from([7]) };
  assert.deepEqual(transport.buildProfilePictureQueryContent('image', [token]),
    [{ tag: 'picture', attrs: { type: 'image', query: 'url' }, content: [token] }]);
  assert.deepEqual(transport.buildProfilePictureQueryContent('preview'), [{ tag: 'picture', attrs: { type: 'preview', query: 'url' } }]);
});

test('actual rc13 photo function retains token lookup and exact target with the nested upstream query', async () => {
  const code = initializer(path.join(fixture, 'node_modules/baileys/lib/Socket/chats.js'), 'profilePictureUrl');
  const { buildTcTokenFromJid } = await import(pathToFileURL(path.join(fixture, 'node_modules/baileys/lib/Utils/tc-token-utils.js')));
  let request, lookups = 0;
  const picture = vm.runInNewContext(`(${code})`, { ...binary, nexiTransport: transport, buildTcTokenFromJid,
    serverProps: { profilePicPrivacyToken: true }, getLIDForPN: async () => null,
    authState: { creds: { me: { id: '999@s.whatsapp.net', lid: '999@lid' } }, keys: {
      async get(_type, [jid]) { lookups++; return { [jid]: { token: Buffer.from([7]), timestamp: Math.floor(Date.now() / 1000) } }; },
    } }, query: async node => { request = node; return { tag: 'iq', attrs: {}, content: [{ tag: 'picture', attrs: { url: 'https://fixture.invalid/photo' } }] }; } });
  assert.equal(await picture('123@s.whatsapp.net', 'image', 100), 'https://fixture.invalid/photo');
  assert.equal(request.attrs.target, '123@s.whatsapp.net');
  assert.equal(request.content.length, 1);
  assert.equal(request.content[0].tag, 'picture');
  assert.equal(request.content[0].content[0].tag, 'tctoken');
  assert.equal(lookups, 1);
  await picture('999@s.whatsapp.net');
  assert.equal(lookups, 1, 'self picture keeps native no-token semantics');
});

test('S6 preserves final wire, authenticated decrypt capture, receipts, auth store and protobuf', () => {
  const snapshot = path.join(fixture, '.transport-s6-upstream/node_modules/baileys/lib/Socket');
  for (const [file, name] of [['messages-send.js', 'relayMessage'], ['messages-send.js', 'sendMessage'],
    ['messages-recv.js', 'handleMessage'], ['messages-recv.js', 'handleReceipt']]) {
    assert.equal(initializer(path.join(fixture, 'node_modules/baileys/lib/Socket', file), name), initializer(path.join(snapshot, file), name));
  }
  for (const file of ['lib/Utils/auth-utils.js', 'WAProto/index.js']) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture, 'node_modules/baileys', file))).digest('hex'),
      crypto.createHash('sha256').update(fs.readFileSync(path.join(deps, 'baileys', file))).digest('hex'));
  }
  const recv = fs.readFileSync(path.join(fixture, 'node_modules/baileys/lib/Socket/messages-recv.js'), 'utf8');
  assert.match(recv, /observeDecrypted\(msg, node, authState.creds, getHistoryMsg\(msg.message\)\);\s*await nexiIngress.capture\(config, msg, proto\)/);
  assert.match(fs.readFileSync(path.join(fixture, 'node_modules/baileys/lib/Utils/event-buffer.js'), 'utf8'), /nexiMessageUpsertHead/);
});

test('artifact assertions reject absent provider bundles and changed patch anchors', () => {
  const assertion = path.join(__dirname, 'assert-baileys-transport-runtime.mjs');
  assert.notEqual(spawnSync(process.execPath, [assertion, fixture], { encoding: 'utf8', timeout: 5000 }).status, 0,
    'unbuilt fixture cannot masquerade as the final image');
  const check = spawnSync(process.execPath, [assertion, fixture, '--source-only'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(check.status, 0, check.stderr);
  const current = fs.readFileSync(path.join(fixture, 'node_modules/baileys/lib/Utils/messages-media.js'));
  const rerun = spawnSync(process.execPath, [path.join(__dirname, 'patch-baileys-transport.mjs'), fixture], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(rerun.status, 0, 'unexpected/already patched input fails closed');
  assert.deepEqual(fs.readFileSync(path.join(fixture, 'node_modules/baileys/lib/Utils/messages-media.js')), current);
  assert.deepEqual(transport.downloadStats(), { active: 0, queued: 0, cancellationUnconfirmed: 0 }, 'native requests actually settled after cancellation');
});

test('missing runtime helper fails source preflight before any source mutation', () => {
  const partial = fs.mkdtempSync(path.join(__dirname, '.test-runtime/s6-preflight-'));
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'fixtures/baileys-transport-s6.json')));
  for (const file of Object.keys(manifest.inputs)) {
    const target = path.join(partial, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fixture, '.transport-s6-upstream', file), target);
  }
  fs.copyFileSync(path.join(__dirname, 'nexi-baileys-transport.cjs'), path.join(partial, 'nexi-baileys-transport.cjs'));
  const check = spawnSync(process.execPath, [path.join(__dirname, 'patch-baileys-transport.mjs'), partial], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /nexi-baileys-device-cache.cjs/);
  for (const [file, digest] of Object.entries(manifest.inputs)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(partial, file))).digest('hex'), digest);
  }
});

test('S6 fingerprints reject changed inputs and historical compositions without partial writes', async t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'fixtures/baileys-transport-s6.json')));
  const provider = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
  const mutations = Object.keys(manifest.inputs).map(file => ({ file, name: file, change: source => source + '\n// synthetic fingerprint drift\n' }));
  function beforeIngressHotfix(source) {
    const helper = "require('/evolution/nexi-ingress.cjs')";
    const historical = source
      .replace(`(${helper}.current(this) || this.localChatwoot?.enabled)`, 'this.localChatwoot?.enabled')
      .replace(`(${helper}.current(this) || (this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&\n            this.localChatwoot?.enabled))`,
        "this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&\n            this.localChatwoot?.enabled")
      .replace(`} catch (error) {\n              if (${helper}.current(this)) throw error;\n              this.logger.warn('nexi_identity_association_rejected');`,
        `} catch {\n              if (${helper}.current(this)) throw new Error('nexi_ingress_identity_pending');\n              this.logger.warn('nexi_identity_association_rejected');`)
      .replace(`} catch (error) {\n                  if (${helper}.current(this)) throw error;\n                  this.logger.warn('nexi_identity_correlation_rejected');`,
        `} catch {\n                  if (${helper}.current(this)) throw new Error('nexi_ingress_correlation_pending');\n                  this.logger.warn('nexi_identity_correlation_rejected');`);
    assert.equal(crypto.createHash('sha256').update(historical).digest('hex'),
      '4f968359cf1dbaabe7db36bac057b55f61d4fbee61385f73678f48f6abe22ecb');
    return historical;
  }
  mutations.push({ file: provider, name: 'historical source which skips mandatory ingress for legacy flags', change: beforeIngressHotfix });
  mutations.push({ file: provider, name: 'historical source without the three accepted type assertions', change(source) {
    source = beforeIngressHotfix(source);
    assert.equal(source.split('cleanMessage(message as WAMessage,').length - 1, 1);
    assert.equal(source.split('...(message.key as Record<string, unknown>)').length - 1, 2);
    const historical = source.replace('cleanMessage(message as WAMessage,', 'cleanMessage(message,')
      .replaceAll('...(message.key as Record<string, unknown>)', '...message.key');
    assert.equal(crypto.createHash('sha256').update(historical).digest('hex'),
      '56d0a31141622514bd972d26a6c01b657f95ed10655173a95052d8afcf866448');
    return historical;
  } });
  for (const mutation of mutations) await t.test(mutation.name, () => {
    const partial = fs.mkdtempSync(path.join(__dirname, '.test-runtime/s6-fingerprint-'));
    for (const file of Object.keys(manifest.inputs)) {
      const target = path.join(partial, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(fixture, '.transport-s6-upstream', file), target);
    }
    for (const helper of ['nexi-baileys-transport.cjs', 'nexi-baileys-device-cache.cjs']) {
      fs.copyFileSync(path.join(__dirname, helper), path.join(partial, helper));
    }
    const target = path.join(partial, mutation.file);
    fs.writeFileSync(target, mutation.change(fs.readFileSync(target, 'utf8')));
    const before = Object.fromEntries(Object.keys(manifest.inputs).map(file => [file, fs.readFileSync(path.join(partial, file))]));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'patch-baileys-transport.mjs'), partial, '--snapshot'],
      { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`S6 accepted composition changed: ${mutation.file}`), result.stderr);
    for (const [file, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(partial, file)), bytes);
    assert.equal(fs.existsSync(path.join(partial, 'fixtures/baileys-transport-s6.json')), false);
    assert.equal(fs.existsSync(path.join(partial, '.transport-s6-upstream')), false);
  });
});
