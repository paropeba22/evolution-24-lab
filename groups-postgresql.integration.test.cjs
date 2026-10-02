'use strict';

// Opt-in isolated PostgreSQL gate. Never uses production DATABASE_CONNECTION_URI.
// Requires an existing pg driver and NEXI_GROUPS_PG_TEST_URL for a disposable DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const groups = require('./nexi-groups.cjs');

test('real PostgreSQL: independent connections, stale claim, process-death lease, ACK race and negative constraints',
  { skip: !process.env.NEXI_GROUPS_PG_TEST_URL }, async () => {
    const { Client } = require(require.resolve('pg', { paths: [__dirname, process.env.NEXI_GROUPS_PG_DRIVER_PATH || __dirname] }));
    const a = new Client({ connectionString: process.env.NEXI_GROUPS_PG_TEST_URL });
    const b = new Client({ connectionString: process.env.NEXI_GROUPS_PG_TEST_URL });
    await Promise.all([a.connect(), b.connect()]);
    const schema = 'nexi_groups_test_' + randomUUID().replaceAll('-', '');
    const previous = process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
    process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = 'synthetic-postgresql-test-secret-at-least-32';
    try {
      await a.query(`CREATE SCHEMA "${schema}"`);
      await Promise.all([a.query(`SET search_path TO "${schema}"`), b.query(`SET search_path TO "${schema}"`)]);
      await a.query('CREATE TABLE "Instance" (id VARCHAR(100) PRIMARY KEY)');
      for (const migration of ['20261002000000_nexi_groups_wave1', '20261002000001_harden_groups_wave1']) {
        await a.query(fs.readFileSync(path.join(__dirname, 'prisma/postgresql-migrations', migration, 'migration.sql'), 'utf8'));
      }
      await a.query('INSERT INTO "Instance" (id) VALUES ($1)', ['synthetic-instance']);
      const control = 'INSERT INTO "NexiGroupControl" ("instanceId","accountId","managedChannelId",generation,revision,"sessionIdentity",nonce,state,rooms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)';
      await a.query(control, ['synthetic-instance', '4', '8', 2, 0, 'a'.repeat(64), 'b'.repeat(64), 'active', '{}']);
      const legacyIds = [randomUUID(), randomUUID()];
      const legacyInsert = `INSERT INTO "NexiGroupEventOutbox" ("instanceId","eventId","sourceKey",fingerprint,payload,state)
        VALUES ('synthetic-instance',$1,$2,$3,$4,'delivered')`;
      await a.query(legacyInsert, [legacyIds[0], '1'.repeat(64), '2'.repeat(64),
        { data: { session_identity: 'a'.repeat(64), binding_generation: 2 } }]);
      await a.query(legacyInsert, [legacyIds[1], '3'.repeat(64), '4'.repeat(64), {}]);
      await a.query(fs.readFileSync(path.join(__dirname,
        'prisma/postgresql-migrations/20261002000002_namespace_groups_source/migration.sql'), 'utf8'));
      const migrated = (await a.query('SELECT * FROM "NexiGroupEventOutbox" ORDER BY id')).rows;
      assert.equal(migrated[0].sourceSession, 'a'.repeat(64)); assert.equal(migrated[0].sourceGeneration, 2);
      assert.equal(migrated[1].sourceSession, null); assert.equal(migrated[1].legacyGeneration, 2);
      assert.deepEqual(migrated.map(row => row.eventId), legacyIds);
      assert.deepEqual(migrated.map(row => row.sourceKey), ['1'.repeat(64), '3'.repeat(64)]);
      // Independent socket owners: a write prepared by A cannot change B's
      // status after B replaces the registered owner token.
      const tokenA = randomUUID(), tokenB = randomUUID();
      await a.query('UPDATE "Instance" SET "nexiGroupsSocketOwner"=$1 WHERE id=$2', [tokenA, 'synthetic-instance']);
      assert.equal((await b.query('UPDATE "Instance" SET "nexiGroupsSocketOwner"=$1 WHERE id=$2 AND "nexiGroupsSocketOwner"=$3',
        [tokenB, 'synthetic-instance', tokenA])).rowCount, 1);
      assert.equal((await a.query('UPDATE "Instance" SET "nexiGroupsSocketOwner"=$1 WHERE id=$2 AND "nexiGroupsSocketOwner"=$3',
        [randomUUID(), 'synthetic-instance', tokenA])).rowCount, 0);
      for (const [generation, revision, state] of [[0, 0, 'active'], [-1, 0, 'active'], [1, -1, 'active'], [1, 0, 'invalid']]) {
        await assert.rejects(a.query(control, ['synthetic-instance', '4', '8', generation, revision, 'a'.repeat(64), 'b'.repeat(64), state, '{}']),
          error => error.code === '23514');
      }
      const payload = { event: 'group.session.proved', instance: 'nexi-wa-synthetic', data: { version: 1, account_id: 4,
        managed_channel_id: 8, binding_generation: 2, session_identity: 'a'.repeat(64), nonce: 'b'.repeat(64) } };
      const inserted = await a.query(`INSERT INTO "NexiGroupEventOutbox" ("instanceId","eventId","sourceKey",fingerprint,payload,state,"nextAttemptAt","sourceSession","sourceGeneration")
        VALUES ($1,$2,$3,$4,$5,'queued',CURRENT_TIMESTAMP,'${'a'.repeat(64)}',2) RETURNING *`,
      ['synthetic-instance', randomUUID(), 'c'.repeat(64), 'd'.repeat(64), payload]);
      const id = inserted.rows[0].id;
      for (const [sourceSession, sourceGeneration, legacyGeneration] of [
        ['a'.repeat(64), 0, null], ['a'.repeat(63), 1, null], [null, 1, 2], [null, null, 0], [null, null, null],
      ]) {
        await assert.rejects(a.query('UPDATE "NexiGroupEventOutbox" SET "sourceSession"=$1,"sourceGeneration"=$2,"legacyGeneration"=$3 WHERE id=$4',
          [sourceSession, sourceGeneration, legacyGeneration, id]), e => e.code === '23514');
      }
      for (const values of [{ attempts: -1 }, { state: 'invalid' }]) {
        const [column, value] = Object.entries(values)[0];
        await assert.rejects(a.query(`UPDATE "NexiGroupEventOutbox" SET "${column}"=$1 WHERE id=$2`, [value, id]), e => e.code === '23514');
      }
      const query = client => {
        const compile = (where, params) => Object.entries(where).map(([key, value]) => {
          if (key === 'AND' || key === 'OR') return '(' + value.map(child => compile(child, params)).join(` ${key} `) + ')';
          assert.ok(['id', 'instanceId', 'state', 'leaseUntil', 'leaseToken', 'nextAttemptAt', 'createdAt', 'attempts'].includes(key));
          if (value === null) return `"${key}" IS NULL`;
          if (typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).map(([op, bound]) => {
            params.push(bound); return `"${key}" ${{ lt: '<', lte: '<=', gt: '>', gte: '>=' }[op]} $${params.length}`;
          }).join(' AND ');
          params.push(value); return `"${key}"=$${params.length}`;
        }).join(' AND ');
        return {
          async findFirst({ where }) {
            const params = [], clause = compile(where, params);
            return (await client.query(`SELECT * FROM "NexiGroupEventOutbox" WHERE ${clause} ORDER BY id LIMIT 1`, params)).rows[0] || null;
          },
          async updateMany({ where, data }) {
            const params = [], clause = compile(where, params);
            const changes = Object.entries(data).map(([key, value]) => {
              if (value?.increment) { params.push(value.increment); return `"${key}"="${key}"+$${params.length}`; }
              params.push(key === 'payload' ? JSON.stringify(value) : value); return `"${key}"=$${params.length}`;
            });
            return { count: (await client.query(`UPDATE "NexiGroupEventOutbox" SET ${changes.join(',')} WHERE ${clause}`, params)).rowCount };
          },
        };
      };
      const service = db => ({ instanceId: 'synthetic-instance', instance: { name: 'nexi-wa-synthetic' },
        prismaRepository: { nexiGroupEventOutbox: db, webhook: { findUnique: async () => ({ enabled: true,
          url: 'https://nexi.example.test/webhooks/nexi/channels/evolution',
          headers: { 'X-Nexi-Chatwoot-Account-Id': '4', 'X-Nexi-Chatwoot-Inbox-Id': '13' } }) } } });
      const dbA = query(a), dbB = query(b);
      let calls = 0, release;
      const stalled = new Promise(resolve => { release = resolve; });
      const running = groups.drain(service(dbA), async () => { calls++; return stalled; }, 1);
      for (let i = 0; calls === 0 && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls, 1, 'first worker must acquire the lease within the bounded gate');
      await groups.drain(service(dbB), async () => { calls++; return { ok: true, status: 200 }; }, 1);
      assert.equal(calls, 1);
      // Owner A dies/stalls; B acquires the expired lease and schedules retry.
      await b.query('UPDATE "NexiGroupEventOutbox" SET "leaseUntil"=CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE id=$1', [id]);
      await groups.drain(service(dbB), async () => { calls++; return { ok: false, status: 503 }; }, 1);
      release({ ok: true, status: 200 }); await running;
      let row = (await b.query('SELECT * FROM "NexiGroupEventOutbox" WHERE id=$1', [id])).rows[0];
      assert.equal(row.state, 'queued'); assert.equal(row.attempts, 2); assert.ok(row.nextAttemptAt > new Date());
      await a.query('UPDATE "NexiGroupEventOutbox" SET "nextAttemptAt"=CURRENT_TIMESTAMP WHERE id=$1', [id]);
      const select = dbA.findFirst;
      dbA.findFirst = async args => {
        const row = await select(args);
        await b.query('UPDATE "NexiGroupEventOutbox" SET "nextAttemptAt"=CURRENT_TIMESTAMP + INTERVAL \'1 minute\' WHERE id=$1', [id]);
        return row;
      };
      await groups.drain(service(dbA), async () => { throw new Error('stale claim dispatched'); }, 1);
      row = (await b.query('SELECT * FROM "NexiGroupEventOutbox" WHERE id=$1', [id])).rows[0];
      assert.equal(row.attempts, 2);
      await b.query('UPDATE "NexiGroupEventOutbox" SET "createdAt"=CURRENT_TIMESTAMP - INTERVAL \'25 hours\' WHERE id=$1', [id]);
      await groups.drain(service(dbB), async () => { throw new Error('expired content dispatched'); }, 1);
      row = (await b.query('SELECT * FROM "NexiGroupEventOutbox" WHERE id=$1', [id])).rows[0];
      assert.equal(row.state, 'quarantined'); assert.deepEqual(row.payload, {}); assert.equal(row.sourceKey, 'c'.repeat(64));
    } finally {
      if (previous === undefined) delete process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET;
      else process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = previous;
      await a.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all([a.end(), b.end()]);
    }
  });
