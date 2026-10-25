'use strict';

const { createHash, createHmac, timingSafeEqual, createPublicKey, randomUUID, verify: verifySignature } = require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const canonical = require('./nexi-canonical-json.cjs');
const enabled = () => process.env.NEXI_WHATSAPP_OWNER_GENERATION_ENABLED === 'true';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sequence = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const running = new Set();
const flushCursor = new Map();
const proposalCursor = new Map();
const APPROVAL_KEYS = ['version', 'purpose', 'key_id', 'authorization_id', 'owner_generation_id', 'cutover_digest',
  'old_lane_id', 'new_lane_id', 'scope_id', 'session_identity', 'pn_jid', 'lid_jid', 'account_id', 'inbox_id',
  'instance_id', 'instance_name', 'C', 'R', 'source_floor', 'witness_journal_id', 'witness_proof_digest', 'snapshot_digest', 'approved_at', 'expires_at'];
const REGISTRATION_KEYS = ['version', 'purpose', 'key_id', 'authorization_id', 'owner_generation_id',
  'cutover_digest', 'scope_id', 'new_lane_id', 'registered_at'];

// A separate provider-only key attests the full persisted state after the
// provider has verified HMAC/Ed25519. It is never a SQL parameter or an oracle.
function receiptKey() {
  const key=process.env.NEXI_INGRESS_OWNER_STORAGE_KEY;
  if (!/^[0-9a-f]{64}$/.test(key||'')) fail('nexi_ingress_owner_storage_key_invalid');
  return Buffer.from(key,'hex');
}
function stateDocument(table,row) {
  const state={};
  for (const [key,value] of Object.entries(row)) {
    if (['receipt','createdAt','delivery','source'].includes(key)) continue;
    state[key]=typeof value==='bigint'?value.toString():value instanceof Date?value.toISOString():value;
  }
  return {version:1,table,state};
}
function attested(table,row) {
  const body=canonical.bytes(stateDocument(table,row));
  return {...row,receipt:canonical.bytes({body,signature:createHmac('sha256',receiptKey()).update(body).digest('hex')})};
}
function verifyReceipt(table,row) {
  try {
    const packet=canonical.parse(row.receipt), expected=createHmac('sha256',receiptKey()).update(packet.body).digest();
    if (Object.keys(packet).sort().join()!=='body,signature' || !hex(packet.signature) ||
      !timingSafeEqual(expected,Buffer.from(packet.signature,'hex')) ||
      packet.body!==canonical.bytes(stateDocument(table,row))) fail('nexi_ingress_owner_state_unattested');
  } catch { fail('nexi_ingress_owner_state_unattested'); }
  return row;
}

