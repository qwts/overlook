import { appendFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

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
const RELEASE_IMPORT_RESULT_ARGUMENT = '--overlook-release-import-result=';
const RELEASE_IMPORT_SOURCE_ENV = 'OVERLOOK_RELEASE_IMPORT_SMOKE_SOURCE';
const RELEASE_IMPORT_PROFILE_ENV = 'OVERLOOK_RELEASE_IMPORT_SMOKE_PROFILE';
const RELEASE_IMPORT_RESULT_ENV = 'OVERLOOK_RELEASE_IMPORT_SMOKE_RESULT';
const RELEASE_IMPORT_HARNESS_ENV = 'OVERLOOK_RELEASE_IMPORT_SMOKE_HARNESS';
const RELEASE_IMPORT_RESULT_FILE = 'release-import-result.txt';

interface ReleaseSmokeApp {
  readonly isPackaged: boolean;
  getAppPath?(): string;
  getPath(name: 'userData'): string;
  exit(code: number): void;
}

interface ReleaseSmokeProfileApp {
  readonly isPackaged: boolean;
  getAppPath?(): string;
}

export interface ReleaseImportSmokeRequest {
  readonly sourcePath: string;
  readonly profilePath: string;
}

let releaseImportSmokeRunner: (request: ReleaseImportSmokeRequest) => Promise<void> = () =>
  Promise.reject(new Error('import smoke runner unavailable'));
let releaseImportSmokeResultPath: string | undefined;

function recordReleaseImportSmoke(value: string): void {
  if (releaseImportSmokeResultPath !== undefined) appendFileSync(releaseImportSmokeResultPath, `${value}\n`, 'utf8');
}

export function configureReleaseImportSmoke(
  getImportService: () => ImportService,
  requireParts: (what: string) => LibraryParts,
  closeLibrary: () => Promise<void> | undefined,
): void {
  releaseImportSmokeRunner = createReleaseImportSmokeRunner(getImportService, requireParts, closeLibrary, (stage) => {
    const value = `${RELEASE_IMPORT_SMOKE_PROGRESS_MARKER}:${stage}`;
    writeSync(process.stdout.fd, `${value}\n`);
    recordReleaseImportSmoke(value);
  });
}

function argumentValue(argv: readonly string[], prefix: string): string | undefined {
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function smokeValue(argv: readonly string[], prefix: string, environmentName: string, environment: NodeJS.ProcessEnv): string | undefined {
  return argumentValue(argv, prefix) ?? environment[environmentName];
}

function isReleaseImportRuntime(app: ReleaseSmokeProfileApp, environment: NodeJS.ProcessEnv): boolean {
  if (app.isPackaged) return true;
  if (environment[RELEASE_IMPORT_HARNESS_ENV] !== '1') return false;
  const appPath = app.getAppPath?.();
  if (appPath === undefined || !isAbsolute(appPath) || basename(appPath).toLowerCase() !== 'app.asar') return false;
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return statSync(realpathSync(appPath)).isFile();
  } catch {
    return false;
  } finally {
    process.noAsar = previousNoAsar;
  }
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
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  releaseImportSmokeResultPath = undefined;
  if (!isReleaseImportRuntime(app, environment) || !argv.includes(RELEASE_IMPORT_SMOKE_ARGUMENT)) return undefined;
  const profilePath = isolatedReleaseImportProfile(
    smokeValue(argv, RELEASE_IMPORT_PROFILE_ARGUMENT, RELEASE_IMPORT_PROFILE_ENV, environment) ?? '',
  );
  const resultPath = resolve(smokeValue(argv, RELEASE_IMPORT_RESULT_ARGUMENT, RELEASE_IMPORT_RESULT_ENV, environment) ?? '');
  if (!isAbsolute(resultPath) || basename(resultPath) !== RELEASE_IMPORT_RESULT_FILE || realpathSync(dirname(resultPath)) !== profilePath) {
    throw new Error('release import result must be the dedicated marker file in the isolated profile');
  }
  releaseImportSmokeResultPath = resultPath;
  writeFileSync(resultPath, `${RELEASE_IMPORT_SMOKE_PROGRESS_MARKER}:profile-bound\n`, 'utf8');
  return profilePath;
}

export async function parseReleaseImportSmokeRequest(
  app: ReleaseSmokeApp,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseImportSmokeRequest> {
  if (!isReleaseImportRuntime(app, environment)) throw new Error('release import smoke requires a packaged application archive');
  const sourcePath = smokeValue(argv, RELEASE_IMPORT_SOURCE_ARGUMENT, RELEASE_IMPORT_SOURCE_ENV, environment) ?? '';
  const profilePath = smokeValue(argv, RELEASE_IMPORT_PROFILE_ARGUMENT, RELEASE_IMPORT_PROFILE_ENV, environment) ?? '';
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
      recordReleaseImportSmoke(RELEASE_IMPORT_SMOKE_READY_MARKER);
      app.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`${RELEASE_IMPORT_SMOKE_ERROR_MARKER}:${message}\n`);
      recordReleaseImportSmoke(`${RELEASE_IMPORT_SMOKE_ERROR_MARKER}:${message}`);
      app.exit(1);
    }
    return true;
  }
  if (!argv.includes(RELEASE_SMOKE_ARGUMENT)) return false;
  write(`${RELEASE_SMOKE_READY_MARKER}\n`);
  app.exit(0);
  return true;
}
