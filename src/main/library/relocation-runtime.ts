import path from 'node:path';

import {
  assertNoPendingRelocation,
  discardRelocation,
  RelocationError,
  finishRelocationCleanup,
  isRelocationResumable,
  probeRelocation,
  relocateLibrary,
  resumeRelocation,
  type RelocationDeps,
  type RelocationProbe,
} from './relocation-engine.js';
import { describeFolderNameObjection, objectToFolderName } from '../../shared/library/folder-name.js';
import type { RelocationOutcome, RelocationMode, RelocationProgress, RelocationState } from '../../shared/library/relocation.js';
import { hasAppLockCustody } from './relocation-verify.js';

// Relocation runtime (#483, ADR-0022 §4): the IPC-facing wrapper around the
// engine. Inactive libraries relocate directly unless app-lock custody requires
// an authenticated open; the ACTIVE library runs the switch-shaped sequence
// (guards → teardown → relocate → reactivate), and
// reactivation happens whatever the move's outcome — on success the registry
// points at the destination, on any refusal/failure it still points at the
// source, so the same reopen lands on the right directory both ways.
// Designed refusals are RETURNED, not thrown (#386 convention): IPC strips
// thrown errors to bare codes, and the wizard needs reason + detail.

export type RelocationMoveOutcome =
  | {
      readonly ok: true;
      readonly outcome: RelocationOutcome;
      readonly mode: RelocationMode;
      readonly items: number;
      readonly bytes: number;
      readonly sourcePath: string;
      readonly destPath: string;
    }
  | { readonly ok: false; readonly reason: RelocationError['reason']; readonly detail: string };

export interface RelocationPendingEntry {
  readonly libraryId: string;
  readonly state: RelocationState | null;
  readonly sourcePath: string | null;
  readonly destPath: string | null;
  readonly corrupt: boolean;
  readonly resumable: boolean;
}

export interface RelocationRuntimeOptions {
  readonly engineDeps: RelocationDeps;
  readonly active: {
    readonly openLibraryId: () => string | null;
    /** App-lock state, undefined before the controller exists. */
    readonly lockState: () => string | undefined;
    /** True while backup/restore provider work is in flight (ADR-0011 parity). */
    readonly providerBusy: () => boolean;
    /** Full ADR-0017 §4 teardown — same contract as the switch. */
    readonly closeLibrary: () => Promise<void>;
    /** Re-point + rebind + app-lock swap + renderer reload for wherever the
     * registry points now (destination after a commit, source otherwise). */
    readonly reactivate: (id: string) => Promise<void>;
  };
  readonly emitProgress: (payload: RelocationProgress & { libraryId: string }) => void;
  /** Test seams; default to the real engine. */
  readonly relocate?: typeof relocateLibrary;
  readonly resume?: typeof resumeRelocation;
  readonly discard?: typeof discardRelocation;
  readonly finishCleanup?: typeof finishRelocationCleanup;
}

export class RelocationRuntime {
  private running: { readonly id: string; readonly controller: AbortController } | null = null;

  constructor(private readonly options: RelocationRuntimeOptions) {}

