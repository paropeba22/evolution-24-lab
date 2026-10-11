'use strict';
require('./attendance-test-network-trap.cjs');
// Run only in the designated EasyPanel build/runtime environment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac, createHash } = require('node:crypto');
const a = require('./nexi-attendance.cjs');
const identity = require('./nexi-identity.cjs');
const financial = require('./nexi-financial-transport.cjs');
const transport = require('./nexi-transport.cjs');
const master = 'synthetic-attendance-boundary-master-32-bytes';
const credentials = () => ({ me: { id: '5511999999999:1@s.whatsapp.net', lid: '100001@lid' }, registrationId: 9,
  signedIdentityKey: { public: Buffer.alloc(32, 7), private: Buffer.from('DO_NOT_EXPOSE') },
  account: { accountSignatureKey: Buffer.alloc(32, 3), accountSignature: Buffer.alloc(64, 4), details: Buffer.from([1, 2]) },
  noiseKey: { private: Buffer.from('DO_NOT_EXPOSE') } });
function context(instanceId, session = identity.sessionFingerprint(credentials())) {
  return { version: 1, protocol_version: 1, canonical_version: a.CANONICAL_VERSION, audience: 'nexi-attendance-evolution', provider: 'evolution-baileys',
    account_id: 1, inbox_id: 2, managed_channel_id: 3, instance_id: instanceId, instance: 'nexi-wa-' + instanceId,
    instance_lineage_id: randomUUID(), sender_account_lineage_id: randomUUID(), sender_attestation_id: randomUUID(),
    session_identity: session, original_session_identity: null, binding_generation: 1, writer_epoch: 1,
    writer_protocol_version: 1, barrier_state: 'staged', channel_state: 'active', current_session: true,
    physical_dispatch: false, isolation_cutover: false };
}
function intent() {
  const payload = { kind: 'text', body: 'synthetic exact body', reply_to: null };
  return { canonical_version: a.CANONICAL_VERSION, execution_id: randomUUID(), transport_unit: 0, authority_digest: 'a'.repeat(64),
    payload_digest: a.digest(payload), identity_version_id: 1, recipient: '5511888888888@s.whatsapp.net', payload };
}
function matches(row, where) {
  return Object.entries(where || {}).every(([key, value]) => {
    if (key === 'OR') return value.some(v => matches(row, v));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lte' in value) return row[key] <= value.lte;
      if ('lt' in value) return row[key] < value.lt;
      if ('gte' in value) return row[key] >= value.gte;
      return matches(row, value); // Prisma compound unique selectors
    }
    return value === null ? row[key] == null : row[key] === value;
  });
}
function table(defaults = {}) {
  const rows = [];
  return { rows,
    async findUnique({ where }) { return rows.find(row => matches(row, where)) || null; },
    async findFirst({ where }) { return rows.find(row => matches(row, where)) || null; },
    async create({ data }) {
      const row = { ...defaults, createdAt: new Date(), ...data }; rows.push(row); return row;
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows.filter(row => matches(row, where))) {
        for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? row[key] + value.increment : value;
        count++;
      }
      return { count };
    },
    async upsert({ where, create, update }) {
      const row = rows.find(row => matches(row, where));
      if (row) { await this.updateMany({ where, data: update }); return row; }
      return this.create({ data: create });
    },
  };
}
function fixture() {
  const instanceId = randomUUID(), c = context(instanceId);
  const repo = {
    nexiManagedTransportContext: table(), nexiAttendancePreparation: table({ revision: 0, successorId: null, recoveryAttempts: 0, nextRecoveryAt: new Date() }),
    nexiReceiptJournal: table(), nexiAttendanceEventOutbox: table({ attempts: 0, leaseUntil: null }),
    nexiAttendanceHealth: table({ revision: 0 }), instance: table(), webhook: table(),
    async $executeRawUnsafe() { return 0; },
    async $transaction(work) { return work(repo); },
    attendanceReceiptRepository() { return repo; },
  };
  repo.instance.rows.push({ id: instanceId, name: c.instance });
  repo.webhook.rows.push({ instanceId, enabled: true, webhookByEvents: false, webhookBase64: false,
    url: 'https://app.invalid/webhooks/nexi/channels/evolution', headers: {
      'X-Nexi-Chatwoot-Account-Id': '1', 'X-Nexi-Chatwoot-Inbox-Id': '2' } });
  const source = { prismaRepository: repo, receiptRepository: repo, instanceId, instance: { name: c.instance } };
  return { source, repo, c };
}
function appResponder(row, reservationId = randomUUID()) {
  const calls = [];
  const request = async (_source, body) => {
    calls.push(structuredClone(body));
    if (body.action === 'attempt') return { outcome: 'attempt_registered', attempt_id: row.attemptId || randomUUID(),
      external_id: row.externalId, authority_digest: row.authorityDigest, payload_digest: row.payloadDigest,
      recipient: row.recipient, identity_version_id: row.intent.identity_version_id, preparation_id: row.id, physical_dispatch: false };
    return { outcome: 'reserved', attempt_id: body.attempt_id, reservation_id: reservationId,
      external_id: body.external_id, admission_registered: false, physical_dispatch: false };
  };
  return { request, calls, reservationId };
}
test('collision crash before successor creation exposes a recoverable gap and resumes original durable chain',async()=>{
  const authority=require('./nexi-attendance-authority.cjs');
  const f=fixture(),root=await a.draft(f.source,f.c,intent(),randomUUID()),app=appResponder(root);
  const db=f.repo.nexiAttendancePreparation,create=db.create.bind(db);
  let paused=true;
  db.create=async args=>{if(paused&&args.data.requests.predecessor)throw Error('crash before successor commit');return create(args);};
  const request=async(source,body)=>{
    if(body.action==='reserve')throw Object.assign(Error('collision'),{code:'nexi_attendance_reservation_conflict'});
    if(body.action==='readback')return {outcome:'unresolved',admission_registered:false};
    if(body.action==='close_collision')return {outcome:'collision_fenced',attempt_id:body.attempt_id,external_id:body.external_id,replacement_permitted:true,physical_dispatch:false};
    return app.request(source,body);
  };
  await assert.rejects(a.prepare(f.source,root,request),/crash/);
  const fenced=await db.findUnique({where:{id:root.id}});
  assert.equal(fenced.state,'definitively_not_sent');assert.equal(db.rows.length,1);assert.equal(fenced.successorId,null);
  const value={request_id:root.requestId,material:{execution_id:root.executionId,transport_unit:root.transportUnit,
    prepare_request_id:root.requestId,preparation_id:root.id,attempt_id:fenced.attemptId}};
  assert.deepEqual((await authority.preparationReadback(f.source,value)).successor_chain,[]);
  assert.equal(db.rows.length,1);
  paused=false;
  // Resume only the transport's persisted replacement request identity.
  const replacement=await a.draft(f.source,fenced.authority,fenced.intent,fenced.requests.replacement,fenced);
  const prepared=await a.prepare(f.source,fenced,appResponder(replacement).request);
  assert.equal(prepared.id,replacement.id);assert.equal(prepared.requestId,fenced.requests.replacement);
  assert.equal(db.rows.length,2);
  const result=await authority.preparationReadback(f.source,value),link=result.successor_chain[0];
  assert.equal(link.successor_request_id,fenced.requests.replacement);assert.equal(link.successor_preparation_id,prepared.id);
  assert.equal(link.successor_external_id,prepared.externalId);assert.equal(link.successor_attempt_id,prepared.attemptId);
  assert.equal(link.closure_request_id,fenced.requests.close_collision);
  assert.equal(link.predecessor_request_id,root.requestId);
  assert.deepEqual(await authority.preparationReadback(f.source,value),result);assert.equal(db.rows.length,2);
  await a.prepare(f.source,fenced,()=>assert.fail('prepared successor cannot allocate or call APP again'));
  assert.equal(db.rows.length,2);
});
test('lost original APP collision fence is recovered through authenticated foundation readback',async()=>{
  const f=fixture(),root=await a.draft(f.source,f.c,intent(),randomUUID()),app=appResponder(root);
  let committed=false,lose=true;const closures=[];
  const request=async(source,body)=>{
    if(body.action==='reserve')throw Object.assign(Error('lost'),{code:committed?'response_lost':'nexi_attendance_reservation_conflict'});
    if(body.action==='readback')return committed?{outcome:'collision_fenced',attempt_id:body.attempt_id,
      external_id:body.external_id,replacement_permitted:true,physical_dispatch:false}:{outcome:'unresolved',admission_registered:false};
    if(body.action==='close_collision'){
      closures.push(body.request_id);committed=true;
      if(lose)throw Error('closure response lost');
      return {outcome:'collision_fenced',attempt_id:body.attempt_id,external_id:body.external_id,replacement_permitted:true,physical_dispatch:false};
    }return app.request(source,body);
  };
  await assert.rejects(a.prepare(f.source,root,request),/response lost/);
  assert.equal(f.repo.nexiAttendancePreparation.rows.length,1);
  const original=await f.repo.nexiAttendancePreparation.findUnique({where:{id:root.id}});
  assert.equal(original.state,'draft');lose=false;
  const successor=await a.prepare(f.source,original,request);
  assert.equal(successor.requestId,root.requests.replacement);assert.equal(closures.length,2);
  assert.equal(new Set(closures).size,1);assert.equal(f.repo.nexiAttendancePreparation.rows.length,2);
});
test('generic timeout with missing reservation never grants collision replacement',async()=>{
  const f=fixture(),root=await a.draft(f.source,f.c,intent(),randomUUID()),app=appResponder(root);
  await assert.rejects(a.prepare(f.source,root,async(source,body)=>{
    if(body.action==='reserve')throw Error('timeout');
    if(body.action==='readback')return {outcome:'unresolved',admission_registered:false};
    if(body.action==='close_collision')assert.fail('timeout is not collision evidence');
    return app.request(source,body);
  }),/timeout/);
  assert.equal(f.repo.nexiAttendancePreparation.rows.length,1);
  assert.equal(root.successorId,null);
});
const limits = { queueItems: 2, queueBytes: 32768, concurrent: 1, acquireMs: 5, statementMs: 10,
  lockMs: 5, deadlineMs: 30, recoveryItems: 1, recoveryBytes: 32768 };

