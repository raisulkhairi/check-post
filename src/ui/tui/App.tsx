import { spawn } from 'node:child_process';
import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { flatten } from '../../core/discovery.js';
import type { PipelineEvent } from '../../core/events.js';
import type { GateResult } from '../../core/gate.js';
import { isBlocking } from '../../core/runners/ai.js';
import type { Finding, Pipeline, PipelineNode, StageResult, StageStatus } from '../../core/types.js';
import { SEVERITY_COLOR, STATUS_COLOR, STATUS_ICON, findingLocation, formatDuration, typeLabel } from '../format.js';

export type Executor = (
  nodes: PipelineNode[] | undefined,
  onEvent: (e: PipelineEvent) => void,
  signal: AbortSignal,
) => Promise<GateResult>;

interface NodeState {
  status: StageStatus;
  startedAt?: number;
  durationMs?: number;
  result?: StageResult;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_LOG_LINES = 400;

interface Props {
  pipeline: Pipeline;
  header: string;
  execute: Executor;
  initialNodes?: PipelineNode[];
}

export function App({ pipeline, header, execute, initialNodes }: Props) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const rowsList = useMemo(() => flatten(pipeline.children), [pipeline]);
  const [states, setStates] = useState<Record<string, NodeState>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [running, setRunning] = useState(false);
  const [gate, setGate] = useState<GateResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const quitting = useRef(false);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  const onEvent = useCallback(
    (e: PipelineEvent) => {
      switch (e.type) {
        case 'stage:start':
        case 'group:start':
          setStates((s) => ({ ...s, [e.id]: { status: 'running', startedAt: Date.now() } }));
          if (e.type === 'stage:start') {
            setLogs((l) => ({ ...l, [e.id]: [] }));
            setFollow((f) => {
              if (f) {
                const idx = rowsList.findIndex((r) => r.node.id === e.id);
                if (idx >= 0) setSelected(idx);
              }
              return f;
            });
          }
          break;
        case 'stage:log':
          setLogs((l) => {
            const lines = [...(l[e.id] ?? []), e.line];
            return { ...l, [e.id]: lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines };
          });
          break;
        case 'stage:finish':
          setStates((s) => ({ ...s, [e.id]: { status: e.result.status, durationMs: e.result.durationMs, result: e.result } }));
          break;
        case 'group:finish':
          setStates((s) => ({ ...s, [e.id]: { status: e.status, durationMs: e.durationMs } }));
          break;
        default:
          break;
      }
    },
    [rowsList],
  );

  const start = useCallback(
    (nodes?: PipelineNode[]) => {
      const targets = nodes ?? pipeline.children;
      const ids = new Set(flatten(targets).map((r) => r.node.id));
      setStates((s) => {
        const next = { ...s };
        for (const id of ids) next[id] = { status: 'pending' };
        return next;
      });
      setGate(null);
      setNotice(null);
      setFollow(true);
      setRunning(true);
      const ac = new AbortController();
      controller.current = ac;
      execute(nodes, onEvent, ac.signal)
        .then((g) => setGate(g))
        .catch((err: Error) => setNotice(`Error: ${err.message}`))
        .finally(() => {
          setRunning(false);
          controller.current = null;
          if (quitting.current) exit();
        });
    },
    [execute, onEvent, pipeline, exit],
  );

  useEffect(() => {
    start(initialNodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = rowsList[selected]?.node;

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      if (running && controller.current) {
        quitting.current = true;
        setNotice('Cancelling running stages…');
        controller.current.abort();
      } else exit();
      return;
    }
    if (view === 'detail') return; // the Detail component handles its own keys
    if (key.upArrow) {
      setFollow(false);
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFollow(false);
      setSelected((i) => Math.min(rowsList.length - 1, i + 1));
    } else if (key.return || key.rightArrow) {
      setView('detail');
    } else if (input === 'r' && current) {
      if (running) setNotice('Wait for the pipeline to finish before rerunning.');
      else start([current]);
    } else if (input === 'R') {
      if (!running) start();
    } else if (input === 'o' && current) {
      const target = current.kind === 'stage' ? current.file : current.dir;
      const { editor, child } = openInEditor(target);
      child.on('error', () => setNotice(`Could not open editor "${editor}". Set CHECKPOST_EDITOR.`));
      setNotice(`Opening ${path.relative(pipeline.root, target)} in ${editor}`);
    }
  });

