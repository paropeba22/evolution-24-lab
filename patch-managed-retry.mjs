import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.argv[2] || '/evolution';
const file = path.join(root, 'src/api/integrations/event/webhook/webhook.controller.ts');
const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
if (createHash('sha256').update(source).digest('hex') !== '39a090e95501e46df8429da8eedfc7e663b2e8958c3eaa34def85354bf1336b9') {
  throw new Error('pinned webhook retry source changed');
}
const start = source.indexOf('    const maxRetryAttempts = maxRetries ??');
const end = source.indexOf('\n\n    let attempts = 0;', start);
if (start < 0 || end < start) throw new Error('retry policy anchor changed');
const replacement = `    const { maxRetryAttempts, initialDelay, useExponentialBackoff, maxDelay, jitterFactor, nonRetryableStatusCodes } =
      require('/evolution/nexi-transport.cjs').retryPolicy(webhookData, webhookConfig, maxRetries, delaySeconds);`;
if (process.argv.includes('--snapshot')) {
  fs.mkdirSync(path.join(root, '.identity-upstream'), { recursive: true });
  fs.writeFileSync(path.join(root, '.identity-upstream/webhook.controller.ts'), source);
}
fs.writeFileSync(file, source.slice(0, start) + replacement + source.slice(end));
