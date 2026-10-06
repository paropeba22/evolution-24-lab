'use strict';
const {createHash}=require('node:crypto');
const PINNED = {
  "postgresql": {
    "nexi_attendance_preparation_guard": "0e4e025376bbeba6c6f73e0423dc8f260e985423c40935cac429d1068bed7133",
    "nexi_attendance_authority_guard": "9bc239c4ed24b11111ff2e00f26140d0238adb061634e075640a34ab8d237003"
  },
  "mysql": {
    "NexiAttendancePreparation_guard": "6fc436933dc02fafe5fc89987d61f301af8750522f1c690135efa6d396184976",
    "NexiAttendancePreparation_authority_update": "e68e5a81186773b999f684f6bd0e5b280355356c48cc8cbbff850d0839acfc0e",
    "NexiAttendancePreparation_authority_insert": "610461ed30b848e75196afddd54adc68e2aab6288b78db671332ad8b46e344d0"
  }
};
function fingerprint(value) { return createHash('sha256').update(value.replaceAll('\r\n','\n').split('\n').map(x=>x.trim()).join('\n').trim()).digest('hex'); }
async function verify(tx, provider) {
  let sources, indexes;
  if (provider==='mysql') {
    sources=await tx.$queryRawUnsafe(`SELECT TRIGGER_NAME AS name,ACTION_STATEMENT AS source,EVENT_MANIPULATION AS event,ACTION_TIMING AS timing
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='NexiAttendancePreparation'
      AND TRIGGER_NAME IN ('NexiAttendancePreparation_guard','NexiAttendancePreparation_authority_update','NexiAttendancePreparation_authority_insert')`);
    indexes=await tx.$queryRawUnsafe(`SELECT INDEX_NAME AS name,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='NexiAttendancePreparation' AND NON_UNIQUE=0
      AND INDEX_NAME IN ('NexiAttendancePreparation_grantId_key','NexiAttendancePreparation_releaseId_key','NexiAttendancePreparation_consumptionId_key') GROUP BY INDEX_NAME`);
    if (sources.some(r=>r.timing!=='BEFORE' || r.event!==(r.name.endsWith('_insert')?'INSERT':'UPDATE'))) throw Error('nexi_attendance_authority_storage_unguarded');
  } else if (['postgresql','psql_bouncer'].includes(provider)) {
    sources=await tx.$queryRawUnsafe(`SELECT p.proname AS name,p.prosrc AS source FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE ns.nspname=current_schema() AND p.proname IN ('nexi_attendance_preparation_guard','nexi_attendance_authority_guard') AND p.pronargs=0
      AND p.prokind='f' AND p.prorettype='pg_catalog.trigger'::regtype AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig IS NULL`);
    const triggers=await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE ns.nspname=current_schema() AND p.pronamespace=ns.oid AND r.relname='NexiAttendancePreparation' AND t.tgenabled='O'
      AND NOT t.tgisinternal AND t.tgconstraint=0 AND t.tgattr=''::int2vector AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=''::bytea
      AND ((t.tgname='nexi_attendance_preparation' AND p.proname='nexi_attendance_preparation_guard' AND t.tgtype=19) OR
           (t.tgname='nexi_attendance_authority' AND p.proname='nexi_attendance_authority_guard' AND t.tgtype=23))`);
    if (triggers[0]?.count!==2) throw Error('nexi_attendance_authority_storage_unguarded');
    indexes=await tx.$queryRawUnsafe(`SELECT ix.relname AS name,string_agg(a.attname,',' ORDER BY k.pos) AS columns FROM pg_index i
      JOIN pg_class r ON r.oid=i.indrelid JOIN pg_class ix ON ix.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(id,pos) ON true JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.id
      WHERE ns.nspname=current_schema() AND ix.relnamespace=ns.oid AND r.relname='NexiAttendancePreparation' AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=i.indnatts
      AND ix.relname IN ('NexiAttendancePreparation_grantId_key','NexiAttendancePreparation_releaseId_key','NexiAttendancePreparation_consumptionId_key') GROUP BY ix.relname`);
  } else throw Error('nexi_attendance_authority_storage_unguarded');
  const expected=PINNED[provider==='mysql'?'mysql':'postgresql'];
  if (!expected || sources.length!==Object.keys(expected).length || sources.some(r=>fingerprint(r.source)!==expected[r.name]) ||
      indexes.length!==3 || ['grantId','releaseId','consumptionId'].some(c=>!indexes.some(r=>r.name===`NexiAttendancePreparation_${c}_key`&&r.columns===c)))
    throw Error('nexi_attendance_authority_storage_unguarded');
}
module.exports={verify,fingerprint,PINNED};
