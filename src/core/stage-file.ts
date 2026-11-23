import matter from 'gray-matter';
import type { z } from 'zod';
import type { StageType } from './types.js';

export class DefinitionError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'DefinitionError';
  }
}

export interface ParsedMarkdown<T> {
  data: T;
  body: string;
}

/** Parse frontmatter YAML + body Markdown, lalu validasi frontmatter dengan schema. */
export function parseMarkdown<S extends z.ZodTypeAny>(
  source: string,
  schema: S,
  fileLabel: string,
): ParsedMarkdown<z.infer<S>> {
  let parsed: matter.GrayMatterFile<string>;
  try {
    // Tanpa cache: gray-matter meng-cache berdasarkan isi string, yang mengacaukan test.
    parsed = matter(source, {});
  } catch (err) {
    throw new DefinitionError([`${fileLabel}: frontmatter YAML tidak valid (${(err as Error).message})`]);
  }
  const result = schema.safeParse(parsed.data ?? {});
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(frontmatter)';
      return `${fileLabel}: ${key}: ${issue.message}`;
    });
    throw new DefinitionError(problems);
  }
  return { data: result.data, body: parsed.content.trim() };
}

export function stageTypeOf(run: string | undefined, body: string): StageType | null {
  const hasRun = Boolean(run && run.trim());
  const hasBody = body.trim().length > 0;
  if (hasRun && hasBody) return 'command+ai';
  if (hasRun) return 'command';
  if (hasBody) return 'ai';
  return null;
}

/** Ubah `30s`, `5m`, `1h`, `500ms`, atau angka (detik) menjadi milidetik. */
export function parseDuration(value: string | number | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs;
  if (typeof value === 'number') return value * 1000;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2] ?? 's') {
    case 'ms':
      return n;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      return n * 1000;
  }
}
