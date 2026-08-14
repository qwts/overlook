import { randomUUID } from 'node:crypto';

const AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;

interface Grant {
  readonly destination: string;
  readonly photoIds: readonly string[];
  readonly senderId: number;
  readonly expiresAt: number;
}

/** One-use proof that main's native folder picker authorized an export. */
export class ExportAuthorizationStore {
  readonly #grants = new Map<string, Grant>();

  issue(senderId: number, photoIds: readonly string[], destination: string, now = Date.now()): string {
    const authorization = randomUUID();
    this.#grants.set(authorization, { destination, photoIds: [...photoIds], senderId, expiresAt: now + AUTHORIZATION_LIFETIME_MS });
    return authorization;
  }

  consume(senderId: number, photoIds: readonly string[], authorization: string, now = Date.now()): string {
    const grant = this.#grants.get(authorization);
    this.#grants.delete(authorization);
    if (
      grant === undefined ||
      grant.senderId !== senderId ||
      grant.expiresAt < now ||
      grant.photoIds.length !== photoIds.length ||
      grant.photoIds.some((id, index) => id !== photoIds[index])
    ) {
      throw new Error('export authorization is invalid or expired');
    }
    return grant.destination;
  }
}
