import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const RELOCATION_DESTINATION_IDLE_MS = 15 * 60_000;

export class RelocationDestinationGrantError extends Error {
  constructor(message = 'Relocation destination authorization was denied') {
    super(message);
    this.name = 'RelocationDestinationGrantError';
  }
}

interface DestinationGrant {
  readonly senderId: number;
  readonly root: string;
  expiresAt: number;
  activeUses: number;
}

export interface RelocationDestinationLease {
  readonly destination: string;
  release(): void;
}

interface RelocationDestinationAuthorityOptions {
  readonly now?: () => number;
  readonly createToken?: () => string;
  readonly canonicalizeExisting?: (value: string) => Promise<string>;
  readonly idleMs?: number;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

async function canonicalizeDestination(value: string, canonicalizeExisting: (value: string) => Promise<string>): Promise<string> {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await canonicalizeExisting(existing);
      return path.resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isContained(root: string, destination: string): boolean {
  const relative = path.relative(root, destination);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Main-owned, sender-bound native-picker grants for relocation (#991). */
export class RelocationDestinationAuthority {
  readonly #grants = new Map<string, DestinationGrant>();
  readonly #now: () => number;
  readonly #createToken: () => string;
  readonly #canonicalizeExisting: (value: string) => Promise<string>;
  readonly #idleMs: number;

  constructor(options: RelocationDestinationAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createToken = options.createToken ?? randomUUID;
    this.#canonicalizeExisting = options.canonicalizeExisting ?? realpath;
    this.#idleMs = options.idleMs ?? RELOCATION_DESTINATION_IDLE_MS;
  }

  async issue(senderId: number, selectedRoot: string): Promise<{ authorization: string; root: string }> {
    const root = await this.#canonicalizeExisting(path.resolve(selectedRoot));
    this.revokeSender(senderId);
    const authorization = this.#createToken();
    this.#grants.set(authorization, {
      senderId,
      root,
      expiresAt: this.#now() + this.#idleMs,
      activeUses: 0,
    });
    return { authorization, root };
  }

  async acquire(senderId: number, authorization: string, requestedDestination: string): Promise<RelocationDestinationLease> {
    const grant = this.#requireGrant(senderId, authorization);
    const destination = await canonicalizeDestination(requestedDestination, this.#canonicalizeExisting);
    const current = this.#requireGrant(senderId, authorization);
    if (current !== grant || !isContained(grant.root, destination)) throw new RelocationDestinationGrantError();
    grant.activeUses += 1;

    let released = false;
    return {
      destination,
      release: () => {
        if (released) return;
        released = true;
        if (this.#grants.get(authorization) !== grant) return;
        grant.activeUses = Math.max(0, grant.activeUses - 1);
        grant.expiresAt = this.#now() + this.#idleMs;
      },
    };
  }

  revoke(senderId: number, authorization: string): boolean {
    const grant = this.#grants.get(authorization);
    if (grant === undefined || grant.senderId !== senderId) return false;
    return this.#grants.delete(authorization);
  }

  revokeSender(senderId: number): void {
    for (const [authorization, grant] of this.#grants) {
      if (grant.senderId === senderId) this.#grants.delete(authorization);
    }
  }

  #requireGrant(senderId: number, authorization: string): DestinationGrant {
    const grant = this.#grants.get(authorization);
    if (grant === undefined || grant.senderId !== senderId) throw new RelocationDestinationGrantError();
    if (grant.activeUses === 0 && this.#now() >= grant.expiresAt) {
      this.#grants.delete(authorization);
      throw new RelocationDestinationGrantError('Relocation destination authorization expired');
    }
    return grant;
  }
}
