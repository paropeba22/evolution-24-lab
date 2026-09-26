'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('patched image bundle preserves the direct message path and fails closed', { skip: !process.env.EVOLUTION_BUNDLE_PATH }, () => {
  const bundle = fs.readFileSync(process.env.EVOLUTION_BUNDLE_PATH, 'utf8');
  const route = bundle.indexOf('verifyChatwootWebhook(e,await ig.getProvider');
  const dispatch = bundle.indexOf('execute:(a,i)=>Cn.receiveWebhook(a,i)', route);
  assert.ok(route >= 0 && dispatch > route);
  assert.match(bundle, /A\.private\|\|A\.event==="message_updated"/);
  assert.match(bundle, /substring\(0,5\)==="WAID:"/);
  assert.match(bundle, /await i\?\.textMessage\(C,!0\)/);
  assert.match(bundle, /chatwoot_media_send_failed/);
  assert.match(bundle, /chatwoot_template_send_failed/);
  assert.match(bundle, /chatwoot_delete_failed/);
  assert.match(bundle, /catch\(e\)\{this\.logger\.error\("chatwoot_transport_failed"\);throw new Error\("chatwoot_transport_failed"\)/);
  assert.doesNotMatch(bundle, /catch\(e\)\{return this\.logger\.error\(e\),\{message:"bot"\}\}\}async updateChatwootMessageId/);
  assert.match(bundle, /prepareEvent\(U,f,A,this\.monitor\.waInstances\[A\]\.instanceId\)/);
  assert.doesNotMatch(bundle, /qrcodeCount: \$\{this\.instance\.qrcode\.count\}/);
});
