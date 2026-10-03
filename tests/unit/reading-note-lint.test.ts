import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { lintReadingNote, type LintFinding } from '../../src/knowledge/reading-note-lint.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const GOLDEN = path.join(repoRoot, 'skills', '_shared', 'examples', 'reading-note-v2.md');
const FIGURE_FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'readable-output', 'figure-paper-with-appraisal.md');

function load(file: string): { body: string; sources: string[] } {
  const parsed = matter(fs.readFileSync(file, 'utf-8'));
  const sources = Array.isArray(parsed.data.sources)
    ? (parsed.data.sources as Array<{ path: string }>).map((s) => s.path)
    : [];
  return { body: parsed.content, sources };
}

/** Replace text and fail loudly if the target is absent, so a mutation test can never pass vacuously. */
function mutate(body: string, from: string, to: string): string {
  if (!body.includes(from)) throw new Error(`mutation target not found: ${from}`);
  return body.replace(from, to);
}

function codes(findings: LintFinding[], severity?: 'warn' | 'info'): string[] {
  return findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);
}

const golden = load(GOLDEN);
const figure = load(FIGURE_FIXTURE);

describe('lintReadingNote — shipped examples', () => {
  it('the golden example (text-only paper, three attachments) lints clean', () => {
    const result = lintReadingNote(golden.body, { sources: golden.sources });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the figure paper with ### Figure Map subsections, E-IDs and an Appraisal lints clean', () => {
    const result = lintReadingNote(figure.body, { sources: figure.sources });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports stats that the pilot can compare across versions', () => {
    const { stats } = lintReadingNote(golden.body);
    expect(stats.claims).toBe(6);
    expect(stats.diagrams).toBe(2);
    expect(stats.tldrWords).toBeGreaterThan(30);
    expect(stats.sentences).toBeGreaterThan(20);
    expect(stats.meanWords).toBeGreaterThan(4);
    expect(stats.meanWords).toBeLessThan(25);
    expect(stats.pctOver25).toBe(0);
  });

  it('treats Windows (CRLF) line endings like Unix ones', () => {
    const crlf = golden.body.replace(/\n/g, '\r\n');
    const result = lintReadingNote(crlf, { sources: golden.sources });
    expect(result.findings).toEqual([]);
    expect(result.stats).toEqual(lintReadingNote(golden.body, { sources: golden.sources }).stats);
  });

  it('does not throw on an empty body and reports the missing structure', () => {
    const result = lintReadingNote('');
    expect(result.ok).toBe(false);
    expect(codes(result.findings, 'warn')).toContain('missing-tldr');
    expect(codes(result.findings, 'warn')).toContain('missing-heading');
  });
});

