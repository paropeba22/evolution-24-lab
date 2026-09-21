FROM evoapicloud/evolution-api:homolog

WORKDIR /evolution

COPY prisma.config.ts /evolution/prisma.config.ts
COPY patch-instance-create.mjs /tmp/patch-instance-create.mjs

RUN node /tmp/patch-instance-create.mjs && rm /tmp/patch-instance-create.mjs
