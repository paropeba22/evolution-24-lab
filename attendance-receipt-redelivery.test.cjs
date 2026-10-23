'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'), assert=require('node:assert/strict');
const {randomUUID,createHmac}=require('node:crypto');
const a=require('./nexi-attendance.cjs'), authority=require('./nexi-attendance-authority.cjs');
const recovery=require('./nexi-attendance-receipt-redelivery.cjs');
const dispatch=require('./nexi-attendance-dispatch.cjs');
const {memory,original}=require('./attendance-authority-test-support.cjs');

function matches(row,where){return Object.entries(where).every(([k,v])=>{
  if(k==='OR')return v.some(item=>matches(row,item));
  if(v && typeof v==='object' && !(v instanceof Date)){
    if('lte' in v)return row[k]<=v.lte;if('gt' in v)return row[k]>v.gt;
  }
  return v===null ? row[k]==null : row[k]===v;
});}
async function fixture(){
  const f=memory(), row=f.repo.row(), c=original(), g=c.material.grant;
  f.source.logger={info(){}};
  Object.assign(row.authority,{barrier_state:'active',physical_dispatch:true,isolation_cutover:true,writer_protocol_version:2});
  row.contentDigest=a.digest({intent:row.intent,attempt_id:row.attemptId,reservation_id:row.reservationId,
    external_id:row.externalId,authority:row.authority});
  row.preparationDigest=a.digest({content_digest:row.contentDigest,authority_digest:row.authorityDigest,
    preparation_id:row.id,nonce:row.preparationNonce,revision:row.preparationRevision});
  Object.assign(g,{scope:'attendance_dispatch_v1',physical_dispatch:true,preparation_digest:row.preparationDigest,
    prepared_content_digest:row.contentDigest});
  c.physical_dispatch=true;c.material.grant_digest=a.digest(g);
  const r=c.material.release;r.preparation_digest=g.preparation_digest;r.grant_digest=c.material.grant_digest;
  r.request_digest=a.digest({admission_id:g.admission_id,grant_id:g.grant_id,grant_digest:r.grant_digest,
    attempt_id:g.attempt_id,reservation_id:g.reservation_id});c.material.release_digest=a.digest(r);
  await authority.consumption(f.source,c);
  Object.assign(f.repo.row(),{state:'transport_returned',outcomeUnknown:true,dispatchStartedAt:new Date(f.repo.now+1),
    transportReturn:{boundary_returned:true,succeeded:true}});
  f.repo.now=Date.now(); // Recovery observes an already-expired historical grant.
  const captured=a.normalizeReceipt(row.authority,{type:'read',t:'1234'},
    {remoteJid:row.recipient,fromMe:true},[row.externalId])[0];
  const data={...captured.evidence,journal_id:randomUUID()};
  const journal={id:data.journal_id,canonicalVersion:a.CANONICAL_VERSION,instanceId:f.source.instanceId,
    sourceKey:captured.sourceKey,externalId:row.externalId,sessionIdentity:data.session_identity,
    normalizedStatus:data.normalized_status,evidence:data,fingerprint:a.digest(data)};
  const body=a.canonical({event:'attendance.receipt.observed',instance:f.source.instance.name,data});
  const event={id:randomUUID(),instanceId:f.source.instanceId,instanceName:f.source.instance.name,canonicalVersion:a.CANONICAL_VERSION,
    eventType:body.event,body,fingerprint:a.digest(body),sourceKey:captured.sourceKey,sessionIdentity:data.session_identity,
    version:1,state:'quarantined',attempts:12,leaseToken:null,leaseUntil:null,acknowledgedAt:null};
  const db={async findUnique({where}){return event.id===where.id?structuredClone(event):null;},
    async updateMany({where,data}){if(!matches(event,where))return {count:0};
      for(const [key,value] of Object.entries(data))event[key]=value?.increment?event[key]+value.increment:value;
      return {count:1};}};
  f.repo.nexiAttendanceEventOutbox=db;
  f.repo.nexiReceiptJournal={async findUnique({where}){return journal.id===where.id?structuredClone(journal):null;}};
  const transaction=f.repo.$transaction.bind(f.repo);
  f.repo.$transaction=async work=>{
    // The original harness serializes transactions. Include the outbox in its
    // rollback snapshot, in addition to the preparation it already protects.
    return transaction(async tx=>{const before=structuredClone(event);
      try{return await work(tx);}catch(error){Object.assign(event,before);throw error;}});
  };
  f.repo.webhook={findUnique:async()=>({enabled:true,url:'https://app.invalid/webhooks/nexi/channels/evolution',headers:{
    'X-Nexi-Chatwoot-Account-Id':String(g.account_id),'X-Nexi-Chatwoot-Inbox-Id':String(row.authority.inbox_id)}})};
  f.repo.instance={findUnique:async()=>({id:f.source.instanceId,name:f.source.instance.name})};
  const claims={...c,request_id:event.id,expires_at:Date.now()+60000,action:'receipt_redelivery',physical_dispatch:false,
    material:{consumption:c.material,event_id:event.id,fingerprint:event.fingerprint,expected_attempts:12}};
  return {...f,event,journal,claims};
}
function ack(f){return {ack:'persisted',event_id:f.event.id,fingerprint:f.event.fingerprint,version:1};}
function client(f,calls,reply=()=>({ok:true,json:async()=>ack(f)})){
  return async(url,options)=>{
    calls.push(options);assert.equal(url.pathname,'/webhooks/nexi/channels/evolution');assert.equal(options.redirect,'error');
    assert.equal(options.body,a.canonicalBytes(f.event.body));assert.equal(options.headers['X-Nexi-Event-Id'],f.event.id);
    const headers=options.headers, secret=createHmac('sha256',process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET)
      .update(`event:${f.source.instance.name}`).digest();
    const expected=createHmac('sha256',secret).update(`${headers['X-Nexi-Event-Timestamp']}.${f.event.id}.${f.source.instance.name}.${f.source.instanceId}.${options.body}`).digest('hex');
    assert.equal(headers['X-Nexi-Event-Signature'],`sha256=${expected}`);
    return reply();
  };
}

