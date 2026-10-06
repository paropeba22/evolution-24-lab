'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const storage=require('./nexi-attendance-storage-guard.cjs');
const {normalize}=require('./nexi-attendance-storage-check.cjs');
const {catalogState,sqlSource,memory,original}=require('./attendance-authority-test-support.cjs');
const authority=require('./nexi-attendance-authority.cjs');

function tx(state){return {$queryRawUnsafe:async sql=>{
  if(sql.includes('session_replication_role'))return [{attendance_replication_role:state.attendance_replication_role}];
  if(sql.includes('VERSION()'))return [{server_version:state.server_version,attendance_database:state.attendance_database}];
  if(sql.includes('CURRENT_ROLE()'))return Object.hasOwn(state,'attendance_current_role')?[{attendance_current_role:state.attendance_current_role}]:[{}];
  if(sql.startsWith('SHOW GRANTS'))return state.grants;
  if(sql.includes('check_constraint_checks'))return [{checks_enabled:state.checks_enabled}];
  if(sql.includes('pg_proc p JOIN pg_namespace'))return state.functions;
  if(sql.includes('pg_trigger'))return state.triggers;
  if(sql.includes('information_schema.TRIGGERS'))return state.functions;
  if(sql.includes('pg_constraint'))return state.checks.filter(r=>
    !(sql.includes('c.convalidated')&&r.validated===false)&&!(sql.includes('NOT c.connoinherit')&&r.noinherit===true));
  if(sql.includes('CHECK_CONSTRAINTS'))return state.checks;
  if(sql.includes('pg_index'))return state.indexes.filter(r=>{
    for(const flag of ['indisunique','indisvalid','indisready','indimmediate'])if(sql.includes('i.'+flag)&&r[flag]===false)return false;
    if(sql.includes("am.amname='btree'")&&r.method!=='BTREE')return false;
    if(sql.includes('i.indpred IS NULL')&&r.predicate!=null)return false;
    if(sql.includes('i.indexprs IS NULL')&&r.expression!=null)return false;
    if(sql.includes('i.indnkeyatts=i.indnatts')&&r.included===true)return false;
    if(sql.includes('unnest(i.indoption)')&&r.descending===true)return false;
    if(sql.includes('NOT opc.opcdefault')&&r.opclass_default===false)return false;
    if(sql.includes('k.collation_oid<>a.attcollation')&&r.collation_matches===false)return false;
    return true;
  });
  if(sql.includes('information_schema.STATISTICS'))return state.indexes;
  if(sql.includes('information_schema.TABLES'))return state.engines;
  if(sql.includes('information_schema.COLUMNS'))return state.columns;
  throw Error('unexpected catalog query');
}};}
test('PostgreSQL replica or unverifiable trigger execution mode fails closed',async()=>{
  for(const mode of ['replica','local',null,undefined]){
    const state=catalogState('postgresql');state.attendance_replication_role=mode;
    await assert.rejects(storage.verify(tx(state),'postgresql'),/unguarded/);
  }
});
for(const provider of ['postgresql','mysql']){
  test(`${provider}: unexpected trigger cannot bypass authority guards`,async()=>{
    const state=catalogState(provider),collection=provider==='mysql'?'functions':'triggers';
    state[collection].push({...state[collection][0],name:'unexpected_mutation_trigger'});
    await assert.rejects(storage.verify(tx(state),provider),/unguarded/);
  });
  test(`${provider}: actual accepted and corrected migration definitions certify`,async()=>{
    const state=catalogState(provider);await storage.verify(tx(state),provider);
    for(const check of state.checks)assert.notEqual(normalize(check.definition),null,check.name);
  });
  for(const name of Object.keys(storage.PINNED[provider]))for(const mode of ['missing','weakened'])
    test(`${provider}: ${mode} ${name} fails closed`,async()=>{
      const state=catalogState(provider);
      if(mode==='missing')state.functions=state.functions.filter(r=>r.name!==name);
      else state.functions.find(r=>r.name===name).source='BEGIN RETURN NEW; END';
      await assert.rejects(storage.verify(tx(state),provider),/unguarded/);
    });
  for(const [table,name] of storage.TRIGGERS[provider])for(const mode of ['missing','wrong wiring'])
    test(`${provider}: ${table}.${name} ${mode} fails closed`,async()=>{
      const state=catalogState(provider),collection=provider==='mysql'?'functions':'triggers';
      if(mode==='missing')state[collection]=state[collection].filter(r=>!(r.name===name&&r.table_name===table));
      else state[collection].find(r=>r.name===name&&r.table_name===table)[provider==='mysql'?'event':'kind']=provider==='mysql'?'INSERT':0;
      // INSERT is the expected event for the initial trigger; use UPDATE there.
      if(provider==='mysql'&&name.endsWith('_insert')&&mode==='wrong wiring')state.functions.find(r=>r.name===name).event='UPDATE';
      await assert.rejects(storage.verify(tx(state),provider),/unguarded/);
    });
  for(const name of Object.keys(storage.CHECKS))for(const mode of ['missing','weakened'])
    test(`${provider}: ${name} ${mode} fails closed`,async()=>{
      const state=catalogState(provider);
      if(mode==='missing')state.checks=state.checks.filter(r=>r.name!==name);
      else state.checks.find(r=>r.name===name).definition='CHECK (true)';
      await assert.rejects(storage.verify(tx(state),provider),/unguarded/);
    });
  for(const [name,[table,columns,primary]] of Object.entries(storage.INDEXES))for(const mode of ['missing','wrong columns','wrong table'])
    test(`${provider}: ${name} ${mode} fails closed`,async()=>{
      const state=catalogState(provider),actual=provider==='mysql'&&primary?'PRIMARY':name;
      const row=state.indexes.find(r=>r.name===actual&&r.table_name===table);
      if(mode==='missing')state.indexes=state.indexes.filter(r=>r!==row);
      if(mode==='wrong columns')row.columns=columns.split(',').length>1?columns.split(',').reverse().join(','):'wrong';
      if(mode==='wrong table')row.table_name='wrong';
      await assert.rejects(storage.verify(tx(state),provider),/unguarded/);
    });
}
test('PostgreSQL catalog enforces complete effective trigger metadata and all-table inventory',async()=>{
  const state=catalogState('postgresql'),queries=[],base=tx(state),query=base.$queryRawUnsafe;
  base.$queryRawUnsafe=sql=>{queries.push(sql);return query(sql);};
  await storage.verify(base,'postgresql');
  const sql=queries.find(s=>s.includes('FROM pg_trigger'));
  for(const predicate of ["p.pronamespace=ns.oid","t.tgenabled='O'","t.tgconstraint=0","t.tgattr=''::int2vector",
    't.tgqual IS NULL','t.tgnargs=0',"t.tgargs=''::bytea",'t.tgoldtable IS NULL','t.tgnewtable IS NULL'])assert.ok(sql.includes(predicate),predicate);
  assert.ok(!sql.includes('p.proname IN'));
  for(const row of state.triggers){row.guarded=false;await assert.rejects(storage.verify(base,'postgresql'),/unguarded/);row.guarded=true;}
});
test('PostgreSQL every CHECK must be validated and inherited normally',async()=>{
  const state=catalogState('postgresql');
  for(const row of state.checks)for(const [field,value] of [['validated',false],['noinherit',true]]){
    row[field]=value;await assert.rejects(storage.verify(tx(state),'postgresql'),/unguarded/);delete row[field];
  }
});
test('PostgreSQL index query uses a legal collation alias and retains the complete safety predicate',async()=>{
  // Query contract only: the catalog mock does not execute PostgreSQL's parser.
  // Real PostgreSQL execution remains deferred to the EasyPanel disposable DB.
  const base=tx(catalogState('postgresql')),query=base.$queryRawUnsafe,queries=[];
  base.$queryRawUnsafe=sql=>{queries.push(sql);return query(sql);};
  await storage.verify(base,'postgresql');
  const sql=queries.find(s=>s.includes('FROM pg_index')).replace(/\s+/g,' ');
  assert.ok(sql.includes('AND NOT EXISTS(SELECT 1 FROM unnest(i.indkey,i.indcollation) k(id,collation_oid) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.id '+
    'LEFT JOIN pg_collation col ON col.oid=k.collation_oid WHERE k.collation_oid<>a.attcollation OR (k.collation_oid<>0 AND NOT col.collisdeterministic))'));
  assert.ok(!/k\(id,collation\)|k\.collation\b/.test(sql));
});

