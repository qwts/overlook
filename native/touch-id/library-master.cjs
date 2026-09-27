'use strict';

const extension = process.arch === 'arm64' ? 'armv8.node' : 'node';
module.exports = require(`./prebuilds/darwin-${process.arch}/library-master.node.napi.${extension}`);
