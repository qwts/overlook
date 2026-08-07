import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  libraryRegistryFileSchema,
  libraryDisplayNameSchema,
  selectStartupLibrary,
  type LibraryEntry,
  type LibraryRegistryFile,
} from '../../shared/library/registry.js';

// Library registry persistence (ADR-0017 §1/§7, #384). Standalone
// userData/libraries.json, main-process writer only, atomic tmp+rename like
// the settings store — but the failure policy is the opposite: a corrupt
// registry throws instead of self-healing, because "recovered" defaults here
// would silently forget where libraries live. Callers surface the error into
// a recovery flow; they never overwrite a corrupt file with an empty one.

export class LibraryRegistryError extends Error {
  override readonly name = 'LibraryRegistryError';
}

export interface LibraryRegistryOptions {
  readonly filePath: string;
  /** Injected for tests; defaults to wall clock. */
  readonly now?: () => Date;
}

export class LibraryRegistry {
  private file: LibraryRegistryFile;

  constructor(private readonly options: LibraryRegistryOptions) {
    this.file = this.load();
  }

  list(): readonly LibraryEntry[] {
    return this.file.entries;
  }

  get(id: string): LibraryEntry | undefined {
    return this.file.entries.find((entry) => entry.id === id);
  }

  /** Startup selection per ADR-0017 §1. */
  startupEntry(): LibraryEntry | undefined {
    return selectStartupLibrary(this.file.entries);
  }

  register(entry: LibraryEntry): LibraryEntry {
    if (this.get(entry.id) !== undefined) {
      throw new LibraryRegistryError(`library ${entry.id} is already registered`);
    }
    const resolved = path.resolve(entry.path);
    const clash = this.file.entries.find((existing) => path.resolve(existing.path) === resolved);
    if (clash !== undefined) {
      throw new LibraryRegistryError(`path already registered to library ${clash.id} (${clash.name})`);
    }
    this.file = { ...this.file, entries: [...this.file.entries, entry] };
    this.persist();
    return entry;
  }

  /** Registry-entry removal only — never touches the directory, keys, or DB
   * (acceptance 4; destructive deletion is a separate, explicit action). */
  remove(id: string): boolean {
    const next = this.file.entries.filter((entry) => entry.id !== id);
    if (next.length === this.file.entries.length) return false;
    this.file = { ...this.file, entries: next };
    this.persist();
    return true;
  }

  /** ADR-0017 §2: the directory's library-id file is authoritative — when a
   * registered directory turns out to carry a different id, the registry's
   * cached id heals to match. */
  updateId(id: string, newId: string): LibraryEntry {
    const entry = this.get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    if (newId === id) return entry;
    if (this.get(newId) !== undefined) {
      throw new LibraryRegistryError(`library ${newId} is already registered`);
    }
    const updated = { ...entry, id: newId };
    this.file = { ...this.file, entries: this.file.entries.map((e) => (e.id === id ? updated : e)) };
    this.persist();
    return updated;
  }

  /** Atomic registry path rewrite — the relocation commit point (ADR-0022
   * §1/§4, #483). The entry stays authoritative at its old path until this
   * write lands; callers run it only after full verification. */
  updatePath(id: string, newPath: string): LibraryEntry {
    const entry = this.get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const resolved = path.resolve(newPath);
    const clash = this.file.entries.find((existing) => existing.id !== id && path.resolve(existing.path) === resolved);
    if (clash !== undefined) {
      throw new LibraryRegistryError(`path already registered to library ${clash.id} (${clash.name})`);
    }
    const updated = { ...entry, path: newPath };
    this.file = { ...this.file, entries: this.file.entries.map((e) => (e.id === id ? updated : e)) };
    this.persist();
    return updated;
  }

  rename(id: string, name: string): LibraryEntry {
    const entry = this.get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const parsed = libraryDisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      throw new LibraryRegistryError(parsed.error.issues[0]?.message ?? 'invalid library display name');
    }
    const renamed = { ...entry, name: parsed.data };
    this.file = { ...this.file, entries: this.file.entries.map((e) => (e.id === id ? renamed : e)) };
    this.persist();
    return renamed;
  }

  /** ADR-0028 §4's sealed-library preflight hint. Callers write a non-zero
   * hint before committing the first database binding; zero is recorded only
   * after a verified recount, so stale data can block but cannot undercount. */
  updateCustodyHints(id: string, custodyHints: NonNullable<LibraryEntry['custodyHints']>): LibraryEntry {
    const entry = this.get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const updated = { ...entry, custodyHints };
    this.file = { ...this.file, entries: this.file.entries.map((e) => (e.id === id ? updated : e)) };
    this.persist();
    return updated;
  }

  /** Stamped at successful open — not at close, so a crash never loses it
   * (ADR-0017 §1). */
  touchOpened(id: string): LibraryEntry {
    const entry = this.get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const touched = { ...entry, lastOpenedAt: (this.options.now?.() ?? new Date()).toISOString() };
    this.file = { ...this.file, entries: this.file.entries.map((e) => (e.id === id ? touched : e)) };
    this.persist();
    return touched;
  }

  private load(): LibraryRegistryFile {
    if (!existsSync(this.options.filePath)) {
      // Absent is a valid state (first run) — distinct from corrupt.
      return { version: 1, entries: [] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.filePath, 'utf8'));
    } catch (error) {
      throw new LibraryRegistryError(`libraries.json is unreadable or not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = libraryRegistryFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LibraryRegistryError(`libraries.json failed validation: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`);
    }
    return parsed.data;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const staging = `${this.options.filePath}.tmp`;
    writeFileSync(staging, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
    renameSync(staging, this.options.filePath);
  }
}

export interface EnsureDefaultEntryOptions {
  /** The legacy hardcoded library directory (userData/library). */
  readonly legacyDir: string;
  /** Reads or mints the directory's library-id file (eager per ADR-0017 §2). */
  readonly libraryId: () => string;
  readonly now?: () => Date;
}

/** ADR-0017 §7 migration: an empty registry registers the legacy directory in
 * place — for an existing install that directory holds the library; for a
 * fresh install it is where the default library will be created on first
 * open. No files move either way (acceptance 1). */
export function ensureDefaultEntry(registry: LibraryRegistry, options: EnsureDefaultEntryOptions): LibraryEntry {
  const existing = registry.startupEntry();
  if (existing !== undefined) return existing;
  const at = (options.now?.() ?? new Date()).toISOString();
  return registry.register({
    id: options.libraryId(),
    name: 'My Library',
    path: options.legacyDir,
    createdAt: at,
    lastOpenedAt: null,
  });
}
