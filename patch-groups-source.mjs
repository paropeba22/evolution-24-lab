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

// libsignal bypasses the socket logger for session/key diagnostics. Pin every
// executable console site and retain the original arguments outside Group scope.
for (const [file, expected] of [['session_record.js', 7], ['session_cipher.js', 3], ['session_builder.js', 1],
  ['queue_job.js', 1], ['curve.js', 1]]) {
  patch(`node_modules/libsignal/src/${file}`, source => {
    let count = 0;
    source = source.replace(/^(\s*)console\.(info|warn|error)\(/gm, (_, indentation, level) => {
      count++;
      return `${indentation}${helper}.signalDiagnostic('${level}', `;
    });
    if (count !== expected) throw new Error(`Groups Signal diagnostic anchors changed: ${file} (${count})`);
    if (file === 'queue_job.js') source = once(source, '    let inactive;',
      `    // Executor may belong to a different packet sharing this device queue.
    awaitable = ${helper}.bindSignalJob(awaitable);
    let inactive;`);
    return source;
  });
}

patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', source => {
  if (!source.includes('nexi-financial-transport.cjs') || !source.includes('nexi-identity.cjs')) throw new Error('Groups require accepted financial/identity patches');
  source = once(source, '    this.client.ev.process(async (events) => {',
    '    const nexiEventSocket = this.client;\n    this.client.ev.process(async (events) => {');
  source = once(source, "              this.connectionUpdate(events['connection.update']);",
    "              if (this.client === nexiEventSocket) this.connectionUpdate(events['connection.update']);");
  source = once(source, '  private async createClient(number?: string): Promise<WASocket> {',
    `  private async createClient(number?: string): Promise<WASocket> {
    if (!await ${helper}.beforeConnect(this)) return this.client;`);
  source = once(source, "keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any)",
    `keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys,
          ${helper}.privacyLogger(P({ level: 'error' }), ${helper}.managed(this.instance.name)) as any)`);
  source = once(source, "    this.client = makeWASocket(require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, socketConfig));",
    `    this.client = await ${helper}.installAdmissionSocket(this, socketConfig,
      config => makeWASocket(require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, config)));`);
  source = once(source, "    if (connection === 'close') {", `    if (connection === 'close') {
      if (await ${helper}.recordSuspension(this, lastDisconnect?.error, Events.CONNECTION_UPDATE)) return;`);
  for (const event of ['contacts.upsert', 'contacts.update']) {
    const anchor = event === 'contacts.upsert' ? "    'contacts.upsert': async (contacts: Contact[]) => {"
      : "    'contacts.update': async (contacts: Partial<Contact>[]) => {";
    source = once(source, anchor, `${anchor}
      contacts = ${helper}.filterGeneric(this.instance.name, contacts);
      if (!contacts?.length) return;`);
  }
  for (const event of ['CB:call', 'CB:ack,class:call']) {
    const anchor = `    this.client.ws.on('${event}', (packet) => {`;
    source = once(source, anchor, `${anchor}
      if (${helper}.managed(this.instance.name) && ${helper}.groupSource(packet)) return;`);
  }
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
  source = once(source, '      const meta = await this.client.groupMetadata(groupJid);',
    `      const watermark = await ${helper}.metadataWatermark(this);
      const nexiCacheKey = this.instanceId + ':' + watermark.session + ':' + groupJid;
      const meta = await this.client.groupMetadata(groupJid);
      if (!await ${helper}.metadataCurrent(this, watermark)) return null;`);
  source = once(source, '        await groupMetadataCache.set(groupJid, { timestamp: Date.now(), data: meta });',
    '        await groupMetadataCache.set(nexiCacheKey, { timestamp: Date.now(), data: meta });');
  source = once(source, '        this.logger.verbose(`Updating cache for group: ${groupJid}`);',
    `        if (!${helper}.managed(this.instance.name)) this.logger.verbose(\`Updating cache for group: \${groupJid}\`);`);
  for (const anchor of ['        console.log(`Cache request for group: ${groupJid}`);',
    '      console.log(`Cache request for group: ${groupJid} - not found`);']) {
    source = once(source, anchor, anchor.replace('console.log', `if (!${helper}.managed(this.instance.name)) console.log`));
  }
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
  // Same canonical boundary also checks the ACTUAL normalized result for every
  // createJid call in this provider, including non-relay chat controls.
  source = source.replace(/createJid\(([^()]*)\)/g,
    (_, argument) => `${helper}.validateTargets(${helper}.managed(this.instance.name), {}, createJid(${argument}))`);
  return source;
});

