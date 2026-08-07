'use strict';

const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`unsupported Touch ID build target: ${process.platform}-${process.arch}`);
}

const extension = process.arch === 'arm64' ? 'armv8.node' : 'node';
const targetDirectory = join(__dirname, 'prebuilds', `darwin-${process.arch}`);
mkdirSync(targetDirectory, { recursive: true });
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_touch_id.node'), join(targetDirectory, `node.napi.${extension}`));
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_raw_preview.node'), join(targetDirectory, `raw.node.napi.${extension}`));
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_icloud_drive.node'), join(targetDirectory, `icloud.node.napi.${extension}`));
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_native_drag.node'), join(targetDirectory, `drag.node.napi.${extension}`));
copyFileSync(join(__dirname, 'build', 'Release', 'overlook_photokit.node'), join(targetDirectory, `photokit.node.napi.${extension}`));
