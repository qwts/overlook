'use strict';

const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const targetArch = process.argv[2] || process.env.npm_config_arch || process.arch;
if (process.platform !== 'win32' || !['arm64', 'x64'].includes(targetArch)) {
  throw new Error(`unsupported Windows interop build target: ${process.platform}-${targetArch}`);
}

const extension = targetArch === 'arm64' ? 'armv8.node' : 'node';
const targetDirectory = join(__dirname, 'prebuilds', `win32-${targetArch}`);
mkdirSync(targetDirectory, { recursive: true });
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_windows_pipe.node'), join(targetDirectory, `pipe.node.napi.${extension}`));
