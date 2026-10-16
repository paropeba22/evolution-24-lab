import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] || '/evolution';
const helper = "require('/evolution/nexi-ingress-dispatch.cjs')";
const changes = [];
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`R2 pinned anchor changed: ${anchor.slice(0, 90)}`);
  return source.replace(anchor, () => replacement);
}
function patch(file, transform) {
  const target = path.join(root, file), before = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  changes.push({ file, target, before, after: transform(before) });
}
patch('tsup.config.ts', source => once(source, "external: ['/evolution/nexi-ingress.cjs',",
  "external: ['/evolution/nexi-ingress-dispatch.cjs', '/evolution/nexi-ingress.cjs',"));
patch('src/api/integrations/event/event.manager.ts', source => {
  source = once(source, '    await this.websocket.emit(eventData);',
    `    if (${helper}.current()) { await this.emitIngress(eventData); return; }
    await this.websocket.emit(eventData);`);
  // Callers which intentionally ignore this Promise are registered in the
  // enclosing destination scope and drained before its result is recorded.
  source = once(source, '  public async emit(eventData: {', '  public emit(eventData: {');
  source = once(source, '  }): Promise<void> {', `  }): Promise<void> {
    return ${helper}.track(async () => {`);
  source = once(source, '    await this.kafka.emit(eventData);\n  }', '    await this.kafka.emit(eventData);\n    });\n  }');
  return once(source, '  public async setInstance(', fs.readFileSync(path.join(root, 'ingress-event-adapters.ts.inc'), 'utf8') + '\n  public async setInstance(');
});
patch('src/api/services/channel.service.ts', source => {
  source = once(source, '  public async sendDataWebhook<T extends object = any>(', '  public sendDataWebhook<T extends object = any>(');
  source = once(source, '    const serverUrl = this.configService.get<HttpServer>(\'SERVER\').URL;',
    `    return ${helper}.track(async () => {
    const serverUrl = this.configService.get<HttpServer>('SERVER').URL;`);
  return once(source, '      extra,\n    });\n  }', '      extra,\n    });\n    });\n  }');
});
patch('src/config/logger.config.ts', source => once(source, '  public error(value: any) {',
  `  public error(value: any) {
    ${helper}.noteFailure(); // A swallowed error cannot become confirmed success.`));
patch('src/utils/sendTelemetry.ts', source => {
  source = once(source, 'export const sendTelemetry = async (route: string): Promise<void> => {',
    `export const sendTelemetry = (route: string): Promise<void> => ${helper}.track(async () => {`);
  source = once(source, '  axios\n    .post(url, telemetry)', `  if (${helper}.current()) {
    await ${helper}.batch('telemetry:' + route, [{ target: 'telemetry', destination: { url }, binding: { url }, input: telemetry, transport: true, causal: false,
      run: async (body: any) => { await ${helper}.guard(); const response = await axios.post(url, body, { timeout: 15000, maxRedirects: 0 });
        return { http_status: response.status }; } }]);
    return;
  }
  axios
    .post(url, telemetry)`);
  return once(source, '    .catch(() => {});\n};', '    .catch(() => {});\n});');
});
patch('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', source => once(source,
  '    const cachedNumbers = await getOnWhatsappCache(numbersToVerify);',
  `    const cachedNumbers = this.instance.name.startsWith('nexi-wa-')
      ? await require('/evolution/nexi-ingress.cjs').cachedContacts(this, numbersToVerify)
      : await getOnWhatsappCache(numbersToVerify);`));
