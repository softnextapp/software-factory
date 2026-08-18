// The publish ledger — a durable trace of a branch that was PUSHED but whose
// Draft MR/PR creation failed. Issue #26.
//
// Why this exists
// ---------------
// Phase 3 catches a `createDraftChangeRequest` failure, prints the manual hint
// and moves on. That is correct but TERMINAL: nothing remembers "pushed, no MR".
// The planner only sets an issue aside when it has an OPEN MR, so a blind re-run
// re-picks the ticket and duplicates a full implement+review cycle on a `-r2`
// branch (observed 17 Aug 2026: `gh pr create` in 503, branch pushed and
// invisible on the board).
//
// So the run that fails writes a trace, and the NEXT run reads it before Phase 1
// and acts on it:
//
//   - an open MR now carries the branch   → the trace is resolved, erased;
//   - the branch is gone from origin      → merged-and-deleted or dropped; erased;
//   - otherwise                           → open the missing MR from the trace,
//                                           then erase it.
//
// The trace carries everything Phase 3 had already computed — the MR title and
// description built by mr-body.ts, the target base, the failure reason — so the
// resume opens the MR the failed run would have opened, without re-running a
// single agent. Erased-on-success keeps a later run from opening a duplicate.
//
// Everything but the two fs shells is pure: no CLI, no network, no process.env —
// the host read/create calls stay in main.ts, this module only decides. Same
// seam as chain.ts / plan.ts. Tests: publish.test.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import type { OpenMergeRequest } from './chain.ts';
import type { QueueIssue } from './host.ts';

/**
 * One "pushed without a MR" trace. Written by Phase 3 after a successful push
 * whose MR/PR creation failed; read — and erased — by the next run's drain.
 */
export interface PendingPublish {
  /** The issue the branch implements (matches the `Ralph: issue-#N` trailer). */
  readonly issue: number;
  /** The pushed branch — the ledger's key. */
  readonly branch: string;
  /** The base the MR was to target. */
  readonly base: string;
  /** The MR title Phase 3 had built (mr-body buildMrTitle). */
  readonly title: string;
  /** The MR description Phase 3 had built (mr-body buildMrDescription). */
  readonly description: string;
  /** Why the create failed, as the per-branch catch saw it. */
  readonly reason: string;
  /** The round that recorded the trace — provenance for the operator. */
  readonly round: number;
}

/**
 * Parse the ledger file. A missing/blank/unreadable payload yields [] — a
 * corrupt ledger must degrade to "nothing pending" (the pre-#26 behaviour),
 * never block the round. Rows missing the required fields are dropped, not
 * fatal: one odd row should not stop the drain, mirroring the MR-list parsers.
 */
export function parsePendingPublishes(raw: string): PendingPublish[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PendingPublish[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Partial<PendingPublish>;
    if (typeof row.issue !== 'number') continue;
    if (typeof row.branch !== 'string' || row.branch === '') continue;
    if (typeof row.base !== 'string' || row.base === '') continue;
    if (typeof row.title !== 'string' || row.title === '') continue;
    if (typeof row.description !== 'string') continue;
    if (typeof row.reason !== 'string') continue;
    if (typeof row.round !== 'number') continue;
    out.push({
      issue: row.issue,
      branch: row.branch,
      base: row.base,
      title: row.title,
      description: row.description,
      reason: row.reason,
      round: row.round,
    });
  }
  return out;
}

/**
 * The on-disk shape: 2-space-indented JSON ending in a newline. The ledger is
 * operator-readable by design — "which ticket is stuck?" should be answerable
 * with `cat .sandcastle/publish-pending.json` (issue #26, criterion 1).
 */
export function serializePendingPublishes(pending: readonly PendingPublish[]): string {
  return `${JSON.stringify(pending, null, 2)}\n`;
}

/**
 * Add a trace to a ledger, REPLACING any trace the same branch already carries:
 * a branch that failed to publish twice must leave one trace with the latest
 * reason and round, not a duplicate the drain would then try to open twice.
 * Newest last; the input array is not mutated.
 */
export function recordPendingPublish(
  pending: readonly PendingPublish[],
  trace: PendingPublish,
): PendingPublish[] {
  return [...pending.filter((entry) => entry.branch !== trace.branch), trace];
}

/** What the drain should do with one trace. */
export type ResumeDecision = 'create' | 'resolved' | 'gone';

/**
 * Decide how the next run handles one trace. Pure — the caller gathers the
 * facts, this only rules on them:
 *
 *  - `resolved`: an OPEN MR/PR already carries the branch as its source. Someone
 *    (the operator, a race) opened it; erasing the trace is the whole action.
 *    Checked first: a satisfied trace must never reach `create`, which would
 *    duplicate the MR (issue #26, criterion 3).
 *  - `gone`: the branch no longer exists on origin (merged with branch deletion,
 *    or dropped by hand). Nothing to open a MR from; erase and say why.
 *  - `create`: neither — the branch is pushed and MR-less, exactly the state the
 *    trace recorded. Open the missing MR.
 *
 * `remoteBranches` may be null (the origin listing itself failed — the same 503
 * again): `gone` is then undecidable, and the drain falls back to `create`, the
 * only decision that can make progress. An empty array is a REAL "origin has
 * lost the branch" and does yield `gone`.
 */
export function decideResume(
  trace: PendingPublish,
  openMrs: readonly OpenMergeRequest[],
  remoteBranches: readonly string[] | null = null,
): ResumeDecision {
  if (openMrs.some((mr) => mr.sourceBranch === trace.branch)) return 'resolved';
  if (remoteBranches !== null && !remoteBranches.includes(trace.branch)) return 'gone';
  return 'create';
}

/**
 * Hold pending issues out of the planner queue: a ticket with a pushed-but-MR-less
 * branch is resume work for the drain, not fresh work — feeding it to the planner
 * is exactly the duplicate `-r2` round issue #26 was filed for. Returns the queue
 * without the held issues plus the held issue numbers, for the log line.
 */
export function dropPendingIssues(
  queue: readonly QueueIssue[],
  pending: readonly PendingPublish[],
): { kept: QueueIssue[]; held: number[] } {
  const heldNumbers = new Set(pending.map((trace) => trace.issue));
  const kept: QueueIssue[] = [];
  const held: number[] = [];
  for (const issue of queue) {
    if (heldNumbers.has(issue.number)) held.push(issue.number);
    else kept.push(issue);
  }
  return { kept, held };
}

/** The dry-run's structured summary of the ledger (see main.ts's config report). */
export function pendingFileSummary(pending: readonly PendingPublish[]): {
  pending: number;
  issues: number[];
} {
  return { pending: pending.length, issues: pending.map((trace) => trace.issue) };
}

// ---------------------------------------------------------------------------
// fs shells — thin read/write wrappers the drain composes with the pure pieces
// above. Kept here so the ledger's on-disk format (array of PendingPublish,
// serialized by serializePendingPublishes) has exactly one owner.
// ---------------------------------------------------------------------------

/**
 * Read the ledger off disk; a missing file is the common fresh case and reads as
 * empty. Never throws — a corrupt ledger degrades to "nothing pending" (see
 * parsePendingPublishes).
 */
export function readPendingPublishes(path: string): PendingPublish[] {
  try {
    return parsePendingPublishes(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Persist the ledger. An empty ledger still writes `[]` — the erase is durable too. */
export function writePendingPublishes(path: string, pending: readonly PendingPublish[]): void {
  writeFileSync(path, serializePendingPublishes(pending));
}
