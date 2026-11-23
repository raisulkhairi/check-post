import { z } from 'zod';
import { AgentError, type Adapter, type AdapterRunResult } from '../adapters/types.js';
import { AiVerdictParseSchema, AiVerdictSchema, SEVERITIES, severityRank, type AiVerdict, type Finding, type Severity, type StageNode } from '../types.js';

/**
 * JSON Schema sent to the AI; must stay in sync with AiVerdictSchema.
 * The `$schema` key is dropped because Claude Code rejects the draft 2020-12 reference.
 */
export const VERDICT_JSON_SCHEMA: object = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(AiVerdictSchema) as Record<string, unknown>;
  return schema;
})();

const MAX_COMMAND_OUTPUT_CHARS = 30_000;

export function buildSystemPrompt(sensitivePaths: string[], language = 'English'): string {
  return [
    'You are an automated stage in a local CI pipeline. You audit a software project and report findings.',
    'Rules:',
    '- You are strictly read-only. You can only use Read, Grep and Glob. Never suggest you changed anything.',
    `- Never try to read secret files. These paths are blocked and must be skipped: ${sensitivePaths.join(', ')}. ` +
      'For environment configuration you may reason about variable NAMES only, never values.',
    '- Be precise. Report only real, verifiable problems found in the code you actually read. No speculative or generic advice.',
    '- Each finding must point to a file path relative to the project root and a 1-based line number when possible.',
    '- Severity scale: critical (exploitable now / leaked secret), high (likely exploitable or serious bug), ' +
      'medium (should be fixed soon), low (minor / hardening), info (observation, not a problem).',
    '- If nothing is wrong, return an empty findings array.',
    '- Cover the whole scope the stage asks for; do not stop after the first findings. Set "complete" to true only ' +
      'if you did. If you skipped anything (too many matches, files you could not read, a check you could not do ' +
      'with read-only tools), set "complete" to false and list each skipped part in "not_checked". ' +
      'If your summary says you did not read, check, or follow up something, "complete" must be false. ' +
      'An honest incomplete answer is better than a partial audit reported as clean.',
    `- Write summary, message and suggestion in ${language}, regardless of the language of the code or instructions.`,
    '- Your final answer MUST be the structured output object: { summary, findings[], complete, not_checked[] }.',
  ].join('\n');
}

export function buildStagePrompt(stage: StageNode, command?: { run: string; exitCode: number | null; output: string }): string {
  const parts: string[] = [];
  if (stage.context.length) {
    parts.push('## Project context', ...stage.context);
  }
  if (stage.config.paths?.length) {
    parts.push('## Scope', `Only inspect files matching: ${stage.config.paths.join(', ')}`);
  }
  if (command) {
    const out = command.output.length > MAX_COMMAND_OUTPUT_CHARS
      ? '[... earlier output truncated ...]\n' + command.output.slice(-MAX_COMMAND_OUTPUT_CHARS)
      : command.output;
    parts.push(
      '## Command result',
      `Command: \`${command.run}\``,
      `Exit code: ${command.exitCode ?? 'unknown'}`,
      'Output:',
      '```',
      out.trimEnd(),
      '```',
      'Review this command result according to the stage instructions below. If the command failed because of a real problem, report it as a finding.',
    );
  }
  parts.push(`## Stage: ${stage.name}`, stage.body);
  return parts.join('\n\n');
}

export function isBlocking(finding: Finding, failOn: Severity): boolean {
  return severityRank(finding.severity) <= severityRank(failOn);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export interface AiStageOutcome {
  verdict: AiVerdict;
  costUsd: number;
  deniedReads: string[];
}

/** Run an AI stage; ask again once if the answer does not match the schema. */
export async function runAiStage(
  adapter: Adapter,
  stage: StageNode,
  opts: {
    cwd: string;
    model: string;
    language?: string;
    sensitivePaths: string[];
    maxBudgetUsd: number;
    timeoutMs: number;
    signal?: AbortSignal;
    onLog: (line: string) => void;
    command?: { run: string; exitCode: number | null; output: string };
  },
): Promise<AiStageOutcome> {
  const systemPrompt = buildSystemPrompt(opts.sensitivePaths, opts.language);
  let prompt = buildStagePrompt(stage, opts.command);
  let cost = 0;
  const denied: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: AdapterRunResult;
    try {
      res = await adapter.run({
        cwd: opts.cwd,
        systemPrompt,
        prompt,
        schema: VERDICT_JSON_SCHEMA,
        model: stage.config.model ?? opts.model,
        denyPaths: opts.sensitivePaths,
        maxBudgetUsd: stage.config.max_budget_usd ?? opts.maxBudgetUsd,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onActivity: (line) => opts.onLog(`[AI] ${line}`),
      });
    } catch (err) {
      // Keep the cost of earlier attempts and of the failed one in the stage result.
      const failedCost = err instanceof AgentError ? (err.costUsd ?? 0) : 0;
      throw new AgentError((err as Error).message, cost + failedCost || undefined);
    }
    cost += res.costUsd ?? 0;
    denied.push(...res.deniedReads);

    let candidate = res.output;
    if (candidate == null) {
      try {
        candidate = JSON.parse(res.rawText);
      } catch {
        candidate = null;
      }
    }
    const parsed = AiVerdictParseSchema.safeParse(candidate);
    if (parsed.success) {
      return { verdict: { ...parsed.data, findings: sortFindings(parsed.data.findings) }, costUsd: cost, deniedReads: denied };
    }
    opts.onLog(`[AI] answer did not match the required format (attempt ${attempt}/2)`);
    prompt =
      buildStagePrompt(stage, opts.command) +
      `\n\nIMPORTANT: your previous answer was not valid. Return ONLY the structured object with "summary", "findings", "complete" and "not_checked" (severity one of ${SEVERITIES.join(', ')}).`;
  }
  throw new AgentError('AI did not return a validly formatted answer after 2 attempts', cost || undefined);
}
