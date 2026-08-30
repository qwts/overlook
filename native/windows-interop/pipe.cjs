'use strict';

if (process.platform !== 'win32' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`unsupported Windows interop runtime: ${process.platform}-${process.arch}`);
}

const extension = process.arch === 'arm64' ? 'armv8.node' : 'node';
module.exports = require(`./prebuilds/win32-${process.arch}/pipe.node.napi.${extension}`);
