'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const a=require('./nexi-attendance.cjs'),authority=require('./nexi-attendance-authority.cjs'),isolated=require('./nexi-attendance-isolated.cjs');
const {fixture}=require('./attendance-isolated-test-support.cjs');
const {registerSocket}=require('./attendance-socket-test-support.cjs');

async function writerProbe(t,composerFlag) {
  const keys=['NEXI_ATTENDANCE_CUTOVER_HOLD','NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED','NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED'];
  const previous=keys.map(k=>process.env[k]);
  keys.forEach((k,i)=>{process.env[k]=['true','true',composerFlag][i];});
  t.after(()=>keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];}));
  const f=fixture(),logs=[],warn=console.warn;
  console.warn=value=>{try{logs.push(JSON.parse(value));}catch{assert.fail('unexpected diagnostic');}};
  t.after(()=>{console.warn=warn;});
  f.token.protocol=isolated.COMPOSER_PROTOCOL;f.token.message_id=null;
  await registerSocket(f,t,{context:value=>{
    // APP's fencing context has no bound execution/token yet; probe authority
    // is the separate authenticated request, with message_id=null.
    const context={...value,barrier_state:'fencing',physical_dispatch:false};delete context.isolated_operation;return context;
  }});
  const find=f.repo.instance.findUnique;
  f.repo.instance.findUnique=({where})=>find({where:{id:where.name===f.source.instance.name?f.source.instanceId:where.id}});
  let handler;
  authority.installRoute({post(path,guard,route){assert.equal(path,'/nexi/attendance/authority/:instanceName');handler=route;}},
    {waInstances:{[f.source.instance.name]:f.source.service}},()=>{},f.repo);
  const claims={...f.claims,action:'writer_probe',request_id:randomUUID(),physical_dispatch:false,
    material:{managed_channel_id:f.token.managed_channel_id,session_identity:f.token.session_identity,isolated_operation:f.token}};
  const envelope=a.signEnvelope(f.source,claims,'attendance-authority');
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},sendStatus(code){this.statusCode=code;}};
  await handler({body:envelope,params:{instanceName:f.source.instance.name}},res);
  return {f,res,logs,envelope,claims};
}

test('writer probe: disabled Evolution composer rejects V2 with its actual scope guard and phase',async t=>{
  const {f,res,logs,envelope}=await writerProbe(t,'false');
  assert.equal(res.statusCode,422);assert.equal(f.repo.row().dispatchStartedAt,null);
  const failure=logs.findLast(v=>v.event==='attendance.writer_probe.rejected');
  assert.equal(failure.category,'nexi_attendance_isolated_authority_invalid');
  assert.equal(failure.failure_stage,'scoped_operation_validation');
  assert.equal(failure.correlation,a.digest(envelope).slice(0,24));
  const checks=logs.findLast(v=>v.event==='attendance.writer_probe.isolation_checks');
  assert.deepEqual([checks.isolated_dispatch_enabled,checks.composer_dispatch_enabled,checks.scoped_composer],[true,false,true]);
  assert.equal(logs.some(v=>v.stage==='proof_response_produced'),false);
});

test('writer probe: coordinated flags preserve signed proof and never start transport',async t=>{
  const {f,res,logs,claims}=await writerProbe(t,'true');
  assert.equal(res.statusCode,200);
  const reply=a.verifyEnvelope(f.source,res.body,'attendance-authority');
  assert.equal(reply.action,'writer_result');assert.equal(reply.request_id,claims.request_id);
  assert.equal(reply.material.isolated_operation_id,f.token.authorization_id);
  assert.equal(reply.material.writer_epoch,f.token.writer_epoch);
  assert.equal(f.repo.row().dispatchStartedAt,null);assert.equal(f.repo.row().consumptionId,null);
  assert.ok(logs.some(v=>v.stage==='proof_response_produced'));
  const serialized=JSON.stringify(logs);
  for(const secret of [f.token.authorization_id,f.token.request_id,f.token.session_identity,res.body.signature,claims.material.isolated_operation.recipient_digest])
    assert.equal(serialized.includes(secret),false);
});

test('writer probe: arbitrary error text and additional diagnostic fields stay private',()=>{
  const logs=[],warn=console.warn;
  console.warn=value=>logs.push(JSON.parse(value));
  try {
    const trace=a.writerProbeTrace({claims:Buffer.from(JSON.stringify({action:'writer_probe'})).toString('base64url')});
    trace.attempt('scoped_operation_validation');
    trace.isolationChecks(()=>({composer_dispatch_enabled:false,secret:'SECRET_BODY'}));
    trace.failure(Object.assign(new Error('SECRET_BODY'),{code:'SECRET_TOKEN'}));
    assert.equal(logs.at(-1).category,'unexpected_failure');
    assert.equal(JSON.stringify(logs).includes('SECRET'),false);
  } finally {console.warn=warn;}
});
