'use strict';
// Completes the shared fixture with the real Evolution consumption producer.
// Run after Evolution prepare -> Ruby APP ReleaseContract has written it.
const fs=require('node:fs');
const {fixture,memory,original}=require('../attendance-authority-test-support.cjs');
const authority=require('../nexi-attendance-authority.cjs');
(async()=>{
  const f=memory(),claims=original();
  const result=await authority.consumption(f.source,claims);
  fixture.evolution_response=authority.response(f.source,claims,result,fixture.now+2);
  fs.writeFileSync(__dirname+'/attendance-authority-v1.json',JSON.stringify(fixture)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