  if (view === 'detail' && current) {
    return (
      <Detail
        key={current.id}
        node={current}
        state={states[current.id]}
        log={logs[current.id] ?? []}
        pipeline={pipeline}
        onBack={() => setView('list')}
      />
    );
  }

  const logLines = current ? (logs[current.id] ?? []) : [];
  const logHeight = Math.max(4, Math.min(12, rows - rowsList.length - 10));
  void tick;

  return (
    <Box flexDirection="column">
      <Text bold>
        {' '}Checkpost <Text color="gray">· {header}</Text>
      </Text>
      <Text color="gray">{'─'.repeat(60)}</Text>
      {rowsList.map(({ node, depth }, i) => {
        const st = states[node.id] ?? { status: 'pending' as StageStatus };
        const isSel = i === selected;
        const icon = st.status === 'running' ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : STATUS_ICON[st.status];
        const elapsed =
          st.status === 'running' && st.startedAt
            ? formatDuration(Date.now() - st.startedAt)
            : st.durationMs !== undefined && st.status !== 'pending' && st.status !== 'skipped'
              ? formatDuration(st.durationMs)
              : '';
        const findings = st.result?.findings ?? [];
        const blocking = node.kind === 'stage' ? findings.filter((f) => isBlocking(f, node.config.fail_on)).length : 0;
        const tag = node.kind === 'group' ? (node.config.parallel ? '(parallel)' : '') : node.type === 'command' ? '' : `[${typeLabel(node)}]`;
        const prefix = depth > 0 ? '  '.repeat(depth - 1) + '├ ' : '';
        return (
          <Text key={node.id} inverse={isSel}>
            {' '}
            {prefix}
            <Text color={STATUS_COLOR[st.status]}>{icon}</Text> {node.name.padEnd(Math.max(1, 22 - prefix.length))}
            <Text color="cyan">{tag.padEnd(10)}</Text>
            <Text color="gray">{elapsed.padStart(8)}</Text>
            {findings.length > 0 && (
              <Text color={blocking ? 'red' : 'yellow'}>
                {'  '}
                {findings.length} finding{findings.length === 1 ? '' : 's'}{blocking ? ` (${blocking} blocking)` : ''}
              </Text>
            )}
            {st.result?.allowFailure && (st.status === 'failed' || st.status === 'error') && <Text color="yellow"> allow_failure</Text>}
            {st.status === 'skipped' && st.result?.summary && <Text color="gray"> {st.result.summary}</Text>}
          </Text>
        );
      })}
      <Text color="gray">{'─'.repeat(60)}</Text>
      {current && (
        <Box flexDirection="column" height={logHeight + 1}>
          <Text color="gray">{current.name} › log</Text>
          {logLines.slice(-logHeight).map((line, i) => (
            <Text key={i} wrap="truncate-end" color={line.startsWith('[AI]') ? 'cyan' : undefined}>
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Text color="gray">{'─'.repeat(60)}</Text>
      {gate && <GateBox gate={gate} />}
      {notice && <Text color="yellow"> {notice}</Text>}
      <Text color="gray">
        {' '}↑↓ select  enter details  r rerun stage  R rerun all  o open .md  q quit
      </Text>
    </Box>
  );
}

function GateBox({ gate }: { gate: GateResult }) {
  const sha = gate.git.sha ? `${gate.git.branch}@${gate.git.sha.slice(0, 7)}` : '';
  if (gate.green) {
    return (
      <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
        <Text color="green" bold>
          ✔ GATE GREEN · ok to deploy
        </Text>
        <Text color="gray">{sha}</Text>
      </Box>
    );
  }
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red" bold>
        ✖ GATE RED · not ready to deploy
      </Text>
      {gate.reasons.slice(0, 6).map((r, i) => (
        <Text key={i} color="gray">
          • {r}
        </Text>
      ))}
    </Box>
  );
}

const SEVERITY_ORDER: Finding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];
const GUI_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'codium']);

/** Open a file (optionally at a line) in the configured editor, detached from the TUI. */
export function openInEditor(file: string, line?: number | null): { editor: string; child: ReturnType<typeof spawn> } {
  const editor = process.env.CHECKPOST_EDITOR || 'code';
  const args = line && GUI_EDITORS.has(path.basename(editor)) ? ['-g', `${file}:${line}`] : [file];
  const child = spawn(editor, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { editor, child };
}

/** Rough number of terminal rows a finding takes, used to keep the selection on screen. */
function findingHeight(f: Finding, width: number): number {
  const rowsFor = (text: string) => Math.max(1, Math.ceil(text.length / Math.max(20, width)));
  return 1 + rowsFor(f.message) + (f.suggestion ? rowsFor('→ ' + f.suggestion) : 0) + 1;
}

function Detail({
  node,
  state,
  log,
  pipeline,
  onBack,
}: {
  node: PipelineNode;
  state?: NodeState;
  log: string[];
  pipeline: Pipeline;
  onBack: () => void;
}) {
  const { rows, columns } = useWindowSize();
  const result = state?.result;
  const findings = result?.findings ?? [];
  const [selected, setSelected] = useState(0);
  const [logOffset, setLogOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const top = useRef(0);

  const failOn = node.kind === 'stage' ? node.config.fail_on : 'high';
  const numWidth = String(findings.length).length;
  const bodyIndent = 2 + 2 * numWidth + 1 + 2; // "❯ " + "n/N" + gap
  const bodyWidth = columns - bodyIndent - 2;

  useInput((input, key) => {
    if (key.escape || key.leftArrow || key.backspace) return onBack();
    if (findings.length) {
      if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSelected((i) => Math.min(findings.length - 1, i + 1));
      else if (key.pageUp) setSelected((i) => Math.max(0, i - 5));
      else if (key.pageDown) setSelected((i) => Math.min(findings.length - 1, i + 5));
      else if (input === 'g') setSelected(0);
      else if (input === 'G') setSelected(findings.length - 1);
      else if (input === 'o' || key.return) {
        const f = findings[selected];
        if (!f?.file) return setNotice('This finding has no file location.');
        const { editor, child } = openInEditor(path.resolve(pipeline.root, f.file), f.line);
        child.on('error', () => setNotice(`Could not open editor "${editor}". Set CHECKPOST_EDITOR.`));
        setNotice(`Opening ${findingLocation(f)} in ${editor}`);
      }
    } else if (key.upArrow) setLogOffset((o) => Math.max(0, o - 1));
    else if (key.downArrow) setLogOffset((o) => Math.min(Math.max(0, log.length - 1), o + 1));
  });

  const status = state?.status ?? 'pending';
  const header =
    node.kind === 'stage'
      ? `${node.name} · ${typeLabel(node)}${node.type !== 'command' ? ` · fail_on: ${node.config.fail_on}` : ''}`
      : node.name;
  const counts = SEVERITY_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const).filter(([, n]) => n > 0);
  const blockingCount = findings.filter((f) => isBlocking(f, failOn)).length;

  // Fixed chrome: header, rule, summary (estimated), counts, rule, ..., rule, footer, notice.
  const summaryRows = result?.summary ? Math.ceil(result.summary.length / Math.max(20, columns - 2)) : 0;
  const available = Math.max(4, rows - 7 - summaryRows - (result?.error ? 1 : 0));

  let body: React.ReactNode;
  let position = '';
  if (node.kind === 'group') {
    body = <Text>Group with {node.children.length} items. Select a stage inside it to see details.</Text>;
  } else if (findings.length) {
    // Keep the selected finding visible: scroll the window only when the selection leaves it.
    const heights = findings.map((f) => findingHeight(f, bodyWidth));
    const fits = (from: number, to: number) => heights.slice(from, to + 1).reduce((a, b) => a + b, 0) <= available;
    if (selected < top.current) top.current = selected;
    while (top.current < selected && !fits(top.current, selected)) top.current++;
    let end = top.current;
    while (end + 1 < findings.length && fits(top.current, end + 1)) end++;
    const hiddenAbove = top.current;
    const hiddenBelow = findings.length - 1 - end;
    position = `${selected + 1}/${findings.length}`;

    body = (
      <Box flexDirection="column">
        {hiddenAbove > 0 && <Text color="gray">  ↑ {hiddenAbove} more above</Text>}
        {findings.slice(top.current, end + 1).map((f, i) => {
          const index = top.current + i;
          const isSel = index === selected;
          const blocking = isBlocking(f, failOn);
          const num = `${String(index + 1).padStart(numWidth)}/${findings.length}`;
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="cyan" bold>{isSel ? '❯ ' : '  '}</Text>
                <Text inverse={isSel} bold={isSel} color={isSel ? undefined : 'gray'}>{num}</Text>
                {'  '}
                <Text backgroundColor={SEVERITY_COLOR[f.severity]} color="black" bold>
                  {` ${f.severity.toUpperCase()} `.padEnd(10)}
                </Text>
                {blocking ? <Text color="red" bold> ● blocking</Text> : <Text color="gray">{'           '}</Text>}
                {'  '}
                <Text underline={isSel} bold={isSel}>{findingLocation(f) || '(no location)'}</Text>
              </Text>
              <Box paddingLeft={bodyIndent}>
                <Text color={isSel ? undefined : 'gray'}>{f.message}</Text>
              </Box>
              {f.suggestion && (
                <Box paddingLeft={bodyIndent}>
                  <Text color={isSel ? 'green' : 'gray'}>→ {f.suggestion}</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {hiddenBelow > 0 && <Text color="gray">  ↓ {hiddenBelow} more below</Text>}
      </Box>
    );
  } else {
    const visible = Math.max(4, available);
    const start = Math.min(logOffset, Math.max(0, log.length - visible));
    if (log.length) position = `lines ${start + 1}-${Math.min(log.length, start + visible)}/${log.length}`;
    body = (
      <Box flexDirection="column">
        {result?.status === 'passed' && node.type !== 'command' && <Text color="green">No findings.</Text>}
        {log.slice(start, start + visible).map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {'  '}
            {line}
          </Text>
        ))}
        {result?.logFile && <Text color="gray">Full log: {path.relative(pipeline.root, result.logFile)}</Text>}
      </Box>
    );
  }

  const rule = <Text color="gray">{'─'.repeat(Math.max(20, Math.min(columns - 1, 100)))}</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>
        {' '}
        <Text color={STATUS_COLOR[status]}>{STATUS_ICON[status]}</Text> {header}
        {result?.costUsd ? <Text color="gray"> · ${result.costUsd.toFixed(3)}</Text> : null}
      </Text>
      {rule}
      {result?.summary && (
        <Box paddingLeft={1}>
          <Text color="gray">{result.summary}</Text>
        </Box>
      )}
      {result?.error && (
        <Box paddingLeft={1}>
          <Text color="red">Error: {result.error}</Text>
        </Box>
      )}
      {findings.length > 0 && (
        <Text>
          {' '}
          <Text bold>{findings.length} finding{findings.length === 1 ? '' : 's'}</Text>
          {counts.map(([sev, n]) => (
            <Text key={sev}>
              {'  '}
              <Text color={SEVERITY_COLOR[sev]}>■</Text> {n} {sev}
            </Text>
          ))}
          <Text color={blockingCount ? 'red' : 'green'}>
            {'  ·  '}
            {blockingCount ? `${blockingCount} blocking (fail_on: ${failOn})` : `none blocking (fail_on: ${failOn})`}
          </Text>
        </Text>
      )}
      {rule}
      {body}
      {rule}
      {notice && <Text color="yellow"> {notice}</Text>}
      <Text color="gray">
        {findings.length
          ? ' ↑↓ select  PgUp/PgDn jump  g/G first/last  enter/o open in editor  esc back  q quit'
          : ' ↑↓ scroll  esc back  q quit'}
        {position && <Text color="cyan">{'   '}{position}</Text>}
      </Text>
    </Box>
  );
}
