import fs from 'node:fs';

const bundlePath = process.env.EVOLUTION_BUNDLE_PATH || '/evolution/dist/main.js';
const marker = 'evo24-lab-instance-create-fix';

let code = fs.readFileSync(bundlePath, 'utf8');

if (code.includes(marker)) {
  console.log('[evolution-24-lab] instance create patch already applied');
  process.exit(0);
}

const createPattern =
  /([$A-Za-z_][$\w]*)\.originalUrl\.includes\((["'])\/instance\/create\2\)\s*&&\s*Object\.assign\(\s*([$A-Za-z_][$\w]*)\s*,\s*([$A-Za-z_][$\w]*)\(\s*([$A-Za-z_][$\w]*)\s*\)\s*\)/;

const match = code.match(createPattern);

if (!match) {
  const markerIndex = code.indexOf('/instance/create');
  const context =
    markerIndex >= 0
      ? code.slice(Math.max(0, markerIndex - 500), markerIndex + 700)
      : 'marker /instance/create not found';

  throw new Error(
    '[evolution-24-lab] could not locate the instance/create sanitizer in dist/main.js. Context:\n' +
      context,
  );
}

const [, requestVar, quote, instanceVar, sanitizerVar, bodyVar] = match;

const replacement =
  `${requestVar}.originalUrl.includes(${quote}/instance/create${quote})&&(` +
  `/* ${marker} */Object.assign(${instanceVar},${sanitizerVar}(${bodyVar})),` +
  `typeof ${bodyVar}?.instanceName==="string"&&(${instanceVar}.instanceName=${bodyVar}.instanceName))`;

code = code.replace(createPattern, replacement);
fs.writeFileSync(bundlePath, code);

console.log('[evolution-24-lab] patched /instance/create to preserve body.instanceName');
