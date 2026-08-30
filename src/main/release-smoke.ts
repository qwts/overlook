import { realpathSync, writeSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { ICLOUD_NATIVE_SMOKE_ARGUMENT, runICloudNativeSmokeIfRequested } from './backup/icloud-drive/native-smoke.js';
import { ICLOUD_LIVE_CONTRACT_ARGUMENT, runICloudLiveContractIfRequested } from './backup/icloud-drive/live-contract.js';
import { createReleaseImportSmokeRunner } from './release-import-smoke.js';
import type { ImportService } from './import/import-runtime.js';
import type { LibraryParts } from './library/library-parts.js';

export const RELEASE_SMOKE_ARGUMENT = '--overlook-release-smoke';
export const RELEASE_SMOKE_READY_MARKER = 'overlook-release-smoke:ready';
export const RELEASE_IMPORT_SMOKE_ARGUMENT = '--overlook-release-import-smoke';
export const RELEASE_IMPORT_SMOKE_READY_MARKER = 'overlook-release-import-smoke:ready';
export const RELEASE_IMPORT_SMOKE_ERROR_MARKER = 'overlook-release-import-smoke:error';
export const RELEASE_IMPORT_SMOKE_PROGRESS_MARKER = 'overlook-release-import-smoke:progress';
const RELEASE_IMPORT_SOURCE_ARGUMENT = '--overlook-release-import-source=';
const RELEASE_IMPORT_PROFILE_ARGUMENT = '--overlook-release-import-profile=';

interface ReleaseSmokeApp {
  readonly isPackaged: boolean;
  getPath(name: 'userData'): string;
  exit(code: number): void;
}

interface ReleaseSmokeProfileApp {
  readonly isPackaged: boolean;
}

export interface ReleaseImportSmokeRequest {
  readonly sourcePath: string;
  readonly profilePath: string;
}

let releaseImportSmokeRunner: (request: ReleaseImportSmokeRequest) => Promise<void> = () =>
  Promise.reject(new Error('import smoke runner unavailable'));

export function configureReleaseImportSmoke(
  getImportService: () => ImportService,
  requireParts: (what: string) => LibraryParts,
  closeLibrary: () => Promise<void> | undefined,
): void {
  releaseImportSmokeRunner = createReleaseImportSmokeRunner(getImportService, requireParts, closeLibrary, (stage) => {
    writeSync(process.stdout.fd, `${RELEASE_IMPORT_SMOKE_PROGRESS_MARKER}:${stage}\n`);
  });
}

function argumentValue(argv: readonly string[], prefix: string): string | undefined {
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function isolatedReleaseImportProfile(profilePath: string): string {
  if (!isAbsolute(profilePath)) throw new Error('release import profile must be an absolute path');
  const resolvedProfile = realpathSync(resolve(profilePath));
  const tempRelation = relative(realpathSync(resolve(tmpdir())), resolvedProfile);
  if (
    tempRelation === '' ||
    tempRelation.startsWith('..') ||
    isAbsolute(tempRelation) ||
    !tempRelation.split(/[\\/]/u).some((part) => part.startsWith('overlook-release-import-smoke-'))
  ) {
    throw new Error('release import profile must be an isolated Overlook smoke directory under the system temp directory');
  }
  return resolvedProfile;
}

export function releaseImportSmokeProfileIfRequested(
  app: ReleaseSmokeProfileApp,
  argv: readonly string[] = process.argv,
): string | undefined {
  if (!app.isPackaged || !argv.includes(RELEASE_IMPORT_SMOKE_ARGUMENT)) return undefined;
  return isolatedReleaseImportProfile(argumentValue(argv, RELEASE_IMPORT_PROFILE_ARGUMENT) ?? '');
}

export async function parseReleaseImportSmokeRequest(app: ReleaseSmokeApp, argv: readonly string[]): Promise<ReleaseImportSmokeRequest> {
  if (!app.isPackaged) throw new Error('release import smoke requires a packaged application');
  const sourcePath = argumentValue(argv, RELEASE_IMPORT_SOURCE_ARGUMENT) ?? '';
  const profilePath = argumentValue(argv, RELEASE_IMPORT_PROFILE_ARGUMENT) ?? '';
  if (!isAbsolute(sourcePath)) throw new Error('release import source must be an absolute path');
  const resolvedProfile = await realpath(isolatedReleaseImportProfile(profilePath));
  if ((await realpath(resolve(app.getPath('userData')))) !== resolvedProfile) {
    throw new Error('release import profile does not match Electron userData');
  }
  return { sourcePath: resolve(sourcePath), profilePath: resolvedProfile };
}

export async function exitForReleaseSmokeIfRequested(
  app: ReleaseSmokeApp,
  argv: readonly string[] = process.argv,
  write: (value: string) => unknown = (value) => writeSync(process.stdout.fd, value),
  runImportSmoke: (request: ReleaseImportSmokeRequest) => Promise<void> = releaseImportSmokeRunner,
): Promise<boolean> {
  if (argv.includes(ICLOUD_LIVE_CONTRACT_ARGUMENT)) {
    return runICloudLiveContractIfRequested(app, { argv, write });
  }
  if (argv.includes(ICLOUD_NATIVE_SMOKE_ARGUMENT)) {
    return runICloudNativeSmokeIfRequested(app, { argv, write });
  }
  if (argv.includes(RELEASE_IMPORT_SMOKE_ARGUMENT)) {
    try {
      const request = await parseReleaseImportSmokeRequest(app, argv);
      await runImportSmoke(request);
      write(`${RELEASE_IMPORT_SMOKE_READY_MARKER}\n`);
      app.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`${RELEASE_IMPORT_SMOKE_ERROR_MARKER}:${message}\n`);
      app.exit(1);
    }
    return true;
  }
  if (!argv.includes(RELEASE_SMOKE_ARGUMENT)) return false;
  write(`${RELEASE_SMOKE_READY_MARKER}\n`);
  app.exit(0);
  return true;
}
