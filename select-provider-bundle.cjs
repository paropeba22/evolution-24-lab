'use strict';

const fs = require('node:fs');
const path = require('node:path');

const distDir = process.env.EVOLUTION_DIST_DIR || '/evolution/dist';
if (process.env.DATABASE_PROVIDER === undefined) {
  // Match runWithProvider.js, which loads the upstream .env before selecting
  // the schema and migration folder.
  require(path.join(distDir, '..', 'node_modules', 'dotenv')).config({
    path: path.join(distDir, '..', '.env'),
  });
}
const provider = process.env.DATABASE_PROVIDER || 'postgresql';
if (!['postgresql', 'psql_bouncer', 'mysql'].includes(provider)) {
  throw new Error(`Unsupported DATABASE_PROVIDER: ${provider}`);
}

const source = path.join(distDir, 'providers', `${provider}.js`);
const target = path.join(distDir, 'main.js');
const temporary = path.join(distDir, '.main.js.selected');
fs.copyFileSync(source, temporary);
fs.renameSync(temporary, target);
console.log(`[evolution-24-lab] selected compiled Prisma bundle for ${provider}`);
