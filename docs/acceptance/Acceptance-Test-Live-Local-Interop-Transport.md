# Acceptance Test: Live Local Interop Transport

Issue: [#543](https://github.com/qwts/overlook/issues/543)  
Decision:
[ADR-0029](../adr/ADR-0029-Authenticated-Live-Local-Interop-Transport.md)  
Threat model: [Live Local Interop](../Live-Local-Interop-Threat-Model.md)

## Prototype evidence

The deterministic prototype proves the contract without entering a production
composition root:

1. An absent user-scoped Unix socket reports `not-running`; a real mode-`0700`
   rendezvous distinguishes `locked`, `incompatible`, and `running`.
2. The Windows seam derives a privacy-safe pipe name from the current user SID
   and emits a protected DACL granting generic-all only to that SID.
3. Capabilities carry 256 random secret bits, remain valid across a simulated
   MV3 suspension shorter than 15 seconds, expire after the bound, and are
   consumed atomically on success or failed authority validation.
4. Wrong extension, pairing, operation, secret, version, expiry, replay,
   malformed control data, and oversized control data fail closed.
5. The real HTTP upgrade listener binds `127.0.0.1`, rejects non-Image-Trail
   origins before upgrade, and requires the exact WebSocket subprotocol.
6. The first application frame redeems the capability. No secret appears in
   the URL, endpoint path, server metrics, or closed error strings.
7. Sixteen MiB of synthetic ciphertext moves as 512 KiB binary frames. The
   producer byte window never exceeds 8 MiB, no frame exceeds the ADR-0016
   4 MiB ceiling, and no base64 original is created.
8. Local sustained throughput exceeds the deliberately conservative 1 MiB/s
   prototype floor. Cancellation is observed and closed within 250 ms.
9. A control frame one byte above 64 KiB is rejected from its declared length
   before JSON parsing or payload allocation.

Automated evidence:

- `src/main/interop/live-local-security.ts`
- `tests/interop/live-local-transport-prototype.test.ts`

The security contract was promoted intact from the prototype into the main
process for #544. The bulk-stream and journal harness remains deterministic
evidence for #545 rather than a second production transport.

## Production macOS evidence

[#544](https://github.com/qwts/overlook/issues/544) composes the accepted
bootstrap on macOS:

1. The desktop owns a deterministic per-user, per-profile Unix endpoint in a
   mode-`0700` directory and sets the socket to mode `0600`.
2. Startup refuses foreign endpoint files and a second live desktop peer. A
   dead owned socket is the only stale endpoint it removes.
3. The existing signed native-messaging executable forwards one bounded,
   versioned bootstrap request without entering iCloud storage authority.
4. The ephemeral listener binds `127.0.0.1`, checks the exact released
   extension Origin and WebSocket subprotocol, and accepts data only after
   first-frame capability redemption.
5. Lock revokes outstanding capabilities and closes active sessions; shutdown
   closes both endpoints. Unsupported platforms create no listener.

Automated production evidence:

- `src/main/interop/live-local-control.ts`
- `src/main/interop/live-local-session.ts`
- `src/main/interop/live-local-bridge.ts`
- `src/main/interop/live-local-native.ts`
- `tests/interop/live-local-production.test.ts`
- `tests/interop/transport.test.ts`

## Production Windows evidence

[#1066](https://github.com/qwts/overlook/issues/1066) composes the same
bootstrap through a narrow Node-API binding:

1. The desktop hashes the current process-token SID into the endpoint name and
   creates one named-pipe instance with a protected DACL granting access only
   to that SID.
2. The binding asks Windows for the pipe's actual security descriptor before
   publishing readiness, rejects remote clients, and prevents a second server
   from claiming the endpoint.
3. A dedicated worker thread owns bounded connect, read, and write operations;
   synchronous Win32 waits never block Electron's main thread.
4. The signed executable remains the native-messaging host. Per-user Chromium,
   Chrome, Brave, and Edge registry values point to an executable-versioned
   manifest, and cleanup removes only values owned by that exact manifest.
5. Native tests exercise the real kernel DACL, second-owner rejection, bounded
   framing, recovery after an oversized frame, and exact-owner registry
   cleanup on `windows-latest`.

Automated production evidence:

- `native/windows-interop/windows_pipe.cc`
- `native/windows-interop/test.cjs`
- `src/main/interop/windows-live-local.ts`
- `src/main/interop/windows-pipe-worker.ts`
- `src/main/interop/windows-native-host-registry.ts`
- `.github/workflows/package.yml`

## Production follow-up gates

The remaining #544 owner-run gate must prove the signed packaged macOS host
across install, upgrade, disable, and uninstall. The deterministic production
tests prove:

- native-host launch origin and browser manifest identity remain exact;
- unsupported platforms install and listen to nothing;
- MV3 suspension/restart retries through a fresh bootstrap without persisting
  capability authority.

The packaged executable exposes a headless `--unregister-native-host` cleanup
seam for disable and uninstall flows. It removes only manifests whose canonical
host name, exact executable path, and released extension origin match that app
copy. Run it before removing the app bundle; a stale older app copy cannot
unregister a newer installation.

The #1066 signed-package gate builds x64 and ARM64 installers, verifies every
packaged native binary has the target machine type, and verifies Authenticode
when the repository's Azure signing credentials are present. The x64 leg also
runs the binding against the real Windows kernel, then silently installs and
repairs the package, registers and disables the native host, and proves the
uninstaller invokes exact-owner cleanup before removing the executable.

[#545](https://github.com/qwts/overlook/issues/545) must prove:

- ADR-0014 envelopes and ADR-0016 ciphertext chunks are the only bulk payloads;
- transfer journals, replay receipts, verification, and durability
  acknowledgements are identical to the cloud transport path;
- sustained representative-original throughput, memory, backpressure,
  cancellation, app disappearance, and restart behavior;
- no listener, native proxy, timer, or producer survives app/session teardown.

The signed-package gates cannot be marked complete by deterministic tests.
