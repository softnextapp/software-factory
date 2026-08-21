// Contract tests for the end-of-run summary (issue #32).
//
// The issue's complaint is not that the run misbehaved — on 17 Aug 2026 it
// behaved WELL, refusing to publish anything from a severed model provider. The
// complaint is that its last line (`All done`) and its exit code were
// indistinguishable from an evening that opened three MRs. So the unit under
// test is the accounting, and it splits three ways:
//
//   summarizeRun  — the pure fold from what the run recorded to what it counts;
//   renderRunSummary — a rendering of that fold and nothing more (criterion 5);
//   exitCodeFor   — the same verdict, said in the one word automation reads.
//
// main.ts owns only the appends and the two effects (print, exit). The events
// below are the exact shapes it appends at the sites named in each case.
//
// Pure: no CLI, no network, no fs, no process.env.
// Run: npx tsx .sandcastle/run-summary.test.ts
import assert from 'node:assert/strict';
import {
  summarizeRun,
  renderRunSummary,
  exitCodeFor,
  type RunEvent,
} from './run-summary.ts';
import { test, finish } from './test-harness.ts';

// --- fixtures ---------------------------------------------------------------

const started = (iteration: number): RunEvent => ({ kind: 'iteration-started', iteration });
const chain = (iteration: number, mode: 'on' | 'off'): RunEvent =>
  ({ kind: 'chain-decided', iteration, mode });
const planned = (iteration: number, issues: number[]): RunEvent =>
  ({ kind: 'planned', iteration, issues });
const published = (iteration: number, issue: number): RunEvent =>
  ({ kind: 'published', iteration, issue, branch: `issue-${issue}-x`, base: 'main' });
const abandoned = (
  iteration: number,
  issue: number,
  reason: 'implementer-failed' | 'no-commits' | 'push-failed' | 'mr-not-opened',
  detail = 'because',
): RunEvent => ({ kind: 'abandoned', iteration, issue, reason, detail });
const lost = (iteration: number, reason: 'outage' | 'unknown' = 'outage'): RunEvent =>
  ({ kind: 'iteration-lost', iteration, reason, detail: 'HTTP 503: Service Unavailable' });
const stopped = (
  reason:
    | 'iterations-exhausted'
    | 'queue-empty'
    | 'only-no-match'
    | 'no-commits'
    | 'implementers-failed'
    | 'fatal',
): RunEvent => ({ kind: 'stopped', reason });

/** The fruitful evening the sterile run must not read like: 2 iterations, 3 MRs. */
const FRUITFUL: RunEvent[] = [
  started(1),
  chain(1, 'off'),
  planned(1, [41, 42]),
  published(1, 41),
  published(1, 42),
  started(2),
  chain(2, 'off'),
  planned(2, [43]),
  published(2, 43),
  stopped('queue-empty'),
];

/** The 17 Aug 2026 shape: the loop ran, the host was gone, nothing shipped. */
const STERILE: RunEvent[] = [
  started(1),
  lost(1),
  started(2),
  lost(2),
  stopped('iterations-exhausted'),
];

const summaryOf = (events: RunEvent[], opts: { maxIterations?: number; chainRequested?: boolean } = {}) =>
  summarizeRun({
    events,
    maxIterations: opts.maxIterations ?? 10,
    chainRequested: opts.chainRequested ?? false,
  });

// --- criterion 1: the counters ----------------------------------------------

test('counts the iterations that actually ran, against the configured cap', () => {
  const s = summaryOf(FRUITFUL, { maxIterations: 10 });
  assert.equal(s.ranIterations, 2);
  assert.equal(s.maxIterations, 10);
});

test('counts published MRs, keeping each one identifiable', () => {
  const s = summaryOf(FRUITFUL);
  assert.equal(s.published.length, 3);
  assert.deepEqual(
    s.published.map((mr) => mr.issue),
    [41, 42, 43],
  );
  assert.equal(s.published[0]?.branch, 'issue-41-x');
  assert.equal(s.published[0]?.base, 'main');
});

test('counts abandoned tickets — planned and never published', () => {
  const s = summaryOf([
    started(1),
    planned(1, [41, 42, 43]),
    published(1, 41),
    abandoned(1, 42, 'no-commits'),
    abandoned(1, 43, 'push-failed'),
    stopped('iterations-exhausted'),
  ]);
  assert.equal(s.published.length, 1);
  assert.deepEqual(
    s.abandoned.map((t) => t.issue),
    [42, 43],
  );
});