  /** One move at a time, app-wide: multi-select is N sequential singles
   * driven by the wizard, each with independent progress and results. */
  async move(id: string, destPath: string): Promise<RelocationMoveOutcome> {
    if (this.running !== null) {
      return { ok: false, reason: 'move-in-progress', detail: `a move is already running for library ${this.running.id}` };
    }
    const entry = this.options.engineDeps.registry.get(id);
    if (entry === undefined) {
      return { ok: false, reason: 'io-error', detail: `library ${id} is not registered` };
    }
    try {
      assertNoPendingRelocation(this.options.engineDeps, id);
    } catch (error) {
      if (error instanceof RelocationError) return { ok: false, reason: error.reason, detail: error.message };
      throw error;
    }
    const sourcePath = entry.path;
    const isActive = this.options.active.openLibraryId() === id;
    // Inactive OVLK custody has no authenticated password authority in this
    // process. Require the user to open and unlock it before allowing renderer-
    // initiated relocation to move its custody or delete its source. An
    // unreadable probe maps to the stable source-unreadable refusal, never an
    // opaque IPC failure (ADR-0022 amendment, PR #853 review).
    const custody = this.probeAppLockCustody(sourcePath);
    if (!isActive && custody !== 'none') {
      return custody === 'app-locked'
        ? { ok: false, reason: 'app-locked', detail: 'open and unlock the library before moving it' }
        : { ok: false, reason: 'source-unreadable', detail: `cannot read the library's custody files at ${sourcePath}` };
    }
    if (isActive) {
      const lockState = this.options.active.lockState();
      if (lockState !== undefined && lockState !== 'unconfigured-unlocked' && lockState !== 'unlocked') {
        return { ok: false, reason: 'app-locked', detail: 'unlock the library before moving it' };
      }
      if (this.options.active.providerBusy()) {
        return { ok: false, reason: 'provider-busy', detail: 'backup or restore work is in flight' };
      }
      // Preflight BEFORE teardown (PR #557 review): an active-library refusal
      // (occupied destination, space, filesystem) must return to the caller —
      // the wizard's collision-suffix retry — not tear down and reload the
      // window. The real move re-runs preflight after quiesce regardless.
      const pre = await probeRelocation(this.options.engineDeps, { libraryId: id, destDir: destPath });
      if (!pre.ok) {
        return { ok: false, reason: pre.reason, detail: pre.detail };
      }
    }

    const controller = new AbortController();
    this.running = { id, controller };
    try {
      // Quiesce the active library first (ADR-0017 §4 teardown: fence →
      // cancel/drain → checkpoint → close → zero keys → release lock); the
      // engine then takes the freed advisory lock like any inactive move.
      if (isActive) await this.options.active.closeLibrary();
      try {
        const result = await (this.options.relocate ?? relocateLibrary)(this.options.engineDeps, {
          libraryId: id,
          destDir: destPath,
          signal: controller.signal,
          onProgress: (progress) => this.options.emitProgress({ ...progress, libraryId: id }),
        });
        return {
          ok: true,
          outcome: result.outcome,
          mode: result.mode,
          items: result.items,
          bytes: result.bytes,
          sourcePath,
          destPath: this.options.engineDeps.registry.get(id)?.path ?? destPath,
        };
      } catch (error) {
        if (error instanceof RelocationError) {
          return { ok: false, reason: error.reason, detail: error.message };
        }
        throw error;
      } finally {
        if (isActive) await this.options.active.reactivate(id);
      }
    } finally {
      this.running = null;
    }
  }

  /** Rename the library's folder in place (#686): parent fixed, new final
   * path component. Validation is conservative and cross-platform (the disk
   * roams); everything else — quiesce/reactivate for the active library,
   * journaling, refusal vocabulary — is the move path with a sibling
   * destination. Case-only renames are legal; a same-name rename refuses. */
  async rename(id: string, newName: string): Promise<RelocationMoveOutcome> {
    const objection = objectToFolderName(newName);
    if (objection !== null) {
      return { ok: false, reason: 'invalid-destination', detail: describeFolderNameObjection(objection) };
    }
    const entry = this.options.engineDeps.registry.get(id);
    if (entry === undefined) {
      return { ok: false, reason: 'io-error', detail: `library ${id} is not registered` };
    }
    const source = path.resolve(entry.path);
    if (newName === path.basename(source)) {
      return { ok: false, reason: 'invalid-destination', detail: 'the folder already has this name' };
    }
    return this.move(id, path.join(path.dirname(source), newName));
  }