patch('src/api/abstract/abstract.router.ts', source => once(source,
  '    const { request, schema, ClassRef, execute } = args;',
  `    const { request, schema, ClassRef, execute } = args;
    // dataValidate runs AFTER multer has parsed fields, before validation/logging
    // and before any operation-specific execution or media handling.
    ${helper}.validateTargets(${helper}.managed(request.params.instanceName), { body: request.body, query: request.query });`));

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
patch('src/api/routes/index.router.ts', source => once(once(source,
  "import { waMonitor } from '@api/server.module';", "import { waMonitor, prismaRepository } from '@api/server.module';"),
  'const telemetry = new Telemetry();',
  `${helper}.installRoutes(router, waMonitor, authGuard['apikey'], prismaRepository);

const telemetry = new Telemetry();`));
patch('src/api/services/monitor.service.ts', source => {
  const record = '          connectionStatus: instance.connectionStatus as any, // Pass connection status';
  if (source.split(record).length !== 3) throw new Error('Groups pinned instance recovery metadata changed');
  source = source.replaceAll(record, record + `\n          ...${helper}.suspensionMetadata(instance),`);
  source = once(source, '            connectionStatus: instanceData.connectionStatus as any, // Pass connection status',
    `            connectionStatus: instanceData.connectionStatus as any, // Pass connection status
            ...${helper}.suspensionMetadata(instanceData),`);
  return once(source,
  "      instanceData.connectionStatus === 'open' ||",
  `      (instanceData.integration === Integration.WHATSAPP_BAILEYS &&
        await ${helper}.restoreSuspension(instance, (instanceData as any).nexiGroupsAdmissionSuspended)) ||
      instanceData.connectionStatus === 'open' ||`);
});
patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', source => {
  source = once(source, '  public async receiveWebhook(instance: InstanceDto, body: any) {',
    `  public async receiveWebhook(instance: InstanceDto, body: any) {
    ${helper}.validateTargets(${helper}.managed(instance.instanceName), {
      jid: body?.conversation?.meta?.sender?.identifier,
      number: body?.conversation?.meta?.sender?.phone_number,
      target: body?.meta?.sender?.identifier,
      payload: body
    });`);
  return once(source,
  '  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {',
  `  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    if (${helper}.managed(instance.instanceName) && ${helper}.filterGeneric(instance.instanceName, body) === null) return null;`);
});

