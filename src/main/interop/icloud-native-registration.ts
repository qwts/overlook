import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OVERLOOK_ICLOUD_NATIVE_HOST, nativeHostManifest } from './icloud-native-host.js';
import { InteropTransportError } from './transport.js';

const CHROMIUM_HOST_DIRECTORIES = [
  ['Google', 'Chrome', 'NativeMessagingHosts'],
  ['Chromium', 'NativeMessagingHosts'],
  ['BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
  ['Microsoft Edge', 'NativeMessagingHosts'],
] as const;

export interface NativeHostRegistrationOptions {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly applicationSupportDirectory: string;
  readonly executablePath: string;
  readonly extensionId: string | null;
}

export interface NativeHostInvocation {
  readonly requested: boolean;
  readonly origin: string | null;
  readonly authorized: boolean;
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
 * macOS builds. The app executable is the signed native host; no script or
 * unsigned helper is introduced. */
export async function registerICloudNativeHost(options: NativeHostRegistrationOptions): Promise<readonly string[]> {
  if (options.platform !== 'darwin' || !options.packaged || options.extensionId === null) return [];
  const manifest = `${JSON.stringify(nativeHostManifest(options.executablePath, options.extensionId), null, 2)}\n`;
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

export function assertAuthorizedNativeHostInvocation(invocation: NativeHostInvocation): void {
  if (!invocation.requested || !invocation.authorized)
    throw new InteropTransportError('Native host rejected the extension origin.', 'unsupported', false);
}
