'use strict';
require('./attendance-test-network-trap.cjs');
const fs=require('node:fs');
const a=require('./nexi-attendance.cjs');
const storage=require('./nexi-attendance-storage-guard.cjs');
const fixture=JSON.parse(fs.readFileSync(__dirname+'/fixtures/attendance-authority-v1.json','utf8'));
process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET='synthetic-attendance-release-master-test-only';
const credentials=()=>({me:{id:'5511999999999:1@s.whatsapp.net',lid:'100001@lid'},registrationId:9,signedIdentityKey:{public:Buffer.alloc(32,7)},
  account:{accountSignatureKey:Buffer.alloc(32,3),accountSignature:Buffer.alloc(64,4),details:Buffer.from([1,2])}});
function catalog(provider='postgresql') {
  const sql=sqlSource(provider);
  const rx=provider==='mysql'?/CREATE TRIGGER `?(\w+)`? BEFORE (UPDATE|INSERT|DELETE) ON `?(\w+)`? FOR EACH ROW\s+((?:BEGIN.*?\nEND)|SIGNAL[^;]+);/gs:
    /CREATE (?:OR REPLACE )?FUNCTION (\w+)\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$(.*?)\$\$;/gs;
  return [...new Map([...sql.matchAll(rx)].map(m=>[m[1],provider==='mysql'?
    {name:m[1],source:m[4],event:m[2],timing:'BEFORE',table_name:m[3],orientation:'ROW'}:{name:m[1],source:m[2]}])).values()];
}
function sqlSource(provider){
  return ['20261005000000_nexi_attendance_boundaries','20261005000001_attendance_canonical_version','20261006000000_attendance_release_dispatch']
    .map(m=>fs.readFileSync(__dirname+`/prisma/${provider}-migrations/${m}/migration.sql`,'utf8').replaceAll('\r\n','\n')).join('\n');
}
function catalogState(provider){
  const sql=sqlSource(provider),functions=catalog(provider);
  const triggers=provider==='mysql'?functions.map(r=>({...r})): [...sql.matchAll(/CREATE TRIGGER (\w+) BEFORE (DELETE|TRUNCATE|UPDATE|INSERT OR UPDATE) ON "(\w+)"\s+FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION (\w+)\(\);/g)]
    .map(m=>({table_name:m[3],name:m[1],function_name:m[5],guarded:true,kind:(m[4]==='ROW'?1:0)+2+({DELETE:8,TRUNCATE:32,UPDATE:16,'INSERT OR UPDATE':20}[m[2]])}));
  const checks=Object.entries(storage.CHECKS).flatMap(([name,[table]])=>{
    const m=new RegExp('CONSTRAINT [`"]?'+name+'[`"]?\\s+CHECK \\(').exec(sql);if(!m)return [];
    const start=m.index+m[0].length;let i=start,depth=1,quoted=false;
    while(depth&&i<sql.length){const c=sql[i++];if(c==="'")quoted=!quoted;else if(!quoted&&c==='(')depth++;else if(!quoted&&c===')')depth--;}
    return [{table_name:table,name,definition:sql.slice(start,i-1),enforced:'YES'}];
  });
  const indexes=Object.entries(storage.INDEXES).map(([name,[table,columns,primary]])=>{
    const m=primary?null:new RegExp('CREATE UNIQUE INDEX [`"]?'+name+'[`"]? ON [`"]?(\\w+)[`"]? \\(([^)]+)\\)').exec(sql);
    return {table_name:m?.[1]||table,name:provider==='mysql'&&primary?'PRIMARY':name,columns:primary?columns:m?.[2].replaceAll('"','').replaceAll('`','').replaceAll(' ',''),primary,non_unique:0,method:'BTREE',weakened:0};
  });
  const columns=Object.values(storage.INDEXES).flatMap(([table,cols])=>cols.split(',').map(c=>({table_name:table,column_name:c,data_type:'varchar',collation_name:'utf8mb4_bin',nullable:['grantId','releaseId','consumptionId'].includes(c)?'YES':'NO'})));
  return {functions,triggers,checks,indexes,columns,engines:storage.TABLES.map(t=>({table_name:t,engine:'InnoDB'})),
    server_version:'8.4.0',attendance_database:'attendance',checks_enabled:1,attendance_replication_role:'origin',attendance_current_role:'NONE',
    grants:[{grants:"GRANT USAGE ON *.* TO 'attendance_runtime'@'%'"},{grants:"GRANT SELECT, INSERT, UPDATE, DELETE ON `attendance`.* TO 'attendance_runtime'@'%'"}]};
}
function memory() {
  let row=structuredClone(fixture.prepared_row);
  for(const key of ['frozenAt','reservedAt'])row[key]=new Date(row[key]);
  const trace=[];
  const repo={now:fixture.now+1,failStorage:false,failCommit:false,badGuard:false,badIndex:false,
    nexiAttendancePreparation:{async findUnique({where}){return where.id===row.id?structuredClone(row):null;},
      async updateMany({where,data}){
        if (!Object.entries(where).every(([k,v])=>v===null?row[k]==null:row[k]===v))return {count:0};
        row={...row,...data,revision:row.revision+1};trace.push(data.state);return {count:1};}},
    async $queryRawUnsafe(sql){
      if(this.failStorage)throw Error('storage failed');
      if(sql.includes('attendance_now'))return [{attendance_now:new Date(this.now)}];
      if(sql.includes('session_replication_role'))return [{attendance_replication_role:'origin'}];
      const mysql=sql.includes('information_schema'),state=catalogState(mysql?'mysql':'postgresql');
      if(sql.includes('VERSION()'))return [{server_version:'8.4.0',attendance_database:'attendance'}];
      if(sql.includes('CURRENT_ROLE()'))return [{attendance_current_role:'NONE'}];
      if(sql.startsWith('SHOW GRANTS'))return state.grants;
      if(sql.includes('pg_proc p JOIN pg_namespace')){if(this.badGuard)state.functions[0].source='BEGIN RETURN NEW; END';return state.functions;}
      if(sql.includes('information_schema.TRIGGERS'))return state.triggers;
      if(sql.includes('pg_trigger'))return state.triggers;
      if(sql.includes('pg_constraint')||sql.includes('CHECK_CONSTRAINTS'))return state.checks;
      if(sql.includes('information_schema.TABLES'))return state.engines;
      if(sql.includes('information_schema.COLUMNS'))return state.columns;
      if(sql.includes('pg_index')||sql.includes('information_schema.STATISTICS')){if(this.badIndex)state.indexes[0].columns='wrong';return state.indexes;}
      throw Error('unexpected SQL');},
    async $transaction(work){const prior=structuredClone(row);try{const result=await work(this);if(this.failCommit)throw Error('commit lost');trace.push('committed');return result;}catch(e){row=prior;throw e;}},
    row(){return row;},trace};
  const source={prismaRepository:repo,instanceId:row.instanceId,instance:{name:row.instanceName}};
  source.service={instanceId:source.instanceId,instance:source.instance,client:{authState:{creds:credentials()},ws:{isOpen:true}}};
  return {source,repo};
}
const original=()=>structuredClone(JSON.parse(Buffer.from(fixture.envelope.claims,'base64url').toString('utf8')));
module.exports={fixture,catalog,catalogState,sqlSource,memory,original};
