export interface AdapterRunOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /** JSON Schema for the structured answer. */
  schema: object;
  model?: string;
  /** Path globs the AI must not read. */
  denyPaths: string[];
  maxBudgetUsd?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Short activity lines for the log (e.g. "Read src/app.ts"). */
  onActivity?: (line: string) => void;
}

export interface AdapterRunResult {
  /** Structured output JSON object, or null if the AI did not return one. */
  output: unknown;
  rawText: string;
  costUsd?: number;
  /** Tool calls rejected by deny rules. */
  deniedReads: string[];
}

export interface Adapter {
  id: string;
  label: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  run(options: AdapterRunOptions): Promise<AdapterRunResult>;
}

/** An agent run that failed; carries what it cost so far so the run total stays accurate. */
export class AgentError extends Error {
  constructor(message: string, readonly costUsd?: number) {
    super(message);
    this.name = 'AgentError';
  }
}
