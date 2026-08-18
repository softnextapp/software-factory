// Stacked-MR base resolution: fork the next ticket off the PREVIOUS ticket's
// unmerged branch instead of off the epic branch.
//
// Why this exists
// ---------------
// The RGAA effort (#4 → #16) produces MRs faster than a human can review them.
// Without chaining, every ticket forks from `epic/rgaa-accessibilite`, so ticket
// N never sees ticket N-1's work: the queue stalls behind the review backlog, and
// what does get written duplicates or contradicts what is still sitting in a Draft
// MR. Chaining trades merge-order freedom for the ability to keep going.
//
// The shape it builds is a *stack*: each MR targets the one below it, so a MR's
// diff shows only its own ticket — which is the point, since the review backlog is
// the constraint being managed.
//
//   epic/rgaa-accessibilite ──●
//                              └─ issue-4-… ──●   MR !1 → epic          (root)
//                                              └─ issue-7-… ──●  MR !2 → issue-4
//                                                              └─ …     (head)
//
// The next ticket forks from, and targets, the HEAD of that stack.
//
// Consequences accepted (not bugs)
// --------------------------------
//   - MRs must be merged bottom-up. Merging !2 before !1 would drag !1's commits
//     into the epic under !2's name.
//   - When !1 merges and its source branch is deleted, GitLab retargets !2 onto
//     the epic on its own. If the branch is kept, !2 keeps pointing at a merged
//     branch and must be retargeted by hand. Nothing here does that.
//   - A rejected ticket poisons everything stacked above it. Bottom-up review
//     order is what keeps that cheap.
//
// Everything in this module is pure. host.ts owns the host IO — fetching the
// open MR/PR list from glab or gh and parsing each host's JSON into the
// `OpenMergeRequest` shape below; this module owns only the host-agnostic stack
// walk over that shape. So the walk is unit-tested (chain.test.ts) with no CLI,
// no network, and no GitLab or GitHub instance.

/** The subset of an open MR/PR the stack walk needs (host-agnostic). */
export interface OpenMergeRequest {
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  /** ISO 8601, as the host returns it. Only ever compared, never parsed. */
  createdAt: string;
  title: string;
  webUrl: string;
}

export interface ChainResolution {
  /** Branch to fork from AND to target the host's draft change request against. */
  base: string;
  /** True when `base` is a previous ticket's branch rather than the root. */
  chained: boolean;
  /** The stack from root to head, in merge order. Empty when nothing is open. */
  stack: OpenMergeRequest[];
  /**
   * Rival heads that were NOT chosen. Non-empty means the stack forked — someone
   * opened two MRs against the same branch — and the most recent one won. Worth
   * printing: the loser's work will not be visible to the ticket being started.
   */
  rivals: OpenMergeRequest[];
}

/**
 * Walk the stack rooted at `root` and return the branch the next ticket should
 * build on.
 *
 * An MR belongs to the stack when it targets `root`, or targets the source branch
 * of an MR already in the stack. The head is the stack member whose source branch
 * nothing else targets — the top of the pile.
 *
 * With no open MR on `root`, this returns `root` itself and `chained: false`:
 * chaining is not a mode that changes where the first ticket of a wave goes, only
 * where the second one does.
 */
