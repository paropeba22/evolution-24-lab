'use strict';
const {memory,original}=require('./attendance-authority-test-support.cjs');
const a=require('./nexi-attendance.cjs');
const isolated=require('./nexi-attendance-isolated.cjs');
function fixture(now=Date.now()) {
  const f=memory(),row=f.repo.row(),claims=original(),g=claims.material.grant;
  f.repo.now=now;
  Object.assign(row.authority,{instance:f.source.instance.name,barrier_state:'active',physical_dispatch:true,isolation_cutover:true,writer_protocol_version:2});
  const payload={kind:'text',body:'SYNTHETIC OWNER TEST',reply_to:null};
  row.intent.payload=payload;row.intent.payload_digest=a.digest(payload);row.payloadDigest=a.digest(payload);
  const token={protocol:isolated.PROTOCOL,authorization_id:'ab000000-1111-4111-8111-111111111111',execution_id:row.executionId,
    request_id:'ac000000-1111-4111-8111-111111111111',instance_id:f.source.instanceId,
    instance_lineage_id:row.authority.instance_lineage_id,sender_account_lineage_id:row.authority.sender_account_lineage_id,
    account_id:g.account_id,managed_channel_id:g.managed_channel_id,inbox_id:row.authority.inbox_id,conversation_id:10,actor_id:11,
    contact_id:12,contact_inbox_id:13,identity_slot_id:14,identity_version_id:g.identity_version_id,identity_generation:1,
    writer_epoch:g.writer_epoch,binding_generation:g.binding_generation,message_id:g.message_id,session_identity:g.session_identity,
    recipient_digest:a.digest({recipient:row.recipient}),manifest_digest:a.digest({units:[payload]}),payload_digest:a.digest(payload),
    approved_at:now-1000,expires_at:now+120000};
  row.authority.isolated_operation=token;
  Object.assign(g,{scope:'attendance_dispatch_v1',physical_dispatch:true,expires_at:now+60000,isolated_operation:token});
  claims.physical_dispatch=true;claims.expires_at=now+60000;claims.material.release.deadline=now+15000;
  f.claims=claims;f.token=token;seal(f);return f;
}
function seal(f) {
  const row=f.repo.row(),m=f.claims.material,g=m.grant,r=m.release;
  row.contentDigest=a.digest({intent:row.intent,attempt_id:row.attemptId,reservation_id:row.reservationId,external_id:row.externalId,authority:row.authority});
  row.preparationDigest=a.digest({content_digest:row.contentDigest,authority_digest:row.authorityDigest,preparation_id:row.id,nonce:row.preparationNonce,revision:row.preparationRevision});
  g.preparation_digest=row.preparationDigest;g.prepared_content_digest=row.contentDigest;m.grant_digest=a.digest(g);
  r.preparation_digest=g.preparation_digest;r.grant_digest=m.grant_digest;
  r.request_digest=a.digest({admission_id:g.admission_id,grant_id:g.grant_id,grant_digest:m.grant_digest,attempt_id:g.attempt_id,reservation_id:g.reservation_id});
  m.release_digest=a.digest(r);
}
async function installSocket(f,t,{failure=false,beforeBoundary=false,context}={}) {
  const assert=require('node:assert/strict'),fs=require('node:fs');
  const {config}=await require('./attendance-socket-test-support.cjs').registerSocket(f,t,{context});
  const pinned=JSON.parse(fs.readFileSync(__dirname+'/fixtures/baileys-send-node-rc13.json','utf8'));
  const {patchAttendanceSendNode}=await import('./patch-attendance-source.mjs');let writes=0;
  const boundary=new Function('config','nexiAttendance','logger','binaryNodeToString','encodeBinaryNode','sendRawMessage',
    patchAttendanceSendNode(pinned.source)+'\nreturn sendNode;')(config,a,{level:'silent'},()=>'',()=>Buffer.from([1]),()=>{
      assert.ok(f.repo.row().dispatchStartedAt);assert.equal(f.repo.trace.at(-1),'committed');writes++;if(failure)throw Error('SYNTHETIC_SOCKET_LOSS');});
  f.source.service.client.sendMessage=async(recipient,body,options)=>{
    if(beforeBoundary){beforeBoundary=false;throw Error('SYNTHETIC_CRASH_BEFORE_CAS');}
    assert.equal(body.text,f.repo.row().intent.payload.body);
    await boundary({tag:'message',attrs:{id:options.messageId,to:recipient},content:[]});
    return {key:{id:options.messageId,remoteJid:recipient}};
  };
  return {get writes(){return writes;},config};
}
module.exports={fixture,seal,installSocket};
