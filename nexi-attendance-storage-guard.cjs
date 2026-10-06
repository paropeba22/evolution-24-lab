'use strict';
const {createHash}=require('node:crypto');
const {normalize}=require('./nexi-attendance-storage-check.cjs');
const TABLES=["NexiManagedTransportContext","NexiAttendancePreparation","NexiReceiptJournal","NexiAttendanceEventOutbox","NexiAttendanceHealth"];
const PINNED={
  "postgresql": {
    "nexi_attendance_permanent": "9a6f26e8ff45c49e26dca8c87a5c050a5f3cfba88ea0a69e08b42678aa503fde",
    "nexi_attendance_preparation_guard": "0e4e025376bbeba6c6f73e0423dc8f260e985423c40935cac429d1068bed7133",
    "nexi_attendance_outbox_guard": "a3fd7215fcb2f7422923d3cb94b7cf51c49d652039e242dc5b228bbac56b4583",
    "nexi_attendance_canonical_version_immutable": "1e81e8b7aeade4bbeb94c2931033d9ba8deae5a5263fc25b7c436baa1c692178",
    "nexi_attendance_authority_guard": "9bc239c4ed24b11111ff2e00f26140d0238adb061634e075640a34ab8d237003"
  },
  "mysql": {
    "NexiManagedTransportContext_no_delete": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiManagedTransportContext_immutable": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiAttendancePreparation_no_delete": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiReceiptJournal_no_delete": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiReceiptJournal_immutable": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiAttendanceEventOutbox_no_delete": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiAttendanceHealth_no_delete": "944d4a11ff497956db29905863e4916ae14d27fb611117bd6e263cf670c7f564",
    "NexiAttendancePreparation_guard": "6fc436933dc02fafe5fc89987d61f301af8750522f1c690135efa6d396184976",
    "NexiAttendanceEventOutbox_guard": "dabd39e284ec779c210ea909e95ba8d26b8a3021e3bc678bbf6d884cfd38695d",
    "NexiAttendancePreparation_canonical": "e6f0f0f6dabb196197b79e81b8dde4eb9eeaf3339aacc77e625729d53c5a113a",
    "NexiAttendanceEventOutbox_canonical": "e6f0f0f6dabb196197b79e81b8dde4eb9eeaf3339aacc77e625729d53c5a113a",
    "NexiAttendancePreparation_authority_update": "e68e5a81186773b999f684f6bd0e5b280355356c48cc8cbbff850d0839acfc0e",
    "NexiAttendancePreparation_authority_insert": "e23c088adf0e8288bb8b64cd1e77740193fcbcf200d8de9e17c3ec6045657bf4"
  }
};
const TRIGGERS={
  "postgresql": [
    [
      "NexiManagedTransportContext",
      "nexi_attendance_no_delete",
      "nexi_attendance_permanent",
      11
    ],
    [
      "NexiManagedTransportContext",
      "nexi_attendance_no_truncate",
      "nexi_attendance_permanent",
      34
    ],
    [
      "NexiManagedTransportContext",
      "nexi_attendance_immutable",
      "nexi_attendance_permanent",
      19
    ],
    [
      "NexiAttendancePreparation",
      "nexi_attendance_no_delete",
      "nexi_attendance_permanent",
      11
    ],
    [
      "NexiAttendancePreparation",
      "nexi_attendance_no_truncate",
      "nexi_attendance_permanent",
      34
    ],
    [
      "NexiReceiptJournal",
      "nexi_attendance_no_delete",
      "nexi_attendance_permanent",
      11
    ],
    [
      "NexiReceiptJournal",
      "nexi_attendance_no_truncate",
      "nexi_attendance_permanent",
      34
    ],
    [
      "NexiReceiptJournal",
      "nexi_attendance_immutable",
      "nexi_attendance_permanent",
      19
    ],
    [
      "NexiAttendanceEventOutbox",
      "nexi_attendance_no_delete",
      "nexi_attendance_permanent",
      11
    ],
    [
      "NexiAttendanceEventOutbox",
      "nexi_attendance_no_truncate",
      "nexi_attendance_permanent",
      34
    ],
    [
      "NexiAttendanceHealth",
      "nexi_attendance_no_delete",
      "nexi_attendance_permanent",
      11
    ],
    [
      "NexiAttendanceHealth",
      "nexi_attendance_no_truncate",
      "nexi_attendance_permanent",
      34
    ],
    [
      "NexiAttendancePreparation",
      "nexi_attendance_preparation",
      "nexi_attendance_preparation_guard",
      19
    ],
    [
      "NexiAttendanceEventOutbox",
      "nexi_attendance_outbox",
      "nexi_attendance_outbox_guard",
      19
    ],
    [
      "NexiAttendancePreparation",
      "nexi_attendance_canonical",
      "nexi_attendance_canonical_version_immutable",
      19
    ],
    [
      "NexiAttendanceEventOutbox",
      "nexi_attendance_canonical",
      "nexi_attendance_canonical_version_immutable",
      19
    ],
    [
      "NexiAttendancePreparation",
      "nexi_attendance_authority",
      "nexi_attendance_authority_guard",
      23
    ]
  ],
  "mysql": [
    [
      "NexiManagedTransportContext",
      "NexiManagedTransportContext_no_delete",
      "DELETE"
    ],
    [
      "NexiManagedTransportContext",
      "NexiManagedTransportContext_immutable",
      "UPDATE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_no_delete",
      "DELETE"
    ],
    [
      "NexiReceiptJournal",
      "NexiReceiptJournal_no_delete",
      "DELETE"
    ],
    [
      "NexiReceiptJournal",
      "NexiReceiptJournal_immutable",
      "UPDATE"
    ],
    [
      "NexiAttendanceEventOutbox",
      "NexiAttendanceEventOutbox_no_delete",
      "DELETE"
    ],
    [
      "NexiAttendanceHealth",
      "NexiAttendanceHealth_no_delete",
      "DELETE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_guard",
      "UPDATE"
    ],
    [
      "NexiAttendanceEventOutbox",
      "NexiAttendanceEventOutbox_guard",
      "UPDATE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_canonical",
      "UPDATE"
    ],
    [
      "NexiAttendanceEventOutbox",
      "NexiAttendanceEventOutbox_canonical",
      "UPDATE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_guard",
      "UPDATE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_authority_update",
      "UPDATE"
    ],
    [
      "NexiAttendancePreparation",
      "NexiAttendancePreparation_authority_insert",
      "INSERT"
    ]
  ]
};
TRIGGERS.mysql=[...new Map(TRIGGERS.mysql.map(t=>[t[1],t])).values()];
const CHECKS={
  NexiAttendancePreparation_unit:['NexiAttendancePreparation','transportUnit>=0 AND preparationRevision>0 AND revision>=0'],
  NexiAttendancePreparation_authority_state:['NexiAttendancePreparation',
    "state IN ('draft','reserved','prepared','awaiting_admission','dispatch_ready_but_disabled','dispatch_started','transport_returned','outcome_unknown','definitively_not_sent') AND ((state IN ('dispatch_started','transport_returned','outcome_unknown'))=outcomeUnknown)"],
  ...Object.fromEntries(TABLES.filter(t=>t!=='NexiAttendanceHealth').map(t=>[t+'_canonical',[t,"canonicalVersion IN ('legacy_unversioned','canonical_json_v1')"]]))
};
const INDEXES={
  ...Object.fromEntries(TABLES.map(t=>[t+'_pkey',[t,t==='NexiAttendanceHealth'?'instanceId':'id',true]])),
  NexiManagedTransportContext_fingerprint_key:['NexiManagedTransportContext','fingerprint',false],
  NexiAttendancePreparation_instanceId_requestId_key:['NexiAttendancePreparation','instanceId,requestId',false],
  NexiAttendancePreparation_instanceId_externalId_key:['NexiAttendancePreparation','instanceId,externalId',false],
  NexiReceiptJournal_instanceId_sourceKey_key:['NexiReceiptJournal','instanceId,sourceKey',false],
  NexiAttendanceEventOutbox_instanceId_sourceKey_key:['NexiAttendanceEventOutbox','instanceId,sourceKey',false],
  ...Object.fromEntries(['grantId','releaseId','consumptionId'].map(c=>['NexiAttendancePreparation_'+c+'_key',['NexiAttendancePreparation',c,false]]))
};
function deny(){throw Error('nexi_attendance_authority_storage_unguarded');}
function fingerprint(value){return createHash('sha256').update(value.replaceAll('\r\n','\n').split('\n').map(x=>x.trim()).join('\n').trim()).digest('hex');}
function exactRows(rows,spec,key,match){
  if(!Array.isArray(rows)||rows.length!==Object.keys(spec).length||new Set(rows.map(key)).size!==rows.length||rows.some(r=>!spec[key(r)]||!match(r,spec[key(r)])))deny();
}
function grantRowsSafe(rows,database){
  if(!Array.isArray(rows)||!rows.length||typeof database!=='string'||!database.length)return false;
  const identifier='(?:\\*|`(?:``|[^`])+`|[a-zA-Z_][a-zA-Z_0-9]*)';
  const scopeRx=new RegExp('^GRANT ([A-Z ,]+) ON ('+identifier+')\\.('+identifier+') TO (.+)$');
  const account=/^(?:'(?:''|[^'])*'|`(?:``|[^`])*`)@(?:'(?:''|[^'])*'|`(?:``|[^`])*`)(?: IDENTIFIED BY PASSWORD '(?:''|[^'])*')?(?: WITH GRANT OPTION)?$/;
  const known=new Set(['USAGE','SELECT','INSERT','UPDATE','DELETE','REFERENCES','EXECUTE','SHOW VIEW','LOCK TABLES','CREATE TEMPORARY TABLES',
    'ALL PRIVILEGES','ALL','DROP','ALTER','INDEX','TRIGGER','CREATE','CREATE VIEW','CREATE ROUTINE','ALTER ROUTINE','EVENT','GRANT OPTION',
    'SUPER','FILE','RELOAD','SHUTDOWN','PROCESS','SHOW DATABASES','CREATE USER','CREATE TABLESPACE','REPLICATION SLAVE','REPLICATION CLIENT']);
  const unsafe=new Set(['ALL PRIVILEGES','ALL','DROP','ALTER','INDEX','TRIGGER','CREATE','GRANT OPTION','SUPER','FILE']);
  const decode=v=>v.startsWith('`')?v.slice(1,-1).replaceAll('``','`'):v;
  function databaseMatches(pattern){
    if(pattern==='*')return true;let rx='';for(let i=0;i<pattern.length;i++){
      const c=pattern[i];if(c==='\\'){const next=pattern[++i];if(!['%','_','\\'].includes(next))throw Error('scope escape');rx+=next.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
      else if(c==='%')rx+='.*';else if(c==='_')rx+='.';else rx+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    }return new RegExp('^'+rx+'$','i').test(database);
  }
  try{
    for(const row of rows){
      const values=Object.values(row);if(values.length!==1||typeof values[0]!=='string')return false;
      const m=scopeRx.exec(values[0]);if(!m||!account.test(m[4]))return false;
      const privileges=m[1].split(',').map(p=>p.trim());if(privileges.some(p=>!known.has(p)))return false;
      const schema=decode(m[2]),table=decode(m[3]);
      const applies=databaseMatches(schema)&&(table==='*'||TABLES.some(t=>t.toLowerCase()===table.toLowerCase()));
      if(applies&&(privileges.some(p=>unsafe.has(p))||m[4].endsWith(' WITH GRANT OPTION')))return false;
    }return true;
  }catch{return false;}
}
async function verify(tx,provider){
  if(!['mysql','postgresql','psql_bouncer'].includes(provider))deny();
  const mysql=provider==='mysql',names=Object.keys(PINNED[mysql?'mysql':'postgresql']).map(n=>"'"+n+"'").join(',');
  const tables=TABLES.map(t=>"'"+t+"'").join(',');let functions,triggers,indexes,checks;
  if(mysql){
    const server=await tx.$queryRawUnsafe('SELECT VERSION() AS server_version, DATABASE() AS attendance_database');
    const version=server[0]?.server_version,database=server[0]?.attendance_database;
    if(typeof version!=='string'||typeof database!=='string')deny();
    const maria=version.includes('MariaDB');
    // SHOW GRANTS (without FOR) also exposes MySQL mandatory role assignments.
    // Any role/proxy/dynamic/unknown syntax is unverifiable and fails closed.
    for(const query of ['SHOW GRANTS FOR CURRENT_USER()','SHOW GRANTS'])if(!grantRowsSafe(await tx.$queryRawUnsafe(query),database))deny();
    if(maria){const enabled=await tx.$queryRawUnsafe('SELECT @@SESSION.check_constraint_checks AS checks_enabled');if(Number(enabled[0]?.checks_enabled)!==1)deny();}
    functions=await tx.$queryRawUnsafe(`SELECT EVENT_OBJECT_TABLE AS table_name,TRIGGER_NAME AS name,ACTION_STATEMENT AS source,
      EVENT_MANIPULATION AS event,ACTION_TIMING AS timing,ACTION_ORIENTATION AS orientation
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${tables})`);
    triggers=functions;
    indexes=await tx.$queryRawUnsafe(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS name,NON_UNIQUE AS non_unique,INDEX_TYPE AS method,
      GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns,
      SUM(SUB_PART IS NOT NULL OR COLLATION<>'A' OR COLUMN_NAME IS NULL) AS weakened
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables})
      AND (INDEX_NAME='PRIMARY' OR INDEX_NAME IN (${Object.keys(INDEXES).map(n=>"'"+n+"'").join(',')}))
      GROUP BY TABLE_NAME,INDEX_NAME,NON_UNIQUE,INDEX_TYPE`);
    const engines=await tx.$queryRawUnsafe(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables})`);
    exactRows(engines,Object.fromEntries(TABLES.map(t=>[t,'InnoDB'])),r=>r.table_name,(r,e)=>r.engine===e);
    const columns=await tx.$queryRawUnsafe(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,COLLATION_NAME AS collation_name,IS_NULLABLE AS nullable,DATA_TYPE AS data_type
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables})`);
    for(const [table,cols] of Object.values(INDEXES))for(const column of cols.split(',')){
      const c=columns.find(r=>r.table_name===table&&r.column_name===column);
      if(!c||c.data_type!=='varchar'||c.collation_name!=='utf8mb4_bin'||c.nullable!==(['grantId','releaseId','consumptionId'].includes(column)?'YES':'NO'))deny();
    }
    checks=await tx.$queryRawUnsafe(`SELECT tc.TABLE_NAME AS table_name,tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS definition,
      ${maria?"'YES'":"tc.ENFORCED"} AS enforced FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME IN (${tables}) AND tc.CONSTRAINT_TYPE='CHECK' AND tc.CONSTRAINT_NAME IN (${Object.keys(CHECKS).map(n=>"'"+n+"'").join(',')})`);
  }else{
    const mode=await tx.$queryRawUnsafe("SELECT current_setting('session_replication_role') AS attendance_replication_role");
    if(mode[0]?.attendance_replication_role!=='origin')deny();
    functions=await tx.$queryRawUnsafe(`SELECT p.proname AS name,p.prosrc AS source FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE ns.nspname=current_schema() AND p.proname IN (${names}) AND p.pronargs=0 AND p.prokind='f' AND p.prorettype='pg_catalog.trigger'::regtype
      AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig IS NULL`);
    triggers=await tx.$queryRawUnsafe(`SELECT r.relname AS table_name,t.tgname AS name,p.proname AS function_name,t.tgtype AS kind,
      (p.pronamespace=ns.oid AND t.tgenabled='O' AND t.tgconstraint=0 AND t.tgattr=''::int2vector AND t.tgqual IS NULL
      AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL) AS guarded
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE ns.nspname=current_schema() AND r.relname IN (${tables}) AND NOT t.tgisinternal`);
    indexes=await tx.$queryRawUnsafe(`SELECT r.relname AS table_name,ix.relname AS name,string_agg(a.attname,',' ORDER BY k.pos) AS columns,i.indisprimary AS primary
      FROM pg_index i JOIN pg_class r ON r.oid=i.indrelid JOIN pg_class ix ON ix.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace JOIN pg_am am ON am.oid=ix.relam
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(id,pos) ON true JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.id AND NOT a.attisdropped
      WHERE ns.nspname=current_schema() AND ix.relnamespace=ns.oid AND r.relname IN (${tables}) AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
      AND am.amname='btree' AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=i.indnatts
      AND NOT EXISTS(SELECT 1 FROM unnest(i.indoption) o WHERE o<>0)
      AND NOT EXISTS(SELECT 1 FROM unnest(i.indclass) k(opclass) JOIN pg_opclass opc ON opc.oid=k.opclass JOIN pg_namespace opns ON opns.oid=opc.opcnamespace WHERE NOT opc.opcdefault OR opns.nspname<>'pg_catalog')
      AND NOT EXISTS(SELECT 1 FROM unnest(i.indkey,i.indcollation) k(id,collation) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.id
        LEFT JOIN pg_collation col ON col.oid=k.collation WHERE k.collation<>a.attcollation OR (k.collation<>0 AND NOT col.collisdeterministic))
      AND ix.relname IN (${Object.keys(INDEXES).map(n=>"'"+n+"'").join(',')}) GROUP BY r.relname,ix.relname,i.indisprimary`);
    checks=await tx.$queryRawUnsafe(`SELECT r.relname AS table_name,c.conname AS name,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
      WHERE ns.nspname=current_schema() AND c.connamespace=ns.oid AND r.relname IN (${tables}) AND c.contype='c' AND c.convalidated AND NOT c.connoinherit
      AND c.conname IN (${Object.keys(CHECKS).map(n=>"'"+n+"'").join(',')})`);
  }
  const p=mysql?'mysql':'postgresql';
  exactRows(functions,PINNED[p],r=>r.name,(r,h)=>typeof r.source==='string'&&fingerprint(r.source)===h);
  const expectedTriggers=Object.fromEntries(TRIGGERS[p].map(t=>[t[0]+':'+t[1],t]));
  exactRows(triggers,expectedTriggers,r=>r.table_name+':'+r.name,(r,t)=>mysql?
    r.event===t[2]&&r.timing==='BEFORE'&&r.orientation==='ROW':r.guarded===true&&r.function_name===t[2]&&r.kind===t[3]);
  exactRows(indexes,INDEXES,r=>mysql&&r.name==='PRIMARY'?r.table_name+'_pkey':r.name,(r,s)=>r.table_name===s[0]&&r.columns===s[1]&&
    (mysql?Number(r.non_unique)===0&&r.method==='BTREE'&&Number(r.weakened)===0:r.primary===s[2]));
  exactRows(checks,CHECKS,r=>r.name,(r,s)=>r.table_name===s[0]&&(!mysql||r.enforced==='YES')&&normalize(s[1])!==null&&normalize(r.definition)===normalize(s[1]));
}
module.exports={verify,fingerprint,PINNED,TRIGGERS,CHECKS,INDEXES,TABLES,grantRowsSafe};
