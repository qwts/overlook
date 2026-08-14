import { randomUUID } from 'node:crypto';

interface Authorization {
  readonly destination: string;
  readonly token: string;
}

export class ExportDestinationAuthorization {
  private readonly bySender = new Map<number, Authorization>();

  authorize(senderId: number, destination: string): string {
    const token = randomUUID();
    this.bySender.set(senderId, { destination, token });
    return token;
  }

  clear(senderId: number): void {
    this.bySender.delete(senderId);
  }

  consume(senderId: number, token: string): string {
    const authorization = this.bySender.get(senderId);
    if (authorization?.token !== token) {
      throw new Error('export destination is not authorized');
    }
    this.bySender.delete(senderId);
    return authorization.destination;
  }
}
