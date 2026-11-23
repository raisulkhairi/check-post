import { describe, expect, it } from 'vitest';
import type { Adapter, AdapterRunOptions } from '../src/core/adapters/types.js';
import { discoverPipeline } from '../src/core/discovery.js';
import type { PipelineEvent } from '../src/core/events.js';
import { buildStagePrompt, isBlocking } from '../src/core/runners/ai.js';
import { runPipeline } from '../src/core/scheduler.js';
import type { Finding } from '../src/core/types.js';
import { ai, cmd, fixture } from './helpers.js';

function mockAdapter(respond: (o: AdapterRunOptions) => unknown): Adapter & { calls: AdapterRunOptions[] } {
  const calls: AdapterRunOptions[] = [];
  return {
    id: 'mock',
    label: 'Mock',
    calls,
    detect: async () => ({ installed: true }),
    run: async (o) => {
      calls.push(o);
      return { output: respond(o), rawText: '', costUsd: 0.01, deniedReads: [] };
    },
  };
}

const finding = (severity: Finding['severity']): Finding => ({ severity, file: 'src/a.ts', line: 1, message: 'm', suggestion: null });

async function run(files: Record<string, string>, adapter?: Adapter) {
  const root = fixture(files);
  const pipeline = discoverPipeline(root);
  const events: PipelineEvent[] = [];
  const out = await runPipeline(pipeline, { adapter, onEvent: (e) => events.push(e) });
  const order = events.filter((e) => e.type === 'stage:start').map((e) => (e as { id: string }).id);
  const status = Object.fromEntries(Object.entries(out.results).map(([k, v]) => [k, v.status]));
  return { out, order, status, events };
}

