import type { Finding, PipelineNode, StageStatus } from '../core/types.js';

export const STATUS_ICON: Record<StageStatus, string> = {
  pending: '○',
  running: '●',
  passed: '✔',
  failed: '✖',
  error: '✖',
  skipped: '–',
};

export const STATUS_COLOR: Record<StageStatus, string> = {
  pending: 'gray',
  running: 'yellow',
  passed: 'green',
  failed: 'red',
  error: 'red',
  skipped: 'gray',
};

export const SEVERITY_COLOR: Record<Finding['severity'], string> = {
  critical: 'magenta',
  high: 'red',
  medium: 'yellow',
  low: 'cyan',
  info: 'gray',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function typeLabel(node: PipelineNode): string {
  if (node.kind === 'group') return node.config.parallel ? 'grup paralel' : 'grup';
  if (node.type === 'ai') return 'AI';
  if (node.type === 'command+ai') return 'cmd+AI';
  return 'command';
}

export function findingLocation(f: Finding): string {
  if (!f.file) return '';
  return f.line ? `${f.file}:${f.line}` : f.file;
}
