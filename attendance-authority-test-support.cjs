'use strict';
require('./attendance-test-network-trap.cjs');
const fs=require('node:fs');
const a=require('./nexi-attendance.cjs');
const fixture=JSON.parse(fs.readFileSync(__dirname+'/fixtures/attendance-authority-v1.json','utf8'));
process.env.NEXI_CHANNELS_EVENT_MASTER_SECRET='synthetic-attendance-release-master-test-only';
const credentials=()=>({me:{id:'5511999999999:1@s.whatsapp.net',lid:'100001@lid'},registrationId:9,signedIdentityKey:{public:Buffer.alloc(32,7)},
  account:{accountSignatureKey:Buffer.alloc(32,3),accountSignature:Buffer.alloc(64,4),details:Buffer.from([1,2])}});
function catalog(provider='postgresql') {
  const sql=fs.readFileSync(__dirname+`/prisma/${provider}-migrations/20261006000000_attendance_release_dispatch/migration.sql`,'utf8');
  const rx=provider==='mysql'?/CREATE TRIGGER (\w+) BEFORE (UPDATE|INSERT) ON NexiAttendancePreparation FOR EACH ROW\n(BEGIN.*?\nEND);/gs:
    /CREATE (?:OR REPLACE )?FUNCTION (\w+)\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$(.*?)\$\$;/gs;
  return [...sql.matchAll(rx)].map(m=>provider==='mysql'?{name:m[1],source:m[3],event:m[2],timing:'BEFORE'}:{name:m[1],source:m[2]});
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
      if(sql.includes('pg_proc p JOIN pg_namespace')){const data=catalog();if(this.badGuard)data[0].source='BEGIN RETURN NEW; END';return data;}
      if(sql.includes('information_schema.TRIGGERS'))return catalog('mysql');
      if(sql.includes('count(*)'))return [{count:2}];
      if(sql.includes('pg_index')||sql.includes('information_schema.STATISTICS'))return ['grantId','releaseId','consumptionId'].map(c=>({name:`NexiAttendancePreparation_${c}_key`,columns:this.badIndex?'wrong':c}));
      throw Error('unexpected SQL');},
    async $transaction(work){const prior=structuredClone(row);try{const result=await work(this);if(this.failCommit)throw Error('commit lost');trace.push('committed');return result;}catch(e){row=prior;throw e;}},
    row(){return row;},trace};
  const source={prismaRepository:repo,instanceId:row.instanceId,instance:{name:row.instanceName}};
  source.service={instanceId:source.instanceId,instance:source.instance,client:{authState:{creds:credentials()},ws:{isOpen:true}}};
  return {source,repo};
}
const original=()=>structuredClone(JSON.parse(Buffer.from(fixture.envelope.claims,'base64url').toString('utf8')));
module.exports={fixture,catalog,memory,original};
