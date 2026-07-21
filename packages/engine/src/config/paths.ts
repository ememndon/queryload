import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_DATA_DIRNAME, APP_DATA_DIRS, APP_DATA_FILES } from '@queryload/shared';

/**
 * Resolves the on-disk app-data layout: `%APPDATA%/QueryLoad/...`.
 *
 * The engine never scatters state: everything it owns lives under one root
 * (data-locality rule D34/D35). The root is overridable via the constructor
 * so tests and the `--data-dir` flag can point elsewhere without touching the
 * environment.
 */
export class AppPaths {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? AppPaths.defaultRoot();
  }

  static defaultRoot(): string {
    // On Windows this is %APPDATA% (Roaming). Fall back sensibly elsewhere so
    // the engine can at least boot for development on non-Windows hosts.
    const base =
      process.env.APPDATA ??
      (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), '.config'));
    return join(base, APP_DATA_DIRNAME);
  }

  get indexDir(): string {
    return join(this.root, APP_DATA_DIRS.index);
  }
  get logsDir(): string {
    return join(this.root, APP_DATA_DIRS.logs);
  }
  get quarantineDir(): string {
    return join(this.root, APP_DATA_DIRS.quarantine);
  }
  get certsDir(): string {
    return join(this.root, APP_DATA_DIRS.certs);
  }
  get modelsDir(): string {
    return join(this.root, APP_DATA_DIRS.models);
  }
  get configFile(): string {
    return join(this.root, APP_DATA_FILES.config);
  }
  get metadataDbFile(): string {
    return join(this.root, APP_DATA_FILES.metadataDb);
  }
  get runtimeFile(): string {
    return join(this.root, APP_DATA_FILES.runtime);
  }

  /** Directories that must exist before the engine can operate. */
  get requiredDirs(): readonly string[] {
    return [
      this.root,
      this.indexDir,
      this.logsDir,
      this.quarantineDir,
      this.certsDir,
      this.modelsDir,
    ];
  }
}
