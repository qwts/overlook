import { dialog } from 'electron';

export async function pickRecoveryKeyPath(fixture?: string): Promise<string | null> {
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Overlook recovery key', extensions: ['key'] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Save destination for an exported keyring entry (#517). */
export async function pickKeyFileDestination(fixture: string | undefined, suggestedName: string): Promise<string | null> {
  if (fixture !== undefined && fixture !== '') return fixture;
  const result = await dialog.showSaveDialog({ defaultPath: suggestedName, filters: [{ name: 'Overlook key', extensions: ['key'] }] });
  return result.canceled ? null : (result.filePath ?? null);
}