test('PostgreSQL every identity index must satisfy the effective catalog predicates',async()=>{
  const state=catalogState('postgresql');
  for(const row of state.indexes)for(const [field,value] of [['indisunique',false],['indisvalid',false],['indisready',false],
    ['indimmediate',false],['predicate','revision>0'],['expression','lower(externalId)'],['included',true],
    ['descending',true],['opclass_default',false],['collation_matches',false]]){
    row[field]=value;await assert.rejects(storage.verify(tx(state),'postgresql'),/unguarded/);delete row[field];
  }
});
for(const grant of [
  "GRANT DROP ON `attendance`.* TO 'runtime'@'%'",
  "GRANT DROP ON `attendance`.`NexiAttendancePreparation` TO 'runtime'@'%'",
  "GRANT DROP ON *.* TO 'runtime'@'%'",
  "GRANT ALL PRIVILEGES ON *.* TO 'runtime'@'%'",
  "GRANT ALL ON `attendance`.* TO 'runtime'@'%'",
  "GRANT ALTER ON `attendance`.`NexiReceiptJournal` TO 'runtime'@'%'",
  "GRANT TRIGGER ON `attendance`.* TO 'runtime'@'%'",
  "GRANT DROP ON `attend%`.* TO 'runtime'@'%'",
  "GRANT SELECT ON `attendance`.* TO 'runtime'@'%' WITH GRANT OPTION",
  "GRANT `admin_role`@`%` TO `runtime`@`%`",
  "GRANT PROXY ON ''@'' TO 'runtime'@'%'",
  "GRANT SYSTEM_USER ON *.* TO 'runtime'@'%'",
  "unrecognized grant format"
])test(`MySQL privilege state rejects ${grant}`,async()=>{
  const state=catalogState('mysql');state.grants.push({grants:grant});
  await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
});
test('MySQL and MariaDB safe restricted runtime grants certify',async()=>{
  for(const version of ['8.4.0','10.11.8-MariaDB']){
    const state=catalogState('mysql');state.server_version=version;
    if(version.includes('MariaDB'))state.attendance_current_role=null;
    state.grants=[{x:"GRANT USAGE ON *.* TO `runtime`@`%`"},{x:"GRANT SELECT, INSERT, UPDATE, DELETE ON `attendance`.* TO `runtime`@`%`"}];
    await storage.verify(tx(state),'mysql');
  }
});
for(const grants of [[],[{}],[{a:1}],[{a:'GRANT USAGE ON *.* TO x',b:'other'}]])
  test(`unknown MySQL grants fail closed ${JSON.stringify(grants)}`,async()=>{
    const state=catalogState('mysql');state.grants=grants;await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  });
