import { createClaudeCodeAdapter } from './claude-code.js';
import type { Adapter } from './types.js';

export type { Adapter } from './types.js';

export const AGENTS: Record<string, { label: string; available: boolean; create?: () => Adapter }> = {
  'claude-code': { label: 'Claude Code', available: true, create: () => createClaudeCodeAdapter() },
  gemini: { label: 'Gemini CLI', available: false },
  codex: { label: 'Codex CLI', available: false },
};

export function getAdapter(id: string): Adapter {
  const agent = AGENTS[id];
  if (!agent) throw new Error(`Unknown agent "${id}". Options: ${Object.keys(AGENTS).join(', ')}`);
  if (!agent.create) throw new Error(`Agent "${agent.label}" is not supported yet. Use claude-code for now.`);
  return agent.create();
}
