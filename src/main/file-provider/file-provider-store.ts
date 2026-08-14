import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { disabledFileProviderConfig, fileProviderConfigSchema, type FileProviderConfig } from '../../shared/file-provider/contract.js';

export class FileProviderStore {
  constructor(private readonly filePath: string) {}

  load(): FileProviderConfig {
    try {
      return fileProviderConfigSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return disabledFileProviderConfig;
    }
  }

  save(config: FileProviderConfig): void {
    const value = fileProviderConfigSchema.parse(config);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const staging = `${this.filePath}.tmp`;
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(staging, this.filePath);
  }
}
