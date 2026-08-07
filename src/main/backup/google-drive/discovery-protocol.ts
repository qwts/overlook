import { createHash } from 'node:crypto';

export const GOOGLE_DRIVE_DISCOVERY_PROTOCOL = {
  ownerPropertyKey: 'overlookOwner',
  pathHashPropertyKey: 'overlookPathHash',
  hashAlgorithm: 'sha256',
  hashEncoding: 'lowercase-hex',
  rootIdentity: 'overlook-root',
  libraryIdentityTemplate: 'library:{libraryId}',
  folderIdentityTemplate: 'library:{libraryId}/folder:{path}',
  fileIdentityTemplate: 'library:{libraryId}/file:{path}',
} as const;

function fillIdentity(template: string, libraryId: string, path?: string): string {
  return template.replace('{libraryId}', () => libraryId).replace('{path}', () => path ?? '');
}

export function googleDriveDiscoveryHash(identity: string): string {
  return createHash(GOOGLE_DRIVE_DISCOVERY_PROTOCOL.hashAlgorithm).update(identity).digest('hex');
}

export function googleDriveRootIdentity(): string {
  return GOOGLE_DRIVE_DISCOVERY_PROTOCOL.rootIdentity;
}

export function googleDriveLibraryIdentity(libraryId: string): string {
  return fillIdentity(GOOGLE_DRIVE_DISCOVERY_PROTOCOL.libraryIdentityTemplate, libraryId);
}

export function googleDriveFolderIdentity(libraryId: string, path: string): string {
  return fillIdentity(GOOGLE_DRIVE_DISCOVERY_PROTOCOL.folderIdentityTemplate, libraryId, path);
}

export function googleDriveFileIdentity(libraryId: string, path: string): string {
  return fillIdentity(GOOGLE_DRIVE_DISCOVERY_PROTOCOL.fileIdentityTemplate, libraryId, path);
}
