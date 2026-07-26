# ADR-0029: Authenticated Live Local Interop Transport

## Status

Accepted 2026-07-25 on
[#543](https://github.com/qwts/overlook/issues/543).
Production work in [#544](https://github.com/qwts/overlook/issues/544) and
[#545](https://github.com/qwts/overlook/issues/545) must implement this
contract without semantic changes; changes land here first as an amendment.

Extends
[ADR-0014](./ADR-0014-Image-Trail-Bidirectional-Interoperability.md) and
[ADR-0016](./ADR-0016-Isolated-Encrypted-Interop-Transports.md). The companion
analysis is the
[live local interop threat model](../Live-Local-Interop-Threat-Model.md).
Executable evidence is indexed by the
[live local interop acceptance test](../acceptance/Acceptance-Test-Live-Local-Interop-Transport.md).

## Context

Image Trail can reach Overlook's signed native-messaging executable, but the
released boundary currently processes one narrowed iCloud request and exits.
It neither discovers a running desktop process nor establishes a session for
large, resumable encrypted transfers. Cloud transports remain correct for
cross-machine exchange, but impose remote custody and latency when both
products are already open on one machine.

The local path must preserve the existing pairing, envelope, replay, journal,
and acknowledgement contracts. Native Messaging is suitable for trusted
extension bootstrap but its JSON framing and per-message process lifecycle are
not a bulk stream. A bare loopback listener is efficient but discoverable by
unrelated local pages and processes. A permanent daemon would enlarge the
attack and lifecycle surface for a workflow that requires both apps to be open.

## Decision

The accepted design uses a three-part transport. The deterministic prototype
meets the evidence bounds below without entering a production composition
root.

### Bootstrap and rendezvous

1. The released Image Trail extension starts the existing signed
   `com.qwts.overlook.interop` Native Messaging host. Chromium's manifest and
   launch-origin checks remain the first origin boundary.
2. The host connects to a user-scoped control endpoint owned by the running
   Overlook process: a Unix-domain socket inside a mode `0700` runtime
   directory on macOS, and a named pipe restricted to the current user SID on
   Windows.
3. The control endpoint returns either a typed running-state result or one
   short-lived connection capability. The native host forwards that bounded
   response and exits. It never proxies original bytes.
4. The extension redeems the capability as the first control frame on an
   ephemeral WebSocket bound only to loopback. No capability appears in a URL,
   query, log, persistent file, renderer state, or cloud object.

Linux remains unsupported for the MVP. Its future user-runtime-directory and
peer-credential contract requires an ADR amendment or a separately accepted
platform extension.

### Capability contract

A capability is strict, versioned data containing:

- a random 256-bit secret and independent random session identifier;
- the loopback endpoint and exact released extension identity;
- the expected pairing identifier and requested operation;
- the selected protocol version and supported-version bounds;
- issue and expiry instants using a monotonic lifetime no longer than 15
  seconds;
- one maximum ciphertext-frame size and one maximum in-flight byte budget.

The running app keeps only an in-memory digest of the secret. Redemption
atomically consumes the capability before any transfer frame is accepted.
Expiry, replay, wrong extension, wrong pairing, wrong operation, malformed
data, and version downgrade are non-retryable failures. A disconnect after
redemption requires a new Native Messaging bootstrap; a capability is never
resumed or refreshed.

### Authenticated loopback stream

The listener binds an operating-system-selected port on `127.0.0.1` only and
exists only while Overlook is open and a capability is outstanding or a
session is active. Upgrade requests require the exact Image Trail extension
`Origin`; unrelated origins fail before WebSocket acceptance. The first
application frame redeems the capability and negotiates the already selected
protocol version again, preventing downgrade between bootstrap and stream.

Only ADR-0014 envelopes and ADR-0016 encrypted chunks cross the stream.
Plaintext metadata, originals, pairing keys, provider credentials, and local
paths are forbidden. Ciphertext frames are individually bounded at 4 MiB and
the sender stops reading when the negotiated in-flight budget is exhausted.
Acknowledgements release budget. Cancellation closes producers before the
socket and must become observable within the prototype bound.

The loopback channel does not replace application-layer encryption or durable
journals. It is a local transport for the same encrypted protocol objects.

### Running-state and error contract

Bootstrap distinguishes:

- `running` with a redeemable capability;
- `not-running` when the user-scoped endpoint is absent;
- `locked` when Overlook has not released the required pairing authority;
- `incompatible` when version ranges do not overlap;
- `unavailable` for a transient endpoint or resource failure.

Unsupported platform, origin rejection, malformed or oversized bootstrap,
expiry, replay, downgrade, and pairing mismatch use the shared non-retryable
interop vocabulary. Resource pressure, cancellation, and a disappearing app
remain retryable only when no durable protocol acknowledgement was issued.

### Lifecycle and packaging

Overlook creates the control endpoint only after single-instance ownership and
removes it during shutdown. Startup repairs a stale macOS socket only after
proving it is inside the owned runtime directory and no live peer accepts a
connection. Windows creates a fresh named-pipe instance with an explicit
current-user access control list.

The existing signed app executable remains the Native Messaging host. No
launch agent, login item, service, always-running daemon, or unsigned helper is
introduced. Install, upgrade, and uninstall continue to own only the browser
manifests already governed by ADR-0016; production registration of the new
control endpoint belongs to #544.

## Alternatives

- **Native Messaging for bulk transfer:** rejected because length-prefixed JSON,
  base64 expansion, process lifecycle, and browser limits make it a poor
  backpressured ciphertext stream.
- **Bare loopback WebSocket:** rejected because a port alone is not authority;
  hostile pages and local processes can probe loopback.
- **OS IPC for the entire transfer:** retained as a fallback if measurements
  reject WebSocket, but not preferred because extension JavaScript cannot use
  Unix sockets or named pipes directly and a long-lived native proxy adds
  copies and lifecycle complexity.
- **Launch agent or daemon:** rejected for the both-apps-open workflow because
  it adds persistence, installation, update, and idle attack surface.
- **WebRTC:** rejected because signaling, ICE, data-channel negotiation, and
  browser lifecycle exceed a same-machine transport's needs.
- **Cloud relay:** rejected because local availability must not create new
  remote custody or network dependence.

## Acceptance evidence

The deterministic prototype records:

- startup-state classification and capability issue/redeem latency;
- rejection of wrong origin, rogue loopback clients, malformed and oversized
  bootstrap, expired/replayed capabilities, wrong pairing, and downgrade;
- sustained bounded transfer without a whole-original base64 copy;
- negotiated in-flight memory ceiling, producer backpressure, and cancellation
  latency;
- MV3 worker suspension between bootstrap and redemption;
- macOS socket ownership/stale cleanup and Windows named-pipe ACL seams;
- packaged-host registration and uninstall implications.

`tests/interop/live-local-transport-prototype.test.ts` exercises a real
user-scoped Unix rendezvous and loopback WebSocket. It transfers 16 MiB as
bounded binary frames with an 8 MiB producer window, sustains more than the
1 MiB/s floor, observes cancellation within 250 ms, and closes every threat
listed above. The Windows seam emits the current-user-only SDDL but remains a
production platform gate.

The prototype is evidence, not a production transport. #544 owns bootstrap and
packaging; #545 owns durable transport-journal composition. The complete
evidence and remaining owner-run gates are in the
[acceptance test](../acceptance/Acceptance-Test-Live-Local-Interop-Transport.md).

## Consequences

- Native Messaging remains a small signed bootstrap instead of becoming a
  second bulk protocol.
- A rogue page needs both the released extension origin and an unredeemed
  single-use secret; port discovery alone grants nothing.
- Existing encrypted envelopes and durable replay/journal rules remain the
  authority for transfer correctness.
- The design adds two local endpoints and cross-platform lifecycle work.
- Linux local transport and background sync remain deliberately unsupported.
