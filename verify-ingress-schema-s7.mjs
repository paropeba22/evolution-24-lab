// Disposable single-backend PostgreSQL WASM fixture. No server, Prisma client,
// MySQL, PgBouncer, multi-backend contention or runtime certification is implied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = path.dirname(fileURLToPath(import.meta.url));
const modulePath = process.argv[2];
assert.ok(modulePath, 'local PGlite 0.3.14 dist/index.js required');
const version = JSON.parse(fs.readFileSync(path.resolve(path.dirname(modulePath), '../package.json'))).version;
assert.equal(version, '0.3.14');
const { PGlite } = await import(pathToFileURL(path.resolve(modulePath)));
const db = await PGlite.create(); // No path: exclusively memory; no persisted database or network.
const timer = setTimeout(() => { console.error('S7 schema fixture exceeded 30 seconds'); process.exit(1); }, 30000);
const checks = [], migrations = [];
try {
  for (const name of ['20261015000000_nexi_durable_ingress', '20261015000001_nexi_ingress_secondary', '20261015000002_nexi_ingress_contact_cache']) {
    const sql = fs.readFileSync(path.join(root, 'prisma/postgresql-migrations', name, 'migration.sql'), 'utf8');
    await db.exec(sql);
    migrations.push({ name, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  checks.push('three unmodified PostgreSQL ingress migrations apply in order');
  const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='NexiIngressJournal'`)).rows.map(row => row.column_name);
  for (const name of ['mainMaterializedAt', 'payloadPrunedAt', 'continuationStartedAt', 'checkpoint']) assert.ok(columns.includes(name));
  assert.ok((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='NexiIngressEffect'`)).rows.some(row => row.column_name === 'contractVersion'));
  checks.push('R1 materialization/retention and R2 contract checkpoints exist');
  const journal = (id, dedup, lane, sequence) => db.query(`INSERT INTO "NexiIngressJournal"
    (id,"dedupKey","scopeId","laneId","instanceId","sessionIdentity",sequence,envelope,payload)
    VALUES ($1,$2,'scope',$3,'synthetic-instance','synthetic-session',$4,'{}','synthetic-payload')`, [id, dedup, lane, sequence]);
  await journal('j1', 'dedup1', 'lane1', 1);
  await assert.rejects(journal('j2', 'dedup1', 'lane2', 1), { code: '23505' });
  await assert.rejects(journal('j2', 'dedup2', 'lane1', 1), { code: '23505' });
  await journal('j2', 'dedup2', 'lane1', 2);
  checks.push('journal dedup and same-conversation sequence constraints reject duplicates');
  const effect = (id, journalId, lane, seq) => db.query(`INSERT INTO "NexiIngressEffect"
    (id,"journalId","laneId","scopeId","instanceId",kind,sequence,intent,"intentDigest","intentSignature")
    VALUES ($1,$2,$3,'scope','synthetic-instance','message_webhook',$4,'{}','synthetic-digest','synthetic-signature')`, [id, journalId, lane, seq]);
  await effect('e1', 'j1', 'effects1', 1);
  await assert.rejects(effect('e2', 'j1', 'effects2', 2), { code: '23505' });
  await assert.rejects(effect('e2', 'j2', 'effects1', 1), { code: '23505' });
  checks.push('secondary journal/family identity and lane sequence are unique');
  const cache = (id, scope, session, pn, lid) => db.query(`INSERT INTO "NexiIngressContactCache"
    (id,"scopeId","instanceId","sessionIdentity","pnJid","lidJid","journalId",sequence,"expiresAt")
    VALUES ($1,$2,'synthetic-instance',$3,$4,$5,'j1',1,CURRENT_TIMESTAMP + INTERVAL '5 minutes')`, [id, scope, session, pn, lid]);
  await cache('c1', 'scope1', 'session1', '5511888888888@s.whatsapp.net', '123@lid');
  await assert.rejects(cache('c2', 'scope1', 'session1', '5511888888888@s.whatsapp.net', '456@lid'), { code: '23505' });
  await assert.rejects(cache('c2', 'scope1', 'session1', '5511777777777@s.whatsapp.net', '123@lid'), { code: '23505' });
  await cache('c2', 'scope2', 'session1', '5511888888888@s.whatsapp.net', '123@lid');
  await cache('c3', 'scope1', 'session2', '5511888888888@s.whatsapp.net', '123@lid');
  checks.push('authenticated contact cache uniqueness is scoped; session/provider namespaces remain independent');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM "NexiIngressJournal"')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM "NexiIngressEffect"')).rows[0].n, 1);
  console.log(JSON.stringify({ status: 'PASS', level: 'single-backend PostgreSQL WASM schema fixture',
    postgres: (await db.query('SHOW server_version')).rows[0].server_version, migrations, checks }, null, 2));
} finally { clearTimeout(timer); await db.close(); }
