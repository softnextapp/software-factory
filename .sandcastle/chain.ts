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
