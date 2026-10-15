import fs from 'node:fs';
import path from 'node:path';

// Applied after the S3 attendance patch. All anchors fail closed before writes.
const root = process.argv[2] || '/evolution';
const changes = [];
const helper = "require('/evolution/nexi-ingress.cjs')";
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Ingress pinned anchor changed: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, () => replacement);
}
function patch(file, transform) {
  const target = path.join(root, file), before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  changes.push({ file, target, before, after: transform(before) });
}
patch('node_modules/baileys/lib/Socket/messages-recv.js', source => {
  // Observe and commit after authenticated decryption, before the existing
  // delivery receipt. S2's event-buffer optimization remains byte-for-byte.
  source = once(source, '                nexiIdentity.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message));\n', '');
  source = once(source, '                await decrypt();', `                await decrypt();
                nexiIdentity.observeDecrypted(msg, node, authState.creds, getHistoryMsg(msg.message));
                await nexiIngress.capture(config, msg, proto);`);
  return "import nexiIngress from '/evolution/nexi-ingress.cjs';\n" + source;
});
patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', source => {
  source = once(source, '  proto,', '  cleanMessage,\n  proto,');
  source = once(source, "    const nexiEventOwner = require('/evolution/nexi-groups.cjs').lifecycleCapture(this, nexiEventSocket);",
    `    const nexiEventOwner = require('/evolution/nexi-groups.cjs').lifecycleCapture(this, nexiEventSocket);
    ${helper}.register(this, (bytes, creds, transportKey) => {
      const message = proto.WebMessageInfo.decode(bytes);
      Object.assign(message.key, transportKey);
      cleanMessage(message, creds.me.id, creds.me.lid);
      return message;
    }, async message => this.messageHandle['messages.upsert']({ messages: [message], type: 'notify' }, await this.findSettings()));`);
  const start = source.indexOf("    'messages.upsert': async ("), end = source.indexOf("    'messages.update': async (", start);
  if (start < 0 || end <= start) throw new Error('Ingress handler boundary changed');
  let section = source.slice(start, end);
  section = once(section, '        for (const received of messages) {',
    `        for (const received of messages) {
          if (${helper}.skipSerial(received)) continue;`);
  section = once(section, "let trustedObservation = require('/evolution/nexi-identity.cjs').take(received, type, requestId);",
    `let trustedObservation = ${helper}.observation(this, received) || require('/evolution/nexi-identity.cjs').take(received, type, requestId);`);
  section = once(section, "() => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation));",
    `() => ${helper}.observed(this, () => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation)));`);
  section = once(section, "              this.logger.warn('nexi_identity_association_rejected');",
    `              if (${helper}.current(this)) throw new Error('nexi_ingress_identity_pending');
              this.logger.warn('nexi_identity_association_rejected');`);
  section = once(section, "'chatwoot_http', () => this.chatwootService.eventWhatsapp(",
    `'chatwoot_http', () => ${helper}.chatwoot(this, messageRaw, () => this.chatwootService.eventWhatsapp(`);
  section = once(section, '              messageRaw,\n            ));', '              messageRaw,\n            )));');
  // Even a previously confirmed association goes through reconciliation in
  // the worker. The legacy path keeps its S3 short circuit.
  section = once(section, 'const chatwootSentMessage = trustedAssociation?.message_id',
    `const chatwootSentMessage = !${helper}.current(this) && trustedAssociation?.message_id`);
  section = once(section, 'if (trustedAssociation && !trustedAssociation.message_id)',
    `if (trustedAssociation && (${helper}.current(this) || !trustedAssociation.message_id))`);
  section = once(section, `() => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation,
                      { ...trustedAssociation, message_id: chatwootSentMessage.id }));`,
    `() => ${helper}.correlated(this, { ...trustedAssociation, message_id: chatwootSentMessage.id },
                      () => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation,
                        { ...trustedAssociation, message_id: chatwootSentMessage.id })));`);
  section = once(section, "                  this.logger.warn('nexi_identity_correlation_rejected');",
    `                  if (${helper}.current(this)) throw new Error('nexi_ingress_correlation_pending');
                  this.logger.warn('nexi_identity_correlation_rejected');`);
  section = once(section, "          if (this.configService.get<Openai>('OPENAI').ENABLED && received?.message?.audioMessage) {",
    `          await ${helper}.beginContinuation(this);
          if (this.configService.get<Openai>('OPENAI').ENABLED && received?.message?.audioMessage) {`);
  section = once(section, "'message_persist', () => this.prismaRepository.message.create({ data: messageData }));",
    `'message_persist', () => ${helper}.persistMessage(this, messageData, () => this.prismaRepository.message.create({ data: messageData })));`);
  for (const [anchor, name] of [
    ['await this.client.requestPlaceholderResend(received.key)', 'placeholder_control'],
    ['await this.client.fetchMessageHistory(50, received.key, received.messageTimestamp!)', 'history_control'],
  ]) section = once(section, anchor, `await ${helper}.control(this, '${name}', () => ${anchor.slice(6)})`);
  // The two read controls have identical expressions but distinct predicates.
  const read = 'await this.client.readMessages([received.key]);';
  if (section.split(read).length !== 3) throw new Error('Ingress read-control anchors changed');
  section = section.replaceAll(read, `await ${helper}.control(this, 'read_control', () => this.client.readMessages([received.key]));`);
  section = once(section, "            require('/evolution/nexi-attendance.cjs').failInbound(nexiInboundSpan);",
    `            require('/evolution/nexi-attendance.cjs').failInbound(nexiInboundSpan);
            if (${helper}.current(this)) throw error;`);
  section = once(section, '      } catch (error) {\n        this.logger.error(error);',
    `      } catch (error) {
        if (${helper}.current(this)) throw error;
        this.logger.error(error);`);
  section = once(section, '            this.sendDataWebhook(Events.CHATS_UPSERT, [{ ...existingChat, name: received.pushName }]);',
    `            await ${helper}.control(this, 'chat_name_webhook',
              () => this.sendDataWebhook(Events.CHATS_UPSERT, [{ ...existingChat, name: received.pushName }]));`);
  // A recovered callback retains its exact captured socket. It cannot adopt a
  // replacement through the service's mutable client property after an await.
  section = section.replaceAll('this.client', `${helper}.socket(this)`);
  source = source.slice(0, start) + section + source.slice(end);
  return source;
});
patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', source => {
  source = once(source, '  private provider: any;', `  private nexiLegacyProvider: any;
  private get provider(): any {
    return ${helper}.inWorker() ? ${helper}.provider(this) : this.nexiLegacyProvider;
  }
  private set provider(value: any) {
    if (!${helper}.setProvider(this, value)) this.nexiLegacyProvider = value;
  }`);
  const messageStart = source.indexOf('  public async createMessage(');
  const messageEnd = source.indexOf('  public async getOpenConversationByContact(', messageStart);
  const mediaStart = source.indexOf('  private async sendData(');
  const mediaEnd = source.indexOf('  public async createBotQr(', mediaStart);
  if (messageStart < 0 || messageEnd <= messageStart || mediaStart < 0 || mediaEnd <= mediaStart)
    throw new Error('Ingress Chatwoot method boundaries changed');
  let message = source.slice(messageStart, messageEnd);
  message = once(message, '    const message = await client.messages.create({',
    `    const message = await ${helper}.cancellable(() => client.messages.create({`);
  message = once(message, '      data: messageData,\n    });', '      data: messageData,\n    }));');
  source = source.slice(0, messageStart) + message + source.slice(messageEnd);
  const updatedMediaStart = source.indexOf('  private async sendData(');
  const updatedMediaEnd = source.indexOf('  public async createBotQr(', updatedMediaStart);
  const media = once(source.slice(updatedMediaStart, updatedMediaEnd),
    '      maxBodyLength: Infinity,', '      maxBodyLength: Infinity,\n      timeout: 15000,');
  source = source.slice(0, updatedMediaStart) + media + source.slice(updatedMediaEnd);
  const quotedAnchor = `        if (quotedId)
          quotedMsg = await this.prismaRepository.message.findFirst({
            where: {`;
  source = once(source, quotedAnchor, quotedAnchor + '\n              instanceId: instance.instanceId,');
  return source;
});
patch('tsup.config.ts', source => once(source, "external: ['/evolution/nexi-attendance.cjs',",
  "external: ['/evolution/nexi-ingress.cjs', '/evolution/nexi-attendance.cjs',"));
const models = fs.readFileSync(path.join(root, 'ingress-models.prisma'), 'utf8');
for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) patch(`prisma/${provider}-schema.prisma`, source => {
  if (source.includes('model NexiIngressJournal')) throw new Error('Ingress schema already installed');
  return source + '\n' + models.replaceAll('JSON_TYPE', provider === 'mysql' ? '@db.Json' : '@db.JsonB')
    .replaceAll('LARGE_TEXT', provider === 'mysql' ? '@db.LongText' : '@db.Text');
});
for (const change of changes) {
  if (process.argv.includes('--snapshot')) {
    const target = path.join(root, '.ingress-upstream', change.file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, change.before);
  }
  fs.writeFileSync(change.target, change.after);
}
