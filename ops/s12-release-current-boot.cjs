'use strict';
// MUTATING, only after separate owner authorization for physical authority and
// the full eligible backlog. Run as the runtime UID inside the confirmed task.
// Does not import the application, touch auth state, or restart the socket.
const fs=require('node:fs');
const expected=process.argv[2];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
if(!uuid.test(expected || ''))throw Error('explicit current boot UUID required');
const current=JSON.parse(fs.readFileSync('/tmp/nexi-attendance-cutover-current.json','utf8'));
if(current.hold!==true||current.boot_id!==expected)
  throw Error('STOP: current PID1 hold/boot differs from approved target');
if(fs.readFileSync('/proc/1/comm','utf8').trim()!=='node')throw Error('STOP: PID1 is not the expected Node runtime');
const target=`/tmp/nexi-attendance-cutover-${expected}.release`,temporary=`${target}.${process.pid}.tmp`;
let created=false;
try{
  fs.writeFileSync(temporary,`${expected}\n`,{mode:0o600,flag:'wx'});
  created=true;
  fs.renameSync(temporary,target);
  created=false;
}finally{
  if(created)fs.unlinkSync(temporary);
}
console.log(JSON.stringify({released_boot:expected,requires_backlog_authorization:true}));
