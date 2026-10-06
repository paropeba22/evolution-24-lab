'use strict';

// Transport-local extension of Attendance. All logical authority arrives in
// APP-signed canonical envelopes; no actor/account/identity policy lives here.
const identity = require('./nexi-identity.cjs');
const canonical = require('./nexi-canonical-json.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KEYS = ['version', 'protocol_version', 'canonical_version', 'audience', 'provider', 'instance', 'instance_id',
  'request_id', 'expires_at', 'action', 'material', 'physical_dispatch'];
const GRANT_KEYS = ['grant_id','admission_id','request_id','request_digest','authority_snapshot_digest','account_id','managed_channel_id',
  'execution_id','message_id','transport_unit_index','attempt_id','reservation_id','external_id','preparation_id','preparation_digest',
  'prepared_content_digest','identity_version_id','instance_lineage_id','sender_account_lineage_id','session_identity','writer_epoch',
  'binding_generation','expires_at','scope','physical_dispatch'];
const RELEASE_KEYS = ['release_id','request_id','request_digest','grant_id','grant_digest','attempt_id','reservation_id','external_id',
  'preparation_id','preparation_digest','deadline','decision','grant_state'];
function attendance() { return require('./nexi-attendance.cjs'); }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function physicalDispatchEnabled() { return false; } // Source capability; no ENV/admin activation.

