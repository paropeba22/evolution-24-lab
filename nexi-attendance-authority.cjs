'use strict';

// Transport-local extension of Attendance. All logical authority arrives in
// APP-signed canonical envelopes; no actor/account/identity policy lives here.
const identity = require('./nexi-identity.cjs');
const canonical = require('./nexi-canonical-json.cjs');
const { performance } = require('node:perf_hooks');
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
function authorityTiming(source, phase, preparationId, started, result) {
  try {
    const duration = Math.round(performance.now() - started);
    const lane = result === 'failed' ? 'failed' : duration >= 1000 ? 'slow' : 'sampled';
    if (!attendance().allowDiagnosticTrace(lane)) return;
    const effective = process.env.NEXI_RUNTIME_REVISION || '';
    const data = { event: 'attendance.authority_timing', phase, result, timestamp: new Date().toISOString(),
      marker: 's2-authority-observability-v1', runtime_revision: /^[0-9a-f]{40}$/i.test(effective) ? effective : 'unknown',
      duration_ms: duration };
    if (UUID.test(source?.instanceId || '')) data.instance_id = source.instanceId;
    if (UUID.test(preparationId || '')) data.preparation_id = preparationId;
    if (source?.logger?.info) source.logger.info(data); else console.info(JSON.stringify(data));
  } catch { /* timing cannot alter authority or CAS */ }
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const WRITER_VERSION = 2;
function physicalDispatchEnabled(source, row) {
  const scoped = row?.authority?.isolated_operation || row?.releasedAuthority?.grant?.isolated_operation;
  return !!(source?.service && row?.releasedAuthority?.grant?.scope === 'attendance_dispatch_v1' &&
    row.releasedAuthority.grant.physical_dispatch === true && row.authority?.physical_dispatch === true &&
    row.authority.isolation_cutover === true && row.authority.barrier_state === 'active' &&
    row.authority.writer_protocol_version === WRITER_VERSION && (!scoped ||
      canonical.digest(row.authority.isolated_operation || null) === canonical.digest(row.releasedAuthority.grant.isolated_operation || null)));
}

function claims(source, envelope, now = Date.now()) {
  const value = attendance().verifyEnvelope(source, envelope, 'attendance-authority', 32768);
  if (!exact(value, KEYS) || value.version !== 1 || value.protocol_version !== 1 || value.canonical_version !== canonical.VERSION ||
      value.audience !== 'nexi-attendance-evolution' || value.provider !== 'evolution-baileys' ||
      value.instance !== source.instance.name || value.instance_id !== source.instanceId || ![true,false].includes(value.physical_dispatch) ||
      !UUID.test(value.request_id || '') || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 60000 ||
      !['consume','consumption_readback','preparation_readback','writer_probe'].includes(value.action)) fail('nexi_attendance_authority_invalid');
  if (value.physical_dispatch !== (value.material?.grant?.physical_dispatch === true)) fail('nexi_attendance_authority_invalid');
  return value;
}
function material(value) {
  if (!exact(value, ['consumption_id','grant','grant_digest','release','release_digest']) || !UUID.test(value.consumption_id || '') ||
      !exact(value.grant, Object.hasOwn(value.grant || {}, 'isolated_operation') ? [...GRANT_KEYS,'isolated_operation'] : GRANT_KEYS) || !exact(value.release, RELEASE_KEYS) ||
      canonical.digest(value.grant) !== value.grant_digest || canonical.digest(value.release) !== value.release_digest)
    fail('nexi_attendance_authority_material_conflict');
  const g = value.grant, r = value.release;
  if (Object.hasOwn(g, 'isolated_operation')) require('./nexi-attendance-isolated.cjs').validate(g.isolated_operation, g.isolated_operation?.approved_at);
  if (!['grant_id','admission_id','request_id','execution_id','attempt_id','reservation_id','preparation_id','instance_lineage_id','sender_account_lineage_id'].every(k => UUID.test(g[k] || '')) ||
      !['request_digest','authority_snapshot_digest','preparation_digest','prepared_content_digest','session_identity'].every(k => HASH.test(g[k] || '')) ||
      !['account_id','managed_channel_id','message_id','identity_version_id','writer_epoch','binding_generation','expires_at'].every(k => Number.isSafeInteger(g[k]) && g[k] > 0) ||
      !Number.isSafeInteger(g.transport_unit_index) || g.transport_unit_index < 0 ||
      typeof g.external_id !== 'string' || !g.external_id.length || Buffer.byteLength(g.external_id) > 512 || g.external_id.includes('\0') ||
      !((g.scope === 'attendance_release_v1' && g.physical_dispatch === false) ||
        (g.scope === 'attendance_dispatch_v1' && g.physical_dispatch === true)) ||
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
      (g.physical_dispatch && !physicalDispatchEnabled(source, {...row,releasedAuthority:m})) ||
      row.intent.identity_version_id !== g.identity_version_id || !row.frozenAt ||
      !['account_id','managed_channel_id','instance_lineage_id','sender_account_lineage_id','session_identity','writer_epoch','binding_generation'].every(k => a[k] === g[k]) ||
      row.contentDigest !== canonical.digest({ intent:row.intent, attempt_id:row.attemptId, reservation_id:row.reservationId,
        external_id:row.externalId, authority:a }) || row.preparationDigest !== canonical.digest({ content_digest:row.contentDigest,
        authority_digest:row.authorityDigest, preparation_id:row.id, nonce:row.preparationNonce, revision:row.preparationRevision }))
    fail('nexi_attendance_consumption_binding_conflict');
  if (Object.hasOwn(m.grant, 'isolated_operation') || Object.hasOwn(a, 'isolated_operation')) {
    require('./nexi-attendance-isolated.cjs').grant(source, row, m, m.grant.isolated_operation?.approved_at, {history:true});
  }
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
    outcome_unknown:row?.outcomeUnknown || false, physical_dispatch:m.grant.physical_dispatch };
}
function replay(row, m) {
  if (row.consumptionId !== m.consumption_id || row.consumptionDigest !== canonical.digest(m) ||
      row.grantId !== m.grant.grant_id || row.grantDigest !== m.grant_digest || row.releaseId !== m.release.release_id ||
      row.releaseDigest !== m.release_digest || canonical.digest(row.releasedAuthority) !== canonical.digest(m))
    fail('nexi_attendance_consumption_conflict');
}
async function consumption(source, authorityClaims) {
  if (authorityClaims.action === 'consume' && attendance().cutoverHeld() && !authorityClaims.material?.grant?.isolated_operation)
    fail('nexi_attendance_cutover_held');
  const m = material(authorityClaims.material);
  if (authorityClaims.request_id !== m.consumption_id) fail('nexi_attendance_consumption_identity_conflict');
  const started = performance.now();
  try {
    const committed = await source.prismaRepository.$transaction(async tx => {
    authorityTiming(source, `${authorityClaims.action}.transaction_acquired`, m.grant.preparation_id, started, 'returned');
    const guardStarted = performance.now();
    await storageGuard(tx);
    authorityTiming(source, `${authorityClaims.action}.storage_guard`, m.grant.preparation_id, guardStarted, 'returned');
    const db = tx.nexiAttendancePreparation;
    let row = await db.findUnique({ where:{ id:m.grant.preparation_id } });
    if (!row) fail('nexi_attendance_consumption_preparation_unresolved');
    binding(source, row, m);
    if (row.consumptionId) { replay(row, m); return result(row, m); }
    if (authorityClaims.action === 'consumption_readback') return result(null, m);
    const now = await clock(tx);
    if (m.grant.isolated_operation) require('./nexi-attendance-isolated.cjs').grant(source, row, m, now);
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
    authorityTiming(source, `${authorityClaims.action}.transaction_returned`, m.grant.preparation_id, started, 'returned');
    return committed;
  } catch (error) {
    authorityTiming(source, `${authorityClaims.action}.transaction_returned`, m.grant.preparation_id, started, 'failed');
    throw error;
  }
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
    action:requestClaims.action==='writer_probe'?'writer_result':requestClaims.action==='preparation_readback'?'preparation_result':'consumption_result',
    material:materialValue, physical_dispatch:requestClaims.physical_dispatch === true }, 'attendance-authority');
}
async function dispatchStart(source, preparationId, consumptionId, stanza) {
  const groups = require('./nexi-groups.cjs'), owner = groups.lifecycleCapture(source.service);
  const snapshot = await attendance().captureContextSnapshot(source, owner), current = snapshot.context;
  if (!UUID.test(owner.token || '') || !groups.lifecycleCurrent(owner) || !current?.physical_dispatch)
    fail('nexi_attendance_dispatch_fenced');
  const result = await source.prismaRepository.$transaction(async tx => {
    await storageGuard(tx);
    // Serialize with socket replacement across processes. A stale process
    // cannot dispatch using only its own in-memory lifecycle snapshot.
    const socket = await tx.instance.updateMany({where:{id:source.instanceId,nexiGroupsSocketOwner:owner.token},
      data:{nexiGroupsSocketOwner:owner.token}});
    if (socket.count !== 1 || !groups.lifecycleCurrent(owner)) fail('nexi_attendance_dispatch_fenced');
    // Match expiryReadback's row lock before reading authority or its clock.
    // MySQL statement time must not be captured before waiting for this lock.
    const mysql = process.env.DATABASE_PROVIDER === 'mysql';
    const locked = await tx.$queryRawUnsafe(mysql ? 'SELECT id FROM NexiAttendancePreparation WHERE id=? FOR UPDATE' :
      'SELECT id FROM "NexiAttendancePreparation" WHERE id=$1 FOR UPDATE',preparationId);
    if (!Array.isArray(locked) || locked.length !== 1) fail('nexi_attendance_dispatch_unconsumed');
    const db = tx.nexiAttendancePreparation, row = await db.findUnique({where:{id:preparationId}});
    if (!row?.consumptionId || row.consumptionId !== consumptionId) fail('nexi_attendance_dispatch_unconsumed');
    const m = material(row.releasedAuthority); binding(source,row,m); replay(row,m);
    // Even after a crash or a socket exception the original CAS is permanent.
    if (row.dispatchStartedAt) return { started:false, outcome_unknown:true };
    const now = await clock(tx);
    if (m.grant.isolated_operation) require('./nexi-attendance-isolated.cjs').grant(source, row, m, now);
    if (canonical.digest(current.isolated_operation || null) !== canonical.digest(row.authority.isolated_operation || null))
      fail('nexi_attendance_dispatch_fenced');
    if (row.state !== 'dispatch_ready_but_disabled' || now>=m.release.deadline || now>=m.grant.expires_at ||
        current.writer_epoch !== row.authority.writer_epoch || current.binding_generation !== row.authority.binding_generation ||
        current.session_identity !== row.sessionIdentity || current.managed_channel_id !== row.authority.managed_channel_id ||
        !['account_id', 'inbox_id', 'instance_lineage_id', 'sender_account_lineage_id', 'sender_attestation_id']
          .every(key => current[key] === row.authority[key]) ||
        !row.releaseConsumedAt || row.outcomeUnknown || stanza?.attrs?.id !== row.externalId || stanza?.attrs?.to !== row.recipient ||
        identity.sessionFingerprint(source.service?.client?.authState?.creds) !== row.sessionIdentity ||
        source.service.instanceId !== source.instanceId || source.service.instance.name !== source.instance.name ||
        !source.service.client?.ws?.isOpen || !require('./nexi-groups.cjs').lifecycleCurrent(owner))
      fail('nexi_attendance_dispatch_fenced');
    // The same socket/authority used by the transport must be installed in
    // capture before its one-way dispatch CAS. No APP call spans this lock.
    attendance().writerIsolation(source, current);
    attendance().installCaptureContext(snapshot);
    const changed = await db.updateMany({ where:{id:row.id,revision:row.revision,state:'dispatch_ready_but_disabled',
      consumptionId,dispatchStartedAt:null}, data:{state:'dispatch_started',dispatchStartedAt:new Date(now),outcomeUnknown:true,revision:{increment:1}} });
    return { started:changed.count===1, outcome_unknown:true };
  }, { maxWait:3000, timeout:10000 });
  // A concurrent socket/context change after CAS is unknown, never retryable.
  if (result.started && !attendance().captureContextCurrent(snapshot, true)) fail('nexi_attendance_capture_context_superseded');
  return result;
}
async function transportReturned(source, preparationId, consumptionId, succeeded) {
  // A method return/error is separate evidence, never SERVER_ACK/not-sent.
  return source.prismaRepository.$transaction(async tx => {
    await storageGuard(tx);
    const db=tx.nexiAttendancePreparation, row=await db.findUnique({where:{id:preparationId}});
    if (!row?.dispatchStartedAt || row.consumptionId!==consumptionId) fail('nexi_attendance_transport_return_unstarted');
    if (row.transportReturn) return row;
    // Json? filters reject bare null. The read above and revision/state CAS
    // already fence a concurrent return without a provider-specific JSON filter.
    await db.updateMany({where:{id:row.id,revision:row.revision,state:'dispatch_started'},
      data:{state:succeeded?'transport_returned':'outcome_unknown',transportReturn:{boundary_returned:true,succeeded:!!succeeded},
        outcomeUnknown:true,revision:{increment:1}}});
    return db.findUnique({where:{id:row.id}});
  });
}
function installRoute(router, monitor, guard, repository) {
  router.post('/nexi/attendance/authority/:instanceName', guard, async (req,res) => {
    let probe=null;
    try {
      probe=attendance().writerProbeTrace(req.body);
      probe?.stage('request_received');
      const instance=await repository.instance.findUnique({where:{name:req.params.instanceName}});
      if (!instance) { probe?.instanceMissing(); return res.sendStatus(404); }
      const source={prismaRepository:repository,instanceId:instance.id,instance:{name:instance.name},service:monitor.waInstances[instance.name]};
      probe?.attempt('contract_validation');
      const value=claims(source,req.body);
      if (value.action==='writer_probe') {
        const scoped = value.material?.isolated_operation;
        if (attendance().cutoverHeld() && !scoped) fail('nexi_attendance_cutover_held');
        if (scoped && !require('./nexi-attendance-isolated.cjs').enabled()) fail('nexi_attendance_cutover_held');
        probe?.stage('signed_contract_validated');
        probe?.attempt('socket_validation');
        const m=value.material, groups=require('./nexi-groups.cjs');
        const owner=source.service && groups.lifecycleCapture(source.service);
        const materialKeys = scoped ? ['managed_channel_id','session_identity','isolated_operation'] : ['managed_channel_id','session_identity'];
        probe?.socketChecks(() => ({ material_valid:!!exact(m,materialKeys) && Number.isSafeInteger(m?.managed_channel_id),
          socket_open:!!source.service?.client?.ws?.isOpen, owner_token_valid:UUID.test(owner?.token || ''),
          lifecycle_current:!!groups.lifecycleCurrent(owner),
          session_matches:identity.sessionFingerprint(source.service?.client?.authState?.creds)===m?.session_identity }));
        if (!exact(m,materialKeys) || !Number.isSafeInteger(m.managed_channel_id) ||
            !source.service?.client?.ws?.isOpen || !UUID.test(owner?.token || '') || !groups.lifecycleCurrent(owner) ||
            identity.sessionFingerprint(source.service.client.authState?.creds)!==m.session_identity)
          fail('nexi_attendance_writer_unavailable');
        probe?.stage('instance_socket_verified');
        probe?.attempt('context_request_setup');
        const snapshot=await attendance().captureContextSnapshot(source,owner,probe), context=snapshot.context;
        if (scoped) require('./nexi-attendance-isolated.cjs').context(source,context,scoped,Date.now(),{probe:true});
        probe?.attempt('binding_validation');
        if (context.managed_channel_id!==m.managed_channel_id || context.session_identity!==m.session_identity || context.barrier_state!=='fencing')
          fail('nexi_attendance_writer_binding_conflict');
        probe?.stage('binding_fencing_validated');
        probe?.attempt('storage_guard');
        await repository.$transaction(async tx => {
          await storageGuard(tx);
          probe?.stage('storage_guard_executed');
          probe?.attempt('writer_isolation');
          const current=await tx.instance.updateMany({where:{id:source.instanceId,nexiGroupsSocketOwner:owner.token},
            data:{nexiGroupsSocketOwner:owner.token}});
          // Retain the original evaluation order and omit unreached checks.
          const checks={};
          const rejected=!(checks.database_socket_owner_matched=current.count===1) ||
            !(checks.lifecycle_current_after_cas=!!groups.lifecycleCurrent(owner)) ||
            !(checks.socket_open_after_cas=!!source.service.client?.ws?.isOpen);
          probe?.isolationChecks(() => checks);
          if (rejected) fail('nexi_attendance_writer_isolation_unproved');
          attendance().writerIsolation(source,context,probe);
          attendance().installCaptureContext(snapshot);
        });
        // This separate rejection can occur while the transaction completes.
        const lifecycleCurrent=groups.lifecycleCurrent(owner);
        probe?.isolationChecks(() => ({lifecycle_current_after_transaction:!!lifecycleCurrent}));
        if (!lifecycleCurrent || !attendance().captureContextCurrent(snapshot,true)) fail('nexi_attendance_writer_isolation_unproved');
        probe?.stage('writer_isolation_proved');
        probe?.attempt('response_production');
        const proof=response(source,value,{request_digest:canonical.digest(m),writer_version:WRITER_VERSION,
          storage_guarded:true,physical_dispatch:true,session_identity:m.session_identity,isolated_writer:'nexi-app',
          socket_owner:owner.token,verified_account_identity:true,account_id:context.account_id,inbox_id:context.inbox_id,
          writer_epoch:context.writer_epoch,binding_generation:context.binding_generation,
          receipt_context:Object.fromEntries(['instance_lineage_id','sender_account_lineage_id','sender_attestation_id'].map(key=>[key,context[key]])),
          ...(scoped ? {isolated_operation_id:scoped.authorization_id} : {})});
        probe?.stage('proof_response_produced');
        return res.json(proof);
      }
      if (value.action==='preparation_readback') return res.json(response(source,value,
        {...await preparationReadback(source,value),request_digest:canonical.digest(value.material)}));
      let observed=await consumption(source,value);
      if (value.material.grant.physical_dispatch && observed.consumed_at && !observed.dispatch_started_at) {
        const dispatch=require('./nexi-attendance-dispatch.cjs');
        // A readback never initiates a physical operation, including replay of
        // an already-consumed grant whose lexical dispatch has not started.
        observed=value.action==='consume' ? await dispatch.dispatch(source,value.material) :
          await dispatch.expiryReadback(source,value.material) || observed;
      }
      return res.json(response(source,value,observed));
    } catch(error) {
      probe?.failure(error);
      return res.status(error.code?.includes('conflict')?409:422).json({error:'nexi_attendance_authority_unresolved',physical_dispatch:false});
    }
  });
}
module.exports={claims,material,binding,consumption,preparationReadback,response,result,dispatchStart,transportReturned,physicalDispatchEnabled,clock,storageGuard,WRITER_VERSION,installRoute};
