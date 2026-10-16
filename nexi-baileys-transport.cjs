'use strict';

const { PassThrough, Readable, pipeline } = require('node:stream');
const { DeviceCache } = require('./nexi-baileys-device-cache.cjs');
const socketScopes = new WeakMap(), serviceScopes = new WeakMap();
const scopeOption = 'nexiBaileysTransportScope';

function failure(code) { return Object.assign(new Error(code), { code }); }
function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(`nexi_invalid_${name}`);
  return value;
}

class DownloadPool {
  constructor({ concurrency = 4, perScope = 2, maxQueued = 64, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) {
    for (const value of [concurrency, perScope, timeoutMs, maxBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw failure('nexi_download_limits');
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw failure('nexi_download_limits');
    Object.assign(this, { concurrency, perScope, maxQueued, timeoutMs, maxBytes });
    this.active = new Set();
    this.queued = [];
    this.lastScope = null;
  }
  canStart(operation) {
    const mediaLimit = Math.max(1, this.concurrency - 1); // Reserve progress for app-state key transactions.
    return this.active.size < this.concurrency && this.count(operation.scope) < this.perScope &&
      (operation.keyState || [...this.active].filter(item => !item.keyState).length < mediaLimit) &&
      (!operation.lane || ![...this.active].some(item => item.scope === operation.scope && item.lane === operation.lane));
  }
  count(scope) { return [...this.active].filter(operation => operation.scope === scope).length; }
  stats() { return { active: this.active.size, queued: this.queued.length }; }
  enqueue(operation) {
    if (this.queued.length >= this.maxQueued &&
        !this.canStart(operation)) {
      operation.abort(failure('NEXI_DOWNLOAD_BACKPRESSURE'));
      return;
    }
    this.queued.push(operation);
    this.drain();
  }
  remove(operation) {
    const index = this.queued.indexOf(operation);
    if (index >= 0) this.queued.splice(index, 1);
  }
  drain() {
    while (this.active.size < this.concurrency) {
      const eligible = this.queued.filter(operation => this.canStart(operation));
      const operation = eligible.find(candidate => candidate.scope !== this.lastScope || candidate.lane !== this.lastLane) || eligible[0];
      if (!operation) return;
      this.remove(operation);
      if (operation.error) continue;
      this.lastScope = operation.scope;
      this.lastLane = operation.lane;
      this.active.add(operation);
      operation.started = true;
      // The slot is released by run() only after fetch/read/cancel really settles.
      void operation.run();
    }
  }
  release(operation) {
    this.active.delete(operation);
    this.drain();
    if (!this.active.size && !this.queued.length) { this.lastScope = null; this.lastLane = null; }
  }
}

class Download {
  constructor(pool, url, options, fetcher, errorForStatus) {
    this.pool = pool;
    this.url = url;
    this.options = options;
    this.fetcher = fetcher;
    this.errorForStatus = errorForStatus;
    this.scope = options[scopeOption] || null;
    this.lane = typeof options.nexiDownloadLane === 'string' ? options.nexiDownloadLane.slice(0, 256) : null;
    this.keyState = options.nexiDownloadClass === 'key_state';
    this.controller = new AbortController();
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
    this.removers = [];
    const deadlines = [pool.timeoutMs, options.timeout, options.timeoutMs].filter(value => Number.isFinite(value) && value > 0);
    const limits = [pool.maxBytes, options.maxContentLength].filter(value => Number.isFinite(value) && value > 0);
    this.maxBytes = Math.min(...limits);
    this.timer = setTimeout(() => this.abort(failure('NEXI_DOWNLOAD_TIMEOUT')), Math.min(...deadlines));
  }
  check() {
    let current = true;
    try { current = !this.scope || !this.scope.closed && this.scope.current(); } catch { current = false; }
    if (!current) { this.scope?.close?.(); this.abort(failure('NEXI_DOWNLOAD_SESSION_FENCED')); }
    if (this.error) throw this.error;
  }
  listen(signal) {
    if (!signal || this.finished) return;
    const aborted = () => {
      const reason = signal.reason;
      const error = String(reason?.code || '').startsWith('NEXI_DOWNLOAD_') ? reason :
        Object.assign(failure('NEXI_DOWNLOAD_ABORTED'), { cause: reason });
      this.abort(error);
    };
    if (signal.aborted) aborted();
    else {
      signal.addEventListener('abort', aborted, { once: true });
      this.removers.push(() => signal.removeEventListener('abort', aborted));
    }
  }
  cancelReader() {
    if (this.reader && !this.cancelled) {
      this.cancelled = Promise.resolve().then(() => this.reader.cancel(this.error));
      this.cancelled.catch(() => {}); // Awaited at actual operation completion below.
    }
    return this.cancelled;
  }
  abort(error) {
    if (this.finished || this.error) return;
    this.error = error;
    this.controller.abort(error);
    this.reject(error);
    this.output?.destroy(error);
    this.cancelReader();
    if (!this.started) {
      this.pool.remove(this);
      this.finish();
    }
  }
  finish() {
    this.finished = true;
    clearTimeout(this.timer);
    for (const remove of this.removers) remove();
    this.scope?.operations.delete(this);
    this.resolveSettled();
    if (this.started) this.pool.release(this);
  }
  async write(chunk) {
    if (this.output.destroyed) throw this.error || failure('NEXI_DOWNLOAD_CONSUMER_CLOSED');
    if (this.output.write(chunk)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { this.output.off('drain', drained); this.output.off('close', closed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(this.error || failure('NEXI_DOWNLOAD_CONSUMER_CLOSED')); };
      this.output.once('drain', drained);
      this.output.once('close', closed);
      if (this.output.destroyed) closed();
    });
  }
  async run() {
    try {
      this.check();
      const response = await this.fetcher(this.url.toString(), {
        dispatcher: this.options.dispatcher, method: 'GET', headers: this.options.headers, signal: this.controller.signal,
      });
      if (response.body) {
        const body = response.body instanceof Readable ? Readable.toWeb(response.body) : response.body;
        this.reader = body.getReader();
        this.reader.closed.catch(() => { this.readerErrored = true; });
      }
      this.check(); // A replaced scope cannot accept late headers or content.
      if (!response.ok) throw this.errorForStatus(response.status);
      if (!this.reader) throw failure('NEXI_DOWNLOAD_MISSING_BODY');
      const length = response.headers?.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > this.maxBytes) throw failure('NEXI_DOWNLOAD_MAX_BYTES');
      this.output = new PassThrough({ highWaterMark: 64 * 1024 });
      this.output.on('error', () => {}); // Safe before the caller attaches its pipeline/iterator.
      this.output.on('close', () => {
        if (!this.bodyEnded) this.abort(failure('NEXI_DOWNLOAD_CONSUMER_CLOSED'));
      });
      this.resolve(this.output);
      let received = 0;
      while (true) {
        const { done, value } = await this.reader.read();
        this.check();
        if (done) break;
        received += value.byteLength;
        if (received > this.maxBytes) throw failure('NEXI_DOWNLOAD_MAX_BYTES');
        await this.write(Buffer.from(value));
      }
      this.bodyEnded = true;
      this.output.end();
    } catch (error) {
      this.abort(error);
    } finally {
      if (!this.bodyEnded) {
        // An uncooperative fetch/read/cancel keeps this slot occupied. No race,
        // no pretend completion, no queued replacement using the same capacity.
        try { await this.cancelReader(); } catch {
          if (!this.readerErrored) {
            // Web Streams closes pending reads even when the underlying cancel
            // rejects. That synthetic EOF does NOT prove network termination.
            // Retain the slot as uncertain; only process termination can resolve
            // a transport offering neither cancellation nor completion proof.
            this.cancellationUnconfirmed = true;
            clearTimeout(this.timer);
            return;
          }
        }
      }
      try { this.reader?.releaseLock(); } catch {}
      this.finish();
    }
  }
}

let defaultPool;
function pool() {
  return defaultPool ||= new DownloadPool({
    concurrency: setting('NEXI_DOWNLOAD_CONCURRENCY', 4, 1, 32),
    perScope: setting('NEXI_DOWNLOAD_PER_SOCKET', 2, 1, 8),
    maxQueued: setting('NEXI_DOWNLOAD_QUEUE_LIMIT', 64, 0, 1024),
    timeoutMs: setting('NEXI_DOWNLOAD_TIMEOUT_MS', 30000, 100, 120000),
    maxBytes: setting('NEXI_DOWNLOAD_MAX_BYTES', 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  });
}
function download(url, options = {}, { fetcher = globalThis.fetch, downloadPool = pool(),
  errorForStatus = status => Object.assign(failure('NEXI_DOWNLOAD_HTTP'), { status }) } = {}) {
  const operation = new Download(downloadPool, url, options, fetcher, errorForStatus);
  operation.scope?.operations.add(operation);
  operation.listen(options.signal);
  operation.listen(operation.scope?.controller.signal);
  try { operation.check(); } catch { return operation.result; }
  if (!operation.finished) downloadPool.enqueue(operation);
  return operation.result;
}

function createSocketTransport() {
  pool(); // Validate configuration before constructing a socket.
  const scope = { operations: new Set(), controller: new AbortController(), closed: false, current: () => true };
  scope.devices = new DeviceCache();
  scope.options = { [scopeOption]: scope };
  scope.close = () => {
    if (scope.closed) return;
    scope.closed = true;
    scope.devices.close();
    scope.controller.abort(failure('NEXI_DOWNLOAD_SESSION_FENCED'));
  };
  return scope;
}
function bindSocket(scope, socket) {
  if (!scope) return;
  if (scope.native && scope.native !== socket) throw failure('NEXI_DOWNLOAD_SCOPE_REBOUND');
  scope.native = socket;
  socket.registerSocketEndHandler(scope.close);
}
function activateSocket(scope, service, socket, current) {
  if (!scope.native || scope.socket && scope.socket !== socket || scope.closed || !current()) {
    scope.close();
    throw failure('NEXI_DOWNLOAD_SESSION_FENCED');
  }
  scope.socket = socket;
  socketScopes.set(socket, scope);
  const previous = serviceScopes.get(service);
  if (previous && previous !== scope) previous.close();
  serviceScopes.set(service, scope);
  scope.current = current;
}
function optionsFor(socket) {
  const scope = socketScopes.get(socket);
  let current = false;
  try { current = scope && !scope.closed && scope.current(); } catch {}
  if (!current) { scope?.close(); throw failure('NEXI_DOWNLOAD_SESSION_FENCED'); }
  return scope.options;
}
function assertSocket(socket) { optionsFor(socket); }
function terminalDownloadError(error) {
  return String(error?.code || '').startsWith('NEXI_DOWNLOAD_') || ['AbortError', 'TimeoutError'].includes(error?.name);
}
async function downloadMedia(socket, message, type, nativeDownload, logger) {
  const options = { ...optionsFor(socket), nexiDownloadLane: message?.key?.remoteJid };
  const result = await nativeDownload(message, type, { options }, { logger, reuploadRequest: async (...args) => {
    assertSocket(socket);
    const repaired = await socket.updateMediaMessage(...args);
    assertSocket(socket);
    return repaired;
  } });
  assertSocket(socket);
  return result;
}
function pipeDownload(input, output) {
  output.on('error', () => {});
  pipeline(input, output, () => {}); // Propagate source failure AND downstream cancellation.
  return output;
}
function buildProfilePictureQueryContent(type, tokenContent) {
  // MIT upstream WhiskeySockets/Baileys 731cd6b5d1991a16d0c65072fd3107c43968e4a9 (#2607).
  const picture = { tag: 'picture', attrs: { type, query: 'url' } };
  if (tokenContent?.length) picture.content = tokenContent;
  return [picture];
}
function downloadStats() {
  const current = pool();
  return { ...current.stats(), cancellationUnconfirmed: [...current.active].filter(operation => operation.cancellationUnconfirmed).length };
}
function deviceCacheEntries(deviceMap, jidEncode) {
  const entries = new Map();
  for (const devices of Object.values(deviceMap)) for (const device of devices) {
    const key = jidEncode(device.user, device.server);
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(device);
  }
  return [...entries].map(([key, value]) => ({ key, value }));
}
module.exports = { DownloadPool, download, createSocketTransport, bindSocket, activateSocket, optionsFor,
  pipeDownload, buildProfilePictureQueryContent, scopeOption, assertSocket, terminalDownloadError, downloadMedia, deviceCacheEntries, downloadStats };