test('candidate reservation response loss recovers exact candidate, APP attempt, reservation and immutable preparation', async () => {
  const f = fixture(), row = await a.draft(f.source, f.c, intent(), randomUUID()), app = appResponder(row);
  const prepared = await a.prepare(f.source, row, async (source, body) => {
    if (body.action === 'reserve') { app.calls.push(structuredClone(body)); throw Object.assign(new Error('lost'), { code: 'response_lost' }); }
    return app.request(source, body);
  });
  assert.equal(prepared.externalId, row.externalId); assert.equal(prepared.reservationId, app.reservationId);
  assert.equal(prepared.state, 'prepared'); assert.ok(prepared.frozenAt);
  const reserve = app.calls.find(x => x.action === 'reserve'), read = app.calls.find(x => x.action === 'readback');
  assert.equal(reserve.external_id, read.external_id); assert.equal(reserve.attempt_id, read.attempt_id);
  assert.equal(reserve.authority_digest, read.authority_digest);
  const restored = await a.prepare(f.source, prepared, () => assert.fail('prepared recovery must not reserve again'));
  assert.equal(restored.preparationDigest, prepared.preparationDigest);
  await assert.rejects(a.prepare(f.source, { ...prepared, recipient: '5511777777777@s.whatsapp.net', intent: { ...prepared.intent, recipient: '5511777777777@s.whatsapp.net' } }), /frozen_digest_conflict/);
});
test('same request/digest restores same preparation; changed content conflicts before APP interaction', async () => {
  const f = fixture(), i = intent(), id = randomUUID(), row = await a.draft(f.source, f.c, i, id);
  assert.equal((await a.draft(f.source, f.c, i, id)).id, row.id);
  const changed = { ...i, payload: { kind: 'text', body: 'changed' } }; changed.payload_digest = a.digest(changed.payload);
  await assert.rejects(a.draft(f.source, f.c, changed, id), /identity_conflict/);
  const app = appResponder(row); await a.prepare(f.source, row, app.request);
  assert.equal(f.repo.nexiAttendancePreparation.rows.length, 1);
  assert.equal(f.repo.nexiAttendanceEventOutbox.rows.length, 1);
});
test('content canonicalization matches APP UTF-8 ordering and binds each physical unit independently', async () => {
  assert.equal(JSON.stringify(a.canonical({ '\u{10000}': 'a', '\uE000': 'b' })), '{"\uE000":"b","\u{10000}":"a"}');
  const f = fixture(), i = intent();
  const first = await a.draft(f.source, f.c, i, randomUUID());
  const second = await a.draft(f.source, f.c, { ...i, transport_unit: 1 }, randomUUID());
  assert.notEqual(first.externalId, second.externalId); assert.notEqual(first.preparationNonce, second.preparationNonce);
  assert.equal(a.digest({ a: 1, b: 2 }), a.digest({ b: 2, a: 1 }));
  assert.throws(() => a.digest({ value: 1.5 }), /noncanonical/);
});
test('collision requires APP locked pre-admission fencing and creates fresh ID, nonce, revision and attempt identity', async () => {
  const f = fixture(), row = await a.draft(f.source, f.c, intent(), randomUUID()), app = appResponder(row);
  const replacement = await a.prepare(f.source, row, async (source, body) => {
    if (body.action === 'reserve') throw Object.assign(new Error('collision'), { code: 'nexi_attendance_reservation_conflict' });
    if (body.action === 'readback') return { outcome: 'unresolved', admission_registered: false };
    if (body.action === 'close_collision') return { outcome: 'collision_fenced', attempt_id: body.attempt_id,
      external_id: body.external_id, replacement_permitted: true, physical_dispatch: false };
    return app.request(source, body);
  });
  const fenced = await f.repo.nexiAttendancePreparation.findUnique({ where: { id: row.id } });
  assert.equal(fenced.state, 'definitively_not_sent'); assert.equal(fenced.successorId, replacement.id);
  assert.notEqual(replacement.externalId, row.externalId); assert.notEqual(replacement.preparationNonce, row.preparationNonce);
  assert.equal(replacement.preparationRevision, 2); assert.equal(replacement.attemptId, undefined);
  const restored = await a.prepare(f.source, fenced, appResponder(replacement).request);
  assert.equal(restored.id, replacement.id); assert.equal(f.repo.nexiAttendancePreparation.rows.length, 2);
});
test('uncertain admission or reservation absence cannot license regeneration', async () => {
  for (const admitted of [true, undefined]) {
    const f = fixture(), row = await a.draft(f.source, f.c, intent(), randomUUID()), app = appResponder(row);
    await assert.rejects(a.prepare(f.source, row, async (source, body) => {
      if (body.action === 'reserve') throw Object.assign(new Error('collision'), { code: 'nexi_attendance_reservation_conflict' });
      if (body.action === 'readback') return { outcome: 'unresolved', admission_registered: admitted };
      if (body.action === 'close_collision') assert.fail('uncertain admission must not be fenced');
      return app.request(source, body);
    }), /collision/);
    assert.equal(f.repo.nexiAttendancePreparation.rows.length, 1);
    await assert.rejects(a.closeCollision(f.source, { ...row, admissionId: randomUUID() }), /replacement_denied/);
  }
});
test('unresolved preparation recovery persists a bounded future retry without replacing candidate or authorizing dispatch', async () => {
  const f = fixture(), row = await a.draft(f.source, f.c, intent(), randomUUID());
  f.repo.webhook.rows[0].enabled = false; // No HTTP should be attempted.
  await a.recoverPreparation(f.source, row);
  const persisted = await f.repo.nexiAttendancePreparation.findUnique({ where: { id: row.id } });
  assert.equal(persisted.recoveryAttempts, 1); assert.ok(persisted.nextRecoveryAt > new Date());
  assert.equal(persisted.externalId, row.externalId); assert.equal(persisted.state, 'draft');
  assert.equal(persisted.dispatchStartedAt, undefined);
});
test('final completed stanza identity equality includes actual attrs.id, recipient and authenticated session; equality still cannot send', () => {
  const creds = credentials(), row = { reservationId: randomUUID(), preparationDigest: 'a'.repeat(64), externalId: 'exact-ID',
    recipient: '5511888888888@s.whatsapp.net', sessionIdentity: identity.sessionFingerprint(creds) }, config = { auth: { creds } };
  for (const stanza of [{ attrs: { id: 'substituted', to: row.recipient } }, { attrs: { id: row.externalId, to: '5511777777777@s.whatsapp.net' } }])
    assert.throws(() => a.foundationCapability(row, () => a.bindStanza(config, stanza, { conversation: 'x' }, row.externalId)), /final_stanza_mismatch/);
  assert.throws(() => a.foundationCapability(row, () => a.bindStanza(config, { attrs: { id: row.externalId, to: row.recipient } }, {}, row.externalId)), /dispatch_disabled/);
  assert.throws(() => a.foundationCapability(row, () => a.bindStanza({ auth: { creds: { ...creds, registrationId: 10 } } },
    { attrs: { id: row.externalId, to: row.recipient } }, {}, row.externalId)), /final_stanza_mismatch/);
});
test('verified public attestation excludes credentials and private keys; number equality cannot fabricate session continuity', () => {
  const creds = credentials(), prefix = Buffer.from([6, 0]);
  const observation = a.publicAttestation(creds, (key, bytes, signature) => {
    assert.equal(key.length, 32); assert.equal(signature.length, 64); assert.deepEqual(bytes, Buffer.concat([prefix, creds.account.details, creds.signedIdentityKey.public]));
    return true;
  }, () => prefix, 'verified_pairing', 1234);
  assert.equal(observation.canonical_pn, '5511999999999@s.whatsapp.net');
  assert.doesNotMatch(JSON.stringify(observation), /DO_NOT_EXPOSE|private|noiseKey|accountSignature/);
  assert.equal(a.publicAttestation(creds, () => false, () => prefix), null);
  const newer = a.publicAttestation({ ...creds, registrationId: 10 }, () => true, () => prefix);
  assert.equal(newer.canonical_pn, observation.canonical_pn); assert.notEqual(newer.session_identity, observation.session_identity);
  assert.equal(observation.session_identity, identity.sessionFingerprint(creds));
});