test('mandatory roles in SHOW GRANTS fail even with safe explicit CURRENT_USER grants',async()=>{
  const state=catalogState('mysql'),base=tx(state),original=base.$queryRawUnsafe;
  base.$queryRawUnsafe=sql=>sql==='SHOW GRANTS'?Promise.resolve([{x:'GRANT `mandatory_admin`@`%` TO `runtime`@`%`'}]):original(sql);
  await assert.rejects(storage.verify(base,'mysql'),/unguarded/);
});

// Exercise the production verifier, including server-owned schema/role reads.
// Catalog definitions remain valid so each failure is privilege certification.
const unsafePrincipalGrants=[
  "GRANT CREATE TEMPORARY TABLES ON attendance.* TO 'runtime'@'%'",
  "GRANT CREATE TEMPORARY TABLES ON `attendance`.* TO `runtime`@`%`",
  "GRANT CREATE TEMPORARY TABLES ON `attend%`.* TO 'runtime'@'%'",
  "GRANT CREATE TEMPORARY TABLES ON *.* TO 'runtime'@'%'",
  "GRANT SELECT, INSERT, UPDATE, DELETE, RELOAD ON *.* TO 'runtime'@'%'",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON *.* TO 'runtime'@'%'",
  "GRANT ALL PRIVILEGES ON *.* TO 'runtime'@'%'",
  "GRANT ALL PRIVILEGES ON `attendance`.* TO 'runtime'@'%'",
  "GRANT INSERT, UPDATE, DELETE ON mysql.* TO 'runtime'@'%'",
  "GRANT INSERT ON `mysql`.`user` TO 'runtime'@'%'",
  "GRANT UPDATE ON `mysql`.`global_priv` TO 'runtime'@'%'",
  "GRANT DELETE ON `mysql`.`db` TO 'runtime'@'%'",
  "GRANT UPDATE ON `mysql`.`tables_priv` TO 'runtime'@'%'",
  "GRANT INSERT ON `mysql`.`role_edges` TO 'runtime'@'%'",
  "GRANT UPDATE ON `mysql`.`roles_mapping` TO 'runtime'@'%'",
  "GRANT DELETE ON `sys`.* TO 'runtime'@'%'",
  "GRANT INSERT ON `information_schema`.* TO 'runtime'@'%'",
  "GRANT UPDATE ON `performance_schema`.* TO 'runtime'@'%'",
  "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, TRIGGER ON attendance.* TO 'runtime'@'%'",
  "GRANT CREATE TEMPORARY TABLES ON `other`.* TO 'runtime'@'%'",
  "GRANT EXECUTE ON attendance.* TO 'runtime'@'%'",
  "GRANT EXECUTE ON PROCEDURE `attendance`.`make_shadow` TO 'runtime'@'%'",
  "GRANT RELOAD ON *.* TO 'runtime'@'%'",
  "GRANT FLUSH_PRIVILEGES ON *.* TO 'runtime'@'%'",
  "GRANT `temporary_table_role`@`%` TO `runtime`@`%`",
  "GRANT `temporary_table_role` TO `runtime`@`%`",
  "SET DEFAULT ROLE `temporary_table_role` TO `runtime`@`%`",
  "GRANT PROXY ON `privileged`@`%` TO `runtime`@`%` WITH GRANT OPTION",
  "GRANT SELECT ON attendance.* TO 'runtime'@'%' WITH GRANT OPTION",
  "GRANT SELECT (externalId) ON attendance.NexiAttendancePreparation TO 'runtime'@'%'",
  "GRANT UNKNOWN_AUTHORITY ON *.* TO 'runtime'@'%'"
];
for(const version of ['8.4.0','10.11.8-MariaDB'])for(const grant of unsafePrincipalGrants)
  test(`${version}: production certification rejects unsafe principal: ${grant}`,async()=>{
    const state=catalogState('mysql');state.server_version=version;
    state.attendance_current_role=version.includes('MariaDB')?null:'NONE';
    state.grants.push({grants:grant});
    await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  });

