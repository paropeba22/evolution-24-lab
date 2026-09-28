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
    fs.mkdirSync(path.join(directory, 'providers'));
    for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
      fs.writeFileSync(path.join(directory, 'providers', `${provider}.js`), provider);
    }
    for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
        env: { ...process.env, EVOLUTION_DIST_DIR: directory, DATABASE_PROVIDER: provider }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(directory, 'main.js'), 'utf8'), provider);
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'select-provider-bundle.cjs')], {
      env: { ...process.env, EVOLUTION_DIST_DIR: directory, DATABASE_PROVIDER: 'sqlite' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
