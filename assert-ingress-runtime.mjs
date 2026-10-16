// Read files only. No application boot, database, Redis or HTTP request.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function assertChatwootSDK(root) {
  const sdk = path.join(root, 'node_modules/@figuro/chatwoot-sdk');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'))).version, '1.1.17');
  const axiosRoot = path.join(sdk, 'node_modules/axios');
  assert.equal(JSON.parse(fs.readFileSync(path.join(axiosRoot, 'package.json'))).version, '0.27.2');
  const relative = path.relative(fs.realpathSync(axiosRoot), fs.realpathSync(
    createRequire(path.join(sdk, 'dist/core/request.js')).resolve('axios')));
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'SDK must resolve its pinned nested Axios');
  // request.js hash is the accepted 1.1.17 request after patch-chatwoot-completion.
  const hashes = {
    'dist/core/request.js': '1f2e75176c16ca52a4bcef934ba188c4d4ecaacf536f7f670362b39134b0b669',
    'dist/core/CancelablePromise.js': 'c049e0921d4f9b65b1efd8175edbdd3920ae22791fa1497a6f97f07e910248b3',
    'dist/services/Messages.js': '57b9f7157b9ef06c8762c1749b975e6a1fb1b2eca2bc005fefa63bf77b4559dc',
  };
  for (const [file, expected] of Object.entries(hashes)) {
    const source = fs.readFileSync(path.join(sdk, file), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, `shipped SDK changed: ${file}`);
  }
}

export function assertIngressSchema(schema, label) {
  const models = {
    NexiIngressScope: ['secondaryPending'],
    NexiIngressLane: ['sessionIdentity', 'leaseToken', 'leaseUntil'],
    NexiIngressJournal: ['dedupKey', 'envelope', 'payload', 'mainMaterializedAt', 'payloadPrunedAt'],
    NexiIngressEffectLane: ['leaseToken', 'blockedBy'],
    NexiIngressEffect: ['intentDigest', 'intentSignature', 'conversationLaneId', 'contractVersion'],
    NexiIngressContactCache: ['scopeId', 'sessionIdentity', 'pnJid', 'lidJid', 'expiresAt'],
  };
  for (const [name, fields] of Object.entries(models)) {
    const matches = [...schema.matchAll(new RegExp(`\\bmodel ${name} \\{([^}]*)\\}`, 'g'))];
    assert.equal(matches.length, 1, `${label}: ${name} must exist once in Prisma schema`);
    for (const field of fields) assert.match(matches[0][1], new RegExp(`^\\s*${field}\\s+\\S+`, 'm'), `${label}: ${name}.${field}`);
  }
}

export function assertIngressRuntime(root) {
  assertChatwootSDK(root);
  const helpers = ['nexi-ingress.cjs', 'nexi-ingress-effects.cjs', 'nexi-ingress-dispatch.cjs'];
  for (const file of helpers) assert.ok(fs.statSync(path.join(root, file)).isFile(), `missing ingress helper: ${file}`);
  // Effects is a transitive CJS dependency, not a direct provider import.
  for (const file of ['nexi-ingress.cjs', 'nexi-ingress-dispatch.cjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /require\(['"]\.\/nexi-ingress-effects\.cjs['"]\)/, `${file}: effects dependency missing`);
    assert.equal(fs.realpathSync(createRequire(path.join(root, file)).resolve('./nexi-ingress-effects.cjs')),
      fs.realpathSync(path.join(root, 'nexi-ingress-effects.cjs')));
  }
  for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
    const bundle = fs.readFileSync(path.join(root, 'dist/providers', `${provider}.js`), 'utf8');
    for (const helper of ['nexi-ingress.cjs', 'nexi-ingress-dispatch.cjs']) {
      const escaped = helper.replaceAll('.', '\\.');
      assert.match(bundle, new RegExp(`require\\(["']/evolution/${escaped}["']\\)`), `${provider}: ingress helper must remain external: ${helper}`);
    }
    assert.match(bundle, /require\(['"]@figuro\/chatwoot-sdk(?:\/[^'"]+)?['"]\)/, `${provider}: SDK must remain external`);
    const start = bundle.indexOf('inlineSchema:`'), end = bundle.indexOf('`,runtimeDataModel:', start);
    assert.ok(start >= 0 && end > start, `${provider}: Prisma inline schema missing`);
    const schema = bundle.slice(start + 'inlineSchema:`'.length, end);
    assertIngressSchema(schema, provider);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertIngressRuntime(path.resolve(process.argv[2] || '/evolution'));
  console.log('PASS: shipped ingress helpers/models and instrumented SDK/Axios verified for all providers');
}
