'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const a=require('./nexi-attendance.cjs'),authority=require('./nexi-attendance-authority.cjs'),transport=require('./nexi-attendance-dispatch.cjs');
const isolated=require('./nexi-attendance-isolated.cjs'),{fixture,seal,installSocket:socket}=require('./attendance-isolated-test-support.cjs');
const {memory,original}=require('./attendance-authority-test-support.cjs');
function enable(t) {
  const previous={hold:process.env.NEXI_ATTENDANCE_CUTOVER_HOLD,lane:process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED};
  process.env.NEXI_ATTENDANCE_CUTOVER_HOLD='true';process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='true';
  t.after(()=>{for(const [key,value] of [['NEXI_ATTENDANCE_CUTOVER_HOLD',previous.hold],['NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED',previous.lane]])
    if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

test('Ruby/Evolution golden operation has the same exact fields and canonical digests',t=>{
  enable(t);const f=require('./fixtures/attendance-isolated-v1.json');
  assert.deepEqual(isolated.validate(f.token,f.now),f.token);
  assert.deepEqual(isolated.intent(f.source,f.context,f.intent,f.now),f.token);
  assert.deepEqual(isolated.grant(f.source,{authority:f.context,intent:f.intent},f.material,f.now),f.token);
  assert.throws(()=>isolated.validate({...f.token,extra:true},f.now));
});

test('HOLD remains global even if an old boot release file exists',t=>{
  const env={NEXI_ATTENDANCE_CUTOVER_HOLD:'true',NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED:'true',
    NEXI_ATTENDANCE_CUTOVER_BOOT_ID:'aaaaaaaa-1111-4111-8111-111111111111'};
  assert.equal(a.cutoverHeld(env,()=>env.NEXI_ATTENDANCE_CUTOVER_BOOT_ID+'\n'),true);
  assert.equal(isolated.enabled({...env,NEXI_ATTENDANCE_CUTOVER_HOLD:'false'}),false);
});

test('one signed, frozen operation traverses consume and the real lexical CAS once under HOLD',async t=>{
  enable(t);const f=fixture();
  const signed=a.signEnvelope(f.source,f.claims,'attendance-authority');
  assert.equal(authority.claims(f.source,signed,f.repo.now).material.grant.isolated_operation.authorization_id,f.token.authorization_id);
  await authority.consumption(f.source,f.claims);const s=await socket(f,t);
  const result=await transport.dispatch(f.source,f.claims.material);
  assert.equal(s.writes,1);assert.equal(result.outcome_unknown,true);assert.equal(a.cutoverHeld(),true);
  await transport.dispatch(f.source,f.claims.material);assert.equal(s.writes,1);
});

test('ten thousand old queued operations cannot inherit the scoped authorization',async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);const s=await socket(f,t);
  const old=memory(),request=original();let reads=0;
  old.repo.nexiAttendancePreparation.findUnique=async()=>{reads++;throw Error('BACKLOG_WAS_READ');};
  for(let i=0;i<10000;i++) await assert.rejects(authority.consumption(old.source,request),/cutover_held/);
  assert.equal(reads,0);assert.equal(old.repo.trace.length,0);
  await transport.dispatch(f.source,f.claims.material);assert.equal(s.writes,1);
});

for(const [field,value] of [['execution_id','ff000000-1111-4111-8111-111111111111'],['identity_version_id',999],
  ['recipient_digest','0'.repeat(64)],['payload_digest','0'.repeat(64)],['message_id',999],['transport_unit_index',1]])
test(`incompatible ${field} never consumes or writes`,async t=>{
  enable(t);const f=fixture();
  if(field==='transport_unit_index')f.claims.material.grant[field]=value;else f.claims.material.grant.isolated_operation={...f.token,[field]:value};
  seal(f);await assert.rejects(authority.consumption(f.source,f.claims));assert.equal(f.repo.row().consumptionId,null);
});

for(const fault of ['missing','expired','unconsumed','disabled','wrong_hold'])test(`${fault} authorization cannot start a physical operation`,async t=>{
  enable(t);const f=fixture();
  if(fault==='missing'){delete f.claims.material.grant.isolated_operation;delete f.repo.row().authority.isolated_operation;}
  if(fault==='expired')f.repo.now=f.token.expires_at+1;
  if(fault==='unconsumed')f.token.message_id=null;
  if(fault==='disabled')process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='false';
  if(fault==='wrong_hold')process.env.NEXI_ATTENDANCE_CUTOVER_HOLD='false';
  seal(f);await assert.rejects(authority.consumption(f.source,f.claims));assert.equal(f.repo.row().consumptionId,null);
});

test('two concurrent workers reach the physical boundary at most once',async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);const s=await socket(f,t);
  await Promise.allSettled([transport.dispatch(f.source,f.claims.material),transport.dispatch(f.source,f.claims.material)]);
  assert.equal(s.writes,1);
});

