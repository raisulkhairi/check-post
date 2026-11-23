import { spawn } from 'node:child_process';
import path from 'node:path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { flatten } from '../../core/discovery.js';
import type { PipelineEvent } from '../../core/events.js';
import type { GateResult } from '../../core/gate.js';
import { isBlocking } from '../../core/runners/ai.js';
import type { Pipeline, PipelineNode, StageResult, StageStatus } from '../../core/types.js';
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
  const [detailOffset, setDetailOffset] = useState(0);
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
        setNotice('Membatalkan stage yang sedang berjalan…');
        controller.current.abort();
      } else exit();
      return;
    }
    if (view === 'detail') {
      if (key.escape || key.leftArrow || key.return) {
        setView('list');
        setDetailOffset(0);
      } else if (key.upArrow) setDetailOffset((o) => Math.max(0, o - 1));
      else if (key.downArrow) setDetailOffset((o) => o + 1);
      return;
    }
    if (key.upArrow) {
      setFollow(false);
      setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setFollow(false);
      setSelected((i) => Math.min(rowsList.length - 1, i + 1));
    } else if (key.return || key.rightArrow) {
      setView('detail');
    } else if (input === 'r' && current) {
      if (running) setNotice('Tunggu pipeline selesai sebelum rerun.');
      else start([current]);
    } else if (input === 'R') {
      if (!running) start();
    } else if (input === 'o' && current) {
      const target = current.kind === 'stage' ? current.file : current.dir;
      const editor = process.env.CHECKPOST_EDITOR || 'code';
      const child = spawn(editor, [target], { detached: true, stdio: 'ignore' });
      child.on('error', () => setNotice(`Tidak bisa membuka editor "${editor}". Set CHECKPOST_EDITOR.`));
      child.unref();
      setNotice(`Membuka ${path.relative(pipeline.root, target)} di ${editor}`);
    }
  });

  if (view === 'detail' && current) {
    return <Detail node={current} state={states[current.id]} log={logs[current.id] ?? []} offset={detailOffset} rows={rows} pipeline={pipeline} />;
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
        const tag = node.kind === 'group' ? (node.config.parallel ? '(paralel)' : '') : node.type === 'command' ? '' : `[${typeLabel(node)}]`;
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
                {findings.length} temuan{blocking ? ` (${blocking} blokir)` : ''}
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
        {' '}↑↓ pilih  enter detail  r rerun stage  R rerun semua  o buka .md  q keluar
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
          ✔ GATE GREEN · boleh deploy
        </Text>
        <Text color="gray">{sha}</Text>
      </Box>
    );
  }
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red" bold>
        ✖ GATE RED · belum boleh deploy
      </Text>
      {gate.reasons.slice(0, 6).map((r, i) => (
        <Text key={i} color="gray">
          • {r}
        </Text>
      ))}
    </Box>
  );
}

function Detail({
  node,
  state,
  log,
  offset,
  rows,
  pipeline,
}: {
  node: PipelineNode;
  state?: NodeState;
  log: string[];
  offset: number;
  rows: number;
  pipeline: Pipeline;
}) {
  const result = state?.result;
  const lines: React.ReactNode[] = [];
  if (node.kind === 'group') {
    lines.push(<Text key="g">Grup berisi {node.children.length} item. Pilih stage di dalamnya untuk melihat detail.</Text>);
  } else {
    if (result?.summary) lines.push(<Text key="s">{result.summary}</Text>);
    if (result?.error) lines.push(<Text key="e" color="red">Error: {result.error}</Text>);
    if (result?.findings.length) {
      result.findings.forEach((f, i) => {
        const blocking = isBlocking(f, node.config.fail_on);
        lines.push(
          <Box key={`f${i}`} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={SEVERITY_COLOR[f.severity]} bold>
                {f.severity.toUpperCase().padEnd(9)}
              </Text>
              <Text underline>{findingLocation(f)}</Text>
              {blocking && <Text color="red"> (blokir)</Text>}
            </Text>
            <Text>{'         '}{f.message}</Text>
            {f.suggestion && <Text color="gray">{'         '}→ {f.suggestion}</Text>}
          </Box>,
        );
      });
    } else if (node.type === 'command' || !result) {
      lines.push(<Text key="lt" color="gray">Log:</Text>);
      log.forEach((line, i) => lines.push(<Text key={`l${i}`}>  {line}</Text>));
    }
    if (result?.logFile) lines.push(<Text key="lf" color="gray">Log lengkap: {path.relative(pipeline.root, result.logFile)}</Text>);
  }
  const visible = Math.max(5, rows - 6);
  const start = Math.min(offset, Math.max(0, lines.length - visible));
  const header =
    node.kind === 'stage'
      ? `${node.name} · ${typeLabel(node)}${node.kind === 'stage' && node.type !== 'command' ? ` · fail_on: ${node.config.fail_on}` : ''}`
      : node.name;
  return (
    <Box flexDirection="column">
      <Text bold>
        {' '}
        <Text color={STATUS_COLOR[state?.status ?? 'pending']}>{STATUS_ICON[state?.status ?? 'pending']}</Text> {header}
        {result?.costUsd ? <Text color="gray"> · ${result.costUsd.toFixed(3)}</Text> : null}
      </Text>
      <Text color="gray">{'─'.repeat(60)}</Text>
      {lines.slice(start, start + visible)}
      <Text color="gray">{'─'.repeat(60)}</Text>
      <Text color="gray"> ↑↓ gulir  esc kembali  q keluar</Text>
    </Box>
  );
}
