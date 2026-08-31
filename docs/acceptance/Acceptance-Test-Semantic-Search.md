# Semantic search acceptance

Issue [#392](https://github.com/qwts/overlook/issues/392) completes the
ADR-0018 query path on top of [#391](https://github.com/qwts/overlook/issues/391).

## Automated contract

1. Keyword mode retains the exact FTS5 path and its filters.
2. Semantic mode runs the pinned CLIP text tower, queries encrypted int8
   vectors, and returns cosine-ranked photos that need not contain query words.
3. Auto mode fuses keyword and semantic candidates with reciprocal-rank fusion
   (`k = 60`) and a stable photo-ID tie break.
4. Paging, Select All, and range selection use the same logical projection.
5. Source, album, favorite, RAW, offloaded, and local-only filters are identical
   on keyword and semantic candidates.
6. Disabled, unavailable, incomplete, busy, and failed semantic paths fall back
   to keyword search. Typed IPC reports requested mode, applied mode, fallback
   reason, and indexed/total counts; the Toolbar exposes the state in a polite
   live region.
7. The existing 250 ms input debounce and request-generation check prevent
   stale responses from replacing a newer query.
8. The 200K performance lane measures text-query embedding, cosine KNN, fusion,
   hydration, and IPC together against the ADR-0018 900 ms median ratchet.

Evidence:

- `tests/e2e/semantic-search.spec.ts`
- `src/renderer/src/shell/Toolbar.stories.tsx`
- `tests/db/embedding-repository.test.ts`
- `tests/embedding/clip-tokenizer.test.ts`
- `tests/embedding/embedding-pool.test.ts`
- `tests/library/semantic-search.test.ts`
- `tests/library/app-state.test.ts`
- `tests/perf/perf-harness.spec.ts`

The E2E and performance lanes use deterministic offline vectors and a fixed
query vector. Production text-model execution remains covered at the worker,
tokenizer, asset-integrity, and measured-model checkpoint boundaries documented
in [Semantic embedding index acceptance](./Acceptance-Test-Semantic-Embedding-Index.md).

## Packaged manual pass

On macOS and Windows packages after indexing finishes:

1. Search for a natural-language scene whose terms are absent from the target
   photo metadata. Semantic and Auto must surface the expected photo.
2. Switch among Auto, Semantic, and Keyword with pointer and arrow keys. The
   visible grid and live status must match the selected mode.
3. Start a fresh index, pause it, disable it, and temporarily disconnect model
   assets. Semantic and Auto must show the reason and keyword results; they must
   never render an empty grid as if semantic search succeeded.
4. Apply each source, chip, and album filter, then use Select All and Shift-range
   selection. No photo outside the visible semantic projection may be selected.
5. Type two queries quickly. Only the later query may populate the grid or live
   status.
