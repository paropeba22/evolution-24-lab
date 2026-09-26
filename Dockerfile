FROM evoapicloud/evolution-api:homolog

WORKDIR /evolution

COPY prisma.config.ts /evolution/prisma.config.ts
COPY patch-instance-create.mjs /tmp/patch-instance-create.mjs
COPY patch-channel-transport.mjs /tmp/patch-channel-transport.mjs
COPY patch-prisma-binding.mjs /tmp/patch-prisma-binding.mjs
COPY nexi-transport.cjs /evolution/nexi-transport.cjs
COPY prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id
COPY prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id

RUN node /tmp/patch-prisma-binding.mjs && node /tmp/patch-instance-create.mjs && \
    node /tmp/patch-channel-transport.mjs && \
    rm /tmp/patch-prisma-binding.mjs /tmp/patch-instance-create.mjs /tmp/patch-channel-transport.mjs
