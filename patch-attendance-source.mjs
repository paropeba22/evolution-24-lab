import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function once(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Attendance pinned anchor: expected 1, found ${count}: ${anchor.slice(0, 96)}`);
  return source.replace(anchor, () => replacement);
}
export function patchAttendanceInboundBatch(source) {
  const start = source.indexOf("    'messages.upsert': async (");
  const end = source.indexOf("    'messages.update': async (", start);
  if (start < 0 || end <= start) throw new Error('Attendance inbound batch boundary changed');
  let section = source.slice(start, end);
  const loop = '        for (const received of messages) {\n';
  const tail = `        }
      } catch (error) {
        this.logger.error(error);
      }
    },

`;
  // This is applied after the pinned financial/identity and Groups patches.
  // Keep every per-message filter/capability inside the same iteration. An
  // unrelated persistence/cache failure must not consume the remaining batch.
  section = once(section, loop, loop +
    `          const nexiInboundSpan = require('/evolution/nexi-attendance.cjs').beginInbound(this, received);\n          try {\n`);
  section = once(section, tail, `          } catch (error) {
            require('/evolution/nexi-attendance.cjs').failInbound(nexiInboundSpan);
            if (!this.instance.name.startsWith('nexi-wa-')) throw error;
            this.logger.warn(JSON.stringify({ event: 'nexi_inbound_item_failed', instance_id: this.instanceId,
              ref: nexiInboundSpan?.ref || null }));
          } finally {
            require('/evolution/nexi-attendance.cjs').endInbound(nexiInboundSpan);
          }
