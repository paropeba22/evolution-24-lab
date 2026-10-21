'use strict';
require('./attendance-test-network-trap.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const attendance=require('./nexi-attendance.cjs'),authority=require('./nexi-attendance-authority.cjs');
const transport=require('./nexi-attendance-dispatch.cjs');
const {fixture,seal,installSocket}=require('./attendance-isolated-test-support.cjs');
function configuration(t,hold='false',flag='false') {
  const keys=['NEXI_ATTENDANCE_CUTOVER_HOLD','NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED'];
  const previous=keys.map(key=>process.env[key]);
  keys.forEach((key,index)=>{const value=[hold,flag][index];if(value===undefined)delete process.env[key];else process.env[key]=value;});
  t.after(()=>keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}));
}
async function normal(t,{consume=false}={}) {
  configuration(t);const f=fixture();
  delete f.repo.row().authority.isolated_operation;delete f.claims.material.grant.isolated_operation;seal(f);
  const socket=await installSocket(f,t);
  if(consume)await authority.consumption(f.source,f.claims);
  return {...f,socket};
}
test('review H01: normal grant without isolated token cannot consume or write with isolated=true HOLD=false',async t=>{
  const f=await normal(t);process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='true';
  let rejected=false;
  try{await authority.consumption(f.source,f.claims);await transport.dispatch(f.source,f.claims.material);}
  catch{rejected=true;}
  console.log(JSON.stringify({case:'review-H01',cutoverHeld:attendance.cutoverHeld(),rejected,simulatedWrites:f.socket.writes,
    consumed:!!f.repo.row().consumptionId,dispatchStarted:!!f.repo.row().dispatchStartedAt,isolatedToken:false}));
  assert.equal(f.socket.writes,0);assert.equal(rejected,true);assert.equal(f.repo.row().consumptionId,null);
});
for(const hold of [undefined,'false','true','typo','','TRUE'])test(`normal consumed grant cannot downgrade isolated mode with HOLD=${String(hold)}`,async t=>{
  const f=await normal(t,{consume:true});process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='true';
  if(hold===undefined)delete process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;else process.env.NEXI_ATTENDANCE_CUTOVER_HOLD=hold;
  const before=f.repo.row().consumptionId;
  await assert.rejects(transport.dispatch(f.source,f.claims.material));
  assert.equal(f.socket.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);assert.equal(f.repo.row().consumptionId,before);
  // Directly exercising the released capability also cannot bypass the gate
  // in dispatch(): this reaches the patched lexical sendNode implementation.
  await assert.rejects(attendance.releasedGrantCapability(f.source,f.repo.row().id,before,()=>
    f.source.service.client.sendMessage(f.repo.row().recipient,{text:f.repo.row().intent.payload.body},{messageId:f.repo.row().externalId})));
  assert.equal(f.socket.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);
  await assert.rejects(authority.dispatchStart(f.source,f.repo.row().id,before,
    {attrs:{id:f.repo.row().externalId,to:f.repo.row().recipient}}));
  assert.equal(f.repo.row().dispatchStartedAt,null);assert.equal(f.socket.writes,0);
});
for(const flag of [undefined,'false'])for(const hold of [undefined,'false'])
test(`normal non-isolated dispatch compatibility flag=${String(flag)} HOLD=${String(hold)}`,async t=>{
  const f=await normal(t);
  if(flag===undefined)delete process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED;
  if(hold===undefined)delete process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
  await authority.consumption(f.source,f.claims);await transport.dispatch(f.source,f.claims.material);
  assert.equal(f.socket.writes,1);
});
for(const hold of [undefined,'false','typo'])test(`boot and socket configuration reject isolated=true HOLD=${String(hold)}`,async t=>{
  configuration(t,hold,'true');const f=fixture();
  assert.throws(()=>attendance.assertConfiguration(),/isolated_configuration_invalid/);
  assert.throws(()=>attendance.settings(),/isolated_configuration_invalid/);
  await assert.rejects(attendance.configure(f.source.service,{}),/isolated_configuration_invalid/);
  assert.throws(()=>attendance.installRoutes({},null,null,null),/isolated_configuration_invalid/);
});
test('isolated token cannot become a normal operation when flag is disabled and HOLD opens',async t=>{
  configuration(t,'true','true');const f=fixture();await authority.consumption(f.source,f.claims);
  const socket=await installSocket(f,t);
  process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED='false';process.env.NEXI_ATTENDANCE_CUTOVER_HOLD='false';
  await assert.rejects(transport.dispatch(f.source,f.claims.material));
  assert.equal(socket.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);
  const readback=await authority.consumption(f.source,{...f.claims,action:'consumption_readback'});
  assert.ok(readback.consumed_at);assert.equal(readback.dispatch_started_at,null);
});
for(const flag of ['','TRUE','typo','0'])test(`invalid feature flag ${JSON.stringify(flag)} never opens normal dispatch`,async t=>{
  const f=await normal(t,{consume:true});process.env.NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED=flag;
  assert.throws(()=>attendance.assertConfiguration(),/isolated_configuration_invalid/);
  await assert.rejects(transport.dispatch(f.source,f.claims.material));
  assert.equal(f.socket.writes,0);assert.equal(f.repo.row().dispatchStartedAt,null);
});
