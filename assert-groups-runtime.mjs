import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const provider = process.env.EVOLUTION_SCHEMA_PROVIDER || process.env.EVOLUTION_PROVIDER || 'postgresql';
const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js', 'utf8');
const schema = fs.readFileSync(path.join(process.env.EVOLUTION_PRISMA_DIR || '/evolution/prisma', `${provider}-schema.prisma`), 'utf8');
for (const name of ['NexiGroupControl', 'NexiGroupEventOutbox']) assert.equal(schema.split(`model ${name} {`).length, 2);
const marker = '.runtimeDataModel=JSON.parse(';
const start = bundle.indexOf(marker);
assert.ok(start >= 0 && bundle.indexOf(marker, start + 1) < 0);
let pos = start + marker.length;
const quote = bundle[pos], begin = pos++;
assert.ok(quote === '"' || quote === "'");
while (pos < bundle.length) {
  if (bundle[pos] === '\\') pos += 2;
  else if (bundle[pos] === quote) break;
  else pos++;
}
assert.equal(bundle[pos + 1], ')');
const models = JSON.parse(vm.runInNewContext(bundle.slice(begin, pos + 1), Object.create(null))).models;
const required = {
  Instance: ['nexiGroupsSocketOwner'],
  NexiGroupControl: ['instanceId', 'accountId', 'managedChannelId', 'generation', 'revision', 'sessionIdentity', 'nonce', 'rooms'],
  NexiGroupEventOutbox: ['id', 'instanceId', 'eventId', 'sourceKey', 'sourceSession', 'sourceGeneration', 'legacyGeneration',
    'fingerprint', 'payload', 'state', 'leaseToken', 'leaseUntil', 'nextAttemptAt'],
};
for (const [name, fields] of Object.entries(required)) {
  assert.ok(models[name], `compiled ${name} missing`);
  for (const field of fields) assert.ok(models[name].fields.some(f => f.name === field), `${name}.${field} missing`);
}
for (const gate of ['interceptEvents(this,', 'installRoutes(', 'nexi_groups_outbound_disabled_wave1', 'nexi-groups.cjs']) {
  assert.ok(bundle.includes(gate), `compiled Groups gate missing: ${gate}`);
}
for (const file of ['session_record.js', 'session_cipher.js', 'session_builder.js', 'queue_job.js', 'curve.js']) {
  const source = fs.readFileSync(path.join(process.env.EVOLUTION_SIGNAL_DIR || '/evolution/node_modules/libsignal/src', file), 'utf8');
  assert.ok(source.includes("require('/evolution/nexi-groups.cjs').signalDiagnostic("), `Signal privacy routing missing: ${file}`);
  assert.doesNotMatch(source, /^\s*console\.(info|warn|error)\(/m, `raw Signal diagnostic remains: ${file}`);
  if (file === 'queue_job.js') assert.ok(source.includes('.bindSignalJob(awaitable)'), 'Signal queued job scope missing');
}
console.log(`Groups Wave 1 ${provider}: compiled authority, outbox and routing gates verified`);