` + tail);
  const timed = "require('/evolution/nexi-attendance.cjs').timedInbound";
  section = once(section, '          const existingChat = await this.prismaRepository.chat.findFirst({',
    `          const existingChat = await ${timed}(nexiInboundSpan, 'chat_lookup', () => this.prismaRepository.chat.findFirst({`);
  section = once(section, '            select: { id: true, name: true },\n          });',
    '            select: { id: true, name: true },\n          }));');
  section = once(section, '              trustedObservation = await require(\'/evolution/nexi-identity.cjs\').contactProfile(this, trustedObservation);',
    `              trustedObservation = await ${timed}(nexiInboundSpan, 'identity_profile',
                () => require('/evolution/nexi-identity.cjs').contactProfile(this, trustedObservation));`);
  section = once(section, '              trustedAssociation = await require(\'/evolution/nexi-identity.cjs\').managedObservation(this, trustedObservation);',
    `              trustedAssociation = await ${timed}(nexiInboundSpan, 'identity_observation',
                () => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation));`);
  section = once(section, '              : await this.chatwootService.eventWhatsapp(',
    `              : await ${timed}(nexiInboundSpan, 'chatwoot_http', () => this.chatwootService.eventWhatsapp(`);
  section = once(section, '              messageRaw,\n            );', '              messageRaw,\n            ));');
  section = once(section, `                  await require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation,
                    { ...trustedAssociation, message_id: chatwootSentMessage.id });`,
    `                  await ${timed}(nexiInboundSpan, 'identity_correlation',
                    () => require('/evolution/nexi-identity.cjs').managedObservation(this, trustedObservation,
                      { ...trustedAssociation, message_id: chatwootSentMessage.id }));`);
  section = once(section, '            const msg = await this.prismaRepository.message.create({ data: messageData });',
    `            const msg = await ${timed}(nexiInboundSpan, 'message_persist', () => this.prismaRepository.message.create({ data: messageData }));`);
  section = once(section, '            profilePicUrl: (await this.profilePicture(received.key.remoteJid)).profilePictureUrl,',
    `            profilePicUrl: (await ${timed}(nexiInboundSpan, 'profile_picture', () => this.profilePicture(received.key.remoteJid))).profilePictureUrl,`);
  section = once(section, '          await chatbotController.emit({',
    `          await ${timed}(nexiInboundSpan, 'chatbot_emit', () => chatbotController.emit({`);
  section = once(section, '            pushName: messageRaw.pushName,\n          });',
    '            pushName: messageRaw.pushName,\n          }));');
  // These upstream media skips are after the Chatwoot persistence/ACK path.
  // Neither an exception nor a media skip retries any attempted message/send.
  for (const anchor of [
    "                    // Skip video upload by returning early from this block\n                    return;",
    "                      this.logger.verbose('No valid media to upload (messageContextInfo only), skipping MinIO');\n                      return;",
  ]) {
    section = once(section, anchor, anchor.replace('return;',
      "if (this.instance.name.startsWith('nexi-wa-')) continue;\n" +
      (anchor.includes('// Skip video') ? '                    ' : '                      ') + 'return;'));
  }
  return source.slice(0, start) + section + source.slice(end);
}
export function patchAttendanceEventQueue(source) {
  source = once(source, `    this.client.ev.process(async (events) => {
      if (!require('/evolution/nexi-groups.cjs').lifecycleCurrent(nexiEventOwner)) return;
      this.eventProcessingQueue = this.eventProcessingQueue.then(async () => {
        try {`,
    `    this.client.ev.process(async (events) => {
      if (!require('/evolution/nexi-groups.cjs').lifecycleCurrent(nexiEventOwner)) return;
      require('/evolution/nexi-attendance.cjs').queueEnqueued(this, events);
      this.eventProcessingQueue = this.eventProcessingQueue.then(async () => {
        const nexiQueueSpan = require('/evolution/nexi-attendance.cjs').queueStarted(this, events);
        let nexiQueueFailed = false;
        try {`);
  source = once(source,
    "            events = await require('/evolution/nexi-groups.cjs').interceptEvents(this, events);",
    `            events = await require('/evolution/nexi-attendance.cjs').timedInbound(nexiQueueSpan,
              'groups_intercept', () => require('/evolution/nexi-groups.cjs').interceptEvents(this, events));`);
  source = once(source,
    "            const settings = await require('/evolution/nexi-groups.cjs').lifecycleAwait(nexiEventOwner, () => this.findSettings());",
    `            const settings = await require('/evolution/nexi-attendance.cjs').timedInbound(nexiQueueSpan,
              'settings_lookup', () => require('/evolution/nexi-groups.cjs').lifecycleAwait(nexiEventOwner, () => this.findSettings()));`);
  source = once(source, "              await this.messageHandle['messaging-history.set'](payload);",
    `              await require('/evolution/nexi-attendance.cjs').timedInbound(nexiQueueSpan,
                'history_handler', () => this.messageHandle['messaging-history.set'](payload));`);
  source = once(source, "              await this.messageHandle['messages.upsert'](payload, settings);",
    `              await require('/evolution/nexi-attendance.cjs').timedInbound(nexiQueueSpan,
                'upsert_handler', () => this.messageHandle['messages.upsert'](payload, settings));`);
  return once(source, `        } catch (error) {
          this.logger.error(error);
        }
      });
    });
  }

  private historySyncNotification`,
    `        } catch (error) {
          nexiQueueFailed = true;
          this.logger.error(error);
        } finally {
          require('/evolution/nexi-attendance.cjs').queueEnded(nexiQueueSpan, nexiQueueFailed);
        }
      });
    });
  }

  private historySyncNotification`);
}
export function patchAttendanceSendNode(source) {
  source = once(source, '    const sendNode = (frame) => {',
    `    const sendNode = async (frame) => {
        const nexiFrame = nexiAttendance.snapshotFrame(config, frame);
        await nexiAttendance.assertNode(config, nexiFrame);`);
  source = once(source, "            logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' });",
    "            logger.trace({ xml: binaryNodeToString(nexiFrame), msg: 'xml send' });");
  return once(source, '        const buff = encodeBinaryNode(frame);', '        const buff = encodeBinaryNode(nexiFrame);');
}
export function patchAttendanceContactLookup(source) {
  // clientCw returns ChatwootClient, not an Axios instance. Use the same
  // account-scoped SDK request helper already used by findContact/mergeContacts.
  source = once(source, `    const contact = (await (client as any).get('contacts/search', {
      params: {
        q: identifier,
        sort: 'name',
      },
    })) as any;`, `    // Optional LID fallback: 2.5 s deadline per query; GET + POST HTTP budget is 5 s.
    const nexiLidTimeoutMs = 2500;
    const nexiLidRequest = async (options: Parameters<typeof chatwootRequest>[1]) => {
      const request = chatwootRequest(this.getClientCwConfig(), options);
      // Keep the original CancelablePromise: then/finally return plain Promises.
      // SDK 1.1.17 cancel() signals Axios 0.27.2 CancelToken and aborts its request.
      const timer = setTimeout(() => request.cancel(), nexiLidTimeoutMs);
      try {
        return await request;
      } finally {
        clearTimeout(timer);
      }
    };
    const contact = (await nexiLidRequest({
      method: 'GET',
      url: \`/api/v1/accounts/\${this.provider.accountId}/contacts/search\`,
      query: {
        q: identifier,
        sort: 'name',
      },
    })) as any;`);
  return once(source, `    const contactByAttr = (await (client as any).post('contacts/filter', {
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
          query_operator: null,
        },
      ],
    })) as any;`, `    const contactByAttr = (await nexiLidRequest({
      method: 'POST',
      url: \`/api/v1/accounts/\${this.provider.accountId}/contacts/filter\`,
      body: {
        payload: [
          {
            attribute_key: 'identifier',
            filter_operator: 'equal_to',
            values: [identifier],
            query_operator: null,
          },
        ],
      },
    })) as any;`);
}
export function patchAttendanceTsupConfig(source) {
  source = once(source, "import { cpSync } from 'node:fs';", "import { cpSync, readFileSync } from 'node:fs';");
  source = once(source, "external: ['/evolution/nexi-groups.cjs', 'baileys',",
    "external: ['/evolution/nexi-attendance.cjs', '/evolution/nexi-groups.cjs', 'baileys',");
  return once(source, '  noExternal: [/^@prisma\\/client$/],',
    `  noExternal: [/^@prisma\\/client$/, /^@prisma\\/adapter-mariadb$/, /^mariadb$/],
  // check-node.js reads engines.node at module scope, even for PostgreSQL.
  // Keep upstream's JSON asset loader everywhere except this runtime metadata.
  esbuildPlugins: [{
    name: 'nexi-mariadb-runtime-metadata',
    setup(build) {
      build.onLoad({ filter: /[\\\\/]node_modules[\\\\/]mariadb[\\\\/]package\\.json$/, namespace: 'file' }, args => ({
        contents: readFileSync(args.path, 'utf8'),
        loader: 'json',
      }));
    },
  }],`);
}
// Keep the exact pinned observation points; require real crypto and diagnose absence.
export function patchAttendanceAccountObservation(source) {
  if (source.includes('nexiAttendance.observePublicAccount(')) throw new Error('Attendance account observation already installed');
  const observer = `    const nexiObserveAccount = (provenance) => {
        void nexiAttendance.observePublicAccount(config, authState.creds, nexiAttendance.verifyPublicAccountSignature,
            details => proto.ADVDeviceIdentity.decode(details).deviceType === proto.ADVEncryptionType.HOSTED
                ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX, provenance);
    };\n`;
  source = once(source, '    // device paired for the first time', observer + '    // device paired for the first time');
  // creds.update may not mutate the original object synchronously. Verify a
  // bounded merged public view after pinned pairing verified account signature.
  source = once(source, "            ev.emit('creds.update', updatedCreds);", `            ev.emit('creds.update', updatedCreds);
            void nexiAttendance.observePublicAccount(config, { ...creds, ...updatedCreds }, nexiAttendance.verifyPublicAccountSignature,
                details => proto.ADVDeviceIdentity.decode(details).deviceType === proto.ADVEncryptionType.HOSTED
                    ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX, 'verified_pairing');`);
  return once(source, "    ws.on('CB:success', async (node) => {\n        try {",
    "    ws.on('CB:success', async (node) => {\n        try {\n            nexiObserveAccount('verified_restored_account');");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const root = process.argv[2] || '/evolution';
const changes = [];
const helper = "require('/evolution/nexi-attendance.cjs')";
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
  source = patchAttendanceInboundBatch(source);
  source = patchAttendanceEventQueue(source);
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
  source = once(source, "                await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');",
    "                nexiAttendance.observeInbound(config, msg);\n                await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');");
  return once(source, '            msgs.push(msg);',
    '            msg = await nexiAttendance.retryMessage(config, { ...key, id }, msg);\n            msgs.push(msg);');
});
patch('node_modules/baileys/lib/Socket/chats.js', source => {
  source = "import nexiAttendance from '/evolution/nexi-attendance.cjs';\n" + source;
  return once(source, "        ev.emit('messages.upsert', { messages: [msg], type });",
    "        nexiAttendance.enqueueInbound(config, msg);\n        ev.emit('messages.upsert', { messages: [msg], type });");
});
patch('node_modules/baileys/lib/Socket/messages-send.js', source => {
  source = "import nexiAttendance from '/evolution/nexi-attendance.cjs';\nimport Long from 'long';\n" + source;
  source = once(source, '        const msgId = await relayMessage(meJid, protocolMessage, {',
    '        const nexiInternalMessage = nexiAttendance.markInternalControl(config, protocolMessage, meJid);\n        const msgId = await relayMessage(meJid, nexiInternalMessage, {');
  source = once(source,
    '    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {',
    `    const relayMessage = async (jid, message, options) => {
        const nexiEncoding = nexiAttendance.beginRelay(config, jid, message, options, proto, Long.prototype);
        message = nexiEncoding.message;
        let { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList } = nexiEncoding.options;`);
  source = once(source, '    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {',
    `    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage, nexiEncoding) => {
        const nexiRoot = nexiEncoding?.message || nexiAttendance.beginRelay(config, '', message, {}, proto, Long.prototype).message;
        message = nexiAttendance.encodingInput(nexiRoot, message);
        recipientJids = nexiAttendance.encodingInput(nexiRoot, recipientJids);
        extraAttrs = nexiAttendance.encodingInput(nexiRoot, extraAttrs);
        dsmMessage = nexiAttendance.encodingInput(nexiRoot, dsmMessage);`);
  source = once(source, '        const patched = await patchMessageBeforeSending(message, recipientJids);',
    '        const patched = await nexiAttendance.patchEncoding(config, nexiRoot, message, recipientJids, patchMessageBeforeSending);');
  source = once(source, '                const bytes = encodeWAMessage(msgToEncrypt);',
    '                const bytes = nexiAttendance.encodeMessage(config, nexiRoot, msgToEncrypt, encodeWAMessage);');
  source = once(source, '                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message;',
    '                const patched = patchMessageBeforeSending ? await nexiAttendance.patchEncoding(config, message, message, [], patchMessageBeforeSending) : message;');
  source = once(source, '                const bytes = encodeNewsletterMessage(patched);',
    '                const bytes = nexiAttendance.encodeMessage(config, message, patched, encodeNewsletterMessage);');
  source = once(source, '                const patched = await patchMessageBeforeSending(message);',
    '                const patched = await nexiAttendance.patchEncoding(config, message, message, undefined, patchMessageBeforeSending);');
  source = once(source, '                const bytes = encodeWAMessage(patched);',
    '                const bytes = nexiAttendance.encodeMessage(config, message, patched, encodeWAMessage);');
  source = once(source, '                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs);',
    '                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs, undefined, nexiEncoding);');
  source = once(source, '                    const patchedForReporting = await patchMessageBeforeSending(message, [jid]);',
    '                    const patchedForReporting = await nexiAttendance.patchEncoding(config, message, message, [jid], patchMessageBeforeSending);');
  source = once(source, '                    createParticipantNodes(meRecipients, meMsg || message, extraAttrs),',
    '                    createParticipantNodes(meRecipients, meMsg || message, extraAttrs, undefined, nexiEncoding),');
  source = once(source, '                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)',
    '                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsg, nexiEncoding)');
  source = once(source, `                const encodedMessageToSend = isMe
                    ? encodeWAMessage({
                        deviceSentMessage: {
                            destinationJid,
                            message: messageToSend
                        }
                    })
                    : encodeWAMessage(messageToSend);`,
    `                const encodedMessageToSend = nexiAttendance.encodeMessage(config, message, isMe
                    ? { deviceSentMessage: { destinationJid, message: messageToSend } }
                    : messageToSend, encodeWAMessage);`);
  source = once(source, '                    const encoded = encodeWAMessage(reportingMessage);',
    '                    const encoded = nexiAttendance.encodeMessage(config, message, reportingMessage, encodeWAMessage);');
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
  source = patchAttendanceSendNode(source);
  // Exported raw bytes are a separate surface. Internal handshake/noise calls
  // retain their lexical sendRawMessage and cannot be forged through attributes.
  source = once(source, '        sendRawMessage,\n        sendNode,',
    `        sendRawMessage: data => {
            nexiAttendance.externalRaw(config);
            return sendRawMessage(data);
        },
        sendNode,`);
  return patchAttendanceAccountObservation(source);
});
patch('src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts', source => {
  source = patchAttendanceContactLookup(source);
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
patch('tsup.config.ts', patchAttendanceTsupConfig);
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
}
