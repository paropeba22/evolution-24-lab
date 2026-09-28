'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('runtime model assertion rejects a bundle missing Chatwoot.inboxId',
  { skip: !process.env.EVOLUTION_BUNDLE_PATH || !process.env.EVOLUTION_PRISMA_DIR },
  () => {
    const source = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
    const start = source.indexOf('.runtimeDataModel=JSON.parse(');
    assert.ok(start >= 0);
    const field = '"name":"inboxId","kind":"scalar","type":"String"';
    const fieldAt = source.indexOf(field, start);
    assert.ok(fieldAt > start && fieldAt < source.indexOf("')", start));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-model-test-'));
    try {
      const bundlePath = path.join(directory, 'main.js');
      fs.writeFileSync(bundlePath, source.slice(0, fieldAt) +
        source.slice(fieldAt).replace(field, '"name":"removedInboxId","kind":"scalar","type":"String"'));
      const result = spawnSync(process.execPath, [path.join(__dirname, 'assert-runtime-model.mjs')], {
        env: { ...process.env, EVOLUTION_BUNDLE_PATH: bundlePath }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /final dist: Chatwoot\.inboxId field/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

test('startup selector chooses the configured provider and rejects unknown providers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-selector-test-'));
  try {
    const distDir = path.join(directory, 'dist');
    fs.mkdirSync(path.join(distDir, 'providers'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'prisma.config.ts'), path.join(directory, 'prisma.config.ts'));
    for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
      fs.writeFileSync(path.join(distDir, 'providers', `${provider}.js`),
        provider === 'psql_bouncer' ? 'postgresql' : provider);
    }
    for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
        env: { ...process.env, EVOLUTION_DIST_DIR: distDir, DATABASE_PROVIDER: provider }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(distDir, 'main.js'), 'utf8'),
        provider === 'psql_bouncer' ? 'postgresql' : provider);
    }
    fs.writeFileSync(path.join(directory, '.env'), 'DATABASE_PROVIDER=mysql\n');
    const missingEnv = { ...process.env, EVOLUTION_DIST_DIR: distDir };
    delete missingEnv.DATABASE_PROVIDER;
    const missing = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
      env: missingEnv, encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /DATABASE_PROVIDER must be/);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
      env: { ...process.env, EVOLUTION_DIST_DIR: distDir, DATABASE_PROVIDER: 'sqlite' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DATABASE_PROVIDER must be/);
    fs.unlinkSync(path.join(directory, 'prisma.config.ts'));
    const missingConfig = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
      env: { ...process.env, EVOLUTION_DIST_DIR: distDir, DATABASE_PROVIDER: 'postgresql' }, encoding: 'utf8',
    });
    assert.notEqual(missingConfig.status, 0);
    assert.match(missingConfig.stderr, /Missing \/evolution\/prisma\.config\.ts/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('final Docker stage restores Prisma config and selects the provider before startup', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  assert.match(finalStage, /^COPY prisma\.config\.ts \/evolution\/prisma\.config\.ts$/m);
  assert.ok(finalStage.indexOf('COPY prisma.config.ts /evolution/prisma.config.ts') <
    finalStage.indexOf('RUN set -eu;'));
  assert.match(finalStage, /^COPY --from=source-builder \/evolution\/prisma \/evolution\/prisma$/m);
  assert.match(finalStage, /^COPY select-provider-bundle\.cjs \/evolution\/select-provider-bundle\.cjs$/m);
  for (const file of ['prisma.config.ts', 'prisma/postgresql-schema.prisma',
    'prisma/psql_bouncer-schema.prisma', 'prisma/mysql-schema.prisma',
    'select-provider-bundle.cjs', 'Docker/scripts/deploy_database.sh', 'runWithProvider.js']) {
    assert.ok(finalStage.includes(`test -f /evolution/${file};`), `final image must verify ${file}`);
  }
  const entrypoints = [...finalStage.matchAll(/^ENTRYPOINT (.+)$/gm)];
  assert.equal(entrypoints.length, 1);
  const entrypoint = JSON.parse(entrypoints[0][1]);
  assert.deepEqual(entrypoint.slice(0, 2), ['/bin/bash', '-c']);
  assert.deepEqual(entrypoint[2].split(' && '), [
    'node /evolution/select-provider-bundle.cjs',
    '. ./Docker/scripts/deploy_database.sh',
    'npm run start:prod',
  ]);
  const prismaConfig = fs.readFileSync(path.join(__dirname, 'prisma.config.ts'), 'utf8');
  assert.match(prismaConfig, /url: env\('DATABASE_CONNECTION_URI'\)/);
  assert.match(prismaConfig, /process\.env\.DATABASE_PROVIDER/);
});
