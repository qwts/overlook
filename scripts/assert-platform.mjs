#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export function assertPlatform(expectedPlatform, expectedArchitecture, actual = process) {
  if (actual.platform !== expectedPlatform || actual.arch !== expectedArchitecture) {
    throw new Error(`runner is ${actual.platform}/${actual.arch}; expected ${expectedPlatform}/${expectedArchitecture}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [expectedPlatform, expectedArchitecture] = process.argv.slice(2);
  if (expectedPlatform === undefined || expectedArchitecture === undefined) {
    throw new Error('usage: assert-platform.mjs <platform> <architecture>');
  }
  assertPlatform(expectedPlatform, expectedArchitecture);
}
