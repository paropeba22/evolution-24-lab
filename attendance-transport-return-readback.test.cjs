'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const a=require('./nexi-attendance.cjs'), authority=require('./nexi-attendance-authority.cjs');
const dispatch=require('./nexi-attendance-dispatch.cjs');
const {memory,original}=require('./attendance-authority-test-support.cjs');

async function persisted(succeeded=true) {
  const f=memory(), row=f.repo.row(), claims=original(), g=claims.material.grant;
  Object.assign(row.authority,{barrier_state:'active',physical_dispatch:true,isolation_cutover:true,writer_protocol_version:2});
  row.contentDigest=a.digest({intent:row.intent,attempt_id:row.attemptId,reservation_id:row.reservationId,
    external_id:row.externalId,authority:row.authority});
  row.preparationDigest=a.digest({content_digest:row.contentDigest,authority_digest:row.authorityDigest,
    preparation_id:row.id,nonce:row.preparationNonce,revision:row.preparationRevision});
  Object.assign(g,{scope:'attendance_dispatch_v1',physical_dispatch:true,preparation_digest:row.preparationDigest,
    prepared_content_digest:row.contentDigest});
  claims.physical_dispatch=true;claims.material.grant_digest=a.digest(g);
  const r=claims.material.release;r.preparation_digest=g.preparation_digest;r.grant_digest=claims.material.grant_digest;
  r.request_digest=a.digest({admission_id:g.admission_id,grant_id:g.grant_id,grant_digest:r.grant_digest,
    attempt_id:g.attempt_id,reservation_id:g.reservation_id});
  claims.material.release_digest=a.digest(r);
  await authority.consumption(f.source,claims);
  // Model the already-persisted historical operation; no socket dispatch in this suite.
  Object.assign(f.repo.row(),{state:succeeded?'transport_returned':'outcome_unknown',outcomeUnknown:true,
    dispatchStartedAt:new Date(f.repo.now+1),transportReturn:{succeeded,boundary_returned:true}});
  claims.action='consumption_readback';claims.expires_at=Date.now()+60000;
  return {...f,claims};
}

async function route(f) {
  let handler;
  const source=f.source, instance={id:source.instanceId,name:source.instance.name};
  f.repo.instance={findUnique:async()=>instance};
  authority.installRoute({post:(_path,_guard,work)=>{handler=work;}},
    {waInstances:{[instance.name]:source.service}},()=>{},f.repo);
  let status=200, body;
  const res={status(code){status=code;return this;},sendStatus(code){status=code;},json(value){body=value;}};
  await handler({params:{instanceName:instance.name},body:a.signEnvelope(source,f.claims,'attendance-authority')},res);
  return {status,body};
}

for (const succeeded of [true,false]) test(`signed readback exposes only persisted method return ${succeeded}; no dispatch/receipt`,async t=>{
  const f=await persisted(succeeded), revision=f.repo.row().revision, trace=[...f.repo.trace];
  let sends=0, dispatches=0, receiptCalls=0;
  f.source.service.client.sendMessage=()=>{sends++;throw Error('SEND_TRAP');};
  f.repo.attendanceReceiptRepository=()=>{receiptCalls++;throw Error('RECEIPT_REPOSITORY_TRAP');};
  t.mock.method(dispatch,'dispatch',()=>{dispatches++;throw Error('DISPATCH_TRAP');});
  const oldHold=process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  process.env.NEXI_ATTENDANCE_CUTOVER_HOLD='true';
  t.after(()=>{if(oldHold===undefined)delete process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;else process.env.NEXI_ATTENDANCE_CUTOVER_HOLD=oldHold;});
  f.repo.now=f.claims.material.release.deadline+100000;
  const response=await route(f);assert.equal(response.status,200);
  const signed=a.verifyEnvelope(f.source,response.body,'attendance-authority',32768);
  assert.equal(signed.action,'consumption_result');assert.equal(signed.audience,'nexi-attendance-app');
  assert.equal(signed.request_id,f.claims.material.consumption_id);
  assert.equal(signed.material.request_digest,a.digest(f.claims.material));
  assert.deepEqual(signed.material.transport_return,{boundary_returned:true,succeeded});
  assert.equal(signed.material.outcome_unknown,true);assert.equal(signed.material.external_id,f.repo.row().externalId);
  assert.equal(signed.material.state,succeeded?'transport_returned':'outcome_unknown');
  for(const key of ['receipt','server_ack','delivered','read','sent'])assert.equal(signed.material[key],undefined);
  assert.equal(sends,0);assert.equal(dispatches,0);assert.equal(receiptCalls,0);
  assert.equal(f.repo.row().revision,revision);
  assert.deepEqual(f.repo.trace.filter(value=>value!=='committed'),trace.filter(value=>value!=='committed'));
  assert.deepEqual((await authority.consumption(f.source,f.claims)).transport_return,signed.material.transport_return);
  assert.equal(authority.result(f.repo.row(),f.claims.material).transport_return,undefined);
  await assert.rejects(authority.consumption(f.source,{...f.claims,action:'consume'}),{code:'nexi_attendance_cutover_held'});
});

test('no persisted method return leaves original readback shape unchanged',async()=>{
  const f=await persisted();f.repo.row().transportReturn=null;f.repo.row().state='dispatch_started';
  assert.equal((await authority.consumption(f.source,f.claims)).transport_return,undefined);
});

for(const mutate of [row=>row.transportReturn.boundary_returned=false,row=>row.transportReturn.succeeded='true',
  row=>row.transportReturn.receipt='DELIVERY_ACK',row=>row.state='dispatch_started',row=>row.dispatchStartedAt=null,
  row=>row.outcomeUnknown=false])test('malformed or inconsistent durable method result fails closed '+mutate.toString(),async()=>{
  const f=await persisted();mutate(f.repo.row());
  await assert.rejects(authority.consumption(f.source,f.claims),{code:'nexi_attendance_transport_return_unproved'});
});

test('signed envelope tampering and changed operation material cannot obtain another result',async()=>{
  const f=await persisted(), envelope=a.signEnvelope(f.source,f.claims,'attendance-authority');
  assert.throws(()=>authority.claims(f.source,{...envelope,signature:'0'.repeat(64)}));
  f.claims.material.grant.message_id++;
  await assert.rejects(authority.consumption(f.source,f.claims));
});