test('temporary-shadow capability fails before permanent-table metadata can certify',async()=>{
  const state=catalogState('mysql');
  state.grants.push({x:"GRANT CREATE TEMPORARY TABLES ON attendance.* TO 'runtime'@'%'"});
  const base=tx(state),query=base.$queryRawUnsafe,queries=[];
  base.$queryRawUnsafe=sql=>{queries.push(sql);return query(sql);};
  await assert.rejects(storage.verify(base,'mysql'),/unguarded/);
  assert.ok(!queries.some(sql=>sql.includes('information_schema.')));
  // That privilege would allow CREATE TEMPORARY TABLE NexiAttendancePreparation;
  // permanent INFORMATION_SCHEMA metadata cannot detect the session's shadow.
});

test('separate metadata-write and reload grants cannot compose escalation',async()=>{
  for(const schema of ['mysql','*']){
    const state=catalogState('mysql');
    state.grants.push({x:`GRANT UPDATE ON ${schema}.* TO 'runtime'@'%'`},
      {x:"GRANT RELOAD ON *.* TO 'runtime'@'%'"});
    await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  }
});

for(const version of ['8.4.0','10.11.8-MariaDB'])
  test(`${version}: active, missing or ambiguous role state fails closed`,async()=>{
    for(const role of ["`admin`@`%`",'admin','',undefined,[],0,...(version.includes('MariaDB')?['NONE']:[null])]){
      const state=catalogState('mysql');state.server_version=version;state.attendance_current_role=role;
      await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
    }
    const state=catalogState('mysql');state.server_version=version;delete state.attendance_current_role;
    await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  });

test('unavailable grants/role introspection blocks certification',async()=>{
  for(const blocked of ['SHOW GRANTS FOR CURRENT_USER()','SHOW GRANTS','CURRENT_ROLE()']){
    const base=tx(catalogState('mysql')),query=base.$queryRawUnsafe;
    base.$queryRawUnsafe=sql=>{if(sql.includes(blocked))throw Error('introspection unavailable');return query(sql);};
    await assert.rejects(storage.verify(base,'mysql'),/unavailable/);
  }
});

