'use strict';

const fs = require('node:fs');
const path = require('node:path');

const distDir = process.env.EVOLUTION_DIST_DIR || '/evolution/dist';
const provider = process.env.DATABASE_PROVIDER;
if (!['postgresql', 'psql_bouncer', 'mysql'].includes(provider)) {
  throw new Error(`DATABASE_PROVIDER must be postgresql, psql_bouncer, or mysql; received: ${provider}`);
}
const prismaConfig = path.join(distDir, '..', 'prisma.config.ts');
if (!fs.existsSync(prismaConfig) || !fs.statSync(prismaConfig).isFile()) {
  throw new Error('Missing /evolution/prisma.config.ts required for Prisma startup');
}

const source = path.join(distDir, 'providers', `${provider}.js`);
const target = path.join(distDir, 'main.js');
const temporary = path.join(distDir, '.main.js.selected');
fs.copyFileSync(source, temporary);
fs.renameSync(temporary, target);
console.log(`[evolution-24-lab] selected compiled Prisma bundle for ${provider}`);
