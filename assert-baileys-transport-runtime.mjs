import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.argv[2] || '/evolution';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/baileys-transport-s6.json'), 'utf8'));
assert.equal(manifest.version, 'nexi_baileys_transport_s6_v1');
assert.equal(manifest.baileys, '7.0.0-rc13');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/baileys/package.json'))).version, manifest.baileys);
const required = ['node_modules/baileys/lib/Utils/messages-media.js', 'node_modules/baileys/lib/Socket/messages-send.js',
  'node_modules/baileys/lib/Socket/messages-recv.js', 'node_modules/baileys/lib/Socket/chats.js',
  'nexi-baileys-transport.cjs', 'nexi-baileys-device-cache.cjs'];
assert.deepEqual(Object.keys(manifest.files).sort(), required.sort());
for (const [file, digest] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), digest,
    `S6 final runtime changed/missing: ${file}`);
}
if (!process.argv.includes('--source-only')) {
  for (const provider of ['mysql', 'postgresql', 'psql_bouncer']) {
    const bundle = fs.readFileSync(path.join(root, `dist/providers/${provider}.js`), 'utf8');
    for (const marker of ['/evolution/nexi-baileys-transport.cjs', 'createSocketTransport', 'activateSocket',
      'downloadMedia', 'terminalDownloadError']) {
      // Patcher-owned locals may be minified; require the externally consumed
      // method names and module, not a minifier-dependent local identifier.
      assert.ok(bundle.includes(marker), `S6 ${provider} bundle missing ${marker}`);
    }
  }
}
console.log('PASS: S6 rc13 runtime files, cache, download and photo fixes match the composed artifact manifest');