test('runtime schema comes from DATABASE(), with quoted account and scoped Prisma CRUD',async()=>{
  for(const version of ['8.4.0','10.11.8-MariaDB'])for(const schema of ['evolution','evolution_api','evolution`api']){
    const state=catalogState('mysql');state.server_version=version;state.attendance_database=schema;
    state.attendance_current_role=version.includes('MariaDB')?null:'NONE';
    const encoded=schema.replaceAll('_','\\_').replaceAll('`','``');
    const account="`evolution_runtime`@`localhost`"+(version.includes('MariaDB')?" IDENTIFIED BY PASSWORD '*SYNTHETIC_TEST_ONLY'":'');
    state.grants=[{x:`GRANT USAGE ON *.* TO ${account}`},
      {x:`GRANT SELECT,  INSERT , UPDATE, DELETE ON \`${encoded}\`.* TO ${account}`}];
    await storage.verify(tx(state),'mysql');
    state.grants[1].x=`GRANT SELECT, INSERT, UPDATE, DELETE ON attendance.* TO ${account}`;
    await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  }
});

test('table-scoped application DML passes; system/wildcard metadata scopes fail',async()=>{
  const state=catalogState('mysql');
  state.grants=[{x:"GRANT SELECT, INSERT, UPDATE, DELETE ON `attendance`.`NexiAttendancePreparation` TO 'runtime'@'%'"}];
  await storage.verify(tx(state),'mysql');
  for(const [database,scope] of [['mysql','mysql'],['sys','sys'],['information_schema','information_schema'],
    ['performance_schema','performance_schema'],['myapplication','my%'],['attendance','%'],['mysql_copy','mysql%']]){
    state.attendance_database=database;
    state.grants=[{x:`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${scope}\`.* TO 'runtime'@'%'`}];
    await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  }
});

test('both authority CAS operations recertify the current MySQL session without cached PASS',async()=>{
  const prior=process.env.DATABASE_PROVIDER;process.env.DATABASE_PROVIDER='mysql';
  try{
    for(const unsafe of ['temporary privilege','global escalation','active role']){
      const f=memory(),state=catalogState('mysql'),catalogQuery=tx(state).$queryRawUnsafe;
      const base=f.repo.$queryRawUnsafe.bind(f.repo);let checks=0;
      f.repo.$queryRawUnsafe=sql=>{if(sql==='SHOW GRANTS FOR CURRENT_USER()')checks++;return sql.includes('attendance_now')?base(sql):catalogQuery(sql);};
      const corrupt=()=>{
        if(unsafe==='active role')state.attendance_current_role='admin';
        else state.grants.push({x:unsafe==='temporary privilege'?"GRANT CREATE TEMPORARY TABLES ON attendance.* TO 'runtime'@'%'":
          "GRANT SELECT, INSERT, UPDATE, DELETE, RELOAD ON *.* TO 'runtime'@'%'"});
      };
      await storage.verify(tx(state),'mysql');corrupt();
      await assert.rejects(authority.consumption(f.source,original()),/unguarded/);
      assert.equal(f.repo.row().consumptionId,null);assert.deepEqual(f.repo.trace,[]);
      state.grants=catalogState('mysql').grants;state.attendance_current_role='NONE';
      await authority.consumption(f.source,original());
      const trace=[...f.repo.trace],id=f.repo.row().consumptionId;corrupt();
      await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,id,{attrs:{}}),/unguarded/);
      assert.equal(f.repo.row().dispatchStartedAt,null);assert.deepEqual(f.repo.trace,trace);
      assert.equal(checks,3); // failed consume, committed consume, failed dispatch.
    }
  }finally{if(prior===undefined)delete process.env.DATABASE_PROVIDER;else process.env.DATABASE_PROVIDER=prior;}
});
for(const field of ['non_unique','method','weakened'])test(`MySQL index ${field} weakening fails`,async()=>{
  const state=catalogState('mysql');state.indexes[0][field]=({non_unique:1,method:'HASH',weakened:1})[field];
  await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
});
test('MySQL disabled CHECK or wrong engine/collation/nullability fails',async()=>{
  for(const mutate of [s=>s.checks[0].enforced='NO',s=>s.engines[0].engine='MyISAM',s=>s.columns[0].collation_name='utf8mb4_general_ci',
    s=>s.columns[0].nullable='YES',s=>s.columns[0].data_type='text',s=>s.columns.pop()]){
    const state=catalogState('mysql');mutate(state);await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
  }
  const state=catalogState('mysql');state.server_version='10.11.8-MariaDB';state.checks_enabled=0;
  await assert.rejects(storage.verify(tx(state),'mysql'),/unguarded/);
});
test('consumption and dispatch CAS invoke storage guard before writes',async()=>{
  for(const mutate of [s=>s.functions.pop(),s=>s.triggers.pop(),s=>s.indexes.pop(),s=>s.checks.pop()]){
    const f=memory(),state=catalogState('postgresql');mutate(state);
    const catalogQuery=tx(state).$queryRawUnsafe,base=f.repo.$queryRawUnsafe.bind(f.repo);
    f.repo.$queryRawUnsafe=sql=>sql.includes('attendance_now')?base(sql):catalogQuery(sql);
    await assert.rejects(authority.consumption(f.source,original()),/unguarded/);
    await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,'bad',{attrs:{}}),/unguarded/);
    assert.equal(f.repo.row().consumptionId,null);assert.equal(f.repo.row().dispatchStartedAt,null);assert.deepEqual(f.repo.trace,[]);
  }
});

