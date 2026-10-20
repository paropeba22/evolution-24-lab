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
COPY assert-attendance-runtime.mjs /evolution/assert-attendance-runtime.mjs
COPY assert-protected-send-node.cjs /evolution/assert-protected-send-node.cjs
COPY patch-attendance-source.mjs attendance-models.prisma nexi-attendance.cjs attendance-wave1b.test.cjs attendance-source.test.cjs /evolution/
COPY nexi-canonical-json.cjs attendance-canonical.test.cjs attendance-corrections.test.cjs /evolution/
COPY nexi-attendance-snapshot.cjs attendance-snapshot.test.cjs /evolution/
COPY nexi-attendance-authority.cjs nexi-attendance-storage-guard.cjs attendance-authority.test.cjs attendance-authority-test-support.cjs attendance-test-network-trap.cjs /evolution/
COPY nexi-attendance-dispatch.cjs attendance-physical-dispatch.test.cjs /evolution/
COPY nexi-attendance-isolated.cjs attendance-isolated.test.cjs attendance-isolated-test-support.cjs /evolution/
COPY attendance-socket-test-support.cjs attendance-socket-registration.test.cjs /evolution/
COPY nexi-attendance-storage-check.cjs /evolution/
COPY attendance-storage-corrections.test.cjs /evolution/
COPY fixtures/attendance-authority-v1.json /evolution/fixtures/attendance-authority-v1.json
COPY fixtures/baileys-send-node-rc13.json /evolution/fixtures/baileys-send-node-rc13.json
COPY fixtures/attendance-canonical-json-v1.json /evolution/fixtures/attendance-canonical-json-v1.json
COPY Dockerfile /evolution/Dockerfile
COPY nexi-transport.cjs /evolution/nexi-transport.cjs
COPY patch-trusted-baileys.mjs patch-managed-retry.mjs patch-webhook-safe-logs.mjs nexi-identity.cjs /evolution/
COPY patch-ingress-source.mjs ingress-models.prisma nexi-ingress.cjs /evolution/
COPY patch-chatwoot-completion.mjs nexi-ingress-effects.cjs ingress-effects.ts.inc /evolution/
COPY patch-ingress-integrations.mjs ingress-event-adapters.ts.inc nexi-ingress-dispatch.cjs /evolution/
COPY patch-baileys-transport.mjs assert-baileys-transport-runtime.mjs nexi-baileys-transport.cjs nexi-baileys-device-cache.cjs /evolution/
COPY assert-ingress-runtime.mjs /evolution/
COPY patch-groups-source.mjs nexi-groups.cjs groups-wave1.test.cjs /evolution/
COPY groups-postgresql.integration.test.cjs /evolution/
COPY attendance-database.integration.test.cjs /evolution/
COPY identity-foundation-source.test.cjs recipient-contract-test-support.cjs /evolution/
COPY bundle-patch.test.cjs nexi-transport.test.cjs redis-lua.integration.test.cjs runtime-model.test.cjs financial-delivery-source.test.cjs /evolution/
COPY select-provider-bundle.cjs /evolution/select-provider-bundle.cjs
COPY prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/postgresql-migrations/20260926000000_add_chatwoot_inbox_id
COPY prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id /evolution/prisma/mysql-migrations/20260926000000_add_chatwoot_inbox_id
COPY prisma/postgresql-migrations/20261002000000_nexi_groups_wave1 /evolution/prisma/postgresql-migrations/20261002000000_nexi_groups_wave1
COPY prisma/mysql-migrations/20261002000000_nexi_groups_wave1 /evolution/prisma/mysql-migrations/20261002000000_nexi_groups_wave1
COPY prisma/postgresql-migrations/20261002000001_harden_groups_wave1 /evolution/prisma/postgresql-migrations/20261002000001_harden_groups_wave1
COPY prisma/mysql-migrations/20261002000001_harden_groups_wave1 /evolution/prisma/mysql-migrations/20261002000001_harden_groups_wave1
COPY prisma/postgresql-migrations/20261002000002_namespace_groups_source /evolution/prisma/postgresql-migrations/20261002000002_namespace_groups_source
COPY prisma/mysql-migrations/20261002000002_namespace_groups_source /evolution/prisma/mysql-migrations/20261002000002_namespace_groups_source
COPY prisma/postgresql-migrations/20261005000000_nexi_attendance_boundaries /evolution/prisma/postgresql-migrations/20261005000000_nexi_attendance_boundaries
COPY prisma/mysql-migrations/20261005000000_nexi_attendance_boundaries /evolution/prisma/mysql-migrations/20261005000000_nexi_attendance_boundaries
COPY prisma/postgresql-migrations/20261005000001_attendance_canonical_version /evolution/prisma/postgresql-migrations/20261005000001_attendance_canonical_version
COPY prisma/mysql-migrations/20261005000001_attendance_canonical_version /evolution/prisma/mysql-migrations/20261005000001_attendance_canonical_version
COPY prisma/postgresql-migrations/20261006000000_attendance_release_dispatch /evolution/prisma/postgresql-migrations/20261006000000_attendance_release_dispatch
COPY prisma/mysql-migrations/20261006000000_attendance_release_dispatch /evolution/prisma/mysql-migrations/20261006000000_attendance_release_dispatch
COPY prisma/postgresql-migrations/20261010000000_attendance_physical_dispatch /evolution/prisma/postgresql-migrations/20261010000000_attendance_physical_dispatch
COPY prisma/mysql-migrations/20261010000000_attendance_physical_dispatch /evolution/prisma/mysql-migrations/20261010000000_attendance_physical_dispatch
COPY prisma/postgresql-migrations/20261015000000_nexi_durable_ingress /evolution/prisma/postgresql-migrations/20261015000000_nexi_durable_ingress
COPY prisma/mysql-migrations/20261015000000_nexi_durable_ingress /evolution/prisma/mysql-migrations/20261015000000_nexi_durable_ingress
COPY prisma/postgresql-migrations/20261015000001_nexi_ingress_secondary /evolution/prisma/postgresql-migrations/20261015000001_nexi_ingress_secondary
COPY prisma/mysql-migrations/20261015000001_nexi_ingress_secondary /evolution/prisma/mysql-migrations/20261015000001_nexi_ingress_secondary
COPY prisma/postgresql-migrations/20261015000002_nexi_ingress_contact_cache /evolution/prisma/postgresql-migrations/20261015000002_nexi_ingress_contact_cache
COPY prisma/mysql-migrations/20261015000002_nexi_ingress_contact_cache /evolution/prisma/mysql-migrations/20261015000002_nexi_ingress_contact_cache

