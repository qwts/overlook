---
'overlook': patch
---

Import journal now appends per-file stage transitions (with periodic compaction) instead of rewriting the whole batch manifest on every transition, and import progress events no longer rescan the batch — importing a 100k-file card no longer costs O(N²) CPU/IO or gigabytes of allocation churn. Crash-safety is unchanged: torn writes never corrupt previously journaled state, and journals written by earlier builds still resume.
