// Contract tests for the post-MR report phase (report.ts).
//
// What is worth testing here is not "does the skill write a good report" — no
// unit test reaches that. It is the boundary: what the orchestration accepts as
// a report, what it refuses, and whether a refusal is ever silent. The phase
// runs unattended, between a push and an MR creation; every one of its failure
// modes ends with a human reading an MR body and needing to know what happened.
import assert from 'node:assert/strict';
import {
  classifyReport,
  isReviewableUrl,
  renderReport,
  reportCrashed,
  reportPromptArgs,
  shouldRunReport,
  type ReportConfig,
} from './report.ts';
import { test, finish } from './test-harness.ts';

const SKILL = 'explain-diff';
const URL_OK = 'https://revue.exemple.fr/r/un-compte-qui-nouvre-rien';

const CONFIG: ReportConfig = {
  skill: SKILL,
  promptFile: './.sandcastle/report-prompt.md',
  role: 'reviewer',
  mounts: [],
  env: {},
  idleTimeoutSeconds: 1800,
};

// --- isReviewableUrl ---------------------------------------------------------

test('isReviewableUrl: an https url on a real host is reviewable', () => {
  assert.equal(isReviewableUrl(URL_OK), true);
  assert.equal(isReviewableUrl('http://203.0.113.9:8080/r/x'), true);
});

test('isReviewableUrl: a path is not a url — the skill returns the url, not the path', () => {
  assert.equal(isReviewableUrl('/r/un-compte-qui-nouvre-rien'), false);
  assert.equal(isReviewableUrl('~/.revue/travail/x/doc.json'), false);
  assert.equal(isReviewableUrl('r/x'), false);
});

test('isReviewableUrl: loopback is refused — pasting it into an MR is the confusion, not the fix', () => {
  assert.equal(isReviewableUrl('http://127.0.0.1:8766/r/x'), false);
  assert.equal(isReviewableUrl('http://localhost:8766/r/x'), false);
  assert.equal(isReviewableUrl('http://0.0.0.0:8766/r/x'), false);
});

test('isReviewableUrl: IPv6 loopback is refused too — Node renders the hostname bracketed', () => {
  // `parsed.hostname` is `[::1]`, never `::1`. A bare comparison passes silently,
  // and the refusal holds on IPv4 only — which is the half that gets tested by hand.
  assert.equal(isReviewableUrl('http://[::1]:8766/r/x'), false);
  assert.equal(isReviewableUrl('http://[::ffff:127.0.0.1]:8766/r/x'), false);
  assert.equal(isReviewableUrl('http://[::]:8766/r/x'), false);
});

test('isReviewableUrl: credentials in the url are refused — an MR body keeps them forever', () => {
  assert.equal(isReviewableUrl('https://jeton:secret@revue.exemple.fr/r/x'), false);
  assert.equal(isReviewableUrl('https://jeton@revue.exemple.fr/r/x'), false);
});

test('isReviewableUrl: a non-web scheme is refused', () => {
  assert.equal(isReviewableUrl('file:///home/agent/rapport.html'), false);
  assert.equal(isReviewableUrl('ftp://example.com/x'), false);
});

// --- classifyReport ----------------------------------------------------------

test('classifyReport: a marked url is published', () => {
  const out = classifyReport(SKILL, `blah blah\n<report>${URL_OK}</report>\ndone`);
  assert.deepEqual(out, { kind: 'published', skill: SKILL, url: URL_OK });
});

test('classifyReport: whitespace inside the marker does not defeat it', () => {
  const out = classifyReport(SKILL, `<report>\n  ${URL_OK}\n</report>`);
  assert.equal(out.kind, 'published');
});

test('classifyReport: an unmarked url in chatter is NOT taken as the report', () => {
  // The whole reason the marker exists: the agent linking the issue, the docs,
  // or the repo must not be mistaken for its own output.
  const out = classifyReport(SKILL, `see https://github.com/org/repo/issues/26 for context`);
  assert.equal(out.kind, 'failed');
  assert.match((out as { reason: string }).reason, /aucun bloc/);
});

test('classifyReport: the LAST block wins — an agent that retries printed the earlier try too', () => {
  const out = classifyReport(
    SKILL,
    `<report>oops</report>\nretrying\n<report>${URL_OK}</report>`,
  );
  assert.deepEqual(out, { kind: 'published', skill: SKILL, url: URL_OK });
});

test('classifyReport: a marked non-url fails, and the reason quotes what was said instead', () => {
  const out = classifyReport(SKILL, '<report>/home/agent/rapport.json</report>');
  assert.equal(out.kind, 'failed');
  assert.match((out as { reason: string }).reason, /rapport\.json/);
});

