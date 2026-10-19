({
  projection: {
    mode: 'local', selected: () => true,
    run: async ({ received, policy, tx }) => {
      const remoteJid = received.key.remoteJid;
      const chat = await tx.chat.findFirst({ where: { instanceId: this.instanceId, remoteJid } });
      if (!chat) return { not_applicable: true };
      const provider = this.configService.get<Database>('DATABASE').PROVIDER;
      const rows = provider === 'mysql'
        ? await tx.$queryRaw`SELECT COUNT(*) AS count FROM Message WHERE instanceId = ${this.instanceId}
            AND JSON_UNQUOTE(JSON_EXTRACT(\`key\`, '$.remoteJid')) = ${remoteJid}
            AND JSON_UNQUOTE(JSON_EXTRACT(\`key\`, '$.fromMe')) = 'false' AND status = ${status[3]}`
        : await tx.$queryRaw`SELECT COUNT(*)::int AS count FROM "Message" WHERE "instanceId" = ${this.instanceId}
            AND "key"->>'remoteJid' = ${remoteJid} AND ("key"->>'fromMe')::boolean = false AND status = ${status[3]}`;
      const publicName = require('/evolution/nexi-ingress-dispatch.cjs').current().claims.observation.contact_profile?.public_name;
      const name = policy.saveChats && publicName ? publicName : chat.name;
      await tx.chat.update({ where: { id: chat.id }, data: { name, unreadMessages: Number(rows[0]?.count || 0) } });
      return { completed: true };
    },
  },
  contact_projection: {
    mode: 'local', selected: policy => policy.saveContacts,
    run: async ({ received, tx }) => {
      const remoteJid = require('/evolution/nexi-ingress-dispatch.cjs').current().claims.observation.pn_jid;
      const contact = await tx.contact.findFirst({ where: { instanceId: this.instanceId, remoteJid } });
      const publicName = require('/evolution/nexi-ingress-dispatch.cjs').current().claims.observation.contact_profile?.public_name;
      const data = { remoteJid, instanceId: this.instanceId, pushName: publicName || contact?.pushName || '',
        ...(contact?.profilePicUrl ? { profilePicUrl: contact.profilePicUrl } : {}) };
      await tx.contact.upsert({ where: { remoteJid_instanceId: { remoteJid, instanceId: this.instanceId } }, create: data, update: data });
      return { completed: true };
    },
  },
  transcription: {
    mode: 'external', independent: true,
    selected: (policy, received) => policy.transcription && !!received.message?.audioMessage,
    run: async ({ received, guard }) => {
      const settings = await this.prismaRepository.openaiSetting.findFirst({ where: { instanceId: this.instanceId } });
      if (!settings?.openaiCredsId || !settings.speechToText) return { not_applicable: true };
      await guard();
      const text = await this.openaiService.speechToText(received, this);
      if (typeof text !== 'string' || !text.trim()) throw new Error('nexi_transcription_result_unconfirmed');
      return { speechToText: `[audio] ${text}` };
    },
  },
  media_archive: {
    mode: 'external', independent: true,
    selected: (policy, received) => policy.archive &&
      ['imageMessage', 'audioMessage', 'stickerMessage', 'documentMessage', 'documentWithCaptionMessage', 'ptvMessage', 'videoMessage']
        .some(type => received.message?.[type]) && (!received.message?.videoMessage || policy.archiveVideo),
    run: async ({ received, operationId, journalId, guard }) => {
      if (!this.hasValidMediaContent(received)) throw new Error('nexi_media_content_unavailable');
      await guard();
      const media = await this.getBase64FromMediaMessage({ message: received }, true);
      if (!media?.buffer || !media.fileName) throw new Error('nexi_media_download_unconfirmed');
      const mimetype = mimeTypes.lookup(media.fileName);
      if (!mimetype) throw new Error('nexi_media_mimetype_unavailable');
      // Fixed object identity, no timestamp/random suffix or new Message ID.
      const safeName = String(media.fileName).split(/[\\/]/).pop();
      const fullName = `${this.instanceId}/ingress/${journalId}/${operationId}/${safeName}`;
      await guard();
      const uploaded = await s3Service.uploadFile(fullName, media.buffer, media.buffer.length, { 'Content-Type': mimetype });
      // The legacy helper returns an Error object on failed PUT. Fulfilment
      // alone is NOT an upload acknowledgement.
      if (!uploaded || typeof uploaded.etag !== 'string') throw new Error('nexi_media_upload_unconfirmed');
      const mediaUrl = await s3Service.getObjectUrl(fullName);
      if (typeof mediaUrl !== 'string' || !mediaUrl) throw new Error('nexi_media_url_unconfirmed');
      return { media: { fileName: fullName, type: media.mediaType, mimetype }, mediaUrl };
    },
  },
  read_control: {
    mode: 'external', selected: policy => policy.readMessages,
    run: async ({ received, guard }) => {
      await guard();
      await require('/evolution/nexi-ingress.cjs').socket(this).readMessages([received.key]);
      return { transport_returned: true }; // Not a fabricated READ/DELIVERY receipt.
    },
  },
  placeholder_control: {
    mode: 'external', selected: (_policy, received) =>
      (received.message?.conversation || received.message?.extendedTextMessage?.text) === 'requestPlaceholder',
    run: async ({ received, guard }) => {
      await guard();
      const id = await require('/evolution/nexi-ingress.cjs').socket(this).requestPlaceholderResend(received.key);
      return { request_id: typeof id === 'string' ? id : null };
    },
  },
  history_control: {
    mode: 'external', selected: (_policy, received) =>
      (received.message?.conversation || received.message?.extendedTextMessage?.text) === 'onDemandHistSync',
    run: async ({ received, guard }) => {
      await guard();
      const id = await require('/evolution/nexi-ingress.cjs').socket(this).fetchMessageHistory(50, received.key, received.messageTimestamp);
      return { request_id: typeof id === 'string' ? id : null };
    },
  },
  message_webhook: {
    mode: 'dispatch', contractVersion: 2, independent: true, orderedTargets: true, selected: () => true,
    run: async ({ journalId, guard }) => {
      const dispatch = require('/evolution/nexi-ingress-dispatch.cjs'), ctx = dispatch.current();
      const message = await this.prismaRepository.message.findUnique({ where: { id: journalId } });
      if (!message || message.instanceId !== this.instanceId) throw new Error('nexi_ingress_message_missing');
      const observation = ctx.claims.observation;
      const body = { ...message, key: { ...(message.key as Record<string, unknown>), remoteJid: observation.pn_jid,
        remoteJidAlt: observation.lid_jid, addressingMode: 'pn' } };
      await guard();
      await this.sendDataWebhook(Events.MESSAGES_UPSERT, body);
      return dispatch.summary(ctx);
    },
  },
  chatbot: {
    mode: 'dispatch', contractVersion: 2, selected: () => true,
    run: async ({ journalId, guard }) => {
      const dispatch = require('/evolution/nexi-ingress-dispatch.cjs'), ctx = dispatch.current();
      const message = await this.prismaRepository.message.findUnique({ where: { id: journalId } });
      if (!message || message.instanceId !== this.instanceId) throw new Error('nexi_ingress_message_missing');
      const observation = ctx.claims.observation;
      const msg = { ...message, key: { ...(message.key as Record<string, unknown>), remoteJid: observation.pn_jid,
        remoteJidAlt: observation.lid_jid, addressingMode: 'pn' } };
      await guard();
      await chatbotController.emit({ instance: { instanceName: this.instance.name, instanceId: this.instanceId },
        remoteJid: observation.pn_jid, msg, pushName: observation.contact_profile?.public_name || '' });
      return dispatch.summary(ctx);
    },
  },
  contact_webhook: {
    mode: 'dispatch', contractVersion: 2, independent: true, orderedTargets: true, selected: () => true,
    run: async ({ policy, guard }) => {
      const dispatch = require('/evolution/nexi-ingress-dispatch.cjs'), ctx = dispatch.current();
      const observation = ctx.claims.observation;
      const body = { remoteJid: observation.pn_jid, pushName: observation.contact_profile?.public_name || '',
        ...(policy.contactPhoto ? { profilePicUrl: policy.contactPhoto } : {}), instanceId: this.instanceId };
      await guard();
      await this.sendDataWebhook(policy.contactExisted ? Events.CONTACTS_UPDATE : Events.CONTACTS_UPSERT, body);
      return dispatch.summary(ctx);
    },
  },
  contact_chatwoot: {
    mode: 'reconciled', contractVersion: 2, selected: policy => policy.chatwoot,
    run: async () => require('/evolution/nexi-ingress.cjs').contactSupplement(this),
  },
  chat_name_webhook: {
    mode: 'dispatch', contractVersion: 2, independent: true, orderedTargets: true, selected: policy => policy.saveChats && policy.chatNameChanged,
    run: async ({ policy, guard }) => {
      const dispatch = require('/evolution/nexi-ingress-dispatch.cjs'), ctx = dispatch.current();
      await guard();
      await this.sendDataWebhook(Events.CHATS_UPSERT, [{ ...policy.chatSnapshot,
        name: ctx.claims.observation.contact_profile?.public_name || policy.chatSnapshot.name }]);
      return dispatch.summary(ctx);
    },
  },
  contact_cache: {
    mode: 'local', contractVersion: 2, selected: policy => policy.cacheContacts,
    run: async ({ tx, policy }) => {
      const ctx = require('/evolution/nexi-ingress-dispatch.cjs').current(), row = ctx.parent;
      const { pn_jid, lid_jid } = ctx.claims.observation;
      const id = require('/evolution/nexi-canonical-json.cjs').digest([row.scopeId, row.sessionIdentity, pn_jid]);
      const data = { scopeId: row.scopeId, instanceId: row.instanceId, sessionIdentity: row.sessionIdentity,
        pnJid: pn_jid, lidJid: lid_jid || null, journalId: row.id, sequence: row.sequence,
        expiresAt: new Date(Date.now() + policy.cacheDays * 86400000) };
      const previous = await tx.nexiIngressContactCache.findUnique({ where: { id } });
      if (!previous || previous.sequence < row.sequence) await tx.nexiIngressContactCache.upsert({ where: { id }, create: { id, ...data }, update: data });
      return { cached: true, scope_id: row.scopeId };
    },
  },
})
