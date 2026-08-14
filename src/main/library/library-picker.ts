import { dialog } from 'electron';

import { ensureLibraryDocumentPath } from '../../shared/library/library-document.js';

/** Native directory picker for the library flows (#386): create-location and
 * add-existing. The harness fixture bypasses the native dialog — '' means the
 * user cancelled, anything else is the chosen directory. */
export async function pickLibraryDirectory(fixture?: string): Promise<string | null> {
  if (fixture !== undefined) return fixture === '' ? null : fixture;
  const result = await dialog.showOpenDialog({
    title: 'Choose library folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Save-style picker for a newly created Finder package. Existing-library
 * registration deliberately keeps the directory picker above so arbitrary
 * legacy library directories remain supported without migration. */
export async function pickLibraryCreateLocation(fixture?: string): Promise<string | null> {
  if (fixture !== undefined) return fixture === '' ? null : ensureLibraryDocumentPath(fixture);
  const result = await dialog.showSaveDialog({
    title: 'Create Overlook library',
    nameFieldLabel: 'Library name',
    filters: [{ name: 'Overlook Library', extensions: ['overlooklibrary'] }],
  });
  return result.canceled || result.filePath === '' ? null : ensureLibraryDocumentPath(result.filePath);
}
