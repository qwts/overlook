import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { OVERLOOK_ICLOUD_NATIVE_HOST, nativeHostManifest } from './icloud-native-host.js';
import { InteropTransportError } from './transport.js';
import { createWindowsNativeHostRegistry, type WindowsNativeHostRegistry } from './windows-native-host-registry.js';

const CHROMIUM_HOST_DIRECTORIES = [
  ['Google', 'Chrome', 'NativeMessagingHosts'],
  ['Chromium', 'NativeMessagingHosts'],
  ['BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
  ['Microsoft Edge', 'NativeMessagingHosts'],
] as const;

export const NATIVE_HOST_UNREGISTER_ARGUMENT = '--unregister-native-host';
export const NATIVE_HOST_REGISTER_ARGUMENT = '--register-native-host';

export interface NativeHostRegistrationOptions {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly applicationSupportDirectory: string;
  readonly executablePath: string;
  readonly extensionId: string | null;
  readonly windowsRegistry?: WindowsNativeHostRegistry;
}

export interface NativeHostInvocation {
  readonly requested: boolean;
  readonly origin: string | null;
  readonly authorized: boolean;
}

export function nativeHostUnregisterRequested(argv: readonly string[]): boolean {
  return argv.includes(NATIVE_HOST_UNREGISTER_ARGUMENT);
}

export function nativeHostRegisterRequested(argv: readonly string[]): boolean {
  return argv.includes(NATIVE_HOST_REGISTER_ARGUMENT);
}

export function nativeHostInvocation(argv: readonly string[], extensionId: string | null): NativeHostInvocation {
  const origin = argv.find((argument) => argument.startsWith('chrome-extension://')) ?? null;
  if (origin === null) return { requested: false, origin: null, authorized: false };
  const expected = extensionId === null ? null : `chrome-extension://${extensionId}/`;
  return { requested: true, origin, authorized: origin === expected };
}

async function writeManifest(path: string, contents: string): Promise<boolean> {
  try {
    if ((await readFile(path, 'utf8')) === contents) return false;
  } catch {
    // Missing or unreadable manifests are repaired atomically below.
  }
  const staged = `${path}.${String(process.pid)}.tmp`;
  await writeFile(staged, contents, { mode: 0o600 });
  await rename(staged, path);
  return true;
}

/** Installs or repairs user-level Chromium manifests on supported packaged
 * macOS and Windows builds. The app executable is the signed native host; no
 * script or unsigned helper is introduced. */
export async function registerICloudNativeHost(options: NativeHostRegistrationOptions): Promise<readonly string[]> {
  if (!options.packaged || options.extensionId === null) return [];
  const manifest = `${JSON.stringify(nativeHostManifest(options.executablePath, options.extensionId), null, 2)}\n`;
  if (options.platform === 'win32') {
    try {
      const path = windowsManifestPath(options);
      await mkdir(join(options.applicationSupportDirectory, 'Overlook', 'NativeMessagingHosts'), { recursive: true, mode: 0o700 });
      await writeManifest(path, manifest);
      (options.windowsRegistry ?? createWindowsNativeHostRegistry()).register(path);
      return [path];
    } catch {
      // A damaged per-user registry key or manifest directory disables the
      // affected browser integration, never the signed desktop application.
      return [];
    }
  }
  if (options.platform !== 'darwin') return [];
  const installed: string[] = [];
  for (const segments of CHROMIUM_HOST_DIRECTORIES) {
    try {
      const directory = join(options.applicationSupportDirectory, ...segments);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${OVERLOOK_ICLOUD_NATIVE_HOST}.json`);
      await writeManifest(path, manifest);
      installed.push(path);
    } catch {
      // A damaged browser profile must not prevent the desktop from starting
      // or block registration for the remaining installed browsers.
    }
  }
  return installed;
}

/** Removes only manifests owned by this exact signed app invocation. An older
 * app copy must not unregister a newer installation that already repaired the
 * canonical browser manifest paths. */
export async function unregisterICloudNativeHost(options: NativeHostRegistrationOptions): Promise<readonly string[]> {
  if (!options.packaged || options.extensionId === null) return [];
  const expected = nativeHostManifest(options.executablePath, options.extensionId);
  if (options.platform === 'win32') {
    const path = windowsManifestPath(options);
    (options.windowsRegistry ?? createWindowsNativeHostRegistry()).unregister(path);
    return (await removeOwnedManifest(path, expected)) ? [path] : [];
  }
  if (options.platform !== 'darwin') return [];
  const removed: string[] = [];
  for (const segments of CHROMIUM_HOST_DIRECTORIES) {
    const path = join(options.applicationSupportDirectory, ...segments, `${OVERLOOK_ICLOUD_NATIVE_HOST}.json`);
    const claimed = `${path}.${String(process.pid)}.${randomUUID()}.unregister`;
    try {
      await rename(path, claimed);
    } catch {
      continue;
    }
    try {
      const actual = JSON.parse(await readFile(claimed, 'utf8')) as unknown;
      if (!isDeepStrictEqual(actual, expected)) {
        await restoreClaimedManifest(claimed, path);
        continue;
      }
      await unlink(claimed);
      removed.push(path);
    } catch {
      await restoreClaimedManifest(claimed, path);
    }
  }
  return removed;
}

function windowsManifestPath(options: NativeHostRegistrationOptions): string {
  const owner = createHash('sha256').update(options.executablePath, 'utf8').digest('hex').slice(0, 24);
  return join(options.applicationSupportDirectory, 'Overlook', 'NativeMessagingHosts', `${OVERLOOK_ICLOUD_NATIVE_HOST}-${owner}.json`);
}

async function removeOwnedManifest(path: string, expected: unknown): Promise<boolean> {
  const claimed = `${path}.${String(process.pid)}.${randomUUID()}.unregister`;
  try {
    await rename(path, claimed);
  } catch {
    return false;
  }
  try {
    const actual = JSON.parse(await readFile(claimed, 'utf8')) as unknown;
    if (!isDeepStrictEqual(actual, expected)) {
      await restoreClaimedManifest(claimed, path);
      return false;
    }
    await unlink(claimed);
    return true;
  } catch {
    await restoreClaimedManifest(claimed, path);
    return false;
  }
}

async function restoreClaimedManifest(claimed: string, path: string): Promise<void> {
  try {
    await link(claimed, path);
    await unlink(claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') await unlink(claimed).catch(() => undefined);
  }
}

export function assertAuthorizedNativeHostInvocation(invocation: NativeHostInvocation): void {
  if (!invocation.requested || !invocation.authorized)
    throw new InteropTransportError('Native host rejected the extension origin.', 'unsupported', false);
}
