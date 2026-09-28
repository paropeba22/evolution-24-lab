import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const provider = process.env.EVOLUTION_PROVIDER || 'postgresql';
assert.ok(['postgresql', 'psql_bouncer', 'mysql'].includes(provider), 'unknown provider');
const schemaProvider = process.env.EVOLUTION_SCHEMA_PROVIDER || provider;
assert.ok(['postgresql', 'psql_bouncer', 'mysql'].includes(schemaProvider), 'unknown schema provider');
const prismaDir = process.env.EVOLUTION_PRISMA_DIR || '/evolution/prisma';
const bundlePath = process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js';
const schema = fs.readFileSync(path.join(prismaDir, `${schemaProvider}-schema.prisma`), 'utf8');
const generated = process.env.EVOLUTION_SKIP_GENERATED === '1'
  ? null
  : fs.readFileSync(path.join(prismaDir, 'generated/client/internal/class.ts'), 'utf8');
const bundle = fs.readFileSync(bundlePath, 'utf8');

function chatwootModel(text, label) {
  const matches = [...text.matchAll(/\bmodel Chatwoot \{([^}]*)\}/g)];
  assert.equal(matches.length, 1, `${label}: exactly one Chatwoot schema model`);
  assert.match(matches[0][1], /^\s*inboxId\s+String\?\s+@db\.VarChar\(32\)\s*$/m,
    `${label}: Chatwoot.inboxId must be a nullable VARCHAR(32)`);
}

function modelFromJsonParse(text, assignment, label) {
  const start = text.indexOf(assignment);
  assert.ok(start >= 0 && text.indexOf(assignment, start + 1) < 0, `${label}: one runtimeDataModel assignment`);
  let pos = start + assignment.length;
  const quote = text[pos];
  assert.ok(quote === '"' || quote === "'", `${label}: expected JS string literal`);
  const literalStart = pos++;
  while (pos < text.length) {
    if (text[pos] === '\\') {
      pos += 2;
    } else if (text[pos] === quote) {
      break;
    } else {
      pos++;
    }
  }
  assert.ok(pos < text.length && text[pos + 1] === ')', `${label}: complete JSON.parse argument`);
  const jsonText = vm.runInNewContext(text.slice(literalStart, pos + 1), Object.create(null));
  const model = JSON.parse(jsonText).models?.Chatwoot;
  assert.ok(model, `${label}: Chatwoot runtime model`);
  const fields = model.fields.filter(field => field.name === 'inboxId');
  assert.deepEqual(fields.map(field => ({ name: field.name, kind: field.kind, type: field.type })),
    [{ name: 'inboxId', kind: 'scalar', type: 'String' }], `${label}: Chatwoot.inboxId field`);
}

chatwootModel(schema, 'patched schema');
if (generated !== null) {
  assert.match(generated, new RegExp(`"activeProvider": "${provider}"`), 'generated client provider');
  const generatedInline = generated.match(/"inlineSchema": ("(?:\\.|[^"\\])*")/);
  assert.ok(generatedInline, 'generated client inlineSchema');
  chatwootModel(JSON.parse(generatedInline[1]), 'generated client inlineSchema');
  modelFromJsonParse(generated, 'config.runtimeDataModel = JSON.parse(', 'generated client');
}

assert.ok(bundle.includes(`activeProvider:"${provider}"`), 'compiled provider');
const inlineStart = bundle.indexOf('inlineSchema:`');
const inlineEnd = bundle.indexOf('`,runtimeDataModel:', inlineStart);
assert.ok(inlineStart >= 0 && inlineEnd > inlineStart, 'final dist inlineSchema boundary');
chatwootModel(bundle.slice(inlineStart + 'inlineSchema:`'.length, inlineEnd), 'final dist inlineSchema');
const runtimeAssignments = [...bundle.matchAll(/\.runtimeDataModel=JSON\.parse\(/g)];
assert.equal(runtimeAssignments.length, 1, 'final dist: one runtimeDataModel assignment');
modelFromJsonParse(bundle, '.runtimeDataModel=JSON.parse(', 'final dist');

const field = 'nameInbox:t.nameInbox,inboxId:t.inboxId,signMsg';
assert.equal(bundle.split(field).length - 1, 3, 'three Chatwoot write/readback projections');
assert.match(bundle, /prismaRepository\.chatwoot\.update\(\{where:\{instanceId:this\.instanceId\},data:\{[^}]*nameInbox:t\.nameInbox,inboxId:t\.inboxId,signMsg/,
  'Chatwoot update persists inboxId');
assert.match(bundle, /prismaRepository\.chatwoot\.create\(\{data:\{[^}]*nameInbox:t\.nameInbox,inboxId:t\.inboxId,signMsg/,
  'Chatwoot create persists inboxId');
assert.match(bundle, /return\{enabled:t\?\.enabled,[^}]*nameInbox:t\.nameInbox,inboxId:t\.inboxId,signMsg/,
  'findChatwoot readback returns inboxId');
assert.match(bundle, /chatwoot_inbox_id_required/, 'managed instances require stable ID');
assert.match(bundle, /resolveConfiguredInbox\(s\.payload,this\.provider,t\.instanceName\)/,
  'stable Inbox resolver remains active');

console.log(`[evolution-24-lab] ${schemaProvider}/${provider}: schema, generated client, final dist model and Chatwoot paths verified`);
