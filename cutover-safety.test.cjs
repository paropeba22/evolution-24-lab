'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const attendance=require('./nexi-attendance.cjs');
const authority=require('./nexi-attendance-authority.cjs');
const dispatch=require('./nexi-attendance-dispatch.cjs');
const fs=require('node:fs'),vm=require('node:vm');
const {memory,original}=require('./attendance-authority-test-support.cjs');

function hold(t,value) {
  const previous=process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  if(value===undefined)delete process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  else process.env.NEXI_ATTENDANCE_CUTOVER_HOLD=value;
  t.after(()=>{if(previous===undefined)delete process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
    else process.env.NEXI_ATTENDANCE_CUTOVER_HOLD=previous;});
}
async function consumed(t) {
  hold(t,'false');
  const f=memory(),c=original(),g=c.material.grant,row=f.repo.row();
  Object.assign(row.authority,{physical_dispatch:true,isolation_cutover:true,barrier_state:'active',writer_protocol_version:2});
  row.contentDigest=attendance.digest({intent:row.intent,attempt_id:row.attemptId,reservation_id:row.reservationId,
    external_id:row.externalId,authority:row.authority});
  row.preparationDigest=attendance.digest({content_digest:row.contentDigest,authority_digest:row.authorityDigest,
    preparation_id:row.id,nonce:row.preparationNonce,revision:row.preparationRevision});
  Object.assign(g,{scope:'attendance_dispatch_v1',physical_dispatch:true,
    preparation_digest:row.preparationDigest,prepared_content_digest:row.contentDigest});
  c.physical_dispatch=true;c.material.grant_digest=attendance.digest(g);
  const r=c.material.release;r.grant_digest=c.material.grant_digest;r.preparation_digest=g.preparation_digest;
  r.request_digest=attendance.digest({admission_id:g.admission_id,grant_id:g.grant_id,grant_digest:r.grant_digest,
    attempt_id:g.attempt_id,reservation_id:g.reservation_id});
  c.material.release_digest=attendance.digest(r);
  await authority.consumption(f.source,c);
  return {...f,c};
}
async function route(f,action) {
  let handler;
  authority.installRoute({post(_path,_guard,callback){handler=callback;}},
    {waInstances:{[f.source.instance.name]:f.source.service}},()=>{},
    {...f.repo,instance:{findUnique:async()=>({id:f.source.instanceId,name:f.source.instance.name})}});
  const c={...f.c,action,expires_at:Date.now()+60000};
  const body=attendance.signEnvelope(f.source,c,'attendance-authority');
  const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;},sendStatus(value){this.statusCode=value;return this;}};
  await handler({params:{instanceName:f.source.instance.name},body},res);
  return res;
}
test('operational hold fails closed on malformed values and preserves default behavior',()=>{
  assert.equal(attendance.cutoverHeld({}),false);
  assert.equal(attendance.cutoverHeld({NEXI_ATTENDANCE_CUTOVER_HOLD:'false'}),false);
  for(const value of ['true','','0','FALSE','typo'])assert.equal(attendance.cutoverHeld({NEXI_ATTENDANCE_CUTOVER_HOLD:value}),true);
});
test('only an exact release of the current boot opens true hold without a restart',()=>{
  const boot='12345678-1234-4123-8123-123456789abc';
  const env={NEXI_ATTENDANCE_CUTOVER_HOLD:'true',NEXI_ATTENDANCE_CUTOVER_BOOT_ID:boot};
  assert.equal(attendance.cutoverHeld(env,file=>{
    assert.equal(file,`/tmp/nexi-attendance-cutover-${boot}.release`);return `${boot}\n`;
  }),false);
  assert.equal(attendance.cutoverHeld(env,()=>{throw Error('missing');}),true);
  assert.equal(attendance.cutoverHeld(env,()=>`${boot}`),true);
  assert.equal(attendance.cutoverHeld({...env,NEXI_ATTENDANCE_CUTOVER_BOOT_ID:'12345678-1234-4123-8123-123456789abd'},()=>`${boot}\n`),true);
  assert.equal(attendance.cutoverHeld({...env,NEXI_ATTENDANCE_CUTOVER_HOLD:'typo'},()=>`${boot}\n`),true);
  assert.equal(attendance.cutoverHeld({...env,NEXI_ATTENDANCE_CUTOVER_BOOT_ID:'../escape'},()=>assert.fail('invalid boot read a file')),true);
});
test('release utility writes atomically for approved boot and rejects mismatched boot or PID1',()=>{
  const source=fs.readFileSync(__dirname+'/ops/s12-release-current-boot.cjs','utf8');
  const boot='12345678-1234-4123-8123-123456789abc';
  function run(current,comm='node\n'){
    const writes=[];
    const fake={readFileSync(file){
      if(file==='/tmp/nexi-attendance-cutover-current.json')return JSON.stringify(current);
      if(file==='/proc/1/comm')return comm;
      assert.fail('utility read an unexpected file');
    },writeFileSync(...args){writes.push(['write',...args]);},renameSync(...args){writes.push(['rename',...args]);},existsSync(){return false;}};
    const context={process:{argv:['node','release.cjs',boot],pid:99},console:{log(){}},require(name){assert.equal(name,'node:fs');return fake;}};
    return {writes,execute:()=>vm.runInNewContext(source,context)};
  }
  const valid=run({boot_id:boot,hold:true});valid.execute();
  assert.equal(valid.writes.length,2);
  assert.equal(valid.writes[0][2],`${boot}\n`);assert.equal(valid.writes[0][3].mode,0o600);
  assert.equal(valid.writes[1][2],`/tmp/nexi-attendance-cutover-${boot}.release`);
  for(const entry of [run({boot_id:'stale',hold:true}),run({boot_id:boot,hold:false}),run({boot_id:boot,hold:true},'tini\n')]){
    assert.throws(entry.execute,/STOP/);assert.deepEqual(entry.writes,[]);
  }
});
test('held consume/dispatch/wire cannot read storage, commit consumption or reach a send',async t=>{
  hold(t,'true');
  const source=new Proxy({}, {get(){assert.fail('held operation touched storage or service');}});
  await assert.rejects(authority.consumption(source,{action:'consume'}),{code:'nexi_attendance_cutover_held'});
  await assert.rejects(dispatch.dispatch(source,{}),{code:'nexi_attendance_cutover_held'});
  await assert.rejects(attendance.assertNode({}, {tag:'message',attrs:{to:'synthetic'}}),{code:'nexi_attendance_cutover_held'});
  await attendance.assertNode({}, {tag:'receipt'});
});
test('HTTP readback of consumed, physically eligible grant never dispatches',async t=>{
  const f=await consumed(t),before=structuredClone(f.repo.row());
  const originalDispatch=dispatch.dispatch;let calls=0;
  dispatch.dispatch=async()=>{calls++;throw Error('READBACK_DISPATCH_FORBIDDEN');};
  t.after(()=>{dispatch.dispatch=originalDispatch;});
  const res=await route(f,'consumption_readback');
  assert.equal(calls,0);
  assert.equal(res.statusCode,200);assert.deepEqual(f.repo.row(),before);
  const result=attendance.verifyEnvelope(f.source,res.body,'attendance-authority');
  assert.equal(result.material.state,'dispatch_ready_but_disabled');
  assert.equal(result.material.physical_dispatch,true); // Original grant fact is retained.
});
test('held HTTP readback retains historical facts; consume and writer probe are refused',async t=>{
  const f=await consumed(t),before=structuredClone(f.repo.row());process.env.NEXI_ATTENDANCE_CUTOVER_HOLD='true';
  assert.equal((await route(f,'consumption_readback')).statusCode,200);
  assert.equal((await route(f,'consume')).statusCode,422);
  const probe={...f,c:{...f.c,physical_dispatch:false,material:{managed_channel_id:1,session_identity:f.repo.row().sessionIdentity}}};
  assert.equal((await route(probe,'writer_probe')).statusCode,422);
  assert.deepEqual(f.repo.row(),before);
});
test('expired consumed grant readback produces locked expiry evidence without dispatch',async t=>{
  const f=await consumed(t),before=structuredClone(f.repo.row());
  f.repo.now=f.c.material.release.deadline+1;
  const res=await route(f,'consumption_readback');
  assert.equal(res.statusCode,200);
  assert.equal(attendance.verifyEnvelope(f.source,res.body,'attendance-authority').material.state,'release_expired_before_dispatch');
  assert.deepEqual(f.repo.row(),before);
});
test('HTTP readback of physical UNKNOWN preserves evidence and never retries',async t=>{
  const f=await consumed(t);
  Object.assign(f.repo.row(),{state:'outcome_unknown',dispatchStartedAt:new Date(f.repo.now),outcomeUnknown:true});
  const before=structuredClone(f.repo.row()),originalDispatch=dispatch.dispatch;
  dispatch.dispatch=async()=>assert.fail('UNKNOWN was physically retried');
  t.after(()=>{dispatch.dispatch=originalDispatch;});
  const res=await route(f,'consumption_readback');
  assert.equal(res.statusCode,200);assert.deepEqual(f.repo.row(),before);
  const result=attendance.verifyEnvelope(f.source,res.body,'attendance-authority').material;
  assert.equal(result.outcome_unknown,true);assert.equal(result.state,'outcome_unknown');
});
test('consume retains physical path only when explicitly unheld',async t=>{
  const f=await consumed(t),originalDispatch=dispatch.dispatch;let calls=0;
  dispatch.dispatch=async()=>{calls++;return authority.result(f.repo.row(),f.c.material);};
  t.after(()=>{dispatch.dispatch=originalDispatch;});
  assert.equal((await route(f,'consume')).statusCode,200);assert.equal(calls,1);
});
