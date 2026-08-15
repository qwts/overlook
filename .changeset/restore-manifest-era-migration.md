---
'overlook': patch
---

Legacy backup manifests now migrate to the current field contract in one place, when they are parsed for restore: optional fields whose absence does not round-trip through a rebuilt catalog are normalized per their documented contracts (absent `mediaInfo` becomes null). Every supported manifest schema era (2–6) is covered by a regression test that restores an era-exact manifest end to end, so a future manifest field addition fails tests instead of rejecting existing backups as corrupt.
