// The end-of-run accounting (issue #32).
//
// The cause
// ---------
// `main.ts` used to end every run with the same two bytes of information:
// `All done.` and exit 0. On 17 Aug 2026 a run stopped on a severed model
// provider (`Connection closed mid-response`) without producing a single
// commit. The CONDUCT was right — nothing empty was published, which is exactly
// the behaviour we want — but the last line and the exit code were
// indistinguishable from an evening that opened three MRs. A correct conduct,
// badly reported, reads as a success, and the operator relaunches without
// knowing what they are relaunching.
//
// So this module is not a logger. It is the run's books: what the loop ran, what
// it published, what it gave up on and WHY, and the one-word verdict automation
// reads off the exit code.
//
// Why an event fold rather than a counter per site
// -----------------------------------------------
// Counters incremented at each site drift: the site that forgets to increment
// produces a run whose numbers add up to less than it did, and nothing says so.
// Here main.ts appends flat facts (`planned`, `published`, `abandoned`, …) and
// this module DERIVES the abandonment list as *planned minus published*. A
// ticket cannot fall out of the books by being forgotten: it falls out with the
// reason `unknown`, which is issue #32's criterion 2 — "une cause inconnue se
// dit inconnue plutôt que d'être rangée dans la plus proche". The one exception
// is a ticket left unaccounted inside an iteration the run recorded as lost:
// there the cause is not unknown, it is on record (`host-unavailable`), and
// saying `unknown` would hide a cause the run holds.
//
// Purity contract (same seam as chain.ts / publish.ts / iteration.ts): every
// function here is pure — no CLI, no fs, no process, no clock. main.ts owns the
// appends and the two effects (print, exit); the display is a rendering of the
// fold and nothing more (criterion 5). Tests: run-summary.test.ts.

import type { HostFailureReason } from './host.ts';

// ---------------------------------------------------------------------------
// The named causes
// ---------------------------------------------------------------------------

/**
 * Why one ticket the run had committed to did not end in a published MR — the
 * four causes the issue names, plus the two the accounting needs to stay honest.
 *
 * A closed union on purpose, like host.ts's `HostFailureReason`: a free-text
 * cause is a cause nobody can count, and a summary that cannot count its causes
 * is the `All done` this module replaces.
 */
export type AbandonReason =
  /** "agent implémenteur coupé" — the implementer sandbox threw, or was severed mid-response. */
  | 'implementer-failed'
  /** The implementer ran to the end and produced nothing to publish. */
  | 'no-commits'
  /** `git push` never got the branch to origin — nothing durable was left behind. */
  | 'push-failed'
  /** "MR restée à ouvrir" — pushed, but the MR creation failed; the #26 ledger holds it. */
  | 'mr-not-opened'
  /** "hôte indisponible" — the iteration was lost to a host outage (#31) with this ticket in it. */
  | 'host-unavailable'
  /** No cause was recorded. Said out loud rather than filed under the nearest one. */
  | 'unknown';

/** Declaration order is the render order; `unknown` last, where it reads as the exception it is. */
const ABANDON_ORDER: readonly AbandonReason[] = [
  'implementer-failed',
  'no-commits',
  'push-failed',
  'mr-not-opened',
  'host-unavailable',
  'unknown',
];

/** Why the loop stopped. `unknown` covers a stop nobody recorded — same honesty rule as above. */
export type StopReason =
  /** The loop used its whole `maxIterations` budget. */
  | 'iterations-exhausted'
  /** The queue (or the planner) had nothing left — the backlog is drained. */
  | 'queue-empty'
  /** SANDCASTLE_ONLY matched none of the planned issues. */
  | 'only-no-match'
  /** A round's branches produced no commits, so the round had nothing to publish. */
  | 'no-commits'
  /** Every branch of a round lost its implementer before it could commit — not the same thing. */
  | 'implementers-failed'
  /** A definitive failure ended the run (#31's stop-the-run list, or a bug). */
  | 'fatal'
  | 'unknown';

/** The chained mode as APPLIED to a round — issue #30's vocabulary, not the operator's flag. */
export type ChainMode = 'on' | 'off';

