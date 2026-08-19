// The per-iteration failure boundary of the run loop. Issue #31.
//
// The cause
// ---------
// A host read that survives every retry (issue #25's bounded backoff spent) or
// is definitive on its first attempt used to bubble out of the loop body in
// main.ts and kill the RUN: everything before it — iterations that delivered,
// branches pushed, MRs opened — stayed on disk but left the loop, and the eight
// iterations after it never ran. Observed 17 Aug 2026: a `gh issue list` in 503
// at iteration 2 of 10, AFTER the implementer had delivered.
//
// The fix has two halves. The retry (issue #25, host.ts) makes a transient
// outage survive a hiccup. This module is the second half — the boundary: when
// the retries ARE spent, the failure ends its ITERATION, and the loop moves on
// to the next one, which re-lists the queue on a host that may have healed.
//
// Not every failure earns that treatment. The boundary discriminates:
//
//   - a host read whose retries are exhausted — a long enough outage. LOSE the
//     iteration: the next iteration's first act is a fresh queue read, so the
//     run self-heals if the host comes back. Cheap to lose, expensive to die.
//   - a DEFINITIVE host failure (bad credentials, missing scope, exhausted
//     quota, client error) — STOP the run. Retrying ten iterations on an
//     invalid token is ten losses with a calm-looking log (issue #31,
//     criterion 3); the operator needs the failure, not nine repetitions of it.
//   - anything else (a config error, a bug in this loop, a sandbox crash that
//     is not a host read at all) — STOP the run. A bug must not read as an
//     outage; config errors never heal between iterations.
//
// A lost iteration is never a silent one (criterion 2): the run counts them,
// names each one's cause, and — if ALL its iterations were lost — ends
// non-zero, because a run that failed 9 times out of 10 must not exit like a
// run that delivered (criterion 4).
//
// Purity contract (same seam as chain.ts / branch-sweep.ts / publish.ts): every
// function here is pure — no CLI, no fs, no process. main.ts owns the try/catch
// and the log/exit effects; this module only decides. Tests: iteration.test.ts.

import { HostReadError, type HostFailureReason } from './host.ts';

/** Why one iteration ended without reaching its publish phase. */
export interface LostIteration {
  /** The iteration's 1-based number in the run. */
  readonly iteration: number;
  /** Short stable cause of the underlying failure — host.ts's closed union, not free text. */
  readonly reason: HostFailureReason;
  /** The thrown error, kept for the operator-facing log line. */
  readonly error: HostReadError;
}

/**
 * Whether a thrown error ends ONLY the iteration it landed in.
 *
 * True for a `HostReadError` whose failure was retryable in #25's sense — the
 * outage outlasted every backoff attempt. That is the "no longer transient, but
 * also not permanent in the next five minutes" band: unknown wordings classify
 * as retryable precisely so they land here (fail toward the lost iteration, not
 * the dead run) and still surface in the count.
 *
 * False for everything else:
 *   - a DEFINITIVE HostReadError (auth, not-found, quota-exhausted,
 *     client-error) — criterion 3's stop-the-run list;
 *   - a non-host error — a config mistake, a bug, a git failure. Losing an
 *     iteration over those would replace a loud loss with a quiet one, which is
 *     the exact regression the issue warns about.
 *
 * A type predicate, not a bare boolean: the caller that acts on `true` needs the
 * classification off the error, and an `as HostReadError` at the one site the
 * boundary must not get wrong is a cast the typechecker can hold instead.
 */
export function isLostIterationError(error: unknown): error is HostReadError {
  return error instanceof HostReadError && error.failure.retryable;
}

/**
 * Record one lost iteration for the run's tally. The caller has already ruled
 * with {@link isLostIterationError} that this error costs its iteration, so the
 * reason is read straight off the classification — the tally line carries a
 * LABEL ('outage', 'quota', 'unknown'…), not a diagnosis; the error's own first
 * line prints beside it and carries the detail.
 */
export function recordLostIteration(
  tally: readonly LostIteration[],
  iteration: number,
  error: HostReadError,
): LostIteration[] {
  return [...tally, { iteration, reason: error.failure.reason, error }];
}

/**
 * Whether a run whose loop has ended may report success.
 *
 * `ran === 0` (the loop never ran a single iteration — an operator interrupt,
 * or a startup break) is NOT an all-lost run: there is nothing to count, and
 * exit(1) there would be a new failure mode smuggled in with this fix. The
 * criterion is about a run that RAN and lost everything it ran.
 */
export function isRunLost(tally: readonly LostIteration[], ran: number): boolean {
  return ran > 0 && tally.length === ran;
}

/**
 * The per-iteration log line — the "se dit" of a lost iteration (criterion 2).
 * One line, and only the facts of THIS loss: which iteration, why, and that the
 * loop goes on. The durability reassurance lives in the end-of-run summary
 * instead ({@link describeIterationLosses}) — printed once there rather than
 * repeated under every loss, where it would bury the cause the criterion asks
 * for under boilerplate about branches this iteration never pushed.
 *
 * The cause is the error's first line. HostReadError already builds a one-line
 * message; the split is the belt that keeps this a single log line whatever the
 * verb or stderr turns out to contain.
 */
export function describeLostIteration(lost: LostIteration, maxIterations: number): string {
  const cause = lost.error.message.split('\n')[0]?.trim() || 'no message';
  return (
    `  ✗ iteration ${lost.iteration}/${maxIterations} lost (host ${lost.reason}): ${cause} — ` +
    `the run continues with the next iteration.`
  );
}

/**
 * The end-of-run summary line when at least one iteration was lost. Says the
 * count out loud so a run that failed 9 times out of 10 cannot read as calm, and
 * carries the durability note once: a lost iteration throws on a host READ, all
 * of which precede the round's first push, so it published nothing and discarded
 * nothing (criterion 5).
 */
export function describeIterationLosses(tally: readonly LostIteration[], ran: number): string {
  const which = tally.map((lost) => `#${lost.iteration}`).join(', ');
  const one = tally.length === 1;
  const noun = one ? 'iteration' : 'iterations';
  return (
    `${tally.length} of ${ran} ${noun} lost to host failures (${noun} ${which}). ` +
    `${one ? 'It ended' : 'Each ended'} before reaching the publish phase. Earlier iterations ` +
    `are untouched: pushed branches keep their commits, and a branch pushed without its MR is ` +
    `resumed by the next run (issue #26).`
  );
}
