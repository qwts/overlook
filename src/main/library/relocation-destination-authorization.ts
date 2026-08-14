import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class RelocationDestinationAuthorization {
  readonly #grants = new Map<string, { root: string; expiresAt: number }>();

  authorize(root: string): string {
    const token = randomUUID();
    this.#grants.clear();
    this.#grants.set(token, { root: path.resolve(root), expiresAt: Date.now() + 10 * 60_000 });
    return token;
  }

  permits(token: string, destination: string): boolean {
    const grant = this.#grants.get(token);
    if (grant === undefined || grant.expiresAt < Date.now()) {
      this.#grants.delete(token);
      return false;
    }
    const relative = path.relative(grant.root, path.resolve(destination));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }
}

export const relocationDestinationAuthorization = new RelocationDestinationAuthorization();
