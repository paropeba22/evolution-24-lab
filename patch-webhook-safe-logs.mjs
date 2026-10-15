import fs from 'node:fs';
import path from 'node:path';

// Applied after patch-managed-retry.mjs to the same pinned upstream source.
// Only diagnostic arguments change. webhookData and HTTP headers remain intact.
const root = process.argv[2] || '/evolution';
const file = path.join(root, 'src/api/integrations/event/webhook/webhook.controller.ts');
let source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');

function once(pattern, replacement, label) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) throw new Error(`pinned webhook diagnostic anchor changed: ${label}`);
  source = source.replace(pattern, replacement);
}

function segment(start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first < 0 || source.indexOf(start, first + 1) >= 0) throw new Error(`pinned webhook diagnostic anchor changed: ${label}`);
  const last = source.indexOf(end, first + start.length);
  if (last < 0) throw new Error(`pinned webhook diagnostic end changed: ${label}`);
  source = source.slice(0, first) + replacement + source.slice(last + end.length);
}

for (const suffix of ['', '-Global']) {
  const local = suffix ? '`${origin}.sendData-Webhook-Global`' : '`${origin}.sendData-Webhook`';
  segment('const logData = {\n            local: ' + local, '\n          };',
    `const logData = { local: ${local}, event };`, `enabled webhook log${suffix}`);
  segment('this.logger.error({\n            local: ' + local, '\n          });',
    `this.logger.error({ local: ${local}, event, result: 'request_failed' });`, `webhook failure${suffix}`);
}

// retryWebhookRequest has its own logs, including an Axios error whose message,
// stack and URL may contain credentials. Keep only bounded categories/status.
once(/this\.logger\.log\(\{\n            local: `\$\{origin\}`,[\s\S]*?\n          \}\);/,
  "this.logger.log({ local: 'WebhookController.retryWebhookRequest', result: 'retry_succeeded', attempts });",
  'retry succeeded');
once(/this\.logger\.error\(\{\n            local: `\$\{origin\}`,[\s\S]*?\n          \}\);/,
  "this.logger.error({ local: 'WebhookController.retryWebhookRequest', result: 'http_rejected', statusCode: error.response.status });",
  'nonretryable HTTP');
once(/this\.logger\.error\(\{\n          local: `\$\{origin\}`,[\s\S]*?\n        \}\);/,
  "this.logger.error({ local: 'WebhookController.retryWebhookRequest', result: isTimeout ? 'timeout' : 'request_failed', attempts, statusCode: error?.response?.status });",
  'retry failure');
once(/this\.logger\.log\(\{\n          local: `\$\{origin\}`,[\s\S]*?\n        \}\);/,
  "this.logger.log({ local: 'WebhookController.retryWebhookRequest', result: 'waiting_to_retry', delaySeconds: nextDelay });",
  'retry wait');
once(/message: `JWT generation failed: \$\{error\?\.message\}`,/,
  "message: 'JWT generation failed',", 'JWT failure');

fs.writeFileSync(file, source);