// ---------------------------------------------------------------------------
// What main.ts records
// ---------------------------------------------------------------------------

/**
 * One fact the run appends as it goes. Flat and past-tense by design: an event
 * records what HAPPENED at a site, never what it means for the tally — the
 * meaning is this module's job, and keeping it here is what lets the books be
 * tested without a host.
 */
export type RunEvent =
  /** The loop entered an iteration. The count of these is `ranIterations`. */
  | { readonly kind: 'iteration-started'; readonly iteration: number }
  /** #31's boundary absorbed a host failure and moved on. */
  | {
      readonly kind: 'iteration-lost';
      readonly iteration: number;
      readonly reason: HostFailureReason;
      readonly detail: string;
    }
  /** The chained mode this round actually applied (#30's `decidePlannerChainMode`). */
  | { readonly kind: 'chain-decided'; readonly iteration: number; readonly mode: ChainMode }
  /** A chained round in which THIS ticket still fell back to its label base (#24's warning). */
  | { readonly kind: 'chain-ticket-unchained'; readonly iteration: number; readonly issue: number }
  /** The tickets the round committed to — bases resolved, work about to start. */
  | { readonly kind: 'planned'; readonly iteration: number; readonly issues: readonly number[] }
  /** An MR this run opened for its own work. */
  | {
      readonly kind: 'published';
      readonly iteration: number;
      readonly issue: number;
      readonly branch: string;
      readonly base: string;
    }
  /** An MR opened by the #26 ledger drain — a PREVIOUS run's orphan, finished here. */
  | { readonly kind: 'resumed'; readonly issue: number }
  /** A committed ticket that will not be published, with its cause. */
  | {
      readonly kind: 'abandoned';
      readonly iteration: number;
      readonly issue: number;
      readonly reason: AbandonReason;
      readonly detail: string;
    }
  /** Why the loop ended. Appended once, at the one place the loop leaves. */
  | { readonly kind: 'stopped'; readonly reason: StopReason };

// ---------------------------------------------------------------------------
// What the books say
// ---------------------------------------------------------------------------

/** One abandonment, resolved to a named cause. */
export interface AbandonedTicket {
  readonly iteration: number;
  readonly issue: number;
  readonly reason: AbandonReason;
  /** The operator-facing one-liner: the failure's own words, or why there are none. */
  readonly detail: string;
}

/** An MR this run opened, kept identifiable so the operator can go and look at it. */
export interface PublishedMr {
  readonly iteration: number;
  readonly issue: number;
  readonly branch: string;
  readonly base: string;
}

/** An iteration #31 gave up on, with the host cause it was given up for. */
export interface LostIterationRecord {
  readonly iteration: number;
  readonly reason: HostFailureReason;
  readonly detail: string;
}

/**
 * The chained mode, requested against applied (criterion 4). `effective` sides
 * with the ROUNDS: a flag that asked for a stack no round could build is
 * reported `off`, because that is what the run did.
 */
export interface ChainReport {
  /** The operator's flag — SANDCASTLE_CHAIN. */
  readonly requested: boolean;
  readonly iterationsOn: number;
  readonly iterationsOff: number;
  /** `mixed` when the rounds disagreed; `off` when no round applied it. */
  readonly effective: ChainMode | 'mixed';
  /** Tickets that fell back to their label base inside an `on` round (#24). */
  readonly ticketFallbacks: number;
}

/**
 * The run's one-word verdict.
 *
 * `idle` is the distinction that keeps this useful: a drained backlog published
 * nothing and is not a failure — exit 1 there would cry wolf on every quiet
 * night — but it is not the same as three MRs either, so it gets its own code
 * rather than borrowing `published`'s zero.
 */
export type RunVerdict =
  /** At least one MR is open because of this run, and the run finished. */
  | 'published'
  /** It published, then died on a definitive failure. Reported, still non-zero. */
  | 'published-then-died'
  /**
   * Every iteration it ran was lost to the host — #31's criterion 4, which this
   * verdict is the exit code for. Its own value rather than `sterile` because the
   * ledger drain may still have opened a PREVIOUS run's MR before the first
   * iteration died: claiming "nothing was published" would send the operator
   * looking for a publish that did happen. The exit code is non-zero either way.
   */
  | 'all-iterations-lost'
  /** It had work to do, or died trying, and no MR came out of it. */
  | 'sterile'
  /** There was nothing to do. */
  | 'idle';