test('a ticket published after an earlier round abandoned it is not counted abandoned twice', () => {
  // Re-planned next round and shipped: the run's tally is per (iteration, ticket),
  // and the operator reads "one abandonment, one publish", not "one lost ticket".
  const s = summaryOf([
    started(1),
    planned(1, [41]),
    abandoned(1, 41, 'push-failed'),
    started(2),
    planned(2, [41]),
    published(2, 41),
    stopped('queue-empty'),
  ]);
  assert.equal(s.published.length, 1);
  assert.equal(s.abandoned.length, 1);
  assert.equal(s.abandoned[0]?.iteration, 1);
});

test('MRs opened by the previous run ledger drain are counted apart from this run work', () => {
  const s = summaryOf([{ kind: 'resumed', issue: 39 }, ...FRUITFUL]);
  assert.deepEqual(s.resumed, [39]);
  assert.equal(s.published.length, 3, 'a resumed MR is not this run own publish');
});

// --- criterion 2: every abandonment has a NAMED cause -----------------------

test('each abandonment carries the cause the run recorded', () => {
  const s = summaryOf([
    started(1),
    planned(1, [41, 42, 43, 44]),
    abandoned(1, 41, 'implementer-failed', 'Connection closed mid-response'),
    abandoned(1, 42, 'no-commits'),
    abandoned(1, 43, 'push-failed'),
    abandoned(1, 44, 'mr-not-opened'),
    stopped('iterations-exhausted'),
  ]);
  assert.deepEqual(
    s.abandoned.map((t) => t.reason),
    ['implementer-failed', 'no-commits', 'push-failed', 'mr-not-opened'],
  );
  assert.equal(s.abandoned[0]?.detail, 'Connection closed mid-response');
});

test('a planned ticket with no recorded outcome is reported unknown, not filed under the nearest cause', () => {
  const s = summaryOf([
    started(1),
    planned(1, [41, 42]),
    published(1, 41),
    // #42 fell through every recording site — a bug, or a path nobody wrote a
    // cause for. The summary must say so rather than guess `no-commits`.
    stopped('iterations-exhausted'),
  ]);
  assert.equal(s.abandoned.length, 1);
  assert.equal(s.abandoned[0]?.issue, 42);
  assert.equal(s.abandoned[0]?.reason, 'unknown');
});

test('a ticket unaccounted for in a LOST iteration is named host-unavailable, not unknown', () => {
  // Not a guess: the iteration is on record as lost to the host, and that IS the
  // cause. `unknown` here would hide a cause the run knows.
  const s = summaryOf([started(1), planned(1, [41]), lost(1), stopped('iterations-exhausted')]);
  assert.equal(s.abandoned[0]?.reason, 'host-unavailable');
  assert.match(s.abandoned[0]?.detail ?? '', /503/);
});

test('abandonments group by cause, in a stable order, with unknown last', () => {
  const s = summaryOf([
    started(1),
    planned(1, [41, 42, 43]),
    abandoned(1, 43, 'no-commits'),
    abandoned(1, 41, 'push-failed'),
    stopped('iterations-exhausted'),
  ]);
  const groups = s.abandonedByReason.map((g) => g.reason);
  assert.deepEqual(groups, ['no-commits', 'push-failed', 'unknown']);
  assert.deepEqual(s.abandonedByReason.at(-1)?.issues, [42]);
});

test('lost iterations are counted and named', () => {
  const s = summaryOf(STERILE);
  assert.equal(s.lost.length, 2);
  assert.deepEqual(
    s.lost.map((l) => l.iteration),
    [1, 2],
  );
  assert.equal(s.lost[0]?.reason, 'outage');
});

// --- criterion 3: sterile vs fruitful, in words AND in the exit code --------

test('a run that published is a published verdict, exit 0', () => {
  const s = summaryOf(FRUITFUL);
  assert.equal(s.verdict, 'published');
  assert.equal(exitCodeFor(s), 0);
});

test('a run that had work and published nothing is sterile, exit 1', () => {
  const s = summaryOf([
    started(1),
    planned(1, [41]),
    abandoned(1, 41, 'no-commits'),
    stopped('no-commits'),
  ]);
  assert.equal(s.verdict, 'sterile');
  assert.equal(exitCodeFor(s), 1);
});

test('the 17 Aug 2026 run — every iteration lost — exits 1 under its own verdict', () => {
  // Its own verdict rather than plain `sterile`, because a resumed MR can coexist
  // with it (see below) and "nothing was published" would then be a lie. Both
  // read as sterile and both exit 1 — the distinction is in what they may claim.
  const s = summaryOf(STERILE);
  assert.equal(s.verdict, 'all-iterations-lost');
  assert.equal(exitCodeFor(s), 1);
  assert.match(renderRunSummary(s), /STERILE/);
});

