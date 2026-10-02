FROM node:24-alpine AS source-builder

RUN apk add --no-cache git ffmpeg wget curl bash openssl
WORKDIR /evolution

# Fetch only the accepted source commit. A changed or unavailable revision fails the build.
RUN git init . && \
    git remote add origin https://github.com/EvolutionAPI/evolution-api.git && \
    git fetch --depth 1 origin e273b904d53f5726970fd6a244ed9caa61dfeb9a && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = e273b904d53f5726970fd6a244ed9caa61dfeb9a

RUN npm ci --silent

COPY patch-prisma-binding.mjs /tmp/patch-prisma-binding.mjs
COPY patch-instance-create.mjs /tmp/patch-instance-create.mjs
COPY patch-channel-transport.mjs /tmp/patch-channel-transport.mjs
COPY patch-financial-delivery-source.mjs /tmp/patch-financial-delivery-source.mjs
COPY patch-financial-delivery-source.mjs nexi-financial-transport.cjs /evolution/
COPY patch-channel-transport.mjs /evolution/patch-channel-transport.mjs
COPY assert-runtime-model.mjs /tmp/assert-runtime-model.mjs
COPY assert-runtime-model.mjs /evolution/assert-runtime-model.mjs
COPY assert-groups-runtime.mjs /evolution/assert-groups-runtime.mjs
COPY Dockerfile /evolution/Dockerfile
COPY nexi-transport.cjs /evolution/nexi-transport.cjs
COPY patch-trusted-baileys.mjs patch-managed-retry.mjs nexi-identity.cjs /evolution/
COPY patch-groups-source.mjs nexi-groups.cjs groups-wave1.test.cjs /evolution/
COPY identity-foundation-source.test.cjs recipient-contract-test-support.cjs /evolution/
COPY bundle-patch.test.cjs nexi-transport.test.cjs redis-lua.integration.test.cjs runtime-model.test.cjs financial-delivery-source.test.cjs /evolution/
COPY select-provider-bundle.cjs /evolution/select-provider-bundle.cjs
COPY prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id
COPY prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id
COPY prisma/postgresql-migrations/20261002000000_nexi_groups_wave1 /evolution/prisma/postgresql-migrations/20261002000000_nexi_groups_wave1
COPY prisma/mysql-migrations/20261002000000_nexi_groups_wave1 /evolution/prisma/mysql-migrations/20261002000000_nexi_groups_wave1

# The schema change must precede Prisma generation and tsup's bundled client.
RUN node /tmp/patch-prisma-binding.mjs
RUN node /tmp/patch-financial-delivery-source.mjs /evolution --snapshot
RUN node /evolution/patch-trusted-baileys.mjs /evolution --snapshot
RUN node /evolution/patch-managed-retry.mjs /evolution --snapshot
RUN node /evolution/patch-groups-source.mjs /evolution --snapshot

