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
      const name = policy.saveChats && typeof received.pushName === 'string' && received.pushName.trim()
        ? received.pushName : chat.name;
      await tx.chat.update({ where: { id: chat.id }, data: { name, unreadMessages: Number(rows[0]?.count || 0) } });
      return { completed: true };
    },
  },
  contact_projection: {
    mode: 'local', selected: policy => policy.saveContacts,
    run: async ({ received, tx }) => {
      const remoteJid = received.key.remoteJid;
      const contact = await tx.contact.findFirst({ where: { instanceId: this.instanceId, remoteJid } });
      const data = { remoteJid, instanceId: this.instanceId, pushName: received.pushName || '',
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
  // These dispatchers swallow failure, retry internally or detach promises.
  // There is no safe automatic execution/completion/reconciliation contract.
  // Persist the intent and block this family, without dispatch or main-lane
  // ownership. A later adapter must explicitly reconcile/authorize recovery.
  message_webhook: { mode: 'blocked', selected: () => true },
  chatbot: { mode: 'blocked', selected: () => true },
  contact_webhook: { mode: 'blocked', selected: () => true },
  contact_chatwoot: { mode: 'blocked', selected: policy => policy.chatwoot },
  chat_name_webhook: { mode: 'blocked', selected: policy => policy.saveChats },
  contact_cache: { mode: 'blocked', selected: () => true },
})
