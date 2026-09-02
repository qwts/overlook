# Acceptance test — Inspector histogram (#498, first slice)

Scope: the histogram only. Non-destructive tonal adjustments (exposure,
levels, curves) are the issue's second slice and are not covered here.

The Inspector's **Histogram** section shows red, green, blue and luminance
bins for the focused photo. The bins are computed in the main process, on a
dedicated worker thread, from the photo's own mid derivative (ADR-0006:
sRGB, metadata-free, the persisted edit stack already baked in), so the
renderer never decodes pixels, the lightbox never waits on it, and no
metadata is read to produce it. The _Source_ row states what was measured.
The answer is cached per head revision and derivative key and recomputed
when a derivative changes. Missing, corrupt or failed derivatives say so;
nothing is drawn from a fabricated or stale source.

Automated coverage: `tests/e2e/histogram.spec.ts`, `tests/library/histogram.test.ts`,
`tests/library/histogram-service.test.ts`, `Inspector.stories.tsx › Histogram / HistogramUnavailable`.

## Steps

1. Launch a seeded library (`OVERLOOK_SEED=4`), open IMG_4028.JPG in the
   lightbox, press `i`. **Expected:** the Inspector shows a _Histogram_
   section with four overlaid traces (red, green, blue fills; luminance
   line), a _Clipping_ row ("Shadows x% · Highlights y%", amber at or above
   1%), and a _Source_ row ("Preview · sRGB · W×H"). Paging with ←/→ is not
   delayed by it; the previous chart stays until the next one is ready.
2. Page to another photo and back. **Expected:** the chart follows the
   focused photo; the same photo shows the same chart again (cached).
3. Rotate clockwise and save with ⌘S. **Expected:** the _Source_ edges swap
   (W×H → H×W) once the derivative is re-baked; the section's
   `data-revision` names the new head.
4. Crop (C, drag, Enter, ⌘S). **Expected:** the _Source_ edges shrink and the
   bins change — the histogram is of the presentation, not the original.
5. Open a variant of the photo (Inspector › Variants). **Expected:** the
   variant's own derivative is measured (its own edit stack), not the
   root's.
6. Offloaded original (manual): offload a synced photo and open it.
   **Expected:** the histogram stays available — derivatives survive
   offload — and nothing is fetched from the provider to draw it.
7. Failed preview (manual, a corrupt or unsupported file): **Expected:** the
   section's _State_ row repeats the preview failure copy ("PREVIEW
   UNAVAILABLE — …"); no chart is drawn. A photo whose derivatives are not
   in custody yet reads "No preview in custody yet — repair pending"; a
   derivative that does not decode reads "Preview did not decode — repair
   pending".
8. Detached Inspector window. **Expected:** the same section, same
   behaviour, no crash without the bridge (the section hides when the
   bridge is unreachable).