export function resolveChainedBase(
  mrs: readonly OpenMergeRequest[],
  root: string
): ChainResolution {
  // Group by target once — the walk below is O(stack), not O(stack × mrs).
  const byTarget = new Map<string, OpenMergeRequest[]>();
  for (const mr of mrs) {
    const siblings = byTarget.get(mr.targetBranch);
    if (siblings) siblings.push(mr);
    else byTarget.set(mr.targetBranch, [mr]);
  }

  // Breadth-first from the root. `seen` guards against a branch cycle (A targets
  // B, B targets A) — impossible through this loop, trivially possible by hand,
  // and an infinite walk here would hang the round before any agent starts.
  const stack: OpenMergeRequest[] = [];
  const seen = new Set<string>([root]);
  const frontier = [root];
  while (frontier.length > 0) {
    const branch = frontier.shift() as string;
    for (const mr of byTarget.get(branch) ?? []) {
      if (seen.has(mr.sourceBranch)) continue;
      seen.add(mr.sourceBranch);
      stack.push(mr);
      frontier.push(mr.sourceBranch);
    }
  }

  if (stack.length === 0) return { base: root, chained: false, stack: [], rivals: [] };

  // A head is a stack member nothing else in the stack is built on.
  const targeted = new Set(stack.map((mr) => mr.targetBranch));
  const heads = stack.filter((mr) => !targeted.has(mr.sourceBranch));

  // Most recent wins, per the "last open MR" rule. iid breaks a createdAt tie
  // (same-second creations are real when a round publishes several MRs in a row);
  // without it the winner would depend on glab's page ordering.
  const sorted = [...heads].sort((a, b) =>
    a.createdAt === b.createdAt ? b.iid - a.iid : a.createdAt < b.createdAt ? 1 : -1
  );
  const head = sorted[0] as OpenMergeRequest;

  return {
    base: head.sourceBranch,
    chained: true,
    stack: orderedPath(stack, root, head),
    rivals: sorted.slice(1),
  };
}