test('lost response after dispatch-start remains UNKNOWN and restart cannot repeat the write',async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);const s=await socket(f,t,{failure:true});
  const result=await transport.dispatch(f.source,f.claims.material);assert.equal(result.state,'outcome_unknown');assert.equal(s.writes,1);
  f.repo.now=f.token.expires_at+100;process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='false';
  assert.equal((await authority.consumption(f.source,{...f.claims,action:'consumption_readback'})).dispatch_started_at,result.dispatch_started_at);
  await transport.dispatch(f.source,f.claims.material);assert.equal(s.writes,1);
});

test('crash before dispatch-start retains the same operation and can retry one physical CAS',async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);const s=await socket(f,t,{beforeBoundary:true});
  await assert.rejects(transport.dispatch(f.source,f.claims.material),/CRASH_BEFORE_CAS/);assert.equal(s.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);
  await transport.dispatch(f.source,f.claims.material);assert.equal(s.writes,1);assert.ok(f.repo.row().dispatchStartedAt);
});

test('a changed signed envelope cannot authorize an isolated grant',t=>{
  enable(t);const f=fixture(),envelope=a.signEnvelope(f.source,f.claims,'attendance-authority');
  const changed=structuredClone(f.claims);changed.material.grant.isolated_operation.recipient_digest='0'.repeat(64);
  envelope.claims=Buffer.from(a.canonicalBytes(changed)).toString('base64url');
  assert.throws(()=>authority.claims(f.source,envelope),/authentication|invalid/);assert.equal(f.repo.trace.length,0);
});

for(const failure of ['badGuard','badIndex','failCommit'])test(`storage ${failure} never reaches the wire`,async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);const s=await socket(f,t);f.repo[failure]=true;
  await assert.rejects(transport.dispatch(f.source,f.claims.material));assert.equal(s.writes,0);
});

test('changed fresh writer context cannot borrow a previously frozen authorization',async t=>{
  enable(t);const f=fixture();await authority.consumption(f.source,f.claims);
  const s=await socket(f,t,{context:value=>({...value,isolated_operation:{...value.isolated_operation,authorization_id:'ff000000-1111-4111-8111-111111111111'}})});
  await assert.rejects(transport.dispatch(f.source,f.claims.material));assert.equal(s.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);
});

function enableComposer(t) {
  enable(t);const previous=process.env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED;
  process.env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED='true';
  t.after(()=>{if(previous===undefined)delete process.env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED;
    else process.env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED=previous;});
}
function composerFixture(index,recipient='5511999999999@s.whatsapp.net') {
  const f=fixture(),row=f.repo.row(),g=f.claims.material.grant,r=f.claims.material.release;
  const {randomUUID}=require('node:crypto');
  const contact=recipient.startsWith('5581')?2:1;
  Object.assign(f.token,{protocol:isolated.COMPOSER_PROTOCOL,authorization_id:randomUUID(),request_id:randomUUID(),
    execution_id:randomUUID(),message_id:100+index,conversation_id:200+contact,contact_id:300+contact,contact_inbox_id:400+contact,
    identity_slot_id:500+contact,identity_version_id:600+contact,recipient_digest:a.digest({recipient})});
  row.id=randomUUID();row.executionId=f.token.execution_id;row.intent.execution_id=row.executionId;
  row.recipient=recipient;row.intent.recipient=recipient;row.intent.identity_version_id=f.token.identity_version_id;
  row.requestId=randomUUID();row.attemptId=randomUUID();row.reservationId=randomUUID();row.externalId='COMPOSER_'+index;
  Object.assign(g,{grant_id:randomUUID(),admission_id:randomUUID(),request_id:randomUUID(),message_id:f.token.message_id,
    execution_id:row.executionId,identity_version_id:f.token.identity_version_id,attempt_id:row.attemptId,reservation_id:row.reservationId,
    preparation_id:row.id,external_id:row.externalId});
  Object.assign(r,{release_id:randomUUID(),request_id:randomUUID(),grant_id:g.grant_id,attempt_id:row.attemptId,
    reservation_id:row.reservationId,preparation_id:row.id,external_id:row.externalId});
  f.claims.material.consumption_id=randomUUID();f.claims.request_id=f.claims.material.consumption_id;seal(f);return f;
}
function selectOperation(repo,value) {
  const row=repo.row();for(const key of Object.keys(row))delete row[key];
  Object.assign(row,structuredClone(value));
}