describe('lintReadingNote — robustness', () => {
  it('handles a long, malformed ID list in parentheses without catastrophic backtracking', () => {
    const refs = Array.from({ length: 40 }, () => 'C1').join(', ');
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', `Result (${refs}, X). In this assay, IL-42 lowered`);
    const started = performance.now();
    lintReadingNote(body, { sources: golden.sources });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('never throws and always returns well-formed findings on random Markdown-like input (seeded fuzz)', () => {
    const pool = [
      '', '', '## Claims', '## Reasoning', '## Evidence', '## Figure Map', '## Takeaways', '### Sub', '# Title',
      '> [!abstract] TL;DR', '> **Did:** x', '> **Source:** paper.md', '>', '```mermaid', '```', '~~~', '````',
      'flowchart TB', '  A["a"] -->|"b (C1)"| B["c"]', '  A[[x]] --> B', '<!--', '-->', '<!-- one line -->',
      '- **C1** [measured] Text. (Fig 1A)', '- **C2** [guess] Text.', '1. numbered', '  - nested **E1**', '+ plus',
      '| a | b |', '|---|---|', '| 1 | ' + 'w '.repeat(35) + '|', 'It shows a thing. This pathway matters.',
      'Result (C1, C9, X). See (E1; Fig 2). <br> and x<y and z>w and `<sub>`.', 'p. 7 and PDF p. 7', 'α-syntrophin et al. 2018, Fig. 2A vs. 3',
      '\t- tab indented', 'ünïcödé 日本語 text. Another sentence here.', 'x'.repeat(2000), '(((((', ')))))', '[[wiki]]', '[x](y)',
    ];
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let doc = 0; doc < 400; doc++) {
      const lines = Array.from({ length: 1 + rand(60) }, () => pool[rand(pool.length)]);
      const text = lines.join(rand(4) === 0 ? '\r\n' : '\n');
      const result = lintReadingNote(text, rand(2) === 0 ? { sources: ['paper.md'] } : {});
      expect(typeof result.ok).toBe('boolean');
      expect(result.ok).toBe(!result.findings.some((f) => f.severity === 'warn'));
      for (const f of result.findings) {
        expect(Number.isInteger(f.line) && f.line >= 1, `line ${f.line} in ${f.code}`).toBe(true);
        expect(['warn', 'info']).toContain(f.severity);
        expect(f.code.length).toBeGreaterThan(0);
        expect(f.message.length).toBeGreaterThan(0);
      }
      expect(Number.isFinite(result.stats.meanWords)).toBe(true);
      expect(result.stats.pctOver25).toBeGreaterThanOrEqual(0);
      expect(result.stats.pctOver25).toBeLessThanOrEqual(100);
    }
  });

  it('lints a note with thousands of lines in well under a few seconds', () => {
    const filler = Array.from({ length: 4000 }, (_, i) => `Line ${i} states one plain fact about the sample. (Fig ${i % 9 + 1}A)`).join('\n');
    const body = mutate(golden.body, '## Extensions', `${filler}\n\n## Extensions`);
    const started = performance.now();
    lintReadingNote(body, { sources: golden.sources });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('lintReadingNote — Claims must be claim bullets', () => {
  const claimsBlock = (body: string): { start: number; end: number } => ({
    start: body.indexOf('## Claims\n') + '## Claims\n'.length,
    end: body.indexOf('## Reasoning'),
  });
  const replaceClaims = (replacement: string): string => {
    const { start, end } = claimsBlock(golden.body);
    return golden.body.slice(0, start) + replacement + golden.body.slice(end);
  };

  it('warns when the Claims section has prose instead of bullets, and reports no claims', () => {
    const result = lintReadingNote(replaceClaims('\nIL-42 lowers granzyme B in primary human CD8 T cells. (§Results 1)\n\n'), { sources: golden.sources });
    expect(codes(result.findings, 'warn')).toContain('claim-format');
    expect(codes(result.findings, 'warn')).toContain('no-claims');
    expect(result.ok).toBe(false);
  });

  it('warns when claims are written as a table', () => {
    const table = '\n| ID | Claim |\n|---|---|\n| C1 | IL-42 lowers granzyme B. (§Results 1) |\n\n';
    expect(codes(lintReadingNote(replaceClaims(table), { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
  });

  it('warns when a claim bullet is indented or uses a plus marker', () => {
    const indented = '\n  - **C1** [measured] IL-42 lowers granzyme B. (§Results 1)\n\n';
    expect(codes(lintReadingNote(replaceClaims(indented), { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
    const plus = '\n+ **C1** [measured] IL-42 lowers granzyme B. (§Results 1)\n\n';
    expect(codes(lintReadingNote(replaceClaims(plus), { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
  });

  it('warns about an empty Claims section but does not double-report when the heading itself is missing', () => {
    const empty = lintReadingNote(replaceClaims('\n'), { sources: golden.sources });
    expect(codes(empty.findings, 'warn')).toContain('no-claims');
    const noHeading = lintReadingNote(mutate(golden.body, '## Claims\n', ''), { sources: golden.sources });
    expect(codes(noHeading.findings, 'warn')).toContain('missing-heading');
    expect(codes(noHeading.findings)).not.toContain('no-claims');
  });

  it('still allows indented continuation lines of a claim and HTML comments inside Claims', () => {
    const body = replaceClaims('\n- **C1** [measured] IL-42 lowers granzyme B in primary cells\n  and in Jurkat cells. (§Results 1)\n<!-- reviewed -->\n\n');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings)).not.toContain('claim-format');
  });
});

describe('lintReadingNote — TL;DR', () => {
  it('warns when the TL;DR callout is missing', () => {
    const body = golden.body.replace(/^> .*\n/gm, '');
    const result = lintReadingNote(body);
    expect(codes(result.findings, 'warn')).toContain('missing-tldr');
    expect(result.ok).toBe(false);
  });

  it('budgets the TL;DR by words, not by physical lines (line breaks change with the window width)', () => {
    const body = mutate(golden.body, '> **Source:** paper.md', '> **Extra:** one more short line\n> **Source:** paper.md');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings)).not.toContain('tldr-too-long');
  });

  it('warns about each missing TL;DR field (Did, Found, Trust, Why it matters here)', () => {
    for (const field of ['Did', 'Found', 'Trust', 'Why it matters here']) {
      const body = golden.body.replace(new RegExp(`^> \\*\\*${field}:\\*\\*.*\\n`, 'm'), '');
      expect(body, field).not.toBe(golden.body);
      const finding = lintReadingNote(body, { sources: golden.sources }).findings.find((f) => f.code === 'tldr-missing-field');
      expect(finding?.severity, field).toBe('warn');
      expect(finding?.message, field).toContain(field);
    }
  });

  it('a TL;DR that holds only the Source line is not enough', () => {
    const body = golden.body.replace(/^> \*\*(Did|Found|Trust|Why it matters here):\*\*.*\n/gm, '');
    const missing = lintReadingNote(body, { sources: golden.sources }).findings.filter((f) => f.code === 'tldr-missing-field');
    expect(missing).toHaveLength(4);
  });

  it('warns when the TL;DR exceeds the word budget', () => {
    const filler = Array.from({ length: 200 }, () => 'word').join(' ');
    const body = mutate(golden.body, '**Trust:** ', `**Trust:** ${filler} `);
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('tldr-too-long');
  });

  it('warns when the TL;DR has no Source line', () => {
    const body = mutate(golden.body, '> **Source:** paper.md\n', '');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('tldr-no-source');
  });

  it('accepts abstract, summary and tldr callout types', () => {
    for (const type of ['summary', 'tldr']) {
      const body = mutate(golden.body, '[!abstract]', `[!${type}]`);
      expect(codes(lintReadingNote(body).findings)).not.toContain('missing-tldr');
    }
  });

  it('in path mode, warns when the declared Source is not a registered source', () => {
    const result = lintReadingNote(golden.body, { sources: ['claude-notes.md', 'notebooklm-summary.md'] });
    expect(codes(result.findings, 'warn')).toContain('source-not-registered');
  });

  it('uses the declared Source line, not sources[0], so a non-PDF source sorted first is fine', () => {
    // golden frontmatter lists claude-notes.md first and paper.md last; Source: paper.md must still pass.
    expect(golden.sources[0]).toBe('claude-notes.md');
    const result = lintReadingNote(golden.body, { sources: golden.sources });
    expect(codes(result.findings)).not.toContain('source-not-registered');
  });

  it('accepts a Source path whose basename matches a registered source', () => {
    const body = mutate(golden.body, '**Source:** paper.md', '**Source:** Reading/attachments/lee/paper.md');
    const result = lintReadingNote(body, { sources: golden.sources });
    expect(codes(result.findings)).not.toContain('source-not-registered');
  });
});

describe('lintReadingNote — headings', () => {
  it('warns about a missing layout heading and names it', () => {
    const body = mutate(golden.body, '## Evidence\n', '');
    const finding = lintReadingNote(body).findings.find((f) => f.code === 'missing-heading');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toContain('Evidence');
  });

  it('warns about a missing Figure Map (it is part of the layout)', () => {
    const body = mutate(golden.body, '## Figure Map\n', '');
    const finding = lintReadingNote(body).findings.find((f) => f.code === 'missing-heading');
    expect(finding?.message).toContain('Figure Map');
  });

  it('warns about a duplicated heading', () => {
    const body = golden.body + '\n## Claims\n\n- **C7** [measured] Extra. (§Results 1)\n';
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('duplicate-heading');
  });

  it('warns when headings are out of order', () => {
    const extensions = golden.body.slice(golden.body.indexOf('## Extensions'));
    let body = golden.body.slice(0, golden.body.indexOf('## Extensions'));
    body = mutate(body, '## Assumptions', '## TMP_A');
    body = mutate(body, '## Takeaways', '## Assumptions');
    body = mutate(body, '## TMP_A', '## Takeaways');
    expect(codes(lintReadingNote(body + extensions).findings, 'warn')).toContain('heading-order');
  });

  it('warns when an Appraisal section sits before Extensions', () => {
    const body = mutate(golden.body, '## Extensions', '## Appraisal: Early\n\nText here.\n\n## Extensions');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('heading-order');
  });

  it('allows trailing Appraisal sections after Extensions', () => {
    const result = lintReadingNote(figure.body, { sources: figure.sources });
    expect(codes(result.findings)).not.toContain('heading-order');
  });

  it('reports an unknown extra H2 as info only', () => {
    const body = golden.body + '\n## Random notes\n\nSomething.\n';
    const result = lintReadingNote(body, { sources: golden.sources });
    expect(codes(result.findings, 'info')).toContain('extra-section');
    expect(result.ok).toBe(true);
  });

  it('ignores headings inside fenced code and HTML comments', () => {
    const body =
      golden.body +
      '\n```text\n## Claims\n## Evidence\n```\n\n<!--\n## Takeaways\n-->\n';
    const result = lintReadingNote(body, { sources: golden.sources });
    expect(codes(result.findings)).not.toContain('duplicate-heading');
  });

  it('accepts the no-figures placeholder comment under Figure Map', () => {
    expect(golden.body).toContain('<!-- No data figures found in compiled sources -->');
    const result = lintReadingNote(golden.body, { sources: golden.sources });
    expect(codes(result.findings)).not.toContain('missing-heading');
  });
});

describe('lintReadingNote — claims, locators and IDs', () => {
  it('warns when a claim bullet lacks the support-type label', () => {
    const body = mutate(golden.body, '- **C1** [measured] ', '- **C1** ');
    const finding = lintReadingNote(body).findings.find((f) => f.code === 'claim-format');
    expect(finding?.severity).toBe('warn');
  });

  it('warns about numbered-list claims (the pre-v2 format)', () => {
    const body = mutate(golden.body, '- **C1** [measured] IL-42 at 20 ng/mL', '1. IL-42 at 20 ng/mL');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('claim-format');
  });

  it('rejects an unknown support-type label', () => {
    const body = mutate(golden.body, '[inferred]', '[certain]');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('claim-format');
  });

  it('warns when a claim has no locator', () => {
    const body = mutate(golden.body, ' (§Results 2)\n- **C3**', '\n- **C3**');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('claim-no-locator');
  });

  it('accepts every documented locator form', () => {
    const forms = ['Fig 2A–E', 'Table 1', 'Suppl. S3', 'PDF p. 7', 'printed p. 7', '§Methods', 'Box 1', 'Movie S1', 'supp1.pdf, Suppl. S3'];
    for (const form of forms) {
      const body = mutate(golden.body, '(§Results 5)\n\n## Reasoning', `(${form})\n\n## Reasoning`);
      expect(codes(lintReadingNote(body).findings), form).not.toContain('claim-no-locator');
    }
  });

  it('warns about duplicate claim IDs', () => {
    const body = mutate(golden.body, '- **C2** [measured]', '- **C1** [measured]');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('duplicate-claim-id');
  });

  it('warns when Reasoning cites an undefined claim in a step', () => {
    const body = mutate(golden.body, '(C5).\n', '(C99).\n');
    const result = lintReadingNote(body);
    const finding = result.findings.find((f) => f.code === 'undefined-claim-ref');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toContain('C99');
  });

  it('warns when a Mermaid edge label cites an undefined claim', () => {
    const body = mutate(golden.body, '(C2)"|', '(C42)"|');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('undefined-claim-ref');
  });

  it('understands claim lists and ranges in references', () => {
    const body = mutate(golden.body, '(C3, C4)', '(C3, C4, C77)');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('undefined-claim-ref');
    const ok = mutate(golden.body, '(C3, C4)', '(C1–C4)');
    expect(codes(lintReadingNote(ok).findings)).not.toContain('undefined-claim-ref');
  });

  it('does not treat unparenthesised chemistry-style tokens as claim references', () => {
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', 'Complement C9 and C57BL/6 mice matter. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(body).findings)).not.toContain('undefined-claim-ref');
  });

  it('warns when a claim cites an undefined evidence ID', () => {
    const body = mutate(figure.body, '(Fig 2B, E2)', '(Fig 2B, E9)');
    const result = lintReadingNote(body, { sources: figure.sources });
    expect(codes(result.findings, 'warn')).toContain('undefined-evidence-ref');
  });

  it('warns about duplicate evidence IDs', () => {
    const body = mutate(figure.body, '- **E3** (Fig 3A–C)', '- **E2** (Fig 3A–C)');
    const result = lintReadingNote(body, { sources: figure.sources });
    expect(codes(result.findings, 'warn')).toContain('duplicate-evidence-id');
  });

  it('reports an evidence ID that no claim cites as info only', () => {
    const body = mutate(figure.body, '- (Fig 1A–D) Volume', '- **E7** (Fig 1A–D) Volume');
    const result = lintReadingNote(body, { sources: figure.sources });
    expect(codes(result.findings, 'info')).toContain('orphan-evidence-id');
    expect(result.ok).toBe(true);
  });

  it('reports an evidence bullet without any locator as info', () => {
    const body = mutate(golden.body, ' (§Results 5)\n\n## Figure Map', '\n\n## Figure Map');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings, 'info')).toContain('evidence-no-locator');
  });

  it('flags a bare page locator as ambiguous but accepts PDF and printed pages', () => {
    const bare = mutate(golden.body, '(§Results 4)\n', '(p. 7)\n');
    expect(codes(lintReadingNote(bare).findings, 'info')).toContain('ambiguous-page-locator');
    for (const good of ['PDF p. 7', 'printed p. 7']) {
      const body = mutate(golden.body, '(§Results 4)\n', `(${good})\n`);
      expect(codes(lintReadingNote(body).findings), good).not.toContain('ambiguous-page-locator');
    }
  });

  it('reports line numbers relative to the body, starting at 1', () => {
    const body = mutate(golden.body, '- **C1** [measured] ', '- **C1** ');
    const lines = body.split('\n');
    const expectedLine = lines.findIndex((l) => l.startsWith('- **C1** IL-42')) + 1;
    const finding = lintReadingNote(body).findings.find((f) => f.code === 'claim-format');
    expect(finding?.line).toBe(expectedLine);
  });
});

describe('lintReadingNote — Mermaid and HTML', () => {
  it('warns about an unclosed fence', () => {
    const body = golden.body + '\n```mermaid\nflowchart TB\n  A["x"] --> B["y"]\n';
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('fence-unclosed');
  });

  it('warns about double-bracket link syntax inside a Mermaid block', () => {
    const body = mutate(golden.body, 'B["CD69 readout nearly unchanged"]', 'B[["CD69 readout nearly unchanged"]]');
    expect(codes(lintReadingNote(body).findings, 'warn')).toContain('mermaid-wikilink');
  });

  it('warns about HTML tags in prose but not inside inline code or Mermaid', () => {
    const prose = mutate(golden.body, 'In this assay, IL-42 lowered', 'IL-42<br>appears to weaken');
    expect(codes(lintReadingNote(prose).findings, 'warn')).toContain('html-tag');
    const inline = mutate(golden.body, 'In this assay, IL-42 lowered', 'The `<br>` tag is banned. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(inline).findings)).not.toContain('html-tag');
    const mermaid = mutate(golden.body, '"Fewer marker-positive cells"', '"Fewer<br/>marker-positive cells"');
    expect(codes(lintReadingNote(mermaid).findings)).not.toContain('html-tag');
  });

  it('flags real HTML tags such as sub and sup, but not math-like angle brackets', () => {
    const sub = mutate(golden.body, 'In this assay, IL-42 lowered', 'Amyloid-β<sub>1–40</sub> and Ca<sup>2+</sup> matter. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(sub).findings, 'warn')).toContain('html-tag');
    const math = mutate(golden.body, 'In this assay, IL-42 lowered', 'When x<y and z>w the order flips. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(math).findings)).not.toContain('html-tag');
  });

  it('does not treat HTML comments or autolinks as HTML tags', () => {
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', 'See <https://example.org/x> for details. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(body).findings)).not.toContain('html-tag');
  });

  it('suggests TB over LR as info only', () => {
    const body = mutate(golden.body, 'flowchart TB', 'flowchart LR');
    const result = lintReadingNote(body, { sources: golden.sources });
    expect(codes(result.findings, 'info')).toContain('mermaid-direction');
    expect(result.ok).toBe(true);
  });

  it('reports non-flowchart diagram types as info', () => {
    const body = mutate(golden.body, 'flowchart TB\n', 'sequenceDiagram\n  A->>B: hello\n%% ');
    expect(codes(lintReadingNote(body).findings, 'info')).toContain('mermaid-non-flowchart');
  });

  it('reports more than two diagrams as info', () => {
    const diagram = '\n```mermaid\nflowchart TB\n  A["x"] --> B["y"]\n```\n';
    const body = golden.body + diagram + diagram;
    expect(codes(lintReadingNote(body).findings, 'info')).toContain('too-many-diagrams');
  });

  it('reports a diagram with more than 12 nodes as info', () => {
    const edges = Array.from({ length: 13 }, (_, i) => `  N${i}["n${i}"] --> N${i + 1}["n${i + 1}"]`).join('\n');
    const body = golden.body + `\n\`\`\`mermaid\nflowchart TB\n${edges}\n\`\`\`\n`;
    expect(codes(lintReadingNote(body).findings, 'info')).toContain('mermaid-too-large');
  });

  it('counts nodes correctly for inhibition, circle, dotted-inhibition and bidirectional arrows', () => {
    const arrows = ['-->', '--x', '--o', '-.->', '-.-x', '-.-o', '<-->', '---', '==>'];
    const make = (n: number): string => {
      const edges = Array.from({ length: n - 1 }, (_, i) => `  N${i}["n${i}"] ${arrows[i % arrows.length]}|"label"| N${i + 1}["n${i + 1}"]`).join('\n');
      return golden.body + `\n\`\`\`mermaid\nflowchart TB\n${edges}\n\`\`\`\n`;
    };
    expect(codes(lintReadingNote(make(12)).findings)).not.toContain('mermaid-too-large');
    expect(codes(lintReadingNote(make(13)).findings)).toContain('mermaid-too-large');
  });

  it('accepts subgraphs, stadium and hexagon shapes, and quoted labels in an interaction diagram', () => {
    const diagram = [
      'flowchart TB',
      '  IL["IL-42"]',
      '  subgraph CD8["Activated CD8 T cell"]',
      '    GZB["Granzyme B"]',
      '  end',
      '  T(["T cell (CD8)"]) -->|"secretes (C1)"| IL',
      '  R{{"Receptor (not identified)"}} -.->|"inferred (C4)"| T',
      '  IL --x|"lowers (C1)"| GZB',
    ].join('\n');
    const body = golden.body + `\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
    const findings = lintReadingNote(body, { sources: golden.sources }).findings;
    expect(codes(findings)).not.toContain('mermaid-unquoted-label');
    expect(codes(findings)).not.toContain('mermaid-too-large');
    expect(codes(findings)).not.toContain('mermaid-wikilink');
  });

  it('reports unquoted stadium, round and hexagon labels with special characters as info', () => {
    for (const shape of ['T([T cell (CD8)])', 'T(T cell (CD8))', 'T{{T cell: CD8}}']) {
      const body = golden.body + `\n\`\`\`mermaid\nflowchart TB\n  ${shape} --> B["b"]\n\`\`\`\n`;
      expect(codes(lintReadingNote(body).findings, 'info'), shape).toContain('mermaid-unquoted-label');
    }
  });

  it('reports an unquoted label with special characters as info', () => {
    const body = mutate(golden.body, 'B["CD69 readout nearly unchanged"]', 'B[CD69 readout (nearly) unchanged]');
    expect(codes(lintReadingNote(body).findings, 'info')).toContain('mermaid-unquoted-label');
  });
});

describe('lintReadingNote — prose style (info only)', () => {
  const long26 = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ') + '.';
  const long25 = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ') + '.';

  it('reports a sentence longer than 25 words, but never a 25-word one', () => {
    const over = mutate(golden.body, 'In this assay, IL-42 lowered', `${long26} In this assay, IL-42 lowered`);
    const result = lintReadingNote(over, { sources: golden.sources });
    expect(codes(result.findings, 'info')).toContain('long-sentence');
    expect(result.ok).toBe(true);
    const exact = mutate(golden.body, 'In this assay, IL-42 lowered', `${long25} In this assay, IL-42 lowered`);
    expect(codes(lintReadingNote(exact).findings)).not.toContain('long-sentence');
  });

  it('does not count locator parentheticals toward sentence length', () => {
    const near = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${near} (Fig 1A–D, Fig 2A–D, Fig 3A–D, Fig 4A–D). In this assay, IL-42 lowered`);
    expect(codes(lintReadingNote(body).findings)).not.toContain('long-sentence');
  });

  it('skips table rows when measuring sentences', () => {
    const cell = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const body = mutate(golden.body, '<!-- No data figures found in compiled sources -->', `| Figure | Note |\n|---|---|\n| Fig 1 | ${cell} |`);
    expect(codes(lintReadingNote(body).findings)).not.toContain('long-sentence');
  });

  it('reports a paragraph with seven or more sentences as info', () => {
    const sentences = Array.from({ length: 7 }, (_, i) => `Sentence number ${i} stands alone here.`).join(' ');
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${sentences}\n\nIn this assay, IL-42 lowered`);
    expect(codes(lintReadingNote(body).findings, 'info')).toContain('long-paragraph');
  });

  it('reports a sentence that starts with a bare pronoun verb, not a demonstrative plus noun', () => {
    const bare = mutate(golden.body, 'In this assay, IL-42 lowered', 'It shows a drop. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(bare).findings, 'info')).toContain('leading-pronoun');
    const withNoun = mutate(golden.body, 'In this assay, IL-42 lowered', 'This pathway shows a drop. In this assay, IL-42 lowered');
    expect(codes(lintReadingNote(withNoun).findings)).not.toContain('leading-pronoun');
  });

  it('caps repeated findings of one code and summarises the rest', () => {
    const many = Array.from({ length: 20 }, () => `${long26}`).join('\n\n');
    const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${many}\n\nIn this assay, IL-42 lowered`);
    const longFindings = lintReadingNote(body).findings.filter((f) => f.code === 'long-sentence');
    expect(longFindings.length).toBeLessThanOrEqual(9);
    expect(longFindings[longFindings.length - 1].message).toMatch(/\+\d+ more/);
  });
});

describe('lintReadingNote — Figure Map size', () => {
  function figureMapRows(n: number): string {
    const rows = Array.from({ length: n }, (_, i) => `| Fig ${i + 1} | Shows panel ${i + 1}. | Supports claim. |`).join('\n');
    return `| Figure | What it shows | Significance |\n|---|---|---|\n${rows}`;
  }

  it('suggests ### subsections for more than 40 rows, without truncating', () => {
    const body = mutate(golden.body, '<!-- No data figures found in compiled sources -->', figureMapRows(45));
    const finding = lintReadingNote(body, { sources: golden.sources }).findings.find((f) => f.code === 'figure-map-long');
    expect(finding?.severity).toBe('info');
    expect(finding?.fix).toMatch(/###/);
  });

  it('does not flag a long Figure Map that is already split under ### subsections', () => {
    const split = `### Main figures\n\n${figureMapRows(25)}\n\n### Supplementary\n\n${figureMapRows(25)}`;
    const body = mutate(golden.body, '<!-- No data figures found in compiled sources -->', split);
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings)).not.toContain('figure-map-long');
  });

  it('reports a Figure Map cell longer than 30 words as info', () => {
    const cell = Array.from({ length: 31 }, (_, i) => `w${i}`).join(' ');
    const table = `| Figure | What it shows | Significance |\n|---|---|---|\n| Fig 1 | ${cell} | Short. |`;
    const body = mutate(golden.body, '<!-- No data figures found in compiled sources -->', table);
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings, 'info')).toContain('figure-map-cell-long');
  });

  it('reports figure map row counts in stats', () => {
    const body = mutate(golden.body, '<!-- No data figures found in compiled sources -->', figureMapRows(12));
    expect(lintReadingNote(body).stats.figureMapRows).toBe(12);
  });
});

describe('lintReadingNote — review round 2 regressions', () => {
  const withClaims = (claims: string): string => {
    const start = golden.body.indexOf('## Claims\n') + '## Claims\n'.length;
    return golden.body.slice(0, start) + claims + golden.body.slice(golden.body.indexOf('## Reasoning'));
  };

  it('warns when a nested list item or an indented table sits under a claim', () => {
    const nested = withClaims('\n- **C1** [measured] Real claim. (§Results 1)\n  - This second claim has no ID or locator.\n\n');
    expect(codes(lintReadingNote(nested, { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
    const table = withClaims('\n- **C1** [measured] Real claim. (§Results 1)\n  | a | b |\n  |---|---|\n\n');
    expect(codes(lintReadingNote(table, { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
    const quote = withClaims('\n- **C1** [measured] Real claim. (§Results 1)\n  > a hidden second claim\n\n');
    expect(codes(lintReadingNote(quote, { sources: golden.sources }).findings, 'warn')).toContain('claim-format');
  });

  it('reads a Source filename with spaces, backticks or quotes in full', () => {
    for (const written of ['main paper.pdf', '`main paper.pdf`', '"main paper.pdf"']) {
      const body = mutate(golden.body, '**Source:** paper.md', `**Source:** ${written}`);
      const result = lintReadingNote(body, { sources: ['main paper.pdf'] });
      expect(codes(result.findings), written).not.toContain('source-not-registered');
    }
    const body = mutate(golden.body, '**Source:** paper.md', '**Source:** main paper.pdf');
    expect(codes(lintReadingNote(body, { sources: ['paper.md'] }).findings, 'warn')).toContain('source-not-registered');
  });

  it('keeps scanning visible text that follows the end of a multi-line HTML comment', () => {
    const body = mutate(golden.body, 'The authors first separate early activation', '<!--\nhidden\n--> See (C99). The authors first separate early activation');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings, 'warn')).toContain('undefined-claim-ref');
  });

  it('does not treat a Mermaid %% comment as a claim reference', () => {
    const body = mutate(golden.body, '  IL --x|"lowers the fraction (C1)"| GZB\n', '  %% example (C99)\n  IL --x|"lowers the fraction (C1)"| GZB\n');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings)).not.toContain('undefined-claim-ref');
  });

  it('flags common block and list HTML such as dl, details and b, but still not math-like angle brackets', () => {
    for (const html of ['<dl><dt>Term</dt><dd>Definition</dd></dl>', '<details><summary>More</summary>text</details>', '<b>bold</b>', '<section class="x">y</section>']) {
      const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${html} In this assay, IL-42 lowered`);
      expect(codes(lintReadingNote(body).findings, 'warn'), html).toContain('html-tag');
    }
    for (const prose of ['when a<b and c>d holds', 'when x<y and z>w holds', 'P<0.05 and n>3']) {
      const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${prose}. In this assay, IL-42 lowered`);
      expect(codes(lintReadingNote(body).findings), prose).not.toContain('html-tag');
    }
  });

  it('counts nodes whose IDs end in x or o correctly (they are not part of an x--x or o--o operator)', () => {
    const make = (n: number, arrow: string): string => {
      const edges = Array.from({ length: n - 1 }, (_, i) => `  N${i}x${arrow} N${i + 1}x`).join('\n'); // no space before the operator: the form that used to lose the ID's last letter
      return golden.body + `\n\`\`\`mermaid\nflowchart TB\n${edges}\n\`\`\`\n`;
    };
    for (const arrow of ['-->', '--x', '--o']) {
      expect(codes(lintReadingNote(make(12, arrow)).findings), `12 nodes ${arrow}`).not.toContain('mermaid-too-large');
      expect(codes(lintReadingNote(make(13, arrow)).findings), `13 nodes ${arrow}`).toContain('mermaid-too-large');
    }
    const spaced = golden.body + '\n```mermaid\nflowchart TB\n  A x--x B\n  C o--o D\n```\n';
    expect(codes(lintReadingNote(spaced).findings)).not.toContain('mermaid-too-large');
  });

  it('inspects every edge label on a line and inline "-- text -->" labels, not just the first', () => {
    const chained = golden.body + '\n```mermaid\nflowchart TB\n  A[Good] -->|plain| B[Good] -->|bad (C1)| C[Good]\n```\n';
    expect(codes(lintReadingNote(chained).findings, 'info')).toContain('mermaid-unquoted-label');
    const inline = golden.body + '\n```mermaid\nflowchart TB\n  A -- bad (C1) --> B\n```\n';
    expect(codes(lintReadingNote(inline).findings, 'info')).toContain('mermaid-unquoted-label');
  });
});

describe('lintReadingNote — review round 3 regressions', () => {
  const inMermaid = (lines: string[]): string => golden.body + `\n\`\`\`mermaid\nflowchart TB\n${lines.join('\n')}\n\`\`\`\n`;
  const withClaim = (claim: string): string => {
    const start = golden.body.indexOf('## Claims\n') + '## Claims\n'.length;
    return golden.body.slice(0, start) + `\n${claim}\n` + golden.body.slice(golden.body.indexOf('\n- **C2**'));
  };
  const timeIt = (body: string): number => {
    const started = performance.now();
    lintReadingNote(body, { sources: golden.sources });
    return performance.now() - started;
  };

  it('does not stall on whitespace-heavy lines (inline edge label scan, HTML, claims, labels)', () => {
    const spaces = ' '.repeat(3200);
    const payloads = [
      inMermaid([`A --${spaces}X`]),
      inMermaid([`A -- ${spaces}X`]),
      inMermaid([`A -- ${spaces} --> B`]),
      inMermaid([`A -- ${'x '.repeat(1600)}`]),
      mutate(golden.body, 'In this assay, IL-42 lowered', `<div ${spaces}x In this assay, IL-42 lowered`),
      mutate(golden.body, 'In this assay, IL-42 lowered', `${'<div '.repeat(800)} In this assay, IL-42 lowered`),
      withClaim(`- **C1** [measured] ${spaces}claim text. (Fig 1A)`),
      mutate(golden.body, '> **Source:** paper.md', `> **Source:** ${spaces}paper.md`),
    ];
    for (const [i, body] of payloads.entries()) expect(timeIt(body), `payload ${i}`).toBeLessThan(500);
  });

  it('requires a value for every TL;DR field and stops reading Source at the next field', () => {
    const emptySource = mutate(golden.body, '> **Source:** paper.md', '> **Source:**\n> **Found:** The tracer reached tissue.');
    expect(codes(lintReadingNote(emptySource, { sources: golden.sources }).findings, 'warn')).toContain('tldr-no-source');
    for (const field of ['Did', 'Found', 'Trust', 'Why it matters here']) {
      const body = golden.body.replace(new RegExp(`^> \\*\\*${field}:\\*\\*.*$`, 'm'), `> **${field}:**`);
      expect(body, field).not.toBe(golden.body);
      const finding = lintReadingNote(body, { sources: golden.sources }).findings.find((f) => f.code === 'tldr-missing-field');
      expect(finding?.severity, field).toBe('warn');
      expect(finding?.message, field).toContain(field);
    }
  });

  it('keeps an exactly registered filename even when it starts or ends with quote-like characters', () => {
    for (const name of ["'Authors'.pdf", '"Quoted".pdf', '`tick`.pdf']) {
      const body = mutate(golden.body, '**Source:** paper.md', `**Source:** ${name}`);
      expect(codes(lintReadingNote(body, { sources: [name] }).findings), name).not.toContain('source-not-registered');
    }
  });

  it('does not read comparisons like "t<time and n>3" as HTML, but still flags real tags', () => {
    for (const prose of ['The effect occurred when t<time and n>3', 'when n<data and m>2 held', 'if x<label and y>z']) {
      const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${prose}. In this assay, IL-42 lowered`);
      expect(codes(lintReadingNote(body).findings), prose).not.toContain('html-tag');
    }
    for (const html of ['line one<br />line two', '<time datetime="2026-01-01">x</time>', '<dl><dt>a</dt></dl>', '<b>bold</b>']) {
      const body = mutate(golden.body, 'In this assay, IL-42 lowered', `${html} In this assay, IL-42 lowered`);
      expect(codes(lintReadingNote(body).findings, 'warn'), html).toContain('html-tag');
    }
  });

  it('reads references everywhere, and a scientific symbol escapes by backticks or by spelling it out', () => {
    const where = (extra: string): string => mutate(golden.body, 'In this assay, IL-42 lowered', `${extra} In this assay, IL-42 lowered`);
    // genuine undefined references are caught wherever they sit
    expect(codes(lintReadingNote(where('The result supports the inference (C99).'), { sources: golden.sources }).findings, 'warn')).toContain('undefined-claim-ref');
    expect(codes(lintReadingNote(withClaim('- **C1** [measured] Tracer moved as predicted (C99). (Fig 1A)'), { sources: golden.sources }).findings, 'warn')).toContain('undefined-claim-ref');
    const diagramInTakeaways = golden.body.replace('## Extensions', '```mermaid\nflowchart TB\n  A["x"] -->|"prediction (C99)"| B["y"]\n```\n\n## Extensions');
    expect(codes(lintReadingNote(diagramInTakeaways, { sources: golden.sources }).findings, 'warn')).toContain('undefined-claim-ref');
    expect(codes(lintReadingNote(withClaim('- **C1** [measured] Tracer spread (Fig 1A, E9), and cortex signal increased. (Table 2)'), { sources: golden.sources }).findings, 'warn')).toContain('undefined-evidence-ref');
    // the warning tells the author how to escape a scientific symbol
    const finding = lintReadingNote(where('Complement (C9) rose.'), { sources: golden.sources }).findings.find((f) => f.code === 'undefined-claim-ref');
    expect(finding?.fix).toMatch(/backtick/i);
    // escapes: inline code, or no parentheses
    for (const claim of [
      '- **C1** [measured] Complement component 3 (`C3`) increased in mouse serum. (Fig 1A)',
      '- **C1** [measured] Complement C3 increased in mouse serum. (Fig 1A)',
      '- **C1** [measured] The E3 ubiquitin ligase (`E3`) was recruited. (Fig 1A)',
      '- **C1** [measured] The figure shows recruitment. (Fig 1A) The E3 ligase (`E3`) participates.',
    ]) {
      const codesFound = codes(lintReadingNote(withClaim(claim), { sources: golden.sources }).findings);
      expect(codesFound, claim).not.toContain('undefined-claim-ref');
      expect(codesFound, claim).not.toContain('undefined-evidence-ref');
    }
    const escaped = where('Complement (`C9`) and the E3 ligase (`E7`) are unrelated.');
    expect(codes(lintReadingNote(escaped, { sources: golden.sources }).findings)).not.toContain('undefined-claim-ref');
  });

  it('does not give label advice for Mermaid comment lines', () => {
    const body = inMermaid(['%% Example A[kinase (C99)]', '  A["signal"] --> B["output"]']);
    expect(codes(lintReadingNote(body).findings)).not.toContain('mermaid-unquoted-label');
  });

  it('does not count inline edge-label text as nodes', () => {
    const make = (n: number): string => inMermaid(Array.from({ length: n - 1 }, (_, i) => `  N${i} -- signal${i} --> N${i + 1}`));
    expect(codes(lintReadingNote(make(12)).findings)).not.toContain('mermaid-too-large');
    expect(codes(lintReadingNote(make(13)).findings)).toContain('mermaid-too-large');
  });

  it('the golden example keeps the measured CD69 readout separate from the inferred activation reading', () => {
    expect(golden.body).not.toMatch(/\*\*C2\*\* \[measured\][^\n]*so early activation/);
    expect(golden.body).not.toMatch(/observed: CD69 unchanged/);
  });
});

describe('lintReadingNote — review round 4 regressions', () => {
  const inMermaid = (lines: string[]): string => golden.body + `\n\`\`\`mermaid\nflowchart TB\n${lines.join('\n')}\n\`\`\`\n`;
  const timeIt = (body: string): number => {
    const started = performance.now();
    lintReadingNote(body, { sources: golden.sources });
    return performance.now() - started;
  };

  it('stays fast on long attribute-like HTML runs and on thousands of inline edge labels on one line', () => {
    const html = mutate(golden.body, 'In this assay, IL-42 lowered', `<div x=${' '.repeat(51200)}X In this assay, IL-42 lowered`);
    expect(timeIt(html)).toBeLessThan(150);
    const manyLabels = inMermaid([Array.from({ length: 3200 }, (_, i) => `N${i} -- label --> N${i + 1}`).join('; ')]);
    expect(timeIt(manyLabels)).toBeLessThan(150);
    const manyDotted = inMermaid([Array.from({ length: 3200 }, (_, i) => `N${i} -. label .-> N${i + 1}`).join('; ')]);
    expect(timeIt(manyDotted)).toBeLessThan(150);
  });

  it('keeps a plain "Source:" field on its own line', () => {
    const body = mutate(golden.body, '> **Source:** paper.md', '> Source:\n> **Found:** The tracer reached tissue.');
    expect(codes(lintReadingNote(body, { sources: golden.sources }).findings, 'warn')).toContain('tldr-no-source');
    const filled = mutate(golden.body, '> **Source:** paper.md', '> Source: paper.md');
    expect(codes(lintReadingNote(filled, { sources: golden.sources }).findings)).not.toContain('tldr-no-source');
  });

  it('removes only a matching outer wrapper from a Source filename, keeping literal punctuation', () => {
    const cases: Array<[written: string, registered: string]> = [
      ["`'Authors'.pdf`", "'Authors'.pdf"],
      ['"\'Authors\'.pdf"', "'Authors'.pdf"],
      ['`"Quoted".pdf`', '"Quoted".pdf'],
      ["'Authors'.pdf", "'Authors'.pdf"],
      ['`paper.pdf`', 'paper.pdf'],
    ];
    for (const [written, registered] of cases) {
      const body = mutate(golden.body, '**Source:** paper.md', `**Source:** ${written}`);
      expect(codes(lintReadingNote(body, { sources: [registered] }).findings), written).not.toContain('source-not-registered');
    }
  });

  it('counts the targets of dotted inline edges', () => {
    const make = (n: number): string => inMermaid([`  N0 ${Array.from({ length: n - 1 }, (_, i) => `-. signal${i} .-> N${i + 1}`).join(' ')}`]);
    expect(codes(lintReadingNote(make(12)).findings)).not.toContain('mermaid-too-large');
    expect(codes(lintReadingNote(make(13)).findings)).toContain('mermaid-too-large');
  });

  it('the golden example does not say more than its readouts show', () => {
    expect(golden.body).not.toMatch(/does not stop the cells from switching on/);
    expect(golden.body).not.toMatch(/observed: granzyme B and IFN-gamma fall/);
  });
});
