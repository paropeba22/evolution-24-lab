'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const a=require('./nexi-attendance.cjs'),authority=require('./nexi-attendance-authority.cjs');
const groups=require('./nexi-groups.cjs'),{fixture}=require('./attendance-isolated-test-support.cjs');

// Failure-location tests for the real route. Socket/registration acquisition is
// a prevalidated fixture boundary, not proof of production socket attestation.
// Envelope/token verification, storage guard, context installer and HTTP rescue
// are real; repository/transaction are memory fixtures. No libsignal or network.
async function route(t, options={}) {
  const names=['NEXI_ATTENDANCE_CUTOVER_HOLD','NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED','NEXI_ATTENDANCE_COMPOSER_DISPATCH_ENABLED'];
  const env=names.map(key=>process.env[key]);names.forEach(key=>{process.env[key]='true';});
  t.after(()=>names.forEach((key,i)=>{if(env[i]===undefined)delete process.env[key];else process.env[key]=env[i];}));
  const f=fixture(),logs=[],warn=console.warn;
  console.warn=line=>logs.push(JSON.parse(line));t.after(()=>{console.warn=warn;});
  const replace=(object,key,value)=>{const previous=object[key];object[key]=value;t.after(()=>{object[key]=previous;});};
  const owner={token:randomUUID()},context={...f.repo.row().authority,barrier_state:'fencing',physical_dispatch:false};
  delete context.isolated_operation;
  const registration={source:f.source,credentials:f.source.service.client.authState.creds,contextRevision:1,
    context:options.regression?{...context,barrier_state:'active'}:null};
  const snapshot={registration,revision:options.superseded?0:1,context,owner:null,operation:false};
  replace(groups,'lifecycleCapture',()=>owner);
  replace(groups,'lifecycleCurrent',()=>true);
  replace(a,'captureContextSnapshot',async()=>snapshot);
  replace(a,'writerIsolation',(_source,_context,probe)=>{
    if(options.registrationError)throw options.registrationError;
    probe.isolationChecks(()=>({registration_present:true,registration_instance_id_matches:true,
      registration_instance_name_matches:true,context_current_session:true,context_channel_active:true,
      context_session_matches:true,attestation_session_matches:true,attestation_provenance_valid:true,attestation_present:true}));
  });
  f.repo.instance={async findUnique(){return {id:f.source.instanceId,name:f.source.instance.name};},async updateMany(){
    if(options.casError)throw options.casError;return {count:options.casMismatch?0:1};
  }};
  if(options.commitError||options.postTransactionChanged){const transaction=f.repo.$transaction.bind(f.repo);f.repo.$transaction=async work=>{
    const result=await transaction(work);
    if(options.commitError)throw options.commitError;
    registration.contextRevision++;return result;
  };}
  let handler;
  authority.installRoute({post(_path,_guard,action){handler=action;}},{waInstances:{[f.source.instance.name]:f.source.service}},()=>{},f.repo);
  f.token.protocol='attendance-composer-operation-v2';f.token.message_id=null;
  const claims={...f.claims,action:'writer_probe',request_id:randomUUID(),physical_dispatch:false,
    material:{managed_channel_id:f.token.managed_channel_id,session_identity:f.token.session_identity,isolated_operation:f.token}};
  const envelope=a.signEnvelope(f.source,claims,'attendance-authority');
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},sendStatus(code){this.statusCode=code;}};
  await handler({body:envelope,params:{instanceName:f.source.instance.name}},res);
  assert.equal(f.repo.row().dispatchStartedAt,null);assert.equal(f.repo.row().consumptionId,null);
  return {f,res,logs,envelope};
}
const coded=(code,name='Error')=>Object.assign(new Error('PRIVATE_MESSAGE phone/JID/token'),{code,name,meta:{private:'SECRET_META'}});