function claims(source, envelope, now = Date.now()) {
  const value = attendance().verifyEnvelope(source, envelope, 'attendance-authority', 32768);
  if (!exact(value, KEYS) || value.version !== 1 || value.protocol_version !== 1 || value.canonical_version !== canonical.VERSION ||
      value.audience !== 'nexi-attendance-evolution' || value.provider !== 'evolution-baileys' ||
      value.instance !== source.instance.name || value.instance_id !== source.instanceId || value.physical_dispatch !== false ||
      !UUID.test(value.request_id || '') || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 60000 ||
      !['consume','consumption_readback','preparation_readback'].includes(value.action)) fail('nexi_attendance_authority_invalid');
  return value;
}
function material(value) {
  if (!exact(value, ['consumption_id','grant','grant_digest','release','release_digest']) || !UUID.test(value.consumption_id || '') ||
      !exact(value.grant, GRANT_KEYS) || !exact(value.release, RELEASE_KEYS) ||
      canonical.digest(value.grant) !== value.grant_digest || canonical.digest(value.release) !== value.release_digest)
    fail('nexi_attendance_authority_material_conflict');
  const g = value.grant, r = value.release;
  if (!['grant_id','admission_id','request_id','execution_id','attempt_id','reservation_id','preparation_id','instance_lineage_id','sender_account_lineage_id'].every(k => UUID.test(g[k] || '')) ||
      !['request_digest','authority_snapshot_digest','preparation_digest','prepared_content_digest','session_identity'].every(k => HASH.test(g[k] || '')) ||
      !['account_id','managed_channel_id','message_id','identity_version_id','writer_epoch','binding_generation','expires_at'].every(k => Number.isSafeInteger(g[k]) && g[k] > 0) ||
      !Number.isSafeInteger(g.transport_unit_index) || g.transport_unit_index < 0 ||
      typeof g.external_id !== 'string' || !g.external_id.length || Buffer.byteLength(g.external_id) > 512 || g.external_id.includes('\0') ||
      g.scope !== 'attendance_release_v1' || g.physical_dispatch !== false ||
      !UUID.test(r.release_id || '') || !UUID.test(r.request_id || '') || !HASH.test(r.request_digest || '') ||
      r.decision !== 'released' || r.grant_state !== 'release_committed' || !Number.isSafeInteger(r.deadline) || r.deadline <= 0 || r.deadline > g.expires_at ||
      !['grant_id','attempt_id','reservation_id','external_id','preparation_id','preparation_digest'].every(k => r[k] === g[k]) || r.grant_digest !== value.grant_digest ||
      r.request_digest !== canonical.digest({ admission_id:g.admission_id, grant_id:g.grant_id, grant_digest:value.grant_digest,
        attempt_id:g.attempt_id, reservation_id:g.reservation_id })) fail('nexi_attendance_release_required');
  return value;
}
function binding(source, row, m) {
  const g = m.grant, a = row.authority;
  if (row.canonicalVersion !== canonical.VERSION || row.instanceId !== source.instanceId || row.instanceName !== source.instance.name ||
      row.id !== g.preparation_id || row.executionId !== g.execution_id || row.transportUnit !== g.transport_unit_index ||
      row.attemptId !== g.attempt_id || row.reservationId !== g.reservation_id || row.externalId !== g.external_id ||
      row.sessionIdentity !== g.session_identity || row.authorityDigest !== g.authority_snapshot_digest ||
      row.preparationDigest !== g.preparation_digest || row.contentDigest !== g.prepared_content_digest ||
      row.intent.identity_version_id !== g.identity_version_id || !row.frozenAt ||
      !['account_id','managed_channel_id','instance_lineage_id','sender_account_lineage_id','session_identity','writer_epoch','binding_generation'].every(k => a[k] === g[k]) ||
      row.contentDigest !== canonical.digest({ intent:row.intent, attempt_id:row.attemptId, reservation_id:row.reservationId,
        external_id:row.externalId, authority:a }) || row.preparationDigest !== canonical.digest({ content_digest:row.contentDigest,
        authority_digest:row.authorityDigest, preparation_id:row.id, nonce:row.preparationNonce, revision:row.preparationRevision }))
    fail('nexi_attendance_consumption_binding_conflict');
}
async function clock(tx) {
  const rows = await tx.$queryRawUnsafe("SELECT CURRENT_TIMESTAMP AS attendance_now");
  const now = +new Date(rows[0]?.attendance_now);
  if (!Number.isSafeInteger(now) || now <= 0) fail('nexi_attendance_authority_storage_unavailable');
  return now;
}
async function storageGuard(tx) {
  const provider = process.env.DATABASE_PROVIDER || 'postgresql';
  // Exact source fingerprints are checked in the catalog, not a cache or an
  // in-process capability flag. Missing storage/guards fail before any CAS.
  const guard = require('./nexi-attendance-storage-guard.cjs');
  await guard.verify(tx, provider);
}
function result(row, m) {
  return { request_digest:canonical.digest(m), consumption_id:m.consumption_id, grant_id:m.grant.grant_id,
    release_id:m.release.release_id, preparation_id:m.grant.preparation_id, attempt_id:m.grant.attempt_id,
    reservation_id:m.grant.reservation_id, external_id:m.grant.external_id, state:row?.state || 'unresolved',
    consumed_at:row?.releaseConsumedAt ? +row.releaseConsumedAt : null,
    dispatch_started_at:row?.dispatchStartedAt ? +row.dispatchStartedAt : null,
    outcome_unknown:row?.outcomeUnknown || false, physical_dispatch:false };
}
function replay(row, m) {
  if (row.consumptionId !== m.consumption_id || row.consumptionDigest !== canonical.digest(m) ||
      row.grantId !== m.grant.grant_id || row.grantDigest !== m.grant_digest || row.releaseId !== m.release.release_id ||
      row.releaseDigest !== m.release_digest || canonical.digest(row.releasedAuthority) !== canonical.digest(m))
    fail('nexi_attendance_consumption_conflict');
}
async function consumption(source, authorityClaims) {
  const m = material(authorityClaims.material);
  if (authorityClaims.request_id !== m.consumption_id) fail('nexi_attendance_consumption_identity_conflict');
  return source.prismaRepository.$transaction(async tx => {
    await storageGuard(tx);
    const db = tx.nexiAttendancePreparation;
    let row = await db.findUnique({ where:{ id:m.grant.preparation_id } });
    if (!row) fail('nexi_attendance_consumption_preparation_unresolved');
    binding(source, row, m);
    if (row.consumptionId) { replay(row, m); return result(row, m); }
    if (authorityClaims.action === 'consumption_readback') return result(null, m);
    const now = await clock(tx);
    if (now >= m.grant.expires_at || now >= m.release.deadline) fail('nexi_attendance_authority_expired');
    if (!['prepared','awaiting_admission'].includes(row.state) || row.admissionId || row.releaseId || row.dispatchStartedAt || row.outcomeUnknown)
      fail('nexi_attendance_consumption_fenced');
    if (!source.service || source.service.instanceId !== source.instanceId || source.service.instance.name !== source.instance.name ||
        identity.sessionFingerprint(source.service.client?.authState?.creds) !== row.sessionIdentity)
      fail('nexi_attendance_consumption_session_changed');
    const owner = require('./nexi-groups.cjs').lifecycleCapture(source.service);
    if (!source.service.client?.ws?.isOpen || !require('./nexi-groups.cjs').lifecycleCurrent(owner))
      fail('nexi_attendance_consumption_session_changed');
    const changed = await db.updateMany({ where:{ id:row.id, revision:row.revision, state:row.state, consumptionId:null }, data:{
      admissionId:m.grant.admission_id, grantId:m.grant.grant_id, grantDigest:m.grant_digest,
      releaseId:m.release.release_id, releaseDigest:m.release_digest, consumptionId:m.consumption_id,
      consumptionDigest:canonical.digest(m), releasedAuthority:m, releaseConsumedAt:new Date(now),
      authorityDeadline:new Date(m.release.deadline), state:'dispatch_ready_but_disabled', revision:{increment:1} } });
    row = await db.findUnique({ where:{id:row.id} });
    if (changed.count !== 1) { if (!row?.consumptionId) fail('nexi_attendance_consumption_conflict'); replay(row,m); }
    return result(row,m);
  }, { maxWait:3000, timeout:10000 });
}
async function preparationReadback(source, value) {
  const m = value.material;
  if (!exact(m,['execution_id','transport_unit','prepare_request_id','preparation_id','attempt_id']) ||
      !['execution_id','prepare_request_id','preparation_id','attempt_id'].every(k => UUID.test(m[k] || '')) ||
      value.request_id !== m.prepare_request_id || !Number.isSafeInteger(m.transport_unit) || m.transport_unit<0)
    fail('nexi_attendance_preparation_readback_invalid');
  const row = await source.prismaRepository.nexiAttendancePreparation.findUnique({where:{id:m.preparation_id}});
  if (!row || row.instanceId !== source.instanceId || row.instanceName !== source.instance.name || row.executionId !== m.execution_id ||
      row.transportUnit !== m.transport_unit || row.attemptId !== m.attempt_id || row.requestId !== m.prepare_request_id)
    fail('nexi_attendance_preparation_readback_unresolved');
  // Follow only the transport's committed original successor references. No
  // readback allocates anything, even during the collision/creation crash gap.
  const chain=[],seen=new Set([row.id]);let previous=row;
  while (previous.successorId && chain.length<32) {
    if (previous.state!=='definitively_not_sent' || previous.closureReason!=='collision_fenced' || !previous.closedAt ||
        previous.reservationId || previous.admissionId || previous.releaseId || previous.dispatchStartedAt)
      fail('nexi_attendance_successor_unproved');
    const next=await source.prismaRepository.nexiAttendancePreparation.findUnique({where:{id:previous.successorId}});
    if (!next) break;
    if (seen.has(next.id) || next.requestId!==previous.requests.replacement || next.requests.predecessor!==previous.id ||
        next.instanceId!==row.instanceId || next.instanceName!==row.instanceName || next.executionId!==row.executionId ||
        next.transportUnit!==row.transportUnit || next.preparationRevision!==previous.preparationRevision+1 ||
        canonical.digest(next.intent)!==canonical.digest(row.intent) || canonical.digest(next.authority)!==canonical.digest(row.authority))
      fail('nexi_attendance_successor_conflict');
    if (!next.attemptId) break;
    chain.push({predecessor_preparation_id:previous.id,predecessor_request_id:previous.requestId,
      predecessor_attempt_id:previous.attemptId,predecessor_external_id:previous.externalId,closure_request_id:previous.requests.close_collision,
      successor_preparation_id:next.id,successor_request_id:next.requestId,successor_attempt_id:next.attemptId,successor_external_id:next.externalId});
    previous=next;seen.add(next.id);
  }
  if (previous.successorId && chain.length===32) fail('nexi_attendance_successor_chain_limit');
  return { state:row.state, preparation_id:row.id, successor_chain:chain, physical_dispatch:false };
}
function response(source, requestClaims, materialValue, now = Date.now()) {
  return attendance().signEnvelope(source, { version:1, protocol_version:1, canonical_version:canonical.VERSION,
    audience:'nexi-attendance-app', provider:'evolution-baileys', instance:source.instance.name, instance_id:source.instanceId,
    request_id:requestClaims.request_id, expires_at:now+60000,
    action:requestClaims.action==='preparation_readback'?'preparation_result':'consumption_result',
    material:materialValue, physical_dispatch:false }, 'attendance-authority');
}
async function dispatchStart(source, preparationId, consumptionId, stanza) {
  return source.prismaRepository.$transaction(async tx => {
    await storageGuard(tx);
    const db = tx.nexiAttendancePreparation, row = await db.findUnique({where:{id:preparationId}});
    if (!row?.consumptionId || row.consumptionId !== consumptionId) fail('nexi_attendance_dispatch_unconsumed');
    const m = material(row.releasedAuthority); binding(source,row,m); replay(row,m);
    // Even after a crash or a socket exception the original CAS is permanent.
    if (row.dispatchStartedAt) return { started:false, outcome_unknown:true };
    const now = await clock(tx);
    const owner=source.service && require('./nexi-groups.cjs').lifecycleCapture(source.service);
    if (row.state !== 'dispatch_ready_but_disabled' || now>=m.release.deadline || now>=m.grant.expires_at ||
        !row.releaseConsumedAt || row.outcomeUnknown || stanza?.attrs?.id !== row.externalId || stanza?.attrs?.to !== row.recipient ||
        identity.sessionFingerprint(source.service?.client?.authState?.creds) !== row.sessionIdentity ||
        source.service.instanceId !== source.instanceId || source.service.instance.name !== source.instance.name ||
        !source.service.client?.ws?.isOpen || !require('./nexi-groups.cjs').lifecycleCurrent(owner))
      fail('nexi_attendance_dispatch_fenced');
    const changed = await db.updateMany({ where:{id:row.id,revision:row.revision,state:'dispatch_ready_but_disabled',
      consumptionId,dispatchStartedAt:null}, data:{state:'dispatch_started',dispatchStartedAt:new Date(now),outcomeUnknown:true,revision:{increment:1}} });
    return { started:changed.count===1, outcome_unknown:true };
  }, { maxWait:3000, timeout:10000 });
}
async function transportReturned(source, preparationId, consumptionId, succeeded) {
  // A method return/error is separate evidence, never SERVER_ACK/not-sent.
  return source.prismaRepository.$transaction(async tx => {
    await storageGuard(tx);
    const db=tx.nexiAttendancePreparation, row=await db.findUnique({where:{id:preparationId}});
    if (!row?.dispatchStartedAt || row.consumptionId!==consumptionId) fail('nexi_attendance_transport_return_unstarted');
    if (row.transportReturn) return row;
    await db.updateMany({where:{id:row.id,revision:row.revision,state:'dispatch_started',transportReturn:null},
      data:{state:succeeded?'transport_returned':'outcome_unknown',transportReturn:{boundary_returned:true,succeeded:!!succeeded},
        outcomeUnknown:true,revision:{increment:1}}});
    return db.findUnique({where:{id:row.id}});
  });
}
function installRoute(router, monitor, guard, repository) {
  router.post('/nexi/attendance/authority/:instanceName', guard, async (req,res) => {
    try {
      const instance=await repository.instance.findUnique({where:{name:req.params.instanceName}});
      if (!instance) return res.sendStatus(404);
      const source={prismaRepository:repository,instanceId:instance.id,instance:{name:instance.name},service:monitor.waInstances[instance.name]};
      const value=claims(source,req.body);
      if (value.action==='preparation_readback') return res.json(response(source,value,
        {...await preparationReadback(source,value),request_digest:canonical.digest(value.material)}));
      const observed=await consumption(source,value);
      return res.json(response(source,value,observed));
    } catch(error) {
      return res.status(error.code?.includes('conflict')?409:422).json({error:'nexi_attendance_authority_unresolved',physical_dispatch:false});
    }
  });
}
module.exports={claims,material,binding,consumption,preparationReadback,response,dispatchStart,transportReturned,physicalDispatchEnabled,installRoute};
