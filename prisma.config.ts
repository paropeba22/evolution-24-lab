import 'dotenv/config';

import path from 'node:path';

import { defineConfig, env } from 'prisma/config';

const provider = process.env.DATABASE_PROVIDER ?? 'postgresql';

const schemaFile =
  provider === 'mysql'
    ? 'mysql-schema.prisma'
    : provider === 'psql_bouncer'
      ? 'psql_bouncer-schema.prisma'
      : 'postgresql-schema.prisma';

export default defineConfig({
  schema: path.join('prisma', schemaFile),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_CONNECTION_URI'),
  },
});