for(const [option,code] of [['superseded','nexi_attendance_capture_context_superseded'],['regression','nexi_attendance_capture_context_regression']]) {
  test(`writer probe reports ${option} after true registration checks without weakening the installer`,async t=>{
    const {res,logs}=await route(t,{[option]:true});
    assert.equal(res.statusCode,422);assert.deepEqual(res.body,{error:'nexi_attendance_authority_unresolved',physical_dispatch:false});
    const failure=logs.findLast(value=>value.event==='attendance.writer_probe.rejected');
    assert.equal(failure.last_stage,'storage_guard_executed');assert.equal(failure.failure_stage,'capture_context_installation');
    assert.equal(failure.category,code);assert.equal(failure.error_code,code);
    assert.equal(logs.some(value=>value.registration_present===true),true);
    assert.equal(logs.some(value=>value.stage==='proof_response_produced'),false);
  });
}
for(const [option,phase] of [['casError','writer_socket_cas'],['registrationError','writer_registration_validation'],['commitError','writer_transaction_completion']]) {
  test(`writer probe locates ${option} and emits only allowlisted runtime details`,async t=>{
    const error=coded('P2028','PrismaClientKnownRequestError'),{res,logs}=await route(t,{[option]:error});
    assert.equal(res.statusCode,422);
    const failure=logs.findLast(value=>value.event==='attendance.writer_probe.rejected');
    assert.equal(failure.failure_stage,phase);assert.equal(failure.error_class,'PrismaClientKnownRequestError');
    assert.equal(failure.error_code,'P2028');assert.equal(failure.category,'unexpected_failure');
    assert.equal(JSON.stringify(logs).includes('PRIVATE'),false);assert.equal(JSON.stringify(logs).includes('SECRET_META'),false);
  });
}
test('writer probe preserves the database socket CAS rejection',async t=>{
  const {res,logs}=await route(t,{casMismatch:true});assert.equal(res.statusCode,422);
  const failure=logs.findLast(value=>value.event==='attendance.writer_probe.rejected');
  assert.equal(failure.failure_stage,'writer_socket_cas');assert.equal(failure.category,'nexi_attendance_writer_isolation_unproved');
});
test('writer probe distinguishes a snapshot invalidated after the transaction returns',async t=>{
  const {res,logs}=await route(t,{postTransactionChanged:true});assert.equal(res.statusCode,422);
  const failure=logs.findLast(value=>value.event==='attendance.writer_probe.rejected');
  assert.equal(failure.failure_stage,'writer_post_transaction_validation');
  assert.equal(failure.category,'nexi_attendance_writer_isolation_unproved');
  assert.equal(logs.some(value=>value.lifecycle_current_after_transaction===true),true);
});
test('writer probe still produces a signed proof after all fixture boundaries return',async t=>{
  const {f,res,logs}=await route(t);assert.equal(res.statusCode,200);
  const reply=a.verifyEnvelope(f.source,res.body,'attendance-authority');
  assert.equal(reply.action,'writer_result');assert.equal(reply.material.isolated_operation_id,f.token.authorization_id);
  assert.equal(logs.some(value=>value.stage==='writer_isolation_proved'),true);
});
test('writer probe does not leak arbitrary names, codes, messages, stacks, metadata or causes',()=>{
  const logs=[],warn=console.warn;console.warn=line=>logs.push(JSON.parse(line));
  try {
    const trace=a.writerProbeTrace({claims:Buffer.from(JSON.stringify({action:'writer_probe'})).toString('base64url')});
    trace.attempt('capture_context_installation');
    trace.failure(Object.assign(coded('SECRET_CODE','SECRET_CLASS'),{cause:coded('SECRET_CAUSE')}));
    assert.equal(logs[0].error_code,'unclassified');assert.equal(logs[0].error_class,'OtherError');
    assert.equal(JSON.stringify(logs).includes('SECRET'),false);assert.equal(JSON.stringify(logs).includes('PRIVATE'),false);
    trace.failure(coded('MODULE_NOT_FOUND'));assert.equal(logs.at(-1).error_code,'MODULE_NOT_FOUND');
    trace.failure(new TypeError('PRIVATE_DEPENDENCY'));assert.equal(logs.at(-1).error_class,'TypeError');
    const hostile={get name(){throw Error('SECRET_GETTER');}};
    assert.doesNotThrow(()=>trace.failure(hostile));assert.equal(logs.at(-1).error_class,'OtherError');
    let reads=0;
    trace.failure({get code(){return ++reads===1?'nexi_attendance_capture_context_regression':'SECRET_CHANGED_CODE';}});
    assert.equal(logs.at(-1).category,'nexi_attendance_capture_context_regression');
    assert.equal(logs.at(-1).error_code,'unclassified');assert.equal(JSON.stringify(logs).includes('SECRET'),false);
    let names=0;
    trace.failure({code:'nexi_attendance_capture_context_superseded',get name(){return ++names===1?'TypeError':'SECRET_CHANGED_CLASS';}});
    assert.equal(logs.at(-1).error_class,'TypeError');assert.equal(names,1);
    console.warn=()=>{throw Error('SECRET_LOGGER');};assert.doesNotThrow(()=>trace.failure(coded('P2028')));
  } finally {console.warn=warn;}
});
