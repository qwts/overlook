---
'overlook': patch
---

Fix the Windows signature-verification step in the Package workflow: it called `signtool.exe`, which isn't on `windows-latest`'s `PATH` (the first real release run failed here even though Azure Trusted Signing itself succeeded). Switched to PowerShell's builtin `Get-AuthenticodeSignature` cmdlet instead.
