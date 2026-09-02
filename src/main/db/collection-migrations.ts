import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { migrateAlbumFolders } from './album-folder-migration.js';
import { migrateAlbumVisibility } from './album-visibility-migration.js';
import { migrateGalleryPolicy } from './gallery-policy-migration.js';
import { migrateSmartAlbums } from './smart-album-migration.js';
import { migrateEditRevisions } from './edit-revision-migration.js';
import { migratePhotoProvenance } from './provenance-migration.js';
import { migrateVariants } from './variant-migration.js';
import { migratePerceptualFingerprints } from './fingerprint-migration.js';

// ADR-0030 collection migrations (27..30), kept together so `migrations.ts`
// stays a ledger: gallery inclusion rules (#512), collection visibility
// (#494), folders + organizational tags (#505), and Smart Albums (#514).
// ADR-0031 §2/§8 edit revisions (#493) follow as 31 and §5 provenance
// evidence (#495) as 32 and §1/§3 variants (#496) as 33 — a table rebuild,
// so the runner drops foreign keys around it and checks them before commit.
export const COLLECTION_MIGRATIONS: readonly {
  readonly version: number;
  readonly name: string;
  readonly up: (db: BetterSqlite3.Database) => void;
  readonly rebuild?: boolean;
}[] = [
  { version: 27, name: 'gallery-policy', up: migrateGalleryPolicy },
  { version: 28, name: 'album-visibility', up: migrateAlbumVisibility },
  { version: 29, name: 'album-folders', up: migrateAlbumFolders },
  { version: 30, name: 'smart-albums', up: migrateSmartAlbums },
  { version: 31, name: 'edit-revisions', up: migrateEditRevisions },
  { version: 32, name: 'photo-provenance', up: migratePhotoProvenance },
  { version: 33, name: 'variants', up: migrateVariants, rebuild: true },
  // #650 perceptual fingerprints: recomputable index rows beside the photo.
  { version: 34, name: 'perceptual-fingerprints', up: migratePerceptualFingerprints },
];
