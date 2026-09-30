import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/evolution';
const verifyOnly = process.argv.includes('--verify');

function patch(file, transform) {
  const target = path.join(root, file);
  const before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  const after = transform(before);
  if (before === after) throw new Error(`${file}: no financial delivery change`);
  if (!verifyOnly) fs.writeFileSync(target, after);
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
  source = replaceOnce(source,
    "          for (const button of buttons) {",
    `          const cta = body.key.fromMe && buttons.find(
            (button) => button.name === 'cta_copy' || button.name === 'cta_url',
          );
          if (cta) {
            const content = cta.name === 'cta_copy'
              ? 'PIX da fatura enviado ao cliente'
              : 'Fatura enviada ao cliente';
            return await this.createMessage(
              instance, getConversation, content, 'outgoing', false, [], body,
              'WAID:' + body.key.id, quotedMsg,
            );
          }

          for (const button of buttons) {`,
    'CTA history mapping');
  return source;
});

console.log(`[evolution-24-lab] financial CTA source ${verifyOnly ? 'verified' : 'patched'}`);