test('attestation diagnostics distinguish missing material, signature rejection and verifier errors without changing outcomes', () => {
  const cases = [
    ['session_material_unavailable', c => { delete c.signedIdentityKey; }],
    ['account_identity_invalid', c => { c.me.id = 'invalid'; }],
    ['account_material_unavailable', c => { delete c.account; }],
    ['account_signature_key_missing', c => { delete c.account.accountSignatureKey; }],
    ['account_signature_key_missing', c => { c.account.accountSignatureKey = null; }],
    ['account_signature_key_wrong_type', c => { c.account.accountSignatureKey = { type: 'Buffer', data: 'untrusted' }; }],
    ['account_signature_key_wrong_type', c => { c.account.accountSignatureKey = Array(32).fill(3); }],
    ['account_signature_key_wrong_type', c => { c.account.accountSignatureKey = 'not base64!'; }],
    ['account_signature_key_wrong_length', c => { c.account.accountSignatureKey = Buffer.alloc(0); }],
    ['account_signature_key_wrong_length', c => { c.account.accountSignatureKey = Buffer.alloc(31); }],
    ['account_signature_key_wrong_length', c => { c.account.accountSignatureKey = new Uint8Array(33); }],
    ['account_signature_invalid', c => { c.account.accountSignature = Buffer.alloc(63); }],
    ['account_details_invalid', c => { c.account.details = Buffer.alloc(0); }],
  ];
  for (const [expected, change] of cases) {
    const c = credentials(), statuses = []; change(c);
    assert.equal(a.publicAttestation(c, () => { assert.fail('verifier must not run'); }, () => Buffer.from([6, 0]),
      'verified_restored_account', 1, value => statuses.push(value)), null);
    assert.deepEqual(statuses, [expected]);
  }
  for (const expected of ['account_details_decode_failed', 'signature_verifier_failed', 'signature_rejected', 'verified']) {
    const statuses = [], error = new Error('DO_NOT_EXPOSE');
    const verify = () => { if (expected === 'signature_verifier_failed') throw error; return expected !== 'signature_rejected'; };
    const prefixes = () => { if (expected === 'account_details_decode_failed') throw error; return Buffer.from([6, 0]); };
    const run = () => a.publicAttestation(credentials(), verify, prefixes, 'verified_pairing', 1, value => statuses.push(value));
    if (expected.endsWith('_failed')) assert.throws(run, value => value === error);
    else assert.equal(!!run(), expected === 'verified');
    assert.deepEqual(statuses, [expected]);
  }
  assert.ok(a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0]), 'verified_pairing', 1,
    () => { throw Error('diagnostic failure'); }));
});

