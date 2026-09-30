import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2] || '/evolution';
const file = path.join(root, 'node_modules/baileys/lib/Socket/messages-recv.js');
const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const bufferSource = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Utils/event-buffer.js'), 'utf8').replaceAll('\r\n', '\n');
if (createHash('sha256').update(bufferSource).digest('hex') !== '09da9a892668084c3016108a85517d627022afd2ff57ab9cf97f6051b4dbd509') {
  throw new Error('Baileys 7.0.0-rc13 event buffer source changed');
}
if (createHash('sha256').update(source).digest('hex') !== '850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710') {
  throw new Error('Baileys 7.0.0-rc13 decrypt source changed');
}
const anchor = '                cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid);\n                await upsertMessage(msg, node.attrs.offline ? \'append\' : \'notify\');';
if (source.split(anchor).length !== 2) throw new Error('Baileys inbound anchor changed');
const patched = "import nexiIdentity from '/evolution/nexi-identity.cjs';\n" + source.replace(anchor,
  '                nexiIdentity.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message));\n' + anchor);
const sendFile = path.join(root, 'node_modules/baileys/lib/Socket/messages-send.js');
const sendSource = fs.readFileSync(sendFile, 'utf8').replaceAll('\r\n', '\n');
if (createHash('sha256').update(sendSource).digest('hex') !== '81387f00b457ea28b481b1320bfdbf5ada766305f6f2bc7033931f49811519dc') {
  throw new Error('Baileys 7.0.0-rc13 relay source changed');
}
const wireAnchor = '            logger.debug({ msgId }, `sending message to ${participants.length} devices`);\n            await sendNode(stanza);';
const retryAnchor = '            if (messageRetryManager && !participant) {';
if (sendSource.split(wireAnchor).length !== 2 || sendSource.split(retryAnchor).length !== 2) {
  throw new Error('Baileys final wire/retry anchor changed');
}
const sendPatched = "import nexiFinancial from '/evolution/nexi-financial-transport.cjs';\n" + sendSource
  .replace(wireAnchor, '            nexiFinancial.assertWireRecipient(destinationJid, stanza, authState.creds);\n' + wireAnchor)
  .replace(retryAnchor, '            if (messageRetryManager && !participant && !nexiFinancial.currentOperation()) {');
const tsupFile = path.join(root, 'tsup.config.ts');
const tsupSource = fs.readFileSync(tsupFile, 'utf8').replaceAll('\r\n', '\n');
const tsupAnchor = '  noExternal: [/^@prisma\\/client$/],';
if (createHash('sha256').update(tsupSource).digest('hex') !== '030de0c8aa2184fd5baffa7d5affee7dec8392a6fcb3c8e1f1f1173e3a9098a9' ||
    tsupSource.split(tsupAnchor).length !== 2) throw new Error('Pinned tsup identity-module boundary changed');
// Inline helper copies would split the WeakMap and AsyncLocalStorage from
// Baileys' external runtime. All consumers must load the same CJS module.
const tsupPatched = tsupSource.replace(tsupAnchor,
  "  external: ['baileys', '/evolution/nexi-identity.cjs', '/evolution/nexi-financial-transport.cjs', '/evolution/nexi-transport.cjs'],\n" + tsupAnchor);
if (process.argv.includes('--snapshot')) {
  fs.mkdirSync(path.join(root, '.identity-upstream'), { recursive: true });
  fs.writeFileSync(path.join(root, '.identity-upstream/messages-recv.js'), source);
  fs.writeFileSync(path.join(root, '.identity-upstream/event-buffer.js'), bufferSource);
  fs.writeFileSync(path.join(root, '.identity-upstream/messages-send.js'), sendSource);
  fs.writeFileSync(path.join(root, '.identity-upstream/tsup.config.ts'), tsupSource);
}
fs.writeFileSync(file, patched);
fs.writeFileSync(sendFile, sendPatched);
fs.writeFileSync(tsupFile, tsupPatched);
