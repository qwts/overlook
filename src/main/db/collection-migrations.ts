import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { migrateAlbumFolders } from './album-folder-migration.js';
import { migrateAlbumVisibility } from './album-visibility-migration.js';
import { migrateGalleryPolicy } from './gallery-policy-migration.js';
import { migrateSmartAlbums } from './smart-album-migration.js';

// ADR-0030 collection migrations (27..30), kept together so `migrations.ts`
// stays a ledger: gallery inclusion rules (#512), collection visibility
// (#494), folders + organizational tags (#505), and Smart Albums (#514).
export const COLLECTION_MIGRATIONS: readonly {
  readonly version: number;
  readonly name: string;
  readonly up: (db: BetterSqlite3.Database) => void;
}[] = [
  { version: 27, name: 'gallery-policy', up: migrateGalleryPolicy },
  { version: 28, name: 'album-visibility', up: migrateAlbumVisibility },
  { version: 29, name: 'album-folders', up: migrateAlbumFolders },
  { version: 30, name: 'smart-albums', up: migrateSmartAlbums },
];
