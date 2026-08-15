---
'overlook': patch
---

Restore no longer fails with "rebuilt catalog does not match the verified projection" for backups made before probed media info existed: the catalog equality check now normalizes an absent `mediaInfo` to null, per the manifest schema contract. The restore error panel's Copy error button now uses the app clipboard bridge, so it actually copies.
