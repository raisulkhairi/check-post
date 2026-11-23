export interface AdapterRunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /** JSON Schema untuk jawaban terstruktur. */
  schema: object;
  model?: string;
  /** Glob path yang tidak boleh dibaca AI. */
  denyPaths: string[];
  maxBudgetUsd?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Aktivitas singkat untuk ditampilkan di log (mis. "Read src/app.ts"). */
  onActivity?: (line: string) => void;
}

export interface AdapterRunResult {
  /** Objek JSON hasil structured output, atau null bila AI tidak mengembalikannya. */
  output: unknown;
  rawText: string;
  costUsd?: number;
  /** Tool call yang ditolak karena aturan deny. */
  deniedReads: string[];
}

export interface Adapter {
  id: string;
  label: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  run(options: AdapterRunOptions): Promise<AdapterRunResult>;
}
