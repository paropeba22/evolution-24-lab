#!/bin/sh
# Retire the inherited deploy helper: it prints a database URL and invokes
# unreviewed migration/generation paths. Never read/source environment helpers,
# print arguments/settings, or invoke Prisma from this compatibility path.
set +x +v
printf '%s\n' 'NEXI database maintenance is disabled in this helper; use the separately approved maintenance job.' >&2
exit 78
