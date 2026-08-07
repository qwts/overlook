'use strict';

const extension = process.arch === 'arm64' ? 'armv8.node' : 'node';
module.exports = require(`./prebuilds/darwin-${process.arch}/photokit.node.napi.${extension}`);
