/** Visible tile count. A settled failed page is the loaded length, so an
 * empty failure cannot reserve the one loading placeholder. */
export function gridTotal(input: {
  readonly filtersActive: boolean;
  readonly knownTotal: number | null;
  readonly loaded: number;
  readonly exhausted: boolean;
  readonly pageFailed: boolean;
}): number {
  if (input.pageFailed) return input.loaded;
  if (input.filtersActive || input.knownTotal === null) {
    return input.exhausted ? input.loaded : input.loaded + 1;
  }
  return input.knownTotal;
}