// Evaluate only the restricted initial/unconsumed conditions extracted from
// the real migration declarations; these are modeled SQL-shape tests, not DB
// runtime acceptance. No duplicated manually written provider condition.
function conditions(provider){
  const sql=sqlSource(provider),initial=sql.match(/IF NEW\.?"?state"?<>'draft'([\s\S]*?)THEN (?:RAISE EXCEPTION|SIGNAL)/)?.[0];
  const unconsumed=sql.match(/ELSE\s+IF NEW\."?grantId"? IS NOT NULL([\s\S]*?)THEN (?:RAISE EXCEPTION|SIGNAL)/)?.[0];
  assert.ok(initial&&unconsumed,provider);
  return [initial,unconsumed].map(s=>{
    s=s.slice(s.indexOf('IF NEW')+3,s.indexOf('THEN')).trim().replace(/NEW\.(["`]?)(\w+)\1/g,'"$2"');
    const tree=normalize(s);assert.notEqual(tree,null,s);return JSON.parse(tree);
  });
}
function evalTree(n,row){
  const [op,a,b]=n;
  if(op==='column')return row[a]??null;
  if(op==='integer'||op==='text')return a;
  if(op==='boolean')return a==='true';
  if(op==='null')return (evalTree(a,row)===null)!==b;
  if(op==='or')return n.slice(1).some(c=>evalTree(c,row));
  if(op==='and')return n.slice(1).every(c=>evalTree(c,row));
  if(op==='in')return b.map(c=>evalTree(c,row)).includes(evalTree(a,row));
  if(op==='<>')return evalTree(a,row)!==evalTree(b,row);
  if(op==='=')return evalTree(a,row)===evalTree(b,row);
  throw Error('unsupported modeled expression '+op);
}
const pgInitial=conditions('postgresql'),mysqlInitial=conditions('mysql');
const fields=[...new Set([...JSON.stringify(pgInitial).matchAll(/\["column","(\w+)"\]/g)].map(m=>m[1]))];
const normal=()=>Object.fromEntries(fields.map(k=>[k,k==='state'?'draft':k==='revision'?0:k==='outcomeUnknown'?false:null]));
for(const field of fields)test(`initial PostgreSQL/MySQL orphan ${field} is rejected by actual declarations`,()=>{
  const row=normal();row[field]=field==='state'?'dispatch_started':field==='outcomeUnknown'?true:field==='revision'?1:'orphan';
  assert.equal(pgInitial.some(c=>evalTree(c,row)),true);assert.equal(mysqlInitial.some(c=>evalTree(c,row)),true);
});
test('normal draft accepted and all orphans rejected with provider parity',()=>{
  assert.equal(pgInitial.some(c=>evalTree(c,normal())),false);assert.equal(mysqlInitial.some(c=>evalTree(c,normal())),false);
  const all=normal();for(const k of fields)if(!['state','revision','outcomeUnknown'].includes(k))all[k]='orphan';
  assert.equal(pgInitial.some(c=>evalTree(c,all)),true);assert.equal(mysqlInitial.some(c=>evalTree(c,all)),true);
  assert.deepEqual(new Set([...JSON.stringify(mysqlInitial).matchAll(/\["column","(\w+)"\]/g)].map(m=>m[1])),new Set(fields));
});
