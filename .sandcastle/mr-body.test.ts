// Tests for the Draft-MR title/description renderer.
//
// Covers the pure surface main.ts consumes at publish time: the issue-closure
// decision (issue #27 — close on the default branch, say why not on any other
// base) and its place in the assembled description. Pure: no network, no CLI,
// no process.env.
//
// How a human checks issue #27 by hand, since the decision only becomes visible at
// publish time:
//   1. `npx tsx .sandcastle/mr-body.test.ts` → attendu : "… passed, 0 failed".
//   2. `SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts` → attendu : `bases` lists the
//      configured trunk, i.e. the value main.ts feeds as `defaultBranch`.
//   3. The rendered proof is the next Draft PR: a body targeting the trunk carries the
//      bare `Closes #n` line under the identity table; one targeting a
//      `sandcastle/…` or staging base carries « **Fermeture de l’issue** … ne fermera
//      **pas** #n » and no keyword at all.
// Run: npx tsx .sandcastle/mr-body.test.ts
import assert from 'node:assert/strict';
import {
  decideIssueClosure,
  buildMrDescription,
  type MrBodyInput,
} from './mr-body.ts';
import { test, finish } from './test-harness.ts';

// The host-recognized closing keywords, a CLOSED list (close/closes/closed,
// fix/fixes/fixed, resolve/resolves/resolved) with no translatable equivalent —
// the fact issue #27 turns into the "never translate the keyword" rule. A French
// « Ferme #5 » creates the cross-link but closes nothing.
const KEYWORDS = [
  'close', 'closes', 'closed',
  'fix', 'fixes', 'fixed',
  'resolve', 'resolves', 'resolved',
];

/** Every keyword of the closed list that appears ANYWHERE followed by an issue ref —
 *  the host parses the whole body, not just line starts, so « … qui fixes #12 » counts
 *  exactly as much as a keyword opening a line. */
const keywordsIn = (text: string): string[] =>
  KEYWORDS.filter((keyword) => new RegExp(`\\b${keyword}\\b\\s+#\\d+`, 'i').test(text));

// --- decideIssueClosure ----------------------------------------------------

