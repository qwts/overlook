# Overlook and Image Trail interoperability contracts

This directory contains the versioned, distributable contract artifacts used by
Overlook and Image Trail. The runtime schemas live under
`src/shared/interop/`; committed JSON schemas, golden fixtures, and
`SHA256SUMS` let the sibling repositories enforce exact parity without a
network dependency during builds.

Contract v1 also defines the provider object paths used by Move:

- `messages/outbox/<12-digit-sequence>-<message-id>.json.aesgcm`
- `messages/acknowledgements/<12-digit-sequence>-<message-id>.json.aesgcm`
- `blobs/<record-interop-id>/original.bin.aesgcm`

`provider-root.json` pins the shared logical subtree as
`Overlook Interop/v1`. It is provider-relative: adapters resolve it below the
provider-owned app root and must not treat it as an account-root absolute path.
The same artifact pins the complete Google Drive discovery protocol: the
app-property owner, property keys, SHA-256 encoding, and root/library/folder/file
identity templates. An identically named folder with different custody or path
identity therefore cannot appear conforming.

Messages use `sealed-message.schema.json`; original bytes use the nested binary
format in `sealed-blob.md`. An accepted Move containing an original must
acknowledge both its record and blob protocol message IDs. The storage object
for the binary original is not itself a protocol message.

Run `npm run interop:generate-contract` after an intentional contract change.
Commit the regenerated schemas and checksum with the runtime change. Consumers
must reject unsupported versions and checksum mismatches; they must not silently
fall back to a locally modified contract.

Contract v1 is tracked by `qwts/photos#331`, `qwts/overlook#929`, and
`qwts/image-trail#584`.
Its architecture decision is canonical in the Photos wiki:
[ADR-0014](../../../docs/adr/ADR-0014-Image-Trail-Bidirectional-Interoperability.md).
