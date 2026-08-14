# Moodboard Export Acceptance

Issue [#696](https://github.com/qwts/overlook/issues/696) closes the Moodboard PR-4 export boundary: a board is composed to a single PNG at declared dimensions and an embedded sRGB or Display P3 profile. The main process owns original access and composition; the renderer supplies validated board geometry and never receives plaintext originals.

## Automated evidence

- `tests/export/board-export.test.ts` renders real PNG fixtures through Sharp and verifies output dimensions, distinct embedded ICC profiles, normalized crop geometry, locked/unavailable skip counts, and cancellation without a destination write.
- `tests/moodboard/export-layout.test.ts` owns board-to-output scaling, z-order, crop/rotation preservation, and the pure I4/I6 skip policy.
- `src/renderer/src/export/BoardExportDialog.stories.tsx` exercises dimensions, Display P3 selection, destination choice, completion, and the exact skipped-placement copy through the shared dialog focus contract.
- `tests/e2e/moodboard.spec.ts` drives the packaged Electron boundary from the floating Export action to a real on-disk color-managed PNG.

## Physical-platform procedure

1. Import one tagged sRGB image and one tagged Display P3 image, then place both on a board with overlap, crop, rotation, and one placement partly outside the canvas.
2. Add a placement that later becomes unavailable. Add a protected placement if the current build exposes that board transition, then relock it before export.
3. Choose **Export board**, retain the board dimensions, select **sRGB**, choose an empty folder, and export.
4. Repeat with **Display P3** and a second empty folder.
5. Inspect both PNGs with the platform color-profile inspector and a color-managed viewer.

Expected:

- Pixel dimensions match the dialog exactly; the board background, crop, rotation, clipping, and back-to-front order match the canvas geometry.
- The sRGB file embeds an sRGB profile and the Display P3 file embeds a Display P3 profile. Neither file is untagged.
- The completion message reports the exact locked-or-unavailable count. Those placement rectangles contain only the board background; locked original bytes are never opened or rasterized.
- A filename collision creates `Title (2).png` without overwriting the first export.
- Canceling during composition writes no partial PNG. A profile or decode failure is reported as a failed export rather than producing an untagged or truncated file.

## Resource boundary

The IPC contract limits either dimension to 8,192 pixels and total output to 32 megapixels. Composition is serialized with ordinary exports and releases ephemeral offloaded-original custody after each placement.
