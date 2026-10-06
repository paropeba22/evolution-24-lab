'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const a=require('./nexi-attendance.cjs');
const authority=require('./nexi-attendance-authority.cjs');
const storage=require('./nexi-attendance-storage-guard.cjs');
const {fixture,catalog,memory,original}=require('./attendance-authority-test-support.cjs');
const changed=m=>{m.grant_digest=a.digest(m.grant);m.release.grant_digest=m.grant_digest;m.release.request_digest=a.digest({admission_id:m.grant.admission_id,grant_id:m.grant.grant_id,grant_digest:m.grant_digest,attempt_id:m.grant.attempt_id,reservation_id:m.grant.reservation_id});m.release_digest=a.digest(m.release);return m;};
const consume=f=>authority.consumption(f.source,original());
const stanza=f=>({tag:'message',attrs:{id:f.repo.row().externalId,to:f.repo.row().recipient}});
test('APP-produced canonical grant/release/signature validate in Evolution',()=>{
  const f=memory(),c=authority.claims(f.source,fixture.envelope,fixture.now);
  assert.deepEqual(authority.material(c.material),fixture.material);assert.equal(a.digest(c.material),fixture.request_digest);
  assert.equal(a.signEnvelope(f.source,c,'attendance-authority').signature,fixture.envelope.signature);
});
test('signature and body substitution fail authentication',()=>{
  const f=memory();assert.throws(()=>authority.claims(f.source,{...fixture.envelope,signature:'0'.repeat(64)},fixture.now));
  const c=original();c.material.grant.external_id='other';const e={...fixture.envelope,claims:Buffer.from(a.canonicalBytes(c)).toString('base64url')};
  assert.throws(()=>authority.claims(f.source,e,fixture.now));
});
for(const [key,value] of [['audience','wrong'],['version',2],['protocol_version',2],['canonical_version','wrong'],['instance','wrong'],['instance_id','wrong'],['physical_dispatch',true],['request_id','bad'],['expires_at',fixture.now]])
  test(`wrong ${key} fails signed authority validation`,()=>{const f=memory(),c=original();c[key]=value;assert.throws(()=>authority.claims(f.source,a.signEnvelope(f.source,c,'attendance-authority'),fixture.now));});
test('exact released grant consumes once and exact replay returns durable original',async()=>{
  const f=memory(),first=await consume(f),revision=f.repo.row().revision;
  assert.equal(first.state,'dispatch_ready_but_disabled');assert.equal(first.physical_dispatch,false);
  assert.deepEqual(await consume(f),first);assert.equal(f.repo.row().revision,revision);assert.equal(f.repo.row().dispatchStartedAt,null);
});
test('response-loss readback survives restart and expired release without a second consume',async()=>{
  const f=memory();const result=await consume(f);f.repo.now=fixture.now+100000;
  const c=original();c.action='consumption_readback';const restarted={...f.source};
  assert.deepEqual(await authority.consumption(restarted,c),result);assert.equal(f.repo.trace.filter(x=>x==='dispatch_ready_but_disabled').length,1);
});
for(const key of ['attempt_id','reservation_id','external_id','preparation_id','execution_id','preparation_digest','instance_lineage_id','sender_account_lineage_id','session_identity','writer_epoch','binding_generation'])
  test(`wrong ${key} cannot consume`,async()=>{const f=memory(),c=original();c.material.grant[key]=typeof c.material.grant[key]==='number'?8:key.includes('digest')||key==='session_identity'?'0'.repeat(64):'88888888-1111-4111-8111-111111111111';
    if(key in c.material.release)c.material.release[key]=c.material.grant[key];changed(c.material);await assert.rejects(authority.consumption(f.source,c));assert.equal(f.repo.row().consumptionId,null);});
