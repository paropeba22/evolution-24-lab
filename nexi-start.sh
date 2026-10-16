#!/bin/sh
# Runtime only. Schema changes are a separate, explicitly authorized operation.
set -eu
cd /evolution
if [ "$#" -ne 0 ]; then
  echo 'NEXI runtime entrypoint accepts no operational commands; use an explicit entrypoint override for maintenance.' >&2
  exit 64
fi
node /evolution/select-provider-bundle.cjs
# Preserve the public version metadata previously supplied by npm start:prod.
npm_package_version="$(node -p 'require("/evolution/package.json").version')"
export npm_package_version
exec node --network-family-autoselection-attempt-timeout=1000 /evolution/dist/main.js
