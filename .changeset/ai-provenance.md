---
'overlook': minor
---

**AI-generation provenance.** The Inspector gains a **Provenance** section that shows what a photo's own bytes say about how it was made, as evidence tiers rather than a verdict: **Verified provenance** (a Content Credential validated for these exact bytes), **Declared** (XMP, EXIF, PNG, or sidecar metadata naming a generator, an AI edit, a tool, or a capture — shown verbatim and marked "not verified"), **Detected** (a reviewed detector with its version, confidence, and limits), and **Unknown** (no supported evidence — explicitly not a claim that a person made the image). Everything is evaluated locally with no network path; a present Content Credential that this version cannot validate is reported as present but unverifiable, never as verified. Evidence is bound to the photo's bytes and re-checked when they or the checker change, stays inside the encrypted library, and rides in backups (manifest schema 12, library schema 32).