test('base = default branch → the MR closes its issue, with a recognized keyword', () => {
  const d = decideIssueClosure('main', 'main', 27);
  assert.equal(d.closes, true);
  assert.match(d.line, /^Closes #27\b/);
  assert.deepEqual(keywordsIn(d.line), ['closes']);
});

test('base ≠ default (staging) → no closure; the note names the base, the issue, the default branch and who owns closure', () => {
  const d = decideIssueClosure('staging/v1', 'main', 17);
  assert.equal(d.closes, false);
  assert.ok(d.line.includes('`staging/v1`'), 'names the targeted base');
  assert.ok(d.line.includes('#17'), 'names the issue');
  assert.ok(d.line.includes('`main`'), 'names the default branch');
  assert.ok(d.line.includes('`staging/v1 → main`'), 'says closure falls to the base→default MR');
  assert.ok(d.line.includes('à la main'), 'says closure can be done by hand');
});

test('a stacked base (chained stage) is not the default branch either → no closure', () => {
  const d = decideIssueClosure('sandcastle/issue-26-r3', 'main', 27);
  assert.equal(d.closes, false);
  assert.ok(d.line.includes('`sandcastle/issue-26-r3`'));
  assert.ok(d.line.includes('#27'));
});

test('the keyword is never translated — the note carries none of the closed list', () => {
  const closing = decideIssueClosure('main', 'main', 27).line;
  const note = decideIssueClosure('staging/v1', 'main', 27).line;
  assert.deepEqual(keywordsIn(closing), ['closes']);
  assert.deepEqual(keywordsIn(note), []);
  // The detector itself must see a keyword buried mid-sentence, or the assertion
  // above would be vacuous — that is how the host reads a body.
  assert.deepEqual(keywordsIn('une phrase qui fixes #12 au passage'), ['fixes']);
  // …and a French « Ferme #5 » is precisely what it must NOT count as a closure.
  assert.deepEqual(keywordsIn('Ferme #5'), []);
});

test('a stray space around either name does not read as a different branch', () => {
  assert.equal(decideIssueClosure(' main', 'main\n', 27).closes, true);
  assert.equal(decideIssueClosure('main', 'develop', 27).closes, false);
});

// Neither answer is honest when the trunk is unknown, and two blank strings compare
// equal — so the guard must not let that equality become a `Closes` the merge ignores.
test('an unknown trunk degrades to "no keyword, close by hand" instead of a false promise', () => {
  for (const [base, trunk] of [
    ['', ''],
    ['main', ''],
    ['main', undefined as unknown as string],
    ['', 'main'],
  ] as const) {
    const d = decideIssueClosure(base, trunk, 27);
    assert.equal(d.closes, false, `blank pair ${JSON.stringify([base, trunk])} must not claim closure`);
    assert.deepEqual(keywordsIn(d.line), [], 'no keyword the host could act on');
    assert.ok(d.line.includes('#27'), 'still names the issue');
    assert.ok(d.line.includes('à la main'), 'still says who owns the closing');
    assert.ok(!d.line.includes('undefined'), 'never renders a bogus branch name');
  }
});

// --- buildMrDescription: the closure line in the assembled body -------------

const ISSUE_27 = {
  number: 27,
  title: 'Le corps de MR dit s’il ferme l’issue, et pourquoi il ne la ferme pas',
  url: 'https://github.com/softnextapp/software-factory/issues/27',
  labels: ['enhancement', 'ready-for-agent'],
};

/** A minimal valid MrBodyInput; every case overrides just what it exercises. */
const input = (over: Partial<MrBodyInput> = {}): MrBodyInput => ({
  issue: ISSUE_27,
  branch: 'sandcastle/issue-27-mr-body-closure-r1',
  base: 'main',
  defaultBranch: 'main',
  summary: null,
  review: { reviewed: false },
  commits: [{ sha: 'a1b2c3d', subject: 'feat(chain): add the closure decision (#27)' }],
  diffstat: {
    files: [{ path: '.sandcastle/mr-body.ts', added: 48, removed: 1 }],
    omitted: 0,
    insertions: 48,
    deletions: 1,
  },
  run: {
    profile: 'split',
    implementerModel: 'glm-5.3[1m]',
    reviewerModel: 'claude-opus-5',
    round: 1,
  },
  ...over,
});

// --- buildMrDescription: the report section ---------------------------------
//
// renderReport is tested on its own in report.test.ts; what is only decidable HERE
// is that the assembled body distinguishes the two absences and puts the link above
// the authored sections. A phase that is OFF must render nothing at all — otherwise a
// consumer with no report skill reads a body claiming a report went missing.

test('a body with no report phase says nothing about a report at all', () => {
  const body = buildMrDescription(input());
  assert.ok(!body.includes('Rapport de revue'), body);
});

test('a report that failed says so in the body — the two absences are not the same absence', () => {
  const body = buildMrDescription(
    input({ report: { kind: 'failed', skill: 'explain-diff', reason: 'la skill est muette' } }),
  );
  assert.ok(body.includes('Rapport de revue'), body);
  assert.ok(body.includes('la skill est muette'), body);
});

test('a published report rides above the authored sections — it is what a reviewer can read first', () => {
  const url = 'https://revue.exemple.fr/r/x';
  const body = buildMrDescription(
    input({
      report: { kind: 'published', skill: 'explain-diff', url },
      summary: { why: 'parce que' },
    }),
  );
  assert.ok(body.includes(url), body);
  assert.ok(body.indexOf(url) < body.indexOf('## Pourquoi'), body);
});

test('a body targeting the default branch carries the closure keyword right under the header', () => {
  const body = buildMrDescription(input());
  // The keyword line must be there verbatim — it is what the host parses at merge.
  assert.ok(body.includes(decideIssueClosure('main', 'main', 27).line));
  // High in the body, directly after the identity table, so the reviewer reads
  // "what happens to the issue" before anything authored.
  assert.ok(body.indexOf('Closes #27') < body.indexOf('## Comment tester'));
});

test('a body targeting another base carries the why-not note and NO closing keyword anywhere', () => {
  const body = buildMrDescription(input({ base: 'staging/v1' }));
  assert.ok(body.includes(decideIssueClosure('staging/v1', 'main', 27).line));
  assert.deepEqual(keywordsIn(body), []);
});

test('the closure line is host-derived: it renders even with no agent summary at all', () => {
  const body = buildMrDescription(input({ base: 'staging/v1', summary: null }));
  assert.ok(body.includes('elle ne fermera **pas** #27'));
});

// The guarantee is scoped to the DERIVED line. Authored prose is rendered verbatim,
// so a summary of its own can still hand the host a keyword — pinned here so the
// boundary is a known property of the renderer, not a surprise found in production.
test('the derived note stands even when authored prose carries a keyword of its own', () => {
  const body = buildMrDescription(
    input({ base: 'staging/v1', summary: { why: 'This fixes #12 in passing' } }),
  );
  assert.ok(body.includes(decideIssueClosure('staging/v1', 'main', 27).line), 'note intact');
  assert.deepEqual(keywordsIn(body), ['fixes'], 'the keyword comes from the summary, not from us');
  assert.ok(!/\bcloses\b\s+#27/i.test(body), 'nothing claims to close the carried issue');
});

test('a body built with no usable trunk says so instead of promising a closure', () => {
  const body = buildMrDescription(input({ defaultBranch: '' }));
  assert.deepEqual(keywordsIn(body), []);
  assert.ok(body.includes('#27'));
});

test('on a stacked base the closure note sits right after the header, before the stack note', () => {
  const body = buildMrDescription(input({ base: 'sandcastle/issue-26-r3' }));
  const closureAt = body.indexOf('**Fermeture de l’issue**');
  const stackAt = body.indexOf('MR empilée');
  assert.ok(closureAt !== -1, 'closure note present');
  assert.ok(stackAt !== -1, 'stack note present');
  assert.ok(closureAt < stackAt, 'closure read before the merge-order advice');
});

finish();
