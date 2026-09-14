// Collects the licence texts shipped with Sipper for Windows into build/licences, which the
// installer places in resources\Licenses: Sipper's licence, PJSIP and the libraries built into the
// engine (from scripts/build-pjsip.ps1), cJSON, Preact and htm, and the Fluent icons.
// electron-builder adds the Electron and Chromium notices next to Sipper.exe itself.
//
//   node scripts/copy-licences.mjs [folder with the PJSIP build's licences]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(windowsRoot, '..');
const engineLicences = process.argv[2] ?? path.join(windowsRoot, 'vendor', 'pjsip-win', 'licences');
const out = path.join(windowsRoot, 'build', 'licences');
const buildInfo = path.join(path.dirname(engineLicences), 'BUILD-INFO.txt');

const components = [
  ['Sipper', 'GNU GPL version 3 or later', path.join(repository, 'LICENSE'), 'Sipper.txt'],
  ['PJSIP', 'GNU GPL version 2 or later', path.join(engineLicences, 'PJSIP.txt'), 'PJSIP.txt'],
  ['Opus', 'BSD 3-clause, with royalty-free patent licences', path.join(engineLicences, 'Opus.txt'), 'Opus.txt'],
  ['libsrtp (Cisco Systems)', 'BSD 3-clause', path.join(engineLicences, 'libsrtp.txt'), 'libsrtp.txt'],
  ['Speex (Xiph.Org Foundation)', 'BSD 3-clause', path.join(engineLicences, 'Speex.txt'), 'Speex.txt'],
  ['WebRTC echo canceller', 'BSD 3-clause', path.join(engineLicences, 'WebRTC.txt'), 'WebRTC.txt'],
  ['libresample', 'GNU LGPL version 2.1', path.join(engineLicences, 'libresample.txt'), 'libresample.txt'],
  ['GSM 06.10 (TU Berlin)', 'notice-preserving permissive licence', path.join(engineLicences, 'GSM.txt'), 'GSM.txt'],
  ['cJSON', 'MIT', path.join(windowsRoot, 'engine', 'third_party', 'cjson', 'LICENSE'), 'cJSON.txt'],
  ['Preact', 'MIT', path.join(windowsRoot, 'node_modules', 'preact', 'LICENSE'), 'Preact.txt'],
  ['htm', 'Apache License 2.0', path.join(windowsRoot, 'node_modules', 'htm', 'LICENSE'), 'htm.txt'],
  ['Fluent UI System Icons (Microsoft)', 'MIT', path.join(windowsRoot, 'src', 'renderer', 'icons-LICENSE.txt'), 'Fluent-UI-System-Icons.txt'],
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const missing = components.filter(([, , from]) => !fs.existsSync(from));
if (missing.length > 0) {
  console.error(`error: licence files missing:\n${missing.map(([, , from]) => `  ${from}`).join('\n')}`);
  console.error('Build PJSIP first (scripts/build-pjsip.ps1) and install dependencies (npm ci).');
  process.exit(1);
}
for (const [, , from, name] of components) fs.copyFileSync(from, path.join(out, name));

const width = Math.max(...components.map(([name]) => name.length));
const licenceWidth = Math.max(...components.map(([, licence]) => licence.length));
const versions = fs.existsSync(buildInfo) ? fs.readFileSync(buildInfo, 'utf8').split(/\r?\n/).slice(0, 2).join('\n') : '';
fs.writeFileSync(path.join(out, 'README.txt'), [
  'Sipper for Windows includes the software below. The full licence texts are in this folder.',
  'The Electron and Chromium notices are LICENSE.electron.txt and LICENSES.chromium.html in the folder that holds Sipper.exe.',
  '',
  ...components.map(([name, licence, , file]) => `${name.padEnd(width)}  ${licence.padEnd(licenceWidth)}  ${file}`),
  '',
  versions,
  'Source code: https://github.com/hybes/sipper',
  '',
].join('\r\n'));

console.log(`Wrote ${components.length} licence texts to ${out}`);
