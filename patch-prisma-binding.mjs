import fs from 'node:fs';
import path from 'node:path';

for (const provider of ['postgresql', 'psql_bouncer', 'mysql']) {
  const schemaPath = path.join(process.env.EVOLUTION_PRISMA_DIR || '/evolution/prisma', `${provider}-schema.prisma`);
  const source = fs.readFileSync(schemaPath, 'utf8');
  const before = '  nameInbox               String?   @db.VarChar(100)';
  if (source.split(before).length !== 2 || source.includes('  inboxId                 String?   @db.VarChar(32)')) {
    throw new Error(`${provider}: Chatwoot Prisma schema changed`);
  }
  fs.writeFileSync(schemaPath, source.replace(before, `${before}\n  inboxId                 String?   @db.VarChar(32)`));
}
