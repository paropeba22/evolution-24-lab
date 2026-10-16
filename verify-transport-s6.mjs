// Finite source replay, no build/database/WhatsApp. Inputs must be local pristine packages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = path.dirname(fileURLToPath(import.meta.url));
const [source, dependencies, sdkPristine, sdkInstalled] = process.argv.slice(2);
if (![source, dependencies, sdkPristine, sdkInstalled].every(Boolean)) throw new Error('source, node_modules, pristine SDK, installed SDK required');
fs.mkdirSync(path.join(repo, '.test-runtime'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, '.test-runtime/s6-composed-'));
fs.cpSync(path.resolve(source), root, { recursive: true });
const modules = path.join(root, 'node_modules');
fs.mkdirSync(modules, { recursive: true });
for (const entry of fs.readdirSync(dependencies, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || ['baileys', 'libsignal', '@figuro'].includes(entry.name)) continue;
  fs.symlinkSync(path.resolve(dependencies, entry.name), path.join(modules, entry.name), 'junction');
}
for (const entry of ['baileys', 'libsignal']) fs.cpSync(path.join(dependencies, entry), path.join(modules, entry), { recursive: true });
fs.cpSync(path.resolve(sdkInstalled, '../../@prisma/adapter-mariadb'), path.join(modules, '@prisma/adapter-mariadb'), { recursive: true });
const sdk = path.join(modules, '@figuro/chatwoot-sdk');
fs.cpSync(path.resolve(sdkInstalled), sdk, { recursive: true });
fs.cpSync(path.resolve(sdkPristine), sdk, { recursive: true });
for (const entry of fs.readdirSync(repo, { withFileTypes: true })) {
  if (entry.isFile() && (/\.(mjs|cjs|inc|prisma)$/.test(entry.name) || entry.name === 'Dockerfile')) {
    fs.copyFileSync(path.join(repo, entry.name), path.join(root, entry.name));
  }
}
function run(file, args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(repo, file), ...args],
    { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${file}: ${result.error || result.stderr || result.stdout}`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
}
run('patch-prisma-binding.mjs', [], { EVOLUTION_PRISMA_DIR: path.join(root, 'prisma') });
for (const file of ['patch-financial-delivery-source.mjs', 'patch-trusted-baileys.mjs', 'patch-managed-retry.mjs',
  'patch-webhook-safe-logs.mjs', 'patch-groups-source.mjs', 'patch-attendance-source.mjs', 'patch-chatwoot-completion.mjs',
  'patch-ingress-source.mjs', 'patch-ingress-integrations.mjs']) run(file, [root, '--snapshot']);
run('verify-ingress-r1.mjs', [root, path.resolve(sdkPristine), path.join(dependencies, 'typescript')]);
const files = ['node_modules/baileys/lib/Utils/messages-media.js', 'node_modules/baileys/lib/Socket/messages-send.js',
  'node_modules/baileys/lib/Socket/messages-recv.js', 'node_modules/baileys/lib/Socket/chats.js',
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'tsup.config.ts'];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')).digest('hex')]));
console.log('S6_INPUTS', JSON.stringify(hashes));
fs.writeFileSync(path.join(repo, '.test-runtime/last-composition.json'), JSON.stringify({ root, hashes }));
if (!process.argv.includes('--before-s6')) {
  run('patch-baileys-transport.mjs', [root, '--snapshot']);
  run('assert-baileys-transport-runtime.mjs', [root, '--source-only']);
  run('verify-ingress-r2.mjs', [root, path.join(dependencies, 'typescript')]);
}
console.log('S6_COMPOSITION', root);
