'use strict';

// Protocol cache only. Never an identity attestation, PN/LID resolver or writer grant.
class DeviceCache {
  constructor({ ttlSeconds = 300, maxKeys = 4096, maxDevices = 32768, maxPerKey = 1024, maxBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
    for (const value of [ttlSeconds, maxKeys, maxDevices, maxPerKey, maxBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('nexi_device_cache_limits');
    }
    this.ttlSeconds = ttlSeconds;
    this.maxKeys = maxKeys;
    this.maxDevices = maxDevices;
    this.maxPerKey = maxPerKey;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.now = now;
    this.entries = new Map();
    this.devices = 0;
    this.generation = 0;
    this.closed = false;
  }

  revision() { return this.generation; }
  bump() { this.generation++; }
  drop(key) {
    const entry = this.entries.get(key);
    if (entry) { this.devices -= entry.value.length; this.bytes -= entry.bytes; }
    this.entries.delete(key);
  }
  get(key) {
    if (this.closed) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires !== null && entry.expires <= this.now()) { this.drop(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  mget(keys) {
    const result = Object.create(null);
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  has(key) { return this.get(key) !== undefined; }
  validate(key, value, ttl = this.ttlSeconds) {
    // Keys are actual normalized JIDs supplied by Baileys, including the domain.
    // Device descriptors are retained verbatim, never derived from cache keys.
    if (typeof key !== 'string' || key.length > 256 || !key.includes('@') ||
        !Number.isFinite(ttl) || ttl < 0) throw new TypeError('nexi_device_cache_entry');
    if (!Array.isArray(value) || value.length > this.maxPerKey || value.some(device =>
      !device || typeof device.user !== 'string' || typeof device.server !== 'string' ||
      device.user.length > 128 || device.server.length > 128 || key !== `${device.user}@${device.server}` || !Number.isSafeInteger(device.device) || device.device < 0)) {
      return null; // Unsupported/oversized protocol data remains a cache miss, not a partial list.
    }
    const copy = structuredClone(value);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > 256 * 1024 || bytes > this.maxBytes) return null;
    return { value: copy, bytes, expires: ttl === 0 ? null : this.now() + ttl * 1000 };
  }
  put(key, entry) {
    this.drop(key);
    if (!entry || this.closed) return;
    while (this.entries.size >= this.maxKeys || this.devices + entry.value.length > this.maxDevices ||
      this.bytes + entry.bytes > this.maxBytes) {
      const first = this.entries.keys().next();
      if (first.done) return;
      this.drop(first.value);
    }
    this.entries.set(key, entry);
    this.devices += entry.value.length;
    this.bytes += entry.bytes;
  }
  set(key, value, ttl) {
    const entry = this.validate(key, value, ttl);
    this.bump();
    this.put(key, entry);
    return !this.closed && this.entries.has(key);
  }
  prepare(items) {
    return items.map(item => {
      const hasValue = Object.hasOwn(item, 'value'), hasVal = Object.hasOwn(item, 'val');
      if (!hasValue && !hasVal || hasValue && hasVal && JSON.stringify(item.value) !== JSON.stringify(item.val)) {
        throw new TypeError('nexi_device_cache_batch_shape');
      }
      return [item.key, this.validate(item.key, hasValue ? item.value : item.val, item.ttl)];
    });
  }
  mset(items) {
    const entries = this.prepare(items); // Validate the complete batch before changing cache state.
    this.bump();
    for (const [key, entry] of entries) this.put(key, entry);
    return !this.closed && entries.every(([key, entry]) => entry && this.entries.has(key));
  }
  msetIfRevision(revision, items) {
    if (this.closed || revision !== this.generation) return false;
    return this.mset(items);
  }
  del(keys) {
    let count = 0;
    this.bump(); // Missing-key invalidation must also fence in-flight USync writes.
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.entries.has(key)) count++;
      this.drop(key);
    }
    return count;
  }
  flushAll() { this.bump(); this.entries.clear(); this.devices = 0; this.bytes = 0; }
  close() { this.closed = true; this.flushAll(); }
}

module.exports = { DeviceCache };
