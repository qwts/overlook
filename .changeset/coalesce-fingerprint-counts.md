---
'overlook': patch
---

Coalesce background fingerprint progress counts so fast indexing and deferral bursts do not repeatedly scan the entire library. Explicit status reads and final completion counts remain current.
