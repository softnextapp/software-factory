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
 *  - feasible — at least one derivable base is chainable; `chainable` lists which,
 *    in derivable order (trunk first).
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
  const derivable = derivableBases(cfg.baseBranch, cfg.labelBases);
  const chainable = derivable.filter((base) => cfg.chainableBases.includes(base));
  if (chainable.length === 0) {
    return {
      feasible: false,
      reason: 'no-chainable-base',
      message: buildNoChainableBaseMessage(derivable, cfg.chainableBases),
    };
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
 *
 * It also states the two lists it compared, because "no base can chain" alone does
 * not tell the operator WHICH of the two mistakes they made — an empty
 * `chainableBases`, or one naming a branch no ticket derives. An earlier draft
 * hard-coded the first diagnosis, which was simply false on a fresh consumer where
 * both settings are empty.
 */
function buildNoChainableBaseMessage(
  derivable: readonly string[],
  chainableBases: readonly string[],
): string {
  return (
    'SANDCASTLE_CHAIN=1 mais aucune base de ce round ne peut chaîner.\n' +
    `  - bases que les tickets peuvent dériver (\`baseBranch\` + valeurs de \`labelBases\`) : ${quoteList(derivable)} ;\n` +
    `  - bases déclarées chaînables (\`chainableBases\`) : ${quoteList(chainableBases)}.\n` +
    'Les deux ensembles ne se recoupent pas. Le chaînage exige les DEUX réglages ensemble :\n' +
    '  - `labelBases` (config.ts) : label → branche de base, pour que les tickets de l’effort ' +
    'atterrissent sur une branche commune plutôt que sur le tronc ;\n' +
    '  - `chainableBases` (config.ts) : les bases éligibles au chaînage — la valeur de ' +
    '`labelBases` de l’effort (ou `baseBranch` pour un dépôt plat).\n' +
    'Aucun des deux ne suffit seul : `labelBases` sans `chainableBases` laisse le chaînage ' +
    'inerte, et `chainableBases` sans la valeur `labelBases` correspondante nomme une base ' +
    'qu’aucun ticket ne dérive. Corrigez config.ts, ou lancez sans SANDCASTLE_CHAIN pour un ' +
    'round non chaîné.'
  );
}

/** Branch names as a backticked list, or `aucune` — an empty list is a diagnosis, not a blank. */
function quoteList(branches: readonly string[]): string {
  if (branches.length === 0) return 'aucune';
  return branches.map((branch) => `\`${branch}\``).join(', ');
}

// ---------------------------------------------------------------------------
// Planner chain mode (issue #30)
//
// What the previous wave got wrong: CHAIN_MODE used to be read off the operator's
// flag (`cfg.run.chain ? 'on' : 'off'`), i.e. the INTENT. But plan-prompt.md
// relaxes the `Blocked by:` rule when it reads `on` — a ticket blocked by a
// still-open issue becomes workable "because the stack puts the blocker's code
// under the branch". Promise the planner a mode no branch will honour, and it
// selects tickets whose designated inheritance is not in the tree the
// implementer receives. Observed 17 Aug 2026: the planner asked for the previous
// ticket's branch as base, "en mode chaîné, ce code est déjà sous la branche";
// chainableBases named no base those tickets derived, main.ts fell back to the
// trunk, and the run had to be stopped by hand.
//
// The mode therefore states a fact about the ROUND, and derives from the #24
// predicate plus the bases the round's QUEUED tickets derive:
//
//   - chain off the config                    → `off` (nobody asked; no warning);
//   - chain on + a queued chainable base      → `on`, behaviour unchanged;
//   - chain on but NO queued ticket derives
//     a chainable base                        → `off`, and a message saying the
//                                               mode was downgraded and why —
//                                               every possible selection builds
//                                               unchained, so the relaxed
//                                               `Blocked by:` rule would be a
//                                               lie even though the config is
//                                               feasible (#24 accepted exactly
//                                               this shape as legal).
//
// Computed per iteration, from the queue the planner is about to see: the plan
// does not exist yet when the mode is substituted into the prompt, so the queue
// is the round's reality. The queue's bases are derived host-side from each
// issue's labels — the same authoritative source resolveBase uses — never from
// the planner's advisory `base`.
// ---------------------------------------------------------------------------

/** What `{{CHAIN_MODE}}` in plan-prompt.md should be, given what the round can build. */
export type PlannerChainMode = 'on' | 'off';

/**
 * The decision main.ts prints and substitutes. `downgraded`/`message` are
 * absent on every non-degraded path: `message` exists to be logged, and there
 * is nothing to say when the mode matches the operator's ask.
 */
export type PlannerChainDecision =
  | { mode: 'on' }
  | { mode: 'off'; downgraded: boolean; message: string };

/**
 * Derive the chain mode the planner is TOLD from the feasibility verdict (the
 * #24 predicate — must the run chain at all?) crossed with the bases the
 * round's queued tickets derive. Pure; main.ts supplies `queueBases` from the
 * host-side label walk and owns the logging.
 *
 * An EMPTY queue is deliberately not a downgrade: it selects nothing, so no
 * selection can rest on a missing stack, and the empty plan ends the round
 * before any mode matters.
 */
export function decidePlannerChainMode(cfg: {
  feasibility: ChainFeasibility;
  queueBases: readonly string[];
}): PlannerChainDecision {
  // `off` (chain not asked) and `no-chainable-base` (the run was refused before
  // the planner) both mean no stack exists to promise. Neither is a downgrade:
  // in the first nobody asked, in the second main.ts threw already.
  if (!cfg.feasibility.feasible) return { mode: 'off', downgraded: false, message: '' };
  const chainable: readonly string[] = cfg.feasibility.chainable;
  const chainableQueueBases = cfg.queueBases.filter((base) => chainable.includes(base));
  if (chainableQueueBases.length > 0) return { mode: 'on' };
  // The queue cannot chain: every ticket it holds derives a base outside
  // `chainable`. Distinct from #24's refusal — there a base COULD chain but no
  // ticket derives it; here the tickets themselves are the missing half. The
  // mode falls to `off`, matching what every branch of this round will build.
  if (cfg.queueBases.length === 0) return { mode: 'on' };
  return {
    mode: 'off',
    downgraded: true,
    message:
      `CHAIN_MODE rétrogradé à \`off\` : aucune base des tickets en file ne peut chaîner.\n` +
      `  - bases dérivées par les tickets en file : ${quoteList(cfg.queueBases)} ;\n` +
      `  - bases chaînables (\`chainableBases\`) : ${quoteList(chainable)}.\n` +
      `Le chaînage reste demandé (\`SANDCASTLE_CHAIN\`) et la configuration est valide (#24), ` +
      `mais ce round-ci bâtira sans pile : le planner raisonne en mode \`off\`, la règle ` +
      `\`Blocked by:\` n'est pas assouplie, et chaque ticket partira de sa base de label.\n` +
      `Reprenez le ticket sur la branche chaînable (label \`labelBases\`), ou ajoutez la base ` +
      `des tickets en file à \`chainableBases\` (config.ts).`,
  };
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
