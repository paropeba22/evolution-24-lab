'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHmac,randomUUID}=require('node:crypto');
const a=require('./nexi-attendance.cjs'),{fixture}=require('./attendance-isolated-test-support.cjs');

// Real nonce/HMAC context exchange and installer; memory repository and APP
// HTTP fixture. No registration/attestation verifier, DB or physical transport.
function renewalFixture(t, options={}) {
  const f=fixture(),source=f.source,previous={...f.repo.row().authority,writer_epoch:50,writer_protocol_version:2,
    barrier_state:'fencing',physical_dispatch:false,isolation_cutover:true};
  delete previous.isolated_operation;
  const candidate={...previous,sender_attestation_id:'90000000-1111-4111-8111-111111111111'};
  const contexts=new Map(),requests=[];
  f.repo.webhook={async findUnique(){return {enabled:true,url:'https://synthetic.invalid/webhooks/nexi/channels/evolution',headers:{
    'X-Nexi-Chatwoot-Account-Id':String(previous.account_id),'X-Nexi-Chatwoot-Inbox-Id':String(previous.inbox_id)}};}};
  f.repo.nexiManagedTransportContext={async findUnique({where}){return contexts.get(where.fingerprint)||null;},
    async findFirst(){return [...contexts.values()].at(-1)||null;},
    async create({data}){contexts.set(data.fingerprint,data);return data;}};
  const secret=createHmac('sha256',process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET).update(`event:${source.instance.name}`).digest();
  const fetch=async(_url,request)=>{
    const payload=JSON.parse(request.body),data=payload.data;requests.push(data);
    if(options.allowInitial&&!Object.hasOwn(data,'previous_sender_attestation_id')) {
      const claims=Buffer.from(a.canonicalBytes({...previous,nonce:data.nonce})).toString('base64url');
      return {ok:true,status:200,json:async()=>({claims,signature:createHmac('sha256',secret).update(`attendance-context:v1:${claims}`).digest('hex')})};
    }
    assert.equal(payload.event,'attendance.writer.context.request');
    assert.equal(data.previous_sender_attestation_id,previous.sender_attestation_id);
    const proof={version:1,from_attestation_id:previous.sender_attestation_id,to_attestation_id:candidate.sender_attestation_id,
      expires_at:Date.now()+30000,...options.proof};
    const body={...candidate,nonce:data.nonce,...(options.noProof?{}:{sender_attestation_renewal:proof})};
    const claims=Buffer.from(a.canonicalBytes(body)).toString('base64url');
    const signature=createHmac('sha256',secret).update(`attendance-context:v1:${claims}`).digest('hex');
    return {ok:true,status:200,json:async()=>({claims,signature:options.badSignature?'0'.repeat(64):signature})};
  };
  const refresh=()=>a.refreshContext(source,previous.session_identity,fetch,randomUUID(),null,null,previous.sender_attestation_id);
  const registration={source,credentials:source.service.client.authState.creds,contextRevision:1,context:previous};
  const snapshot=context=>({registration,revision:1,context,owner:null,operation:false});
  return {...f,previous,candidate,contexts,requests,registration,snapshot,refresh,fetch};
}
test('configured socket automatically requests its installed predecessor during the writer probe',async t=>{
  const f=renewalFixture(t,{allowInitial:true}),service=f.source.service,socket=service.client,events=new Map();
  const instance={id:service.instanceId,name:service.instance.name,nexiGroupsSocketOwner:null};
  f.repo.instance={async findUnique(){return {...instance};},async updateMany({where,data}){
    if(!Object.entries(where).every(([key,value])=>instance[key]===value))return {count:0};
    Object.assign(instance,data);return {count:1};
  }};
  f.repo.attendanceReceiptRepository=()=>({});
  f.repo.nexiAttendanceEventOutbox={async findUnique({where}){return events.get(where.instanceId_sourceKey.sourceKey)||null;},
    async create({data}){events.set(data.sourceKey,data);return data;}};
  service.prismaRepository=f.repo;
  const config={auth:{creds:socket.authState.creds},logger:{level:'silent',warn(){}}},fetch=global.fetch;
  global.fetch=f.fetch;t.after(()=>{global.fetch=fetch;a.clearInstanceDiagnostics(service);});
  await a.configure(service,config);
  const groups=require('./nexi-groups.cjs');await groups.installAdmissionSocket(service,config,()=>socket);a.trackSocket(service.client,config);
  const probe=a.writerProbeTrace({claims:Buffer.from(JSON.stringify({action:'writer_probe'})).toString('base64url')});
  const snapshot=await a.captureContextSnapshot(f.source,groups.lifecycleCapture(service),probe);
  assert.equal(f.requests.at(-1).previous_sender_attestation_id,f.previous.sender_attestation_id);
  a.installCaptureContext(snapshot);assert.equal(snapshot.registration.context.sender_attestation_id,f.candidate.sender_attestation_id);
});
test('fresh APP continuity proof renews only attestation on the same epoch without granting dispatch',async t=>{
  const f=renewalFixture(t),context=await f.refresh();
  assert.equal(Object.hasOwn(context,'sender_attestation_renewal'),false);
  a.installCaptureContext(f.snapshot(context));assert.equal(f.registration.context.sender_attestation_id,f.candidate.sender_attestation_id);
  assert.equal(f.registration.context.writer_epoch,50);assert.equal(f.registration.context.physical_dispatch,false);
  assert.equal(f.repo.row().dispatchStartedAt,null);assert.equal(f.repo.row().consumptionId,null);
  assert.equal(Object.hasOwn([...f.contexts.values()][0].payload,'sender_attestation_renewal'),false);
});
test('fresh signed response retains renewal authority on an existing durable context cache hit',async t=>{
  const f=renewalFixture(t);await f.refresh();const context=await f.refresh();
  assert.equal(f.contexts.size,1);assert.equal(f.requests.length,2);
  assert.notEqual(f.requests[0].nonce,f.requests[1].nonce);
  a.installCaptureContext(f.snapshot(context));assert.equal(f.registration.context.sender_attestation_id,f.candidate.sender_attestation_id);
});
test('successive renewals remain forward-only and require a fresh proof for each installed predecessor',async t=>{
  const f=renewalFixture(t),first=await f.refresh();a.installCaptureContext(f.snapshot(first));
  const old={...f.previous};f.previous.sender_attestation_id=first.sender_attestation_id;f.candidate.sender_attestation_id=randomUUID();
  const second=await f.refresh();a.installCaptureContext(f.snapshot(second));
  assert.equal(f.registration.context.sender_attestation_id,f.candidate.sender_attestation_id);
  assert.equal(f.registration.context.writer_epoch,50);
  assert.throws(()=>a.installCaptureContext(f.snapshot(old)),error=>error.code==='nexi_attendance_capture_context_regression');
});
test('serialized, copied or absent continuity proof cannot authorize attestation substitution',async t=>{
  const f=renewalFixture(t),context=await f.refresh();
  for(const copied of [JSON.parse(JSON.stringify(context)),{...context,sender_attestation_renewal:{version:1,
    from_attestation_id:f.previous.sender_attestation_id,to_attestation_id:context.sender_attestation_id,expires_at:Date.now()+30000}}]) {
    assert.throws(()=>a.installCaptureContext(f.snapshot(copied)),error=>error.code==='nexi_attendance_capture_context_regression');
  }
  const without=renewalFixture(t,{noProof:true}),unsigned=await without.refresh();
  assert.throws(()=>a.installCaptureContext(without.snapshot(unsigned)),error=>error.code==='nexi_attendance_capture_context_regression');
});
for(const proof of [{from_attestation_id:randomUUID()},{to_attestation_id:randomUUID()},{version:2},{extra:true},
  {expires_at:1},{expires_at:Number.MAX_SAFE_INTEGER}]) {
  test(`signed but incompatible renewal shape/reference/deadline is rejected: ${JSON.stringify(proof)}`,async t=>{
    await assert.rejects(renewalFixture(t,{proof}).refresh(),error=>error.code==='nexi_attendance_context_invalid');
  });
}
test('tampered APP HMAC cannot install a renewal',async t=>{
  await assert.rejects(renewalFixture(t,{badSignature:true}).refresh(),error=>error.code==='nexi_attendance_context_invalid');
});
test('proof cannot cross a changed installed predecessor, binding or owner',async t=>{
  for(const [field,value] of [['sender_attestation_id',randomUUID()],['binding_generation',2],['account_id',99],
    ['inbox_id',99],['managed_channel_id',99],['instance_lineage_id',randomUUID()],['sender_account_lineage_id',randomUUID()]]) {
    const f=renewalFixture(t),context=await f.refresh();f.registration.context={...f.previous,[field]:value};
    assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_regression',field);
  }
});
test('proof cannot bypass snapshot supersession, state regression or modification of authenticated context',async t=>{
  const f=renewalFixture(t),context=await f.refresh();f.registration.contextRevision=2;
  assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_superseded');
  f.registration.contextRevision=1;f.registration.context={...f.previous,barrier_state:'active'};
  assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_regression');
  f.registration.context=f.previous;context.physical_dispatch=true;
  assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_regression');
});
test('renewal cannot implicitly authorize a newer binding generation or different writer version',async t=>{
  for(const [field,value] of [['binding_generation',2],['writer_protocol_version',1]]) {
    const f=renewalFixture(t);f.candidate[field]=value;const context=await f.refresh();
    assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_regression');
  }
});
test('expired locally authenticated renewal cannot be installed',async t=>{
  const f=renewalFixture(t),context=await f.refresh(),now=Date.now;
  Date.now=()=>now()+61000;t.after(()=>{Date.now=now;});
  assert.throws(()=>a.installCaptureContext(f.snapshot(context)),error=>error.code==='nexi_attendance_capture_context_regression');
});
test('renewal predecessor reference is restricted to the exact writer context contract',()=>{
  const f=fixture(),data={version:1,canonical_version:a.CANONICAL_VERSION,audience:'nexi-attendance-app',provider:'evolution-baileys',
    account_id:1,inbox_id:2,nonce:randomUUID(),session_identity:f.token.session_identity,previous_sender_attestation_id:randomUUID()};
  assert.throws(()=>a.eventPayload('attendance.context.request',data));
  assert.throws(()=>a.eventPayload('attendance.writer.context.request',{...data,socket_owner:randomUUID(),previous_sender_attestation_id:'invalid'}));
});
