# Spike: Multi-Platform Port (iOS, iPadOS, tvOS, visionOS, Android, Windows)

## Status

**Spike — findings only, no decision.** Nothing here is ratified. A port would
supersede [ADR-0003](./adr/ADR-0003-Desktop-Stack.md) (which chose Electron and
explicitly says "a switch would be a new ADR superseding this one") and would
need its own ADR before any code lands.

Investigated 2026-07-18 against `main` at `abbb413`. No production code was
changed by this spike.

## Question

What would it take to run Overlook on iOS, iPadOS, tvOS, visionOS, Android, and
Windows?

## Answer in one paragraph

**Two of the six targets should leave the list immediately, in opposite
directions.** Windows is not a port — it already builds and ships; only code
signing is missing. tvOS is not a port either — it grants ~500 KB of persistent
storage and can never hold a local encrypted library, so it is either cut or
redefined as a cloud viewer. For the remaining four, the cost is **not** the
Electron shell, which is already quarantined behind ~23 adapter files (6% of
`src/`). It is concentrated in four places: `better-sqlite3-multiple-ciphers`,
`sharp`, the macOS-only Objective-C++ addon, and — the only genuinely hard
problem — **master key custody**, which is bound to Electron `safeStorage` and
unreachable from a native app. The on-disk _format_ is portable and, for the
database, empirically SQLCipher-4-compatible; roughly half of `src/` is already
platform-neutral TypeScript, and the image pipeline is only seven operations
wide. The renderer's _logic_ was already deliberately extracted into
`src/shared/`; its _pixels and gestures_ are desktop-web and get rewritten per
platform whatever framework is chosen. And no single framework covers even the
reduced target set — tvOS and visionOS sit outside all of them.

## Method

- Static inventory of `src/main`, `src/renderer`, `src/shared`, `src/preload`,
  `native/`, plus packaging and CI config.
