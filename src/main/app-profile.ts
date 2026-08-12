import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

import { OVERLOOK_PRODUCT_NAME } from '../shared/app-identity.js';

interface ProfileApp {
  readonly isPackaged: boolean;
  getPath(name: 'appData' | 'userData'): string;
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
}

function hasProfileCustody(profilePath: string): boolean {
  return [
    path.join(profilePath, 'libraries.json'),
    path.join(profilePath, 'library', 'library.db'),
    path.join(profilePath, 'provider-auth', 'pcloud', 'pcloud-auth.bin'),
    path.join(profilePath, 'provider-auth', 'google-drive', 'google-drive-auth.bin'),
  ].some((candidate) => existsSync(candidate));
}

function sameDirectory(left: string, right: string): boolean {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  const inodeMatches = leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  return inodeMatches || realpathSync.native(left) === realpathSync.native(right);
}

function legacyProductProfile(appData: string): string | undefined {
  if (!existsSync(appData)) return undefined;
  const legacyName = OVERLOOK_PRODUCT_NAME.toLowerCase();
  const entry = readdirSync(appData, { withFileTypes: true }).find((candidate) => candidate.isDirectory() && candidate.name === legacyName);
  return entry === undefined ? undefined : path.join(appData, entry.name);
}

function migrationTemporaryPath(appData: string): string {
  const stem = path.join(appData, `.overlook-case-migration-${String(process.pid)}`);
  let candidate = stem;
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = `${stem}-${String(suffix)}`;
  }
  return candidate;
}

type RenameDirectory = (from: string, to: string) => void;

export function renameProfileDirectoryForMigration(
  legacyUserData: string,
  temporary: string,
  stableUserData: string,
  rename: RenameDirectory = renameSync,
): void {
  rename(legacyUserData, temporary);
  try {
    rename(temporary, stableUserData);
  } catch (error) {
    try {
      rename(temporary, legacyUserData);
    } catch (rollbackError) {
      throw new AggregateError([error], 'failed to capitalize the Overlook profile directory and roll it back', {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

function migrateLegacyProductProfile(appData: string, stableUserData: string): string | undefined {
  const legacyUserData = legacyProductProfile(appData);
  if (legacyUserData === undefined) return undefined;
  // A case-sensitive volume can contain both spellings. Never replace a
  // distinct destination; custody selection below will keep using whichever
  // populated profile already owns the data.
  if (existsSync(stableUserData) && !sameDirectory(legacyUserData, stableUserData)) return legacyUserData;

  const temporary = migrationTemporaryPath(appData);
  renameProfileDirectoryForMigration(legacyUserData, temporary, stableUserData);
  return stableUserData;
}

export function configureAppProfile(profileApp: ProfileApp, requestedUserData: string | undefined): string | undefined {
  // app.setName() does not promise to repoint an already-resolved userData
  // path. Capture Electron's packaged default first, then explicitly bind the
  // process to the established Overlook profile (#479). This keeps the
  // registry and provider custody visible across reinstall and app-id changes.
  const initialUserData = profileApp.getPath('userData');
  const stableUserData = path.join(profileApp.getPath('appData'), OVERLOOK_PRODUCT_NAME);
  profileApp.setName(OVERLOOK_PRODUCT_NAME);
  const userDataOverride = profileApp.isPackaged ? undefined : requestedUserData;
  if (userDataOverride !== undefined && userDataOverride !== '') {
    profileApp.setPath('userData', userDataOverride);
    return userDataOverride;
  }
  const migratedLegacyUserData = migrateLegacyProductProfile(profileApp.getPath('appData'), stableUserData);
  // Development must use the same stable Overlook identity as the packaged
  // app unless a harness explicitly requests an isolated profile. Packaged
  // reinstalls may preserve a populated Electron-selected profile, but no
  // implicit alternate product identity is discovered.
  const establishedUserData = [stableUserData, migratedLegacyUserData, initialUserData].find(
    (candidate): candidate is string => candidate !== undefined && hasProfileCustody(candidate),
  );
  const selected = profileApp.isPackaged && establishedUserData !== undefined ? establishedUserData : stableUserData;
  mkdirSync(selected, { recursive: true });
  profileApp.setPath('userData', selected);
  return userDataOverride;
}
