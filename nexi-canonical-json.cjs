'use strict';
const { createHash } = require('node:crypto');
const VERSION = 'canonical_json_v1';
const invalid = () => { throw Object.assign(new Error('nexi_attendance_noncanonical_material'), { code: 'nexi_attendance_noncanonical_material' }); };
function quote(value) {
  let result = '"';
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) invalid(); // No lone UTF-16 surrogate.
    const short = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' }[point];
    result += short || (point < 32 ? '\\u' + point.toString(16).padStart(4, '0') : character);
  }
  return result + '"';
}
function bytes(value, version = VERSION) {
  if (version !== VERSION) throw Object.assign(new Error('nexi_attendance_canonical_version_unsupported'),
    { code: 'nexi_attendance_canonical_version_unsupported' });
  const active = new WeakSet();
  function encode(item, depth) {
    if (depth > 64) invalid();
    if (item === null) return 'null';
    if (typeof item === 'string') return quote(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') { if (!Number.isSafeInteger(item)) invalid(); return String(item === 0 ? 0 : item); }
    if (!item || typeof item !== 'object' || active.has(item)) invalid();
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) invalid();
        return '[' + Array.from({ length: item.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !('value' in property)) invalid();
          return encode(property.value, depth + 1);
        }).join(',') + ']';
      }
      if (Object.getPrototypeOf(item) !== Object.prototype || Reflect.ownKeys(item).length !== Object.keys(item).length) invalid();
      const keys = Object.keys(item);
      for (const key of keys) quote(key); // Validate before the UTF-8 comparator.
      keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
      return '{' + keys.map(key => {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property.enumerable || !('value' in property)) invalid();
        return quote(key) + ':' + encode(property.value, depth + 1);
      }).join(',') + '}';
    } finally { active.delete(item); }
  }
  // Strings here contain only validated Unicode scalar values. No ordinary
  // object enumeration participates in the canonical byte representation.
  return encode(value, 0);
}
function parse(text) {
  const value = JSON.parse(text);
  // Signed canonical envelopes must already be exact canonical bytes. Duplicate
  // keys, fractional/exponent lexemes and noncanonical escapes cannot be hidden
  // by JSON.parse's last-key-wins or numeric coercion.
  if (bytes(value) !== text) invalid();
  return value;
}
module.exports = { VERSION, bytes, parse, digest: value => createHash('sha256').update(bytes(value), 'utf8').digest('hex') };
