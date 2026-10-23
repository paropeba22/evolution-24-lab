'use strict';

// Called only after the existing API-key + fresh APP HMAC authority boundary.
// One quarantined original receipt, one CAS-controlled callback. No requeue.
const {randomUUID}=require('node:crypto');
const a=require('./nexi-attendance.cjs'), authority=require('./nexi-attendance-authority.cjs');
const transport=require('./nexi-transport.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function fail(){throw Object.assign(new Error('nexi_attendance_receipt_recovery_conflict'),
  {code:'nexi_attendance_receipt_recovery_conflict'});}
function result(claims,row,state){
  return {request_digest:a.digest(claims.material),event_id:row.id,fingerprint:row.fingerprint,attempts:row.attempts,
    state,receipt_retained:['acknowledged','already_acknowledged'].includes(state),physical_dispatch:false};
}
function material(claims){
  const m=claims.material;
  if(claims.action!=='receipt_redelivery' || claims.physical_dispatch!==false ||
    !exact(m,['consumption','event_id','fingerprint','expected_attempts']) || !UUID.test(m.event_id||'') ||
    claims.request_id!==m.event_id || !HASH.test(m.fingerprint||'') || !Number.isSafeInteger(m.expected_attempts) ||
    m.expected_attempts<12 || m.expected_attempts>2147483646)fail();
  authority.material(m.consumption);
  return m;
}
async function original(source,tx,m){
  const c=m.consumption,g=c.grant;
  const row=await tx.nexiAttendanceEventOutbox.findUnique({where:{id:m.event_id}});
  const prepared=await tx.nexiAttendancePreparation.findUnique({where:{id:g.preparation_id}});
  if(!row || !prepared || row.instanceId!==source.instanceId || row.instanceName!==source.instance.name ||
    row.eventType!=='attendance.receipt.observed' || row.canonicalVersion!==a.CANONICAL_VERSION || row.version!==1 ||
    row.fingerprint!==m.fingerprint || a.digest(row.body)!==row.fingerprint ||
    !exact(row.body,['event','instance','data']) || row.body.event!==row.eventType || row.body.instance!==row.instanceName)fail();
  authority.binding(source,prepared,c);
  if(g.physical_dispatch!==true || !prepared.dispatchStartedAt || prepared.outcomeUnknown!==true ||
    prepared.consumptionId!==c.consumption_id || prepared.consumptionDigest!==a.digest(c) ||
    prepared.grantId!==g.grant_id || prepared.grantDigest!==c.grant_digest || prepared.releaseId!==c.release.release_id ||
    prepared.releaseDigest!==c.release_digest || a.digest(prepared.releasedAuthority)!==a.digest(c))fail();
  const data=a.eventPayload(row.eventType,row.body.data);
  const journal=await tx.nexiReceiptJournal.findUnique({where:{id:data.journal_id}});
  if(a.digest(data)!==a.digest(row.body.data) || data.from_me!==true || !journal ||
    journal.id!==data.journal_id || journal.instanceId!==source.instanceId || journal.canonicalVersion!==a.CANONICAL_VERSION ||
    journal.sourceKey!==row.sourceKey || journal.externalId!==g.external_id || journal.externalId!==data.external_id ||
    journal.sessionIdentity!==row.sessionIdentity || journal.sessionIdentity!==data.session_identity ||
    journal.normalizedStatus!==data.normalized_status || journal.fingerprint!==a.digest(journal.evidence) ||
    a.digest(journal.evidence)!==a.digest(data) ||
    !['account_id','managed_channel_id','instance_lineage_id','sender_account_lineage_id'].every(key=>data[key]===g[key]) ||
    data.instance_id!==source.instanceId ||
    data.original_session_identity!==null && data.original_session_identity!==prepared.sessionIdentity)fail();
  return {row,prepared};
}
async function perform(source,claims,fetchImpl=fetch){
  const m=material(claims), repo=source.prismaRepository, token=randomUUID();
  const claim=await repo.$transaction(async tx=>{
    await authority.storageGuard(tx);
    const now=await authority.clock(tx);
    if(now>=claims.expires_at)fail();
    const {row,prepared}=await original(source,tx,m);
    if(row.state==='acknowledged' && row.acknowledgedAt)return {done:result(claims,row,'already_acknowledged')};
    if(row.state!=='quarantined' || row.attempts!==m.expected_attempts)return {done:result(claims,row,'not_claimed')};
    const changed=await tx.nexiAttendanceEventOutbox.updateMany({where:{id:row.id,instanceId:source.instanceId,
      fingerprint:m.fingerprint,state:'quarantined',attempts:m.expected_attempts,
      OR:[{leaseUntil:null},{leaseUntil:{lte:new Date(now)}}]},
      data:{attempts:{increment:1},leaseToken:token,leaseUntil:new Date(now+30000)}});
    return changed.count===1 ? {row,prepared} : {done:result(claims,row,'not_claimed')};
  },{maxWait:3000,timeout:10000});
  if(claim.done)return claim.done;
  let acknowledged=false;
  try{
    const destination=await a.boundary(source), g=m.consumption.grant;
    if(!destination?.enabled || destination.headers['X-Nexi-Chatwoot-Account-Id']!==String(g.account_id) ||
      destination.headers['X-Nexi-Chatwoot-Inbox-Id']!==String(claim.prepared.authority.inbox_id))fail();
    const prepared=transport.prepareEvent(destination.headers,claim.row.body,source.instance.name,source.instanceId);
    if(a.digest(prepared.body)!==m.fingerprint)fail();
    prepared.headers['X-Nexi-Event-Id']=claim.row.id;
    const response=await fetchImpl(destination.url,{method:'POST',redirect:'error',
      headers:transport.freshEventHeaders(prepared.headers,claim.row.body),body:a.canonicalBytes(claim.row.body),
      signal:AbortSignal.timeout(8000)});
    const ack=response.ok ? await response.json() : null;
    acknowledged=exact(ack,['ack','event_id','fingerprint','version']) && ack.ack==='persisted' &&
      ack.event_id===claim.row.id && ack.fingerprint===m.fingerprint && ack.version===1;
  }catch{ /* An uncertain callback never changes receipt truth or retries here. */ }
  return repo.$transaction(async tx=>{
    await authority.storageGuard(tx);
    const now=await authority.clock(tx);
    const changed=await tx.nexiAttendanceEventOutbox.updateMany({where:{id:m.event_id,instanceId:source.instanceId,
      fingerprint:m.fingerprint,state:'quarantined',attempts:m.expected_attempts+1,leaseToken:token,leaseUntil:{gt:new Date(now)}},
      data:{...(acknowledged?{state:'acknowledged',acknowledgedAt:new Date(now)}:{}),leaseToken:null,leaseUntil:null}});
    const row=await tx.nexiAttendanceEventOutbox.findUnique({where:{id:m.event_id}});
    return result(claims,row,changed.count===1 && acknowledged ? 'acknowledged' : 'not_acknowledged');
  },{maxWait:3000,timeout:10000});
}
module.exports={perform};