async function storageGuard(repo) {
  receiptKey();
  // PostgreSQL 15+ only. No fallback when catalog/parameter ACL proof is absent.
  // The application role must not be able to disable these evidence guards.
  const rows=await repo.$queryRawUnsafe(`SELECT current_setting('server_version_num')::integer>=150000
    AND current_setting('session_replication_role')='origin' AND session_user=current_user
    AND current_schemas(false)=ARRAY['public']::name[] AND pg_my_temp_schema()=0
    AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
      (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
       OR r.rolname IN ('pg_read_server_files','pg_write_server_files','pg_execute_server_program')
       OR has_database_privilege(r.oid,current_database(),'TEMPORARY') OR has_database_privilege(r.oid,current_database(),'CREATE')
       OR EXISTS(SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(r.oid,n.oid,'CREATE'))
       OR has_parameter_privilege(r.oid,'session_replication_role','SET')
       OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
       OR EXISTS(SELECT 1 FROM pg_parameter_acl p WHERE has_parameter_privilege(r.oid,p.parname,'ALTER SYSTEM'))))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND pg_has_role(current_user,c.relowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND (pg_has_role(current_user,p.proowner,'MEMBER')
        OR (p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE'))))
    AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting d CROSS JOIN LATERAL unnest(d.setconfig) config
      WHERE d.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
        AND (d.setrole=0 OR pg_has_role(current_user,d.setrole,'MEMBER'))
        AND split_part(config,'=',1)='session_replication_role' AND split_part(config,'=',2)<>'origin') AS safe`);
  if (rows.length!==1 || rows[0].safe!==true) fail('nexi_ingress_owner_storage_unguarded');
  await schemaGuard(repo);
}
async function schemaGuard(repo) {
  const migration=fs.readFileSync(path.join(__dirname,'prisma/postgresql-migrations/20261025000000_nexi_ingress_owner_generations/migration.sql'),'utf8')
    .replaceAll('\r\n','\n');
  const expected=new Map([...migration.matchAll(/CREATE FUNCTION (nexi_ingress_owner_[a-z_]+)\(\) RETURNS trigger\nLANGUAGE plpgsql(?: SECURITY DEFINER)? SET search_path=pg_catalog,public,pg_temp AS \$\$([\s\S]*?)\$\$;/g)]
    .map(match=>[match[1],createHash('sha256').update(match[2]).digest('hex')]));
  if (expected.size!==5) fail('nexi_ingress_owner_schema_unguarded');
  const functions=await repo.$queryRawUnsafe(`SELECT p.proname,p.prosrc,p.prosecdef,p.proconfig,l.lanname,r.rolname AS owner,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND p.pronargs=0 AND p.proname IN ('nexi_ingress_owner_root_guard',
      'nexi_ingress_owner_generation_guard','nexi_ingress_owner_source_guard','nexi_ingress_owner_prefix_guard','nexi_ingress_owner_receipt_guard')`);
  if (functions.length!==5 || functions.some(p=>p.prosecdef!==(p.proname==='nexi_ingress_owner_receipt_guard') ||
      p.owner!=='nexi_evolution_guard_owner' || (p.prosecdef && p.executable) || p.lanname!=='plpgsql' ||
      JSON.stringify(p.proconfig)!==JSON.stringify(['search_path=pg_catalog, public, pg_temp']) ||
      expected.get(p.proname)!==createHash('sha256').update(p.prosrc.replaceAll('\r\n','\n')).digest('hex')))
    fail('nexi_ingress_owner_schema_unguarded');
  const vault=await repo.$queryRawUnsafe(`SELECT n.nspowner=r.oid AND c.relowner=r.oid AND e.extowner=r.oid
      AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb
      AND NOT r.rolreplication AND NOT r.rolbypassrls AND NOT pg_has_role(current_user,r.oid,'MEMBER')
      AND NOT has_schema_privilege(current_user,n.oid,'USAGE') AND NOT has_schema_privilege(current_user,n.oid,'CREATE')
      AND NOT has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
        AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
      AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid AND
        NOT EXISTS(SELECT 1 FROM pg_depend d
          WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass
            AND d.refobjid=e.oid AND d.deptype='e')) AS safe
    FROM pg_namespace n JOIN pg_roles r ON r.rolname='nexi_evolution_guard_owner'
    JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='receipt_key'
    JOIN pg_extension e ON e.extnamespace=n.oid AND e.extname='pgcrypto'
    WHERE n.nspname='nexi_ingress_owner_private'`);
  if (vault.length!==1 || vault[0].safe!==true) fail('nexi_ingress_owner_storage_unguarded');
  const triggerRows=await repo.$queryRawUnsafe(`SELECT t.tgname,c.relname,p.proname,t.tgtype,t.tgenabled,t.tgnargs,
    t.tgdeferrable,t.tgqual IS NULL AS unqualified FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname LIKE 'nexi_ingress_owner_%'`);
  const triggers=[
    ['a_receipt_root','NexiIngressOwnerRoot','receipt_guard',23],
    ['a_receipt_generation','NexiIngressOwnerGeneration','receipt_guard',23],
    ['a_receipt_source','NexiIngressOwnerSource','receipt_guard',23],
    ['a_receipt_delivery','NexiIngressOwnerDelivery','receipt_guard',23],
    ['root_guard','NexiIngressOwnerRoot','root_guard',31],['root_no_truncate','NexiIngressOwnerRoot','root_guard',34],
    ['generation_guard','NexiIngressOwnerGeneration','generation_guard',31],['generation_no_truncate','NexiIngressOwnerGeneration','generation_guard',34],
    ['source_guard','NexiIngressOwnerSource','source_guard',31],['source_no_truncate','NexiIngressOwnerSource','source_guard',34],
    ['delivery_guard','NexiIngressOwnerDelivery','source_guard',31],['delivery_no_truncate','NexiIngressOwnerDelivery','source_guard',34],
    ['frozen_journal','NexiIngressJournal','prefix_guard',31],['frozen_lane','NexiIngressLane','prefix_guard',27],
    ['journal_no_truncate','NexiIngressJournal','prefix_guard',34],['lane_no_truncate','NexiIngressLane','prefix_guard',34]];
  if (triggerRows.length!==triggers.length || !triggers.every(([name,table,fn,type])=>triggerRows.some(t=>
    t.tgname===`nexi_ingress_owner_${name}` && t.relname===table && t.proname===`nexi_ingress_owner_${fn}` &&
    t.tgtype===type && t.tgenabled==='O' && t.tgnargs===0 && !t.tgdeferrable && t.unqualified)))
    fail('nexi_ingress_owner_schema_unguarded');
  const unique=await repo.$queryRawUnsafe(`SELECT c.relname,array_agg(a.attname::text ORDER BY k.position) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position)
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
    WHERE n.nspname='public' AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND c.relname IN ('NexiIngressOwnerRoot','NexiIngressOwnerGeneration','NexiIngressOwnerSource','NexiIngressOwnerDelivery','NexiIngressJournal')
    GROUP BY c.relname,i.indexrelid`);
  const keys=[['NexiIngressOwnerRoot',['id']],['NexiIngressOwnerGeneration',['id']],['NexiIngressOwnerGeneration',['candidateId']],
    ['NexiIngressOwnerGeneration',['newLaneId']],['NexiIngressOwnerGeneration',['frozenLaneId']],['NexiIngressOwnerSource',['id']],
    ['NexiIngressOwnerSource',['dedupKey']],['NexiIngressOwnerSource',['rootLaneId','sequence']],
    ['NexiIngressOwnerDelivery',['sourceJournalId']],['NexiIngressOwnerDelivery',['deliveryJournalId']],
    ['NexiIngressJournal',['id']],['NexiIngressJournal',['dedupKey']],['NexiIngressJournal',['laneId','sequence']]];
  if (!keys.every(([table,columns])=>unique.some(i=>i.relname===table && JSON.stringify(i.columns)===JSON.stringify(columns))))
    fail('nexi_ingress_owner_schema_unguarded');
}

