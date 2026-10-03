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
function section(source, start, end, transform) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Pinned lifecycle section changed');
  return source.slice(0, a) + transform(source.slice(a, b)) + source.slice(b);
}
function guardedAwait(source, expressions, context = 'nexiLifecycle') {
  for (const expression of expressions) {
    if (!source.includes(`await ${expression}`)) throw new Error(`Pinned lifecycle await changed: ${expression}`);
    source = source.replaceAll(`await ${expression}`, `await ${helper}.${context === 'nexiConnectOwner' ? 'connectAwait' : 'lifecycleAwait'}(${context}, () => ${expression})`);
  }
  return source;
}

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
    `    const nexiEventSocket = this.client;
    const nexiEventOwner = ${helper}.lifecycleCapture(this, nexiEventSocket);
    const nexiEventAuth = this.instance.authState;
    this.client.ev.process(async (events) => {
      if (!${helper}.lifecycleCurrent(nexiEventOwner)) return;`);
  source = once(source, '              this.instance.authState.saveCreds();',
    `              await ${helper}.cleanupLifecycle(nexiEventOwner, async () => nexiEventAuth.saveCreds());`);
  source = once(source, "              this.connectionUpdate(events['connection.update']);",
    `              if (${helper}.lifecycleCurrent(nexiEventOwner)) await this.connectionUpdate(events['connection.update'], nexiEventOwner);`);
  source = once(source, '  private async createClient(number?: string): Promise<WASocket> {',
    `  private async createClient(number?: string): Promise<WASocket> {
    const nexiConnectOwner = ${helper}.connectOwner(this);
    if (!await ${helper}.connectAwait(nexiConnectOwner, () => ${helper}.beforeConnect(this))) return this.client;`);
  source = once(source, "keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any)",
    `keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys,
          ${helper}.privacyLogger(P({ level: 'error' }), ${helper}.managed(this.instance.name)) as any)`);
  source = once(source, "    this.client = makeWASocket(require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, socketConfig));",
    `    const nexiCreatedSocket = await ${helper}.installAdmissionSocket(this, socketConfig,
      config => makeWASocket(require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, config)), nexiConnectOwner);
    if (this.client !== nexiCreatedSocket) throw ${helper}.staleLifecycle();`);
  source = once(source, "    if (connection === 'close') {", `    if (connection === 'close') {
      if (await ${helper}.recordSuspension(this, lastDisconnect?.error, Events.CONNECTION_UPDATE)) return;`);
  source = section(source, '  private async connectionUpdate(', '  private async getMessage(', block => {
    block = once(block, ': Partial<ConnectionState>) {', `: Partial<ConnectionState>, nexiLifecycle = ${helper}.lifecycleCapture(this)) {
    if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
    try {`);
    block = block.replaceAll('this.client', 'nexiLifecycle.socket');
    block = once(block, '        nexiLifecycle.socket?.ws?.close();',
      `        nexiLifecycle.socket?.ws?.close();
        if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;`);
    block = block.replaceAll('await this.prismaRepository.instance.update(', `await ${helper}.persistLifecycle(nexiLifecycle, `);
    block = guardedAwait(block, ['this.getProfileName()', 'delay(1000)',
      'nexiLifecycle.socket.requestPairingCode(this.phoneNumber)', 'this.profilePicture(this.instance.wuid)',
      `${helper}.recordSuspension(this, lastDisconnect?.error, Events.CONNECTION_UPDATE)`]);
    block = once(block, "      } catch {\n        this.instance.profilePictureUrl = null;",
      `      } catch {
        if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
        this.instance.profilePictureUrl = null;`);
    block = once(block, '      qrcode.toDataURL(qr, optsQrcode, (error, base64) => {',
      `      qrcode.toDataURL(qr, optsQrcode, (error, base64) => {
        if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;`);
    block = once(block, '      qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>',
      `      qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>
        ${helper}.lifecycleCurrent(nexiLifecycle) &&`);
    block = once(block, '        setTimeout(async () => {', `        ${helper}.scheduleLifecycle(nexiLifecycle, async () => {`);
    block = once(block, '        this.endSession = true;', `        ${helper}.cancelLifecycle(nexiLifecycle);
        this.endSession = true;`);
    block = once(block, "return this.eventEmitter.emit('no.connection', this.instance.name);",
      `return this.eventEmitter.emit('no.connection', this.instance.name, ${helper}.lifecycleCapture(this, nexiLifecycle.socket, true));`);
    block = once(block, "        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner');",
      `        ${helper}.cancelLifecycle(nexiLifecycle);
        nexiLifecycle = ${helper}.lifecycleCapture(this, nexiLifecycle.socket, true);
        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner', nexiLifecycle);
        if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;`);
    const last = block.lastIndexOf('\n  }');
    return block.slice(0, last) + `
    } catch (error) {
      if (error?.code === 'NEXI_SOCKET_LIFECYCLE_STALE') return;
      throw error;
    }` + block.slice(last);
  });
  source = section(source, '  private async createClient(', '  public async connectToWhatsapp(', block => {
    block = guardedAwait(block, ['this.defineAuthState()', 'fetchLatestWaWebVersion({}, this.cache)',
      'axios.get(this.localProxy?.host)'], 'nexiConnectOwner');
    block = once(block, "        } catch (error) {\n          this.logger.error(error);",
      `        } catch (error) {
          ${helper}.connectCheck(nexiConnectOwner);
          this.logger.error(error);`);
    block = once(block, "    this.client.ws.on('CB:stream:error', (node: { attrs?: { code?: string | number } }) => {",
      `    const nexiStreamOwner = ${helper}.lifecycleCapture(this);
    this.client.ws.on('CB:stream:error', (node: { attrs?: { code?: string | number } }) => {
      if (!${helper}.lifecycleCurrent(nexiStreamOwner)) return;`);
    return block;
  });
  for (const [start, end] of [['  public async connectToWhatsapp(', '  public async reloadConnection('],
    ['  public async reloadConnection(', '  private readonly chatHandle']]) source = section(source, start, end, block => {
    block = once(block, '    try {', `    return ${helper}.connectLifecycle(this, async () => {
    try {`);
    const last = block.lastIndexOf('\n  }');
    return block.slice(0, last) + '\n    });' + block.slice(last);
  });
  source = section(source, '  public async reloadConnection(', '  private readonly chatHandle', block => {
    block = once(block, '  public async reloadConnection(): Promise<WASocket> {',
      `  public async reloadConnection(nexiOrigin?: any): Promise<WASocket> {
    const nexiReloadOwner = nexiOrigin || ${helper}.lifecycleCapture(this);`);
    block = once(block, '      return await this.createClient(this.phoneNumber);',
      `      await ${helper}.operationCheck(nexiReloadOwner);
      ${helper}.connectCheck(nexiReloadOwner);
      if (nexiReloadOwner.socket?.ws?.isOpen) nexiReloadOwner.socket.end(new Error('nexi_socket_profile_reload'));
      ${helper}.connectCheck(nexiReloadOwner);
      const nexiReloadedSocket = await this.createClient(this.phoneNumber);
      // Completion authority belongs to this exact returned socket. A different
      // current socket cannot be adopted by a late operation's completion.
      await ${helper}.operationCheck(${helper}.lifecycleCapture(this, nexiReloadedSocket), { requireOpen: false });
      return nexiReloadedSocket;`);
    block = once(block, '    } catch (error) {', `    } catch (error) {
      if (error?.code === 'NEXI_SOCKET_LIFECYCLE_STALE') throw error;`);
    return once(block, '    });', '    }, nexiReloadOwner);');
  });
  for (const [start, end, mutations] of [
    ['  public async updatePrivacySettings(', '  public async fetchBusinessProfile(',
      ['updateReadReceiptsPrivacy(settings.readreceipts)', 'updateProfilePicturePrivacy(settings.profile)',
        'updateStatusPrivacy(settings.status)', 'updateOnlinePrivacy(settings.online)',
        'updateLastSeenPrivacy(settings.last)', 'updateGroupsAddPrivacy(settings.groupadd)']],
    ['  public async updateProfilePicture(', '  public async removeProfilePicture(', ['updateProfilePicture(nexiProfileTarget, pic)']],
    ['  public async removeProfilePicture(', '  public async blockUser(', ['removeProfilePicture(nexiProfileTarget)']]
  ]) source = section(source, start, end, block => {
    block = once(block, '    try {', `    const nexiOperation = ${helper}.lifecycleCapture(this);
    const nexiProfileTarget = this.instance.wuid;
    try {
      await ${helper}.operationCheck(nexiOperation);`);
    block = block.replaceAll('this.client', 'nexiOperation.socket').replaceAll('this.instance.wuid', 'nexiProfileTarget');
    block = once(block, 'const nexiProfileTarget = nexiProfileTarget;', 'const nexiProfileTarget = this.instance.wuid;');
    for (const mutation of mutations) block = once(block, `await nexiOperation.socket.${mutation}`,
      `await ${helper}.operationAwait(nexiOperation, () => nexiOperation.socket.${mutation})`);
    if (start.includes('updateProfilePicture(')) block = once(block, 'await axios.get(url, config)',
      `await ${helper}.operationAwait(nexiOperation, () => axios.get(url, config))`);
    block = once(block, '      this.reloadConnection();', '      await this.reloadConnection(nexiOperation);');
    return once(block, '    } catch (error) {', `    } catch (error) {
      if (error?.code === 'NEXI_SOCKET_LIFECYCLE_STALE') throw error;`);
  });
  source = section(source, '  public async logoutInstance()', '  public async getProfileName()', block => {
    block = once(block, '  public async logoutInstance() {', `  public async logoutInstance() {
    const nexiLifecycle = await ${helper}.manualOwner(this);
    if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
    return ${helper}.manualLifecycle(nexiLifecycle, async () => {`);
    block = block.replaceAll('this.client', 'nexiLifecycle.socket');
    // The declaration must capture the real socket, rather than self-reference.
    block = guardedAwait(block, ["nexiLifecycle.socket.logout('Log out instance: ' + this.instanceName)"]);
    block = once(block, '        nexiLifecycle.socket.ws?.close();',
      `        nexiLifecycle.socket.ws?.close();
        ${helper}.lifecycleCheck(nexiLifecycle);`);
    block = once(block, '      } catch (error) {', `      } catch (error) {
        if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;`);
    const tail = block.indexOf('    // Force the in-memory');
    const last = block.lastIndexOf('\n  }');
    let cleanup = block.slice(tail, last).replaceAll('this.prismaRepository', 'nexiRepository');
    cleanup = guardedAwait(cleanup, ['this.authStateProvider.authStateProvider(this.instance.id)', 'authState.removeCreds()',
      'useMultiFileAuthStateRedisDb(this.instance.id, this.cache)', 'useMultiFileAuthStatePrisma(this.instance.id, this.cache)',
      'nexiRepository.session.findFirst({ where: { sessionId: this.instanceId } })',
      'nexiRepository.session.delete({ where: { sessionId: this.instanceId } })']);
    cleanup = cleanup.replaceAll('await nexiRepository.instance.update(', `await ${helper}.persistLifecycle(nexiLifecycle, `);
    // Parent ownership lock fences credential/session cleanup against replacement.
    cleanup = once(cleanup, "data: { connectionStatus: 'close' },\n    });", "data: { connectionStatus: 'close' },\n    }, nexiRepository);");
    return block.slice(0, tail) + `    return ${helper}.cleanupLifecycle(nexiLifecycle, async nexiRepository => {
${cleanup}
    });
    });` + block.slice(last);
  });
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
            if (!${helper}.lifecycleCurrent(nexiEventOwner)) return;
            const database = this.configService.get<Database>('DATABASE');
            const settings = await ${helper}.lifecycleAwait(nexiEventOwner, () => this.findSettings());`);
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
  source = once(source,
  "      instanceData.connectionStatus === 'open' ||",
  `      (instanceData.integration === Integration.WHATSAPP_BAILEYS &&
        await ${helper}.restoreSuspension(instance, (instanceData as any).nexiGroupsAdmissionSuspended)) ||
      instanceData.connectionStatus === 'open' ||`);
  source = once(source, '  private async setInstance(instanceData: InstanceDto) {',
    `  private async setInstance(instanceData: InstanceDto) {
    if (this.waInstances[instanceData.instanceName]) return this.waInstances[instanceData.instanceName];`);
  source = once(source, `      (instanceData.integration === Integration.WHATSAPP_BAILEYS &&
        await ${helper}.restoreSuspension(instance, (instanceData as any).nexiGroupsAdmissionSuspended)) ||`, '      nexiRecoverable ||');
  source = once(source, "    if (\n      nexiRecoverable ||", `    const nexiRecoverable = instanceData.integration === Integration.WHATSAPP_BAILEYS &&
      await ${helper}.restoreSuspension(instance, (instanceData as any).nexiGroupsAdmissionSuspended);
    if (instanceData.integration === Integration.WHATSAPP_BAILEYS &&
      !${helper}.trackRecovery(this, instance, instanceData.instanceName)) return;
    if (
      nexiRecoverable ||`);
  source = once(source, '      await instance.connectToWhatsapp();', `      const nexiStartupOwner = ${helper}.lifecycleCapture(instance);
      try {
        if (instanceData.integration === Integration.WHATSAPP_BAILEYS) await ${helper}.controlConnect(nexiStartupOwner);
        else await instance.connectToWhatsapp();
      } catch (error) {
        const nexiPending = await ${helper}.startupFailure(instance, nexiStartupOwner);
        if (!nexiRecoverable && !nexiPending) throw error;
        this.logger.warn('nexi_groups_startup_recovery_pending');
      }`);
  source = once(source, '    this.waInstances[instanceData.instanceName] = instance;',
    `    ${helper}.trackRecovery(this, instance, instanceData.instanceName);`);
  source = section(source, '  public delInstanceTime(', '  public clearDelInstanceTime(', block => {
    block = once(block, '    const time =', `    const nexiService = this.waInstances[instance];
    if (!nexiService) return;
    const nexiLifecycle = ${helper}.lifecycleCapture(nexiService);
    const time =`);
    block = once(block, '      this.delInstanceTimeouts[instance] = setTimeout(', '      const nexiTimer = setTimeout(');
    block = once(block, '          try {', `          if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
          try {`);
    block = block.replaceAll('this.waInstances[instance]?.client', 'nexiLifecycle.socket')
      .replaceAll('this.waInstances[instance]', 'nexiService');
    block = once(block, 'const nexiService = nexiService;', 'const nexiService = this.waInstances[instance];');
    block = guardedAwait(block, ['nexiService.integration', "nexiLifecycle.socket?.logout('Log out instance: ' + instance)"]);
    block = block.replaceAll("this.eventEmitter.emit('remove.instance', instance, 'inner');",
      `this.eventEmitter.emit('remove.instance', instance, 'inner', nexiLifecycle);`);
    block = once(block, '          } finally {', `          } catch (error) {
            if (error?.code !== 'NEXI_SOCKET_LIFECYCLE_STALE') this.logger.warn('nexi_socket_expiry_unavailable');
          } finally {`);
    block = once(block, '            delete this.delInstanceTimeouts[instance];',
      '            if (this.delInstanceTimeouts[instance] === nexiTimer) delete this.delInstanceTimeouts[instance];');
    return once(block, '        1000 * 60 * time,\n      );', '        1000 * 60 * time,\n      );\n      this.delInstanceTimeouts[instance] = nexiTimer;');
  });
  for (const [start, end] of [['  public async cleaningUp(', '  public async cleaningStoreData('],
    ['  public async cleaningStoreData(', '  public async loadInstance()']]) source = section(source, start, end, block => {
    const signature = block.slice(0, block.indexOf('{') + 1);
    const body = block.slice(signature.length, block.lastIndexOf('\n  }'));
    let fenced = body.replaceAll('this.prismaRepository', 'nexiRepository');
    fenced = guardedAwait(fenced, ["nexiRepository.instance.findFirst({\n      where: { name: instanceName },\n    })"].filter(expression => fenced.includes(`await ${expression}`)));
    fenced = fenced.replace(/await ((?:nexiRepository|this\.cache|this\.providerFiles)\.[^\n;]+\([^\n;]*\));/g,
      `await ${helper}.lifecycleAwait(nexiLifecycle, () => $1);`);
    if (start.includes('cleaningUp(')) fenced = guardedAwait(fenced,
      ["nexiRepository.instance.findFirst({\n        where: { name: instanceName },\n      })"]);
    if (start.includes('cleaningUp(')) fenced = once(fenced, 'await nexiRepository.instance.update(',
      `await ${helper}.persistLifecycle(nexiLifecycle, `).replace("data: { connectionStatus: 'close' },\n        });",
        "data: { connectionStatus: 'close' },\n        }, nexiRepository);");
    const fencedSignature = signature.replace('instanceName: string)', 'instanceName: string, nexiOrigin?: any)');
    return `${fencedSignature}
    const nexiService = this.waInstances[instanceName];
    const nexiLifecycle = nexiOrigin || (nexiService && ${helper}.lifecycleCapture(nexiService, nexiService.client, true));
    if (nexiLifecycle && !${helper}.lifecycleCurrent(nexiLifecycle)) return;
    if (nexiLifecycle?.owner) {
      if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
      return ${helper}.cleanupLifecycle(nexiLifecycle, async nexiRepository => {${fenced}
      });
    }
${body}
  }

`;
  });
  for (const [event, next] of [['remove.instance', "    this.eventEmitter.on('logout.instance'"],
    ['logout.instance', '\n  private noConnection()'], ['no.connection', '\n}\n']]) {
    source = section(source, `    this.eventEmitter.on('${event}'`, next, block => {
      const begin = block.indexOf('=> {') + 4, finish = block.lastIndexOf('    });');
      let body = block.slice(begin, finish);
      body = body.replaceAll('this.waInstances[instanceName]?.client', 'nexiLifecycle.socket');
      body = body.replaceAll('this.waInstances[instanceName]', 'nexiService');
      body = body.replaceAll('this.cleaningUp(instanceName);', 'await this.cleaningUp(instanceName, nexiLifecycle);');
      body = body.replaceAll('this.cleaningStoreData(instanceName);', 'await this.cleaningStoreData(instanceName, nexiLifecycle);');
      // Recheck after each existing async webhook/logout boundary.
      body = guardedAwait(body, event === 'no.connection'
        ? ["nexiLifecycle.socket?.logout('Log out instance: ' + instanceName)"]
        : [`nexiService?.sendDataWebhook(Events.${event === 'remove.instance' ? 'REMOVE_INSTANCE' : 'LOGOUT_INSTANCE'}, null)`]);
      if (event !== 'no.connection') body = guardedAwait(body,
        ['this.cleaningUp(instanceName, nexiLifecycle)', 'this.cleaningStoreData(instanceName, nexiLifecycle)']
          .filter(expression => body.includes(`await ${expression}`)));
      if (event === 'no.connection') body = once(body, '      try {', `      try {
        if (nexiLifecycle.owner) await ${helper}.cleanupLifecycle(nexiLifecycle, async () => {});`);
      if (event === 'remove.instance') body = body.replace('delete nexiService;',
        'if (this.waInstances[instanceName] === nexiService) delete this.waInstances[instanceName];');
      const header = `    this.eventEmitter.on('${event}', async (instanceName: string, nexiArgument?: any, nexiOwner?: any) => {
      const nexiService = this.waInstances[instanceName];
      if (!nexiService) return;
      const nexiLifecycle = nexiOwner || (nexiArgument?.owner ? nexiArgument : ${helper}.lifecycleCapture(nexiService, nexiService.client, true));
      if (!${helper}.lifecycleCurrent(nexiLifecycle)) return;
      try {
        await ${helper}.manualLifecycle(nexiLifecycle, async () => {`;
      return header + body + `
        });
      } catch (error) {
        if (error?.code !== 'NEXI_SOCKET_LIFECYCLE_STALE') this.logger.warn('nexi_socket_cleanup_unavailable');
      }
    });` + block.slice(finish + '    });'.length);
    });
  }
  source = once(source, '    return instances;', `    return instances.map(({ nexiGroupsSocketOwner, ...instance }) => instance);`);
  return source;
});
patch('src/api/services/channel.service.ts', source => section(source,
  '  public async setSettings(', '  public async findSettings(', block => {
    block = once(block, '    await this.prismaRepository.setting.upsert({',
      `    const nexiSettingsOwner = ${helper}.lifecycleCapture(this);
    await this.prismaRepository.setting.upsert({`);
    block = once(block, '    this.localSettings.rejectCall = data?.rejectCall;',
      `    ${helper}.lifecycleCheck(nexiSettingsOwner);
    this.localSettings.rejectCall = data?.rejectCall;`);
    block = once(block, '      this.client.ws.close();',
      `      ${helper}.lifecycleCheck(nexiSettingsOwner);
      nexiSettingsOwner.socket.ws.close();
      ${helper}.lifecycleCheck(nexiSettingsOwner);`);
    return once(block, '      this.client.ws.connect();', '      nexiSettingsOwner.socket.ws.connect();');
  }));
patch('src/api/controllers/instance.controller.ts', source => {
  source = section(source, '  public async createInstance(', '  public async connectToWhatsapp(', block => {
    block = once(block, '    try {\n      instanceData.instanceName', '    let nexiCreationOwner: any;\n    try {\n      instanceData.instanceName');
    block = once(block, '      this.waMonitor.waInstances[instance.instanceName] = instance;',
      `      if (instanceData.integration === Integration.WHATSAPP_BAILEYS) {
        if (!${helper}.trackRecovery(this.waMonitor, instance, instance.instanceName)) throw ${helper}.staleLifecycle();
        nexiCreationOwner = ${helper}.lifecycleCapture(instance);
      } else this.waMonitor.waInstances[instance.instanceName] = instance;`);
    for (const expression of ['eventManager.setInstance(instance.instanceName, instanceData)',
      'this.settingsService.create(instanceDto, settings)']) block = once(block, `await ${expression}`,
      `await (nexiCreationOwner ? ${helper}.connectAwait(nexiCreationOwner, () => ${expression}) : ${expression})`);
    block = once(block, '        if (!testProxy) {', `        if (nexiCreationOwner) ${helper}.connectCheck(nexiCreationOwner);
        if (!testProxy) {`);
    block = once(block, '      const settings: wa.LocalSettings = {', `      if (nexiCreationOwner) ${helper}.connectCheck(nexiCreationOwner);
      const settings: wa.LocalSettings = {`);
    block = once(block, '          await instance.connectToWhatsapp(instanceData.number);',
      `          await ${helper}.controlConnect(nexiCreationOwner, instanceData.number);`);
    return once(block, '      this.waMonitor.deleteInstance(instanceData.instanceName);',
      `      if (error?.code === 'NEXI_SOCKET_LIFECYCLE_STALE') throw error;
      if (nexiCreationOwner) ${helper}.connectCheck(nexiCreationOwner);
      this.waMonitor.deleteInstance(instanceData.instanceName);`);
  });
  source = section(source, '  public async restartInstance(', '  public async connectionState(', block => {
    block = once(block, '      const state = instance?.connectionStatus?.state;',
      `      const nexiLifecycle = instance && ${helper}.lifecycleCapture(instance, instance.client, true);
      const state = instance?.connectionStatus?.state;`);
    block = once(block, '        instance.client?.ws?.close();',
      `        ${helper}.lifecycleCheck(nexiLifecycle);
        nexiLifecycle.socket?.ws?.close();
        ${helper}.lifecycleCheck(nexiLifecycle);`);
    return once(block, "        instance.client?.end(new Error('restart'));", `        nexiLifecycle.socket?.end(new Error('restart'));
        ${helper}.lifecycleCheck(nexiLifecycle);`);
  });
  for (const [start, end] of [['  public async logout(', '  public async deleteInstance('],
    ['  public async deleteInstance(', '\n}\n']]) source = section(source, start, end, block => {
    block = once(block, '    const { instance } = await this.connectionState({ instanceName });',
      `    const nexiService = this.waMonitor.waInstances[instanceName];
    const nexiLifecycle = nexiService && ${helper}.lifecycleCapture(nexiService, nexiService.client, true);
    const { instance } = await this.connectionState({ instanceName });
    if (nexiLifecycle) ${helper}.lifecycleCheck(nexiLifecycle);`);
    if (start.includes('logout(')) {
      block = once(block, 'await this.waMonitor.waInstances[instanceName]?.logoutInstance();',
        `await nexiService?.logoutInstance();
      if (nexiLifecycle) ${helper}.lifecycleCheck(nexiLifecycle);`);
    } else {
      block = once(block, 'const waInstances = this.waMonitor.waInstances[instanceName];', 'const waInstances = nexiService;');
      block = once(block, '          await this.logout({ instanceName });',
        `          await this.logout({ instanceName });
          if (nexiLifecycle) ${helper}.lifecycleCheck(nexiLifecycle);`);
      block = once(block, '        } catch (error) {', `        } catch (error) {
          if (nexiLifecycle) ${helper}.lifecycleCheck(nexiLifecycle);`);
      block = once(block, "      this.eventEmitter.emit('remove.instance', instanceName, 'inner');",
        `      if (nexiLifecycle) ${helper}.lifecycleCheck(nexiLifecycle);
      this.eventEmitter.emit('remove.instance', instanceName, 'inner', nexiLifecycle);`);
    }
    return block;
  });
  return source;
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
  source = section(source, '  public async receiveWebhook(', '  private async updateChatwootMessageId(', block => {
    block = once(block, '    try {\n      await new Promise', `    const nexiControlService = this.waMonitor?.waInstances?.[instance.instanceName];
    const nexiControlOwner = nexiControlService && ${helper}.lifecycleCapture(nexiControlService, nexiControlService.client, true);
    const nexiBotCommand = body?.message_type === 'outgoing' &&
      body?.conversation?.meta?.sender?.identifier === '123456';
    const nexiCheckControl = () => { if (nexiBotCommand) ${helper}.lifecycleCheck(nexiControlOwner); };
    try {\n      await new Promise`);
    block = once(block, '      await new Promise((resolve) => setTimeout(resolve, 500));',
      `      await new Promise((resolve) => setTimeout(resolve, 500));
      nexiCheckControl();`);
    block = once(block, '      const client = await this.clientCw(instance);',
      `      const client = await this.clientCw(instance);
      nexiCheckControl();`);
    block = once(block, "      if (chatId === '123456' && body.message_type === 'outgoing') {",
      `      if (chatId === '123456' && body.message_type === 'outgoing') {
        nexiCheckControl();`);
    block = once(block, '            await waInstance.connectToWhatsapp(number);',
      `            await ${helper}.controlConnect(nexiControlOwner, number);`);
    block = once(block, "          await this.createBotMessage(instance, msgLogout, 'incoming');\n\n          await waInstance?.client?.logout('Log out instance: ' + instance.instanceName);\n          await waInstance?.client?.ws?.close();",
      `          await ${helper}.manualLifecycle(nexiControlOwner, async () => {
            if (nexiControlOwner.owner) await ${helper}.cleanupLifecycle(nexiControlOwner, async () => {});
            // A pending response cannot claim successful disconnection before
            // the awaited control operation and ownership checks complete.
            try {
              await ${helper}.lifecycleAwait(nexiControlOwner, () => this.createBotMessage(instance,
                i18next.t('cw.inbox.status', { inboxName: body.inbox.name, state: 'pending' }), 'incoming'));
            } catch {
              ${helper}.lifecycleCheck(nexiControlOwner);
              this.logger.warn('nexi_socket_control_response_unavailable');
            }
            await ${helper}.lifecycleAwait(nexiControlOwner, () => nexiControlOwner.socket?.logout('Log out instance: ' + instance.instanceName));
            await ${helper}.lifecycleAwait(nexiControlOwner, () => nexiControlOwner.socket?.ws?.close());
            if (nexiControlOwner.owner) await ${helper}.cleanupLifecycle(nexiControlOwner, async repository =>
              ${helper}.persistLifecycle(nexiControlOwner, { data: { connectionStatus: 'close' } }, repository));
            ${helper}.lifecycleCheck(nexiControlOwner);
            nexiControlOwner.service.stateConnection.state = 'close';
            await ${helper}.lifecycleAwait(nexiControlOwner, () => this.createBotMessage(instance, msgLogout, 'incoming'));
          });`);
    block = once(block, '    } catch (error) {\n      this.logger.error(error);', `    } catch (error) {
      if (error?.code === 'NEXI_SOCKET_LIFECYCLE_STALE') return { message: 'bot', lifecycle: 'superseded' };
      this.logger.error(error);`);
    return block;
  });
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
