'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');

test('source-builder COPY manifest includes the golden fixture and can execute its isolated suites',()=>{
  const docker=fs.readFileSync(path.join(__dirname,'Dockerfile'),'utf8').split(/^FROM /m)[1];
  assert.match(docker,/AS source-builder/);
  assert.match(docker,/^COPY fixtures\/attendance-isolated-v1.json \/evolution\/fixtures\/attendance-isolated-v1.json$/m);
  assert.match(docker,/^RUN node --test attendance-isolated.test.cjs attendance-isolated-configuration.test.cjs$/m);
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'nexi-s12-stage-'));
  try{
    // Reproduce local COPY inputs only. This is a packaging/source test, not
    // a claim that apk/npm or the Docker image itself was built here.
    for(const line of docker.split(/\r?\n/).filter(line=>line.startsWith('COPY ')&&!line.includes('--from='))){
      const pieces=line.split(/\s+/).slice(1),destination=pieces.pop();
      if(!destination.startsWith('/evolution/'))continue;
      for(const source of pieces){
        const relative=destination.slice('/evolution/'.length),target=path.join(scratch,
          destination.endsWith('/')?path.join(relative,path.basename(source)):relative);
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(__dirname,source),target,{recursive:true});
      }
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch,'fixtures/attendance-isolated-v1.json'))),
      JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/attendance-isolated-v1.json'))));
    fs.symlinkSync(fs.realpathSync(path.join(__dirname,'node_modules')),path.join(scratch,'node_modules'),'junction');
    const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
    const run=cp.spawnSync(process.execPath,['--test','attendance-isolated.test.cjs','attendance-isolated-configuration.test.cjs'],
      {cwd:scratch,env:childEnv,encoding:'utf8',timeout:60000});
    assert.equal(run.status,0,(run.stdout||'')+(run.stderr||'')+(run.error||''));
    assert.match(run.stdout,/Ruby\/Evolution golden operation/);
  }finally{
    assert.ok(path.resolve(scratch).startsWith(path.join(os.tmpdir(),'nexi-s12-stage-')));
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});
