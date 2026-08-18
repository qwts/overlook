# ADR-0006: Media Processing — Thumbnails, EXIF, RAW Policy, Native Modules

## Status

Accepted (2026-07-12, under the standing M05 goal authorization — the owner
may veto or amend on issue
[#83](https://github.com/qwts/photos/issues/83) before the pipeline code
builds on it)

## Context

The import pipeline (M05/M06) turns camera files into thumbnails and metadata.
The mock treats RAW as a first-class citizen (every 5th photo is a `.RAF`),
the Inspector shows a full EXIF block, and the grid needs thumbnails fast at
SD-card import volumes. [ADR-0003](./ADR-0003-Desktop-Stack.md) chose Electron
partly for first-class native modules and left their operating policy as an
open question pointed here; [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md)
adds a SQLCipher driver to the native-module set.

## Decision

**Thumbnails — sharp (libvips).** Two derivatives per photo, sized to the
design's surfaces:

- **Thumb** — 512 px long edge, WebP quality 80: covers the grid's 96–320 px
  tiles at 2× DPR.
- **Mid** — 2048 px long edge, WebP quality 85: the lightbox fast path while
  the decrypted original loads (or _is_ the lightbox image for offloaded
  photos).
- **Color management:** convert to sRGB honoring the embedded ICC profile.
  **Strip all metadata from derivatives** — a thumbnail must never leak the
  GPS track the original carries.
- Derivatives are encrypted and stored per ADR-0005 (`thumbs/`, hash + size
  suffix).

**EXIF — exifr.** Pure-JS, fast, no vendored binary — `exiftool-vendored`
ships a Perl runtime that fights the exact-pin/packaging regime and is
overkill for the Inspector's field set. Extracted fields map 1:1 to ADR-0005
columns: camera make/model, lens, ISO, aperture, shutter, focal length,
dimensions, orientation, `taken_at`, GPS lat/lon. If exifr's coverage gaps
(exotic maker notes) start losing fields we actually display, swapping the
extractor is a patch-level change behind the import pipeline's interface.

**Dimension authority and integrity (amended 2026-07-20, #500).** Stored
dimensions describe the pixels after EXIF orientation is applied. Metadata
claims must be positive safe integers, but a successful decoder result is the
authoritative display value for every supported format. When a valid EXIF or
container claim disagrees with that decoded value, Overlook keeps the original
unchanged, stores the decoded dimensions, and records local-only
`metadata-mismatch` state. The Inspector exposes that state as a possibly
corrupt-metadata warning; matching claims stay quiet. Existing local JPEG,
PNG, RAW, and HEIC rows receive one background verification pass. Offloaded
originals are never downloaded implicitly for this repair, and verification
state is excluded from disaster-recovery manifests so restored originals are
checked again on their new device.

**GPS → place (privacy stance, v1):** store coordinates in the DB (encrypted
at rest); display a place name **only** when the file's own metadata carries
one as text. **No network reverse-geocoding** — a privacy-first app does not
send location history to a geocoding API. Revisit only as an explicit
on-device feature with its own ADR.

**RAW policy v1 — embedded previews, no demosaic.** Camera RAW files (RAF,
CR3, NEF, ARW, DNG …) carry full-size JPEG previews; the pipeline extracts
the largest embedded preview and feeds it to the sharp derivative chain. Full
libraw decoding is **explicitly deferred** — it buys pixel-exact rendering at
the cost of a heavy native dependency and color-science surface v1 does not
need. Fallback when no usable preview exists: import succeeds
metadata-only with a generic RAW placeholder tile (the design's empty-state
iconography), never a failed import.

**Native-module policy** (closing ADR-0003's open question) for `sharp`,
`better-sqlite3(-multiple-ciphers)`, and successors:

- **Prebuilt binaries only** — no source compiles on developer machines or
  CI. A module without Electron-ABI prebuilds for mac + win is disqualified
  at selection time.
- Native modules load **in the main process side** only (workers via
  `utilityProcess` for heavy pipelines — never the sandboxed renderer, which
  has no Node access by ADR-0003's security defaults).
- **ABI lockstep under exact pins:** an Electron major bump and its native
  modules' rebuild/verification travel in the same Dependabot PR group; the
  packaging lane's native probe (#53) plus the E2E lane are the proof that
  the ABI matches — a green unit lane alone never certifies an Electron bump.
- `electron-builder`'s auto-rebuild (or `electron-rebuild`) stays wired even
  while prebuilds make it a no-op, so a module that silently loses prebuild
  coverage fails loudly at package time, not at user launch.

## Consequences

- Import pipeline issues (E6.x) cite sections here for sizes, formats, and
  field sets; changing a derivative size is a data migration (regenerate
  thumbs), not a config tweak.
- exifr and embedded-preview extraction keep v1 free of libraw/exiftool
  binaries — the native-module set stays exactly `sharp` + the SQLite driver.
- The SQLCipher + FTS5 driver build required by ADR-0004/0005 must satisfy
  the prebuilt-binaries rule above **before M03 starts**; if no maintained
  prebuild exists, ADR-0004's driver choice is revisited (that check is the
  first task of the M03 epic, not a mid-epic surprise).
- Stripping derivative metadata + no-network-geocoding are testable privacy
  invariants — they belong in AGENTS.md's Product Invariants once the
  pipeline lands, enforced by unit tests over generated thumbs.
- Deferring libraw means RAW rendering fidelity is preview-limited in v1;
  photographers get the camera's own JPEG interpretation, stated honestly in
  any copy that touches RAW support.

## Accepted clarification — Node-API prebuilds (#1020)

The prebuilt-only rule permits stable Node-API binaries as well as artifacts
published for one Electron ABI. A Node-API migration remains compliant when its
declared runtime floor covers Overlook's Electron version, every shipped target
has a reviewed prebuild, no source compilation occurs, foreign bundled targets
are removed during packaging, and the package matrix verifies the resulting
native payload architecture. `better-sqlite3-multiple-ciphers` v13 is the first
driver using this path; its bundled prebuilds remove the former Electron-major
cap without weakening target or package verification.
