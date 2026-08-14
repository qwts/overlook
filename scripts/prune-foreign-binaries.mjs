#!/usr/bin/env node
// electron-builder afterPack hook: drop the native binaries of bundled
// multi-platform packages that this build can never load.
//
// Most native dependencies here ship one package per platform (sqlite-vec's
// sqlite-vec-darwin-arm64 and friends), so npm installs only the matching one
// and nothing foreign reaches the app. onnxruntime-node instead ships every
// platform inside a single package —
// bin/napi-v6/{darwin,linux,win32}/{arm64,x64} — so every build packaged all
// six. On Windows that fails verify-windows-arch (#683) with three "not a PE
// image" errors (the Mach-O and ELF bindings) plus the win32/arm64 binding in
// the x64 build; on macOS the same surplus ships silently, because no
// equivalent gate exists there. Either way the installer carries binaries it
// will never dlopen — including DirectML.dll and the onnxruntime shared
// libraries, which asarUnpack deliberately leaves unpacked beside the archive.
//
// Pruning here rather than through electron-builder `files` patterns is
// deliberate: the cross-compiled Windows arm64 build runs on an x64 runner and
// needs the opposite exclusion from the x64 build on that same machine, which a
// static pattern cannot express. The hook receives the target from the packer
// itself, and #683's verifier then proves the result on every Windows build.

import { readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { buildFileProviderExtension } from './build-file-provider-extension.mjs';

// Package-relative roots whose immediate layout is <platform>/<arch>/.
export const BUNDLED_MULTI_PLATFORM_ROOTS = ['node_modules/onnxruntime-node/bin/napi-v6'];

// electron-builder's Arch enum is numeric; only the targets this app builds for
// are mapped. An unmapped arch prunes nothing rather than guessing wrong.
export const ARCH_NAME = { 1: 'x64', 3: 'arm64' };

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

export async function pruneForeignBinaries(appOutDir, targetPlatform, targetArch) {
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
      : `prune-foreign-binaries: removed ${removed.length} foreign binary director${removed.length === 1 ? 'y' : 'ies'} for ${targetPlatform}/${targetArch}.`,
  );
  for (const path of removed) console.log(`  - ${path}`);
  if (targetPlatform === 'darwin') {
    const extension = buildFileProviderExtension(
      context.appOutDir,
      context.packager.appInfo.productFilename,
      context.packager.appInfo.version,
      context.packager.appInfo.buildVersion,
    );
    if (extension !== null) console.log(`file-provider-extension: built ${extension}`);
  }
}
