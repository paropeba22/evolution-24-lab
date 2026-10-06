'use strict';
// Offline producer fixture: executes the accepted Evolution prepare function.
// The fake durable row fixes randomness; no HTTP or WhatsApp capability exists.
const attendance=require('../nexi-attendance.cjs');
const identity=require('../nexi-identity.cjs');
global.fetch=()=>{throw Error('NETWORK_TRAP');};
const credentials={me:{id:'5511999999999:1@s.whatsapp.net',lid:'100001@lid'},registrationId:9,
  signedIdentityKey:{public:Buffer.alloc(32,7)},account:{accountSignatureKey:Buffer.alloc(32,3),accountSignature:Buffer.alloc(64,4),details:Buffer.from([1,2])}};
const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const now=Date.parse('2030-01-01T00:00:00.000Z');
const context={version:1,protocol_version:1,canonical_version:attendance.CANONICAL_VERSION,audience:'nexi-attendance-evolution',provider:'evolution-baileys',
  account_id:1,inbox_id:2,managed_channel_id:3,instance_id:uuid(1),instance:'nexi-wa-fixture',instance_lineage_id:uuid(2),sender_account_lineage_id:uuid(3),
  sender_attestation_id:uuid(4),session_identity:identity.sessionFingerprint(credentials),original_session_identity:null,binding_generation:1,writer_epoch:7,
  writer_protocol_version:1,barrier_state:'staged',channel_state:'active',current_session:true,physical_dispatch:false,isolation_cutover:false};
const payload={kind:'text',body:'exact Ω, case-sensitive candidate',reply_to:null};
const intent={canonical_version:attendance.CANONICAL_VERSION,execution_id:uuid(5),transport_unit:0,authority_digest:'a'.repeat(64),
  payload_digest:attendance.digest(payload),identity_version_id:4,recipient:'5511888888888@s.whatsapp.net',payload};
let row={canonicalVersion:attendance.CANONICAL_VERSION,id:uuid(6),instanceId:context.instance_id,instanceName:context.instance,
  executionId:intent.execution_id,attemptId:uuid(7),transportUnit:0,requestId:uuid(8),inputDigest:attendance.digest({context,intent,predecessor_id:null}),requests:{},
  authority:context,intent,authorityDigest:intent.authority_digest,payloadDigest:intent.payload_digest,recipient:intent.recipient,sessionIdentity:context.session_identity,
  externalId:'3EB0A77E1BCaseSensitiveFixture',reservationId:uuid(9),preparationNonce:'c'.repeat(64),preparationRevision:1,
  state:'reserved',revision:1,reservedAt:new Date(now),recoveryAttempts:0,consumptionId:null,dispatchStartedAt:null,outcomeUnknown:false};
const db={async updateMany({where,data}){if(where.id!==row.id||where.revision!==row.revision||where.state!==row.state)return {count:0};
  row={...row,...data,revision:row.revision+1,frozenAt:new Date(now)};return {count:1};},async findUnique(){return row;}};
const repo={nexiAttendancePreparation:db,nexiAttendanceEventOutbox:{async findUnique(){return null;},async create({data}){return data;}},async $transaction(work){return work(this);}};
attendance.prepare({prismaRepository:repo,instanceId:context.instance_id,instance:{name:context.instance},logger:{warn(){}}},row,()=>{throw Error('NETWORK_TRAP');})
  .then(prepared=>process.stdout.write(JSON.stringify({producer:'Evolution prepare -> APP ReleaseContract -> Evolution consumption',now,prepared_row:prepared})))
  .catch(error=>{console.error(error);process.exitCode=1;});
