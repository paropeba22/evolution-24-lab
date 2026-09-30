'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const upstream = process.env.EVOLUTION_UPSTREAM_SOURCE;

test('pinned source patch maps CTAs and guards managed conversation correlation', { skip: !upstream }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-financial-cta-'));
  const files = [
    'src/validate/message.schema.ts',
    'src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts',
  ];
  try {
    for (const file of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(upstream, file), target);
    }
    execFileSync(process.execPath, [path.join(__dirname, 'patch-financial-delivery-source.mjs'), root]);
    const schema = readFileSync(path.join(root, files[0]), 'utf8');
    const mapper = readFileSync(path.join(root, files[1]), 'utf8');
    assert.match(schema, /copyCode: \{ type: 'string' \}/);
    assert.match(mapper, /button\.name === 'cta_copy' \|\| button\.name === 'cta_url'/);
    assert.match(mapper, /if \(managedCta\) return;/);
    assert.match(mapper, /'WAID:' \+ body\.key\.id/);
    assert.match(mapper, /'PIX da fatura enviado ao cliente'/);
    assert.match(mapper, /'Fatura enviada ao cliente'/);
    assert.doesNotMatch(mapper, /New message received - Instance: \$\{JSON\.stringify\(body/);
    assert.doesNotMatch(mapper, /Interactive Button Message: ' \+ JSON\.stringify\(buttons\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