/** The root→head path through the stack, i.e. the MRs that must merge, in order. */
function orderedPath(
  stack: readonly OpenMergeRequest[],
  root: string,
  head: OpenMergeRequest
): OpenMergeRequest[] {
  const bySource = new Map(stack.map((mr) => [mr.sourceBranch, mr]));
  const path: OpenMergeRequest[] = [];
  let current: OpenMergeRequest | undefined = head;
  while (current && current.sourceBranch !== root) {
    path.unshift(current);
    if (current.targetBranch === root) break;
    current = bySource.get(current.targetBranch);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Base-branch reconciliation (issue #14)
//
// Before forking agent branches, main.ts fast-forwards each base to origin so a
// round never builds on stale code. This is the PURE 3-way decision main.ts's
// syncBaseToOrigin composes with `git merge-base --is-ancestor`; the side-effecting
// fetch/merge itself stays in main.ts (chain.ts stays pure + host-agnostic).
// ---------------------------------------------------------------------------

export type BaseSyncDecision = 'fast-forward' | 'ahead' | 'diverged';

/**
 * How to reconcile a local base with its origin counterpart, given the two ancestry
 * facts. Called only when local ≠ origin (the equal case is in-sync and handled by
 * the caller).
 *
 *  - `originAheadOfLocal` (local is an ancestor of origin) → the remote is strictly
 *    ahead → a fast-forward brings local up to date.
 *  - `localAheadOfOrigin` (origin is an ancestor of local) → the local base is being
 *    curated ahead of origin → legitimate; leave it (never rewind a base).
 *  - neither → true divergence → fast-forward is impossible; warn and skip.
 */
export function decideBaseSync(rel: {
  originAheadOfLocal: boolean;
  localAheadOfOrigin: boolean;
}): BaseSyncDecision {
  if (rel.originAheadOfLocal) return 'fast-forward';
  if (rel.localAheadOfOrigin) return 'ahead';
  return 'diverged';
}

// ---------------------------------------------------------------------------
// Chain feasibility (issue #24)
//
// A run launched with SANDCASTLE_CHAIN=1 used to fall back to the plain label
// base without a word when no base was chainable — the revue incident (17 Aug
// 2026): a round was interrupted by hand after the built branch turned out to be
// missing the code its ticket selection had assumed. The README already
// documented the inertia; the execution was mute. This seam decides, purely, the
// two observable outcomes the issue asks for:
//
//   - no chainable base applies at all   → the run refuses BEFORE the planner;
//   - a specific ticket's base is out    → the log says so, per ticket.
//
// "Feasible" here is a CONFIG fact — chain active AND at least one derivable
// base chainable — not a statement that a stack is open. "No open MR on the
// root" is a legitimate first ticket of a wave (resolveChainedBase returns the
// root, `chained: false`), not a refusal; refusing there would stop an effort's
// first round ever starting.
// ---------------------------------------------------------------------------

/** The bases a round's tickets can actually derive: the trunk plus every `labelBases` value. */
export function derivableBases(
  baseBranch: string,
  labelBases: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([baseBranch, ...Object.values(labelBases)])];
}

/**
 * Can this round chain at all?
 *
 *  - `off` — chain is not active; nothing to declare (not an error).
 *  - `no-chainable-base` — chain is active but NO derivable base is chainable:
 *    either `chainableBases` is empty, or it names bases no ticket can derive.
 *    Both are the same operator mistake, and both get the same message naming
 *    `labelBases` AND `chainableBases` — neither setting suffices alone, so
 *    naming only one would leave the operator mid-way.
 *  - `ok` — at least one derivable base is chainable; `chainable` lists which.
 */
export type ChainFeasibility =
  | { feasible: false; reason: 'off' }
  | { feasible: false; reason: 'no-chainable-base'; message: string }
  | { feasible: true; chainable: string[] };

export function decideChainFeasibility(cfg: {
  chain: boolean;
  baseBranch: string;
  labelBases: Readonly<Record<string, string>>;
  chainableBases: readonly string[];
}): ChainFeasibility {
  if (!cfg.chain) return { feasible: false, reason: 'off' };
  const chainable = derivableBases(cfg.baseBranch, cfg.labelBases).filter((base) =>
    cfg.chainableBases.includes(base),
  );
  if (chainable.length === 0) {
    return { feasible: false, reason: 'no-chainable-base', message: buildNoChainableBaseMessage() };
  }
  return { feasible: true, chainable };
}

/**
 * The startup refusal. The two settings are named as a PAIR because they only
 * work together: `labelBases` decides what bases the round's tickets derive,
 * `chainableBases` decides which of those the chain may stack on — set either
 * one alone and chaining stays inert, which is exactly the silent mode this
 * guard exists to forbid. French like every operator-facing free text this
 * Factory emits (mr-body.ts); the quoted shape is the issue's own wording.
 */
function buildNoChainableBaseMessage(): string {
  return (
    'SANDCASTLE_CHAIN=1 mais aucune base de ce round ne peut chaîner : `chainableBases` est ' +
    'vide, ou ne nomme aucune base qu’un ticket puisse atteindre. Le chaînage exige les DEUX ' +
    'réglages ensemble :\n' +
    '  - `labelBases` (config.ts) : label → branche de base, pour que les tickets de l’effort ' +
    'atterrissent sur une branche commune plutôt que sur le tronc ;\n' +
    '  - `chainableBases` (config.ts) : les bases éligibles au chaînage — la valeur de ' +
    '`labelBases` de l’effort (ou `baseBranch` pour un dépôt plat).\n' +
    'Aucun des deux ne suffit seul : `labelBases` sans `chainableBases` laisse le chaînage ' +
    'inerte (le cas présent), et `chainableBases` sans la valeur `labelBases` correspondante ' +
    'nomme une base qu’aucun ticket ne dérive. Corrigez config.ts, ou lancez sans ' +
    'SANDCASTLE_CHAIN pour un round non chaîné.'
  );
}

/**
 * The per-ticket warning for a base outside `chainableBases`: names the ticket,
 * its base, and the consequence — this ticket forks from and targets the plain
 * base and will not see the stack. Empty when the base chains (the common case;
 * a chained round must not print a warning per ticket).
 */
export function buildUnchainableBaseWarning(
  issueNumber: number,
  base: string,
  chainableBases: readonly string[],
): string {
  if (chainableBases.includes(base)) return '';
  return (
    `#${issueNumber} → base \`${base}\`, hors \`chainableBases\` : ce ticket ne verra pas la pile — ` +
    `il part de \`${base}\` et y cible sa demande de fusion, comme si le chaînage était inactif. ` +
    `Ajoutez \`${base}\` à \`chainableBases\` (config.ts) si ce ticket doit chaîner.`
  );
}
