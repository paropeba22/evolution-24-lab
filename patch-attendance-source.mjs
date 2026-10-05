import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/evolution';
const changes = [];
const helper = "require('/evolution/nexi-attendance.cjs')";
export function once(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Attendance pinned anchor: expected 1, found ${count}: ${anchor.slice(0, 96)}`);
  return source.replace(anchor, () => replacement);
}
function patch(file, transform) {
  const target = path.join(root, file), before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  const after = transform(before);
  if (after === before) throw new Error(`Attendance empty patch: ${file}`);
  changes.push({ file, target, before, after });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/baileys/package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
if (pkg.version !== '7.0.0-rc13' || lock.packages['node_modules/baileys'].version !== pkg.version ||
    lock.packages['node_modules/baileys'].integrity !== 'sha512-v8k74K8B5R7WNYGa26MyJAYEu3Wc4BSuK01QaK8lr30lhE8Nga31nWNu8KN0NDDt+Fsvkq4SQFFI8Q13ghjKmA==') {
  throw new Error('Attendance requires exact accepted Baileys runtime/lock');
}
const proto = fs.readFileSync(path.join(root, 'node_modules/baileys/WAProto/index.js'), 'utf8').replaceAll('\r\n', '\n');
for (const anchor of ['values[valuesById[14] = "MESSAGE_EDIT"] = 14;',
  'values[valuesById[16] = "PEER_DATA_OPERATION_REQUEST_MESSAGE"] = 16;',
  'values[valuesById[4] = "PLACEHOLDER_MESSAGE_RESEND"] = 4;']) once(proto, anchor, anchor);
const mariaPackage = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@prisma/adapter-mariadb/package.json')));
const mariaSource = fs.readFileSync(path.join(root, 'node_modules/@prisma/adapter-mariadb/dist/index.js'), 'utf8');
if (mariaPackage.version !== '7.8.0' || lock.packages['node_modules/@prisma/adapter-mariadb'].version !== '7.8.0' ||
    mariaSource.split('  underlyingDriver() {\n    return this.client;\n  }').length !== 2 ||
    mariaSource.split('await this.client.query({ sql: "COMMIT" });').length !== 2)
  throw new Error('Attendance requires pinned MariaDB adapter pool/transaction boundaries');
patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', source => {
  const before = `    const nexiCreatedSocket = await require('/evolution/nexi-groups.cjs').installAdmissionSocket(this, socketConfig,
      config => makeWASocket(require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, config)), nexiConnectOwner);`;
  const replacement = `    const nexiAttendanceConfig = await ${helper}.configure(this,
      require('/evolution/nexi-financial-transport.cjs').socketConfig(this.instance.name, socketConfig));
    require('/evolution/nexi-groups.cjs').connectCheck(nexiConnectOwner);
    const nexiCreatedSocket = await require('/evolution/nexi-groups.cjs').installAdmissionSocket(this, nexiAttendanceConfig,
      config => makeWASocket(config), nexiConnectOwner);
    ${helper}.trackSocket(nexiCreatedSocket, nexiAttendanceConfig);`;
  source = once(source, before, replacement);
  return once(source, "  public async baileysSendNode(stanza: any) {\n    console.log('stanza', JSON.stringify(stanza));",
    `  public async baileysSendNode(stanza: any) {
    await ${helper}.rawNodeForInstance(this.prismaRepository, { instanceName: this.instance.name }, stanza);`);
});
patch('src/api/integrations/channel/whatsapp/voiceCalls/useVoiceCallsBaileys.ts', source => once(source,
  "      console.log('sendNode', JSON.stringify(stanza));",
  `      ${helper}.rawNodeForSocket(baileys_sock, stanza);`));
patch('node_modules/baileys/lib/Socket/messages-recv.js', source => {
  source = "import nexiAttendance from '/evolution/nexi-attendance.cjs';\n" + source;
  const receipt = `        try {
            await Promise.all([
                receiptMutex.mutex(async () => {`;
  source = once(source, receipt, `        // Exact rc13 direction/remoteJid/IDs, before any ev.emit or buffer merge.
        await nexiAttendance.capture(config, attrs, key, ids);
` + receipt);
  source = once(source, `        if (attrs.error) {
            const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked);`,
    `        if (attrs.error) {
            await nexiAttendance.captureBadAck(config, attrs, key);
            const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked);`);
  return once(source, '            msgs.push(msg);',
    '            msg = await nexiAttendance.retryMessage(config, { ...key, id }, msg);\n            msgs.push(msg);');
});
patch('node_modules/baileys/lib/Socket/messages-send.js', source => {
  source = "import nexiAttendance from '/evolution/nexi-attendance.cjs';\n" + source;
  source = once(source, '        const msgId = await relayMessage(meJid, protocolMessage, {',
    '        nexiAttendance.markInternalControl(config, protocolMessage, meJid);\n        const msgId = await relayMessage(meJid, protocolMessage, {');
  source = once(source, '                logger.debug({ msgId }, `sending newsletter message to ${jid}`);',
    '                nexiAttendance.bindStanza(config, stanza, message, msgId);\n                logger.debug({ msgId }, `sending newsletter message to ${jid}`);');
  return once(source, '            nexiFinancial.assertWireRecipient(destinationJid, stanza, authState.creds, message, config.nexiFinancialManaged);',
    '            nexiAttendance.bindStanza(config, stanza, message, msgId);\n            nexiFinancial.assertWireRecipient(destinationJid, stanza, authState.creds, message, config.nexiFinancialManaged);');
});
patch('node_modules/baileys/lib/Socket/index.js', source => once(
  "import nexiAttendance from '/evolution/nexi-attendance.cjs';\n" + source,
  '    return makeCommunitiesSocket(newConfig);',
  '    nexiAttendance.inheritConfig(config, newConfig);\n    return makeCommunitiesSocket(newConfig);'));
patch('node_modules/baileys/lib/Socket/socket.js', source => {
  source = "import nexiAttendance from '/evolution/nexi-attendance.cjs';\n" +
    "import { WA_ADV_ACCOUNT_SIG_PREFIX, WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX } from '../Defaults/index.js';\n" + source;
  source = once(source, '    const sendNode = (frame) => {',
    `    const sendNode = async (frame) => {
        await nexiAttendance.assertNode(config, frame);`);
  // Exported raw bytes are a separate surface. Internal handshake/noise calls
  // retain their lexical sendRawMessage and cannot be forged through attributes.
  source = once(source, '        sendRawMessage,\n        sendNode,',
    `        sendRawMessage: data => {
            nexiAttendance.externalRaw(config);
            return sendRawMessage(data);
        },
        sendNode,`);
  const observer = `    const nexiObserveAccount = (provenance) => {
        const attestation = nexiAttendance.publicAttestation(authState.creds, Curve.verify,
            details => proto.ADVDeviceIdentity.decode(details).deviceType === proto.ADVEncryptionType.HOSTED
                ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX, provenance);
        void nexiAttendance.sessionObserved(config, attestation);
    };\n`;
  source = once(source, '    // device paired for the first time', observer + '    // device paired for the first time');
  // creds.update may not mutate the original object synchronously. Verify a
  // bounded merged public view after pinned pairing verified account signature.
  source = once(source, "            ev.emit('creds.update', updatedCreds);", `            ev.emit('creds.update', updatedCreds);
            const nexiPairedAccount = nexiAttendance.publicAttestation({ ...creds, ...updatedCreds }, Curve.verify,
                details => proto.ADVDeviceIdentity.decode(details).deviceType === proto.ADVEncryptionType.HOSTED
                    ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX, 'verified_pairing');
            void nexiAttendance.sessionObserved(config, nexiPairedAccount);`);
  return once(source, "    ws.on('CB:success', async (node) => {\n        try {",
    "    ws.on('CB:success', async (node) => {\n        try {\n            nexiObserveAccount('verified_restored_account');");
});
patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', source => {
  source = once(source, '  public async receiveWebhook(instance: InstanceDto, body: any) {',
    `  public async receiveWebhook(instance: InstanceDto, body: any) {
    if (body?.message_type === 'outgoing' && body?.conversation?.meta?.sender?.identifier !== '123456' &&
        !await ${helper}.legacyForInstance(this.prismaRepository, instance, 'chatwoot_outbound', body?.source_id?.replace(/^WAID:/, ''))) {
      return { error: 'nexi_attendance_legacy_bypass_denied' };
    }`);
  source = once(source, "      if (event === 'messages.read') {",
    `      if (event === 'messages.read') {
        if (!await ${helper}.legacyForInstance(this.prismaRepository, instance, 'conversation_read', body?.key?.id)) return;`);
  return once(source, 'await chatwootImport.updateMessageSourceID(chatwootMessageIds.messageId, key.id);',
    'await chatwootImport.updateMessageSourceID(chatwootMessageIds.messageId, key.id, instance, this.prismaRepository);');
});
patch('src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts', source => {
  const signature = `  public async importHistoryMessages(
    instance: InstanceDto,
    chatwootService: ChatwootService,
    inbox: inbox,
    provider: ChatwootModel,
  ) {`;
  source = once(source, signature, `${signature}
    if (!await ${helper}.legacyForInstance((chatwootService as any).prismaRepository, instance, 'import_database')) return 0;`);
  source = once(source, '      let messagesOrdered = this.historyMessages.get(instance.instanceName) || [];',
    `      let messagesOrdered = this.historyMessages.get(instance.instanceName) || [];
      const nexiAllowedMessages = [];
      for (const message of messagesOrdered) {
        if (await ${helper}.legacyForInstance((chatwootService as any).prismaRepository, instance, 'import_database', (message.key as any)?.id))
          nexiAllowedMessages.push(message);
      }
      messagesOrdered = nexiAllowedMessages;`);
  return once(source, '  public updateMessageSourceID(messageId: string | number, sourceId: string) {',
    `  public async updateMessageSourceID(messageId: string | number, sourceId: string, instance: InstanceDto, repository: any) {
    if (!await ${helper}.legacyForInstance(repository, instance, 'import_database_source_id', sourceId))
      throw new Error('nexi_attendance_legacy_bypass_denied');`);
});
patch('src/api/routes/index.router.ts', source => once(source, 'const telemetry = new Telemetry();',
  `${helper}.installRoutes(router, waMonitor, authGuard['apikey'], prismaRepository);\n\nconst telemetry = new Telemetry();`));
patch('src/api/repository/repository.service.ts', source => once(once(source, '    await this.$disconnect();',
  '    await this.nexiAttendanceReceiptClient?.$disconnect();\n    await this.$disconnect();'), "  private readonly logger = new Logger('PrismaRepository');",
  `  private nexiAttendanceReceiptClient?: PrismaClient;
  public attendanceReceiptRepository() {
    if (!this.nexiAttendanceReceiptClient) {
      const limits = ${helper}.settings();
      const uri = this.configService.get<Database>('DATABASE').CONNECTION.URI;
      const provider = process.env.DATABASE_PROVIDER ?? 'postgresql';
      const mysqlUri = new URL(uri);
      for (const [key, value] of Object.entries({ acquireTimeout: limits.acquireMs,
        connectTimeout: limits.acquireMs, connectionLimit: limits.concurrent, socketTimeout: limits.statementMs }))
        mysqlUri.searchParams.set(key, String(value));
      mysqlUri.searchParams.delete('queryTimeout'); // MariaDB-only setting rejects real MySQL servers.
      const adapter = provider === 'mysql' ? ${helper}.boundedMariaDb(new PrismaMariaDb(mysqlUri.toString()), limits) :
        new PrismaPg({ connectionString: uri, connectionTimeoutMillis: limits.acquireMs, max: limits.concurrent,
          query_timeout: limits.statementMs, statement_timeout: limits.statementMs, lock_timeout: limits.lockMs });
      this.nexiAttendanceReceiptClient = new PrismaClient({ adapter });
    }
    return this.nexiAttendanceReceiptClient;
  }
  private readonly logger = new Logger('PrismaRepository');`));
patch('tsup.config.ts', source => once(once(source, "external: ['/evolution/nexi-groups.cjs', 'baileys',",
  "external: ['/evolution/nexi-attendance.cjs', '/evolution/nexi-groups.cjs', 'baileys',"),
  '  noExternal: [/^@prisma\\/client$/],',
  '  noExternal: [/^@prisma\\/client$/, /^@prisma\\/adapter-mariadb$/, /^mariadb$/],'));
const models = fs.readFileSync(path.join(root, 'attendance-models.prisma'), 'utf8');
for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) patch(`prisma/${provider}-schema.prisma`, source => {
  if (source.split('model Instance {').length !== 2 || source.split('model NexiGroupControl {').length !== 2 ||
      source.includes('model NexiAttendancePreparation')) throw new Error(`${provider}: Attendance schema baseline changed`);
  return source + '\n' + models.replaceAll('JSON_TYPE', provider === 'mysql' ? '@db.Json' : '@db.JsonB');
});
// Validate every anchor before writing ANY file. No partial layer on failure.
if (!process.argv.includes('--verify')) for (const change of changes) {
  if (process.argv.includes('--snapshot')) {
    const snapshot = path.join(root, '.attendance-upstream', change.file);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true }); fs.writeFileSync(snapshot, change.before);
  }
  fs.writeFileSync(change.target, change.after);
}
