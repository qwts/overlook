---
'overlook': patch
---

Judge library-lock staleness by a stable machine identity instead of the hostname, so a crashed instance's lock is reclaimed even after the hostname drifts with network state (`.local` ↔ `.lan`). Startup now fails loud when the selected library is lock-held by another instance, naming the holder and pointing at the library switcher instead of leaving the user in a different library.
