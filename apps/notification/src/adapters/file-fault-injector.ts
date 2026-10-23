import { existsSync, readFileSync } from 'node:fs';
import type { FaultInjector } from '../application/ports';

/** Reads company ids (one per line) from a file on every check. Wired only outside production. */
export class FileFaultInjector implements FaultInjector {
  constructor(private readonly path: string) {}

  shouldFail(companyId: string): boolean {
    if (!existsSync(this.path)) return false;
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .includes(companyId);
  }
}
