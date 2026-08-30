# Undo and Redo

Undo and Redo are durable, per-library command stacks governed by
[ADR-0025](./adr/ADR-0025-Encrypted-Activity-History-And-Capability-Aware-Undo.md).
They are separate from Activity: Activity records what happened, while command
records hold the minimum encrypted inverse state needed to safely reverse it.

## Supported actions

| Action                        | Class                    | Result                                                      |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| Favorite change               | Immediately reversible   | Restores the prior favorite state                           |
| Add/remove album membership   | Immediately reversible   | Restores the prior membership set                           |
| Move to or restore from Trash | Conditionally reversible | Applies only while every photo still has a compatible state |
| Move import                   | Compensating-only        | Recreates a verified source file at its exact original path |
| Permanent purge and export    | Irreversible             | Recorded in Activity, never placed on either stack          |

Undo and Redo are available from the Edit menu, keyboard shortcuts, and the
Activity dialog. Disabled controls show the current reason. The main process
revalidates every request, so a previously displayed capability is never an
authorization token.

## Capability reasons

`empty-stack`, `expired`, `state-changed`, `resource-missing`, `path-occupied`,
`permission-denied`, `insufficient-space`, `bytes-unavailable`, and
`irreversible` are stable user-facing reason codes. `ready` is the only reason
that permits execution. A failed revalidation leaves the stack unchanged.

## Move compensation safety

A Move import persists a source lease before unlinking the source. Compensation
is offered for seven days only when the encrypted original remains available
and the command fits the smaller of the 2 GiB or 10%-of-free-library-space
budget. Execution verifies the original parent identity, destination vacancy,
permissions, free space, decrypted content hash, and library key access.

The source is reconstructed through a private temporary file, then published
with a no-replace link. Supported POSIX hosts fsync the directory entry; Windows
skips that unsupported operation after preserving the regular-file fsync and
atomic publication boundary. Existing paths are never overwritten or silently
renamed. Successful compensation is intentionally not redoable.

## Retention and privacy

Each library retains at most 100 commands for 30 days. Sensitive external paths
and Move leases expire after seven days. New commands clear that library's Redo
branch. Command request receipts make retries idempotent across renderer retries
and process restart. Paths stay in the encrypted command record and never enter
Activity, diagnostics, sync, or export.
