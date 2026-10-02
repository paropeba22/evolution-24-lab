import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/evolution';
if (process.argv.includes('--verify') && process.argv.includes('--snapshot')) throw new Error('Groups verify cannot write snapshots');
const changes = [];
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Groups pinned anchor changed: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, replacement);
}
function patch(file, transform) {
  const target = path.join(root, file), before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  const after = transform(before);
  if (after === before) throw new Error(`Groups patch empty: ${file}`);
  changes.push({ target, file, before, after });
}
const helper = "require('/evolution/nexi-groups.cjs')";

patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', source => {
  if (!source.includes('nexi-financial-transport.cjs') || !source.includes('nexi-identity.cjs')) throw new Error('Groups require accepted financial/identity patches');
  source = once(source, '    this.client.ev.process(async (events) => {', '    this.client.ev.process(async (events) => {');
  source = once(source, "            const database = this.configService.get<Database>('DATABASE');\n            const settings = await this.findSettings();",
    `            // Group ingress precedes content interpretation and every shared handler.
            events = await ${helper}.interceptEvents(this, events);
            const database = this.configService.get<Database>('DATABASE');
            const settings = await this.findSettings();`);
  source = once(source, '        for (const received of messages) {', `        for (const received of messages) {
          // Defense in depth if called outside ev.process. Storage failure is
          // never permission to enter the direct-message/AI/Chatwoot pipeline.
          if (${helper}.managed(this.instance.name) && ${helper}.groupLike(received?.key?.remoteJid)) {
            try { await ${helper}.ingest(this, received, type, requestId); } catch { this.logger.warn('nexi_groups_ingress_unavailable'); }
            continue;
          }`);
  source = once(source, '    additionalNodes?: BinaryNode[],\n  ) {\n    const managedFinancial =',
    `    additionalNodes?: BinaryNode[],
  ) {
    ${helper}.denyOutbound(${helper}.managed(this.instance.name), createJid(number));
    const managedFinancial =`);
  source = once(source, '        const isGroupJid = this.localSettings.groupsIgnore && isJidGroup(jid);',
    `        // Managed groups must reach the dedicated raw gate even when legacy groupsIgnore is true.
        const isGroupJid = !${helper}.managed(this.instance.name) && this.localSettings.groupsIgnore && isJidGroup(jid);`);
  source = once(source, '    if (!isJidGroup(groupJid)) return null;', `    if (!isJidGroup(groupJid)) return null;
    const nexiCacheKey = this.instanceId + ':' + (require('/evolution/nexi-identity.cjs').sessionFingerprint(this.instance.authState?.state?.creds) || 'unproved') + ':' + groupJid;`);
  source = once(source, '        await groupMetadataCache.set(groupJid, { timestamp: Date.now(), data: meta });',
    `        const nexiCacheKey = this.instanceId + ':' + (require('/evolution/nexi-identity.cjs').sessionFingerprint(this.instance.authState?.state?.creds) || 'unproved') + ':' + groupJid;
        await groupMetadataCache.set(nexiCacheKey, { timestamp: Date.now(), data: meta });`);
  source = once(source, '      if (await groupMetadataCache?.has(groupJid)) {', '      if (await groupMetadataCache?.has(nexiCacheKey)) {');
  source = once(source, '        const meta = await groupMetadataCache.get(groupJid);', '        const meta = await groupMetadataCache.get(nexiCacheKey);');
  source = once(source, '          await this.updateGroupMetadataCache(groupJid);\n        }\n\n        return meta.data;',
    '          return await this.updateGroupMetadataCache(groupJid);\n        }\n\n        return meta.data;');
  // Correct the actual rc13 adapter even for non-managed instances; do not
  // synthesize PN from a LID or perform per-event participant/photo lookups.
  const start = source.indexOf("    'group-participants.update': async (participantsUpdate: {");
  const end = source.indexOf('\n  };\n\n  private readonly labelHandle', start);
  if (start < 0 || end < 0) throw new Error('Groups rc13 adapter boundary changed');
  source = source.slice(0, start) + `    'group-participants.update': async (participantsUpdate: {
      id: string; author?: string; authorPn?: string; participants: { id: string; phoneNumber?: string; lid?: string; admin?: string }[];
      action: ParticipantAction;
    }) => {
      if (${helper}.managed(this.instance.name)) return;
      const normalized = ${helper}.participants(participantsUpdate.participants);
      await this.sendDataWebhook(Events.GROUP_PARTICIPANTS_UPDATE, { ...participantsUpdate,
        participants: participantsUpdate.participants,
        participantsData: normalized.map(p => ({ jid: p.id, alternateJid: p.alternate_id, admin: p.admin })) });
      await this.updateGroupMetadataCache(participantsUpdate.id);
    },` + source.slice(end);
  return source;
});