test('real Signal account signature remains required and rejects changed identity, details and signature', () => {
  // Use the production primitive; no real account, connection or pairing.
  const curve = require('libsignal/src/curve.js'), accountKey = curve.generateKeyPair(), deviceKey = curve.generateKeyPair();
  const c = credentials(), prefix = Buffer.from([6, 0]);
  c.signedIdentityKey.public = Buffer.from(deviceKey.pubKey.subarray(1));
  c.account.accountSignatureKey = Buffer.from(accountKey.pubKey.subarray(1));
  c.account.accountSignature = curve.calculateSignature(accountKey.privKey,
    Buffer.concat([prefix, c.account.details, c.signedIdentityKey.public]));
  const verify = a.verifyPublicAccountSignature;
  assert.ok(a.publicAttestation(c, verify, () => prefix));
  for (const change of [v => { v.account.accountSignature[0] ^= 1; }, v => { v.account.details[0] ^= 1; },
    v => { v.signedIdentityKey.public[0] ^= 1; }, v => { v.account.accountSignatureKey[0] ^= 1; }]) {
    const changed = { ...c, signedIdentityKey: { public: Buffer.from(c.signedIdentityKey.public) },
      account: Object.fromEntries(Object.entries(c.account).map(([key, value]) => [key, Buffer.from(value)])) };
    change(changed); const statuses = [];
    assert.equal(a.publicAttestation(changed, verify, () => prefix, 'verified_restored_account', 1,
      value => statuses.push(value)), null);
    assert.deepEqual(statuses, ['signature_rejected']);
  }
  for (const truthy of [1, 'true', {}]) assert.equal(a.publicAttestation(c, () => truthy, () => prefix), null);
});