test('one original signed receipt is acknowledged only after exact APP persisted ACK; physical operations untouched',async t=>{
  const f=await fixture(),calls=[], before=structuredClone(f.repo.row()),journal=structuredClone(f.journal),body=a.canonicalBytes(f.event.body);
  f.source.service.client.sendMessage=()=>assert.fail('SEND_TRAP');
  t.mock.method(dispatch,'dispatch',()=>assert.fail('DISPATCH_TRAP'));
  const result=await recovery.perform(f.source,f.claims,client(f,calls));
  assert.equal(calls.length,1);assert.equal(result.state,'acknowledged');assert.equal(result.receipt_retained,true);
  assert.equal(result.physical_dispatch,false);assert.equal(f.event.state,'acknowledged');assert.equal(f.event.attempts,13);
  assert.equal(a.canonicalBytes(f.event.body),body);assert.deepEqual(f.journal,journal);assert.deepEqual(f.repo.row(),before);
  assert.equal((await recovery.perform(f.source,f.claims,()=>assert.fail('SECOND_CALLBACK'))).state,'already_acknowledged');
});

test('concurrent recovery manifests win one outbox CAS and issue at most one callback',async()=>{
  const f=await fixture(),calls=[],fetch=client(f,calls);
  const results=await Promise.all([recovery.perform(f.source,f.claims,fetch),recovery.perform(f.source,f.claims,fetch)]);
  assert.equal(calls.length,1);assert.equal(f.event.attempts,13);
  assert.ok(results.some(result=>result.state==='acknowledged'));
});

test('lost callback response keeps quarantine; same manifest cannot retry; fresh explicit counter repeats only original event',async()=>{
  const f=await fixture(),calls=[],retained=new Set();
  await recovery.perform(f.source,f.claims,client(f,calls,()=>{retained.add(f.event.id);throw Error('RESPONSE_LOST');}));
  assert.equal(f.event.state,'quarantined');assert.equal(f.event.attempts,13);assert.equal(f.event.acknowledgedAt,null);
  assert.equal((await recovery.perform(f.source,f.claims,()=>assert.fail('AUTOMATIC_RETRY'))).state,'not_claimed');
  f.claims.material.expected_attempts=13;
  const result=await recovery.perform(f.source,f.claims,client(f,calls,()=>{
    retained.add(f.event.id);return {ok:true,json:async()=>ack(f)};
  }));
  assert.equal(result.state,'acknowledged');assert.equal(calls.length,2);assert.equal(retained.size,1);assert.equal(f.event.attempts,14);
});

