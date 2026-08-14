import path from 'node:path';

import type { EphemeralOriginalService } from '../backup/ephemeral-originals.js';
import { PhotosRepository } from '../db/photos-repository.js';
import type { LibraryParts } from '../library/library-parts.js';
import { createFileProviderBridge } from './file-provider-bridge.js';
import { FileProviderService } from './file-provider-service.js';
import { FileProviderStore } from './file-provider-store.js';
import { FileProviderTransport } from './file-provider-transport.js';
import { TestFileProviderBridge } from './test-file-provider-bridge.js';

interface FileProviderRuntimeFactoryDeps {
  readonly parts: LibraryParts;
  readonly currentParts: () => LibraryParts;
  readonly ephemeral: () => EphemeralOriginalService;
  readonly dataDir: string;
  readonly harnessEnv: (name: string) => string | undefined;
  readonly unlocked: () => boolean;
  readonly library: { readonly id: string; readonly name: string };
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly onLibraryChanged: (listener: () => void) => () => void;
}

export function createFileProviderService(deps: FileProviderRuntimeFactoryDeps): FileProviderService {
  const repo = new PhotosRepository(deps.parts.db);
  const fixtureDirectory = deps.harnessEnv('OVERLOOK_FILE_PROVIDER_STATE_DIRECTORY');
  const bridge =
    fixtureDirectory === undefined
      ? createFileProviderBridge({ platform: deps.platform, packaged: deps.packaged })
      : new TestFileProviderBridge(fixtureDirectory);
  const stateDirectory = bridge.status().available ? bridge.stateDirectory() : null;
  const serviceReference: { current?: FileProviderService } = {};
  const currentService = (): FileProviderService => {
    if (serviceReference.current === undefined) throw new Error('File Provider service is unavailable');
    return serviceReference.current;
  };
  const transport =
    stateDirectory === null
      ? undefined
      : new FileProviderTransport(stateDirectory, {
          enumerate: (parentId) => currentService().enumerate(parentId),
          item: (itemId) => currentService().item(itemId),
          materialize: (itemId) => currentService().materialize(itemId),
        });
  const service = new FileProviderService({
    bridge,
    store: new FileProviderStore(path.join(deps.dataDir, 'file-provider.json')),
    library: deps.library,
    albums: () => repo.albums(),
    selectPhotoIds: (albumId) => repo.selectAllIds({ source: 'all', ...(albumId === undefined ? {} : { albumId }) }),
    getPhoto: (photoId) => repo.get(photoId),
    isMigrating: (photoId) => repo.isInProtectedMigration(photoId),
    openOriginal: async (photo) => {
      const ephemeral = deps.ephemeral();
      const opened = await ephemeral.open(photo.id, 'export');
      return {
        stream: opened.stream,
        release: opened.custody === 'ephemeral' ? () => ephemeral.release(photo.id, 'export') : undefined,
      };
    },
    admit: () => deps.unlocked() && deps.currentParts() === deps.parts,
    transport,
    onLibraryChanged: deps.onLibraryChanged,
  });
  serviceReference.current = service;
  return service;
}
