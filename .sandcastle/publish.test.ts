// Tests for the publish ledger — the durable trace of a branch that was PUSHED
// but whose Draft MR/PR creation failed (issue #26).
//
// Covers the PURE pieces only: parse/serialize round-trips, the replace-by-branch
// record rule, the resume decision (create | resolved | gone) and the queue hold
// (a pending issue is not fresh work). The fs shells (readPendingPublishes /
// recordPendingPublish / clearPendingPublish) are thin readFileSync/writeFileSync
// wrappers over those and are not unit-tested directly — same seam as host.ts.
// Pure: no network, no CLI, no process.env, no fs in the tested functions.
// Run: npx tsx .sandcastle/publish.test.ts
import assert from 'node:assert/strict';
import {
  parsePendingPublishes,
  serializePendingPublishes,
  recordPendingPublish,
  decideResume,
  dropPendingIssues,
  pendingFileSummary,
} from './publish.ts';
import { test, finish } from './test-harness.ts';

const TRACE = {
  issue: 26,
  branch: 'sandcastle/issue-26-resume-missing-mr-r1',
  base: 'main',
  title: 'feat(chain): resume a pushed branch whose MR was never opened (#26)',
  description: '## body',
  reason: 'gh pr create failed (exit 1): 503',
  round: 2,
};

// --- parse / serialize ------------------------------------------------------

test('parsePendingPublishes: [] for an empty/blank file (nothing pending)', () => {
  assert.deepEqual(parsePendingPublishes(''), []);
  assert.deepEqual(parsePendingPublishes('\n  \n'), []);
});

test('parsePendingPublishes: round-trips a serialized ledger', () => {
  const raw = serializePendingPublishes([TRACE]);
  const [back] = parsePendingPublishes(raw);
  assert.deepEqual(back, TRACE);
});

test('parsePendingPublishes: an unreadable payload degrades to [] — never throws, never blocks the round', () => {
  assert.deepEqual(parsePendingPublishes('not json'), []);
  assert.deepEqual(parsePendingPublishes('{"pending": "oups"}'), []);
  assert.deepEqual(parsePendingPublishes('[{"issue": "26"}]'), []); // row without the required fields
});

test('serializePendingPublishes: pretty 2-space JSON ending in a newline (operator-readable on disk)', () => {
  const raw = serializePendingPublishes([TRACE]);
  assert.ok(raw.endsWith('\n'), raw);
  assert.ok(raw.includes('\n    "issue": 26,'), `indented for humans: ${raw}`);
});

// --- record -----------------------------------------------------------------

test('recordPendingPublish: appends a new trace to an empty ledger', () => {
  assert.deepEqual(recordPendingPublish([], TRACE), [TRACE]);
});

test('recordPendingPublish: a re-failure on the SAME branch replaces its trace — no duplicates, no stale reason', () => {
  const retry = { ...TRACE, reason: 'gh pr create failed (exit 1): 504', round: 3 };
  assert.deepEqual(recordPendingPublish([TRACE], retry), [retry]);
});

test('recordPendingPublish: a different branch appends — newest last', () => {
  const other = { ...TRACE, issue: 12, branch: 'sandcastle/issue-12-other-r1' };
  const led = recordPendingPublish([TRACE], other);
  assert.equal(led.length, 2);
  assert.equal(led[1]?.branch, other.branch);
});

test('recordPendingPublish: never mutates the input array', () => {
  const input: typeof TRACE[] = [];
  recordPendingPublish(input, TRACE);
  assert.equal(input.length, 0);
});

// --- decideResume -----------------------------------------------------------

const mr = (sourceBranch: string): {
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  title: string;
  webUrl: string;
} => ({
  iid: 31,
  sourceBranch,
  targetBranch: 'main',
  createdAt: '2026-08-17T22:04:05Z',
  title: 'Draft: anything',
  webUrl: '',
});
const OPEN = [mr(TRACE.branch)];

test('decideResume: create when no open MR has the recorded source branch', () => {
  assert.equal(decideResume(TRACE, []), 'create');
  // An MR FROM a different branch does not satisfy this trace.
  assert.equal(decideResume(TRACE, [mr('other/branch')]), 'create');
});

test('decideResume: resolved when an open MR carries the branch — a second run must not duplicate it', () => {
  assert.equal(decideResume(TRACE, OPEN), 'resolved');
});

test('decideResume: gone when the pushed branch no longer exists on origin (merged+deleted or dropped)', () => {
  assert.equal(decideResume(TRACE, [], ['main', 'other']), 'gone');
});

test('decideResume: create (not gone) when the remote-branch list is unavailable — the 503 again', () => {
  // A failed ls-remote must fall back to trying the MR, not skip the trace.
  assert.equal(decideResume(TRACE, []), 'create');
  assert.equal(decideResume(TRACE, OPEN, null), 'resolved');
});

// --- queue hold -------------------------------------------------------------

const TRACE_TITLE = 'Une branche poussée sans MR est reprise au run suivant, pas refaite';
const QUEUE = [
  { number: 26, title: TRACE_TITLE, body: '', labels: ['ready-for-agent'] },
  { number: 31, title: 'autre ticket', body: '', labels: ['ready-for-agent'] },
];

test('dropPendingIssues: a pending issue leaves the planner queue — it is resume work, not fresh work', () => {
  const { kept, held } = dropPendingIssues(QUEUE, [TRACE]);
  assert.deepEqual(kept.map((i) => i.number), [31]);
  assert.deepEqual(held, [26]);
});

test('dropPendingIssues: an empty ledger keeps the queue intact', () => {
  const { kept, held } = dropPendingIssues(QUEUE, []);
  assert.deepEqual(kept, QUEUE);
  assert.deepEqual(held, []);
});

// --- dry-run report ---------------------------------------------------------

test('pendingFileSummary: reads a pending count off the ledger (dry-run wiring is honest)', () => {
  assert.deepEqual(pendingFileSummary([]), { pending: 0, issues: [] });
  assert.deepEqual(pendingFileSummary([TRACE]), {
    pending: 1,
    issues: [26],
  });
});

finish();