# tsup bakes licensing definitions into each bundle. Empty args retain the
# pinned upstream source's official-endpoint fallback; no runtime ENV is added.
ARG LICENSE_ENDPOINT_ENCODED=""
ARG LICENSE_ENDPOINT_XOR_KEY=""
# Upstream's MySQL schema lacks Label.labelId_instanceId referenced by Baileys,
# so its exact client is bundled by tsup without the upstream TypeScript gate.
# psql_bouncer uses PostgreSQL SQL/migrations and the complete PostgreSQL bundle;
# its upstream schema omits RuntimeConfig used by the licensing source.
RUN set -eu; mkdir -p /tmp/evolution-provider-bundles; \
    for provider in mysql postgresql; do \
      if [ "$provider" = mysql ]; then build_uri="mysql://build:build@localhost:3306/build"; else build_uri="postgresql://build:build@localhost:5432/build"; fi; \
      DATABASE_PROVIDER="$provider" DATABASE_CONNECTION_URI="$build_uri" npm run db:generate; \
      if [ "$provider" != postgresql ]; then \
        DATABASE_PROVIDER="$provider" LICENSE_ENDPOINT_ENCODED="$LICENSE_ENDPOINT_ENCODED" LICENSE_ENDPOINT_XOR_KEY="$LICENSE_ENDPOINT_XOR_KEY" NODE_OPTIONS="--max-old-space-size=2048" npx tsup; \
      else \
        DATABASE_PROVIDER="$provider" LICENSE_ENDPOINT_ENCODED="$LICENSE_ENDPOINT_ENCODED" LICENSE_ENDPOINT_XOR_KEY="$LICENSE_ENDPOINT_XOR_KEY" NODE_OPTIONS="--max-old-space-size=2048" npm run build; \
      fi; \
      node /tmp/patch-instance-create.mjs; \
      EVOLUTION_PROVIDER="$provider" node /tmp/patch-channel-transport.mjs; \
      EVOLUTION_PROVIDER="$provider" node /tmp/assert-runtime-model.mjs; \
      EVOLUTION_PROVIDER="$provider" node /evolution/assert-groups-runtime.mjs; \
      cp dist/main.js "/tmp/evolution-provider-bundles/$provider.js"; \
    done; \
    mkdir -p dist/providers; \
    cp /tmp/evolution-provider-bundles/*.js dist/providers/; \
    cp dist/providers/postgresql.js dist/providers/psql_bouncer.js; \
    for provider in mysql postgresql; do \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-runtime-model.mjs; \
    done; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /tmp/assert-runtime-model.mjs; \
    EVOLUTION_PROVIDER=postgresql node /tmp/assert-runtime-model.mjs; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_PRISMA_DIR=/evolution/prisma EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/postgresql.js node --test *.test.cjs; \
    EVOLUTION_PROVIDER=mysql EVOLUTION_SKIP_GENERATED=1 EVOLUTION_PRISMA_DIR=/evolution/prisma EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/mysql.js node --test *.test.cjs

FROM evoapicloud/evolution-api@sha256:65e29aa1a2ca096675825ff8feb3b5bf7fbcb167e368f9282fd80670e8da18a2

WORKDIR /evolution
COPY prisma.config.ts /evolution/prisma.config.ts
COPY --from=source-builder /evolution/dist /evolution/dist
COPY --from=source-builder /evolution/prisma /evolution/prisma
COPY --from=source-builder /evolution/nexi-transport.cjs /evolution/nexi-transport.cjs
COPY --from=source-builder /evolution/nexi-financial-transport.cjs /evolution/nexi-financial-transport.cjs
COPY --from=source-builder /evolution/nexi-identity.cjs /evolution/nexi-identity.cjs
COPY --from=source-builder /evolution/nexi-groups.cjs /evolution/nexi-groups.cjs
COPY --from=source-builder /evolution/node_modules/baileys /evolution/node_modules/baileys
COPY select-provider-bundle.cjs /evolution/select-provider-bundle.cjs
COPY assert-runtime-model.mjs /tmp/assert-runtime-model.mjs
COPY assert-groups-runtime.mjs /tmp/assert-groups-runtime.mjs

RUN set -eu; \
    test -f /evolution/prisma.config.ts; \
    test -f /evolution/prisma/postgresql-schema.prisma; \
    test -f /evolution/prisma/psql_bouncer-schema.prisma; \
    test -f /evolution/prisma/mysql-schema.prisma; \
    test -f /evolution/select-provider-bundle.cjs; \
    test -f /evolution/Docker/scripts/deploy_database.sh; \
    test -f /evolution/runWithProvider.js; \
    for provider in mysql postgresql; do \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-runtime-model.mjs; \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-groups-runtime.mjs; \
    done; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /tmp/assert-runtime-model.mjs; \
    EVOLUTION_PROVIDER=postgresql node /tmp/assert-runtime-model.mjs && \
    rm /tmp/assert-runtime-model.mjs
ENTRYPOINT ["/bin/bash", "-c", "node /evolution/select-provider-bundle.cjs && . ./Docker/scripts/deploy_database.sh && npm run start:prod"]
