---
'overlook': patch
---

Fix the Windows ARM64 installer silently omitting every ARM64 binary. electron-builder compresses the NSIS payload with a downloaded 7-Zip 24.x, which auto-applies its ARM64 branch filter (method `0A`); the much older `nsis7z` plugin that unpacks the payload at install time cannot decode that filter and skipped each affected file while reporting success. The result installed `Overlook.exe` and 10 ARM64 DLLs' worth of nothing — a complete-looking install with no executable. The Windows legs now pin `ELECTRON_BUILDER_7Z_FILTER=BCJ2`, which `nsis7z` can decode; filters are reversible, so extracted bytes are unchanged.
