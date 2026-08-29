'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const targetArch = process.argv[2] || process.env.npm_config_arch || process.arch;
if (process.platform !== 'win32' || !['arm64', 'x64'].includes(targetArch)) {
  process.stdout.write(`Skipping Windows interop native build on ${process.platform}-${targetArch}.\n`);
  process.exit(0);
}

const environment = { ...process.env, npm_config_arch: targetArch };
const nodeGyp = join(__dirname, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
execFileSync(process.execPath, [nodeGyp, 'rebuild', `--arch=${targetArch}`], {
  env: environment,
  stdio: 'inherit',
});
execFileSync(process.execPath, [require.resolve('./prepare-prebuild.cjs'), targetArch], {
  env: environment,
  stdio: 'inherit',
});