test('composer: consecutive and alternating recipients share one socket/epoch with independent one-use operations',async t=>{
  enableComposer(t);const f=composerFixture(0),saved=[];
  const socket=await require('./attendance-isolated-test-support.cjs').installSocket(f,t,{context:(_,request)=>{
    const value={...f.repo.row().authority},token=value.isolated_operation;
    if(request.isolated_authorization_id===token.authorization_id)return value;
    delete value.isolated_operation;return {...value,physical_dispatch:false};
  }});
  for(const [index,recipient] of ['5511999999999@s.whatsapp.net','5511999999999@s.whatsapp.net',
    '5581888888888@s.whatsapp.net','5511999999999@s.whatsapp.net'].entries()) {
    const operation=index===0?f:composerFixture(index,recipient);
    if(index)selectOperation(f.repo,operation.repo.row());
    const claims=operation.claims;
    await authority.consumption(f.source,claims);
    const result=await transport.dispatch(f.source,claims.material);
    assert.equal(result.outcome_unknown,true);assert.equal(socket.writes,index+1);
    await transport.dispatch(f.source,claims.material);assert.equal(socket.writes,index+1);
    saved.push({row:structuredClone(f.repo.row()),claims});
    assert.equal(a.cutoverHeld(),true);
  }
  selectOperation(f.repo,saved[0].row);
  await transport.dispatch(f.source,saved[0].claims.material);assert.equal(socket.writes,4);
  assert.equal(new Set(saved.map(item=>item.row.authority.writer_epoch)).size,1);
  assert.equal(new Set(saved.map(item=>item.row.authority.isolated_operation.authorization_id)).size,4);
  const requests=f.socketRegistration.requests.filter(item=>item.isolated_authorization_id);
  assert.deepEqual(requests.map(item=>item.isolated_authorization_id),saved.map(item=>item.row.authority.isolated_operation.authorization_id));
});

test('composer: disabling only the new lane blocks a V2 operation without opening legacy dispatch',async t=>{
  enableComposer(t);const f=composerFixture(0);
  process.env.NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED='false';
  await assert.rejects(authority.consumption(f.source,f.claims));
  assert.equal(f.repo.row().consumptionId,null);assert.equal(a.cutoverHeld(),true);
});

test('composer: signed operations consume independently and cannot borrow another message grant',async t=>{
  enableComposer(t);const first=composerFixture(0),second=composerFixture(1,'5581888888888@s.whatsapp.net');
  for(const f of [first,second]) {
    const envelope=a.signEnvelope(f.source,f.claims,'attendance-authority');
    const claims=authority.claims(f.source,envelope,f.repo.now);
    await authority.consumption(f.source,claims);
    assert.equal(f.repo.row().consumptionId,f.claims.material.consumption_id);
    assert.equal(f.repo.row().dispatchStartedAt,null);
  }
  assert.throws(()=>isolated.grant(first.source,first.repo.row(),second.claims.material,first.repo.now));
  assert.equal(first.repo.row().authority.writer_epoch,second.repo.row().authority.writer_epoch);
  assert.equal(a.cutoverHeld(),true);
});

test('composer: another operation context between dispatch CAS and commit does not burn an unsent message',async t=>{
  enableComposer(t);const f=composerFixture(0),other=composerFixture(1).token;
  await authority.consumption(f.source,f.claims);
  const socket=await require('./attendance-isolated-test-support.cjs').installSocket(f,t,{context:(_,request)=>{
    const value={...f.repo.row().authority};
    if(request.isolated_authorization_id===f.token.authorization_id)return value;
    if(request.isolated_authorization_id===other.authorization_id)return {...value,isolated_operation:other};
    delete value.isolated_operation;return {...value,physical_dispatch:false};
  }});
  const transaction=f.repo.$transaction.bind(f.repo);let interleaved=false,otherSnapshot;
  f.repo.$transaction=(work,...args)=>transaction(async tx=>{
    const result=await work(tx);
    if(!interleaved && f.repo.row().dispatchStartedAt) {
      interleaved=true;
      const owner=require('./nexi-groups.cjs').lifecycleCapture(f.source.service);
      otherSnapshot=await a.captureContextSnapshot(f.source,owner,null,other.authorization_id);
      a.installCaptureContext(otherSnapshot);
    }
    return result;
  },...args);
  await transport.dispatch(f.source,f.claims.material);
  assert.equal(interleaved,true);assert.equal(socket.writes,1);
  assert.equal(otherSnapshot.registration.context.isolated_operation,undefined);
  assert.equal(otherSnapshot.registration.context.physical_dispatch,false);
  assert.equal(a.captureContextCurrent(otherSnapshot,true),true);
});

test('composer: partial or misspelled enablement fails closed',()=>{
  for(const flag of ['true','TRUE','typo']) {
    const env={NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED:flag,NEXI_ATTENDANCE_CUTOVER_HOLD:'false'};
    assert.equal(a.cutoverHeld(env),true);assert.throws(()=>a.assertConfiguration(env),/composer_configuration_invalid/);
  }
});