test('rc13 protobuf account survives supported JSON storage layers only after faithful restored-byte decoding', async () => {
  // Exact installed rc13 protobuf and BufferJSON export, without importing
  // sockets or invoking a storage provider. All account material is synthetic.
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const root = path.dirname(require.resolve('baileys/package.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '7.0.0-rc13');
  const { proto } = await import(require('node:url').pathToFileURL(path.join(root, 'WAProto/index.js')).href);
  const generics = fs.readFileSync(path.join(root, 'lib/Utils/generics.js'), 'utf8').replaceAll('\r\n', '\n');
  const start = generics.indexOf('export const BufferJSON = '), end = generics.indexOf('\nexport const getKeyAuthor');
  assert.ok(start >= 0 && end > start);
  const BufferJSON = vm.runInNewContext(generics.slice(start, end).replace('export const BufferJSON = ', 'globalThis.BufferJSON = ') +
    '\nBufferJSON;', { Buffer, Uint8Array });
  const curve = require('libsignal/src/curve.js'), accountKey = curve.generateKeyPair(), deviceKey = curve.generateKeyPair();
  const prefix = Buffer.from([6, 0]), c = credentials();
  c.signedIdentityKey.public = Buffer.from(deviceKey.pubKey.subarray(1));
  const details = proto.ADVDeviceIdentity.encode({ keyIndex: 1 }).finish();
  c.account = proto.ADVSignedDeviceIdentity.decode(proto.ADVSignedDeviceIdentity.encode({
    details, accountSignatureKey: Buffer.from(accountKey.pubKey.subarray(1)),
    accountSignature: curve.calculateSignature(accountKey.privKey, Buffer.concat([prefix, details, c.signedIdentityKey.public]))
  }).finish());
  const original = a.publicAttestation(c, a.verifyPublicAccountSignature, () => prefix, 'verified_pairing');
  assert.ok(original);
  const serialized = JSON.stringify(c, BufferJSON.replacer), restore = raw => JSON.parse(raw, BufferJSON.reviver);
  const paths = [restore(serialized), // Baileys filesystem helper
    restore(restore(JSON.stringify(serialized, BufferJSON.replacer))), // CacheService + RedisCache/LocalCache
    restore(JSON.parse(JSON.stringify(serialized))), // Prisma saveKey/getAuthKey layers
    restore(JSON.stringify(JSON.parse(serialized)))]; // ProviderFiles object response
  for (const restored of paths) {
    const snapshot = JSON.stringify(restored, BufferJSON.replacer), statuses = [];
    for (const field of ['accountSignatureKey', 'accountSignature', 'details']) {
      assert.equal(typeof restored.account[field], 'string');
      assert.ok(Buffer.from(restored.account[field], 'base64').equals(c.account[field]));
    }
    // V8.3 rejects this exact stored type; only the restored hook may decode it.
    assert.equal(a.publicAttestation(restored, a.verifyPublicAccountSignature, () => prefix, 'verified_pairing', 1,
      status => statuses.push(status)), null);
    assert.deepEqual(statuses, ['account_signature_key_wrong_type']);
    const observed = a.publicAttestation(restored, (key, bytes, signature) => {
      assert.ok(Buffer.from(key).equals(c.account.accountSignatureKey));
      assert.ok(Buffer.from(signature).equals(c.account.accountSignature));
      assert.ok(bytes.equals(Buffer.concat([prefix, c.account.details, c.signedIdentityKey.public])));
      return a.verifyPublicAccountSignature(key, bytes, signature);
    }, value => { assert.ok(Buffer.from(value).equals(c.account.details)); return prefix; });
    assert.ok(observed);
    assert.equal(observed.session_identity, original.session_identity);
    assert.equal(observed.public_material_digest, original.public_material_digest);
    assert.equal(observed.registration_digest, original.registration_digest);
    assert.equal(JSON.stringify(restored, BufferJSON.replacer), snapshot);
    for (const field of ['accountSignatureKey', 'accountSignature', 'details']) {
      const changed = restore(serialized), bytes = Buffer.from(changed.account[field], 'base64');
      bytes[0] ^= 1; changed.account[field] = bytes.toString('base64');
      const rejected = [];
      assert.equal(a.publicAttestation(changed, a.verifyPublicAccountSignature, () => prefix, 'verified_restored_account', 1,
        status => rejected.push(status)), null);
      assert.deepEqual(rejected, ['signature_rejected']);
    }
    const changedIdentity = restore(serialized); changedIdentity.signedIdentityKey.public[0] ^= 1;
    assert.equal(a.publicAttestation(changedIdentity, a.verifyPublicAccountSignature, () => prefix), null);
    for (const result of [false, undefined, 1, 'true', {}])
      assert.equal(a.publicAttestation(restored, () => result, () => prefix), null);
    assert.throws(() => a.publicAttestation(restored, () => { throw Error('synthetic-verifier-failure'); }, () => prefix),
      /synthetic-verifier-failure/);
  }
  for (const value of ['AB==', 'AA', 'AA-_', ' AA==', 'AA==\n', 'A'.repeat(1372), { type: 'Buffer', data: 'AA==' }]) {
    const restored = restore(serialized), statuses = []; restored.account.accountSignatureKey = value;
    assert.equal(a.publicAttestation(restored, () => { assert.fail('verifier must not run'); }, () => prefix,
      'verified_restored_account', 1, status => statuses.push(status)), null);
    assert.deepEqual(statuses, ['account_signature_key_wrong_type']);
  }
  const f = fixture(), restored = restore(serialized), config = { auth: { creds: restored } };
  f.repo.webhook.rows.length = 0; // Only the existing in-memory legacy path.
  const service = { ...f.source, client: { authState: { creds: restored } } }; f.source.service = service;
  const current = { ...f.c, session_identity: identity.sessionFingerprint(restored) };
  const logs = [], previous = console.warn; console.warn = value => logs.push(JSON.parse(value));
  const probe = () => a.writerIsolation(f.source, current,
    a.writerProbeTrace({ claims: Buffer.from(JSON.stringify({ action: 'writer_probe' })).toString('base64url') }));
  try {
    await a.configure(service, config); a.trackSocket(service.client, config);
    assert.throws(probe, /writer_isolation_unproved/);
    const invalid = restore(serialized); invalid.account.accountSignature = Buffer.alloc(64).toString('base64');
    await a.observePublicAccount(config, invalid, a.verifyPublicAccountSignature, () => prefix, 'verified_restored_account');
    assert.throws(probe, /writer_isolation_unproved/);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').attestation_present, false);
    await a.observePublicAccount(config, restored, a.verifyPublicAccountSignature, () => prefix, 'verified_restored_account');
    assert.equal(probe(), true);
    // A replacement registration cannot inherit even a real verified signature.
    const replacement = { auth: { creds: restored } }; service.client = { authState: { creds: restored } };
    await a.configure(service, replacement); a.trackSocket(service.client, replacement);
    assert.throws(probe, /writer_isolation_unproved/);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').attestation_present, false);
    for (const log of logs.filter(v => v.event === 'attendance.attestation.observation'))
      assert.deepEqual(Object.keys(log).sort(), ['event', 'registration_present', 'status', 'trigger']);
  } finally { console.warn = previous; }
});

test('socket attestation diagnostics follow inherited config, never transfer to replacement or authorize missing evidence', async () => {
  const f = fixture(), creds = credentials(), config = { auth: { creds } }, completed = { ...config };
  f.repo.webhook.rows.length = 0; // In-memory legacy classification: no HTTP or database service.
  const service = { ...f.source, client: { authState: { creds } } }; f.source.service = service;
  const logs = [], previous = console.warn; console.warn = value => logs.push(JSON.parse(value));
  const trace = () => a.writerProbeTrace({ claims: Buffer.from(JSON.stringify({ action: 'writer_probe' })).toString('base64url') });
  const probe = () => a.writerIsolation(f.source, f.c, trace());
  try {
    await a.configure(service, config); a.inheritConfig(config, completed); a.trackSocket(service.client, config);
    assert.throws(probe, /writer_isolation_unproved/);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').status, 'not_observed');
    await a.observePublicAccount(completed, { ...creds, account: undefined }, () => true, () => Buffer.from([6, 0]), 'verified_restored_account');
    assert.throws(probe, /writer_isolation_unproved/);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').status, 'account_material_unavailable');
    for (const [status, key] of [['account_signature_key_missing', undefined], ['account_signature_key_wrong_type', {}],
      ['account_signature_key_wrong_length', Buffer.alloc(31)]]) {
      const invalid = { ...creds, account: { ...creds.account, accountSignatureKey: key } };
      await a.observePublicAccount(completed, invalid, () => { assert.fail('verifier must not run'); },
        () => Buffer.from([6, 0]), 'verified_restored_account');
      assert.equal(logs.findLast(v => v.event === 'attendance.attestation.observation').status, status);
      assert.throws(probe, /writer_isolation_unproved/);
      const diagnostic = logs.findLast(v => v.event === 'attendance.writer_probe.attestation');
      assert.equal(diagnostic.status, status); assert.equal(diagnostic.attestation_present, false);
    }
    await a.observePublicAccount({}, creds, () => true, () => Buffer.from([6, 0]), 'verified_restored_account');
    assert.equal(logs.findLast(v => v.event === 'attendance.attestation.observation').registration_present, false);
    assert.throws(probe, /writer_isolation_unproved/);
    await a.observePublicAccount(completed, creds, () => false, () => Buffer.from([6, 0]), 'verified_restored_account');
    assert.throws(probe, /writer_isolation_unproved/);
    assert.throws(() => a.observePublicAccount(completed, creds, () => { throw Error('DO_NOT_EXPOSE'); },
      () => Buffer.from([6, 0]), 'verified_restored_account'), /DO_NOT_EXPOSE/);
    assert.throws(probe, /writer_isolation_unproved/);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').status, 'signature_verifier_failed');
    await a.observePublicAccount(completed, creds, () => true, () => Buffer.from([6, 0]), 'verified_pairing');
    assert.equal(probe(), true);
    assert.equal(logs.findLast(v => v.event === 'attendance.writer_probe.attestation').credentials_object_matches, true);
    const newer = { ...creds, me: { ...creds.me, lid: '100002@lid' } }; service.client.authState.creds = newer;
    const current = { ...f.c, session_identity: identity.sessionFingerprint(newer) };
    assert.throws(() => a.writerIsolation(f.source, current, trace()), /writer_isolation_unproved/);
    const stale = logs.findLast(v => v.event === 'attendance.writer_probe.attestation');
    assert.equal(stale.status, 'verified'); assert.equal(stale.attestation_present, true);
    assert.equal(stale.attestation_session_matches, false); assert.equal(stale.credentials_object_matches, false);
    const replacementConfig = { auth: { creds: newer } };
    await a.configure(service, replacementConfig); service.client = { authState: { creds: newer } };
    a.trackSocket(service.client, replacementConfig);
    assert.throws(() => a.writerIsolation(f.source, current, trace()), /writer_isolation_unproved/);
    const replaced = logs.findLast(v => v.event === 'attendance.writer_probe.attestation');
    assert.equal(replaced.status, 'not_observed'); assert.equal(replaced.attestation_present, false);
    for (const value of logs) {
      assert.doesNotMatch(JSON.stringify(value), /DO_NOT_EXPOSE|5511999999999|100001@lid|session_identity|public_material_digest|registration_digest|accountSignature/);
      assert.ok(Object.keys(value).every(key => ['event', 'status', 'trigger', 'registration_present', 'operation', 'correlation',
        'credentials_object_matches', 'attestation_present', 'attestation_session_matches', 'registration_instance_id_matches',
        'registration_instance_name_matches', 'context_current_session', 'context_channel_active', 'context_session_matches',
        'attestation_provenance_valid'].includes(key)));
    }
    console.warn = () => { throw Error('diagnostics failed'); };
    await a.observePublicAccount(replacementConfig, newer, () => true, () => Buffer.from([6, 0]), 'verified_restored_account');
    assert.equal(a.writerIsolation(f.source, current, trace()), true);
  } finally { console.warn = previous; }
});

test('pinned observation patch keeps pairing merged credentials and restored verification point; anchor drift fails closed', async () => {
  const { patchAttendanceAccountObservation: patch } = await import('./patch-attendance-source.mjs');
  const source = `    // device paired for the first time
    ws.on('pair', () => {
            ev.emit('creds.update', updatedCreds);
    });
    ws.on('CB:success', async (node) => {
        try {
            ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } });
        } catch (error) { throw error; }
    });`;
  const result = patch(source), hooks = new Map(), calls = [], originalCreds = credentials(), updatedCreds = { me: { ...originalCreds.me, lid: '100002@lid' } };
  const config = { auth: { creds: originalCreds } }, verify = () => true;
  new Function('ws', 'ev', 'nexiAttendance', 'config', 'authState', 'creds', 'updatedCreds', 'Curve', 'proto',
    'WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX', 'WA_ADV_ACCOUNT_SIG_PREFIX', result)(
    { on: (event, fn) => hooks.set(event, fn) }, { emit: (...args) => calls.push(args) },
    { observePublicAccount: (...args) => calls.push(['observe', ...args]), verifyPublicAccountSignature: verify }, config, { creds: originalCreds },
    originalCreds, updatedCreds, { verify }, { ADVDeviceIdentity: { decode: () => ({ deviceType: 0 }) }, ADVEncryptionType: { HOSTED: 1 } },
    Buffer.from([6, 5]), Buffer.from([6, 0]));
  hooks.get('pair')();
  assert.equal(calls[0][0], 'creds.update');
  assert.equal(calls[1][1], config); assert.equal(calls[1][2].me, updatedCreds.me);
  assert.equal(calls[1][2].account, originalCreds.account); assert.equal(calls[1][3], verify);
  assert.equal(calls[1][5], 'verified_pairing');
  await hooks.get('CB:success')({ attrs: { lid: '100003@lid' } });
  assert.equal(calls[2][0], 'observe'); assert.equal(calls[2][2], originalCreds);
  assert.equal(calls[2][5], 'verified_restored_account'); assert.equal(calls[3][0], 'creds.update');
  assert.throws(() => patch(source.replace('// device paired for the first time', '// drift')), /expected 1, found 0/);
  assert.throws(() => patch(source + '\n' + source), /expected 1, found 2/);
  assert.throws(() => patch(result), /already installed/);
});
test('raw receipt semantics, direction and Groups isolation never invent positive acknowledgement', () => {
  const f = fixture(), key = { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true };
  for (const [type, status] of [[undefined, 'DELIVERY_ACK'], ['sender', 'SERVER_ACK'], ['read', 'READ'], ['read-self', 'READ'], ['played', 'PLAYED'], ['retry', 'UNKNOWN'], [null, 'UNKNOWN'], ['', 'UNKNOWN'], ['new', 'UNKNOWN']])
    assert.equal(a.normalizeReceipt(f.c, { type, t: '1234' }, key, ['ID'])[0].evidence.normalized_status, status);
  assert.equal(a.normalizeReceipt(f.c, { type: 'read' }, { ...key, fromMe: false }, ['ID'])[0].evidence.normalized_status, 'UNKNOWN');
  assert.deepEqual(a.normalizeReceipt(f.c, {}, { ...key, remoteJid: '120363000000000000@g.us' }, ['ID']), []);
  assert.deepEqual([0, 1, 2, 3, 4, 5, -1, 6, '3'].map(a.numericNormalization), ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
});
test('receipt commits before any Message/correlation row; persistent dedupe survives worker recreation and session replacement', async () => {
  const f = fixture(), key = { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true }, attrs = { type: 'sender', t: '1234' };
  const first = a.normalizeReceipt(f.c, attrs, key, ['early-ID'], 1000)[0];
  const journal = await a.append(f.source, f.c, first, limits);
  const repeated = a.normalizeReceipt(f.c, attrs, key, ['early-ID'], 2000)[0];
  assert.equal((await a.append(f.source, f.c, repeated, limits)).id, journal.id);
  assert.equal(f.repo.nexiReceiptJournal.rows.length, 1); assert.equal(f.repo.nexiAttendanceEventOutbox.rows.length, 1);
  assert.equal(journal.evidence.captured_at, 1000); assert.equal(journal.evidence.attempt_id, undefined);
  const newer = { ...f.c, session_identity: 'b'.repeat(64), sender_attestation_id: randomUUID() };
  await a.append(f.source, newer, a.normalizeReceipt(newer, attrs, key, ['early-ID'], 3000)[0], limits);
  assert.equal(f.repo.nexiReceiptJournal.rows.length, 2); assert.equal(journal.evidence.session_identity, f.c.session_identity);
});
test('journal timeout trips sticky managed health and unresolved work stays bounded', async () => {
  const f = fixture(), item = a.normalizeReceipt(f.c, {}, { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true }, ['ID'])[0];
  let finish;
  const worker = new a.ReceiptWorker(f.source, limits, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(await worker.submit(f.c, item), false); assert.equal(worker.unhealthy, true); assert.equal(worker.active, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.repo.nexiAttendanceHealth.rows[0].unhealthy, true);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.active, 0); assert.equal(worker.unhealthy, true);
});
test('bounded queue saturation caps item/byte recovery, and acquisition/statement limits are explicit', async () => {
  const f = fixture(), items = ['A', 'B', 'C', 'D'].map(id => a.normalizeReceipt(f.c, {}, { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true }, [id])[0]);
  const worker = new a.ReceiptWorker(f.source, { ...limits, queueItems: 1 }, () => Promise.reject(new Error('DB unavailable')));
  const active = worker.submit(f.c, items[0]);
  assert.equal(await worker.submit(f.c, items[1]), false); await worker.submit(f.c, items[2]); await worker.submit(f.c, items[3]);
  await active; assert.ok(worker.recovery.size <= 1); assert.ok(worker.recoveryBytes <= limits.recoveryBytes);
  assert.equal(worker.unhealthy, true); assert.throws(() => a.settings({}), /unconfigured/);
  let options; f.repo.$transaction = async (work, opts) => { options = opts; return work(f.repo); };
  await a.append(f.source, f.c, items[0], limits); assert.equal(options.maxWait, limits.acquireMs); assert.ok(options.timeout < limits.deadlineMs);
});
test('real MySQL driver statement deadline destroys only the dedicated receipt connection without MariaDB-only SQL', async () => {
  let destroyed = 0;
  const connection = { query: async () => new Promise(() => {}), execute: async () => 1, destroy() { destroyed++; } };
  const pool = { getConnection: async () => connection };
  const factory = { provider: 'mysql', adapterName: 'synthetic', connect: async () => ({ underlyingDriver: () => pool }) };
  await a.boundedMariaDb(factory, limits).connect();
  const acquired = await pool.getConnection();
  assert.equal(await acquired.execute('bounded insert'), 1);
  await assert.rejects(acquired.query('synthetic stalled COMMIT'), /statement_deadline/);
  assert.equal(destroyed, 1);
  await assert.rejects(a.boundedMariaDb({ connect: async () => ({}) }, limits).connect(), /boundary_changed/);
});
test('outbox retry uses stable UUID/body and fresh signatures; HTTP success alone cannot acknowledge', async () => {
  const f = fixture(), attestation = a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0]));
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  const event = await a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', attestation, a.digest(['obs', attestation.observation_id]));
  const sent = [];
  const fetchImpl = async (_url, opts) => { sent.push(opts); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  await a.drain(f.source, fetchImpl); event.nextAttemptAt = new Date(0); await a.drain(f.source, fetchImpl);
  assert.equal(sent.length, 2); assert.equal(sent[0].body, sent[1].body);
  assert.equal(sent[0].body, a.canonicalBytes(event.body));
  assert.equal(createHash('sha256').update(sent[0].body, 'utf8').digest('hex'), event.fingerprint);
  assert.equal(sent[0].headers['X-Nexi-Event-Id'], event.id); assert.equal(sent[1].headers['X-Nexi-Event-Id'], event.id);
  assert.equal(event.state, 'pending'); assert.equal(event.attempts, 2);
  event.nextAttemptAt = new Date(0);
  await a.drain(f.source, async () => ({ ok: true, status: 200, json: async () => ({ ack: 'persisted', event_id: event.id, fingerprint: event.fingerprint, version: 1 }) }));
  assert.equal(event.state, 'acknowledged'); assert.ok(event.acknowledgedAt);
});
test('unsupported version is retained without HTTP and conflicting outbox identity cannot overwrite', async () => {
  const f = fixture(), attestation = a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0])), key = a.digest('event');
  const row = await a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', attestation, key), original = JSON.stringify(row.body);
  await assert.rejects(a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', { ...attestation, public_material_digest: 'b'.repeat(64) }, key), /identity_conflict/);
  row.version = 2; await a.drain(f.source, () => assert.fail('unsupported must not send'));
  assert.equal(row.state, 'unsupported'); assert.equal(JSON.stringify(row.body), original); assert.equal(f.repo.nexiAttendanceEventOutbox.rows.length, 1);
});

