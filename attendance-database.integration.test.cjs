'use strict';

// EasyPanel-only, opt-in disposable databases. Never read the production URI.
// No server, dependency installation or migration against an existing schema.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

for (const provider of ['postgresql', 'mysql']) {
  const variable = provider === 'postgresql' ? 'NEXI_ATTENDANCE_PG_TEST_URL' : 'NEXI_ATTENDANCE_MYSQL_TEST_URL';
  test(`real ${provider}: durable receipt dedupe, immutable preparation/outbox and dispatch prohibition`,
    { skip: !process.env[variable] }, async () => {
      const namespace = 'nexi_attendance_test_' + randomUUID().replaceAll('-', '');
      const quote = name => provider === 'mysql' ? '`' + name + '`' : '"' + name + '"';
      const connect = async () => {
        if (provider === 'postgresql') {
          const { Client } = require('pg');
          const client = new Client({ connectionString: process.env[variable] });
          await client.connect();
          return { query: async (sql, values = []) => {
            let index = 0;
            return (await client.query(sql.replace(/\?/g, () => '$' + ++index), values)).rows;
          }, end: () => client.end() };
        }
        const url = new URL(process.env[variable]);
        assert.equal(url.protocol, 'mysql:');
        const client = await require('mariadb').createConnection({ host: url.hostname, port: Number(url.port || 3306),
          user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), multipleStatements: true });
        return { query: (sql, values = []) => client.query(sql, values), end: () => client.end() };
      };
      const a = await connect();
      let b, created = false;
      const table = name => quote(name);
      const insert = (db, name, material) => db.query(`INSERT INTO ${table(name)} (${Object.keys(material).map(quote).join(',')})
        VALUES (${Object.keys(material).map(() => '?').join(',')})`, Object.values(material));
      const update = (db, name, id, material) => db.query(`UPDATE ${table(name)} SET
        ${Object.keys(material).map(key => quote(key) + '=?').join(',')} WHERE ${quote('id')}=?`, [...Object.values(material), id]);
      try {
        await a.query(provider === 'mysql' ? `CREATE DATABASE ${quote(namespace)}` : `CREATE SCHEMA ${quote(namespace)}`);
        created = true;
        b = await connect();
        for (const db of [a, b]) await db.query(provider === 'mysql' ? `USE ${quote(namespace)}` : `SET search_path TO ${quote(namespace)}`);
        await a.query(fs.readFileSync(path.join(__dirname, 'prisma', provider + '-migrations',
          '20261005000000_nexi_attendance_boundaries/migration.sql'), 'utf8'));
        // There is deliberately no Message/Instance table. A receipt is durable
        // before message creation, Chatwoot correlation or preparation ownership.
        const receipt = { id: randomUUID(), instanceId: 'synthetic-instance', sessionIdentity: 'a'.repeat(64),
          sourceKey: 'b'.repeat(64), fingerprint: 'c'.repeat(64), externalId: 'EARLY', normalizedStatus: 'UNKNOWN', evidence: '{}' };
        await insert(a, 'NexiReceiptJournal', receipt);
        await assert.rejects(insert(b, 'NexiReceiptJournal', { ...receipt, id: randomUUID() }));
        assert.equal((await b.query(`SELECT * FROM ${table('NexiReceiptJournal')}`)).length, 1);
        await assert.rejects(update(b, 'NexiReceiptJournal', receipt.id, { normalizedStatus: 'READ' }));
        await assert.rejects(b.query(`DELETE FROM ${table('NexiReceiptJournal')}`));
        const prep = { id: randomUUID(), instanceId: receipt.instanceId, instanceName: 'synthetic-name', executionId: randomUUID(),
          transportUnit: 0, requestId: randomUUID(), inputDigest: 'd'.repeat(64), requests: '{}', authority: '{}', intent: '{}',
          authorityDigest: 'e'.repeat(64), payloadDigest: 'f'.repeat(64), recipient: '5511999999999@s.whatsapp.net',
          sessionIdentity: receipt.sessionIdentity, externalId: 'CANDIDATE', preparationNonce: '1'.repeat(64), preparationRevision: 1,
          state: 'draft' };
        await insert(a, 'NexiAttendancePreparation', prep);
        await update(a, 'NexiAttendancePreparation', prep.id,
          { attemptId: randomUUID(), reservationId: randomUUID(), state: 'reserved', revision: 1 });
        await update(a, 'NexiAttendancePreparation', prep.id, { contentDigest: '2'.repeat(64), preparationDigest: '3'.repeat(64),
          frozenAt: new Date(), state: 'prepared', revision: 2 });
        const restored = (await b.query(`SELECT * FROM ${table('NexiAttendancePreparation')}`))[0];
        assert.equal(restored.externalId, prep.externalId);
        assert.equal(restored.preparationNonce, prep.preparationNonce);
        for (const material of [{ externalId: 'SUBSTITUTED' }, { recipient: '5511888888888@s.whatsapp.net' },
          { intent: '{"body":"substituted"}' }, { preparationNonce: '4'.repeat(64) }, { reservationId: randomUUID() },
          { state: 'draft' }, { dispatchStartedAt: new Date() }, { releaseConsumedAt: new Date() }, { state: 'released' }])
          await assert.rejects(update(b, 'NexiAttendancePreparation', prep.id, { ...material, revision: 3 }));
        const event = { id: randomUUID(), instanceId: receipt.instanceId, instanceName: 'synthetic-name',
          sessionIdentity: receipt.sessionIdentity, eventType: 'attendance.receipt.observed', version: 1,
          sourceKey: '5'.repeat(64), fingerprint: '6'.repeat(64), body: '{"stable":true}', state: 'pending', nextAttemptAt: new Date() };
        await insert(a, 'NexiAttendanceEventOutbox', event);
        await update(b, 'NexiAttendanceEventOutbox', event.id, { attempts: 1, nextAttemptAt: new Date() });
        const retry = (await a.query(`SELECT * FROM ${table('NexiAttendanceEventOutbox')}`))[0];
        assert.equal(retry.id, event.id);
        assert.deepEqual(typeof retry.body === 'string' ? JSON.parse(retry.body) : retry.body, { stable: true });
        await assert.rejects(update(a, 'NexiAttendanceEventOutbox', event.id, { body: '{"stable":false}' }));
        await update(a, 'NexiAttendanceEventOutbox', event.id, { state: 'acknowledged', acknowledgedAt: new Date() });
        await assert.rejects(update(b, 'NexiAttendanceEventOutbox', event.id, { state: 'pending', acknowledgedAt: null }));
        await assert.rejects(update(b, 'NexiAttendanceEventOutbox', event.id, { acknowledgedAt: null }));
        await assert.rejects(b.query(`DELETE FROM ${table('NexiAttendanceEventOutbox')}`));
      } finally {
        try {
          if (created) await a.query(provider === 'mysql' ? `DROP DATABASE ${quote(namespace)}` : `DROP SCHEMA ${quote(namespace)} CASCADE`);
        } finally { await Promise.all([a.end(), b?.end()]); }
      }
    });
}
