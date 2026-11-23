import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Buat project sementara dengan file-file di dalam checkpost/. */
export function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aip-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, 'checkpost', rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export const cmd = (run: string, extra = '') => `---\nrun: ${run}\n${extra}---\n`;
export const ai = (body: string, extra = '') => `---\n${extra}---\n${body}\n`;
