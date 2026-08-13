const RECEIPT_TTL_MS = 10 * 60 * 1000;

/** Process-local proof that this library completed a recovery-key export in
 * the current settings session. It deliberately cannot survive a restart. */
export class RecoveryExportReceipt {
  private receipt: { readonly libraryId: string; readonly expiresAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  mark(libraryId: string): void {
    this.receipt = { libraryId, expiresAt: this.now() + RECEIPT_TTL_MS };
  }

  consume(libraryId: string): boolean {
    const receipt = this.receipt;
    this.receipt = null;
    return receipt !== null && receipt.libraryId === libraryId && receipt.expiresAt >= this.now();
  }
}