test('same request UUID changed body and conflicting grant/release/consumption replay fail closed',async()=>{
  for(const change of [m=>m.grant.message_id++,m=>m.grant.grant_id='88888888-1111-4111-8111-111111111111',m=>m.release.release_id='88888888-1111-4111-8111-111111111111',m=>m.consumption_id='88888888-1111-4111-8111-111111111111']){
    const f=memory();await consume(f);const c=original();change(c.material);c.material.release.grant_id=c.material.grant.grant_id;changed(c.material);c.request_id=c.material.consumption_id;
    await assert.rejects(authority.consumption(f.source,c));assert.equal(f.repo.row().consumptionDigest,fixture.request_digest);
  }
});
for(const state of ['denied','revoked','expired','open'])test(`no committed release (${state}) denies consumption`,async()=>{
  const f=memory(),c=original();c.material.release.decision=state;changed(c.material);await assert.rejects(authority.consumption(f.source,c));
});
test('expired unconsumed grant/release denies while readback remains UNKNOWN',async()=>{
  const f=memory();f.repo.now=fixture.now+60000;await assert.rejects(consume(f));
  const c=original();c.action='consumption_readback';assert.equal((await authority.consumption(f.source,c)).state,'unresolved');
});
for(const fault of ['failStorage','failCommit','badGuard','badIndex'])test(`${fault} blocks durable consumption and dispatch eligibility`,async()=>{
  const f=memory();f.repo[fault]=true;await assert.rejects(consume(f));assert.equal(f.repo.row().consumptionId,null);assert.equal(f.repo.row().dispatchStartedAt,null);
});
test('CAS commits before a hypothetical fake write and second CAS never writes',async()=>{
  const f=memory();await consume(f);f.repo.trace.length=0;let writes=0;
  const boundary=async()=>{const cas=await authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,stanza(f));if(cas.started){assert.equal(f.repo.trace.at(-1),'committed');writes++;f.repo.trace.push('FAKE_WRITE');}};
  await boundary();await boundary();assert.equal(writes,1);assert.deepEqual(f.repo.trace.slice(0,3),['dispatch_started','committed','FAKE_WRITE']);
});
test('unconsumed, expired, wrong stanza, changed socket or storage gap deny dispatch CAS',async()=>{
  let f=memory();await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,stanza(f)));
  for(const mutate of [f=>f.repo.now=fixture.now+15000,f=>f.source.service.client.authState.creds.registrationId++,f=>f.repo.failStorage=true,f=>f.source.service.endSession=true]){
    f=memory();await consume(f);mutate(f);await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,stanza(f)));assert.equal(f.repo.row().dispatchStartedAt,null);
  }
  f=memory();await consume(f);await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,{tag:'message',attrs:{id:'other',to:f.repo.row().recipient}}));
});
test('crash after CAS preserves UNKNOWN through restart and never resends',async()=>{
  const f=memory();await consume(f);await authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,stanza(f));
  assert.equal(f.repo.row().outcomeUnknown,true);const restart={...f.source};assert.deepEqual(await authority.dispatchStart(restart,f.repo.row().id,fixture.material.consumption_id,stanza(f)),{started:false,outcome_unknown:true});
});
for(const succeeded of [true,false])test(`transport return ${succeeded} keeps UNKNOWN and never synthesizes SERVER_ACK/not-sent`,async()=>{
  const f=memory();await consume(f);await authority.dispatchStart(f.source,f.repo.row().id,fixture.material.consumption_id,stanza(f));
  const row=await authority.transportReturned(f.source,f.repo.row().id,fixture.material.consumption_id,succeeded);
  assert.equal(row.outcomeUnknown,true);assert.equal(row.state,succeeded?'transport_returned':'outcome_unknown');assert.equal(JSON.stringify(row.transportReturn).includes('ACK'),false);
  assert.equal((await authority.dispatchStart(f.source,row.id,fixture.material.consumption_id,stanza(f))).started,false);
});
test('production gate is false and even exact consumed capability never calls work/sendNode',async()=>{
  const f=memory();await consume(f);let calls=0;assert.equal(authority.physicalDispatchEnabled(),false);
  const result=await a.releasedGrantCapability(f.source,f.repo.row().id,fixture.material.consumption_id,()=>{calls++;throw Error('REAL_WRITE_TRAP');});
  assert.equal(result.physical_dispatch,false);assert.equal(calls,0);assert.equal(f.repo.row().dispatchStartedAt,null);
  await assert.rejects(a.assertNode({},stanza(f))); // Dedicated external ID remains denied universally.
});
test('provider migrations pin original immutability plus one-way authority transitions',async()=>{
  for(const provider of ['postgresql','mysql']){
    const rows=catalog(provider);assert.equal(rows.length,Object.keys(storage.PINNED[provider]).length);
    for(const r of rows)assert.equal(storage.fingerprint(r.source),storage.PINNED[provider][r.name]);
    const f=memory();await storage.verify(f.repo,provider);
    const sql=fs.readFileSync(__dirname+`/prisma/${provider}-migrations/20261006000000_attendance_release_dispatch/migration.sql`,'utf8');
    assert.match(sql,/dispatch_started/);assert.match(sql,/consumption_write_once/);assert.match(sql,/dispatch_order/);
    assert.ok(!sql.includes("OLD.state='dispatch_started' AND NEW.state IN ('prepared'"));
  }
});
test('actual pinned lexical sendNode and production guard never reach managed raw write',async()=>{
  const fixture=JSON.parse(fs.readFileSync(__dirname+'/fixtures/baileys-send-node-rc13.json','utf8'));
  assert.equal(require('node:crypto').createHash('sha256').update(fixture.source).digest('hex'),fixture.source_sha256);
  const {patchAttendanceSendNode}=await import(pathToFileURL(__dirname+'/patch-attendance-source.mjs'));
  const patched=patchAttendanceSendNode(fixture.source);
  require('./assert-protected-send-node.cjs')(patched+'    /**\n     * Wait for a message with a certain tag');
  let rawWrites=0,encoded=0;
  const boundary=new Function('config','nexiAttendance','logger','binaryNodeToString','encodeBinaryNode','sendRawMessage',patched+'\nreturn sendNode;')(
    {},a,{level:'silent'},()=>'',()=>{encoded++;return Buffer.alloc(0);},()=>{rawWrites++;throw Error('REAL_WRITE_TRAP');});
  const f=memory();await assert.rejects(boundary(stanza(f)));assert.equal(encoded,0);assert.equal(rawWrites,0);
  const source=a.assertNode.toString();assert.ok(source.indexOf('physicalDispatchEnabled')<source.indexOf('await authority.dispatchStart'));
  assert.match(source,/if \(!started.started\)/);
});
test('preparation readback is exact, durable and does not allocate replacement',async()=>{
  const f=memory(),row=f.repo.row(),value={request_id:row.requestId,material:{execution_id:row.executionId,transport_unit:row.transportUnit,prepare_request_id:row.requestId,preparation_id:row.id,attempt_id:row.attemptId}};
  assert.equal((await authority.preparationReadback(f.source,value)).preparation_id,row.id);assert.equal(row.revision,2);
  const wrong=structuredClone(value);wrong.request_id=wrong.material.prepare_request_id='88888888-1111-4111-8111-111111111111';
  await assert.rejects(authority.preparationReadback(f.source,wrong));
  value.material.attempt_id='88888888-1111-4111-8111-111111111111';await assert.rejects(authority.preparationReadback(f.source,value));
});
test('preparation readback response uses the same canonical signed boundary',async()=>{
  const f=memory(),row=f.repo.row(),value={action:'preparation_readback',request_id:row.requestId,
    material:{execution_id:row.executionId,transport_unit:row.transportUnit,prepare_request_id:row.requestId,preparation_id:row.id,attempt_id:row.attemptId}};
  const result={...await authority.preparationReadback(f.source,value),request_digest:a.digest(value.material)};
  const signed=authority.response(f.source,value,result,fixture.now);
  const response=a.verifyEnvelope(f.source,signed,'attendance-authority',32768);
  assert.equal(response.action,'preparation_result');assert.equal(response.audience,'nexi-attendance-app');
  assert.equal(response.request_id,row.requestId);assert.deepEqual(response.material,result);
});
