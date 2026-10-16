  public async emitIngress(eventData: any) {
    const dispatch = require('/evolution/nexi-ingress-dispatch.cjs');
    const ctx = dispatch.current();
    if (!ctx || eventData.instanceName !== ctx.claims.instance_name) throw new Error('nexi_ingress_event_binding_invalid');
    const config = require('@config/env.config').configService;
    const axios = require('axios').default;
    const tasks: any[] = [];
    const { instanceName, event, data, serverUrl, sender, apiKey, local, integration, extra } = eventData;
    const dateTime = ctx.claims.accepted_at;
    const we = event.replace(/[.-]/g, '_').toUpperCase();
    const transformed = we.replace(/_/g, '-').toLowerCase();
    const packet = { ...(extra || {}), event, instance: instanceName, data, server_url: serverUrl,
      date_time: dateTime, sender, apikey: apiKey };
    const add = (target: string, binding: any, input: any, run: any) => tasks.push({ target, binding, input, run, transport: true,
      causal: !dispatch.inDestination(),
      destination: Object.fromEntries(['url', 'subject', 'queue', 'routing', 'exchange', 'appId', 'topic', 'region', 'namespace']
        .filter(key => binding[key] !== undefined).map(key => [key, binding[key]])) });
    const allowed = (name: string) => !integration || integration.includes(name);
    const selected = (settings: any) => settings?.enabled && Array.isArray(settings.events) && settings.events.includes(we);
    if (allowed('webhook')) {
      const settings: any = await this.webhook.get(instanceName), cfg = config.get('WEBHOOK');
      const send = (target: string, url: string, custom: any) => {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('nexi_ingress_webhook_url_invalid');
        const headers = { ...custom };
        add(target, { url, headers }, { ...packet, destination: url }, async (body: any, operationId: string) => {
          const actualHeaders: any = { ...headers };
          if (actualHeaders.jwt_key) {
            actualHeaders.Authorization = `Bearer ${require('jsonwebtoken').sign({ app: 'evolution', action: 'webhook' },
              actualHeaders.jwt_key, { algorithm: 'HS256', expiresIn: 600 })}`;
            delete actualHeaders.jwt_key;
          }
          await dispatch.guard();
          const transport = require('/evolution/nexi-transport.cjs');
          const requestHeaders = { ...actualHeaders, 'Content-Type': 'application/json', 'X-Instance-ID': ctx.parent.instanceId,
              'X-Instance-Name': instanceName, 'X-Event-Type': event, 'X-Nexi-Operation-Id': operationId,
              'X-Nexi-Attempt': '1', 'User-Agent': 'EvolutionAPI-Webhook/2.3.7' };
          const prepared = transport.prepareEvent(requestHeaders, { ...body, nexi_operation_id: operationId, nexi_attempt: 1 }, instanceName, ctx.parent.instanceId);
          if (prepared.headers['X-Nexi-Event-Id']) prepared.headers['X-Nexi-Event-Id'] =
            `${operationId.slice(0, 8)}-${operationId.slice(8, 12)}-${operationId.slice(12, 16)}-${operationId.slice(16, 20)}-${operationId.slice(20, 32)}`;
          const response = await axios.post(url, prepared.body, {
            headers: transport.freshEventHeaders(prepared.headers, prepared.body),
            timeout: cfg.REQUEST?.TIMEOUT_MS ?? 30000, maxRedirects: 0,
          });
          return { http_status: response.status }; // HTTP acknowledgement, not downstream business completion.
        });
      };
      if (local && selected(settings)) send('webhook:local', settings.webhookByEvents ? `${settings.url}/${transformed}` : settings.url, settings.headers || {});
      if (cfg.GLOBAL?.ENABLED && cfg.EVENTS?.[we]) send('webhook:global', cfg.GLOBAL.WEBHOOK_BY_EVENTS ? `${cfg.GLOBAL.URL}/${transformed}` : cfg.GLOBAL.URL, {});
    }
    if (allowed('websocket') && this.websocket.status) {
      const settings: any = await this.websocket.get(instanceName), cfg = config.get('WEBSOCKET');
      if (cfg.GLOBAL_EVENTS) add('websocket:global', { namespace: '/' }, packet, async (body: any, operationId: string) => {
        await dispatch.guard(); const acknowledgements = await this.websocket.socket.timeout(15000).emitWithAck(event, { ...body, nexi_operation_id: operationId });
        return { client_acknowledgements: acknowledgements.length };
      });
      if (selected(settings)) add('websocket:local', { namespace: instanceName }, packet, async (body: any, operationId: string) => {
        await dispatch.guard(); const acknowledgements = await this.websocket.socket.of(`/${instanceName}`).timeout(15000).emitWithAck(event, { ...body, nexi_operation_id: operationId });
        return { client_acknowledgements: acknowledgements.length };
      });
    }
    if (allowed('nats') && this.nats.status) {
      const settings: any = await this.nats.get(instanceName), cfg = config.get('NATS');
      const send = (target: string, subject: string) => add(target, { subject, uri: cfg.URI }, packet, async (body: any, operationId: string) => {
        await dispatch.guard(); const client = this.nats.natsClient;
        if (!client || client.isClosed()) throw new Error('nexi_nats_unavailable');
        client.publish(subject, Buffer.from(JSON.stringify({ ...body, nexi_operation_id: operationId }))); await client.flush(); return { broker_flush: true };
      });
      if (selected(settings)) send('nats:local', `${instanceName}.${event.toLowerCase()}`);
      if (cfg.GLOBAL_ENABLED && cfg.EVENTS?.[we]) send('nats:global', cfg.PREFIX_KEY ? `${cfg.PREFIX_KEY}.${event.toLowerCase()}` : event.toLowerCase());
    }
    if (allowed('rabbitmq') && this.rabbitmq.status) {
      const settings: any = await this.rabbitmq.get(instanceName), cfg = config.get('RABBITMQ');
      const send = (target: string, queue: string, routing: string) => add(target, { queue, routing, exchange: cfg.EXCHANGE_NAME, uri: cfg.URI }, packet,
        async (body: any, operationId: string) => {
          await dispatch.guard();
          await this.rabbitmq.publishIngress(cfg.EXCHANGE_NAME, queue, routing, body, operationId);
          return { publisher_confirm: true };
        });
      if (selected(settings)) send('rabbitmq:local', `${instanceName}.${event.replace(/_/g, '.').toLowerCase()}`, event);
      if (cfg.GLOBAL_ENABLED && cfg.EVENTS?.[we]) send('rabbitmq:global',
        `${cfg.PREFIX_KEY ? cfg.PREFIX_KEY + '.' : ''}${event.replace(/_/g, '.').toLowerCase()}`, event);
    }
    if (allowed('pusher') && this.pusher.status) {
      const settings: any = await this.pusher.get(instanceName), cfg = config.get('PUSHER');
      const send = (target: string, options: any) => add(target, options, packet, async (body: any, operationId: string) => {
        if (Buffer.byteLength(JSON.stringify(body)) > 10000) throw new Error('nexi_pusher_payload_capacity');
        const Pusher = require('pusher');
        const client = new Pusher(options);
        await dispatch.guard();
        await client.trigger(instanceName, event.replace(/_/g, '.').toLowerCase(), { ...body, nexi_operation_id: operationId });
        return { api_acknowledged: true };
      });
      if (local && selected(settings)) send('pusher:local', { appId: settings.appId, key: settings.key, secret: settings.secret, cluster: settings.cluster, useTLS: settings.useTLS });
      if (cfg.GLOBAL?.ENABLED && cfg.EVENTS?.[we]) send('pusher:global', { appId: cfg.GLOBAL.APP_ID, key: cfg.GLOBAL.KEY, secret: cfg.GLOBAL.SECRET, cluster: cfg.GLOBAL.CLUSTER, useTLS: cfg.GLOBAL.USE_TLS });
    }
    if (allowed('sqs') && this.sqs.status) {
      const settings: any = await this.sqs.get(instanceName), cfg = config.get('SQS');
      if (cfg.GLOBAL_ENABLED ? cfg.EVENTS?.[we] : selected(settings)) {
        const formatted = cfg.GLOBAL_ENABLED && cfg.GLOBAL_FORCE_SINGLE_QUEUE ? 'singlequeue' : event.replace('.', '_').toLowerCase();
        const queue = `${(cfg.BASE_URL || `https://sqs.${cfg.REGION}.amazonaws.com`).replace(/\/+$/, '')}/${cfg.ACCOUNT_ID}/${cfg.GLOBAL_ENABLED ? cfg.GLOBAL_PREFIX_NAME : instanceName}_${formatted}.fifo`;
        add('sqs:queue', { queue, region: cfg.REGION }, { ...packet, dataType: 'json', server: config.get('SERVER').NAME },
          async (body: any, operationId: string) => {
            if (Buffer.byteLength(JSON.stringify(body)) > cfg.MAX_PAYLOAD_SIZE) {
              if (!config.get('S3').ENABLE) throw new Error('nexi_sqs_payload_capacity');
              const storage = require('@api/integrations/storage/s3/libs/minio.server');
              const buffer = Buffer.from(JSON.stringify(body)), object = `ingress/${ctx.parent.instanceId}/${operationId}/event.json`;
              await dispatch.guard();
              const uploaded = await storage.uploadFile(object, buffer, buffer.length, { 'Content-Type': 'application/json' });
              if (!uploaded?.etag) throw new Error('nexi_sqs_archive_unconfirmed');
              body = { ...body, dataType: 's3', data: { fileUrl: await storage.getObjectUrl(object) } };
            }
            // A dedicated client disables SDK retries; FIFO dedup is finite and
            // is not used as permission to replay an unknown attempt.
            const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
            const client = new SQSClient({ region: cfg.REGION, credentials: { accessKeyId: cfg.ACCESS_KEY_ID, secretAccessKey: cfg.SECRET_ACCESS_KEY }, maxAttempts: 1 });
            try {
              await dispatch.guard();
              const ack = await client.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: JSON.stringify(body),
                MessageGroupId: `${ctx.parent.laneId}`, MessageDeduplicationId: operationId }));
              if (!ack.MessageId) throw new Error('nexi_sqs_ack_missing');
              return { message_id: ack.MessageId };
            } finally { client.destroy(); }
          });
      }
    }
    if (allowed('kafka') && this.kafka.status) {
      const settings: any = await this.kafka.get(instanceName), cfg = config.get('KAFKA');
      const send = (target: string, topic: string) => add(target, { topic, brokers: cfg.BROKERS }, packet, async (body: any, operationId: string) => {
        const producer = (this.kafka as any).kafkaClient?.producer({ retry: { retries: 0 } });
        if (!producer) throw new Error('nexi_kafka_unavailable');
        try {
          await producer.connect(); await dispatch.guard();
          const ack = await producer.send({ topic, acks: -1, messages: [{ key: ctx.parent.laneId,
            value: JSON.stringify(body), headers: { event, instance: instanceName, nexi_operation_id: operationId } }] });
          return { broker_acknowledged: true, partitions: ack.length };
        } finally { await producer.disconnect(); }
      });
      const prefix = cfg.TOPIC_PREFIX || 'evolution';
      if (selected(settings)) send('kafka:local', `${prefix}.${instanceName}.${event.toLowerCase().replace(/_/g, '.')}`);
      if (cfg.GLOBAL_ENABLED && cfg.EVENTS?.[we]) send('kafka:global', `${prefix}.global.${event.toLowerCase().replace(/_/g, '.')}`);
    }
    return dispatch.batch(`event:${event}`, tasks);
  }
