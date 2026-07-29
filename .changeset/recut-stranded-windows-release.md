---
'overlook': patch
---

Windows packages ship only the target architecture's onnxruntime binaries again. The v0.64.0 and v0.64.1 builds bundled foreign-architecture binaries, failed release verification, and were never published — this release supersedes both stranded tags.