/** The books. Every field is derived; nothing here is read back from a host. */
export interface RunSummary {
  readonly ranIterations: number;
  readonly maxIterations: number;
  readonly lost: readonly LostIterationRecord[];
  readonly published: readonly PublishedMr[];
  /** Issues whose MR was opened by the #26 drain, not by this run's own work. */
  readonly resumed: readonly number[];
  readonly abandoned: readonly AbandonedTicket[];
  /** The same abandonments grouped by cause, in {@link ABANDON_ORDER}; empty groups dropped. */
  readonly abandonedByReason: readonly { readonly reason: AbandonReason; readonly issues: readonly number[] }[];
  readonly chain: ChainReport;
  readonly stop: StopReason;
  readonly verdict: RunVerdict;
}

/** What main.ts hands the fold: the events, plus the two run facts events do not carry. */
export interface RunSummaryInput {
  readonly events: readonly RunEvent[];
  readonly maxIterations: number;
  readonly chainRequested: boolean;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** `iteration:issue` — the identity of one attempt. A re-planned ticket is a NEW attempt. */
const attemptKey = (iteration: number, issue: number): string => `${iteration}:${issue}`;

/**
 * Fold the run's events into its books. Pure and total: any event list — including
 * an empty one, or one missing the `stopped` it should have had — produces a
 * summary, because a run that ends in a shape nobody anticipated is precisely
 * when the operator needs the books to still balance.
 */
export function summarizeRun(input: RunSummaryInput): RunSummary {
  const { events, maxIterations, chainRequested } = input;

  let ranIterations = 0;
  const lost: LostIterationRecord[] = [];
  const published: PublishedMr[] = [];
  const resumed: number[] = [];
  // Attempt-keyed so a ticket re-planned in a later round is a fresh attempt with
  // its own outcome — round 1's push failure and round 2's publish are two facts,
  // not one contradiction.
  const publishedKeys = new Set<string>();
  const recorded = new Map<string, AbandonedTicket>();
  const plannedAttempts: { iteration: number; issue: number }[] = [];
  const lostIterationNumbers = new Map<number, LostIterationRecord>();
  const chainModes = new Map<number, ChainMode>();
  let ticketFallbacks = 0;
  let stop: StopReason = 'unknown';

  for (const event of events) {
    switch (event.kind) {
      case 'iteration-started':
        ranIterations += 1;
        break;
      case 'iteration-lost': {
        const record = { iteration: event.iteration, reason: event.reason, detail: event.detail };
        lost.push(record);
        lostIterationNumbers.set(event.iteration, record);
        break;
      }
      case 'chain-decided':
        chainModes.set(event.iteration, event.mode);
        break;
      case 'chain-ticket-unchained':
        ticketFallbacks += 1;
        break;
      case 'planned':
        for (const issue of event.issues) plannedAttempts.push({ iteration: event.iteration, issue });
        break;
      case 'published':
        published.push({
          iteration: event.iteration,
          issue: event.issue,
          branch: event.branch,
          base: event.base,
        });
        publishedKeys.add(attemptKey(event.iteration, event.issue));
        break;
      case 'resumed':
        resumed.push(event.issue);
        break;
      case 'abandoned':
        recorded.set(attemptKey(event.iteration, event.issue), {
          iteration: event.iteration,
          issue: event.issue,
          reason: event.reason,
          detail: event.detail,
        });
        break;
      case 'stopped':
        stop = event.reason;
        break;
    }
  }

  // Abandonment is DERIVED, never counted at the sites: every attempt the run
  // committed to that did not end in a published MR is one, and it gets the cause
  // the run recorded — or, failing that, the one the books can still prove.
  const abandoned: AbandonedTicket[] = [];
  for (const { iteration, issue } of plannedAttempts) {
    const key = attemptKey(iteration, issue);
    if (publishedKeys.has(key)) continue;
    const explicit = recorded.get(key);
    if (explicit) {
      abandoned.push(explicit);
      continue;
    }
    const outage = lostIterationNumbers.get(iteration);
    abandoned.push(
      outage
        ? {
            iteration,
            issue,
            reason: 'host-unavailable',
            detail: `iteration ${iteration} was lost to the host (${outage.reason}): ${outage.detail}`,
          }
        : {
            iteration,
            issue,
            reason: 'unknown',
            detail: 'no cause was recorded for this ticket — the run cannot say why it did not publish',
          },
    );
  }

  const abandonedByReason = ABANDON_ORDER.map((reason) => ({
    reason,
    issues: abandoned.filter((t) => t.reason === reason).map((t) => t.issue),
  })).filter((group) => group.issues.length > 0);

  const modes = [...chainModes.values()];
  const iterationsOn = modes.filter((mode) => mode === 'on').length;
  const iterationsOff = modes.filter((mode) => mode === 'off').length;
  const chain: ChainReport = {
    requested: chainRequested,
    iterationsOn,
    iterationsOff,
    // No round decided (a run that never reached a planner) reads `off`: nothing
    // was chained, whatever the flag asked for.
    effective: iterationsOn === 0 ? 'off' : iterationsOff === 0 ? 'on' : 'mixed',
    ticketFallbacks,
  };

  return {
    ranIterations,
    maxIterations,
    lost,
    published,
    resumed,
    abandoned,
    abandonedByReason,
    chain,
    stop,
    verdict: decideVerdict({
      opened: published.length + resumed.length,
      stop,
      ranIterations,
      hadWork: plannedAttempts.length > 0,
      lost: lost.length,
    }),
  };
}

/**
 * The verdict, from the four facts that decide it.
 *
 * The awkward case is the run that published nothing. It is `sterile` only if it
 * had something to publish: tickets it committed to, an iteration it lost, or a
 * fatal failure that ended it. A loop that ran, found an empty queue and stopped
 * is `idle` — nothing to do is not a failure, and calling it one would make the
 * exit code useless on exactly the nights it is supposed to be quiet.
 */
function decideVerdict(facts: {
  opened: number;
  stop: StopReason;
  ranIterations: number;
  hadWork: boolean;
  lost: number;
}): RunVerdict {
  // Checked BEFORE `opened`, and this order is the whole of #31's criterion 4: the
  // ledger drain runs before the first iteration, so a run can open a previous
  // run's missing MR and then lose all ten of its own iterations to a 503. Ruling
  // on `opened` first would call that run `published` and exit 0 — the exact
  // signal #31 added a non-zero exit to prevent.
  if (facts.ranIterations > 0 && facts.lost === facts.ranIterations) return 'all-iterations-lost';
  if (facts.opened > 0) return facts.stop === 'fatal' ? 'published-then-died' : 'published';
  // `only-no-match` counts as attempted: the operator named the tickets they wanted
  // and got none of them. Calling that `idle` would report "the backlog is drained"
  // for the one mistake this path exists to catch (a ticket never labelled).
  const attempted =
    facts.hadWork || facts.lost > 0 || facts.stop === 'fatal' || facts.stop === 'only-no-match';
  return attempted && facts.ranIterations > 0 ? 'sterile' : 'idle';
}

/**
 * The exit code — the same verdict, in the one word automation reads.
 *
 *   0 — an MR is open because of this run;
 *   1 — the run had work (or died) and published nothing;
 *   2 — there was nothing to do.
 *
 * Three codes, not two: collapsing `idle` into 0 is the `All done` this module
 * replaces, and collapsing it into 1 would make a drained backlog look broken.
 */
export function exitCodeFor(summary: RunSummary): 0 | 1 | 2 {
  switch (summary.verdict) {
    case 'published':
      return 0;
    case 'published-then-died':
    case 'all-iterations-lost':
    case 'sterile':
      return 1;
    case 'idle':
      return 2;
  }
}

// ---------------------------------------------------------------------------
// The rendering — a view of the fold, and nothing more
// ---------------------------------------------------------------------------

const STOP_PROSE: Record<StopReason, string> = {
  'iterations-exhausted': 'the iteration budget was spent',
  'queue-empty': 'the queue was empty — the backlog is drained',
  'only-no-match': 'SANDCASTLE_ONLY matched none of the planned issues',
  'no-commits': 'a round produced no commits, so it had nothing to publish',
  'implementers-failed': 'every branch of a round lost its implementer before it could commit',
  fatal: 'a definitive failure ended the run',
  unknown: 'the loop ended without recording why',
};

const VERDICT_PROSE: Record<RunVerdict, string> = {
  published: 'published',
  'published-then-died': 'published, then died',
  'all-iterations-lost': 'STERILE — every iteration was lost to the host',
  sterile: 'STERILE — nothing was published',
  idle: 'idle — there was nothing to do',
};

/** `1 MR` / `3 MRs` — a summary whose own counters read wrong is not one to trust. */
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The operator-facing summary block. A pure function of the books: every number
 * and every name below is read off `summary`, so no line here can claim
 * something the fold does not hold (criterion 5).
 */
export function renderRunSummary(summary: RunSummary): string {
  const lines: string[] = ['=== Run summary ==='];

  const iterations =
    summary.ranIterations === 0
      ? `0 of ${summary.maxIterations} — the loop never ran an iteration`
      : `${summary.ranIterations} of ${summary.maxIterations} run`;
  const lostNote =
    summary.lost.length === 0
      ? ''
      : ` (${plural(summary.lost.length, 'lost to a host failure', 'lost to host failures')}: ` +
        // `iteration 2 (outage)`, never `#2`: two lines below, `#41` is an ISSUE, and
        // one block cannot spend `#` on both without being misread.
        summary.lost.map((l) => `iteration ${l.iteration} (${l.reason})`).join(', ') +
        ')';
  lines.push(`  iterations         ${iterations}${lostNote}`);

  lines.push(
    summary.published.length === 0
      ? '  MRs published      0'
      : `  MRs published      ${summary.published.length} — ` +
        summary.published.map((mr) => `#${mr.issue} (${mr.branch} → ${mr.base})`).join(', '),
  );
  if (summary.resumed.length > 0) {
    lines.push(
      `  MRs resumed        ${summary.resumed.length} — #${summary.resumed.join(', #')} ` +
        `(a previous run's pushed branch, finished by the ledger drain)`,
    );
  }

  lines.push(`  tickets abandoned  ${summary.abandoned.length}`);
  for (const group of summary.abandonedByReason) {
    lines.push(`      ${group.reason.padEnd(18)} #${group.issues.join(', #')}`);
    // The cause's own words, once per ticket: the label says what KIND of failure
    // it was, and only the detail says which failure — the difference between a
    // countable summary and an actionable one.
    for (const ticket of summary.abandoned.filter((t) => t.reason === group.reason)) {
      lines.push(`        · #${ticket.issue} (iteration ${ticket.iteration}): ${ticket.detail}`);
    }
  }

  const { chain } = summary;
  const fallbacks =
    chain.ticketFallbacks === 0
      ? ''
      : ` — ${plural(chain.ticketFallbacks, 'ticket')} fell back to its label base`;
  // The round split and the fallback count are only ever interesting when a stack
  // was ASKED for: "requested off, applied off (on in 0 of 2 rounds)" is three ways
  // of saying nothing, on every unchained run there will ever be.
  const decided = chain.iterationsOn + chain.iterationsOff;
  const split =
    chain.requested && decided > 0
      ? ` (on in ${chain.iterationsOn} of ${plural(decided, 'round')})`
      : '';
  lines.push(
    `  chained mode       requested ${chain.requested ? 'on' : 'off'}, ` +
      `applied ${chain.effective}${split}${fallbacks}`,
  );

  lines.push(`  stopped because    ${STOP_PROSE[summary.stop]}`);
  lines.push(`  verdict            ${VERDICT_PROSE[summary.verdict]} (exit ${exitCodeFor(summary)})`);

  return lines.join('\n');
}
