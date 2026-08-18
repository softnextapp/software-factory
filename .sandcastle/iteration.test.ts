// Contract tests for the per-iteration failure boundary (issue #31).
//
// The boundary has two cooperating halves, both under test here:
//   - host.ts's HostReadError — the #25 classification carried OUT of the spent
//     retry loop, so the boundary does not re-derive it from the raw throw;
//   - iteration.ts — the pure decisions: which throw costs its ITERATION and
//     which stops the RUN, the tally, and the operator-facing lines.
//
// The try/catch itself lives in main.ts, whose top-level loop runs on import
// and is therefore not unit-testable in this suite (same fence as plan.ts /
// chain.ts / publish.ts): what IS testable is the discrimination the catch
// delegates to, which is the whole of the decision.
//
// Pure: no CLI, no network, no fs, no process.env. The fixtures reuse the
// byte-accurate CLI captures from host.test.ts.
// Run: npx tsx .sandcastle/iteration.test.ts
import assert from 'node:assert/strict';
import {
  HostReadError,
  runHostRead,
  classifyHostFailure,
  type HostFailure,
} from './host.ts';
import {
  isLostIterationError,
  recordLostIteration,
  isRunLost,
  describeLostIteration,
  describeIterationLosses,
} from './iteration.ts';
import { test, finish } from './test-harness.ts';

// --- fixtures: the two incidents the issue names -----------------------------
//
// SPENT is the 17 Aug 2026 shape — a 503 that outlasted every backoff attempt.
// REFUSED is criterion 3's shape — a bad credential, definitive on attempt 1.

const cliError = (stderr: string): Error & { status: number; stderr: string } => {
  const error = new Error(`Command failed: gh\n${stderr}`) as Error & {
    status: number;
    stderr: string;
  };
  error.status = 1;
  error.stderr = stderr;
  return error;
};

const GH_503 = 'HTTP 503: Service Unavailable (https://api.github.com/graphql)\n';
const GH_401 = 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n';

/**
 * A host read whose CLI fails with `stderr` on EVERY attempt, driven through
 * runHostRead. Whether that burns all HOST_READ_ATTEMPTS (a retryable wording)
 * or stops at the first (a definitive one) is #25's decision — this helper only
 * guarantees the outcome is the HostReadError the boundary will actually see.
 */
const failingRead = (verb: string, stderr: string): HostReadError => {
  const read = (): string => {
    throw cliError(stderr);
  };
  try {
    runHostRead(verb, read, { sleep: () => {}, log: () => {}, random: () => 0 });
  } catch (error) {
    return error as HostReadError;
  }
  throw new Error('the read was expected to throw');
};

/** A retryable wording that outlived every retry — the "spent" half of the boundary. */
const spentRead = failingRead;
/** A definitive wording, refused on the first attempt — the "stops the run" half. */
const refusedRead = failingRead;

// --- HostReadError: the classification carried out (the seam #31 needs) ------

test('a spent host read throws a HostReadError carrying verb + classification + cause', () => {
  const error = spentRead('gh issue list --label sandcastle', GH_503);
  assert.ok(error instanceof HostReadError);
  assert.equal(error.verb, 'gh issue list --label sandcastle');
  // Retryable HERE means "was retryable" — the retries are spent by construction.
  assert.equal(error.failure.retryable, true);
  assert.equal(error.failure.reason, 'outage');
  // The original execFileSync-shaped throw stays reachable for the stack.
  assert.ok(String((error.cause as { stderr?: string }).stderr).includes('503'));
  // The message is ONE line and names the verb: the boundary prints it verbatim.
  const lines = error.message.split('\n');
  assert.equal(lines.length, 1, `single line: ${error.message}`);
  assert.ok(error.message.includes('gh issue list --label sandcastle'), error.message);
});

test('a definitive host read also surfaces as HostReadError, with retryable=false', () => {
  const error = refusedRead('gh issue list --label sandcastle', GH_401);
  assert.ok(error instanceof HostReadError);
  assert.equal(error.failure.retryable, false);
  assert.equal(error.failure.reason, 'auth');
});

test('HostReadError is an Error — it reads like one in a stack and a log', () => {
  const error = spentRead('gh issue list', GH_503);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'HostReadError');
});

// --- isLostIterationError: the discrimination (criteria 1 and 3) -------------

test('a spent TRANSIENT host read loses its ITERATION, not the run (criterion 1)', () => {
  assert.equal(isLostIterationError(spentRead('gh issue list', GH_503)), true);
  // The other transient causes classify the same way.
  const GLAB_503 = 'ERROR: GET http://127.0.0.1:8453/api/v4/projects/o%2Fr/issues: 503 {message: 503 stubbed}\n';
  assert.equal(isLostIterationError(spentRead('glab issue list', GLAB_503)), true);
  const GH_CONN = 'error connecting to github.invalid\ncheck your internet connection or https://githubstatus.com\n';
  assert.equal(isLostIterationError(spentRead('gh pr list', GH_CONN)), true);
});

test('an UNRECOGNISED wording that survived its retries is a lost iteration, not a dead run', () => {
  // #25 fails open to retryable precisely so this lands here: an unknown
  // transient costs one iteration, and still surfaces in the tally.
  const error = spentRead('gh issue list', 'some never-seen-before CLI error');
  assert.equal(error.failure.reason, 'unknown');
  assert.equal(isLostIterationError(error), true);
});

