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
  if (!agent) throw new Error(`Agent "${id}" tidak dikenal. Pilihan: ${Object.keys(AGENTS).join(', ')}`);
  if (!agent.create) throw new Error(`Agent "${agent.label}" belum didukung. Gunakan claude-code untuk saat ini.`);
  return agent.create();
}