test('legacy canonical records are retained and cannot be silently promoted or prepared', async () => {
  const f = fixture(), row = await a.draft(f.source, f.c, intent(), randomUUID());
  row.canonicalVersion = 'legacy_unversioned';
  await assert.rejects(a.prepare(f.source, row), /canonical_version_unsupported/);
  const attestation = a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0]));
  const event = await a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', attestation, a.digest('legacy-canonical'));
  const original = structuredClone(event.body);
  event.canonicalVersion = 'legacy_unversioned';
  await a.drain(f.source, () => assert.fail('legacy canonical body must not send'));
  assert.equal(event.state, 'unsupported'); assert.deepEqual(event.body, original);
});
test('outbox survives crash after claim; retry ceiling and missing binding retain immutable evidence', async () => {
  const f = fixture(), attestation = a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0]));
  const event = await a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', attestation, a.digest('crash'));
  event.attempts = 12; event.leaseUntil = new Date(0);
  await a.drain(f.source, () => assert.fail('exhausted event must not send'));
  assert.equal(event.state, 'quarantined'); assert.ok(event.body); assert.equal(event.id, f.repo.nexiAttendanceEventOutbox.rows[0].id);
  const second = await a.enqueue(f.repo, f.source, f.c, 'attendance.session.proved', attestation, a.digest('binding'));
  f.repo.webhook.rows[0].enabled = false;
  await a.drain(f.source, () => assert.fail('missing binding must not send'));
  assert.equal(second.state, 'binding_unavailable'); assert.ok(second.body);
});
test('managed classification persists for disabled/deleted bindings; managed imports and READ refuse dedicated IDs', async () => {
  const f = fixture(); f.repo.nexiManagedTransportContext.rows.push({ instanceId: f.source.instanceId, instanceName: f.c.instance, payload: f.c });
  f.repo.webhook.rows.length = 0;
  assert.equal(await a.classification(f.source), 'managed');
  const row = await a.draft(f.source, f.c, intent(), randomUUID());
  for (const operation of ['import_database', 'import_database_source_id', 'conversation_read', 'chatwoot_outbound'])
    assert.equal(await a.legacyAllowed(f.source, operation, row.externalId), false);
  f.repo.instance.rows.length = 0;
  assert.equal(await a.legacyForInstance(f.repo, { instanceName: f.c.instance }, 'conversation_read'), false);
});
test('restart restores exact historical receipt provenance during APP outage without restoring send authority or guessing name continuity', async () => {
  const f = fixture(), config = { auth: { creds: credentials() } }, previousFetch = global.fetch;
  const historical = { ...f.c, channel_state: 'disabled', barrier_state: 'retired', current_session: false };
  f.repo.nexiManagedTransportContext.rows.push({ instanceId: f.source.instanceId, instanceName: f.c.instance,
    sessionIdentity: historical.session_identity, fingerprint: a.digest(historical), payload: historical, canonicalVersion: a.CANONICAL_VERSION });
  f.repo.webhook.rows[0].enabled = false;
  const env = { QUEUE_ITEMS: '2', QUEUE_BYTES: '32768', APPEND_CONCURRENCY: '1', DB_ACQUISITION_TIMEOUT_MS: '5',
    DB_STATEMENT_TIMEOUT_MS: '10', DB_LOCK_TIMEOUT_MS: '5', APPEND_DEADLINE_MS: '100', RECOVERY_ITEMS: '1', RECOVERY_BYTES: '32768' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env['NEXI_ATTENDANCE_' + key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env['NEXI_ATTENDANCE_' + key] = value;
    global.fetch = async () => assert.fail('disabled binding must not request APP');
    await a.configure(f.source, config);
    await a.capture(config, { type: 'read', t: '1234' }, { remoteJid: '5511888888888@s.whatsapp.net', fromMe: true }, ['historical-ID']);
    assert.equal(f.repo.nexiReceiptJournal.rows[0].evidence.session_identity, historical.session_identity);
    assert.equal(f.repo.nexiReceiptJournal.rows[0].evidence.barrier_state, 'retired');
    const ordinary = { tag: 'message', attrs: { id: 'ordinary-customer', to: '5511888888888@s.whatsapp.net' } };
    // An unbound raw stanza is denied before ambiguous classification. Even
    // proven ordinary content cannot recover send authority from receipt history.
    await assert.rejects(a.assertNode(config, ordinary), { code: 'nexi_attendance_unknown_protocol_denied' });
    a.bindStanza(config, ordinary, { conversation: 'synthetic ordinary content' }, ordinary.attrs.id);
    await assert.rejects(a.assertNode(config, a.snapshotFrame(config, ordinary)),
      { code: 'nexi_attendance_classification_unresolved' });
    assert.equal(await a.classification({ ...f.source, instanceId: randomUUID() }), 'managed_unresolved');
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env['NEXI_ATTENDANCE_' + key]; else process.env['NEXI_ATTENDANCE_' + key] = value;
    }
  }
});
test('socket native retry/raw/API forgery cannot reach Attendance wire; protocol, Groups and legacy remain usable', async () => {
  const f = fixture(), config = { auth: { creds: credentials() } }, savedFetch = global.fetch;
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  f.repo.nexiManagedTransportContext.rows.push({ instanceId: f.source.instanceId, instanceName: f.c.instance, payload: f.c });
  global.fetch = async (_url, options) => {
    const data = JSON.parse(options.body).data, claims = Buffer.from(a.canonicalBytes({ ...f.c, nonce: data.nonce })).toString('base64url');
    const secret = createHmac('sha256', master).update(`event:${f.c.instance}`).digest();
    return { ok: true, json: async () => ({ claims, signature: createHmac('sha256', secret).update(`attendance-context:v1:${claims}`).digest('hex') }) };
  };
  try { await a.configure({ ...f.source, instance: { name: f.c.instance } }, config); } finally { global.fetch = savedFetch; }
  const completed = { ...config }; a.inheritConfig(config, completed);
  await assert.rejects(a.assertNode(completed, { tag: 'message', attrs: { id: a.ID_PREFIX + 'RESERVED' } }), /dispatch_disabled/);
  const row = await a.draft(f.source, f.c, intent(), randomUUID());
  assert.equal(await a.retryMessage(config, { id: row.externalId }, { conversation: 'cached' }), undefined);
  await assert.rejects(a.assertNode(config, { tag: 'message', attrs: { id: row.externalId, to: row.recipient, managed: false } }), /dispatch_disabled/);
  assert.throws(() => a.externalRaw(config), /raw_send_denied/);
  const socket = {}; a.trackSocket(socket, config);
  assert.throws(() => a.rawNodeForSocket(socket, { tag: 'message', attrs: { managed: true, capability: 'release' } }), /raw_send_denied/);
  await assert.rejects(a.rawNodeForInstance(f.repo, { instanceName: f.c.instance }, { tag: 'message', attrs: { capability: 'release' } }), /raw_send_denied/);
  await a.assertNode(config, { tag: 'iq', attrs: {} }); await a.assertNode(config, { tag: 'ack', attrs: {} });
  await a.assertNode(config, { tag: 'message', attrs: { id: 'group-existing', to: '120363000000000000@g.us' } });
  const protocol = { tag: 'message', attrs: { id: 'peer-existing', to: '5511999999999@s.whatsapp.net' } };
  const internal = { protocolMessage: { type: 16, peerDataOperationRequestMessage: { peerDataOperationRequestType: 4,
    placeholderMessageResendRequest: [{ messageKey: { remoteJid: row.recipient, fromMe: false, id: 'incoming-original' } }] } } };
  const marked = a.markInternalControl(completed, internal, protocol.attrs.to);
  const encoding = a.beginRelay(completed, protocol.attrs.to, marked, {});
  a.encodeMessage(completed, encoding.message, encoding.message, value => Buffer.from(JSON.stringify(value)));
  a.bindStanza(completed, protocol, encoding.message, 'peer-existing');
  await a.assertNode(completed, protocol);
  const legacy = fixture(); legacy.repo.webhook.rows.length = 0; const legacyConfig = { auth: { creds: credentials() } };
  await a.configure(legacy.source, legacyConfig); assert.equal(await a.classification(legacy.source), 'legacy');
  a.externalRaw(legacyConfig); assert.equal(await a.retryMessage(legacyConfig, { id: 'ordinary' }, 'native'), 'native');
  await a.assertNode(legacyConfig, { tag: 'message', attrs: { id: 'ordinary' } });
  assert.equal(await a.legacyAllowed(legacy.source, 'import_database'), true);
});
test('financial exact recipient and native retry suppression remain enforced; WAID alone is ordinary history', () => {
  const id = financial.relayMessageId(false, 'ordinary', { conversation: 'x' }); assert.equal(id, 'ordinary');
  assert.throws(() => financial.assertWireRecipient('5511888888888@s.whatsapp.net', { attrs: { id: '3EB0F1A9C7D5E3B1AAAA' } }, credentials(), {}, true), /native_retry_denied/);
  assert.equal(transport.financialHistoryDisposition({ event: 'message_created', source_id: 'WAID:ordinary', message_type: 'incoming' }, {}), null);
  assert.equal(transport.financialHistoryDisposition({ event: 'message_created', source_id: 'WAID:ordinary', message_type: 'outgoing' }, {}), null);
  assert.equal(transport.financialHistoryDisposition({ event: 'message_created', source_id: 'WAID:ordinary', message_type: 'incoming', content_attributes: { nexi_managed_delivery: true } }, {}), null);
});
test('unsigned prepare token, forbidden event fields and incompatible versions fail closed', () => {
  assert.throws(() => a.prepareClaims({ instance: { name: 'nexi-wa-test' } }, { managed: true }), /authentication_required/);
  const f = fixture(), attestation = a.publicAttestation(credentials(), () => true, () => Buffer.from([6, 0]));
  const data = { ...a.common(f.c), ...attestation };
  assert.throws(() => a.eventPayload('attendance.session.proved', { ...data, private_key: 'secret' }), /unsupported/);
  assert.throws(() => a.eventPayload('attendance.session.proved', { ...data, version: 2 }), /unsupported/);
  assert.throws(() => a.eventPayload('attendance.session.proved', { ...data, audience: 'browser' }), /invalid/);
});
test('APP preparation authorization signature, immutable session, audience and expiry are mandatory and never release a send', () => {
  const f = fixture(), now = 20000, service = { instanceId: f.source.instanceId, instance: f.source.instance,
    client: { authState: { creds: credentials() } } };
  process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET = master;
  const claims = { version: 1, canonical_version: a.CANONICAL_VERSION, audience: 'nexi-attendance-evolution', provider: 'evolution-baileys', instance: f.c.instance,
    instance_id: f.source.instanceId, managed_channel_id: 3, session_identity: f.c.session_identity, writer_epoch: 1,
    request_id: randomUUID(), expires_at: now + 60000, physical_dispatch: false, intent: intent() };
  const signed = material => {
    const encoded = Buffer.from(a.canonicalBytes(material)).toString('base64url');
    const secret = createHmac('sha256', master).update(`event:${f.c.instance}`).digest();
    return { claims: encoded, signature: createHmac('sha256', secret).update(`attendance-prepare:v1:${encoded}`).digest('hex') };
  };
  assert.deepEqual(a.prepareClaims(service, signed(claims), now), claims);
  // A signed enabled context is valid preparation metadata, never a release.
  const enabledClaims = { ...claims, physical_dispatch: true };
  assert.deepEqual(a.prepareClaims(service, signed(enabledClaims), now), enabledClaims);
  for (const change of [{ physical_dispatch: 'true' }, { physical_dispatch: null }, { session_identity: 'b'.repeat(64) }, { audience: 'browser' }, { expires_at: now }, { writer_epoch: 0 }])
    assert.throws(() => a.prepareClaims(service, signed({ ...claims, ...change }), now), /authentication_required/);
  const forged = signed(claims); forged.signature = '0'.repeat(64);
  assert.throws(() => a.prepareClaims(service, forged, now), /authentication_required/);
});
