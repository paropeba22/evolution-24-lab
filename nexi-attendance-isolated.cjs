'use strict';

// This is a restriction on the existing signed prepare/grant/CAS protocol, not
// a second sender. A bare token is never authority: callers must first verify
// its containing APP envelope (or the immutable row produced from that envelope).
const canonical = require('./nexi-canonical-json.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PROTOCOL = 'attendance-single-operation-v1';
const COMPOSER_PROTOCOL = 'attendance-composer-operation-v2';
const UUID_KEYS = ['authorization_id','execution_id','request_id','instance_id','instance_lineage_id','sender_account_lineage_id'];
const INTEGER_KEYS = ['account_id','managed_channel_id','inbox_id','conversation_id','actor_id','contact_id','contact_inbox_id',
  'identity_slot_id','identity_version_id','identity_generation','writer_epoch','binding_generation'];
const HASH_KEYS = ['session_identity','recipient_digest','manifest_digest','payload_digest'];
const KEYS = [...UUID_KEYS,...INTEGER_KEYS,...HASH_KEYS,'protocol','message_id','approved_at','expires_at'];
function fail() { throw Object.assign(new Error('nexi_attendance_isolated_authority_invalid'), {code:'nexi_attendance_isolated_authority_invalid'}); }
function enabled(env = process.env) {
  return env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED === 'true' && env.NEXI_ATTENDANCE_CUTOVER_HOLD === 'true' &&
    require('./nexi-attendance.cjs').cutoverHeld(env);
}
function composerEnabled(env = process.env) {
  return enabled(env) && env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED === 'true';
}
function validate(token, now = Date.now(), {probe = false} = {}) {
  if (!token || typeof token !== 'object' || Array.isArray(token) || Object.keys(token).sort().join(',') !== [...KEYS].sort().join(',') ||
      ![PROTOCOL,COMPOSER_PROTOCOL].includes(token.protocol) || !UUID_KEYS.every(key => UUID.test(token[key] || '')) ||
      !INTEGER_KEYS.every(key => Number.isSafeInteger(token[key]) && token[key] > 0) ||
      !HASH_KEYS.every(key => HASH.test(token[key] || '')) ||
      !(probe ? token.message_id === null : Number.isSafeInteger(token.message_id) && token.message_id > 0) ||
      !Number.isSafeInteger(token.approved_at) || !Number.isSafeInteger(token.expires_at) || token.approved_at <= 0 ||
      token.approved_at > now || token.expires_at <= now || token.expires_at <= token.approved_at ||
      token.expires_at - token.approved_at > 300000) fail();
  return token;
}
function context(source, value, token, now, options = {}) {
  validate(token, now, options);
  if ((!options.history && (!enabled() || token.protocol === COMPOSER_PROTOCOL && !composerEnabled())) ||
      source.instanceId !== token.instance_id || value.instance_id !== token.instance_id ||
      source.instance.name !== value.instance || !['account_id','managed_channel_id','inbox_id','session_identity','writer_epoch',
        'binding_generation','instance_lineage_id','sender_account_lineage_id'].every(key => value[key] === token[key])) fail();
  return token;
}
function intent(source, value, data, now = Date.now(), options = {}) {
  const token = context(source, value, value.isolated_operation, now, options);
  if (value.physical_dispatch !== true || data.execution_id !== token.execution_id || data.transport_unit !== 0 || data.identity_version_id !== token.identity_version_id ||
      canonical.digest({recipient:data.recipient}) !== token.recipient_digest || data.payload_digest !== token.payload_digest ||
      canonical.digest(data.payload) !== token.payload_digest || canonical.digest({units:[data.payload]}) !== token.manifest_digest ||
      data.payload?.kind !== 'text' || typeof data.payload.body !== 'string' || data.payload.body.length === 0 || data.payload.reply_to !== null) fail();
  return token;
}
function grant(source, row, material, now = Date.now(), options = {}) {
  const token = intent(source, row.authority, row.intent, now, options), g = material.grant;
  if (canonical.digest(g.isolated_operation) !== canonical.digest(token) || g.execution_id !== token.execution_id ||
      g.message_id !== token.message_id || g.transport_unit_index !== 0 || g.expires_at > token.expires_at ||
      material.release.deadline > token.expires_at || g.scope !== 'attendance_dispatch_v1' || g.physical_dispatch !== true) fail();
  return token;
}
module.exports = {PROTOCOL,COMPOSER_PROTOCOL,KEYS,UUID_KEYS,INTEGER_KEYS,HASH_KEYS,enabled,composerEnabled,validate,context,intent,grant};
