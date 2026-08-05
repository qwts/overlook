---
'overlook': patch
---

Restore everything that verifies when no retained cloud backup generation is
complete, instead of failing the whole restore over a single missing object.
Unrecoverable objects are reported in full as NOT FOUND, kept visible in the
library as errored rows, listed durably in restore-report.json, and filled in
by re-running the restore after they are recovered on the provider.
