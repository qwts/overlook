---
'overlook': minor
---

Common video and Apple/iPhone media import as first-class library items: MP4/M4V, QuickTime MOV (H.264, HEVC, ProRes), WebM, AVI, MPEG-PS, and provisional Matroska classify by byte signature — never by extension — with bounded probes recording container, codecs, duration, dimensions, rotation, frame rate/VFR, audio presence, and HDR color hints. Audio-only MPEG files classify as audio, never as fake video. Playability stays a per-device runtime derivation: MP4/QuickTime/WebM play when every stream decodes locally; AVI, MPEG-PS, and Matroska are preserved-only (imported, protected, backed up, exported) with honest playback-limitation UI. Range-served playback MIME follows the probed container.
