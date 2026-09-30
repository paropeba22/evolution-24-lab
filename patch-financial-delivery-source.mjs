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
  return source.slice(0, start) + corrected + source.slice(end);
});

patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', (input) => {
  let source = input;
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
    `    const managedFinancial = ${helper}.isManagedCta(this.instance.name, message);
    let financialStage = 'lookup';
    let financialMessageId: string = null;
    const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();`, 'financial exception boundary');
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
  let source = input.slice(0, start) + section + input.slice(end);
  source = replaceOnce(source,
    '        for (const received of messages) {',
    `        for (const received of messages) {
          // Outgoing CTA echoes may arrive asynchronously with the full secret.
          // The send path already owns persistence and Rails owns CW history.
          if (received.key?.fromMe && ${helper}.isManagedCta(this.instance.name, received.message)) continue;`,
    'managed CTA asynchronous echo redaction');
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