patch('src/api/integrations/event/event.manager.ts', source => once(source, '    await this.websocket.emit(eventData);',
  `    if (${helper}.managed(eventData.instanceName)) {
      const data = ${helper}.filterGeneric(eventData.instanceName, eventData.data);
      if (data === null) return;
      eventData = { ...eventData, data };
    }
    await this.websocket.emit(eventData);`));
patch('src/api/integrations/chatbot/chatbot.controller.ts', source => once(source, '    const emitData = {',
  `    if (${helper}.managed(instance.instanceName) &&
        (${helper}.groupLike(remoteJid) || ${helper}.hasGroupTarget(msg))) return;
    const emitData = {`));
patch('src/api/routes/index.router.ts', source => once(source, 'const telemetry = new Telemetry();',
  `${helper}.installRoutes(router, waMonitor, authGuard['apikey']);

const telemetry = new Telemetry();`));
patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', source => {
  source = once(source, '  public async receiveWebhook(instance: InstanceDto, body: any) {',
    `  public async receiveWebhook(instance: InstanceDto, body: any) {
    if (${helper}.managed(instance.instanceName) && ${helper}.hasGroupTarget(body)) throw new Error('nexi_groups_outbound_disabled_wave1');`);
  return once(source,
  '  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {',
  `  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    if (${helper}.managed(instance.instanceName) && ${helper}.filterGeneric(instance.instanceName, body) === null) return null;`);
});

// Patch after the accepted trusted-Baileys patch, not the unmodified library.
patch('node_modules/baileys/lib/Socket/messages-recv.js', source => {
  source = "import nexiGroups from '/evolution/nexi-groups.cjs';\n" + source;
  source = once(source, '                nexiIdentity.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message));',
    '                nexiGroups.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message), proto.Message.ProtocolMessage.Type);\n                nexiIdentity.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message));');
  source = once(source, "                        await upsertMessage(fullMsg, 'append');",
    "                        nexiGroups.observeNotification(fullMsg, node, authState.creds);\n                        await upsertMessage(fullMsg, 'append');");
  // Native resend gets no group plaintext, including payloads loaded from DB.
  source = once(source, '            msgs.push(msg);',
    '            if (config.nexiFinancialManaged && nexiGroups.groupLike(key.remoteJid)) msg = undefined;\n            msgs.push(msg);');
  return source;
});
patch('node_modules/baileys/lib/Socket/messages-send.js', source => {
  source = "import nexiGroups from '/evolution/nexi-groups.cjs';\n" + source;
  return once(source, '        msgId = nexiFinancial.relayMessageId(config.nexiFinancialManaged, msgId, message);',
    '        nexiGroups.denyOutbound(config.nexiFinancialManaged, jid);\n        msgId = nexiFinancial.relayMessageId(config.nexiFinancialManaged, msgId, message);');
});
patch('tsup.config.ts', source => once(source, "external: ['baileys',", "external: ['/evolution/nexi-groups.cjs', 'baileys',"));

for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) patch(`prisma/${provider}-schema.prisma`, source => {
  const start = source.indexOf('model Instance {'), end = source.indexOf('\n}', start);
  if (start < 0 || end < 0 || source.includes('model NexiGroupControl')) throw new Error('Groups Instance schema boundary changed');
  const json = provider === 'mysql' ? '@db.Json' : '@db.JsonB';
  source = source.slice(0, end) + '\n  NexiGroupControl NexiGroupControl?\n  NexiGroupEventOutbox NexiGroupEventOutbox[]' + source.slice(end);
  return source + `

model NexiGroupControl {
  instanceId String @id @db.VarChar(100)
  Instance Instance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  accountId String @db.VarChar(32)
  managedChannelId String @db.VarChar(32)
  generation Int
  revision Int @default(0)
  sessionIdentity String @db.VarChar(64)
  nonce String @db.VarChar(64)
  state String @db.VarChar(16)
  rooms Json ${json}
  catalog Json? ${json}
  catalogAt DateTime?
  catalogStale Boolean @default(true)
}

model NexiGroupEventOutbox {
  id BigInt @id @default(autoincrement())
  instanceId String @db.VarChar(100)
  Instance Instance @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  eventId String @unique @db.VarChar(36)
  sourceKey String @db.VarChar(64)
  fingerprint String @db.VarChar(64)
  payload Json ${json}
  state String @db.VarChar(16)
  attempts Int @default(0)
  nextAttemptAt DateTime
  leaseUntil DateTime?
  leaseToken String? @db.VarChar(36)
  createdAt DateTime @default(now())
  @@unique([instanceId, sourceKey])
  @@index([instanceId, state, id])
}
`;
});

// Validate the complete patch before writing anything. --verify is read only.
for (const change of changes) {
  if (process.argv.includes('--snapshot')) {
    const target = path.join(root, '.groups-upstream', change.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.before);
  }
  if (!process.argv.includes('--verify')) fs.writeFileSync(change.target, change.after);
}
console.log(`Groups Wave 1 source ${process.argv.includes('--verify') ? 'verified' : 'patched'} (${changes.length} files)`);
