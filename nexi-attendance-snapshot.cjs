'use strict';
const { createHash } = require('node:crypto');
// Local transport limits, not receipt-queue defaults or APP authority contracts.
// Uploaded media is represented by protobuf metadata, not a file/stream here.
const LIMITS = Object.freeze({ depth: 64, nodes: 65536, bytes: 16 * 1024 * 1024 });
const registries = new WeakMap(), privateGraphs = new WeakSet();
function invalid(reason) {
  throw Object.assign(new Error('nexi_attendance_snapshot_' + reason), { code: 'nexi_attendance_snapshot_' + reason });
}
function registry(proto, longPrototype) {
  if (!proto) return new Set();
  if (registries.has(proto)) return registries.get(proto);
  const allowed = new Set(), seen = new WeakSet();
  function visit(value, depth) {
    if (!value || !['object', 'function'].includes(typeof value) || seen.has(value) || depth > 16) return;
    seen.add(value);
    if (typeof value === 'function' && typeof value.encode === 'function' && typeof value.decode === 'function')
      allowed.add(value.prototype); // Exact installed generated protobuf constructors only.
    for (const property of Object.values(Object.getOwnPropertyDescriptors(value)))
      if ('value' in property) visit(property.value, depth + 1);
  }
  visit(proto, 0);
  if (longPrototype) allowed.add(longPrototype);
  registries.set(proto, allowed);
  return allowed;
}
function copy(value, allowed = new Set(), immutable = true) {
  const active = new WeakSet(); let nodes = 0, bytes = 0;
  function charge(size = 0) {
    if (++nodes > LIMITS.nodes || (bytes += size) > LIMITS.bytes) invalid('limit');
  }
  function clone(item, depth) {
    if (depth > LIMITS.depth) invalid('depth');
    if (typeof item === 'string') { charge(Buffer.byteLength(item)); return item; }
    charge(8);
    if (item === null || item === undefined || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid('number'); return item; }
    if (!item || typeof item !== 'object') invalid('type');
    if (Buffer.isBuffer(item) || Object.getPrototypeOf(item) === Uint8Array.prototype) {
      charge(item.byteLength); return Buffer.from(item); // Isolated bytes; never freeze a nonempty typed array.
    }
    if (active.has(item)) invalid('cycle');
    const prototype = Object.getPrototypeOf(item), array = Array.isArray(item);
    if (array && item.length > LIMITS.nodes) invalid('limit');
    if (array ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null && !allowed.has(prototype) && !privateGraphs.has(item)) invalid('prototype');
    active.add(item);
    try {
      // Preserve a trusted Long's methods/low/high/unsigned for protobuf encoders.
      const long = !array && allowed.has(prototype) && ['low', 'high', 'unsigned'].every(key => Object.hasOwn(item, key));
      const result = array ? [] : Object.create(long ? prototype : Object.prototype);
      for (const key of Reflect.ownKeys(item)) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || (array && !/^(0|[1-9]\d*)$/.test(key))) invalid('key');
        charge(Buffer.byteLength(key));
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property.enumerable || (!('value' in property) && !privateGraphs.has(item))) invalid('accessor');
        const child = clone('value' in property ? property.value : item[key], depth + 1);
        if (immutable && Buffer.isBuffer(child)) {
          // Closure owns bytes. Even a trusted hook/logger obtaining a view gets
          // a fresh copy; the next encoder read cannot observe its mutation.
          Object.defineProperty(result, key, { enumerable: true, get: () => Buffer.from(child) });
        } else Object.defineProperty(result, key, { enumerable: true, value: child, writable: !immutable, configurable: !immutable });
      }
      if (array) result.length = item.length; // Preserve undefined slots/array semantics.
      if (immutable) { privateGraphs.add(result); Object.freeze(result); }
      return result;
    } finally { active.delete(item); }
  }
  return clone(value, 0);
}
function fingerprint(value) {
  // Evolution-local semantic identity only; canonical_json_v1 is unchanged.
  const hash = createHash('sha256');
  function walk(item) {
    if (item === undefined) { hash.update('u;'); return; }
    if (item === null) { hash.update('n;'); return; }
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) { hash.update('b' + item.length + ':').update(item); return; }
    if (typeof item === 'number') { const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(item); hash.update('number:').update(bytes); return; }
    if (typeof item !== 'object') { const text = String(item); hash.update(typeof item + ':' + Buffer.byteLength(text) + ':' + text); return; }
    hash.update(Array.isArray(item) ? '[' + item.length + ':' : '{');
    for (const key of Object.keys(item).sort()) { hash.update(Buffer.byteLength(key) + ':' + key); walk(item[key]); }
    hash.update('};');
  }
  walk(value); return hash.digest('hex');
}
module.exports = { copy, registry, fingerprint, LIMITS };