# The schema change must precede Prisma generation and tsup's bundled client.
RUN node /tmp/patch-prisma-binding.mjs
RUN node /tmp/patch-financial-delivery-source.mjs /evolution --snapshot
RUN node /evolution/patch-trusted-baileys.mjs /evolution --snapshot
RUN node /evolution/patch-managed-retry.mjs /evolution --snapshot
RUN node /evolution/patch-webhook-safe-logs.mjs /evolution
RUN node /evolution/patch-groups-source.mjs /evolution --snapshot
RUN node /evolution/patch-attendance-source.mjs /evolution --snapshot
RUN node /evolution/patch-chatwoot-completion.mjs /evolution
RUN node /evolution/patch-ingress-source.mjs /evolution --snapshot
RUN node /evolution/patch-ingress-integrations.mjs /evolution --snapshot
RUN node /evolution/patch-baileys-transport.mjs /evolution --snapshot

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
        DATABASE_PROVIDER="$provider" LICENSE_ENDPOINT_ENCODED="$LICENSE_ENDPOINT_ENCODED" LICENSE_ENDPOINT_XOR_KEY="$LICENSE_ENDPOINT_XOR_KEY" NODE_OPTIONS="--max-old-space-size=4096" npx tsup; \
      else \
        DATABASE_PROVIDER="$provider" LICENSE_ENDPOINT_ENCODED="$LICENSE_ENDPOINT_ENCODED" LICENSE_ENDPOINT_XOR_KEY="$LICENSE_ENDPOINT_XOR_KEY" NODE_OPTIONS="--max-old-space-size=4096" npm run build; \
      fi; \
      node /tmp/patch-instance-create.mjs; \
      EVOLUTION_PROVIDER="$provider" node /tmp/patch-channel-transport.mjs; \
      EVOLUTION_PROVIDER="$provider" node /tmp/assert-runtime-model.mjs; \
      EVOLUTION_PROVIDER="$provider" node /evolution/assert-groups-runtime.mjs; \
      EVOLUTION_PROVIDER="$provider" node /evolution/assert-attendance-runtime.mjs; \
      cp dist/main.js "/tmp/evolution-provider-bundles/$provider.js"; \
    done; \
    mkdir -p dist/providers; \
    cp /tmp/evolution-provider-bundles/*.js dist/providers/; \
    cp dist/providers/postgresql.js dist/providers/psql_bouncer.js; \
    for provider in mysql postgresql; do \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-runtime-model.mjs; \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /evolution/assert-attendance-runtime.mjs; \
    done; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /tmp/assert-runtime-model.mjs; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /evolution/assert-attendance-runtime.mjs; \
    EVOLUTION_PROVIDER=postgresql node /tmp/assert-runtime-model.mjs; \
    node /evolution/assert-baileys-transport-runtime.mjs /evolution; \
    node /evolution/assert-ingress-runtime.mjs /evolution;

FROM evoapicloud/evolution-api@sha256:65e29aa1a2ca096675825ff8feb3b5bf7fbcb167e368f9282fd80670e8da18a2

WORKDIR /evolution
COPY prisma.config.ts /evolution/prisma.config.ts
COPY --from=source-builder /evolution/dist /evolution/dist
COPY --from=source-builder /evolution/prisma /evolution/prisma
COPY --from=source-builder /evolution/nexi-transport.cjs /evolution/nexi-transport.cjs
COPY --from=source-builder /evolution/nexi-baileys-transport.cjs /evolution/nexi-baileys-transport.cjs
COPY --from=source-builder /evolution/nexi-baileys-device-cache.cjs /evolution/nexi-baileys-device-cache.cjs
COPY --from=source-builder /evolution/nexi-financial-transport.cjs /evolution/nexi-financial-transport.cjs
COPY --from=source-builder /evolution/nexi-identity.cjs /evolution/nexi-identity.cjs
COPY --from=source-builder /evolution/nexi-ingress.cjs /evolution/nexi-ingress.cjs
COPY --from=source-builder /evolution/nexi-ingress-effects.cjs /evolution/nexi-ingress-effects.cjs
COPY --from=source-builder /evolution/nexi-ingress-dispatch.cjs /evolution/nexi-ingress-dispatch.cjs
# SDK is external in tsup. Ship the actual instrumented SDK and its pinned
# nested Axios, rather than relying on the unmodified base-image dependency.
COPY --from=source-builder /evolution/node_modules/@figuro/chatwoot-sdk /evolution/node_modules/@figuro/chatwoot-sdk
COPY --from=source-builder /evolution/nexi-groups.cjs /evolution/nexi-groups.cjs
COPY --from=source-builder /evolution/nexi-attendance.cjs /evolution/nexi-attendance.cjs
COPY --from=source-builder /evolution/nexi-canonical-json.cjs /evolution/nexi-canonical-json.cjs
COPY --from=source-builder /evolution/nexi-attendance-snapshot.cjs /evolution/nexi-attendance-snapshot.cjs
COPY --from=source-builder /evolution/nexi-attendance-authority.cjs /evolution/nexi-attendance-authority.cjs
COPY --from=source-builder /evolution/nexi-attendance-dispatch.cjs /evolution/nexi-attendance-dispatch.cjs
COPY --from=source-builder /evolution/nexi-attendance-isolated.cjs /evolution/nexi-attendance-isolated.cjs
COPY --from=source-builder /evolution/nexi-attendance-storage-guard.cjs /evolution/nexi-attendance-storage-guard.cjs
COPY --from=source-builder /evolution/nexi-attendance-storage-check.cjs /evolution/nexi-attendance-storage-check.cjs
COPY --from=source-builder /evolution/fixtures /evolution/fixtures
COPY --from=source-builder /evolution/node_modules/baileys /evolution/node_modules/baileys
COPY --from=source-builder /evolution/node_modules/libsignal /evolution/node_modules/libsignal
COPY select-provider-bundle.cjs /evolution/select-provider-bundle.cjs
COPY assert-runtime-model.mjs /tmp/assert-runtime-model.mjs
COPY assert-groups-runtime.mjs /tmp/assert-groups-runtime.mjs
COPY assert-attendance-runtime.mjs /tmp/assert-attendance-runtime.mjs
COPY assert-protected-send-node.cjs /tmp/assert-protected-send-node.cjs
COPY assert-baileys-transport-runtime.mjs /tmp/assert-baileys-transport-runtime.mjs
COPY assert-ingress-runtime.mjs /evolution/assert-ingress-runtime.mjs
COPY nexi-start.sh /evolution/nexi-start.sh
COPY ops/s12-release-current-boot.cjs /evolution/ops/s12-release-current-boot.cjs

RUN set -eu; \
    test -f /evolution/prisma.config.ts; \
    test -f /evolution/ops/s12-release-current-boot.cjs; \
    node --check /evolution/ops/s12-release-current-boot.cjs; \
    test -f /evolution/prisma/postgresql-schema.prisma; \
    test -f /evolution/prisma/psql_bouncer-schema.prisma; \
    test -f /evolution/prisma/mysql-schema.prisma; \
    test -f /evolution/select-provider-bundle.cjs; \
    test -f /evolution/Docker/scripts/deploy_database.sh; \
    test -f /evolution/runWithProvider.js; \
    for provider in mysql postgresql; do \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-runtime-model.mjs; \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-groups-runtime.mjs; \
      EVOLUTION_PROVIDER="$provider" EVOLUTION_BUNDLE_PATH="/evolution/dist/providers/$provider.js" node /tmp/assert-attendance-runtime.mjs; \
    done; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_SKIP_GENERATED=1 EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /tmp/assert-runtime-model.mjs; \
    EVOLUTION_PROVIDER=postgresql EVOLUTION_SCHEMA_PROVIDER=psql_bouncer EVOLUTION_BUNDLE_PATH=/evolution/dist/providers/psql_bouncer.js node /tmp/assert-attendance-runtime.mjs; \
    EVOLUTION_PROVIDER=postgresql node /tmp/assert-runtime-model.mjs && \
    node /tmp/assert-baileys-transport-runtime.mjs /evolution && \
    node /evolution/assert-ingress-runtime.mjs /evolution && \
    rm /tmp/assert-runtime-model.mjs
ENTRYPOINT ["/bin/sh", "/evolution/nexi-start.sh"]
CMD []