test('a drained backlog is idle, not sterile — exit 2, its own code', () => {
  // Nothing to do is not a failure (exit 1 would cry wolf at every quiet night)
  // and not a success either (exit 0 would read as "three MRs" to automation).
  const s = summaryOf([started(1), stopped('queue-empty')]);
  assert.equal(s.verdict, 'idle');
  assert.equal(exitCodeFor(s), 2);
});

test('a resumed MR does NOT rescue a run that lost every iteration — #31 criterion 4', () => {
  // The ledger drain runs BEFORE the first iteration, so this shape is reachable:
  // last night's orphan MR is opened, then all ten of tonight's iterations 503.
  // Ruling on "an MR is open" first would exit 0 on a run that lost everything.
  const s = summaryOf([{ kind: 'resumed', issue: 39 }, ...STERILE]);
  assert.deepEqual(s.resumed, [39], 'the resumed MR is still reported');
  assert.equal(s.verdict, 'all-iterations-lost');
  assert.equal(exitCodeFor(s), 1);
});

test('the all-lost verdict does not claim nothing was published', () => {
  // It cannot: the drain may have opened one. The prose names the loss, and the
  // resumed line beside it says what IS open.
  const out = renderRunSummary(summaryOf([{ kind: 'resumed', issue: 39 }, ...STERILE]));
  assert.match(out, /every iteration was lost/i);
  assert.match(out, /#39/);
});

test('a partially lost run is not all-lost', () => {
  const s = summaryOf([
    started(1),
    lost(1),
    started(2),
    planned(2, [41]),
    published(2, 41),
    stopped('queue-empty'),
  ]);
  assert.equal(s.verdict, 'published');
  assert.equal(exitCodeFor(s), 0);
});

test('a round whose implementers were all severed is not a round that wrote nothing', () => {
  // Same exit code, different accusation: `no-commits` blames the agents for a
  // dead provider, which is the mis-reporting this module exists to end.
  const s = summaryOf([
    started(1),
    planned(1, [41]),
    abandoned(1, 41, 'implementer-failed', 'Connection closed mid-response'),
    stopped('implementers-failed'),
  ]);
  assert.equal(s.stop, 'implementers-failed');
  assert.match(renderRunSummary(s), /lost its implementer/);
  assert.doesNotMatch(renderRunSummary(s), /produced no commits/);
});

test('SANDCASTLE_ONLY matching nothing is sterile, not idle — the ticket is missing, not the backlog', () => {
  // exit 2 here would report "the backlog is drained" for the one mistake this
  // path detects: the operator's ticket never got its queue label.
  const s = summaryOf([started(1), stopped('only-no-match')]);
  assert.equal(s.verdict, 'sterile');
  assert.equal(exitCodeFor(s), 1);
});

test('the render does not spend `#` on both iterations and issues', () => {
  const out = renderRunSummary(
    summaryOf([
      started(1),
      lost(1),
      started(2),
      planned(2, [41]),
      published(2, 41),
      stopped('queue-empty'),
    ]),
  );
  assert.match(out, /iteration 1 \(outage\)/);
  assert.doesNotMatch(out, /#1 outage/);
});

test('resuming a previous run missing MR counts as having published', () => {
  const s = summaryOf([{ kind: 'resumed', issue: 39 }, started(1), stopped('queue-empty')]);
  assert.equal(s.verdict, 'published');
  assert.equal(exitCodeFor(s), 0);
});

test('a fatal stop is sterile even with nothing planned — the run died, it was not idle', () => {
  const s = summaryOf([started(1), stopped('fatal')]);
  assert.equal(s.verdict, 'sterile');
  assert.equal(exitCodeFor(s), 1);
});

test('a fatal stop AFTER a publish still reports the publish, and still exits non-zero', () => {
  const s = summaryOf([started(1), planned(1, [41]), published(1, 41), stopped('fatal')]);
  assert.equal(s.published.length, 1);
  assert.equal(s.verdict, 'published-then-died');
  assert.equal(exitCodeFor(s), 1, 'a run that died must not exit like one that finished');
});

// --- criterion 4: the chained mode APPLIED, not the one requested ----------

test('chain off and never applied reports neither requested nor applied', () => {
  const s = summaryOf(FRUITFUL, { chainRequested: false });
  assert.equal(s.chain.requested, false);
  assert.equal(s.chain.effective, 'off');
});

test('chain requested and applied throughout reports on', () => {
  const s = summaryOf([started(1), chain(1, 'on'), planned(1, [41]), published(1, 41), stopped('queue-empty')], {
    chainRequested: true,
  });
  assert.equal(s.chain.requested, true);
  assert.equal(s.chain.effective, 'on');
  assert.equal(s.chain.iterationsOn, 1);
});

test('chain requested but downgraded in every round reports off, not on', () => {
  // The whole point of the criterion: the flag said on, the rounds built
  // unchained, and the summary must side with the rounds (issue #30 vocabulary).
  const s = summaryOf(
    [started(1), chain(1, 'off'), planned(1, [41]), published(1, 41), started(2), chain(2, 'off'), stopped('queue-empty')],
    { chainRequested: true },
  );
  assert.equal(s.chain.requested, true);
  assert.equal(s.chain.effective, 'off');
  assert.equal(s.chain.iterationsOn, 0);
  assert.equal(s.chain.iterationsOff, 2);
});

test('chain applied in some rounds and not others reports mixed, with the split', () => {
  const s = summaryOf(
    [started(1), chain(1, 'on'), started(2), chain(2, 'off'), stopped('queue-empty')],
    { chainRequested: true },
  );
  assert.equal(s.chain.effective, 'mixed');
  assert.equal(s.chain.iterationsOn, 1);
  assert.equal(s.chain.iterationsOff, 1);
});

test('a ticket that fell back to its label base inside a chained round is counted', () => {
  const s = summaryOf(
    [
      started(1),
      chain(1, 'on'),
      { kind: 'chain-ticket-unchained', iteration: 1, issue: 41 },
      planned(1, [41]),
      published(1, 41),
      stopped('queue-empty'),
    ],
    { chainRequested: true },
  );
  assert.equal(s.chain.ticketFallbacks, 1);
});

// --- criterion 5: the display is a rendering of the fold, nothing more -----

test('the render names the counters it was given', () => {
  const out = renderRunSummary(summaryOf(FRUITFUL));
  assert.match(out, /2 of 10/, 'iterations run vs cap');
  assert.match(out, /3/, 'the MR count');
  assert.match(out, /#41/);
  assert.match(out, /#43/);
});

test('the render of a sterile run cannot be read as a fruitful one', () => {
  const out = renderRunSummary(summaryOf(STERILE));
  assert.doesNotMatch(out, /All done/);
  assert.match(out, /sterile|no .*published|nothing/i);
  assert.match(out, /outage/);
});

test('the render lists every abandonment under its named cause', () => {
  const out = renderRunSummary(
    summaryOf([
      started(1),
      planned(1, [41, 42, 43]),
      abandoned(1, 41, 'mr-not-opened', 'HTTP 503 from gh pr create'),
      abandoned(1, 42, 'implementer-failed', 'Connection closed mid-response'),
      stopped('iterations-exhausted'),
    ]),
  );
  assert.match(out, /mr-not-opened/);
  assert.match(out, /#41/);
  assert.match(out, /implementer-failed/);
  assert.match(out, /Connection closed mid-response/);
  assert.match(out, /unknown/, 'the unaccounted #43 says so');
  assert.match(out, /#43/);
});

test('the render keeps the round split out of an unchained run', () => {
  // Three ways of saying nothing, on every unchained run there will ever be.
  const out = renderRunSummary(
    summaryOf([started(1), chain(1, 'off'), started(2), chain(2, 'off'), stopped('queue-empty')], {
      chainRequested: false,
    }),
  );
  assert.match(out, /requested off, applied off/);
  assert.doesNotMatch(out, /0 of 2 rounds/);
});

test('the render says the applied chained mode alongside the requested one', () => {
  const out = renderRunSummary(
    summaryOf([started(1), chain(1, 'off'), stopped('queue-empty')], { chainRequested: true }),
  );
  assert.match(out, /chain/i);
  assert.match(out, /requested/i);
  assert.match(out, /applied|off/i);
});

test('the render is a pure function of the summary — same summary, same bytes', () => {
  const s = summaryOf(FRUITFUL);
  assert.equal(renderRunSummary(s), renderRunSummary(s));
});

test('summarizeRun does not mutate the events it folds', () => {
  const events = [...FRUITFUL];
  const before = JSON.stringify(events);
  summarizeRun({ events, maxIterations: 10, chainRequested: false });
  assert.equal(JSON.stringify(events), before);
});

// --- edges ------------------------------------------------------------------

test('a run whose loop never started an iteration is idle, not sterile', () => {
  // Nothing ran, so nothing was lost — exit(1) here would invent a failure mode.
  const s = summaryOf([]);
  assert.equal(s.ranIterations, 0);
  assert.equal(s.verdict, 'idle');
  assert.equal(exitCodeFor(s), 2);
});

test('an empty run still renders, and says the loop never ran', () => {
  const out = renderRunSummary(summaryOf([]));
  assert.match(out, /0 of 10|never/i);
});

test('the stop reason is reported, and an unrecorded stop says unknown', () => {
  assert.equal(summaryOf(FRUITFUL).stop, 'queue-empty');
  assert.equal(summaryOf([started(1)]).stop, 'unknown');
});

finish();
