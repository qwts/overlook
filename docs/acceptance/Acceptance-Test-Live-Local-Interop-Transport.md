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

- `src/shared/interop/live-local-prototype.ts`
- `tests/interop/live-local-transport-prototype.test.ts`

The shared module is marked test-only and has no production importer. It
exists to keep the ADR executable while #544 and #545 remain gated.

## Production follow-up gates

[#544](https://github.com/qwts/overlook/issues/544) must prove:

- the packaged signed host distinguishes every running state;
- native-host launch origin and browser manifest identity remain exact;
- macOS socket ownership/stale cleanup and Windows named-pipe ACLs survive
  install, upgrade, disable, and uninstall;
- unsupported platforms install and listen to nothing;
- MV3 suspension/restart retries through a fresh bootstrap without persisting
  capability authority.

[#545](https://github.com/qwts/overlook/issues/545) must prove:

- ADR-0014 envelopes and ADR-0016 ciphertext chunks are the only bulk payloads;
- transfer journals, replay receipts, verification, and durability
  acknowledgements are identical to the cloud transport path;
- sustained representative-original throughput, memory, backpressure,
  cancellation, app disappearance, and restart behavior;
- no listener, native proxy, timer, or producer survives app/session teardown.

These owner-run and production-composition gates cannot be marked complete by
the prototype.
