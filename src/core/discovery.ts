import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  GroupConfigSchema,
  PipelineConfigSchema,
  StageConfigSchema,
  DEFAULT_SENSITIVE_PATHS,
  type GroupNode,
  type Pipeline,
  type PipelineNode,
  type StageNode,
} from './types.js';
import { DefinitionError, parseMarkdown, stageTypeOf } from './stage-file.js';

export const PIPELINE_DIR = 'checkpost';
export const PIPELINE_FILE = 'pipeline.md';
export const GROUP_FILE = '_group.md';

interface Entry {
  fsName: string;
  full: string;
  isDir: boolean;
  prefix: number | null;
  name: string;
}

/** `03-security` → { prefix: 3, name: 'security' }; `build.md` → { prefix: null, name: 'build' }. */
export function splitPrefix(fsName: string): { prefix: number | null; name: string } {
  const base = fsName.replace(/\.md$/i, '');
  const m = base.match(/^(\d+)[-_.\s]+(.+)$/);
  if (m) return { prefix: Number(m[1]), name: m[2] };
  return { prefix: null, name: base };
}

export function compareEntries(a: { prefix: number | null; name: string }, b: { prefix: number | null; name: string }): number {
  if (a.prefix !== null && b.prefix !== null && a.prefix !== b.prefix) return a.prefix - b.prefix;
  if (a.prefix !== null && b.prefix === null) return -1;
  if (a.prefix === null && b.prefix !== null) return 1;
  return a.name.localeCompare(b.name);
}

function listEntries(dir: string, isRoot: boolean): Entry[] {
  const entries: Entry[] = [];
  for (const fsName of readdirSync(dir)) {
    if (fsName.startsWith('.')) continue;
    if (fsName.startsWith('_')) continue; // includes _group.md, which is read separately
    if (isRoot && fsName === PIPELINE_FILE) continue;
    const full = path.join(dir, fsName);
    const isDir = statSync(full).isDirectory();
    if (!isDir && !fsName.toLowerCase().endsWith('.md')) continue;
    entries.push({ fsName, full, isDir, ...splitPrefix(fsName) });
  }
  return entries.sort(compareEntries);
}

export function discoverPipeline(root: string, dirName = PIPELINE_DIR): Pipeline {
  const dir = path.join(root, dirName);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new DefinitionError([`Folder ${dirName}/ not found in ${root}. Run "checkpost init" first.`]);
  }
  const problems: string[] = [];
  const rel = (p: string) => path.relative(root, p);

  let pipelineConfig = PipelineConfigSchema.parse({});
  let rootContext: string[] = [];
  const pipelineFile = path.join(dir, PIPELINE_FILE);
  if (existsSync(pipelineFile)) {
    try {
      const { data, body } = parseMarkdown(readFileSync(pipelineFile, 'utf8'), PipelineConfigSchema, rel(pipelineFile));
      pipelineConfig = data;
      if (body) rootContext = [body];
    } catch (err) {
      if (err instanceof DefinitionError) problems.push(...err.problems);
      else throw err;
    }
  }
  pipelineConfig.sensitive_paths = [...new Set([...DEFAULT_SENSITIVE_PATHS, ...pipelineConfig.sensitive_paths])];

  const walk = (current: string, context: string[], sensitive: string[], isRoot: boolean): PipelineNode[] => {
    const entries = listEntries(current, isRoot);
    const seen = new Map<number, string>();
    for (const e of entries) {
      if (e.prefix === null) continue;
      const other = seen.get(e.prefix);
      if (other) problems.push(`${rel(current) || '.'}: prefix ${e.prefix} is used twice (${other} and ${e.fsName})`);
      else seen.set(e.prefix, e.fsName);
    }

    const nodes: PipelineNode[] = [];
    for (const e of entries) {
      const id = path.relative(dir, e.full).replace(/\.md$/i, '').split(path.sep).join('/');
      if (e.isDir) {
        let groupConfig = GroupConfigSchema.parse({});
        let groupContext = context;
        let groupSensitive = sensitive;
        const groupFile = path.join(e.full, GROUP_FILE);
        if (existsSync(groupFile)) {
          try {
            const { data, body } = parseMarkdown(readFileSync(groupFile, 'utf8'), GroupConfigSchema, rel(groupFile));
            groupConfig = data;
            if (body) groupContext = [...context, body];
            if (data.sensitive_paths?.length) groupSensitive = [...new Set([...sensitive, ...data.sensitive_paths])];
          } catch (err) {
            if (err instanceof DefinitionError) problems.push(...err.problems);
            else throw err;
          }
        }
        if (!groupConfig.enabled) continue;
        const children = walk(e.full, groupContext, groupSensitive, false);
        if (children.length === 0) {
          problems.push(`${rel(e.full)}/: empty group (no enabled .md stages)`);
          continue;
        }
        const group: GroupNode = {
          kind: 'group',
          id,
          name: groupConfig.name ?? e.name,
          dir: e.full,
          config: groupConfig,
          children,
          context: groupContext,
        };
        nodes.push(group);
        continue;
      }

      try {
        const { data, body } = parseMarkdown(readFileSync(e.full, 'utf8'), StageConfigSchema, rel(e.full));
        if (!data.enabled) continue;
        const type = stageTypeOf(data.run, body);
        if (!type) {
          problems.push(`${rel(e.full)}: empty stage. Add "run:" to the frontmatter, AI instructions to the body, or both.`);
          continue;
        }
        const stage: StageNode = {
          kind: 'stage',
          id,
          name: data.name ?? e.name,
          file: e.full,
          type,
          config: data,
          body,
          context,
          sensitivePaths: data.sensitive_paths?.length ? [...new Set([...sensitive, ...data.sensitive_paths])] : sensitive,
        };
        nodes.push(stage);
      } catch (err) {
        if (err instanceof DefinitionError) problems.push(...err.problems);
        else throw err;
      }
    }
    return nodes;
  };

  const children = walk(dir, rootContext, pipelineConfig.sensitive_paths, true);
  if (problems.length === 0 && children.length === 0) {
    problems.push(`${dirName}/: no stages yet. Add a file such as 01-build.md.`);
  }
  if (problems.length) throw new DefinitionError(problems);

  return { root, dir, config: pipelineConfig, children };
}

/** Every node in display order, with its depth. */
export function flatten(nodes: PipelineNode[], depth = 0): Array<{ node: PipelineNode; depth: number }> {
  const out: Array<{ node: PipelineNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === 'group') out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

export function allStages(nodes: PipelineNode[]): StageNode[] {
  return flatten(nodes)
    .map((x) => x.node)
    .filter((n): n is StageNode => n.kind === 'stage');
}

/** Find a node by exact id, id without prefixes, or name. */
export function findNode(nodes: PipelineNode[], query: string): PipelineNode | undefined {
  const q = query.replace(/\.md$/i, '').replace(/\/+$/, '');
  const all = flatten(nodes).map((x) => x.node);
  const stripped = (id: string) =>
    id
      .split('/')
      .map((seg) => splitPrefix(seg).name)
      .join('/');
  return (
    all.find((n) => n.id === q) ??
    all.find((n) => stripped(n.id) === q) ??
    all.find((n) => n.name === q)
  );
}
