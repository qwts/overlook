export type DestructiveActionTier = 'reversible' | 'structural' | 'irreversible';

export interface DestructiveActionDescriptor {
  readonly id: string;
  readonly tier: DestructiveActionTier;
  readonly label: string;
  readonly title?: string;
  readonly authorization?: string;
  readonly survival?: string;
  readonly sideEffects?: string;
}

// ADR-0023's single vocabulary source. UI surfaces may add exact counts and
// object names, but must not invent a different verb or custody promise.
export const destructiveActions = {
  movePhotosToTrash: {
    id: 'photos.move-to-trash',
    tier: 'reversible',
    label: 'Move to Trash',
    survival: 'Photos can be restored from Trash until they are deleted permanently.',
  },
  restorePhotosFromTrash: {
    id: 'photos.restore-from-trash',
    tier: 'reversible',
    label: 'Restore from Trash',
    survival: 'Photos return to the library with their metadata and album membership.',
  },
  deletePhotosPermanently: {
    id: 'photos.delete-permanently',
    tier: 'irreversible',
    label: 'Delete permanently…',
    title: 'Delete photos permanently?',
    sideEffects:
      'Deletes local originals, previews, and metadata, and removes the encrypted copies from your cloud backup. The provider keeps its deleted objects in its own trash for a limited time (still encrypted, recoverable only through the provider). Cloud deletion failures are recorded and retried; encrypted records that name a photo may remain in up to two older recovery snapshots.',
  },
  deleteProtectedOriginals: {
    id: 'photos.delete-protected-originals',
    tier: 'irreversible',
    label: 'Delete protected Originals permanently…',
    title: 'Override Original protection?',
    authorization: 'photos.delete-protected-originals.v1',
    sideEffects:
      'Overrides Original protection and permanently deletes the selected local originals, previews, metadata, and connected-provider copies.',
  },
  deleteAlbum: {
    id: 'album.delete',
    tier: 'structural',
    label: 'Delete album',
    survival: 'Photos stay in the library; only the album and its membership are removed.',
  },
  deleteFolder: {
    id: 'album.folder.delete',
    tier: 'structural',
    label: 'Delete folder',
    survival: 'Photos stay in the library; only the folder, the albums inside it, and their membership are removed.',
  },
  deleteSmartAlbum: {
    id: 'album.smart.delete',
    tier: 'structural',
    label: 'Delete Smart Album',
    survival: 'Photos stay in the library; only the saved query is removed.',
  },
  removePhotosFromAlbum: {
    id: 'album.remove-photos',
    tier: 'structural',
    label: 'Remove from album',
    survival: 'Photos stay in the library and in any other albums.',
  },
  removeLibraryFromList: {
    id: 'library.remove-from-list',
    tier: 'structural',
    label: 'Remove library from list',
    survival: 'The library files stay on disk and can be opened again.',
  },
  disconnectProvider: {
    id: 'provider.disconnect',
    tier: 'structural',
    label: 'Disconnect provider',
    survival: 'Local photos and existing provider copies remain.',
  },
  removeProviderAuthorizationAnyway: {
    id: 'provider.remove-authorization-anyway',
    tier: 'structural',
    label: 'Remove authorization anyway',
    authorization: 'provider.remove-authorization-anyway.v1',
    survival: 'Provider copies remain, but cloud-only originals require reconnecting the same provider account.',
  },
  clearDiagnostics: {
    id: 'diagnostics.clear',
    tier: 'structural',
    label: 'Clear diagnostics',
    survival: 'Photos, libraries, settings, and recovery data are unchanged.',
  },
  // ADR-0033 §7: leaving automatic backup. Tier M when the provider holds
  // no copy; the surface escalates to removeCloudCopy when one exists.
  keepOnThisDeviceOnly: {
    id: 'photos.keep-on-this-device-only',
    tier: 'structural',
    label: 'Keep on this device only',
    survival: 'The photos stay in the library on this device and stop being backed up automatically. Back up again re-enables them.',
  },
  removeCloudCopy: {
    id: 'photos.remove-cloud-copy',
    tier: 'irreversible',
    label: 'Remove cloud copy permanently',
    title: 'Remove the cloud copy?',
    authorization: 'photos.remove-cloud-copy.v1',
    sideEffects:
      'Removes the encrypted copies from your cloud backup after the originals are verified on this device, and stops backing the photos up automatically. The provider keeps its deleted objects in its own trash for a limited time (still encrypted, recoverable only through the provider). Cloud deletion failures are recorded and retried; a copy that also backs another photo is kept.',
  },
  // ADR-0032 §2 removal ceremony (#517). Tier M when nothing is sealed under
  // the key; Tier D with exact counts when removal strands the only custody.
  forgetEncryptionKey: {
    id: 'keyring.forget-key',
    tier: 'structural',
    label: 'Remove key',
    survival: 'Nothing in the library is sealed under this key, so no photo changes. The registry keeps its reference.',
  },
  removeEncryptionKey: {
    id: 'keyring.remove-key',
    tier: 'irreversible',
    label: 'Remove key permanently',
    title: 'Remove this key?',
    authorization: 'keyring.remove-key.v1',
    sideEffects:
      'Deletes the key material from this device. Photos and sidecars sealed under it stay in the library as locked items that cannot be opened, exported, or verified until the same key is imported again from an exported key file. Nothing on the provider changes, and disaster recovery of a backup that names this key needs the key file too.',
  },
  removeAppPassword: {
    id: 'app-password.remove',
    tier: 'structural',
    label: 'Remove app password',
    survival: 'Encryption keys return to operating-system protection; recovery data is unchanged.',
  },
} as const satisfies Record<string, DestructiveActionDescriptor>;

export const ORIGINAL_DELETE_AUTHORIZATION = destructiveActions.deleteProtectedOriginals.authorization;
export const PROVIDER_AUTHORIZATION_REMOVAL = destructiveActions.removeProviderAuthorizationAnyway.authorization;
export const REMOVE_CLOUD_COPY_AUTHORIZATION = destructiveActions.removeCloudCopy.authorization;
export const REMOVE_KEY_AUTHORIZATION = destructiveActions.removeEncryptionKey.authorization;
