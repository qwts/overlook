# Windows ARM64 signed release acceptance

Owner-only acceptance for the native Windows-on-ARM installer (#683). CI proves
each installer is architecture-pure and Authenticode-verifiable; this manual
pass proves the signed ARM64 build actually launches and exercises the core
library flows on a Windows ARM64 device. Run it on a real Windows-on-ARM
machine (Snapdragon/other ARM64 silicon), not on x64 under emulation.

Use a throwaway scratch library; never open an existing production library
while testing.

## Artifact prerequisites

- Dispatch the **Release** (or **Package**) workflow for the exact
  release-candidate tag/commit.
- Confirm every Windows gate passed for the `arm64` leg:
  - `verify-windows-arch.mjs arm64` — the installed `Overlook.exe` and every
    shipped `*.node` (sharp, encrypted SQLite) report PE machine `0xAA64`; no
    x64 payload leaked in.
  - `signtool verify /pa /v` — the `Overlook-<version>-arm64.exe` installer
    carries a valid Authenticode signature and RFC 3161 timestamp.
  - The artifact was uploaded as `overlook-windows-arm64` and the release
    carries **both** `-x64.exe` and `-arm64.exe` installers.
- Download `Overlook-<version>-arm64.exe`. Do not test the x64 installer or a
  local development build.

## Trust and signature check (on the ARM64 device)

1. Right-click the installer → **Properties → Digital Signatures**. Confirm a
   single signature from the expected publisher, a valid certificate chain, and
   a countersignature timestamp.
2. From an elevated PowerShell:

   ```powershell
   Get-AuthenticodeSignature .\Overlook-<version>-arm64.exe
   ```

   Expect `Status: Valid` and the expected signer subject. `NotSigned` or
   `HashMismatch` fails acceptance.

3. Install. Windows SmartScreen must not report an unknown/untrusted publisher
   for a correctly signed Azure Trusted Signing (individual identity
   validation) certificate.

## Smoke checklist (installed ARM64 app)

Perform each step and confirm the expected result. Any failure fails
acceptance.

1. **Launch** — the app starts natively. Confirm in Task Manager that
   `Overlook.exe` runs as **ARM64** (Architecture column), not `ARM64 (x86)` or
   `x64` emulation.
2. **Library create** — create a new library in a scratch folder; it opens
   without error.
3. **Library open** — close and reopen the same library; contents persist.
4. **Import** — import a small representative set (JPEG, HEIC, PNG); thumbnails
   generate and the grid populates.
5. **Encrypted-database restart** — fully quit and relaunch; the encrypted
   SQLite database reopens and the imported items are intact (proves the ARM64
   `better-sqlite3-multiple-ciphers` prebuild decrypts on restart).
6. **Image decode** — open a full-resolution image in the lightbox and confirm
   it decodes and displays (proves the ARM64 `sharp`/libvips prebuild runs).

## Recording the result

Record the tag, artifact SHA, device (Windows build + ARM64 SoC), and
pass/fail per step in the issue/PR that ships the signed release. Never paste
certificate material, passwords, or the signing thumbprint into logs or the
issue.
