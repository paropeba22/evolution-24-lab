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
