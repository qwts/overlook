# Semantic embedding index acceptance

Issue [#391](https://github.com/qwts/overlook/issues/391) implements the
ADR-0018 image-embedding pipeline and encrypted vector substrate. Semantic
query fusion remains [#392](https://github.com/qwts/overlook/issues/392).

## Automated contract

1. A fresh profile makes no model request while semantic indexing is disabled.
2. Enabling the Settings switch records explicit consent, downloads the pinned
   assets, verifies every size and SHA-256, and publishes download/index
   progress.
3. Pause cancels the in-flight worker job. Resume queries the encrypted database
   again, so completed rows are not repeated after pause, crash, or relaunch.
4. Content-hash changes and ordinary deletes requeue or remove vectors.
   Permanent purge cascades vector removal. Starting a protected-photo migration
   removes the unlocked embedding in the same transaction.
5. Import, backup/provider work, and battery power pause the one-worker queue.
   Library teardown cancels it before SQLCipher and key custody close.
6. Raw database bytes expose neither a SQLite header nor model-version/content
   metadata, and the wrong library key cannot read the index.

Evidence:

- `tests/embedding/model-assets.test.ts`
- `tests/embedding/embedding-service.test.ts`
- `tests/embedding/embedding-runtime.test.ts`
- `tests/db/embedding-repository.test.ts`
- `tests/db/protected-photo-migration-repository.test.ts`
- `src/renderer/src/settings/SettingsDialog.stories.tsx`

## Model checkpoint

Run:

```sh
OVERLOOK_EMBEDDING_MODEL_CACHE=/path/to/cache npm run benchmark:embedding
```

The guarded benchmark downloads only the immutable manifest revision, verifies
all asset hashes, forces the CPU provider, embeds four checked-in images over
five measured rounds, measures 20 text-tower runs per query, and checks four
labeled retrieval pairs.

Apple Silicon dev-machine evidence recorded 2026-07-25:

| Metric                       | ADR-0018 budget | Result          |
| ---------------------------- | --------------- | --------------- |
| Image embedding throughput   | at least 5/s    | 127.59 photos/s |
| Median text-tower latency    | at most 40 ms   | 6.20 ms         |
| Labeled top-1 retrieval      | sanity check    | 4/4             |
| Hash-verified download bytes | pinned manifest | 154,949,606     |

Checkpoint:
`openclip-vit-b32-int8-d15189d7028b43f1d3e65039190477f6af591c2a`.
Changing any asset requires a manifest/version change and a complete re-index.

## Performance interpretation

Indexing does not contend with import: the scheduler pauses before taking the
next photo whenever an import batch is active. The guarded service test proves
that queue boundary; `npm run test:perf` retains the greater-than-3-photos/s
import ratchet and records the product pipeline baseline.

## Packaged manual pass

On a macOS and Windows package:

1. Confirm a disabled fresh profile makes no model request.
2. Enable indexing and verify download progress, then pause and resume.
3. Quit mid-index and relaunch. Completed count must not decrease or restart at
   zero.
4. Start an import and a backup. Indexing must report the matching pause reason
   and resume after each finishes.
5. Switch to battery on macOS; indexing pauses until AC returns.
6. Purge an indexed photo and protect another. Neither vector remains queryable.
