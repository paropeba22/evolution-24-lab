'use strict';
// Preload only in focused tests. Any accidental live network call is a failure.
const trap=()=>{throw Error('ATTENDANCE_TEST_NETWORK_TRAP');};
global.fetch=trap;
for(const name of ['node:http','node:https']) { const mod=require(name);mod.request=trap;mod.get=trap; }
require('node:net').Socket.prototype.connect=trap;
require('node:dns').lookup=trap;
