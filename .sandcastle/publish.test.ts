// Tests for the publish ledger — the durable trace of a branch that was PUSHED
// but whose Draft MR/PR creation failed (issue #26).
//
// Covers the pure pieces — parse/serialize round-trips, the replace-by-branch record
// rule, the resume decision (create | resolved | gone) and the queue hold (a pending
// issue is not fresh work) — plus the two fs shells, because "durable" is half of what
// issue #26 asks for: a ledger that silently fails to reach the disk, or that throws
// and takes the run with it, is the bug rather than the fix. The fs tests write to a
// scratch dir under os.tmpdir() and clean up after themselves; no network, no CLI, no
// secrets, no process.env — same purity contract as worktree-exclude.test.ts.
// Run: npx tsx .sandcastle/publish.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parsePendingPublishes,
  serializePendingPublishes,
  recordPendingPublish,
  decideResume,
  dropPendingIssues,
  pendingFileSummary,
  readPendingPublishes,
  writePendingPublishes,
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

test('dropPendingIssues: a trace whose issue left the queue holds nothing — no phantom log line', () => {
  const { kept, held } = dropPendingIssues(QUEUE, [{ ...TRACE, issue: 99 }]);
  assert.deepEqual(kept, QUEUE);
  assert.deepEqual(held, []);
});

test('dropPendingIssues: two traces on the same issue hold it once — the log line stays readable', () => {
  const queue = [{ number: 26, title: TRACE_TITLE, body: '', labels: ['ready-for-agent'] }];
  const { kept, held } = dropPendingIssues(queue, [
    TRACE,
    { ...TRACE, branch: 'sandcastle/issue-26-resume-missing-mr-r2' },
  ]);
  assert.deepEqual(kept, []);
  assert.deepEqual(held, [26]);
});

test('dropPendingIssues: never mutates the queue it filters', () => {
  const queue = [...QUEUE];
  dropPendingIssues(queue, [TRACE]);
  assert.deepEqual(queue, QUEUE);
});

// --- dry-run report ---------------------------------------------------------

test('pendingFileSummary: reads a pending count off the ledger (dry-run wiring is honest)', () => {
  assert.deepEqual(pendingFileSummary([]), { pending: 0, issues: [] });
  assert.deepEqual(pendingFileSummary([TRACE]), {
    pending: 1,
    issues: [26],
  });
});

// --- fs shells: the "durable" half of criterion 1 ---------------------------

const scratch = mkdtempSync(path.join(tmpdir(), 'publish-ledger-'));
const ledgerPath = (name: string): string => path.join(scratch, `${name}.json`);

test('readPendingPublishes: a missing file reads as empty — the fresh-repo case, never a throw', () => {
  assert.deepEqual(readPendingPublishes(ledgerPath('absent')), []);
});

test('writePendingPublishes → readPendingPublishes: a trace survives the round-trip to disk', () => {
  const file = ledgerPath('roundtrip');
  assert.equal(writePendingPublishes(file, [TRACE]), null);
  assert.deepEqual(readPendingPublishes(file), [TRACE]);
});

test('writePendingPublishes: an erased ledger writes `[]` — the erase is durable too', () => {
  const file = ledgerPath('erase');
  writePendingPublishes(file, [TRACE]);
  assert.equal(writePendingPublishes(file, []), null);
  assert.equal(readFileSync(file, 'utf8'), '[]\n');
  assert.deepEqual(readPendingPublishes(file), []);
});

test('readPendingPublishes: a corrupt file degrades to [] — a bad ledger must not block the round', () => {
  const file = ledgerPath('corrupt');
  writeFileSync(file, '{ this is not the ledger');
  assert.deepEqual(readPendingPublishes(file), []);
});

test('readPendingPublishes: a directory where the ledger should be reads as [] instead of throwing', () => {
  const file = ledgerPath('adirectory');
  mkdirSync(file);
  assert.deepEqual(readPendingPublishes(file), []);
});

test('writePendingPublishes: an unwritable path RETURNS the failure — it never throws at the caller', () => {
  // The drain erases traces outside any try/catch and Phase 3 records mid-loop: a
  // throwing write would abort the run the ledger exists to protect.
  const unwritable = path.join(scratch, 'no-such-dir', 'publish-pending.json');
  const failure = writePendingPublishes(unwritable, [TRACE]);
  assert.equal(typeof failure, 'string');
  assert.match(String(failure), /ENOENT/);
});

rmSync(scratch, { recursive: true, force: true });

finish();
