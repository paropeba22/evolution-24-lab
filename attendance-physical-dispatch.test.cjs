'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const a=require('./nexi-attendance.cjs'), authority=require('./nexi-attendance-authority.cjs');
const transport=require('./nexi-attendance-dispatch.cjs');
const {memory,original}=require('./attendance-authority-test-support.cjs');

function enabled(payload={kind:'text',body:'texto real\n😀',reply_to:null}) {
  const f=memory(),row=f.repo.row(),claims=original(),g=claims.material.grant;
  Object.assign(row.authority,{barrier_state:'active',physical_dispatch:true,isolation_cutover:true,writer_protocol_version:2});
  row.intent.payload=payload;row.intent.payload_digest=a.digest(payload);row.payloadDigest=a.digest(payload);
  row.contentDigest=a.digest({intent:row.intent,attempt_id:row.attemptId,reservation_id:row.reservationId,external_id:row.externalId,authority:row.authority});
  row.preparationDigest=a.digest({content_digest:row.contentDigest,authority_digest:row.authorityDigest,preparation_id:row.id,nonce:row.preparationNonce,revision:row.preparationRevision});
  Object.assign(g,{scope:'attendance_dispatch_v1',physical_dispatch:true,preparation_digest:row.preparationDigest,prepared_content_digest:row.contentDigest});
  claims.physical_dispatch=true;claims.material.grant_digest=a.digest(g);
  const r=claims.material.release;r.preparation_digest=g.preparation_digest;r.grant_digest=claims.material.grant_digest;
  r.request_digest=a.digest({admission_id:g.admission_id,grant_id:g.grant_id,grant_digest:r.grant_digest,attempt_id:g.attempt_id,reservation_id:g.reservation_id});
  claims.material.release_digest=a.digest(r);
  return {...f,claims};
}
async function lexical(f,throws=false) {
  const config={auth:{creds:f.source.service.client.authState.creds},logger:{level:'silent',warn(){}}};
  f.source.service.prismaRepository=f.repo;
  await a.configure(f.source.service,config);
  const fixture=JSON.parse(fs.readFileSync(__dirname+'/fixtures/baileys-send-node-rc13.json','utf8'));
  const {patchAttendanceSendNode}=await import(pathToFileURL(__dirname+'/patch-attendance-source.mjs'));
  let writes=0;
  const boundary=new Function('config','nexiAttendance','logger','binaryNodeToString','encodeBinaryNode','sendRawMessage',
    patchAttendanceSendNode(fixture.source)+'\nreturn sendNode;')(config,a,{level:'silent'},()=>'',()=>Buffer.from([1]),()=>{
      assert.equal(f.repo.row().state,'dispatch_started');assert.equal(f.repo.trace.at(-1),'committed');
      writes++;if(throws)throw Error('SYNTHETIC_SOCKET_FAILURE');
    });
  f.source.service.client.sendMessage=async(recipient,content,options)=>{
    assert.equal(options.messageId,f.repo.row().externalId);
    assert.equal(content.text,f.repo.row().intent.payload.body);
    await boundary({tag:'message',attrs:{id:options.messageId,to:recipient},content:[]});
    return {key:{id:options.messageId,remoteJid:recipient}};
  };
  return {get writes(){return writes;}};
}
test('signed dispatch grant requires active isolated writer and exact frozen binding',async()=>{
  const f=enabled();const envelope=a.signEnvelope(f.source,f.claims,'attendance-authority');
  assert.deepEqual(authority.claims(f.source,envelope, f.repo.now).material,f.claims.material);
  await authority.consumption(f.source,f.claims);
  assert.equal(authority.physicalDispatchEnabled(f.source,f.repo.row()),true);
  f.repo.row().authority.isolation_cutover=false;
  assert.equal(authority.physicalDispatchEnabled(f.source,f.repo.row()),false);
});
test('actual patched lexical boundary commits CAS before one socket write; replay never writes twice',async()=>{
  const f=enabled();await authority.consumption(f.source,f.claims);const socket=await lexical(f);
  const result=await transport.dispatch(f.source,f.claims.material);
  assert.equal(socket.writes,1);assert.equal(result.state,'transport_returned');assert.equal(result.outcome_unknown,true);
  assert.equal(result.physical_dispatch,true);assert.ok(result.dispatch_started_at);
  assert.equal(result.delivered,undefined);assert.equal(result.sent,undefined);
  assert.deepEqual(await transport.dispatch(f.source,f.claims.material),result);assert.equal(socket.writes,1);
});
test('socket failure after CAS persists UNKNOWN and suppresses restart resend',async()=>{
  const f=enabled();await authority.consumption(f.source,f.claims);const socket=await lexical(f,true);
  const result=await transport.dispatch(f.source,f.claims.material);
  assert.equal(result.state,'outcome_unknown');assert.equal(socket.writes,1);
  await transport.dispatch({...f.source},f.claims.material);assert.equal(socket.writes,1);
});
test('expired consumed release proves no dispatch under row lock and never writes',async()=>{
  const f=enabled();await authority.consumption(f.source,f.claims);const socket=await lexical(f);
  f.repo.now=f.claims.material.release.deadline+1;
  const result=await transport.dispatch(f.source,f.claims.material);
  assert.equal(result.state,'release_expired_before_dispatch');
  assert.equal(result.dispatch_started_at,null);assert.equal(result.outcome_unknown,false);assert.equal(socket.writes,0);
  assert.deepEqual(await transport.dispatch(f.source,f.claims.material),result);
});
test('concurrent physical operations reach the lexical socket at most once',async()=>{
  const f=enabled();await authority.consumption(f.source,f.claims);const socket=await lexical(f);
  await Promise.allSettled([transport.dispatch(f.source,f.claims.material),transport.dispatch(f.source,f.claims.material)]);
  assert.equal(socket.writes,1);
});
for(const fault of ['failCommit','badGuard','badIndex'])test(`${fault} cannot escape to socket`,async()=>{
  const f=enabled();await authority.consumption(f.source,f.claims);const socket=await lexical(f);f.repo[fault]=true;
  await assert.rejects(transport.dispatch(f.source,f.claims.material));assert.equal(socket.writes,0);
});
for(const type of ['image','file','audio','video'])test(`${type} resolves APP-authorized bytes and verifies checksum before Baileys`,async()=>{
  const bytes=Buffer.from('synthetic '+type),blob={id:9,key:'stored',byte_size:bytes.length,checksum:createHash('md5').update(bytes).digest('base64'),filename:'sample',content_type:'application/octet-stream'};
  const f=enabled({kind:'attachment',file_type:type,blob});await authority.consumption(f.source,f.claims);
  f.repo.webhook={findUnique:async()=>({url:'https://synthetic.invalid/webhooks/nexi/channels/evolution',enabled:true,headers:{'X-Nexi-Chatwoot-Account-Id':'1','X-Nexi-Chatwoot-Inbox-Id':'2'}})};
  const fetch=async(url,options)=>{
    assert.equal(url.pathname,'/webhooks/nexi/channels/evolution');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.event,'attendance.media.request');assert.equal(body.data.external_id,f.repo.row().externalId);
    assert.equal(body.data.inbox_id,f.repo.row().authority.inbox_id);
    assert.deepEqual(a.eventPayload(body.event,body.data),body.data);
    return {ok:true,body:(async function*(){yield bytes;})()};
  };
  const result=await transport.content(f.source,f.repo.row(),fetch);
  assert.deepEqual(result[type==='file'?'document':type],bytes);
  await assert.rejects(transport.content(f.source,f.repo.row(),async()=>({ok:true,body:(async function*(){yield Buffer.from('changed');})()})));
  assert.equal(f.repo.row().dispatchStartedAt,null);
});
