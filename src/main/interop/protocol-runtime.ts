import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { PhotosRepository } from '../db/photos-repository.js';
import { InteropRepository } from './interop-repository.js';
import { LiveLocalRouteRepository } from './live-local-route-repository.js';
import { MoveJournalRepository } from './move-journal-repository.js';
import { MoveProtocolService } from './move-protocol.js';
import { SyncProtocolService } from './sync-protocol.js';
import { SyncRepository } from './sync-repository.js';
import { InteropTranslationService } from './translation-service.js';

export interface InteropProtocolRuntime {
  readonly interop: InteropRepository;
  readonly translation: InteropTranslationService;
  readonly moveJournals: MoveJournalRepository;
  readonly move: MoveProtocolService;
  readonly syncRepository: SyncRepository;
  readonly sync: SyncProtocolService;
  readonly routes: LiveLocalRouteRepository;
}

/** One library-scoped production composition for the canonical Move and Sync
 * protocols. Provider transports and renderer workflows borrow these services
 * instead of creating parallel journals or translation models. */
export function createInteropProtocolRuntime(db: BetterSqlite3.Database): InteropProtocolRuntime {
  const photos = new PhotosRepository(db);
  const interop = new InteropRepository(db);
  const translation = new InteropTranslationService(interop, photos);
  const moveJournals = new MoveJournalRepository(db);
  const syncRepository = new SyncRepository(db);
  return {
    interop,
    translation,
    moveJournals,
    move: new MoveProtocolService('overlook', moveJournals, translation),
    syncRepository,
    sync: new SyncProtocolService('overlook', syncRepository),
    routes: new LiveLocalRouteRepository(db),
  };
}
