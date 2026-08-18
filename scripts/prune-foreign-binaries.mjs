#!/usr/bin/env node
// electron-builder afterPack hook: drop the native binaries of bundled
// multi-platform packages that this build can never load.
//
// Most native dependencies here ship one package per platform (sqlite-vec's
// sqlite-vec-darwin-arm64 and friends), so npm installs only the matching one.
// Two runtime packages instead bundle every target in one package:
//
// - onnxruntime-node: bin/napi-v6/<platform>/<arch>/
// - better-sqlite3-multiple-ciphers v13: prebuilds/<platform>-<arch>.node
//
// On Windows those foreign files fail verify-windows-arch (#683) with non-PE
// or wrong-machine errors; on macOS the same surplus would ship silently.
// Either way the installer must not carry binaries it can never dlopen.
//
// Pruning here rather than through electron-builder `files` patterns is
// deliberate: the cross-compiled Windows arm64 build runs on an x64 runner and
// needs the opposite exclusion from the x64 build on that same machine, which a
// static pattern cannot express. The hook receives the target from the packer
// itself, and #683's verifier then proves the result on every Windows build.

import { readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { buildFileProviderExtension } from './build-file-provider-extension.mjs';
import { buildQuickLookExtension } from './build-quick-look-extension.mjs';

// Package-relative roots whose immediate layout is <platform>/<arch>/.
export const BUNDLED_MULTI_PLATFORM_ROOTS = ['node_modules/onnxruntime-node/bin/napi-v6'];

// Package-relative roots whose files are <platform>-<arch>.node.
export const BUNDLED_FLAT_PREBUILD_ROOTS = ['node_modules/better-sqlite3-multiple-ciphers/prebuilds'];

// electron-builder's Arch enum is numeric; only the targets this app builds for
// are mapped. An unmapped arch prunes nothing rather than guessing wrong.
export const ARCH_NAME = { 1: 'x64', 3: 'arm64', 4: 'universal' };

// A universal macOS build genuinely needs both darwin slices; every other
// target wants exactly one platform/arch pair.
export function keepsArch(targetArch, candidateArch) {
  return targetArch === 'universal' ? true : candidateArch === targetArch;
}

// The single decision this hook makes, kept pure so it can be tested without
// packing an app: does this <platform>/<arch> pair belong in this build?
export function isForeign(platformDir, archDir, targetPlatform, targetArch) {
  if (platformDir !== targetPlatform) return true;
  return !keepsArch(targetArch, archDir);
}

const FLAT_PREBUILD_NAME = /^(darwin|linux|linuxmusl|win32)-(arm64|x64)\.node$/u;

export function flatPrebuildTarget(fileName) {
  const match = FLAT_PREBUILD_NAME.exec(fileName);
  if (!match) return undefined;
  return { platform: match[1], arch: match[2] };
}

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent root: nothing bundled here, nothing to prune
  }
}

// Walk to the packaged app's node_modules. Layout differs per platform
// (Contents/Resources on macOS, resources elsewhere) and electron-builder may
// nest the app under a product-named directory, so search rather than hardcode.
export async function findRoots(appOutDir, relativeRoot, depth = 10) {
  const marker = relativeRoot.split('/');
  const found = [];
  const walk = async (dir, remaining) => {
    if (remaining < 0) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      // Compare trailing segments so the match is layout-independent and the
      // separator is whatever this OS uses.
      if (child.split(sep).slice(-marker.length).join('/') === relativeRoot) {
        found.push(child);
        continue; // the root itself is the target; its children are the payload
      }
      await walk(child, remaining - 1);
    }
  };
  await walk(appOutDir, depth);
  return found;
}

async function pruneNestedBinaries(appOutDir, targetPlatform, targetArch) {
  const removed = [];
  for (const relativeRoot of BUNDLED_MULTI_PLATFORM_ROOTS) {
    for (const root of await findRoots(appOutDir, relativeRoot)) {
      for (const platformEntry of await entries(root)) {
        if (!platformEntry.isDirectory()) continue;
        const platformDir = join(root, platformEntry.name);
        for (const archEntry of await entries(platformDir)) {
          if (!archEntry.isDirectory()) continue;
          if (!isForeign(platformEntry.name, archEntry.name, targetPlatform, targetArch)) continue;
          const target = join(platformDir, archEntry.name);
          await rm(target, { recursive: true, force: true });
          removed.push(target);
        }
        // A platform directory emptied by the loop above is itself surplus.
        if ((await entries(platformDir)).length === 0) await rm(platformDir, { recursive: true, force: true });
      }
    }
  }
  return removed;
}

async function pruneFlatPrebuilds(appOutDir, targetPlatform, targetArch) {
  const removed = [];
  for (const relativeRoot of BUNDLED_FLAT_PREBUILD_ROOTS) {
    for (const root of await findRoots(appOutDir, relativeRoot)) {
      for (const entry of await entries(root)) {
        if (!entry.isFile()) continue;
        const candidate = flatPrebuildTarget(entry.name);
        // Unknown files are package metadata or a future layout. Preserve them
        // rather than guessing and deleting a target binary.
        if (!candidate || !isForeign(candidate.platform, candidate.arch, targetPlatform, targetArch)) continue;
        const target = join(root, entry.name);
        await rm(target, { force: true });
        removed.push(target);
      }
    }
  }
  return removed;
}

export async function pruneForeignBinaries(appOutDir, targetPlatform, targetArch) {
  return [
    ...(await pruneNestedBinaries(appOutDir, targetPlatform, targetArch)),
    ...(await pruneFlatPrebuilds(appOutDir, targetPlatform, targetArch)),
  ];
}

export default async function afterPack(context) {
  const targetPlatform = context.electronPlatformName;
  const targetArch = ARCH_NAME[context.arch];
  if (!targetArch) {
    console.log(`prune-foreign-binaries: unmapped arch ${context.arch}; keeping every bundled binary.`);
    return;
  }
  const removed = await pruneForeignBinaries(context.appOutDir, targetPlatform, targetArch);
  console.log(
    removed.length === 0
      ? `prune-foreign-binaries: nothing foreign for ${targetPlatform}/${targetArch}.`
      : `prune-foreign-binaries: removed ${removed.length} foreign binary path${removed.length === 1 ? '' : 's'} for ${targetPlatform}/${targetArch}.`,
  );
  for (const path of removed) console.log(`  - ${path}`);
  if (targetPlatform === 'darwin') {
    const quickLook = buildQuickLookExtension(
      context.appOutDir,
      context.packager.appInfo.productFilename,
      context.packager.appInfo.version,
      context.packager.appInfo.buildVersion,
    );
    console.log(`quick-look-extension: built ${quickLook}`);
    const extension = buildFileProviderExtension(
      context.appOutDir,
      context.packager.appInfo.productFilename,
      context.packager.appInfo.version,
      context.packager.appInfo.buildVersion,
    );
    if (extension !== null) console.log(`file-provider-extension: built ${extension}`);
  }
}