// Patch after the accepted trusted-Baileys patch, not the unmodified library.
patch('node_modules/baileys/lib/Socket/messages-recv.js', source => {
  source = "import nexiGroups from '/evolution/nexi-groups.cjs';\n" + source;
  source = once(source, '                await decrypt();',
    `                if (config.nexiFinancialManaged && nexiGroups.groupLike(node.attrs.from)) {
                    // rc13's nested Signal transactions reuse this outer context.
                    // Canonical enqueue commits BEFORE ratchet/sender-key writes.
                    // Failure/crash before enqueue leaves keys unconsumed; crash
                    // after enqueue leaves the durable UUID/source tombstone.
                    try {
                        await authState.keys.transaction(async () => {
                            await decrypt();
                            await nexiGroups.admit(config, msg, node, authState.creds, getHistoryMsg(msg.message), proto.Message.ProtocolMessage.Type);
                        }, node.attrs.from);
                    } catch {
                        const failure = new Error('nexi_groups_admission_suspended');
                        failure.code = 'NEXI_GROUPS_ADMISSION_SUSPENDED';
                        config.nexiGroupsSuspend?.(failure);
                        throw failure;
                    }
                } else {
                    await decrypt();
                }`);
  source = once(source, "            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message');",
    `            if (error?.code === 'NEXI_GROUPS_ADMISSION_SUSPENDED') {
                logger.warn('nexi_groups_admission_suspended');
                return; // no receipt, ACK, NACK or volatile generic processing
            }
            logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message');`);
  // Each node handler receives a provenance-scoped logger, including decrypt's
  // internal logs. Direct packet loggers remain the original object.
  source = once(source, '    const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } = config;',
    '    const { logger: nexiBaseLogger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } = config;\n    const logger = nexiBaseLogger;');
  for (const name of ['handleMessage', 'handleCall', 'handleNotification', 'handleReceipt']) {
    const anchor = `    const ${name} = async (node) => {`;
    source = once(source, anchor, `${anchor}\n        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);`);
  }
  source = once(source, '    const handleNotification = async (node) => {\n        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);',
    `    const handleNotification = async (node) => {
        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);
        if (config.nexiFinancialManaged && nexiGroups.groupSource(node)) {
            try {
                const carrier = {};
                nexiGroups.observeNotification(carrier, node, authState.creds);
                const projection = nexiGroups.take(carrier, 'append');
                if (projection) {
                    if (!config.nexiGroupsAdmit) throw new Error('nexi_groups_admission_suspended');
                    await config.nexiGroupsAdmit(projection);
                } else {
                    // Authenticated Group-server notifications may lack a room,
                    // source ID or timestamp needed for an APP event. Discovery
                    // invalidation still precedes ACK and catalog completion.
                    if (!config.nexiGroupsInvalidate) throw new Error('nexi_groups_admission_suspended');
                    await config.nexiGroupsInvalidate();
                }
                await sendMessageAck(node);
            } catch {
                const failure = new Error('nexi_groups_admission_suspended');
                failure.code = 'NEXI_GROUPS_ADMISSION_SUSPENDED';
                config.nexiGroupsSuspend?.(failure);
                logger.warn('nexi_groups_admission_suspended');
            }
            return; // no generic notification derivation or fallback ACK
        }`);
  source = once(source, '    const sendMessageAck = async (node, errorCode) => {',
    '    const sendMessageAck = async (node, errorCode) => {\n        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);');
  source = once(source, '            return exec(node, false).catch(err => onUnexpectedError(err, identifier));',
    '            return nexiGroups.withPacketScope(node, config.nexiFinancialManaged, () => exec(node, false).catch(err => onUnexpectedError(err, identifier)));');
  for (const [type, handler] of [['message', 'handleMessage'], ['call', 'handleCall'],
    ['receipt', 'handleReceipt'], ['notification', 'handleNotification']]) {
    source = once(source, `        ['${type}', ${handler}]`,
      `        ['${type}', node => nexiGroups.withPacketScope(node, config.nexiFinancialManaged,
            () => ${handler}(node).catch(err => onUnexpectedError(err, 'processing offline ${type}')))]`);
  }
  source = once(source, '        onUnexpectedError,\n        yieldToEventLoop:',
    `        onUnexpectedError: config.nexiFinancialManaged
            ? () => logger.warn('nexi_groups_ambiguous_offline_error') : onUnexpectedError,
        yieldToEventLoop:`);
  source = once(source, '    const handleCall = async (node) => {\n        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);',
    `    const handleCall = async (node) => {
        const logger = nexiGroups.packetLogger(nexiBaseLogger, node, config.nexiFinancialManaged);
        if (config.nexiFinancialManaged && nexiGroups.groupSource(node)) {
            await sendMessageAck(node).catch(() => logger.warn('nexi_groups_call_ack_failed'));
            return;
        }`);
  source = once(source, "                        await upsertMessage(fullMsg, 'append');",
    `                        nexiGroups.observeNotification(fullMsg, node, authState.creds);
                        if (config.nexiFinancialManaged) {
                            const projection = nexiGroups.take(fullMsg, 'append');
                            if (projection) await config.nexiGroupsAdmit(projection);
                        }
                        await upsertMessage(fullMsg, 'append');`);
  // Native resend gets no group plaintext, including payloads loaded from DB.
  source = once(source, '            msgs.push(msg);',
    '            if (config.nexiFinancialManaged && nexiGroups.groupLike(key.remoteJid)) msg = undefined;\n            msgs.push(msg);');
  return source;
});
patch('node_modules/baileys/lib/Socket/chats.js', source => {
  source = "import nexiGroups from '/evolution/nexi-groups.cjs';\n" + source;
  source = once(source, '    const chatModify = (mod, jid) => {',
    `    const chatModify = (mod, jid) => {
        nexiGroups.validateTargets(config.nexiFinancialManaged, { modification: mod, jid }, jid);`);
  return once(source, '    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {',
    `    const upsertMessage = ev.createBufferedFunction(async (msg, type) => {
        // Trusted Group origin terminates BEFORE contact derivation, buffering,
        // profile lookup, creds pushname changes or generic processMessage.
        if (config.nexiFinancialManaged && nexiGroups.groupSource(msg)) return;`);
});
patch('node_modules/baileys/lib/Socket/socket.js', source => {
  source = "import nexiGroups from '/evolution/nexi-groups.cjs';\n" + source;
  // The socket logs decoded packets before the higher-level handler. Preserve
  // its direct diagnostics but filter structured Group packets at that source.
  const anchor = '    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;';
  return once(source, anchor, anchor.replace('connectTimeoutMs, logger,', 'connectTimeoutMs, logger: nexiSocketLogger,') +
    '\n    const logger = nexiGroups.privacyLogger(nexiSocketLogger, config.nexiFinancialManaged);');
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
  source = source.slice(0, end) + '\n  nexiGroupsSocketOwner String? @db.VarChar(36)\n  NexiGroupControl NexiGroupControl?\n  NexiGroupEventOutbox NexiGroupEventOutbox[]' + source.slice(end);
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
  sourceSession String? @db.VarChar(64)
  sourceGeneration Int?
  legacyGeneration Int?
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
