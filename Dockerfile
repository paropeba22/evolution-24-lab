FROM evoapicloud/evolution-api@sha256:65e29aa1a2ca096675825ff8feb3b5bf7fbcb167e368f9282fd80670e8da18a2

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
