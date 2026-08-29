# Live Local Interop Threat Model

Issue: [#543](https://github.com/qwts/overlook/issues/543)  
Decision: [ADR-0029](./adr/ADR-0029-Authenticated-Live-Local-Interop-Transport.md)

## Security objective

When Image Trail and Overlook are open for the same signed-in desktop user, the
released extension may open one bounded local session that transports only the
existing encrypted interoperability protocol. A website, unrelated extension,
different local user, stale native host, or unrelated local process must not
gain a session by discovering a port or endpoint.

This boundary does not defend against a process already executing with the
same user's full privileges and able to read or modify both applications'
memory. It does defend against ambient web origins, unrelated extensions,
cross-user access, accidental endpoint exposure, replay, downgrade, malformed
inputs, and resource exhaustion.

## Assets and forbidden data

Protected assets are pairing authority, encrypted protocol records and
originals, durable acknowledgements, and the right to request work from an
unlocked Overlook process.

The bootstrap, capability, endpoint names, logs, and errors must never contain
plaintext photo bytes, decrypted metadata, filenames, local paths, provider
credentials, library keys, pairing keys, or recovery material. The capability
secret is authority but not content; it remains memory-only and expires within
15 seconds.

## Trust boundaries

1. **Chromium to signed native host:** browser manifest allowlist, released
   extension origin, packaged signature, bounded Native Messaging framing.
2. **Native host to running Overlook:** user-scoped Unix socket or Windows
   named pipe, peer ownership, strict bootstrap schema, bounded response.
3. **Extension to loopback listener:** exact `Origin`, first-frame
   capability redemption, pairing/operation/version binding, expiry and
   single-use consumption.
4. **Local stream to durable interop engine:** ADR-0014 schema, encryption,
   replay identity, journal, verification, and acknowledgement gates.

Crossing one boundary never substitutes for the next. In particular, loopback
port knowledge is not authentication and a successful WebSocket upgrade is not
a durability acknowledgement.

## Threats and controls

| Threat                               | Required control                                                      | Automated evidence                                  |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| Website scans localhost              | Exact extension `Origin`; reject before upgrade                       | Wrong/missing Origin cannot open a session          |
| Unrelated extension invokes host     | Manifest allowlist plus exact launch-origin check                     | Wrong extension bootstrap fails closed              |
| Rogue local process discovers port   | 256-bit memory-only capability redeemed in first frame                | Port-only and wrong-secret attempts fail            |
| Capability copied or replayed        | 15-second monotonic expiry; atomic single-use consumption             | Expiry and concurrent replay tests                  |
| Protocol downgrade                   | Version range selected at bootstrap and repeated at redemption        | Lower or changed version is rejected                |
| Cross-pairing confused deputy        | Capability binds pairing ID and operation                             | Wrong pairing/operation fails before data           |
| Cross-user endpoint access           | Mode `0700` socket directory or current-user pipe ACL                 | Production macOS modes and Windows kernel DACL      |
| Stale socket hijack                  | Owned-directory validation and live-peer probe before cleanup         | Production macOS rejects foreign/live endpoints     |
| Oversized bootstrap/frame            | 64 KiB control ceiling and 4 MiB ciphertext-frame ceiling             | Boundary and over-limit tests                       |
| Memory/CPU exhaustion                | Negotiated in-flight budget, backpressure, one session per capability | Peak buffered bytes remain within the bound         |
| Slow or abandoned client             | Bootstrap, redemption, idle, and cancellation deadlines               | Bounded teardown and cancellation latency           |
| Native host becomes data proxy       | Bootstrap-only response; host exits before bulk stream                | Production host forwards one bounded control result |
| Listener escapes loopback            | Explicit `127.0.0.1` bind; no wildcard/hostname bind                  | Production listener bound-address assertion         |
| Logs leak authority or content       | Closed error vocabulary; no raw frames, URLs, secrets, or paths       | No logs; generic errors omit authority and content  |
| Desktop is locked                    | Authority check before capability issuance                            | Typed `locked` state, no endpoint capability        |
| App disappears after acknowledgement | ADR-0014/0015 durable acknowledgement remains authoritative           | Retry only unacknowledged work                      |

## Residual risks

- A fully compromised same-user process can inspect either application's memory
  and is outside this boundary.
- Browser and Electron defects can bypass origin or process isolation; release
  updates and signing remain required.
- Loopback traffic is observable to sufficiently privileged local tooling.
  Application-layer encryption remains mandatory even though the route is
  local.
- MV3 suspension can waste an issued capability. Expiry makes this a retry, not
  a reason to lengthen or persist authority.
- A process already running as the current Windows user can invoke the pipe.
  The origin allowlist and one-use capability remain separate required gates;
  pipe possession alone grants no bulk-data authority.
- Packaged macOS signing behavior requires owner-run evidence before production
  closeout.

## Production gates

ADR acceptance requires deterministic evidence for the closed threat matrix.
#544 composes the macOS bootstrap and must add signed packaged evidence. #1066
composes the Windows production ACL and signed-package evidence. #545 must
prove encrypted transfer, backpressure, cancellation, replay, and durable
journal behavior on the production composition. None may introduce a daemon
or plaintext fallback without an ADR amendment.