test('a DEFINITIVE host read stops the run — auth (criterion 3)', () => {
  assert.equal(isLostIterationError(refusedRead('gh issue list', GH_401)), false);
});

test('every definitive cause stops the run: quota-exhausted, not-found, client-error', () => {
  // Built directly rather than through runHostRead: the classifier is the
  // decision's only input, so each definitive reason is pinned at the seam.
  const asHostError = (status: number | null, stderr: string): HostReadError =>
    new HostReadError('gh issue list', classifyHostFailure(status, stderr) as HostFailure, cliError(stderr));
  const cases: [string, string][] = [
    ['quota-exhausted', 'HTTP 403: API rate limit exceeded for user ID 1234.\n'],
    ['not-found', 'GraphQL: Could not resolve to an issue or pull request with the number of 999999999.\n'],
    ['client-error', 'HTTP 422: Validation Failed\n'],
    ['auth', 'HTTP 403: Resource not accessible by integration\n'],
  ];
  for (const [reason, stderr] of cases) {
    const error = asHostError(1, stderr);
    assert.equal(error.failure.reason, reason, stderr);
    assert.equal(isLostIterationError(error), false, `${reason} must stop the run`);
  }
});

test('a NON-host error stops the run — a config error or a bug must not read as an outage', () => {
  assert.equal(isLostIterationError(new Error('Base branch `epic/x` does not exist locally.')), false);
  assert.equal(isLostIterationError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isLostIterationError('a thrown string'), false);
  assert.equal(isLostIterationError(null), false);
});

// --- recordLostIteration: the count (criterion 2) ----------------------------

test('recordLostIteration: appends one entry carrying the iteration number and the reason', () => {
  const second = spentRead('gh issue list', GH_503);
  const tally = recordLostIteration(
    recordLostIteration([], 2, spentRead('gh issue list', GH_503)),
    3,
    second,
  );
  assert.equal(tally.length, 2);
  assert.deepEqual(
    tally.map((lost) => [lost.iteration, lost.reason]),
    [
      [2, 'outage'],
      [3, 'outage'],
    ],
  );
  // The error rides along: the log line prints its first words as the cause.
  assert.equal(tally[1]?.error, second);
});

test('recordLostIteration: never mutates the tally it was given', () => {
  const input = recordLostIteration([], 2, spentRead('gh issue list', GH_503));
  const copy = [...input];
  recordLostIteration(input, 4, spentRead('gh pr list', GH_503));
  assert.deepEqual(input, copy);
});

// --- isRunLost: criterion 4 ---------------------------------------------------

test('a run that lost EVERY iteration it ran is a lost run (criterion 4)', () => {
  let tally = recordLostIteration([], 1, spentRead('gh issue list', GH_503));
  tally = recordLostIteration(tally, 2, spentRead('gh issue list', GH_503));
  tally = recordLostIteration(tally, 3, spentRead('gh issue list', GH_503));
  assert.equal(tally.length, 3);
  assert.equal(isRunLost(tally, 3), true);
});

test('a run where SOME iterations delivered is NOT a lost run — it exits 0 with the tally', () => {
  const tally = recordLostIteration([], 2, spentRead('gh issue list', GH_503));
  assert.equal(isRunLost(tally, 10), false);
});

test('a run that ran NOTHING is not "all lost" — no new failure mode smuggled in', () => {
  // The pre-#31 "planner returned no issues / no branch produced commits" breaks
  // happen before any loss; exit(0) there is the existing behaviour.
  assert.equal(isRunLost([], 0), false);
  assert.equal(isRunLost([], 5), false);
});

// --- the log lines: the "se dit" (criterion 2) -------------------------------

test('describeLostIteration: names the iteration, the cause, and says the run continues', () => {
  const line = describeLostIteration(recordLostIteration([], 2, spentRead('gh issue list --label sandcastle', GH_503))[0]!, 10);
  assert.ok(line.includes('2/10'), `names the iteration: ${line}`);
  assert.ok(line.includes('outage'), `names the reason: ${line}`);
  assert.ok(line.includes('503') || line.includes('Service Unavailable'), `carries the cause: ${line}`);
  assert.ok(line.toLowerCase().includes('continu'), `says the run continues: ${line}`);
});

test('describeLostIteration: keeps a MULTI-LINE stderr to one line — the banner must not drown', () => {
  const multiline = 'HTTP 503: Service Unavailable\nsecond line of the CLI banner\nthird line\n';
  const entry = recordLostIteration([], 2, spentRead('gh issue list', multiline))[0]!;
  const line = describeLostIteration(entry, 10);
  assert.equal(line.split('\n').length, 1, `one line: ${line}`);
});

test('describeIterationLosses: says the count out loud, with the lost iterations named', () => {
  let tally = recordLostIteration([], 2, spentRead('gh issue list', GH_503));
  tally = recordLostIteration(tally, 3, spentRead('gh issue list', GH_503));
  tally = recordLostIteration(tally, 4, spentRead('gh issue list', GH_503));
  const line = describeIterationLosses(tally, 10);
  assert.ok(line.includes('3 of 10'), `says the count: ${line}`);
  assert.ok(line.includes('#2, #3, #4'), `names them: ${line}`);
});

test('describeIterationLosses: a single lost iteration reads in the singular', () => {
  const line = describeIterationLosses([recordLostIteration([], 2, spentRead('gh issue list', GH_503))[0]!], 10);
  assert.ok(line.includes('1 of 10'), line);
});

finish();