function publicKey() {
  try {
    const key = createPublicKey(process.env.NEXI_INGRESS_OWNER_PUBLIC_KEY || '');
    if (key.asymmetricKeyType !== 'ed25519' || !(process.env.NEXI_INGRESS_OWNER_PUBLIC_KEY_ID || '').match(/^[a-zA-Z0-9_-]{1,64}$/))
      fail('nexi_ingress_owner_key_invalid');
    return key;
  } catch { fail('nexi_ingress_owner_key_invalid'); }
}
function signed(packet, keys, purpose) {
  if (!packet || Object.keys(packet).sort().join() !== 'claims,signature' || !packet.claims ||
      Object.keys(packet.claims).sort().join() !== [...keys].sort().join() ||
      packet.claims.version !== 1 || packet.claims.purpose !== purpose ||
      packet.claims.key_id !== process.env.NEXI_INGRESS_OWNER_PUBLIC_KEY_ID ||
      typeof packet.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(packet.signature))
    fail('nexi_ingress_owner_authorization_invalid');
  const signature = Buffer.from(packet.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== packet.signature ||
      !verifySignature(null, canonical.bytes(packet.claims), publicKey(), signature)) fail('nexi_ingress_owner_authorization_invalid');
  return packet.claims;
}
function approval(generation, packet, installing = false) {
  const claims = signed(packet, APPROVAL_KEYS, 'whatsapp_ingress_owner_generation');
  const c = generation.cutover, w = generation.witness, proof = w.ingress.claims;
  const exact = { owner_generation_id: generation.id, cutover_digest: generation.cutoverDigest,
    old_lane_id: c.old_lane, new_lane_id: c.new_lane, scope_id: c.scope_id, session_identity: w.session_identity,
    pn_jid: w.pn_jid, lid_jid: w.lid_jid, account_id: w.account_id, inbox_id: w.inbox_id,
    instance_id: proof.instance_id, instance_name: proof.instance_name, C: c.C, R: c.R, source_floor: c.source_floor,
    witness_journal_id: c.witness_journal_id, witness_proof_digest: c.witness_proof_digest, snapshot_digest: c.snapshot_digest };
  if (!uuid(claims.authorization_id) || Object.entries(exact).some(([key, value]) => claims[key] !== value) ||
      !iso(claims.approved_at) || !iso(claims.expires_at)) fail('nexi_ingress_owner_authorization_invalid');
  const accepted = Date.parse(proof.accepted_at), approved = Date.parse(claims.approved_at), expiry = Date.parse(claims.expires_at);
  if (![accepted, approved, expiry].every(Number.isFinite) || approved < accepted || approved >= accepted + 600000 ||
      expiry <= approved || expiry > accepted + 600000 || expiry > approved + 600000 ||
      (installing && (approved > Date.now() || expiry <= Date.now()))) fail('nexi_ingress_owner_authorization_expired');
  return claims;
}
function registration(generation, packet) {
  const claims = signed(packet, REGISTRATION_KEYS, 'whatsapp_ingress_owner_generation_registered');
  const grant = approval(generation, generation.approval);
  if (claims.authorization_id !== grant.authorization_id || claims.owner_generation_id !== generation.id ||
      claims.cutover_digest !== generation.cutoverDigest || claims.scope_id !== generation.scopeId ||
      claims.new_lane_id !== generation.newLaneId || !iso(claims.registered_at) ||
      !Number.isFinite(Date.parse(claims.registered_at)) || Date.parse(claims.registered_at) < Date.parse(grant.approved_at) ||
      Date.parse(claims.registered_at) >= Date.parse(grant.expires_at))
    fail('nexi_ingress_owner_registration_invalid');
  return claims;
}
function rootId(scopeId, sessionIdentity, pnJid) { return canonical.digest([scopeId, sessionIdentity, pnJid]); }
function newLane(rootLane, generation) { return canonical.digest(['ingress-owner-generation:v1', rootLane, generation]); }
function validateProposal(g) {
  verifyReceipt('NexiIngressOwnerGeneration',g);
  const c = g.cutover, w = g.witness, proof = w?.ingress?.claims;
  if (!c || Object.keys(c).sort().join() !== ['version','id','old_lane','scope_id','C','R','source_floor','witness_journal_id',
      'witness_proof_digest','snapshot_digest','generation_id','new_lane'].sort().join() ||
      c.version !== 1 || !uuid(c.id) || !uuid(c.generation_id) || !uuid(c.witness_journal_id) ||
      !hex(c.old_lane) || !hex(c.scope_id) || !hex(c.new_lane) || !sequence(c.C) || !sequence(c.source_floor) ||
      BigInt(c.source_floor)>BigInt(c.C) ||
      !Number.isSafeInteger(c.R) || c.R < 1 || c.generation_id !== g.id || c.id !== g.candidateId ||
      c.old_lane !== g.oldLaneId || c.new_lane !== g.newLaneId || c.scope_id !== g.scopeId ||
      c.R !== g.rootRevision || BigInt(c.C) !== g.cutoffSequence ||
      c.new_lane !== newLane(g.rootLaneId, g.id) || canonical.digest(c) !== g.cutoverDigest ||
      canonical.digest(g.snapshot) !== c.snapshot_digest || canonical.digest(w.ingress) !== c.witness_proof_digest ||
      !proof || proof.journal_id !== c.witness_journal_id || w.session_identity !== g.sessionIdentity ||
      rootId(g.scopeId, g.sessionIdentity, w.pn_jid) !== g.rootLaneId) fail('nexi_ingress_owner_proposal_invalid');
  return c;
}
async function validateWitness(repo,g,verifyRow) {
  validateProposal(g);
  const source=await repo.nexiIngressOwnerSource.findUnique({where:{id:g.cutover.witness_journal_id}});
  const root=await repo.nexiIngressOwnerRoot.findUnique({where:{id:g.rootLaneId}});
  if (!source || !root) fail('nexi_ingress_owner_witness_missing');
  verifyReceipt('NexiIngressOwnerSource',source); verifyReceipt('NexiIngressOwnerRoot',root);
  const claims=verifyRow({...source,laneId:g.rootLaneId});
  const witness={...claims.observation,account_id:claims.account_id,inbox_id:claims.inbox_id,ingress:source.envelope};
  if (source.rootLaneId!==g.rootLaneId || source.scopeId!==g.scopeId || source.instanceId!==g.instanceId ||
    source.sessionIdentity!==g.sessionIdentity || source.sequence<=root.sourceFloorSequence ||
    root.sourceFloorSequence!==BigInt(g.cutover.source_floor) || claims.version!==1 ||
    claims.journal_id!==source.id || canonical.digest(witness)!==canonical.digest(g.witness) ||
    canonical.digest(source.envelope)!==g.cutover.witness_proof_digest)
    fail('nexi_ingress_owner_witness_mismatch');
}
async function appendRoot(tx, scopeId, service, observation, priorSequence, verifyRow) {
  if (!enabled()) return null;
  await storageGuard(tx);
  publicKey(); // An enabled but unprovisioned deployment must backpressure.
  const id = rootId(scopeId, observation.session_identity, observation.pn_jid);
  // Caller already holds the scope CAS lock. Avoid a no-op UPSERT UPDATE,
  // which would violate this append-only owner's monotonic revision guard.
  const root = await tx.nexiIngressOwnerRoot.findUnique({ where: { id } }) ||
    await tx.nexiIngressOwnerRoot.create({ data: attested('NexiIngressOwnerRoot',{ id, scopeId, instanceId: service.instanceId,
      sessionIdentity: observation.session_identity, pnJid: observation.pn_jid,revision:0,activeGenerationId:null,sourceFloorSequence:null }) });
  verifyReceipt('NexiIngressOwnerRoot',root);
  let generation, laneId = id;
  if (root.activeGenerationId) {
    generation = await tx.nexiIngressOwnerGeneration.findUnique({ where: { id: root.activeGenerationId } });
    if (!generation?.approval || !generation.installedAt || generation.rootLaneId !== root.id ||
        generation.scopeId !== root.scopeId || generation.sessionIdentity !== root.sessionIdentity ||
        generation.instanceId !== root.instanceId) fail('nexi_ingress_owner_registration_pending');
    validateProposal(generation); approval(generation, generation.approval);
    if (generation.registration) registration(generation, generation.registration);
    laneId = generation.newLaneId;
  }
  const head = await tx.nexiIngressJournal.findFirst({ where: { laneId, state: { not: 'succeeded' } }, orderBy: { sequence: 'asc' } });
  const lane=await tx.nexiIngressLane.findUnique({where:{id:laneId}});
  // identity_pending is also written before the HTTP identity request. Never
  // create a cutover boundary while its operation still owns a lease, even if
  // its timestamp expired: a non-null token may name an uncertain late request.
  const busy=lane?.leaseToken || (lane?.leaseUntil && lane.leaseUntil>new Date());
  const blocked = !busy && head && head.checkpoint === 'identity_pending' && head.state === 'recoverable_failure';
  if (blocked) verifyRow(head);
  const unregisteredExpired=generation && !generation.registration &&
    Date.parse(generation.approval.claims.expires_at)<=Date.now();
  const pending = await tx.nexiIngressOwnerGeneration.findFirst({ where: { rootLaneId: id, rootRevision: root.revision,
    installedAt: null }, orderBy: { createdAt: 'desc' } });
  if (root.sourceFloorSequence != null) return { root, generation, laneId, stage: true,
    propose: !!pending || !generation || !!blocked || !!unregisteredExpired,
    prior: pending, cutoff: pending?.cutoffSequence ?? priorSequence };
  if (!blocked) return {root,generation,laneId,stage:false,propose:false,cutoff:priorSequence};
  const next=attested('NexiIngressOwnerRoot',{...root,revision:root.revision+1,sourceFloorSequence:priorSequence});
  const updated = await tx.nexiIngressOwnerRoot.updateMany({ where: { id, revision: root.revision }, data: {
    revision:next.revision,sourceFloorSequence:next.sourceFloorSequence,receipt:next.receipt } });
  if (updated.count !== 1) fail('nexi_ingress_cas_retry');
  return { root:next,
    generation, laneId, stage: !!blocked, propose: !!blocked, cutoff: priorSequence };
}
function verifyClaims(row, claims) {
  const base = rootId(row.scopeId, row.sessionIdentity, claims.observation.pn_jid);
  if (claims.version === 1) return row.laneId === base;
  return enabled() && claims.version === 2 && uuid(claims.owner_generation_id) && hex(claims.cutover_digest) &&
    sequence(claims.source_sequence) && sequence(claims.delivery_sequence) && BigInt(claims.delivery_sequence) === row.sequence &&
    BigInt(claims.source_sequence)<row.sequence && claims.source_journal_id===row.id &&
    hex(claims.source_proof_digest) && claims.source_proof?.claims?.version===1 &&
    canonical.digest(claims.source_proof)===claims.source_proof_digest &&
    row.laneId === newLane(base, claims.owner_generation_id);
}
async function frozen(repo, laneId) {
  if (!enabled()) return false;
  const g=await repo.nexiIngressOwnerGeneration.findUnique({ where: { frozenLaneId: laneId } });
  if (!g) return false;
  verifyReceipt('NexiIngressOwnerGeneration',g); validateProposal(g); approval(g,g.approval);
  if (g.registration) registration(g,g.registration);
  return true;
}
async function frozenLanes(repo,instanceId) {
  await storageGuard(repo);
  const rows=await repo.nexiIngressOwnerGeneration.findMany({where:{instanceId,frozenLaneId:{not:null}}});
  for (const g of rows) {
    verifyReceipt('NexiIngressOwnerGeneration',g); validateProposal(g); approval(g,g.approval);
    if (g.registration) registration(g,g.registration);
  }
  return rows.map(g=>g.frozenLaneId);
}
async function assertWritable(repo, row, claims) {
  if (!enabled()) { if (claims?.version === 2) fail('nexi_ingress_owner_generation_disabled'); return; }
  if (await frozen(repo, row.laneId)) fail('nexi_ingress_owner_prefix_quarantined');
  if (claims?.version !== 2) return;
  const g = await repo.nexiIngressOwnerGeneration.findUnique({ where: { id: claims.owner_generation_id } });
  if (!g?.registration || !g.registeredAt || g.cutoverDigest !== claims.cutover_digest ||
      g.newLaneId !== row.laneId || row.sequence <= g.cutoffSequence) fail('nexi_ingress_owner_generation_unregistered');
  validateProposal(g); registration(g, g.registration);
  const root = await repo.nexiIngressOwnerRoot.findUnique({ where: { id: g.rootLaneId } });
  if (root) verifyReceipt('NexiIngressOwnerRoot',root);
  if (root?.activeGenerationId !== g.id) fail('nexi_ingress_owner_generation_fenced');
  const source = await repo.nexiIngressOwnerSource.findUnique({ where: { id: claims.source_journal_id } });
  const delivery = await repo.nexiIngressOwnerDelivery.findUnique({ where: { sourceJournalId: row.id } });
  if (source) verifyReceipt('NexiIngressOwnerSource',source);
  if (delivery) verifyReceipt('NexiIngressOwnerDelivery',delivery);
  if (!source || !delivery || delivery.deliveryJournalId!==row.id || delivery.generationId!==g.id ||
      delivery.sourceSequence!==source.sequence || delivery.deliverySequence!==row.sequence ||
      source.sequence<=BigInt(g.cutover.source_floor) || canonical.digest(source.envelope)!==claims.source_proof_digest ||
      canonical.digest(source.envelope)!==canonical.digest(claims.source_proof)) fail('nexi_ingress_owner_source_invalid');
}
async function stage(tx, state, row, observation, verifyRow) {
  verifyRow({...row,laneId:state.root.id});
  const source = await tx.nexiIngressOwnerSource.create({ data: attested('NexiIngressOwnerSource',{ ...row, rootLaneId: state.root.id }) });
  if (!state.propose) return source;
  // Keep a live proposal stable while more sources arrive. A later fresh
  // immutable source replaces an expired proposal, never its prior evidence.
  if (state.prior && Date.parse(state.prior.witness.ingress.claims.accepted_at)>Date.now()-600000) return source;
  const prefix = await tx.nexiIngressJournal.findMany({ where: { laneId: state.laneId, sequence: { lte: state.cutoff } },
    orderBy: { sequence: 'asc' } });
  if (prefix.some(item => item.state !== 'succeeded' && (item.association || item.acknowledgement || item.continuationStartedAt ||
      item.mainMaterializedAt || !['persisted','identity_pending'].includes(item.checkpoint) ||
      !['pending','recoverable_failure'].includes(item.state)))) return source;
  for (const item of prefix) verifyRow(item, true);
  const snapshot = prefix.map(item => ({ journal_id: item.id, source_sequence: item.sequence.toString(),
    proof_digest: canonical.digest(item.envelope) }));
  const id = randomUUID(), c = { version: 1, id: randomUUID(), old_lane: state.laneId, scope_id: row.scopeId,
    C: state.cutoff.toString(), R: state.root.revision, source_floor: state.root.sourceFloorSequence.toString(), witness_journal_id: row.id,
    witness_proof_digest: canonical.digest(row.envelope), snapshot_digest: canonical.digest(snapshot),
    generation_id: id, new_lane: newLane(state.root.id, id) };
  await tx.nexiIngressOwnerGeneration.create({ data: attested('NexiIngressOwnerGeneration',{ id, candidateId: c.id, rootLaneId: state.root.id, oldLaneId: state.laneId,
    newLaneId: c.new_lane, scopeId: row.scopeId, instanceId: row.instanceId, sessionIdentity: row.sessionIdentity,
    rootRevision: c.R, cutoffSequence: state.cutoff, cutover: c, cutoverDigest: canonical.digest(c), snapshot,
    witness: { ...observation, account_id: row.envelope.claims.account_id, inbox_id: row.envelope.claims.inbox_id, ingress: row.envelope },
    approval:null,installedAt:null,frozenLaneId:null,registration:null,registeredAt:null }) });
  return source;
}

