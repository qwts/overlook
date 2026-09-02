# Acceptance Test — AI-generation provenance (#495)

Governing contract: [ADR-0031 §5](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md#5-provenance-uses-evidence-tiers-and-byte-exact-subjects)
(evidence tiers, byte-exact subjects, local validation by default) and
[§7](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md#7-backup-restore-and-interop-preserve-meaning-before-appearance)
(backups carry provenance evidence).

Provenance is evidence, not a verdict. The Inspector's **Provenance** section
shows one of four non-collapsible tiers — **Verified provenance**,
**Declared**, **Detected**, **Unknown** — with every source verbatim, the
time of the check, and the limitation that applies. Unknown is never worded
as human-made. A Content Credential this build cannot validate is reported
as present and unverifiable, never as verified. Nothing leaves the device:
there is no network path in this feature.

## Fixtures

`tests/fixtures/provenance/` is generated in-repo by `generate-fixtures.mjs`
(synthetic 16×16 gradients; every declaration is written by the script):

| File                         | Declares                                                                             | Expected tier · summary                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `declared-generator.jpg`     | XMP `DigitalSourceType = trainedAlgorithmicMedia`, `CreatorTool = Adobe Firefly 3.0` | Declared · "AI-generated — declared by metadata, not verified"         |
| `declared-edited.jpg`        | XMP `compositeWithTrainedAlgorithmicMedia`, Photoshop tool, Firefly history agent    | Declared · "AI-edited — declared by metadata, not verified"            |
| `declared-tool.jpg`          | XMP `CreatorTool = Adobe Photoshop`                                                  | Declared · "Tool named — declared by metadata, not verified"           |
| `declared-exif-software.jpg` | EXIF `Software = Midjourney v6`                                                      | Declared · "AI-generated — …"                                          |
| `png-parameters.png`         | PNG `parameters` text (A1111 form)                                                   | Declared · "AI-generated — …"                                          |
| `credential-stub.jpg`        | JPEG APP11 JUMBF container labelled `c2pa`, no manifest, no signature                | Declared · "Content Credentials present — not validated by this build" |
| `declared-sidecar.xmp`       | XMP sidecar declaring a generator                                                    | Declared, origin **Sidecar**                                           |
| `unknown.jpg`                | nothing                                                                              | Unknown · "No supported evidence"                                      |

Verified and Detected renders are covered by Storybook with stubbed evidence
(`Inspector.stories.tsx`: `ProvenanceVerified`, `ProvenanceDetected`): this
build ships no C2PA validator and no watermark detector, so no fixture can
produce them from bytes. A signed-valid / signed-tampered fixture pair lands
with the validator follow-up.

## Steps

1. Launch a fresh library and import the three-file card
   (`declared-generator.jpg`, `credential-stub.jpg`, `unknown.jpg`) through
   the ordinary Import flow. **Expected:** all three import and encrypt; no
   provenance work happens at import.
2. Open `declared-generator.jpg` in the lightbox and press `I`.
   **Expected:** the Provenance section shows the **Declared** badge (cyan),
   the summary "AI-generated — declared by metadata, not verified", an XMP
   row for `Iptc4xmpExt:DigitalSourceType` ending in `trainedAlgorithmicMedia`,
   an XMP row for `xmp:CreatorTool: Adobe Firefly 3.0`, today's date under
   **Checked**, the note "Declarations can be added, changed, or removed by
   any tool. They are not proof.", and "Local check only · no network".
3. Open `credential-stub.jpg`. **Expected:** **Declared**, summary "Content
   Credentials present — not validated by this build", a Credential row
   reading `C2PA · jpeg-app11 · N bytes · unverifiable`. The words "Verified
   provenance" appear nowhere.
4. Open `unknown.jpg`. **Expected:** **Unknown** (neutral badge), "No
   supported evidence", and the note "Unknown is not a claim that a person
   made this image."
5. Press **Re-check** on any photo. **Expected:** the button reads
   "Checking…" briefly, the same tier and rows return, **Checked** updates,
   and no stale flag appears. Page to another photo while it says
   "Checking…": the new photo's own record shows, never the previous one's.
   Only the first 32 MiB of an original is read for the check (the same
   window the extractor scans), so inspecting a large RAW or video does not
   load the whole file into memory.
6. Offload the original of an evaluated photo (or open a library whose
   originals are cloud-only) and view it. **Expected:** the existing record
   stays visible; if its bytes hash differs from the current original the
   amber "Re-check needed" note shows; with the original offloaded the amber
   "Original not local — checked when it returns" note shows instead of a
   new evaluation. A photo with **no** stored record whose original is
   offloaded reads **Not checked** (neutral badge, "Not checked yet"), never
   **Unknown** — no evaluation happened, so no tier is claimed.
7. Relaunch and open the same photos. **Expected:** the records are served
   from the library without re-evaluating (the **Checked** date is
   unchanged).
8. Back up, then restore into a new profile. **Expected:** every photo
   restores with the same record, evaluator, and **Checked** time (manifest
   schema 12); a schema-11 backup restores with no records, and each photo
   evaluates lazily on first view.
9. Purge an evaluated photo permanently. **Expected:** its record is gone
   with it (the §8 death list); nothing else changes.
10. Storybook `App/Inspector`: `ProvenanceVerified` renders the green badge
    with "Validated locally against …"; `ProvenanceDetected` renders the
    amber badge, the detector's name, version, result, confidence, and its
    stated limits under "Detectors have false positives and false
    negatives"; `ProvenanceDeferredUnchecked` renders the **Not checked**
    badge with no Unknown copy; `ProvenanceUnsupported` renders the **Newer
    format** badge, "Newer evidence format — view only", and a disabled
    **Re-check** (a downgraded build must not replace forward-compatible
    evidence).

## Coverage

- Electron: `tests/e2e/provenance.spec.ts` (steps 1–5).
- Storybook: `Inspector.stories.tsx` provenance stories (step 10).
- Unit: `tests/library/provenance.test.ts` (tiers, staleness, fail-closed
  parsing), `tests/import/provenance-extractor.test.ts` (every fixture and
  hostile containers), `tests/db/provenance.test.ts` (migration 32, replace,
  newer format preserved, purge cascade), `tests/library/provenance-service.test.ts`
  (lazy, stale, deferred, refresh), `tests/backup/provenance-manifest.test.ts`
  (schema 12, links, restore fidelity, legacy manifests).
- Manual: steps 6–9.