  /** hasAppLockCustody reads master.key; ACLs or a flaky network volume can
   * make that read throw — a designed refusal, not an opaque handler error. */
  private probeAppLockCustody(dir: string): 'app-locked' | 'unreadable' | 'none' {
    try {
      return hasAppLockCustody(dir) ? 'app-locked' : 'none';
    } catch {
      return 'unreadable';
    }
  }

  /** Cancellation is honored at file boundaries and only ever before the
   * registry commit (ADR-0022 §4) — after it, the engine no longer checks. */
  cancel(id: string): boolean {
    if (this.running?.id !== id) return false;
    this.running.controller.abort();
    return true;
  }

  async resume(id: string): Promise<RelocationMoveOutcome> {
    if (this.running !== null) {
      return { ok: false, reason: 'move-in-progress', detail: `a move is already running for library ${this.running.id}` };
    }
    const entry = this.options.engineDeps.registry.get(id);
    const journal = this.options.engineDeps.journals.load(id);
    if (entry === undefined || journal === null) return { ok: false, reason: 'io-error', detail: `library ${id} has no resumable move` };
    const isActive = this.options.active.openLibraryId() === id;
    if (!isActive) {
      const custody = this.probeAppLockCustody(entry.path);
      if (custody === 'app-locked') {
        return { ok: false, reason: 'app-locked', detail: 'open and unlock the library before resuming its move' };
      }
      if (custody === 'unreadable') {
        return { ok: false, reason: 'source-unreadable', detail: `cannot read the library's custody files at ${entry.path}` };
      }
    }
    if (isActive) {
      const lockState = this.options.active.lockState();
      if (lockState !== undefined && lockState !== 'unconfigured-unlocked' && lockState !== 'unlocked') {
        return { ok: false, reason: 'app-locked', detail: 'unlock the library before resuming its move' };
      }
      if (this.options.active.providerBusy()) {
        return { ok: false, reason: 'provider-busy', detail: 'backup or restore work is in flight' };
      }
    }

    const controller = new AbortController();
    this.running = { id, controller };
    try {
      if (isActive) await this.options.active.closeLibrary();
      try {
        const result = await (this.options.resume ?? resumeRelocation)(this.options.engineDeps, {
          libraryId: id,
          signal: controller.signal,
          onProgress: (progress) => this.options.emitProgress({ ...progress, libraryId: id }),
        });
        return { ok: true, ...result, sourcePath: journal.sourcePath, destPath: journal.destPath };
      } catch (error) {
        if (error instanceof RelocationError) return { ok: false, reason: error.reason, detail: error.message };
        throw error;
      } finally {
        if (isActive) await this.options.active.reactivate(id);
      }
    } finally {
      this.running = null;
    }
  }

  async discard(id: string): Promise<'discarded' | 'nothing-pending'> {
    if (this.running?.id === id) return 'nothing-pending';
    return (this.options.discard ?? discardRelocation)(this.options.engineDeps, id);
  }

  async finishCleanup(id: string): Promise<'cleaned' | 'nothing-pending'> {
    return (this.options.finishCleanup ?? finishRelocationCleanup)(this.options.engineDeps, id);
  }

  /** Review-step dry run (#483): no lock, no journal, no bytes moved. */
  async probe(id: string, destPath: string): Promise<RelocationProbe> {
    return probeRelocation(this.options.engineDeps, { libraryId: id, destDir: destPath });
  }

  /** The resume banner's work list: journals on disk, corrupt ones surfaced
   * with null fields — never guessed at (ADR-0022 §2). */
  pending(): RelocationPendingEntry[] {
    return this.options.engineDeps.journals.list().map((item) => {
      if (item.journal instanceof Error) {
        return { libraryId: item.libraryId, state: null, sourcePath: null, destPath: null, corrupt: true, resumable: false };
      }
      return {
        libraryId: item.libraryId,
        state: item.journal.state,
        sourcePath: item.journal.sourcePath,
        destPath: item.journal.destPath,
        corrupt: false,
        resumable: isRelocationResumable(item.journal),
      };
    });
  }
}
