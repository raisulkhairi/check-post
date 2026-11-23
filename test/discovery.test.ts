import { describe, expect, it } from 'vitest';
import { discoverPipeline, findNode, flatten, splitPrefix } from '../src/core/discovery.js';
import { DefinitionError, parseDuration, stageTypeOf } from '../src/core/stage-file.js';
import { ai, cmd, fixture } from './helpers.js';

const ids = (root: string) => flatten(discoverPipeline(root).children).map((r) => `${'  '.repeat(r.depth)}${r.node.id}`);

describe('discovery', () => {
  it('orders by numeric prefix, not alphabetically (2 < 10)', () => {
    const root = fixture({
      '10-deploy-check.md': cmd('true'),
      '2-build.md': cmd('true'),
      '01-lint.md': cmd('true'),
    });
    expect(ids(root)).toEqual(['01-lint', '2-build', '10-deploy-check']);
  });

  it('puts unprefixed items after prefixed ones, alphabetically', () => {
    const root = fixture({
      'zeta.md': cmd('true'),
      'alpha.md': cmd('true'),
      '01-first.md': cmd('true'),
    });
    expect(ids(root)).toEqual(['01-first', 'alpha', 'zeta']);
  });

  it('strips the prefix from display names unless name: is set', () => {
    const root = fixture({
      '01-unit-test.md': cmd('true'),
      '02-x.md': cmd('true', 'name: Custom Name\n'),
    });
    const names = discoverPipeline(root).children.map((n) => n.name);
    expect(names).toEqual(['unit-test', 'Custom Name']);
  });

  it('subfolders become nested groups configured by _group.md', () => {
    const root = fixture({
      '01-build.md': cmd('true'),
      '02-security/_group.md': '---\nparallel: true\n---\nGroup context\n',
      '02-security/02-xss.md': ai('check xss'),
      '02-security/01-secrets.md': ai('check secrets'),
      '02-security/03-deep/01-a.md': cmd('true'),
    });
    expect(ids(root)).toEqual([
      '01-build',
      '02-security',
      '  02-security/01-secrets',
      '  02-security/02-xss',
      '  02-security/03-deep',
      '    02-security/03-deep/01-a',
    ]);
    const group = discoverPipeline(root).children[1];
    expect(group.kind === 'group' && group.config.parallel).toBe(true);
  });

  it('ignores _ or . prefixed files/folders, non-md files, and enabled: false', () => {
    const root = fixture({
      '01-build.md': cmd('true'),
      '_draft.md': cmd('true'),
      '.hidden.md': cmd('true'),
      '_wip/01-x.md': cmd('true'),
      'notes.txt': 'abc',
      '02-off.md': cmd('true', 'enabled: false\n'),
    });
    expect(ids(root)).toEqual(['01-build']);
  });

  it('inherits context pipeline.md → _group.md → stage', () => {
    const root = fixture({
      'pipeline.md': '---\nmodel: opus\n---\nProject context\n',
      '01-sec/_group.md': '---\n---\nGroup context\n',
      '01-sec/01-a.md': ai('instructions'),
    });
    const p = discoverPipeline(root);
    expect(p.config.model).toBe('opus');
    const stage = flatten(p.children).find((r) => r.node.kind === 'stage')!.node;
    expect(stage.context).toEqual(['Project context', 'Group context']);
  });

  it('always adds the default sensitive_paths', () => {
    const root = fixture({ 'pipeline.md': '---\nsensitive_paths: [src/environments/**]\n---\n', '01-a.md': cmd('true') });
    const paths = discoverPipeline(root).config.sensitive_paths;
    expect(paths).toContain('src/environments/**');
    expect(paths).toContain('.env');
    expect(paths).toContain('.npmrc');
  });

  it('reports every problem at once with file paths', () => {
    const root = fixture({
      '01-a.md': cmd('true'),
      '01-b.md': cmd('true'),
      '02-empty.md': '---\n---\n',
      '03-bad.md': '---\nfail_on: urgent\n---\nbody\n',
      '04-typo.md': '---\nrunn: npm test\n---\n',
      '05-group/_draft.md': cmd('true'),
    });
    try {
      discoverPipeline(root);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DefinitionError);
      const text = (err as DefinitionError).problems.join('\n');
      expect(text).toContain('prefix 1 is used twice');
      expect(text).toContain('02-empty.md: empty stage');
      expect(text).toMatch(/03-bad\.md: fail_on/);
      expect(text).toMatch(/04-typo\.md/);
      expect(text).toContain('empty group');
    }
  });

  it('clear error when the checkpost/ folder is missing', () => {
    expect(() => discoverPipeline('/tmp/does-not-exist-aip')).toThrow(/checkpost init/);
  });

  it('findNode accepts an id, an id without prefixes, or a name', () => {
    const root = fixture({ '01-build.md': cmd('true'), '02-security/01-xss-audit.md': ai('x') });
    const { children } = discoverPipeline(root);
    expect(findNode(children, '02-security')?.id).toBe('02-security');
    expect(findNode(children, 'security')?.id).toBe('02-security');
    expect(findNode(children, 'security/xss-audit')?.id).toBe('02-security/01-xss-audit');
    expect(findNode(children, 'xss-audit.md')?.id).toBe('02-security/01-xss-audit');
    expect(findNode(children, 'nope')).toBeUndefined();
  });
});

describe('stage-file', () => {
  it('derives the type from the content', () => {
    expect(stageTypeOf('npm test', '')).toBe('command');
    expect(stageTypeOf(undefined, 'check xss')).toBe('ai');
    expect(stageTypeOf('gitleaks', 'tinjau')).toBe('command+ai');
    expect(stageTypeOf('  ', '  ')).toBeNull();
  });

  it('parses durations', () => {
    expect(parseDuration('30s', 0)).toBe(30_000);
    expect(parseDuration('5m', 0)).toBe(300_000);
    expect(parseDuration('1h', 0)).toBe(3_600_000);
    expect(parseDuration(10, 0)).toBe(10_000);
    expect(parseDuration(undefined, 42)).toBe(42);
  });

  it('splitPrefix', () => {
    expect(splitPrefix('03-security')).toEqual({ prefix: 3, name: 'security' });
    expect(splitPrefix('10_build.md')).toEqual({ prefix: 10, name: 'build' });
    expect(splitPrefix('build.md')).toEqual({ prefix: null, name: 'build' });
    expect(splitPrefix('2fa-check.md')).toEqual({ prefix: null, name: '2fa-check' });
  });
});
