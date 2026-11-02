import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface DiagnosticEvent {
  event: string;
  connectionId?: string;
  operationId?: string;
  sessionId?: string;
  last?: boolean;
  code?: number;
  reason?: string;
  bytes?: number;
  text?: string;
}
export type DiagnosticSink = (event: DiagnosticEvent) => void;
const LIMIT = 1024 * 1024;
const TEXT_LIMIT = 8192;
function bounded(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  return Buffer.from(value).subarray(0, bytes).toString('utf8').replace(/\ufffd+$/, '');
}

/** Debug-only, bounded synchronous JSONL. Never serializes caller objects or errors.
 * Linux directory descriptors anchor every traversal to defeat parent symlink swaps.
 * Other platforms fail closed rather than silently weaken filesystem protection.
 */
export class Diagnostics {
  private directoryFd: number | undefined;
  private error: string | undefined;
  private sequence = 0;
  private closed = false;
  private readonly path: string;
  private readonly enabled: boolean;
  private readonly captureText: boolean;
  private readonly secrets: string[];
  constructor(directory: string, options: { enabled: boolean; captureText?: boolean }, secrets: string[] = []) {
    this.enabled = options.enabled === true;
    this.captureText = options.captureText === true;
    this.path = resolve(directory, 'diagnostics.jsonl');
    this.secrets = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length > 0))]
      .sort((a, b) => b.length - a.length);
    if (!this.enabled) return;
    try {
      if (process.platform !== 'linux') throw new Error();
      let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const parts = resolve(directory).split(sep).filter(Boolean);
        if (!parts.length) throw new Error();
        for (let i = 0; i < parts.length; i++) {
          const child = `/proc/self/fd/${fd}/${parts[i]}`;
          try { mkdirSync(child, { mode: 0o700 }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error();
          }
          const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          closeSync(fd); fd = next;
          const stat = fstatSync(fd);
          // Sticky shared ancestors (e.g. /tmp) are safe to traverse with anchored descriptors.
          if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new Error();
          if (i === parts.length - 1) {
            if (stat.uid !== process.getuid!()) throw new Error();
            fchmodSync(fd, 0o700);
          }
        }
        this.directoryFd = fd;
      } catch { closeSync(fd); throw new Error(); }
      const file = this.openFile(); closeSync(file);
      this.checkFile(this.filePath(true));
      // Existing rotated logs must be protected too, without ever following links.
      let previous: number | undefined;
      try {
        previous = openSync(this.filePath(true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(previous);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error();
        fchmodSync(previous, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error();
      } finally { if (previous !== undefined) closeSync(previous); }
    } catch { this.fail(); }
  }
  private filePath(previous = false): string {
    return `/proc/self/fd/${this.directoryFd}/diagnostics.jsonl${previous ? '.1' : ''}`;
  }
  private checkFile(path: string): void {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error();
    }
  }
  private openFile(): number {
    this.checkFile(this.filePath());
    const fd = openSync(this.filePath(), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error();
      fchmodSync(fd, 0o600);
      return fd;
    } catch { closeSync(fd); throw new Error(); }
  }
  private fail(): void {
    this.error = 'Diagnostic logging unavailable';
    this.close();
  }
  private redact(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  write: DiagnosticSink = event => {
    if (!this.enabled || this.closed || this.directoryFd === undefined) return;
    let fd: number | undefined;
    try {
      const record: Record<string, string | number | boolean> = {
        timestamp: new Date().toISOString(), seq: ++this.sequence,
      };
      for (const key of ['event', 'connectionId', 'operationId', 'sessionId', 'reason'] as const) {
        if (typeof event[key] === 'string') record[key] = bounded(this.redact(event[key]), 1024);
      }
      for (const key of ['code', 'bytes'] as const) {
        if (typeof event[key] === 'number' && Number.isSafeInteger(event[key]) && event[key] >= 0) record[key] = event[key];
      }
      if (typeof event.last === 'boolean') record.last = event.last;
      if (this.captureText && typeof event.text === 'string') {
        const text = this.redact(event.text);
        record.text = bounded(text, TEXT_LIMIT);
        if (Buffer.byteLength(text) > TEXT_LIMIT) {
          record.textTruncated = true;
          record.textBytes = Buffer.byteLength(text);
        }
      }
      const line = Buffer.from(JSON.stringify(record) + '\n');
      fd = this.openFile();
      if (fstatSync(fd).size + line.length > LIMIT) {
        closeSync(fd); fd = undefined;
        this.checkFile(this.filePath(true));
        try { unlinkSync(this.filePath(true)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error();
        }
        renameSync(this.filePath(), this.filePath(true));
        fd = this.openFile();
      }
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (!written) throw new Error();
        offset += written;
      }
    } catch { this.fail(); }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { this.fail(); } } }
  };
  status(): { enabled: boolean; captureText: boolean; path?: string; error?: string } {
    return { enabled: this.enabled, captureText: this.captureText,
      ...(this.enabled ? { path: this.redact(this.path) } : {}), ...(this.error ? { error: this.error } : {}) };
  }
  close(): void {
    this.closed = true;
    if (this.directoryFd !== undefined) {
      try { closeSync(this.directoryFd); } catch { /* Diagnostics must never interrupt the relay. */ }
      this.directoryFd = undefined;
    }
  }
}