patch('src/api/integrations/chatbot/chatbot.controller.ts', source => {
  const start = source.indexOf('    evolutionBotController.emit(emitData);'), end = source.indexOf('\n  public checkIgnoreJids(', start);
  if (start < 0 || end < start) throw new Error('R2 chatbot dispatcher boundaries changed');
  return source.slice(0, start) + `    const controllers = { evolutionBot: evolutionBotController, typebot: typebotController,
      openai: openaiController, dify: difyController, n8n: n8nController, evoai: evoaiController, flowise: flowiseController };
    if (${helper}.current()) {
      const tasks = [];
      for (const [name, controller] of Object.entries(controllers)) {
        if (!controller.integrationEnabled) continue;
        const bots = await controller.botRepository.findMany({ where: { instanceId: instance.instanceId }, orderBy: { id: 'asc' } });
        const settings = await controller.settingsRepository.findFirst({ where: { instanceId: instance.instanceId } });
        tasks.push({ target: 'chatbot:' + name, destination: { controller: name, bot_ids: bots.map(bot => bot.id) }, binding: { bots, settings }, input: emitData,
          run: async (saved: any) => { await ${helper}.guard(); await controller.emit(saved); return { handler_returned: true }; } });
      }
      await ${helper}.batch('chatbot', tasks);
      return;
    }
    const results = await Promise.allSettled(Object.values(controllers).map(controller => controller.emit(emitData)));
    if (results.some(result => result.status === 'rejected')) throw new Error('chatbot_dispatch_failed');
  }

  public processDebounce(userMessageDebounce: any, content: string, remoteJid: string, debounceTime: number, callback: any): Promise<void> {
    const old = userMessageDebounce[remoteJid];
    if (old) { old.message += '\\n' + content; clearTimeout(old.timeoutId); }
    const entry = old || { message: content, timeoutId: null, waiters: [] };
    userMessageDebounce[remoteJid] = entry;
    const completion = new Promise<void>((resolve, reject) => entry.waiters.push({ resolve, reject }));
    entry.timeoutId = setTimeout(async () => {
      delete userMessageDebounce[remoteJid];
      try { await callback(entry.message); for (const waiter of entry.waiters) waiter.resolve(); }
      catch (error) { for (const waiter of entry.waiters) waiter.reject(error); }
    }, debounceTime * 1000);
    return completion;
  }
` + source.slice(end);
});
patch('src/api/integrations/chatbot/base-chatbot.controller.ts', source => {
  source = once(source, '        this.processDebounce(this.userMessageDebounce, content, remoteJid, debounceTime, async (debouncedContent) => {',
    '        await this.processDebounce(this.userMessageDebounce, content, instance.instanceId + ":" + remoteJid, debounceTime, async (debouncedContent) => {');
  return source.replaceAll('this.waMonitor.waInstances[instance.instanceName]', `${helper}.instance(this.waMonitor.waInstances[instance.instanceName])`);
});
patch('src/api/integrations/chatbot/base-chatbot.service.ts', source => {
  const start = source.indexOf('    await new Promise<void>((resolve) => {\n      setTimeout(async () => {'),
    end = source.indexOf('\n\n    if (instance.integration', start);
  if (start < 0 || end < start) throw new Error('R2 chatbot timer boundary changed');
  return source.slice(0, start) + `    await new Promise<void>(resolve => setTimeout(resolve, delay));
    await instance.textMessage({ number: remoteJid.includes('@lid') ? remoteJid : remoteJid.split('@')[0],
      delay: settings?.delayMessage || 1000, text: message, linkPreview }, false);` + source.slice(end);
});
patch('src/api/integrations/chatbot/typebot/services/typebot.service.ts', source => {
  source = source.replaceAll('this.waMonitor.waInstances[instanceDb.name]', `${helper}.instance(this.waMonitor.waInstances[instanceDb.name])`)
    .replaceAll('this.waMonitor.waInstances[instance.name]', `${helper}.instance(this.waMonitor.waInstances[instance.name])`);
  return once(source, "      console.error('Erro ao processar mensagens:', err);",
    `      ${helper}.noteFailure();
      console.error('Erro ao processar mensagens:', err);`);
});
patch('src/api/integrations/chatbot/openai/services/openai.service.ts', source => {
  source = once(source, '  protected client: OpenAI;', `  private nexiLegacyClient: OpenAI;
  protected get client(): OpenAI {
    return require('/evolution/nexi-ingress.cjs').inWorker() ? require('/evolution/nexi-ingress.cjs').provider(this) : this.nexiLegacyClient;
  }
  protected set client(value: OpenAI) {
    if (!require('/evolution/nexi-ingress.cjs').setProvider(this, value)) this.nexiLegacyClient = value;
  }`);
  return once(source, '    this.client = new OpenAI({ apiKey });',
    `    this.client = new OpenAI({ apiKey, maxRetries: ${helper}.current() ? 0 : 2 });`);
});
patch('src/api/integrations/event/rabbitmq/rabbitmq.controller.ts', source => once(source, '  public async emit({', `  public async publishIngress(exchange: string, queue: string, routing: string, body: any, operationId: string) {
    if (!this.amqpConnection) throw new Error('nexi_rabbitmq_unavailable');
    const channel: any = await new Promise((resolve, reject) => this.amqpConnection.createConfirmChannel((error, value) => error ? reject(error) : resolve(value)));
    const invoke = (method: string, ...args: any[]) => new Promise((resolve, reject) => channel[method](...args, (error, value) => error ? reject(error) : resolve(value)));
    try {
      await invoke('assertExchange', exchange, 'topic', { durable: true, autoDelete: false });
      await invoke('assertQueue', queue, { durable: true, autoDelete: false, arguments: { 'x-queue-type': 'quorum' } });
      await invoke('bindQueue', queue, exchange, routing);
      await ${helper}.guard();
      await new Promise<void>((resolve, reject) => {
        const closed = () => reject(new Error('nexi_rabbitmq_confirm_lost'));
        channel.once('close', closed); channel.once('error', closed);
        channel.publish(exchange, routing, Buffer.from(JSON.stringify(body)), { persistent: true, messageId: operationId }, (error: any) => {
          channel.removeListener('close', closed); channel.removeListener('error', closed);
          if (error) reject(error); else resolve();
        });
      });
    } finally { await new Promise<void>(resolve => channel.close(() => resolve())); }
  }

  public async emit({`));
for (const change of changes) {
  if (process.argv.includes('--snapshot')) {
    const target = path.join(root, '.ingress-integrations-upstream', change.file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, change.before);
  }
  fs.writeFileSync(change.target, change.after);
}