- Line-counted dependency ledger across the whole of `src/`.
- Empirical probe of the SQLCipher on-disk parameters (see
  [Verified: the database is SQLCipher 4](#verified-the-database-is-sqlcipher-4)),
  because the cipher configuration is otherwise unrecorded.
- Review of ADR-0003/0004/0005/0006/0008/0014 for design intent.

## Finding 1 — Windows already ships

Not a port. `.github/workflows/package.yml:31-33` builds a matrix of
`[macos-latest, windows-latest]`, `electron-builder.yml` declares a `win` nsis
target with an icon, and `src/renderer/src/components/TitleBar.tsx` already
branches between the macOS traffic-light inset and custom window controls.
`src/main/crypto/credential-anchor.ts` already has a PowerShell/DPAPI path
beside the macOS `security` path.

The only outstanding Windows work is **code signing**, held on
[#128](https://github.com/qwts/photos/issues/128) pending a certificate.
Windows should be struck from the scope of "port" and tracked as a
release-engineering item.

## Finding 2 — the coupling ledger

Measured over the 41,722 lines of `.ts`/`.tsx` in `src/`:

| Dependency                        | Files | LOC in those files |
| --------------------------------- | ----- | ------------------ |
| `electron`                        | 23    | 2,611 (6%)         |
| `node:crypto`                     | 33    | 8,106              |
| `node:path`                       | 37    | 7,038              |
| `node:fs`                         | 36    | 5,588              |
| `better-sqlite3-multiple-ciphers` | 16    | 4,481              |
| `node:http`                       | 2     | 289                |
| `child_process`                   | 1     | 296                |
| `worker_threads`                  | 2     | 265                |
| `sharp`                           | 3     | 221                |
| `exifr`                           | 1     | 138                |
| **Free of all of the above**      | —     | **21,485 (51%)**   |

Read this carefully: "imports no Electron" is not the same as "portable", and
the LOC column counts whole files, not the coupled lines within them. The
useful signal is the shape — **Electron itself is a thin rind**, and the
23 files that touch it follow a consistent `*-runtime.ts` / `*-factory.ts` /
`*-picker.ts` / `*-protocol.ts` naming convention. `blobs/`, `cache/`, `db/`,
and `interop/` import Electron zero times.

## Finding 3 — the library format is portable

### Verified: the database is SQLCipher 4

`src/main/db/database.ts:29-36` sets only `cipher='sqlcipher'`, a raw 32-byte
hex key, WAL, and foreign keys. Every other cipher parameter rides on library
defaults and is recorded nowhere. Probing a freshly created database through
the pinned `better-sqlite3-multiple-ciphers` (SQLite3 Multiple Ciphers 2.4.0,
SQLite 3.53.4) returns:

| Parameter                        | Value     | Meaning                                        |
| -------------------------------- | --------- | ---------------------------------------------- |
| `legacy`                         | 0         | SQLCipher **4** format                         |
| `legacy_page_size` / `page_size` | 4096      | SQLCipher 4 default                            |
| `kdf_algorithm`                  | 2         | PBKDF2-**SHA512**                              |
| `hmac_algorithm`                 | 2         | HMAC-**SHA512**                                |
| `kdf_iter`                       | 256000    | SQLCipher 4 default (bypassed in raw-key mode) |
| `fast_kdf_iter`                  | 2         | derives the HMAC key from the raw key + salt   |
| `hmac_pgno`                      | 1         |                                                |
| `hmac_salt_mask`                 | 0x3a (58) |                                                |
| `plaintext_header_size`          | 0         |                                                |

These are exactly the SQLCipher 4 defaults, and the first 16 bytes of the file
are the random salt (confirmed identical to `PRAGMA cipher_salt`). Because the
key is supplied raw, there is no passphrase KDF to replicate.

**Caveat, stated plainly:** this establishes that the _parameters_ match
SQLCipher 4 defaults. It does **not** prove byte-for-byte interoperability — no
upstream SQLCipher build was used to open the file. Actually opening a real
`library.db` with `net.zetetic` SQLCipher on iOS and Android is the first
concrete experiment any port should run, and it is cheap.

Two things make this much safer than a single-source bet:

- SQLite3 Multiple Ciphers **documents its `sqlcipher` scheme as compatible with
  SQLCipher versions 1–4**, and `legacy=0` selects the v4 format.
- **SQLite3 Multiple Ciphers ships as a plain C amalgamation** and builds for
  every target here. So there are two independent routes to a second
  implementation: talk to stock SQLCipher, or compile the _identical_ cipher
  implementation we already use and remove the compatibility question entirely.
  This is not theoretical — the Flutter ecosystem has moved the other way for
  exactly this reason: `drift` now recommends SQLite3MultipleCiphers **over**
  SQLCipher, because it covers all native platforms including Windows and Linux.

One near-miss worth recording: sqlite3mc's _default_ cipher is ChaCha20-Poly1305
(sqleet), which is **not** SQLCipher-compatible. `database.ts` sets
`cipher='sqlcipher'` explicitly. Had it relied on the default, this section would
be describing a whole-library migration instead.

### The other four formats are self-describing

Every binary artifact carries a magic and a version byte, which is unusually
disciplined and makes reimplementation mechanical:

- **Blob/thumb envelope** (`src/main/crypto/envelope.ts`) — `"OVLK"` ‖ version
  ‖ key id ‖ 8-byte nonce prefix, then 4 MiB AES-256-GCM chunks. The 96-bit
  nonce is a 64-bit per-blob random prefix ‖ 32-bit chunk counter, so no
  cross-blob state is needed. AAD binds photo id, key id, chunk index, flags,
  and total chunks, so truncation and reordering fail the tag check.
- **Key wrap** (`keystore.ts`) — `base64(nonce ‖ tag ‖ ciphertext)`, AES-256-GCM,
  AAD = key id. Wrapped keys live in versioned JSON at `keys.json`.
- **Recovery key** (`recovery.ts`) — a fixed 81-byte file: `"OVRK"` ‖ version ‖
  salt ‖ nonce ‖ ciphertext ‖ tag, header as AAD.
  ([ADR-0008](./adr/ADR-0008-Recovery-Key-Format.md))
- **App-lock record** (`app-lock-credentials.ts`) — `"OVLK"` ‖ UTF-8 JSON naming
  its own scrypt parameters (N=2^17, r=8, p=1) and two GCM slots.

Blobs are content-addressed by SHA-256 of plaintext under a two-level hex
fan-out, so paths are derivable from the database with no separate index, and
`readEnvelopeKeyId` can recover the key id from the first 9 bytes of any blob.

Everything above is AES-256-GCM, PBKDF2, scrypt, and SHA-2 — all available in
CryptoKit and `javax.crypto`/Tink. This is a few hundred lines of Swift, not a
research project.

## Finding 4 — key custody is the one hard problem

This is the finding that decides the shape of the whole project.

`master.key` exists in one of two mutually exclusive forms, distinguished by
sniffing for an `OVLK` prefix (`keystore.ts:126`):

1. **Default (no app lock):** the output of Electron `safeStorage.encryptString`
   — macOS Keychain, Windows DPAPI, libsecret. This is opaque and bound to the
   Electron app's OS identity. **A native iOS or Android app cannot read it.**
   `KeyStore.open` refuses to run without the keychain; there is deliberately no
   plaintext fallback ([ADR-0004](./adr/ADR-0004-Encryption-And-Key-Management.md)).
2. **App lock configured:** the portable, self-describing `OVLK`+JSON record.

So today there are exactly two cross-platform ingresses into a library: the
**recovery key file**, or **having app lock configured**. Both already exist and
both are already specified — which is a much better starting position than it
sounds.

Deepening the problem, `credential-anchor.ts` maintains the app-lock freshness
anchor by _shelling out_ to `/usr/bin/security` (line 204), `secret-tool`, or an
embedded PowerShell DPAPI script (lines 164, 283). **Process spawning is
prohibited on iOS, iPadOS, tvOS, and visionOS** — there is no workaround. This
is a rewrite against Keychain/Secure Enclave and Android Keystore directly,
which is cleaner than what desktop does, but it is new code.

A port therefore needs a deliberate custody design. The most likely shape: make
the **portable app-lock record the on-disk source of truth**, and let each
platform cache the derived master key in its own secure enclave as a
convenience. That is an ADR-sized decision, and it is the actual project.

## Finding 5 — the renderer's logic is already extracted; its surface is not

The renderer is ~10,200 lines of TS/TSX plus 3,890 lines of CSS across 29 files,
with 68 exported components and ~93 design tokens.

**What already survives a UI rewrite** — someone was deliberately separating
this, with comments saying so:

- `src/shared/library/app-state.ts` (222 L) — the whole app state shape as a
  pure reducer. A ready-made view model for SwiftUI or Compose.
- `src/shared/library/grid-layout.ts` (127 L) — all virtualization math,
  explicitly "no DOM".
- `src/renderer/src/lightbox/geometry.ts` (106 L) — zoom/pan/rotate transforms,
  DOM-free despite its location. Should move to `src/shared/` on day one.
- The URL contracts, `format.ts`, the ICU message catalog, and the Zod IPC
  contract as a stub-generation source.

**What does not survive, on any target:**

- **56 HTML5 drag-and-drop handlers.** Photo→album drag and OS file-drop-to-import.
  The _payload_ is portable (`src/shared/library/photo-drag.ts` is versioned
  JSON behind an interface); the `DataTransfer` transport is not.
- **Zero touch events exist.** No pinch, no pan, no long-press. Lightbox zoom is
  `onWheel` with `DOM_DELTA_LINE` normalization.
- **Hover-revealed affordances.** Three are load-bearing, not cosmetic: the tile
  selection circle (`phototile.css:94`), list-row selection (`list.css:39`), and
  the album action menu (`shell.css:423`). These are invisible and unreachable on
  touch.
- **No keyboard shortcut registry.** `state/use-global-keys.ts` is a 44-line
  inline if-chain, with more key handling scattered across four other files.
  There is no binding table to remap for a tvOS remote.
- **No focus model.** No roving tabindex, no directional navigation, no
  focus-state tokens beyond browser tab order. tvOS needs this from scratch.
- **Desktop-fixed layout.** Chrome dimensions are hardcoded tokens
  (`--titlebar-h: 30px`, `--sidebar-w: 216px`, `--inspector-w: 280px`) composing
  a three-pane frame. Only **5 real responsive breakpoints exist in 3,890 lines
  of CSS**; there is no safe-area or orientation handling anywhere. Density is
  desktop (13px base type, 24–34px controls) — below iOS, Android, and
  especially visionOS touch-target guidance.
- Tokens are **dark-mode only**; there is no light theme yet
  ([#284](https://github.com/qwts/photos/issues/284)).

One real win: there is **no shift-click range select or modifier multi-select**.
Selection is an explicit per-tile toggle button with `aria-pressed`, which maps
cleanly onto touch and TV selection modes.

## Finding 6 — the interop contract is the proven template

The strongest evidence that this is tractable: **the team has already done this
exercise once.** `src/shared/interop/` plus `design/handoff/contracts/v1/`
define a versioned, product-neutral, encrypted, wire-level transfer protocol
that a _different product_ (`qwts/image-trail`) with a _different database
format and key hierarchy_ implements against
([ADR-0014](./adr/ADR-0014-Image-Trail-Bidirectional-Interoperability.md)).

It ships published draft-2020-12 JSON schemas, seven golden fixtures
(valid/invalid/replay/corrupt/future-version), `SHA256SUMS`, and CI-enforced
cross-product acceptance evidence (`npm run check:interop-acceptance`, 10
required scenarios and 4 manual checks). Pairing is PBKDF2-SHA256 at 600,000
iterations plus AES-256-GCM — deliberately WebCrypto-common-denominator
primitives rather than the scrypt used elsewhere in the app.

This matters twice over:

1. It is the template for how to specify the library format for a second
   implementation. That work has a precedent in this repo, not just a plan.
2. **A mobile app could be modeled as an interop _peer_ rather than a second
   implementation of the library format** — a companion that syncs, rather than
   a full port that opens `library.db` directly. That is a dramatically smaller
   and safer first step.

The constraint: `interopProductSchema` is a closed two-value enum
(`['image-trail', 'overlook']`, `contract.ts:6`), the header refines
source ≠ target, and the pairing magic is the literal
`OVERLOOK-IMAGE-TRAIL-PAIRING`. Admitting a third product is a contract-version
bump coordinated with the Image Trail repo — not a blocker, but not free either.

## Finding 7 — the gate suite is part of the cost

Easy to overlook when scoping. The repo's quality regime is
[ADR-0001](./adr/ADR-0001-Automation-Check-Governance.md)-governed and substantial:
~25,000 lines of test code across 140 test files, 29 Storybook stories, and a
Playwright E2E lane in which **all 27 specs are bound to
`playwright._electron`**.

- A web-view port keeps most of this.
- A React Native port loses the E2E lane and the story lane, and keeps the unit
  tests only insofar as the core stays TypeScript.
- A native-core rewrite (Rust/Swift/Kotlin) invalidates the c8 coverage floors,
  the type-coverage floor, and most of the 140 test files — and the floors are
  **ratchets that may only ever rise**. A second language means a second gate
  suite that today's automation does not govern at all. ADR-0003 rejected Tauri
  substantially for this reason; that argument has not weakened.

## Platform-by-platform

| Target          | Real status                                                                                                                                           | Dominant cost                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Windows**     | **Already ships.** Needs a signing cert ([#128](https://github.com/qwts/photos/issues/128)).                                                          | Release engineering, not porting.                                                         |
| **iPadOS**      | Most tractable Apple target. Three-pane layout survives; density and gestures do not.                                                                 | Touch input model, custody.                                                               |
| **iOS (phone)** | Shell must become a navigation stack; 5 breakpoints to build on.                                                                                      | Layout redesign + touch + custody + background-execution limits for long imports/backups. |
| **Android**     | Comparable to iOS, plus a back-button model that does not exist today, and scoped-storage conflicts with the blob store's hardlink/rename durability. | As iOS, plus storage semantics.                                                           |
| **visionOS**    | Closest to a "hover exists" model (gaze), so hover-reveals partly survive. Inherits iOS core work.                                                    | 24–34px controls are far below spatial-UI guidance.                                       |
| **tvOS**        | **Should be cut from scope as specified** — see [tvOS cannot host a local library](#tvos-cannot-host-a-local-library--cut-or-redefine-it).            | Not a port at all; a different product.                                                   |

### tvOS cannot host a local library — cut or redefine it

This is the one finding that removes work rather than adding it, so it is worth
stating bluntly. Apple's _App Programming Guide for tvOS_ specifies that a tvOS
app gets roughly **500 KB of persistent local storage** (via `NSUserDefaults`).
Everything else — including `Caches` — is **purgeable by the system whenever the
app is not running**, and the app bundle is capped at **4 GB**. Persistent data
is expected to live in iCloud/CloudKit or on your own server.

An encrypted local photo library is therefore **architecturally impossible** on
tvOS. No framework choice changes this; it is a platform guarantee we do not
get. The options are:

1. **Cut tvOS.** Recommended for now.
2. **Redefine it as a cloud viewer** — a streaming client against the existing
   backup provider, sharing the crypto and protocol core but essentially none of
   the library-management model. That is a separate product with its own ADR,
   not a port of this one.

**The constraint was re-verified against a current, non-archived source**, which
is the point most secondary writing gets wrong. The enforcement mechanism is
live and documented on `UserDefaults.sizeLimitExceededNotification`:

> In tvOS, the system posts this notification as a warning when the size of your
> app's defaults database reaches **512 kilobytes**. If your app continues to
> write to the defaults database, the system **terminates your app** when the
> database reaches or exceeds **1 megabyte**. The system doesn't post size
> exceeded notifications for other platforms.

(The archived guide's "500 KB" and this "512 KB" are the same number rounded
differently — cite 512 KB.) There is also affirmative evidence Apple is
_maintaining_ the posture rather than relaxing it: when iOS 18 raised on-demand
resource ceilings from 20 GB to 70 GB and per-pack limits from 512 MB to 8 GB,
**tvOS was deliberately excluded and stayed at 20 GB / 512 MB**.

Stated precisely, so an ADR does not overclaim: the **512 KB / 1 MB enforcement
and the tvOS-specific storage ceilings are current and documented**. The broader
"all other data must be purgeable, store it in iCloud" guidance appears **only**
in the 2017 archived guide and Apple has not restated it. That is a weaker claim
than "Apple currently forbids local storage on tvOS" — but the mechanism alone
is sufficient to rule out a local encrypted library.

Note the hidden cost in option 2: a thin client implies a **server-side library
API that this product does not otherwise need**. That is not a small addition.

## Finding 8 — no single framework covers the six targets

Surveyed 2026-07-18. The headline is not which framework is best; it is that
**tvOS and visionOS fall outside every mainstream cross-platform framework**, so
the six-platform ask cannot be satisfied by one technology choice.

| Option                                      | Covers                                                | Does not cover                                | Notes                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron** (today)                        | Windows, macOS, Linux                                 | iOS, iPadOS, tvOS, visionOS, Android          | Windows already ships.                                                                                                                                                                                                                                                                  |
| **Tauri v2** (2.11.5, 2026-07-01)           | Windows, macOS, Linux, iOS, Android                   | **tvOS, visionOS**                            | Stable mobile since v2.0 (2024-10-02). Rust core — the second toolchain [ADR-0003](./adr/ADR-0003-Desktop-Stack.md) rejected.                                                                                                                                                           |
| **React Native**                            | iOS, iPadOS, Android, Windows (RN-Windows)            | tvOS and visionOS only via **separate forks** | Only via the `react-native-tvos` / `react-native-visionos` community forks (next two rows).                                                                                                                                                                                             |
| **`react-native-tvos`**                     | tvOS, Android TV                                      | —                                             | Community fork, at 0.76.5-0, active through 2026. Not core RN.                                                                                                                                                                                                                          |
| **`react-native-visionos`**                 | visionOS                                              | —                                             | Callstack fork, active through 2026. Not core RN.                                                                                                                                                                                                                                       |
| **Compose Multiplatform** (1.11.x, 2026-05) | Android, iOS, desktop (JVM)                           | **tvOS, visionOS** (UI)                       | iOS UI stable since CMP 1.8.0 (2025-05); KMP stable since 2023-11. See the tvOS/visionOS asymmetry below.                                                                                                                                                                               |
| **.NET MAUI** (10.0.x, .NET 10)             | iOS, iPadOS, Android, Windows (WinUI 3), Mac Catalyst | **tvOS, visionOS** (UI)                       | Best _native_ Windows story of any option. But MAUI 10 support ends 2027-05-11 — it does **not** inherit .NET 10's LTS window.                                                                                                                                                          |
| **Flutter** (3.44.x, 2026-05)               | iOS, iPadOS, Android, Windows, macOS, Linux           | **tvOS, visionOS**                            | tvOS ([#47928](https://github.com/flutter/flutter/issues/47928)) open since 2019, P3, dormant since 2022; visionOS ([#128313](https://github.com/flutter/flutter/issues/128313)) open, P3, tagged "requires significant investment". Windows renderer (Impeller) is still experimental. |
| **Capacitor**                               | iOS, iPadOS, Android                                  | tvOS, visionOS                                | Thinnest wrapper; keeps the existing web UI. Worst fit for a large photo grid — webview memory ceiling plus async bridge.                                                                                                                                                               |
| **Native per platform**                     | **all six**                                           | —                                             | SwiftUI (iOS/iPadOS/tvOS/visionOS), Compose (Android), existing Electron (Windows). Maximum reuse of the _core_, zero reuse of the UI.                                                                                                                                                  |

**The tvOS/visionOS asymmetry is worth understanding precisely**, because two of
these options can share _logic_ even where they cannot share _UI_:

- **Kotlin/Native has tvOS targets at Tier 2** (`tvosArm64`,
  `tvosSimulatorArm64`; `tvosX64` is deprecated as of Kotlin 2.3.20), so KMP can
  share business logic to tvOS under a hand-written SwiftUI layer. **There is no
  Kotlin/Native visionOS target at all** — visionOS gets nothing, not even
  shared logic.
- **.NET has real tvOS _bindings_** (`net10.0-tvos` is a genuine TFM) while
  **MAUI's UI layer does not target tvOS**. Note that MAUI's support-policy page
  lists tvOS among "the SDKs MAUI encompasses", which contradicts its own
  supported-platforms doc; the latter is authoritative for UI targets. Do not
  let that line be cited as evidence MAUI does tvOS. visionOS has no .NET TFM.
- **Flutter has neither, at either layer**, and — correcting a common
  misconception — **there is no Flutter visionOS fork**. The visionOS fork that
  exists is React Native's.

Two consequences worth internalising:

- **Choosing React Native for Apple platforms means running three React Native
  distributions** — core, `react-native-tvos`, and `react-native-visionos` —
  each a full fork tracking core with lag. That is a standing maintenance tax on
  a one-owner project, and it is the kind of second toolchain ADR-0003 rejected
  Tauri over.
- **Only "native per platform, shared core" reaches all six.** That is also the
  option that most directly contradicts ADR-0003's single-TypeScript-toolchain
  driver, and that invalidates the gate suite described in Finding 7. It is
  nonetheless the architecture used by comparable privacy-first apps with a
  cryptographic core, and it is the one that best fits _this_ codebase, because
  the expensive, security-critical, well-specified part (formats, crypto,
  protocol) is exactly the part that would be shared.

This reinforces the sequencing below: the framework question is genuinely
downstream. Specifying the format and solving custody is work that every option
in this table requires, and none of it is wasted whichever is chosen.

## Finding 9 — the image pipeline is seven operations wide

`sharp` looks like a large dependency and is actually a thin one here. There are
**four `sharp()` call sites in the entire codebase**:

- `src/main/export/transcode.ts:37` — `.rotate().jpeg({quality}).toBuffer()`
- `src/main/import/raw-preview.ts:40` — `.metadata()`
- `src/main/import/thumbnail-worker.ts:36` — the resize/webp chain
- `src/main/import/thumbnail-worker.ts:44` — `.metadata()`

Across them the complete API surface is `metadata`, `resize`, `rotate`, `webp`,
`jpeg`, and `toBuffer`. EXIF is isolated to a single file
(`src/main/import/exif.ts`, exifr).

Neither `sharp` nor libvips can run on mobile — sharp is a Node N-API addon with
no JS-runtime equivalent on iOS or Android, and libvips has no supported mobile
build and a heavy glib/gobject dependency graph. But given a seven-operation
surface, **the right move is to reimplement against platform codecs rather than
port an image library**: `CGImageSourceCreateThumbnailAtIndex` (ImageIO) and
`CGImageSourceCopyPropertiesAtIndex` for EXIF on Apple, `ImageDecoder` with
`setTargetSize` plus `androidx.exifinterface` on Android. Both are
hardware-accelerated and stream from disk without a full decode. RAW is better
served natively too — `CIRAWFilter` on Apple covers far more formats than the
current embedded-preview-only policy in [ADR-0006](./adr/ADR-0006-Media-Processing.md);
Android handles only DNG natively and would need LibRaw.

The risk this creates is **derivative divergence**: ADR-0006 pins 512px/2048px
WebP, sRGB conversion honoring embedded ICC, and metadata stripping. Different
decoders will not produce byte-identical output, and blobs are content-addressed
by hash, which interacts with dedup and backup. Decide deliberately whether
derivatives are allowed to differ per platform.

## Finding 10 — if a shared core is chosen, share only the headless part

The only architecture reaching every remaining target is a headless core plus
native UI. The precedents are real and instructive, in both directions:

- **Signal** — `libsignal` is Rust, consumed from Swift on iOS, Kotlin via JNI on
  Android, and **Node via neon** on desktop. That is exactly this project's
  three-way split.
- **Mozilla application-services** — Rust core shared by Firefox iOS and Android,
  and the origin of **UniFFI**, which generates Swift and Kotlin bindings.
- **Matrix** `matrix-rust-sdk` — a sync engine shared into Element iOS/Android.
- **Dropbox — the cautionary tale.** Dropbox shared a C++ core between iOS and
  Android via Djinni, then publicly abandoned it ("The (not so) hidden cost of
  sharing code between iOS and Android", 2019): the overhead of the shared layer
  — bespoke tooling, build systems, hiring, cross-FFI debugging — exceeded the
  duplication it saved.

The rule the successful cases follow: **share what is hard and headless; never
share UI.** Signal and Mozilla share crypto, protocol, and sync. Dropbox tried to
share broad application logic. For Overlook the natural core is
`db/`, `crypto/`, `backup/`, `interop/`, `library/`, plus all of `src/shared/` —
which is also, not coincidentally, the part that is already Electron-free.

Two practical constraints if the core were Rust: `aarch64-apple-tvos` and
`aarch64-apple-visionos` are **Tier 3** Rust targets, meaning no prebuilt `std`
and a nightly `-Z build-std` toolchain, whereas Windows/iOS/Android are Tier 1–2.
C++ is the more boring choice for precisely those two targets. And either way it
is a second toolchain with a second gate suite — the cost ADR-0003 weighed and
rejected. That tradeoff should be re-argued explicitly, not assumed to have
changed.

## Finding 11 — store policy has two real teeth

Both apply to every framework choice equally; they are properties of the product.

- **Encryption export compliance — smaller than feared, but with a recurring
  obligation.** `ITSAppUsesNonExemptEncryption` must be `YES`; AES is a published
  standard, so **no CCATS is required** (that is the proprietary-algorithm path).
  Self-classify **ECCN 5D992.c** under **§740.17(b)(1)**, and file a **French
  declaration** for the FR storefront. **Correction to a common instruction: there
  is no ERN to obtain** — the Encryption Registration Number requirement was
  eliminated by the September 2016 BIS rule, and guides still describing one are
  obsolete. The part most likely to be dropped after launch is the **annual
  self-classification CSV to BIS, due February 1** each year. Give it an owner
  and a calendar entry. Not legal advice.
- **iOS backup exclusion — real, but not the guideline people cite.** There is
  **no 2.5.x guideline covering iCloud backup**; the old numbered rule no longer
  exists, and the requirement now lives in the "Before You Submit" section by
  reference to _Optimizing your app's data for iCloud backup_. Likewise
  **QA1719 is archived and redirects** — cite the current doc. The substance
  holds: the encrypted database and originals are non-reproducible user data and
  belong in `Application Support/` **backed up**, while regenerable thumbnails
  and caches belong in `Caches/` or carry `isExcludedFromBackup`. Two traps —
  some file operations **reset the exclusion flag, so it must be reapplied on
  every save**, and the flag is guidance, not a guarantee. Do **not** exclude key
  material: a restored device that cannot decrypt its restored library is a
  data-loss bug. Corollary worth checking in the current desktop code:
  `Library/Caches` is purgeable, so derivatives must be regenerable on demand
  rather than assumed present.
- **Android's real constraint is not the permission — it is a hard cap.**
  Persisted Photo Picker URI grants are limited to **5,000 per app**, with older
  grants dropped automatically. A whole-library manager does not fit, and that
  cap — not the policy — is what forces the `READ_MEDIA_IMAGES` declaration path,
  which in turn shapes onboarding, the Play listing, and review timeline. Decide
  it early and explicitly. Play's Photo and Video Permissions policy separately
  requires justifying why the system picker is insufficient; a gallery/photo
  manager is the archetypal qualifying case.
- **Android background work wants a three-way split**, and a naive single-service
  design leaves capacity unused: **user-initiated data transfer jobs** (API 34+)
  for uploads, which are **exempt from App Standby quotas**; **WorkManager** for
  incremental sync; and a **`mediaProcessing`** foreground service for bulk
  thumbnailing. The Android 15 six-hour daily cap is tracked **separately per
  service type**, so `mediaProcessing` draws from a different budget than
  `dataSync`. Note also the Play target-SDK deadline: **API 36+ from
  2026-08-31**, extendable to 2026-11-01.

## Finding 12 — iOS background execution is _better_ than the folklore

This finding was revised after a second research pass; the first version of this
page repeated the standard "iOS cannot back up a photo library in the
background", and that is now out of date in a way that materially helps.

**Apple has built this exact feature.** The **PhotoKit Background Resource
Upload extension** — abstract: "Enable reliable cloud backup for photo library
assets with background processing" — has the system manage uploads on the app's
behalf, "processing them in the background even when people switch to other apps
or lock their devices". Version situation matters for planning:

- `PHBackgroundResourceUploadJobExtension` — **iOS 27.0** (clean form)
- `PHBackgroundResourceUploadExtension` — **iOS 26.1**, already **deprecated** in 27

Two are different enough to be separate implementations, so the minimum-iOS
decision should be made deliberately rather than by default. It also requires
**full library access** (`.readWrite` and exactly `.authorized`) — limited access
will not do — and is unavailable in the Simulator.

For user-initiated bulk work there is **`BGContinuedProcessingTask`** (iOS 26),
whose _documented example_ is literally "Creating thumbnails for a new batch of
photo uploads". It starts in the foreground, survives backgrounding, and shows a
cancellable Live Activity. Two constraints shape the design: progress reporting
is mandatory and enforced ("the system prioritizes the termination of tasks that
reflect minimal or no progress"), and if the user closes the app from the app
switcher the task is cancelled **without any notification to the app** — so
checkpointing must be durable, because cleanup will not always run.

What still does not exist is **unattended, continuous, whole-library upload
driven by the app's own process**. Apple's answer is the first-party extension
point above, not a background mode; claiming `audio` or `location` to stay alive
is the classic abuse pattern.

Two corrections to widely repeated numbers, worth recording because they get
copied into designs:

- **The "~30 second" background window has no current Apple source.** The docs
  deliberately say only "a finite amount of time" and direct callers to
  `backgroundTimeRemaining`. The figure appears to originate in a retired guide.
  Do not hardcode it.
- **`BGAppRefreshTask` / `BGProcessingTask` have no documented numeric budgets.**
  Design against the expiration handler, not a clock. What _is_ documented is
  queue depth: 1 refresh task and 10 processing tasks scheduled at a time.

The product consequence is unchanged and still the important part:
**interruption and resumption become first-class states rather than error
paths**. The existing import state machine and the resumable journals in
`src/main/import/` and the interop layer are real assets here — the desktop
design already anticipated the shape mobile forces.

One hazard that is _not_ good news: `PHImageRequestOptions.isNetworkAccessAllowed`
defaults to **false**, so on any device with Optimize iPhone Storage most
originals are not local and requests **silently** return nothing useful. For
byte-exact originals use `PHAssetResourceManager` rather than `PHImageManager`.
There is also a developer-forum report that iCloud-optimized photos are silently
skipped by upload jobs — unconfirmed by Apple, but if true it would gut the
feature for precisely the users who most need backup. **Verify on device early.**

## One concrete iOS gotcha

`plaintext_header_size` is `0` in our databases (verified above), meaning the
entire file including the SQLite magic is encrypted. SQLCipher documents a
non-zero plaintext header specifically so that **iOS can recognise the file as a
SQLite database**. If iOS file-protection or backup behaviour turns out to
require it, changing it is a **format change to every existing library**, not a
runtime flag. Decide this before shipping any iOS client, not after.

## What this spike did not answer

Named honestly rather than papered over:

- Whether upstream SQLCipher on iOS/Android actually opens a real `library.db`.
  Parameters match and SQLite3 Multiple Ciphers documents its `sqlcipher` scheme
  as compatible with SQLCipher 1–4, but no upstream build was used to open a
  file. **Cheap to test — do it first.**
- Framework selection. Deliberately left open; it is downstream of the custody
  decision, not upstream of it.
- Whether derivatives can match across decoders (Finding 9), and whether
  per-platform differences are acceptable given content-addressed storage.
- Product scope. "Port" and "interop companion" are very different products, and
  nobody has decided which this is. This is the actual blocking question.
- Effort estimates. None are given here on purpose — they are not knowable before
  the custody design exists and the SQLCipher experiment has run.
- Whether the current desktop code assumes derivatives are always present, which
  iOS's purgeable `Library/Caches` would violate.
- Anything requiring legal review, including export compliance filings.

## Suggested next steps

Ordered by information gained per unit of effort. Steps 1–4 are days and cost
almost nothing; everything after depends on a product decision.

0. **Fix the scope first, because it is free.** Move Windows to a
   release-engineering item under [#128](https://github.com/qwts/photos/issues/128),
   and cut or redefine tvOS. That takes the ask from six platforms to four
   before any engineering happens.
1. **Open `library.db` with upstream SQLCipher** on iOS and Android. One
   afternoon. Settles the largest open technical question.
2. **Decrypt one blob envelope in Swift** against a committed fixture. Proves the
   envelope spec is complete and reimplementable.
3. ~~**Write the library format spec**~~ — **done**:
   [Overlook Library Format v1](./Library-Format-v1.md). Covers the on-disk tree,
   both `master.key` forms, the key-wrap record, the blob envelope, content
   addressing, the recovery file, the SQLCipher parameters verified above, and
   the protected-album extension — plus a traps section for the inconsistencies
   a second implementation will hit. Writing it already caught one error in an
   earlier draft of this page (the recovery file is **81** bytes, not 77).
   The remaining gap is **test vectors**: the spec has no golden fixtures, so a
   second implementation cannot self-check. That is the natural follow-up and,
   unlike the spec, it needs a PR and CI.
4. **Move `lightbox/geometry.ts` into `src/shared/`** and generate the ~93 design
   tokens from a single source into CSS + TS. This also closes an unenforced
   duplication: `VirtualGrid.tsx:16-19` hardcodes `GRID_GAP = 4` and friends as
   JS constants, with a comment saying they must manually match the CSS tokens.
   They agree today; nothing fails if they stop agreeing.
5. **Decide the product question** — full port versus interop companion — then
   write the custody ADR. Everything else waits on this.
6. Only then choose a UI technology, per platform, with the custody and format
   work already done and shared.

Item 3 deserves emphasis. It is the highest-value item on this list, it is
independent of whether the port is ever approved, and it closes a real
resilience gap in the product today.

## Sources

External claims, checked 2026-07-18. Everything about _this_ repo was verified
directly against the working tree at `abbb413`; the SQLCipher parameters were
measured, not read.

- [Tauri 2.0 stable release](https://v2.tauri.app/blog/tauri-20/) — mobile
  support, platform coverage
- [react-native-tvos](https://github.com/react-native-tvos/react-native-tvos) —
  community fork, Apple TV / Android TV
- [react-native-visionos (Callstack)](https://github.com/callstack/react-native-visionos)
- [React Native out-of-tree platforms](https://reactnative.dev/docs/out-of-tree-platforms)
- [Compose Multiplatform 1.11.0](https://blog.jetbrains.com/kotlin/2026/05/compose-multiplatform-1-11-0/),
  [KMP supported platforms](https://kotlinlang.org/docs/multiplatform/supported-platforms.html),
  [Kotlin/Native target tiers](https://kotlinlang.org/docs/native-target-support.html)
- [.NET MAUI supported platforms](https://learn.microsoft.com/en-us/dotnet/maui/supported-platforms)
  and [MAUI support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
  (note: these two disagree about tvOS)
- Flutter [tvOS #47928](https://github.com/flutter/flutter/issues/47928),
  [visionOS #128313](https://github.com/flutter/flutter/issues/128313),
  [supported platforms](https://docs.flutter.dev/reference/supported-platforms)
- [drift — encryption](https://drift.simonbinder.eu/Platforms/encryption/) —
  recommends SQLite3MultipleCiphers over SQLCipher for native-platform coverage
- [SQLite3 Multiple Ciphers — SQLCipher scheme](https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/)
  — documents compatibility with SQLCipher 1–4 and the `plaintext_header_size`
  rationale for iOS
- [SQLCipher design](https://www.zetetic.net/sqlcipher/design/) — v4 defaults
- [sqlcipher-android](https://github.com/sqlcipher/sqlcipher-android) — note the
  older `android-database-sqlcipher` artifact is deprecated
- [libvips](https://github.com/libvips/libvips) — no supported mobile build
- [`UserDefaults.sizeLimitExceededNotification`](https://developer.apple.com/documentation/foundation/userdefaults/sizelimitexceedednotification)
  — **current** source for the tvOS 512 KB / 1 MB enforcement; plus the archived
  [App Programming Guide for tvOS](https://developer.apple.com/library/archive/documentation/General/Conceptual/AppleTV_PG/index.html)
  for the surrounding (unrestated) guidance
- [tvOS on-demand-resources size limits](https://developer.apple.com/help/app-store-connect/reference/app-uploads/on-demand-resources-size-limits/)
- [Uploading asset resources in the background](https://developer.apple.com/documentation/photokit/uploading-asset-resources-in-the-background)
  — the PhotoKit background upload extension
- [`BGContinuedProcessingTask`](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
  and [Performing long-running tasks on iOS and iPadOS](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados)
- [`PHImageRequestOptions.isNetworkAccessAllowed`](https://developer.apple.com/documentation/photos/phimagerequestoptions/isnetworkaccessallowed)
- [Apple: complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
  and [BIS annual self-classification](https://www.bis.gov/learn-support/encryption-controls/annual-self-classification)
- [Optimizing your app's data for iCloud backup](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup)
  — supersedes the archived QA1719
- [Android Photo Picker](https://developer.android.com/training/data-storage/shared/photopicker)
  (5,000 persisted-grant cap) and
  [user-initiated data transfer jobs](https://developer.android.com/develop/background-work/background-tasks/uidt)
- [Foreground service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout)
  and [Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Android 15 behavior changes](https://developer.android.com/about/versions/15/behavior-changes-15)
  — `dataSync` foreground-service cap
- [Dropbox: the (not so) hidden cost of sharing code between iOS and Android](https://dropbox.tech/mobile/the-not-so-hidden-cost-of-sharing-code-between-ios-and-android)
- [libsignal](https://github.com/signalapp/libsignal),
  [Mozilla UniFFI](https://mozilla.github.io/uniffi-rs/),
  [Rust platform support tiers](https://doc.rust-lang.org/rustc/platform-support.html)
