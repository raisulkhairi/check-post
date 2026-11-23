import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severity rank: lower number = more severe. */
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

const duration = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?\s*(ms|s|m|h)?$/)]);

export const StageConfigSchema = z
  .object({
    name: z.string().optional(),
    // YAML reads `run: true` or `run: 123` as a boolean/number; treat it as a command.
    run: z.union([z.string(), z.number(), z.boolean()]).transform(String).optional(),
    timeout: duration.optional(),
    fail_on: z.enum(SEVERITIES).default('high'),
    paths: z.array(z.string()).optional(),
    allow_failure: z.boolean().default(false),
    enabled: z.boolean().default(true),
    agent: z.string().optional(),
    model: z.string().optional(),
    max_budget_usd: z.number().positive().optional(),
    /** Extra paths the AI must not read in this stage (added to the inherited ones). */
    sensitive_paths: z.array(z.string()).optional(),
    /** command+AI: a non-zero exit code fails the stage, whatever the AI reports. */
    require_exit_zero: z.boolean().default(false),
    /** What to do when the AI says it could not check the whole scope. */
    on_incomplete: z.enum(['fail', 'warn']).optional(),
  })
  .strict();
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const GroupConfigSchema = z
  .object({
    name: z.string().optional(),
    parallel: z.boolean().default(false),
    fail_fast: z.boolean().optional(),
    enabled: z.boolean().default(true),
    /** Most children of a parallel group that run at the same time. */
    max_parallel: z.number().int().positive().optional(),
    /** Extra paths the AI must not read in this group's stages. */
    sensitive_paths: z.array(z.string()).optional(),
  })
  .strict();
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

export const DEFAULT_SENSITIVE_PATHS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.npmrc',
  '**/.npmrc',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
];

export const PipelineConfigSchema = z
  .object({
    name: z.string().optional(),
    agent: z.string().default('claude-code'),
    model: z.string().default('sonnet'),
    /** Language for AI summaries and findings, e.g. English or Indonesian. */
    language: z.string().min(1).default('English'),
    fail_fast: z.boolean().default(true),
    require_clean_tree: z.boolean().default(true),
    sensitive_paths: z.array(z.string()).default([]),
    max_budget_usd: z.number().positive().default(1),
    confirm_ai: z.boolean().default(true),
    /** Default for parallel groups: most children running at the same time. */
    max_parallel: z.number().int().positive().default(4),
    /** Default for AI stages whose audit did not cover the whole scope. */
    on_incomplete: z.enum(['fail', 'warn']).default('fail'),
  })
  .strict();
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export type StageType = 'command' | 'ai' | 'command+ai';

export interface StageNode {
  kind: 'stage';
  /** Path relative to the pipeline folder without `.md`, e.g. `04-security/02-xss-audit`. */
  id: string;
  name: string;
  file: string;
  type: StageType;
  config: StageConfig;
  body: string;
  /** Context inherited from pipeline.md and parent _group.md files, outermost first. */
  context: string[];
  /** Every path the AI must not read: defaults, pipeline.md, parent groups, and the stage itself. */
  sensitivePaths: string[];
}

export interface GroupNode {
  kind: 'group';
  id: string;
  name: string;
  dir: string;
  config: GroupConfig;
  children: PipelineNode[];
  context: string[];
}

export type PipelineNode = StageNode | GroupNode;

export interface Pipeline {
  /** Project root (cwd where commands run). */
  root: string;
  /** Stage definition folder, e.g. `<root>/checkpost`. */
  dir: string;
  config: PipelineConfig;
  children: PipelineNode[];
}

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  message: z.string(),
  suggestion: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** The answer format the AI is asked for (every field required). */
export const AiVerdictSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
  /** false when part of the stage's scope was not checked. */
  complete: z.boolean(),
  /** What was not checked, when complete is false. */
  not_checked: z.array(z.string()),
});

/** The answer as parsed: an AI that leaves out the completeness fields is treated as complete. */
export const AiVerdictParseSchema = AiVerdictSchema.extend({
  complete: z.boolean().default(true),
  not_checked: z.array(z.string()).default([]),
});
export type AiVerdict = z.infer<typeof AiVerdictParseSchema>;

export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';

export interface StageResult {
  id: string;
  status: StageStatus;
  durationMs: number;
  exitCode?: number | null;
  summary?: string;
  findings: Finding[];
  costUsd?: number;
  error?: string;
  /** Why the stage failed beyond its findings, e.g. an incomplete audit or a non-zero exit code. */
  reasons?: string[];
  logFile?: string;
  allowFailure: boolean;
}
