import type { StageResult } from './types.js';

export type PipelineEvent =
  | { type: 'stage:start'; id: string; at: number }
  | { type: 'stage:log'; id: string; line: string }
  | { type: 'stage:finish'; id: string; result: StageResult }
  | { type: 'group:start'; id: string }
  | { type: 'group:finish'; id: string; status: StageResult['status']; durationMs: number }
  | { type: 'pipeline:finish'; results: Record<string, StageResult>; passed: boolean; durationMs: number };

export type EventSink = (event: PipelineEvent) => void;