test('classifyReport: an empty marker fails distinctly from a missing one', () => {
  const empty = classifyReport(SKILL, '<report></report>');
  const missing = classifyReport(SKILL, 'nothing at all');
  assert.equal(empty.kind, 'failed');
  assert.equal(missing.kind, 'failed');
  assert.notEqual((empty as { reason: string }).reason, (missing as { reason: string }).reason);
});

test('classifyReport: a replay command with no url is the degraded path, not a plain failure', () => {
  // This is the platform's AFK degradation surfacing in the MR: the VPS was
  // unreachable, the report exists in a local package, and the reviewer is
  // handed the one command that finishes the job.
  const replay = 'revue publier --depuis /srv/revue-paquets/mr26-afk';
  const out = classifyReport(SKILL, `<report-replay>${replay}</report-replay>`);
  assert.equal(out.kind, 'degraded');
  assert.equal((out as { replay: string }).replay, replay);
});

test('classifyReport: a replay command wins over a marker that holds a non-url', () => {
  const replay = 'revue publier --depuis /srv/p/x';
  const out = classifyReport(
    SKILL,
    `<report>échec</report>\n<report-replay>${replay}</report-replay>`,
  );
  assert.equal(out.kind, 'degraded');
  assert.match((out as { reason: string }).reason, /échec/);
});

test('classifyReport: a real url wins over a stale replay command', () => {
  // Publishing succeeded on a retry; the package is moot. Reporting "degraded"
  // would send the reviewer to run a command that republishes for nothing.
  const out = classifyReport(
    SKILL,
    `<report-replay>revue publier --depuis /srv/p/x</report-replay>\n<report>${URL_OK}</report>`,
  );
  assert.equal(out.kind, 'published');
});

test('classifyReport never returns null — a broken phase must not look like a disabled one', () => {
  for (const stdout of ['', '   ', 'Traceback (most recent call last):', '<report>']) {
    const out = classifyReport(SKILL, stdout);
    assert.ok(out.kind === 'failed' || out.kind === 'degraded', `stdout ${JSON.stringify(stdout)}`);
  }
});

// --- reportCrashed -----------------------------------------------------------

test('reportCrashed: a thrown sandbox error becomes a stated failure, never a lost MR', () => {
  const out = reportCrashed(SKILL, new Error('docker: mount source does not exist'));
  assert.equal(out.kind, 'failed');
  assert.match((out as { reason: string }).reason, /mount source/);
});

test('reportCrashed: a non-Error rejection is still stated', () => {
  const out = reportCrashed(SKILL, 'idle timeout');
  assert.equal((out as { reason: string }).reason, 'idle timeout');
});

// --- shouldRunReport ---------------------------------------------------------

test('shouldRunReport: off by default — no config, no phase (ADR-0004)', () => {
  assert.equal(shouldRunReport(null, 12), false);
});

test('shouldRunReport: an empty branch gets no report — a sandbox to explain nothing', () => {
  assert.equal(shouldRunReport(CONFIG, 0), false);
  assert.equal(shouldRunReport(CONFIG, 1), true);
});

// --- renderReport ------------------------------------------------------------

test('renderReport: a disabled phase renders nothing at all', () => {
  assert.equal(renderReport(null), null);
});

