import { describe, expect, it } from 'vitest';
import { AgentError, type Adapter, type AdapterRunOptions } from '../src/core/adapters/types.js';
import { describeFailure } from '../src/core/adapters/claude-code.js';
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
  it('runs stages in order and passes when all exit 0', async () => {
    const { out, order } = await run({ '01-a.md': cmd('true'), '02-b.md': cmd('echo hi') });
    expect(order).toEqual(['01-a', '02-b']);
    expect(out.passed).toBe(true);
  });

  it('fail_fast stops the pipeline and skips the remaining stages', async () => {
    const { out, status } = await run({ '01-a.md': cmd('exit 3'), '02-b.md': cmd('true'), '03-g/01-c.md': cmd('true') });
    expect(out.passed).toBe(false);
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'skipped', '03-g/01-c': 'skipped' });
    expect(out.results['01-a'].exitCode).toBe(3);
  });

  it('fail_fast: false still runs every stage', async () => {
    const { out, status } = await run({
      'pipeline.md': '---\nfail_fast: false\n---\n',
      '01-a.md': cmd('false'),
      '02-b.md': cmd('true'),
    });
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'passed' });
    expect(out.passed).toBe(false);
  });

  it('allow_failure does not fail the pipeline', async () => {
    const { out, status } = await run({ '01-a.md': cmd('false', 'allow_failure: true\n'), '02-b.md': cmd('true') });
    expect(status).toEqual({ '01-a': 'failed', '02-b': 'passed' });
    expect(out.passed).toBe(true);
  });

  it('a parallel group runs its children concurrently', async () => {
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

  it('a timeout results in an error status', async () => {
    const { status, out } = await run({ '01-a.md': cmd('sleep 5', 'timeout: 300ms\n') });
    expect(status['01-a']).toBe('error');
    expect(out.results['01-a'].error).toBe('timeout');
  });

  it('an AI stage fails only on findings >= fail_on', async () => {
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

  it('retries once on an invalid AI answer, then errors if still invalid', async () => {
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

  it('command+ai sends the command output to the AI', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    const { status } = await run({ '01-a.md': `---\nrun: echo LEAKED_OUTPUT && exit 1\n---\nReview the result\n` }, adapter);
    expect(status['01-a']).toBe('passed'); // the AI judged exit 1 a false positive
    expect(adapter.calls[0].prompt).toContain('LEAKED_OUTPUT');
    expect(adapter.calls[0].prompt).toContain('Exit code: 1');
  });

  it('passes sensitive_paths and model to the adapter', async () => {
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
    expect(adapter.calls[0].systemPrompt).toContain('in English');
  });

  it('uses the language from pipeline.md in the system prompt', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    await run({ 'pipeline.md': '---\nlanguage: Indonesian\n---\n', '01-a.md': ai('x') }, adapter);
    expect(adapter.calls[0].systemPrompt).toContain('in Indonesian');
  });

  it('an incomplete audit fails the stage by default, or only warns with on_incomplete: warn', async () => {
    const adapter = mockAdapter(() => ({ summary: 's', findings: [], complete: false, not_checked: ['GTM call sites'] }));
    const { status, out } = await run(
      {
        'pipeline.md': '---\nfail_fast: false\n---\n',
        '01-strict.md': ai('x'),
        '02-lenient.md': ai('y', 'on_incomplete: warn\n'),
      },
      adapter,
    );
    expect(status).toEqual({ '01-strict': 'failed', '02-lenient': 'passed' });
    expect(out.results['01-strict'].reasons).toEqual(['audit incomplete: GTM call sites']);
    expect(out.results['02-lenient'].reasons?.[0]).toContain('on_incomplete: warn');
    expect(adapter.calls[0].systemPrompt).toContain('not_checked');
  });

  it('an answer without completeness fields counts as complete', async () => {
    const adapter = mockAdapter(() => ({ summary: 's', findings: [] }));
    const { status, out } = await run({ '01-a.md': ai('x') }, adapter);
    expect(status['01-a']).toBe('passed');
    expect(out.results['01-a'].reasons).toBeUndefined();
  });

  it('require_exit_zero fails command+ai on a non-zero exit even without findings', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    const { status, out } = await run(
      { '01-a.md': '---\nrun: exit 2\nrequire_exit_zero: true\n---\nExplain the result\n' },
      adapter,
    );
    expect(status['01-a']).toBe('failed');
    expect(out.results['01-a'].reasons).toEqual(['command exited with code 2 (require_exit_zero)']);
    expect(adapter.calls).toHaveLength(1); // the AI still explains the output
  });

  it('group and stage sensitive_paths add to the inherited ones', async () => {
    const adapter = mockAdapter(() => ({ summary: 'ok', findings: [] }));
    await run(
      {
        'pipeline.md': '---\nsensitive_paths: [secret/**]\n---\n',
        '01-g/_group.md': '---\nsensitive_paths: [nginx/.htpasswd]\n---\n',
        '01-g/01-a.md': ai('A', 'sensitive_paths: [infra/*.tfvars]\n'),
        '01-g/02-b.md': ai('B'),
        '02-c.md': ai('C'),
      },
      adapter,
    );
    const deny = (marker: string) => adapter.calls.find((c) => c.prompt.includes(marker))!.denyPaths;
    expect(deny('A')).toEqual(expect.arrayContaining(['.env', 'secret/**', 'nginx/.htpasswd', 'infra/*.tfvars']));
    expect(deny('B')).toContain('nginx/.htpasswd');
    expect(deny('B')).not.toContain('infra/*.tfvars');
    expect(deny('C')).not.toContain('nginx/.htpasswd');
  });

  it('max_parallel limits how many children of a parallel group run at once', async () => {
    let running = 0;
    let peak = 0;
    const adapter: Adapter = {
      id: 'mock',
      label: 'Mock',
      detect: async () => ({ installed: true }),
      run: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
        return { output: { summary: 'ok', findings: [] }, rawText: '', deniedReads: [] };
      },
    };
    const files: Record<string, string> = { '01-g/_group.md': '---\nparallel: true\nmax_parallel: 2\n---\n' };
    for (let i = 1; i <= 5; i++) files[`01-g/0${i}-s.md`] = ai(`stage ${i}`);
    const { out, order } = await run(files, adapter);
    expect(out.passed).toBe(true);
    expect(peak).toBe(2);
    expect(order).toEqual(['01-g/01-s', '01-g/02-s', '01-g/03-s', '01-g/04-s', '01-g/05-s']);
  });

  it('an agent error keeps its message and cost', async () => {
    const adapter: Adapter = {
      id: 'mock',
      label: 'Mock',
      detect: async () => ({ installed: true }),
      run: async () => {
        throw new AgentError('hit the budget limit of $1', 1.23);
      },
    };
    const { status, out } = await run({ '01-a.md': ai('x') }, adapter);
    expect(status['01-a']).toBe('error');
    expect(out.results['01-a'].error).toBe('hit the budget limit of $1');
    expect(out.results['01-a'].costUsd).toBe(1.23);
  });

  it('cancelling skips the following stages', async () => {
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
  it('isBlocking compares severity', () => {
    expect(isBlocking(finding('critical'), 'high')).toBe(true);
    expect(isBlocking(finding('high'), 'high')).toBe(true);
    expect(isBlocking(finding('medium'), 'high')).toBe(false);
    expect(isBlocking(finding('info'), 'low')).toBe(false);
  });

  it('the prompt includes context, scope, and stage instructions', () => {
    const root = fixture({ 'pipeline.md': '---\n---\nCONTEXT\n', '01-a.md': ai('INSTRUCTIONS', 'paths: ["src/**"]\n') });
    const stage = discoverPipeline(root).children[0];
    if (stage.kind !== 'stage') throw new Error();
    const prompt = buildStagePrompt(stage);
    expect(prompt.indexOf('CONTEXT')).toBeLessThan(prompt.indexOf('INSTRUCTIONS'));
    expect(prompt).toContain('src/**');
  });
});

describe('claude adapter', () => {
  it('explains a budget stop with what to change', () => {
    const msg = describeFailure({ subtype: 'error_max_budget_usd', num_turns: 21 }, 0.5, 0.61);
    expect(msg).toContain('budget limit of $0.5');
    expect(msg).toContain('spent $0.610 over 21 turns');
    expect(msg).toContain('max_budget_usd');
  });

  it('uses the error list for other failures', () => {
    expect(describeFailure({ subtype: 'error_during_execution', errors: ['boom'] }, 1, 0)).toBe('Claude Code error: boom');
  });
});

describe('verdict schema', () => {
  it('has no $schema key (rejected by Claude Code)', async () => {
    const { VERDICT_JSON_SCHEMA } = await import('../src/core/runners/ai.js');
    expect(VERDICT_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(VERDICT_JSON_SCHEMA).toHaveProperty('properties.findings');
    expect((VERDICT_JSON_SCHEMA as { required: string[] }).required).toEqual(
      expect.arrayContaining(['summary', 'findings', 'complete', 'not_checked']),
    );
  });
});

describe('definitions hash', () => {
  it('changes when a stage file changes, and only then', async () => {
    const { definitionsHash } = await import('../src/core/gate.js');
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = fixture({ 'pipeline.md': '---\nmodel: haiku\n---\n', '01-g/_group.md': '---\nparallel: true\n---\n', '01-g/01-a.md': ai('x') });
    const first = definitionsHash(discoverPipeline(root));
    expect(definitionsHash(discoverPipeline(root))).toBe(first);
    writeFileSync(path.join(root, 'checkpost/01-g/_group.md'), '---\nparallel: false\n---\n');
    const second = definitionsHash(discoverPipeline(root));
    expect(second).not.toBe(first);
    writeFileSync(path.join(root, 'checkpost/01-g/01-a.md'), ai('y'));
    expect(definitionsHash(discoverPipeline(root))).not.toBe(second);
  });
});