// Installed metadata freezes an old lane. It never changes a journal, lane
// cursor, pending counter, payload, checkpoint, receipt or source reservation.
async function install(service, g, packet, verifyRow) {
  validateProposal(g); approval(g, packet, true);
  const repo = service.prismaRepository;
  return repo.$transaction(async tx => {
    await tx.nexiIngressScope.update({ where: { id: g.scopeId }, data: { revision: { increment: 1 } } });
    const existing = await tx.nexiIngressOwnerGeneration.findUnique({ where: { id: g.id } });
    await validateWitness(tx,g,verifyRow);
    if (existing?.installedAt) {
      if (canonical.digest(existing.approval) !== canonical.digest(packet)) fail('nexi_ingress_owner_authorization_conflict');
      return existing;
    }
    const root = await tx.nexiIngressOwnerRoot.findUnique({ where: { id: g.rootLaneId } });
    const lane = await tx.nexiIngressLane.findUnique({ where: { id: g.oldLaneId } });
    if (!root || root.revision !== g.rootRevision || (root.activeGenerationId &&
        (await tx.nexiIngressOwnerGeneration.findUnique({ where: { id: root.activeGenerationId } }))?.newLaneId !== g.oldLaneId) ||
        lane?.leaseToken || (lane?.leaseUntil && lane.leaseUntil>new Date())) fail('nexi_ingress_owner_cutover_busy');
    const prefix = await tx.nexiIngressJournal.findMany({ where: { laneId: g.oldLaneId, sequence: { lte: g.cutoffSequence } },
      orderBy: { sequence: 'asc' } });
    if (prefix.some(item => item.state !== 'succeeded' && (item.association || item.acknowledgement || item.continuationStartedAt ||
        item.mainMaterializedAt || !['persisted','identity_pending'].includes(item.checkpoint) ||
        !['pending','recoverable_failure'].includes(item.state)))) fail('nexi_ingress_owner_prefix_uncertain');
    for (const item of prefix) verifyRow(item, true);
    const snapshot = prefix.map(item => ({ journal_id: item.id, source_sequence: item.sequence.toString(), proof_digest: canonical.digest(item.envelope) }));
    if (canonical.digest(snapshot) !== g.cutover.snapshot_digest ||
        await tx.nexiIngressJournal.count({ where: { laneId: g.oldLaneId, sequence: { gt: g.cutoffSequence } } }))
      fail('nexi_ingress_owner_prefix_changed');
    const change={approval:packet,frozenLaneId:g.oldLaneId,installedAt:new Date()};
    const installed = await tx.nexiIngressOwnerGeneration.update({ where: { id: g.id }, data: {...change,
      receipt:attested('NexiIngressOwnerGeneration',{...g,...change}).receipt} });
    await tx.nexiIngressLane.create({data:{id:g.newLaneId,scopeId:g.scopeId,instanceId:g.instanceId,
      sessionIdentity:g.sessionIdentity,pending:0}});
    const changed = await tx.nexiIngressOwnerRoot.updateMany({ where: { id: root.id, revision: g.rootRevision },
      data: { revision:root.revision+1,activeGenerationId:g.id,
        receipt:attested('NexiIngressOwnerRoot',{...root,revision:root.revision+1,activeGenerationId:g.id}).receipt } });
    if (changed.count !== 1) fail('nexi_ingress_cas_retry');
    return installed;
  });
}
async function tick(service, api) {
  if (!enabled() || running.has(service.instanceId)) return;
  running.add(service.instanceId);
  try {
    publicKey();
    const repo = service.prismaRepository;
    await storageGuard(repo);
    const pending = await repo.nexiIngressOwnerGeneration.findMany({ where: { instanceId: service.instanceId,
      registeredAt: null }, orderBy: { createdAt: 'desc' }, take: 10000 });
    const offset=(proposalCursor.get(service.instanceId)||0)%Math.max(pending.length,1);
    const proposals=[...pending.slice(offset),...pending.slice(0,offset)].slice(0,10);
    proposalCursor.set(service.instanceId,(offset+10)%Math.max(pending.length,1));
    for (let g of proposals) {
      try {
      await api.check(g.sessionIdentity);
      const root = await repo.nexiIngressOwnerRoot.findUnique({ where: { id: g.rootLaneId } });
      if (g.installedAt && root?.activeGenerationId!==g.id) continue;
      if (!g.installedAt && root?.revision !== g.rootRevision) continue;
      await validateWitness(repo,g,api.verify);
      if (!g.installedAt) {
        if (Date.parse(g.witness.ingress.claims.accepted_at) <= Date.now() - 600000) continue;
        const response = await api.event('ingress.owner_candidate', { version: 1, observation: g.witness, cutover: g.cutover }, g.candidateId);
        if (!response?.owner_authorization) continue;
        g = await install(service, g, response.owner_authorization, api.verify);
      }
      const grant = approval(g, g.approval);
      const response = await api.event('ingress.owner_installed', { version: 1, authorization_id: grant.authorization_id,
        owner_generation_id: g.id, cutover_digest: g.cutoverDigest, cutover: g.cutover, witness: g.witness,
        authorization: g.approval }, canonical.digest([g.candidateId, 'installed']));
      if (!response?.registration) continue;
      registration(g, response.registration);
      const change={registration:response.registration,registeredAt:new Date()};
      await repo.nexiIngressOwnerGeneration.updateMany({ where: { id: g.id, registeredAt: null },
        data: {...change,receipt:attested('NexiIngressOwnerGeneration',{...g,...change}).receipt} });
      } catch {
        service.logger?.warn({event:'ingress.owner_generation_pending',generation_id:g.id,reason:'proof_authority_or_scope_pending'});
      }
    }
    await flush(service, api);
  } finally { running.delete(service.instanceId); }
}
async function flush(service, api) {
  const repo=service.prismaRepository;
  // Scope pending capacity remains bounded by the original 10,000 admission
  // limit. Sources count toward it before there is any delivery journal.
  const waiting=await repo.nexiIngressOwnerSource.findMany({ where: { instanceId:service.instanceId,delivery:{is:null} },
    orderBy:{sequence:'asc'},take:10000,select:{rootLaneId:true} });
  const rootIds=[...new Set(waiting.map(item=>item.rootLaneId))];
  const offset=(flushCursor.get(service.instanceId)||0)%Math.max(rootIds.length,1);
  const roots=[...rootIds.slice(offset),...rootIds.slice(0,offset)];
  flushCursor.set(service.instanceId,(offset+1)%Math.max(rootIds.length,1));
  let budget=20;
  for (const rootId of roots) {
    if (!budget) break;
    try {
    const root=await repo.nexiIngressOwnerRoot.findUnique({where:{id:rootId}});
    if (!root?.activeGenerationId) continue;
    verifyReceipt('NexiIngressOwnerRoot',root);
    const generation=await repo.nexiIngressOwnerGeneration.findUnique({where:{id:root.activeGenerationId}});
    if (!generation?.registeredAt || !generation.registration) continue;
    validateProposal(generation); registration(generation,generation.registration);
    await api.check(generation.sessionIdentity);
    while (budget>0) {
      const delivered=await repo.$transaction(async tx=>{
        await tx.nexiIngressScope.update({where:{id:generation.scopeId},data:{revision:{increment:1}}});
        const current=await tx.nexiIngressOwnerRoot.findUnique({where:{id:rootId}});
        if (current) verifyReceipt('NexiIngressOwnerRoot',current);
        if (current?.activeGenerationId!==generation.id || await frozen(tx,generation.newLaneId)) return false;
        const source=await tx.nexiIngressOwnerSource.findFirst({where:{rootLaneId:rootId,delivery:{is:null}},orderBy:{sequence:'asc'}});
        if (!source) return false;
        const original=api.verify({...source,laneId:rootId});
        const witness=generation.witness;
        if (source.sequence<=BigInt(generation.cutover.source_floor) || original.version!==1 ||
            original.observation.pn_jid!==witness.pn_jid || original.observation.lid_jid!==witness.lid_jid ||
            source.sessionIdentity!==generation.sessionIdentity || source.scopeId!==generation.scopeId)
          fail('nexi_ingress_owner_source_pending');
        const scope=await tx.nexiIngressScope.update({where:{id:source.scopeId},data:{nextSequence:{increment:1}}});
        const claims={...original,version:2,owner_generation_id:generation.id,cutover_digest:generation.cutoverDigest,
          source_journal_id:source.id,source_proof_digest:canonical.digest(source.envelope),source_proof:source.envelope,
          source_sequence:source.sequence.toString(),delivery_sequence:scope.nextSequence.toString()};
        if (scope.nextSequence<=generation.cutoffSequence || scope.nextSequence<=source.sequence)
          fail('nexi_ingress_owner_sequence_invalid');
        verifyReceipt('NexiIngressOwnerSource',source);
        await tx.nexiIngressOwnerDelivery.create({data:attested('NexiIngressOwnerDelivery',{sourceJournalId:source.id,deliveryJournalId:source.id,
          generationId:generation.id,sourceSequence:source.sequence,deliverySequence:scope.nextSequence,
          sourceProofDigest:claims.source_proof_digest})});
        await tx.nexiIngressLane.upsert({where:{id:generation.newLaneId},create:{id:generation.newLaneId,
          scopeId:source.scopeId,instanceId:source.instanceId,sessionIdentity:source.sessionIdentity,pending:1},
          update:{pending:{increment:1}}});
        await tx.nexiIngressJournal.create({data:{id:source.id,dedupKey:source.dedupKey,scopeId:source.scopeId,
          laneId:generation.newLaneId,instanceId:source.instanceId,sessionIdentity:source.sessionIdentity,
          sequence:scope.nextSequence,envelope:{claims,signature:api.proof(claims)},payload:source.payload}});
        return true;
      });
      if (!delivered) break;
      budget--;
    }
    } catch {
      service.logger?.warn({event:'ingress.owner_source_pending',reason:'proof_identity_or_scope_pending'});
    }
  }
}
module.exports = { enabled, appendRoot, verifyClaims, stage, frozen, frozenLanes, assertWritable, tick };
