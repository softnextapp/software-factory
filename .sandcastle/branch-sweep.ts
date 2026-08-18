// Per-run agent-branch naming + the startup sweep of dead runs' empty branches.
// Issue #28.
//
// The cause
// ---------
// main.ts used to suffix an agent branch with `-r${iteration}`. That protects
// WITHIN a run (iteration 2 forks a new branch, not the one iteration 1 left) but
// not BETWEEN runs: a relance starts again at iteration 1 and lands exactly on the
// `…-r1` branch a killed run left behind. The Engine then reuses the existing
// branch — `baseBranch` is ignored for a branch that already exists — so the
// ticket silently forks from the dead run's base, whatever it was. On 17 August
// 2026 that meant a ticket about to fork from a staging base would have restarted
// from `main`, reopening a divergence that had just been closed by hand.
//
// Two effects, shipped together because they close one hole each:
//   1. mintRunId()/buildRunBranch() name a branch after the RUN (the wall clock at
//      startup), so two runs never mint the same name — the resurrected-branch
//      path disappears.
//   2. decideSweep() is the startup net: an agent branch with no commit of its own
//      and no open MR is dead weight a later planner could pick up; the sweep
//      deletes it (with its worktree) and says why. Branches that carry commits or
//      an MR are untouchable — old and abandoned is not empty.
//
// Purity contract (issue #28, acceptance #5): every function here is pure. The
// git commands that gather the facts and act on the verdict live in main.ts; the
// decision itself takes plain data, so it is unit-tested with no git, no fs and
// no network — the seam chain.ts (decideBaseSync) and image.ts established.

/** The agent-branch namespace every Factory run forks its work into. */
const AGENT_BRANCH_PREFIX = 'sandcastle/';

/** A run id as minted by mintRunId(): `YYYYMMDD-HHMMSS` — compact, sortable, readable in a branch name. */
export type RunId = string;

/**
 * The identity of ONE run, from the clock read at its startup: `YYYYMMDD-HHMMSS`,
 * UTC so the id keeps sorting across a machine's DST jumps.
 *
 * Pure by parameter: main.ts hands in the `Date`, so the format is testable here
 * rather than hidden in an IIFE next to the loop.
 *
 * SECONDS, not minutes: the acceptance criterion is that two successive runs never
 * mint the same branch name for one ticket, and a relance of a killed run lands
 * within the same minute routinely — that is the very shape of the incident this
 * closes. Two relances inside the same SECOND is not reachable: a run reads its
 * queue and plans before it forks a single branch.
 */
export function mintRunId(now: Date): RunId {
  const iso = now.toISOString(); // `2026-08-18T09:30:41.000Z`
  const date = iso.slice(0, 10).replaceAll('-', '');
  const clock = iso.slice(11, 19).replaceAll(':', '');
  return `${date}-${clock}`;
}

/**
 * The full branch name a run forks for one ticket: `<planner-branch>-r<run>-<iteration>`.
 *
 * Unique per (ticket, run): the run id differs across two relances of the same
 * ticket, and the iteration still differs within a run, so the old `-r${iteration}`
 * guarantee survives unchanged. Pure — main.ts supplies the run id once per run.
 */
export function buildRunBranch(plannerBranch: string, runId: RunId, iteration: number): string {
  return `${plannerBranch}-r${runId}-${iteration}`;
}

/**
 * Whether a local branch belongs to the Factory's agent namespace. The sweep only
 * ever looks at these: `main`, an epic base, a colleague's `feature/x` are not
 * ours, however stale. The planner's naming rule (plan-prompt.md) puts every
 * ticket branch under `sandcastle/`, which is also the Engine's own prefix for
 * unnamed runs — both are Factory-managed, so both qualify.
 */
export function isAgentBranch(branch: string): boolean {
  return branch.startsWith(AGENT_BRANCH_PREFIX);
}

/**
 * The current run's branch names, for every planned ticket × every iteration the
 * run may reach. The sweep refuses to delete any of them: they are about to be
 * created, and "no commits yet" is their normal state at startup, not a leftover.
 */
export function runBranchBases(
  planned: readonly { branch: string }[],
  runId: RunId,
  iterations: readonly number[],
): string[] {
  return planned.flatMap((issue) => iterations.map((i) => buildRunBranch(issue.branch, runId, i)));
}

/** The git facts the sweep decision needs, gathered host-side by main.ts. */
export interface BranchFacts {
  readonly branch: string;
  /** True when the branch has at least one commit no other local ref reaches. */
  readonly hasOwnCommits: boolean;
  /** True when an open MR/PR on the host has this branch as its source. */
  readonly hasOpenMr: boolean;
  /**
   * True when the branch shares any history with the project's trunk.
   *
   * NOT "its fork base still exists": a leftover forked from an old trunk tip has
   * no base ref of its own once the trunk moves on, and that is the exact shape
   * #28 must still sweep. What this rules out is unrelated history — a branch
   * grafted from elsewhere, which is not provably this repo's leftover.
   */
  readonly attachedToTrunk: boolean;
  /** True when the branch is checked out in a worktree (possibly a live run's). */
  readonly checkedOutElsewhere: boolean;
}

export interface SweepVerdict {
  readonly sweep: boolean;
  /** Why — always set, for both verdicts: the sweep logs kept branches too. */
  readonly reason: string;
}

/**
 * Whether a local agent branch is a dead run's leftover and may be deleted with
 * its worktree. PURE: no git here, only the facts above.
 *
 * Swept — all three must hold:
 *   - no commit of its own above any local ref (the branch is a bare pointer at
 *     its base: nothing was ever built on it);
 *   - no open MR (nothing on the host argues for keeping it);
 *   - it is attached to the trunk (otherwise it is not provably ours — see below).
 *
 * Never swept, in decreasing order of precedence:
 *   - it carries commits: real work, however old or abandoned (acceptance #3);
 *   - an open MR carries it: the host still knows the branch (acceptance #3);
 *   - checked out in a worktree: git would refuse the delete anyway, and the
 *     worktree may belong to a run that is still alive (acceptance #4);
 *   - unrelated history: no merge base with the trunk at all. `--not` emptiness
 *     alone is too thin a basis to delete a branch grafted from somewhere else.
 *     Left for the operator, like a diverged base in syncBaseToOrigin.
 */
export function decideSweep(facts: BranchFacts): SweepVerdict {
  if (facts.hasOwnCommits) {
    return { sweep: false, reason: 'carries commits — never swept, however old or abandoned' };
  }
  if (facts.hasOpenMr) {
    return { sweep: false, reason: 'has an open MR — never swept' };
  }
  if (facts.checkedOutElsewhere) {
    return { sweep: false, reason: 'checked out in another worktree — possibly a live run' };
  }
  if (!facts.attachedToTrunk) {
    return { sweep: false, reason: 'unrelated history — shares no commit with the trunk, kept' };
  }
  return { sweep: true, reason: 'no commit of its own and no MR — dead-run leftover' };
}

/**
 * The one-line record the startup sweep prints per branch it examines, so an
 * operator reading the log can audit every deletion (acceptance #2: the
 * suppression is journalisée avec son motif).
 */
export function describeSweep(verdict: SweepVerdict, branch: string): string {
  return `${branch} ${verdict.sweep ? 'swept' : 'kept'}: ${verdict.reason}`;
}
