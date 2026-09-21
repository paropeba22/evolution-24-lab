FROM evoapicloud/evolution-api:homolog

WORKDIR /evolution

COPY prisma.config.ts /evolution/prisma.config.ts
