import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2] || '/evolution';
const verifyOnly = process.argv.includes('--verify');
const snapshot = process.argv.includes('--snapshot');
const revision = 'e273b904d53f5726970fd6a244ed9caa61dfeb9a';
const hashes = {
  'src/validate/message.schema.ts': '32c39bf02b7687000fd6ffb0aba23c4f301de3f46e651a020e6caffad85fc57c',
  'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts': '83860d7672f70e7603eb89ce4a797c9243f8c5595e0634713684b3d7241b3c7d',
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts': 'e9249cd2783b8ad1d7e88c238b3fe506ea39aa427696288db0488e7e4d993e5d',
};
const changes = [];

function patch(file, transform) {
  const target = path.join(root, file);
  const before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  if (createHash('sha256').update(before).digest('hex') !== hashes[file]) throw new Error(`${file}: pinned source digest changed`);
  const after = transform(before);
  if (before === after) throw new Error(`${file}: no financial delivery change`);
  changes.push({ file, target, before, after });
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`${label}: pinned source changed`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

patch('src/validate/message.schema.ts', (source) => {
  const marker = 'export const buttonsMessageSchema: JSONSchema7 = {';
  const start = source.indexOf(marker);
  const end = source.indexOf('export const carouselMessageSchema:', start);
  if (start < 0 || end < 0) throw new Error('sendButtons schema boundary changed');
  const section = source.slice(start, end);
  const corrected = replaceOnce(section, "          url: { type: 'string' },\n          phoneNumber:",
    "          url: { type: 'string' },\n          copyCode: { type: 'string' },\n          phoneNumber:", 'copyCode schema');
  const recipientSchema = replaceOnce(corrected, "    number: { ...numberDefinition },",
    "    number: { ...numberDefinition },\n    nexiRecipient: { type: 'object', properties: { claims: { type: 'string' }, signature: { type: 'string' } }, required: ['claims', 'signature'], additionalProperties: false },", 'recipient schema');
  return source.slice(0, start) + recipientSchema + source.slice(end);
});

patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', (input) => {
  let source = input;
  const identity = "require('/evolution/nexi-identity.cjs')";
  source = replaceOnce(source, '    const isLid = body.key.addressingMode',
    `    const trustedAssociation = ${identity}.associationFor(body);
    if (instance.instanceName.startsWith('nexi-wa-') && !body.key.fromMe) {
      if (!trustedAssociation || String(trustedAssociation.account_id) !== String(this.provider.accountId) ||
          String(trustedAssociation.inbox_id) !== String(this.provider.inboxId)) return null;
      // The authenticated reservation response validates ContactInbox and the
      // database/display IDs in Rails. Generic conversation JSON omits CI ID.
      return trustedAssociation.conversation_display_id;
    }
    const isLid = body.key.addressingMode`, 'managed inbound association');
  // Every cache-return branch re-enters the live validation above for managed
  // inbound. Managed own messages cannot establish evidence; reject an Inbox
  // mismatch even for those legacy cache branches.
  source = replaceOnce(source, '        return conversationId;\n      }',
    `        if (instance.instanceName.startsWith('nexi-wa-') &&
            (String(conversationExists.inbox_id) !== String(this.provider.inboxId) ||
             !conversationExists.contact_inbox_id)) return null;
        return conversationId;
      }`, 'cached Inbox veto');
  const conversationStart = source.indexOf('  public async createConversation(');
  const conversationEnd = source.indexOf('  public async getInbox(', conversationStart);
  let conversation = source.slice(conversationStart, conversationEnd);
  conversation = conversation.replaceAll('return conversationId;',
    "return instance.instanceName.startsWith('nexi-wa-') ? null : conversationId;");
  conversation = conversation.replaceAll('return (await this.cache.get(cacheKey)) as number;',
    "return instance.instanceName.startsWith('nexi-wa-') ? null : (await this.cache.get(cacheKey)) as number;");
  source = source.slice(0, conversationStart) + conversation + source.slice(conversationEnd);
  source = replaceOnce(source,
    "      if (body?.key?.remoteJid && body.key.remoteJid.includes('@lid') && !body.key.remoteJid.endsWith('@g.us')) {",
    `      if (!${identity}.associationFor(body) && body?.key?.remoteJid && body.key.remoteJid.includes('@lid') && !body.key.remoteJid.endsWith('@g.us')) {`,
    'trusted inbound bypasses heuristic LID cache');
  source = replaceOnce(source,
    "this.logger.info(`[${event}] New message received - Instance: ${JSON.stringify(body, null, 2)}`);",
    "this.logger.info({ event, instanceName: instance.instanceName, messageId: body?.key?.id, fromMe: body?.key?.fromMe, messageType: body?.messageType });",
    'eventWhatsapp payload log');
  source = replaceOnce(source,
    "this.logger.info('is Interactive Button Message: ' + JSON.stringify(buttons));",
    "this.logger.info({ event: 'interactive_button', instanceName: instance.instanceName, messageId: body?.key?.id, buttonTypes: buttons.map((button) => button.name) });",
    'interactive payload log');
  source = replaceOnce(source,
    "this.logger.error(`Error in createConversation: ${error}`);",
    "this.logger.error('Error in createConversation');",
    'conversation error log');
  source = replaceOnce(source,
    "    } catch (error) {\n      this.logger.error(error);\n    }\n  }\n\n  public normalizeJidIdentifier",
    "    } catch (error) {\n      this.logger.error('Chatwoot event processing failed');\n    }\n  }\n\n  public normalizeJidIdentifier",
    'event error log');
  source = replaceOnce(source,
    "        const getConversation = await this.createConversation(instance, body);",
    `        // NEXI owns the exact conversation correlation for managed outbound CTAs.
        // Its Rails reconciliation writes WAID:<id> after Evolution accepts the send.
        const managedCta = instance.instanceName.startsWith('nexi-wa-') && body.key.fromMe &&
          isInteractiveButtonMessage &&
          body.message?.interactiveMessage?.nativeFlowMessage?.buttons?.some(
            (button) => button.name === 'cta_copy' || button.name === 'cta_url',
          );
        if (managedCta) return;

        const getConversation = await this.createConversation(instance, body);`,
    'managed conversation guard');
  return source;
});

patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', (input) => {
  const start = input.indexOf('  private async sendMessageWithTyping<T = proto.IMessage>(');
  const end = input.indexOf('  // Instance Controller', start);
  if (start < 0 || end < 0) throw new Error('sendMessageWithTyping boundary changed');
  const helper = "require('/evolution/nexi-financial-transport.cjs')";
  let section = input.slice(start, end);
  section = replaceOnce(section,
    '    const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();',
    `    const managedFinancial = ${helper}.isManagedCta(this.instance.name, message) || ${helper}.managedLookup(this.instance.name);
    let financialStage = 'lookup';
    let financialMessageId: string = null;
    const isWA = (await this.whatsappNumber({ numbers: [managedFinancial ? ${helper}.resolutionInput(this.instance.name, number, this.instanceId) : number] }))?.shift();`, 'financial exception boundary');
  section = replaceOnce(section, '      let messageSent: WAMessage;',
    "      financialStage = 'dispatch';\n      let messageSent: WAMessage;", 'dispatch stage');
  section = replaceOnce(section, '      const messageRaw = this.prepareMessage(messageSent) as any;',
    `      financialMessageId = messageSent?.key?.id;
      financialStage = 'persistence';
      const messageRaw = this.prepareMessage(messageSent) as any;
      // PIX/financial URLs live only in the in-memory transport message.
      if (managedFinancial) messageRaw.message = { conversation: 'NEXI financial delivery' };`, 'persistence stage');
  section = replaceOnce(section,
    "      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration)",
    "      if (!managedFinancial && this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration)",
    'managed history ownership');
  section = replaceOnce(section, '      this.logger.verbose(messageSent);',
    `      financialStage = 'webhook';
      if (!managedFinancial) this.logger.verbose(messageSent);`, 'financial success log');
  section = replaceOnce(section, '      return messageRaw;',
    `      financialStage = 'response';
      // Managed API responses need correlation only, never the CTA secret.
      return managedFinancial ? { key: { id: financialMessageId, fromMe: true } } : messageRaw;`, 'financial response');
  section = replaceOnce(section,
    '    } catch (error) {\n      this.logger.error(error);\n      throw new BadRequestException(error.toString());',
    `    } catch (error) {
      if (managedFinancial) {
        this.logger.error(${helper}.failureMetadata(this.instanceId, financialMessageId, financialStage, error));
        throw new BadRequestException('nexi_financial_transport_failed');
      }
      this.logger.error(error);
      throw new BadRequestException(error.toString());`, 'financial exception redaction');
  section = replaceOnce(section, '    const sender = isWA.jid.toLowerCase();',
    `    ${helper}.assertRecipient(this.instance.name, message, isWA?.jid, this.instanceId);
    const sender = isWA.jid.toLowerCase();`, 'exact resolved recipient');
  section = replaceOnce(section, '    this.logger.verbose(`Sending message to ${sender}`);',
    "    if (!managedFinancial) this.logger.verbose(`Sending message to ${sender}`);", 'recipient log redaction');
  let source = input.slice(0, start) + section + input.slice(end);
  source = replaceOnce(source, '    this.client = makeWASocket(socketConfig);',
    `    this.client = makeWASocket(${helper}.socketConfig(this.instance.name, socketConfig));`,
    'runtime-owned managed retry scope');
  source = replaceOnce(source, '      getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,',
    `      getMessage: async (key) => ${helper}.retryMessage(this.instance.name, await this.getMessage(key), key) as Promise<proto.IMessage>,`,
    'managed financial messages never supply native receipt retries');
  const lookupStart = source.indexOf('  public async whatsappNumber(');
  const lookupEnd = source.indexOf('  public async markMessageAsRead(', lookupStart);
  let lookup = source.slice(lookupStart, lookupEnd);
  lookup = replaceOnce(lookup, '          this.logger.verbose(`Number ${user.number} found in cache`);',
    `          if (!${helper}.managedLookup(this.instance.name)) this.logger.verbose('Number found in cache');`, 'cache recipient redaction');
  lookup = replaceOnce(lookup, '    if (numbersToCache.length > 0) {',
    `    if (numbersToCache.length > 0 && !${helper}.managedLookup(this.instance.name)) {`, 'financial resolver never expands cache aliases');
  source = source.slice(0, lookupStart) + lookup + source.slice(lookupEnd);
  source = replaceOnce(source, '  public async buttonMessage(data: SendButtonsDto) {',
    `  public async buttonMessage(data: SendButtonsDto) {
    try {
      return await ${helper}.withRecipient(this, data, () => this.buttonMessagePrepared(data));
    } catch (error) {
      if (this.instance.name.startsWith('nexi-wa-')) throw new BadRequestException('nexi_financial_transport_failed');
      throw error;
    }
  }

  private async buttonMessagePrepared(data: SendButtonsDto) {`, 'signed backend recipient');
  source = replaceOnce(source, '      const id = await this.client.relayMessage(sender, message, {',
    `      await ${helper}.beginRelay(this.instance.name, message, sender, this.instanceId);
      const id = await this.client.relayMessage(sender, message, {`, 'pre relay exact recipient');
  source = replaceOnce(source,
    '        for (const received of messages) {',
    `        for (const received of messages) {
          // Outgoing CTA echoes may arrive asynchronously with the full secret.
          // The send path already owns persistence and Rails owns CW history.
          if (received.key?.fromMe && ${helper}.isManagedCta(this.instance.name, received.message)) continue;
          const trustedObservation = require('/evolution/nexi-identity.cjs').take(received, type, requestId);`,
    'managed CTA asynchronous echo redaction');
  source = replaceOnce(source, '          const messageRaw = this.prepareMessage(received) as any;',
    `          const messageRaw = this.prepareMessage(received) as any;
          let trustedAssociation: any = null;
          if (this.instance.name.startsWith('nexi-wa-') && trustedObservation && this.localChatwoot?.enabled) {
            try {
              trustedAssociation = await require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation);
              require('/evolution/nexi-identity.cjs').bind(messageRaw, trustedAssociation);
            } catch {
              this.logger.warn('nexi_identity_association_rejected');
            }
          }`, 'raw observation before normalization');
  source = replaceOnce(source, '              messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;',
    `              messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;
              if (trustedAssociation && !trustedAssociation.message_id) {
                try {
                  await require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation,
                    { ...trustedAssociation, message_id: chatwootSentMessage.id });
                } catch {
                  this.logger.warn('nexi_identity_correlation_rejected');
                }
              }`, 'Chatwoot ACK identity correlation');
  source = replaceOnce(source, '            const chatwootSentMessage = await this.chatwootService.eventWhatsapp(',
    `            const chatwootSentMessage = trustedAssociation?.message_id
              ? { id: trustedAssociation.message_id, inbox_id: trustedAssociation.inbox_id,
                  conversation_id: trustedAssociation.conversation_display_id }
              : await this.chatwootService.eventWhatsapp(`, 'duplicate inbound does not repeat CW history');
  return source;
});

// Validate every file before any write. Docker retains these exact pristine
// bytes for mandatory tests, rather than attempting to patch patched source.
if (!verifyOnly) {
  for (const change of changes) {
    if (snapshot) {
      const target = path.join(root, '.financial-upstream', change.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, change.before);
    }
    fs.writeFileSync(change.target, change.after);
  }
  if (snapshot) fs.writeFileSync(path.join(root, '.financial-upstream', 'REVISION'), revision);
}

console.log(`[evolution-24-lab] financial CTA source ${verifyOnly ? 'verified' : 'patched'}`);