describe('scheduler', () => {
  it('menjalankan stage berurutan dan lulus bila semua exit 0', async () => {
    const { out, order } = await run({ '01-a.md': cmd('true'), '02-b.md': cmd('echo hi') });
    expect(order).toEqual(['01-a', '02-b']);
    expect(out.passed).toBe(true);
  });

  it('fail_fast menghentikan pipeline dan melewati sisa stage', async () => {
    const { out, status } = await run({ '01-a.md': cmd('exit 3'), '02-b.md': cmd('true'), '03-g/01-c.md': cmd('true') });
    expect(out.passed).toBe(false);
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'skipped', '03-g/01-c': 'skipped' });
    expect(out.results['01-a'].exitCode).toBe(3);
  });

  it('fail_fast: false tetap menjalankan semua stage', async () => {
    const { out, status } = await run({
      'pipeline.md': '---\nfail_fast: false\n---\n',
      '01-a.md': cmd('false'),
      '02-b.md': cmd('true'),
    });
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'passed' });
    expect(out.passed).toBe(false);
  });

  it('allow_failure tidak menggagalkan pipeline', async () => {
    const { out, status } = await run({ '01-a.md': cmd('false', 'allow_failure: true\n'), '02-b.md': cmd('true') });
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'passed' });
    expect(out.passed).toBe(true);
  });

  it('grup paralel menjalankan anak bersamaan', async () => {
    const t0 = Date.now();
    const { out } = await run({
      '01-g/_group.md': '---\nparallel: true\n---\n',
      '01-g/01-a.md': cmd('sleep 0.4'),
      '01-g/02-b.md': cmd('sleep 0.4'),
      '01-g/03-c.md': cmd('sleep 0.4'),
    });
    expect(out.passed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('timeout menghasilkan status error', async () => {
    const { status, out } = await run({ '01-a.md': cmd('sleep 5', 'timeout: 300ms\n') });
    expect(status['01-a']).toBe('error');
    expect(out.results['01-a'].error).toBe('timeout');
  });

  it('stage AI gagal hanya bila ada temuan >= fail_on', async () => {
    const adapter = mockAdapter((o) =>
      o.prompt.includes('STRICT') ? { summary: 's', findings: [finding('medium')] } : { summary: 's', findings: [finding('medium'), finding('low')] },
    );
    const { status } = await run(
      {
        '01-lenient.md': ai('LENIENT', 'fail_on: high\n'),
        '02-strict.md': ai('STRICT', 'fail_on: medium\n'),
      },
      adapter,
    );
    expect(status).toEqual({ '01-lenient': 'passed', '02-strict': 'failed' });
  });

  it('meminta ulang sekali bila jawaban AI tidak valid, lalu error bila tetap tidak valid', async () => {
    let n = 0;
    const flaky = mockAdapter(() => (++n === 1 ? { nope: true } : { summary: 'ok', findings: [] }));
    const r1 = await run({ '01-a.md': ai('x') }, flaky);
    expect(r1.status['01-a']).toBe('passed');
    expect(flaky.calls).toHaveLength(2);

    const broken = mockAdapter(() => 'not json');
    const r2 = await run({ '01-a.md': ai('x') }, broken);
    expect(r2.status['01-a']).toBe('error');
    expect(broken.calls).toHaveLength(2);
  });

  it('command+ai mengirim output perintah ke AI', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    const { status } = await run({ '01-a.md': `---\nrun: echo LEAKED_OUTPUT && exit 1\n---\nTinjau hasilnya\n` }, adapter);
    expect(status['01-a']).toBe('passed'); // AI menilai exit 1 sebagai false positive
    expect(adapter.calls[0].prompt).toContain('LEAKED_OUTPUT');
    expect(adapter.calls[0].prompt).toContain('Exit code: 1');
  });

  it('meneruskan sensitive_paths dan model ke adapter', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    await run(
      {
        'pipeline.md': '---\nmodel: haiku\nsensitive_paths: [secret/**]\n---\n',
        '01-a.md': ai('x'),
        '02-b.md': ai('y', 'model: opus\n'),
      },
      adapter,
    );
    expect(adapter.calls[0].model).toBe('haiku');
    expect(adapter.calls[1].model).toBe('opus');
    expect(adapter.calls[0].denyPaths).toContain('secret/**');
    expect(adapter.calls[0].denyPaths).toContain('.env');
  });

  it('pembatalan melewati stage berikutnya', async () => {
    const root = fixture({ '01-a.md': cmd('sleep 5'), '02-b.md': cmd('true') });
    const pipeline = discoverPipeline(root);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await runPipeline(pipeline, { onEvent: () => {}, signal: ac.signal });
    expect(out.passed).toBe(false);
    expect(out.results['01-a'].status).toBe('skipped');
    expect(out.results['02-b'].status).toBe('skipped');
  });
});

describe('ai helpers', () => {
  it('isBlocking membandingkan severity', () => {
    expect(isBlocking(finding('critical'), 'high')).toBe(true);
    expect(isBlocking(finding('high'), 'high')).toBe(true);
    expect(isBlocking(finding('medium'), 'high')).toBe(false);
    expect(isBlocking(finding('info'), 'low')).toBe(false);
  });

  it('prompt memuat konteks, scope, dan instruksi stage', () => {
    const root = fixture({ 'pipeline.md': '---\n---\nKONTEKS\n', '01-a.md': ai('INSTRUKSI', 'paths: ["src/**"]\n') });
    const stage = discoverPipeline(root).children[0];
    if (stage.kind !== 'stage') throw new Error();
    const prompt = buildStagePrompt(stage);
    expect(prompt.indexOf('KONTEKS')).toBeLessThan(prompt.indexOf('INSTRUKSI'));
    expect(prompt).toContain('src/**');
  });
});

describe('verdict schema', () => {
  it('tidak memuat $schema (ditolak Claude Code)', async () => {
    const { VERDICT_JSON_SCHEMA } = await import('../src/core/runners/ai.js');
    expect(VERDICT_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(VERDICT_JSON_SCHEMA).toHaveProperty('properties.findings');
  });
});
