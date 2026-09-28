# Library Management

How Overlook keeps track of your libraries, how moving them works, and how to
repair things when a disk goes missing or a move is interrupted. Contracts:
[ADR-0017](./adr/ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) (registry,
identity, lifecycle) and
[ADR-0022](./adr/ADR-0022-Library-Relocation-And-Registry-Path-Rewrite.md) (relocation).
Feature work: [#483](https://github.com/qwts/photos/issues/483).

## The registry, in one paragraph

Overlook keeps a small `libraries.json` file in its profile listing every
library it knows: a permanent ID, a display name, and the folder path. The ID
lives inside the library folder itself (the `library-id` file) and travels
with it — the path is just where the library currently is. Removing a library
from the list never touches its files.

## Moving a library (relocation)

**Move…** in a library's ⋯ menu in the library switcher relocates it, and
**Move several…** below the list picks more than one to move together —
to an external disk, another folder, anywhere writable. The whole folder
moves intact: encrypted database, keys, originals, thumbnails, settings,
journals. The ID does not change, so provider connections, backup history,
and remote storage all keep working — nothing is uploaded, downloaded,
re-imported, or re-encrypted.

The order of operations is built for zero data loss:

1. **Copy** — the library is copied into a private staging folder on the
   destination. The original stays in place and stays in charge.
2. **Verify** — every copied file is re-read and checksummed (SHA-256), and
   the copied database is opened with your existing keys to prove the copy is
   real, not just present.
3. **Commit** — one atomic update re-points the registry at the new location.
   This is the single moment the move "happens."
4. **Clean up** — only after the commit does the original get removed.

Kill the app or unplug the disk at any point **before** step 3 and the original
library is untouched and still registered. On the next launch, Overlook shows
both paths and lets you resume after re-verifying every staged file, or discard
the staged copy. Cancel explicitly discards the staged attempt. If step 4 fails
(for example the source disk
disconnected), you end up with **two verified copies** — never zero — and
Overlook shows both locations and offers **Finish cleanup** to complete the
removal safely. It never guesses which copy to delete.

Moves on the same volume use an instant rename with the same journal-backed
guarantees. Moving the **open** library is supported: Overlook finishes its
writes, closes the library completely, moves it, and reopens it from the new
location (the window reloads). Moving several libraries runs them one at a
time, each with its own progress and result — a failure in one never affects
another.

A current cloud backup is nice extra safety but is **never required** to
move: the move itself always holds at least one verified copy.

## External disks

- A library on an unplugged disk shows as **Missing** in the switcher, with a
  hint to reconnect the volume. Nothing else happens: Overlook never creates
  an empty library at the missing path and never starts a cloud restore just
  because a disk is disconnected. Plug the disk back in and the library is
  simply there again.
- Ejecting is safe whenever the library is closed: a clean close checkpoints
  the database so the folder is a complete, self-contained unit.
- Network drives are discouraged (database safety cannot be guaranteed and
  cross-machine locks cannot be verified); Overlook warns rather than blocks.

## Recovery after a crash

Every move writes a journal in the profile before it does anything. On
launch, Overlook settles these journals first:

- A move interrupted **before** the commit: marker-bound staging stays inert
  and the original stays active. The recovery banner shows both paths and
  offers **Discard staged copy** by default or **Resume**. Resume re-checks each
  existing file by relative path, size, and SHA-256, then copies only missing
  or incomplete files. Overlook never deletes a folder it cannot prove is its
  own staging.
- A crash caught **at** the commit boundary: the journal and registry agree
  on what happened and the move is completed or rolled back accordingly.
- A committed move whose cleanup did not finish: a banner offers **Finish
  cleanup**, showing both locations.
- A damaged journal is reported and left alone — nothing is guessed.

## Manually moved libraries (Finder repair)

If you move a library folder in Finder instead of using **Move library…**,
the registry still points at the old path and the library shows as Missing.
Use **Add existing…** and choose the folder at its new location: Overlook
reads the folder's own `library-id` and, because the ID matches, offers to
re-point the existing entry — identity, backups, and settings all stay. A
folder with the _wrong_ ID is rejected rather than adopted.

Never hand-edit `libraries.json`; if it is ever corrupted, Overlook refuses
to overwrite it and tells you at startup rather than silently forgetting your
libraries.
