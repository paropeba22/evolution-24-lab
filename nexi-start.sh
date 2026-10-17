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
# A release belongs to this exact runtime boot. Restarting never inherits it,
# even if /tmp is retained. This is an operational send hold, not a Signal drain.
NEXI_ATTENDANCE_CUTOVER_BOOT_ID="$(node -e 'const fs=require("node:fs"),id=require("node:crypto").randomUUID();fs.writeFileSync("/tmp/nexi-attendance-cutover-current.json",JSON.stringify({boot_id:id,hold:process.env.NEXI_ATTENDANCE_CUTOVER_HOLD==="true"}),{mode:0o600});process.stdout.write(id)')"
export NEXI_ATTENDANCE_CUTOVER_BOOT_ID
echo "NEXI cutover boot_id=$NEXI_ATTENDANCE_CUTOVER_BOOT_ID"
exec node --network-family-autoselection-attempt-timeout=1000 /evolution/dist/main.js
