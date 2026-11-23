import { describe, expect, it } from 'vitest';
import { discoverPipeline, findNode, flatten, splitPrefix } from '../src/core/discovery.js';
import { DefinitionError, parseDuration, stageTypeOf } from '../src/core/stage-file.js';
import { ai, cmd, fixture } from './helpers.js';

const ids = (root: string) => flatten(discoverPipeline(root).children).map((r) => `${'  '.repeat(r.depth)}${r.node.id}`);

describe('discovery', () => {
  it('mengurutkan berdasarkan prefix angka, bukan abjad (2 < 10)', () => {
    const root = fixture({
      '10-deploy-check.md': cmd('true'),
      '2-build.md': cmd('true'),
      '01-lint.md': cmd('true'),
    });
    expect(ids(root)).toEqual(['01-lint', '2-build', '10-deploy-check']);
  });

  it('menaruh item tanpa prefix setelah yang berprefix, urut abjad', () => {
    const root = fixture({
      'zeta.md': cmd('true'),
      'alpha.md': cmd('true'),
      '01-first.md': cmd('true'),
    });
    expect(ids(root)).toEqual(['01-first', 'alpha', 'zeta']);
  });

  it('membuang prefix dari nama tampilan, kecuali ada name: di frontmatter', () => {
    const root = fixture({
      '01-unit-test.md': cmd('true'),
      '02-x.md': cmd('true', 'name: Custom Name\n'),
    });
    const names = discoverPipeline(root).children.map((n) => n.name);
    expect(names).toEqual(['unit-test', 'Custom Name']);
  });

  it('subfolder menjadi grup bersarang dengan _group.md sebagai config', () => {
    const root = fixture({
      '01-build.md': cmd('true'),
      '02-security/_group.md': '---\nparallel: true\n---\nKonteks grup\n',
      '02-security/02-xss.md': ai('cek xss'),
      '02-security/01-secrets.md': ai('cek secret'),
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

  it('mengabaikan file/folder berawalan _ atau ., file non-md, dan enabled: false', () => {
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

  it('mewariskan konteks pipeline.md → _group.md → stage', () => {
    const root = fixture({
      'pipeline.md': '---\nmodel: opus\n---\nKonteks project\n',
      '01-sec/_group.md': '---\n---\nKonteks grup\n',
      '01-sec/01-a.md': ai('instruksi'),
    });
    const p = discoverPipeline(root);
    expect(p.config.model).toBe('opus');
    const stage = flatten(p.children).find((r) => r.node.kind === 'stage')!.node;
    expect(stage.context).toEqual(['Konteks project', 'Konteks grup']);
  });

  it('selalu menambahkan default sensitive_paths', () => {
    const root = fixture({ 'pipeline.md': '---\nsensitive_paths: [src/environments/**]\n---\n', '01-a.md': cmd('true') });
    const paths = discoverPipeline(root).config.sensitive_paths;
    expect(paths).toContain('src/environments/**');
    expect(paths).toContain('.env');
    expect(paths).toContain('.npmrc');
  });

  it('melaporkan semua masalah sekaligus dengan path file', () => {
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
      expect(text).toContain('prefix 1 dipakai dua kali');
      expect(text).toContain('02-empty.md: stage kosong');
      expect(text).toMatch(/03-bad\.md: fail_on/);
      expect(text).toMatch(/04-typo\.md/);
      expect(text).toContain('grup kosong');
    }
  });

  it('error jelas bila folder checkpost/ tidak ada', () => {
    expect(() => discoverPipeline('/tmp/does-not-exist-aip')).toThrow(/checkpost init/);
  });

  it('findNode menerima id, id tanpa prefix, atau nama', () => {
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
  it('menentukan tipe dari isi', () => {
    expect(stageTypeOf('npm test', '')).toBe('command');
    expect(stageTypeOf(undefined, 'cek xss')).toBe('ai');
    expect(stageTypeOf('gitleaks', 'tinjau')).toBe('command+ai');
    expect(stageTypeOf('  ', '  ')).toBeNull();
  });

  it('parse durasi', () => {
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
