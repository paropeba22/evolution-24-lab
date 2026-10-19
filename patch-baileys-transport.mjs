import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// S6 is LAST: these fingerprints are the pinned rc13/Evolution source AFTER
// every accepted S1/S2/S3/S4/R1/R2 patch. Validate all files before any write.
const root = process.argv[2] || '/evolution';
const hashes = {
  'node_modules/baileys/lib/Utils/messages-media.js': '22730bc93f1728e6b5866f8d50af67cdcaff6e23a1260450ac7b4bd082e187c0',
  'node_modules/baileys/lib/Socket/messages-send.js': '8446ce33f4b512c25870d4ab625b47f4d133fb08ee2190cabbec22c5bdabc957',
  'node_modules/baileys/lib/Socket/messages-recv.js': '173ea6cafc4fe2111576c694cca4c4d95a89fe3c631f2addc530e4359eecd7a2',
  'node_modules/baileys/lib/Socket/chats.js': '2d4cdbcaf5d31547ec121e99b5a923c35e11782b2448eee2b557748777ddd758',
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts': '4f968359cf1dbaabe7db36bac057b55f61d4fbee61385f73678f48f6abe22ecb',
  'tsup.config.ts': '9b11851f8b12580332577536d5f02cb20f76a2227226b14099dc86ba134eb14e',
};
const digest = source => createHash('sha256').update(source).digest('hex');
const before = {};
for (const [file, hash] of Object.entries(hashes)) {
  before[file] = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
  if (digest(before[file]) !== hash) throw new Error(`S6 accepted composition changed: ${file}`);
}
const helper = "require('/evolution/nexi-baileys-transport.cjs')";
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`S6 anchor changed: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, () => replacement);
}
function section(source, start, end, transform) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`S6 section changed: ${start}`);
  return source.slice(0, a) + transform(source.slice(a, b)) + source.slice(b);
}
const after = { ...before };
const media = 'node_modules/baileys/lib/Utils/messages-media.js';
after[media] = section(after[media], 'export const getHttpStream =', 'export const encryptedStream =', () =>
  `export const getHttpStream = async (url, options = {}) => nexiTransport.download(url, options, {
    errorForStatus: status => new Boom('Failed to fetch media stream', { statusCode: status })
});\n`);
after[media] = once(after[media], '    return downloadEncryptedContent(downloadUrl, keys, opts);',
  `    return downloadEncryptedContent(downloadUrl, keys, { ...opts, options: {
        ...opts.options, nexiDownloadClass: type === 'md-app-state' ? 'key_state' : 'general'
    } });`);
after[media] = once(after[media], 'fileLength + data.length > opts.maxContentLength', 'fileLength > opts.maxContentLength');
after[media] = once(after[media], '    return fetched.pipe(output, { end: true });', '    return nexiTransport.pipeDownload(fetched, output);');
// CreateDecipher can throw on a truncated range IV; deliver that failure through
// the stream callback rather than throwing out of Transform._transform.
after[media] = section(after[media], '    const output = new Transform({', 'export function extensionForMediaMessage', source => {
  source = once(source, '            if (!aes) {', '            try {\n            if (!aes) {');
  return once(source, '            try {\n                pushBytes(aes.update(data)', '                pushBytes(aes.update(data)');
});
after[media] = "import nexiTransport from '/evolution/nexi-baileys-transport.cjs';\n" + after[media];

const send = 'node_modules/baileys/lib/Socket/messages-send.js';
after[send] = once(after[send], 'const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean);',
  'const usersToFetch = jidsWithUser.map(j => j.jid);');
after[send] = once(after[send], 'mgetDevices?.[user]', 'mgetDevices?.[jid]');
after[send] = once(after[send], '(await userDevicesCache.get(user))', '(await userDevicesCache.get(jid))');
after[send] = once(after[send], '        const result = await sock.executeUSyncQuery(query);',
  '        const nexiDeviceCacheRevision = userDevicesCache.revision?.();\n        const result = await sock.executeUSyncQuery(query);');
after[send] = section(after[send], '            await devicesMutex.mutex(async () => {', '            const userDeviceUpdates = {};', () =>
  `            await devicesMutex.mutex(async () => {
                const entries = nexiTransport.deviceCacheEntries(deviceMap, jidEncode);
                if (userDevicesCache.msetIfRevision) {
                    userDevicesCache.msetIfRevision(nexiDeviceCacheRevision, entries);
                } else if (userDevicesCache.mset) {
                    await userDevicesCache.mset(entries);
                } else {
                    for (const entry of entries) await userDevicesCache.set(entry.key, entry.value);
                }
            });\n`);
after[send] = "import nexiTransport from '/evolution/nexi-baileys-transport.cjs';\n" + after[send];

const recv = 'node_modules/baileys/lib/Socket/messages-recv.js';
after[recv] = once(after[recv], 'jidDecode, jidNormalizedUser', 'jidDecode, jidEncode, jidNormalizedUser');
after[recv] = once(after[recv], 'const list = byUser.get(d.user) || [];', 'const list = byUser.get(jidEncode(d.user, d.server)) || [];');
after[recv] = once(after[recv], 'byUser.set(d.user, list);', 'byUser.set(jidEncode(d.user, d.server), list);');

const chats = 'node_modules/baileys/lib/Socket/chats.js';
after[chats] = once(after[chats], '    const sock = makeSocket(config);',
  '    const sock = makeSocket(config);\n    nexiTransport.bindSocket(config.options?.nexiBaileysTransportScope, sock);');
// Backport only WhiskeySockets/Baileys 731cd6b5... (#2607). Retain rc13 token
// resolution/storage; invoke its existing optional baseContent default [].
after[chats] = section(after[chats], '    const profilePictureUrl =', '    const createCallLink =', source => {
  source = once(source, "        const baseContent = [{ tag: 'picture', attrs: { type, query: 'url' } }];\n", '');
  source = once(source, '        let content = baseContent;', '        let tcTokenContent;');
  source = once(source, '            content = await buildTcTokenFromJid({', '            tcTokenContent = await buildTcTokenFromJid({');
  source = once(source, '                baseContent,\n', '');
  return once(source, '            content\n', '            content: nexiTransport.buildProfilePictureQueryContent(type, tcTokenContent)\n');
});
after[chats] = "import nexiTransport from '/evolution/nexi-baileys-transport.cjs';\n" + after[chats];

const provider = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
after[provider] = once(after[provider], '  private readonly userDevicesCache: CacheStore = new NodeCache({ stdTTL: 300000, useClones: false });\n', '');
after[provider] = once(after[provider], '    const socketConfig: UserFacingSocketConfig = {',
  `    const nexiBaileysTransport = ${helper}.createSocketTransport();
    nexiBaileysTransport.options.dispatcher = options?.fetchAgent;
    const socketConfig: UserFacingSocketConfig = {
      options: nexiBaileysTransport.options,`);
after[provider] = once(after[provider], '      userDevicesCache: this.userDevicesCache,', '      userDevicesCache: nexiBaileysTransport.devices,');
const ownerAnchor = "    if (this.client !== nexiCreatedSocket) throw require('/evolution/nexi-groups.cjs').staleLifecycle();";
after[provider] = once(after[provider], ownerAnchor, ownerAnchor + `
    const nexiTransportOwner = require('/evolution/nexi-groups.cjs').lifecycleCapture(this, nexiCreatedSocket);
    ${helper}.activateSocket(nexiBaileysTransport, this, nexiCreatedSocket,
      () => require('/evolution/nexi-groups.cjs').lifecycleCurrent(nexiTransportOwner));`);
after[provider] = once(after[provider], '  public async getBase64FromMediaMessage(data: getBase64FromMediaMessageDto, getBuffer = false) {',
  `  public async getBase64FromMediaMessage(data: getBase64FromMediaMessageDto, getBuffer = false) {
    const nexiMediaSocket = require('/evolution/nexi-ingress.cjs').socket(this);`);
let downloads = 0;
after[provider] = after[provider].replace(/await downloadMediaMessage\(\n\s*(\{ key: [^\n]+\}),\n\s*'buffer',\n\s*\{\},\n\s*\{ logger: P\(\{ level: 'error' \}\) as any, reuploadRequest: [^\n]+ \},\n\s*\)/g,
  (_match, message) => {
    downloads++;
    const socket = downloads === 5 ? 'nexiMediaSocket' : "require('/evolution/nexi-ingress.cjs').socket(this)";
    return `await ${helper}.downloadMedia(${socket}, ${message}, 'buffer', downloadMediaMessage, P({ level: 'error' }) as any)`;
  });
if (downloads !== 5) throw new Error(`S6 provider download count changed: ${downloads}`);
after[provider] = once(after[provider], "      } catch {\n        this.logger.error('Download Media failed, trying to retry in 5 seconds...');",
  `      } catch (nexiDownloadError) {
        if (${helper}.terminalDownloadError(nexiDownloadError)) throw nexiDownloadError;
        this.logger.error('Download Media failed, trying to retry in 5 seconds...');`);
after[provider] = once(after[provider], '            await this.mapMediaType(mediaType),\n            {},',
  `            await this.mapMediaType(mediaType),
            { options: { ...${helper}.optionsFor(nexiMediaSocket), nexiDownloadLane: msg.key.remoteJid } },`);
after[provider] = once(after[provider], '          buffer = Buffer.concat(chunks);',
  `          ${helper}.assertSocket(nexiMediaSocket);
          buffer = Buffer.concat(chunks);`);
after['tsup.config.ts'] = once(after['tsup.config.ts'], "external: ['/evolution/nexi-ingress-dispatch.cjs',",
  "external: ['/evolution/nexi-ingress-dispatch.cjs', '/evolution/nexi-baileys-transport.cjs',");

// Read every required runtime input before writing any patched source.
const runtimeFiles = Object.keys(after).filter(file => file.startsWith('node_modules/'));
const runtimeHashes = Object.fromEntries(runtimeFiles.map(file => [file, digest(after[file])]));
for (const file of ['nexi-baileys-transport.cjs', 'nexi-baileys-device-cache.cjs']) {
  runtimeHashes[file] = digest(fs.readFileSync(path.join(root, file)));
}
const manifest = { version: 'nexi_baileys_transport_s6_v1', baileys: '7.0.0-rc13', inputs: hashes, files: runtimeHashes };
// Every source anchor and fingerprint has passed. No partial patch on rejection.
if (!process.argv.includes('--verify')) {
  for (const [file, source] of Object.entries(after)) {
    if (process.argv.includes('--snapshot')) {
      const target = path.join(root, '.transport-s6-upstream', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, before[file]);
    }
    fs.writeFileSync(path.join(root, file), source);
  }
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures/baileys-transport-s6.json'), JSON.stringify(manifest, null, 2) + '\n');
}
