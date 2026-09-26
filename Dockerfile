FROM evoapicloud/evolution-api:homolog

WORKDIR /evolution

COPY prisma.config.ts /evolution/prisma.config.ts
COPY patch-instance-create.mjs /tmp/patch-instance-create.mjs
COPY patch-channel-transport.mjs /tmp/patch-channel-transport.mjs
COPY nexi-transport.cjs /evolution/nexi-transport.cjs

RUN node /tmp/patch-instance-create.mjs && node /tmp/patch-channel-transport.mjs && \
    rm /tmp/patch-instance-create.mjs /tmp/patch-channel-transport.mjs