for(const reply of [()=>({ok:false,status:503}),()=>({ok:true,json:async()=>({ok:true})}),
  ()=>({ok:true,json:async()=>({ack:'persisted',event_id:randomUUID(),fingerprint:'a'.repeat(64),version:1})})])
  test('HTTP acceptance or wrong ACK cannot settle original evidence '+reply.toString(),async()=>{
    const f=await fixture();const result=await recovery.perform(f.source,f.claims,client(f,[],reply));
    assert.equal(result.receipt_retained,false);assert.equal(f.event.state,'quarantined');assert.equal(f.event.attempts,13);
  });

test('expired lease fences a late ACK and preserves quarantine',async()=>{
  const f=await fixture();
  const result=await recovery.perform(f.source,f.claims,client(f,[],()=>{f.repo.now+=31000;return {ok:true,json:async()=>ack(f)};}));
  assert.equal(result.receipt_retained,false);assert.equal(f.event.state,'quarantined');assert.equal(f.event.acknowledgedAt,null);
});

for(const mutate of [f=>f.event.eventType='attendance.transport.prepared',f=>f.event.instanceId=randomUUID(),
  f=>f.event.fingerprint='a'.repeat(64),f=>f.journal.externalId='other',f=>f.journal.fingerprint='b'.repeat(64),
  f=>f.journal.sourceKey='c'.repeat(64),f=>f.claims.material.consumption.grant.execution_id=randomUUID(),
  f=>f.event.body.data.from_me=false,f=>f.repo.now=f.claims.expires_at])
  test('invalid event/journal/operation/expiry never reaches callback '+mutate.toString(),async()=>{
    const f=await fixture();mutate(f);
    await assert.rejects(recovery.perform(f.source,f.claims,()=>assert.fail('CALLBACK_TRAP')));
    assert.equal(f.event.attempts,12);
  });

for(const state of ['pending','unsupported','binding_unavailable'])test(`${state} outbox is not requeued or delivered by recovery`,async()=>{
  const f=await fixture();f.event.state=state;
  const result=await recovery.perform(f.source,f.claims,()=>assert.fail('STATE_TRAP'));
  assert.equal(result.state,'not_claimed');assert.equal(f.event.attempts,12);
});

test('storage failure prevents recovery from reaching HTTP',async()=>{
  const f=await fixture();f.repo.failStorage=true;
  await assert.rejects(recovery.perform(f.source,f.claims,()=>assert.fail('STORAGE_TRAP')));
  assert.equal(f.event.attempts,12);
});

test('real authority route authenticates signature/audience and exits before consumption',async t=>{
  const f=await fixture();let handler,body,status=200;
  authority.installRoute({post:(_path,_guard,work)=>handler=work},
    {waInstances:{[f.source.instance.name]:f.source.service}},()=>{},f.repo);
  const calls=[];t.mock.method(global,'fetch',client(f,calls));
  const res={status(value){status=value;return this;},json(value){body=value;},sendStatus(value){status=value;}};
  const invoke=envelope=>handler({params:{instanceName:f.source.instance.name},body:envelope},res);
  await invoke({...a.signEnvelope(f.source,f.claims,'attendance-authority'),signature:'0'.repeat(64)});
  assert.equal(status,422);assert.equal(calls.length,0);
  status=200;await invoke(a.signEnvelope(f.source,f.claims,'attendance-authority'));
  assert.equal(status,200);const signed=a.verifyEnvelope(f.source,body,'attendance-authority',32768);
  assert.equal(signed.physical_dispatch,false);assert.equal(signed.material.request_digest,a.digest(f.claims.material));
  assert.equal(signed.material.event_id,f.event.id);assert.equal(signed.material.state,'acknowledged');assert.equal(calls.length,1);
});