test('renderReport: a published report renders a clickable link naming its skill', () => {
  const md = renderReport({ kind: 'published', skill: SKILL, url: URL_OK })!;
  assert.match(md, /## Rapport de revue/);
  assert.ok(md.includes(`(<${URL_OK}>)`), md);
  assert.ok(md.includes(SKILL), md);
});

test('renderReport: a failure is stated in the body — an absence is never mute', () => {
  const md = renderReport({ kind: 'failed', skill: SKILL, reason: 'bloc vide' })!;
  assert.match(md, /Aucun rapport/);
  assert.match(md, /bloc vide/);
  // And it must reassure: the MR is open regardless.
  assert.match(md, /ouverte quand même/);
});

test('renderReport: a degraded report hands over the replay command, in a code fence', () => {
  const replay = 'revue publier --depuis /srv/revue-paquets/mr26-afk';
  const md = renderReport({
    kind: 'degraded',
    skill: SKILL,
    reason: "la publication n'a pas abouti",
    replay,
  })!;
  assert.match(md, /```sh\n/);
  assert.ok(md.includes(replay), md);
  assert.match(md, /n'est pas perdu/);
});

// --- reportPromptArgs --------------------------------------------------------

test('reportPromptArgs: the markers the prompt must use come from the module that parses them', () => {
  // One source for the contract. Two spellings of a marker is a phase that
  // silently never reports — green run, empty MR section, nobody notices.
  const args = reportPromptArgs({
    issueNumber: 26,
    issueTitle: 'Dégradation AFK',
    branch: 'sandcastle/issue-26-r1',
    base: 'main',
    changedLines: 1505,
    skill: SKILL,
    mrNumber: 118,
    mrUrl: 'https://github.com/o/r/pull/118',
  });
  const round = classifyReport(
    SKILL,
    `${args.REPORT_OPEN}${URL_OK}${args.REPORT_CLOSE}`,
  );
  assert.equal(round.kind, 'published');
  assert.equal(args.CHANGED_LINES, '1505');
  assert.equal(args.BRANCH, 'sandcastle/issue-26-r1');
  assert.equal(args.REPORT_SKILL, SKILL);
});

test('renderReport: a url carrying a paren cannot spill out of the markdown link', () => {
  // `new URL` accepts a trailing `)`; an unwrapped `](url)` would close early and
  // dump the remainder into the MR body.
  const section = renderReport({
    kind: 'published',
    skill: SKILL,
    url: 'https://revue.exemple.fr/r/x)y',
  });
  assert.ok(section !== null);
  assert.ok(section.includes('(<https://revue.exemple.fr/r/x)y>)'), section);
});

test('reportPromptArgs: every value is a string — promptArgs substitution takes nothing else', () => {
  const args = reportPromptArgs({
    issueNumber: 1,
    issueTitle: 't',
    branch: 'b',
    base: 'main',
    changedLines: 0,
    skill: SKILL,
    // The unnamed-MR case, which is exactly the one that would otherwise slip a
    // `null` into a substitution map typed Record<string, string>.
    mrNumber: null,
    mrUrl: null,
  });
  for (const [key, value] of Object.entries(args)) {
    assert.equal(typeof value, 'string', key);
  }
});

test('reportPromptArgs: the MR the report explains rides in, number and url (issue #46)', () => {
  // The whole point of the reordering: run before the create, this phase had no
  // number to give the skill, and every report published in AFK named the repo
  // instead of the change.
  const args = reportPromptArgs({
    issueNumber: 46,
    issueTitle: 'Le rapport se produit après l’ouverture de la MR',
    branch: 'sandcastle/issue-46-r1',
    base: 'main',
    changedLines: 240,
    skill: SKILL,
    mrNumber: 118,
    mrUrl: 'https://github.com/softnextapp/software-factory/pull/118',
  });
  assert.equal(args.MR_NUMBER, '118');
  assert.equal(args.MR_URL, 'https://github.com/softnextapp/software-factory/pull/118');
});

test('reportPromptArgs: an unnamed MR substitutes EMPTY, never a leftover {{MR_NUMBER}}', () => {
  // The create succeeded but printed nothing we could parse. Omitting the keys
  // would leave the literal braces in the prompt the skill reads, which is worse
  // than a blank the prompt file explicitly tells the agent how to read.
  const args = reportPromptArgs({
    issueNumber: 46,
    issueTitle: 't',
    branch: 'b',
    base: 'main',
    changedLines: 1,
    skill: SKILL,
    mrNumber: null,
    mrUrl: null,
  });
  assert.equal(args.MR_NUMBER, '');
  assert.equal(args.MR_URL, '');
  assert.ok('MR_NUMBER' in args && 'MR_URL' in args);
});

test('renderReport: the section no longer claims the report predates the MR (issue #46)', () => {
  // The phase runs AFTER the create now; a body saying "avant l'ouverture de cette
  // MR" would describe an order that no longer exists.
  const section = renderReport({ kind: 'published', skill: SKILL, url: URL_OK })!;
  assert.ok(!section.includes("avant l'ouverture"), section);
});

test('renderReport: exactly one report section per outcome — the body is rebuilt, never appended to', () => {
  // main.ts renders the body twice (once for the create with `null`, once for the
  // update with the outcome) and PATCHes the second whole. That is only safe while
  // one outcome yields one heading.
  for (const outcome of [
    { kind: 'published', skill: SKILL, url: URL_OK },
    { kind: 'degraded', skill: SKILL, reason: 'panne', replay: 'revue publier --depuis /p' },
    { kind: 'failed', skill: SKILL, reason: 'rien' },
  ] as const) {
    const section = renderReport(outcome)!;
    assert.equal(section.match(/## Rapport de revue/g)?.length, 1, outcome.kind);
  }
  // And no section at all before the phase has run — the body the MR opens with.
  assert.equal(renderReport(null), null);
});

finish();
