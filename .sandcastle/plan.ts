// Parse the planner agent's <plan> handoff and resolve an issue's base branch from
// its labels — config-driven, with no project-specific constants baked in.
//
// The planner emits exactly one <plan>{ "issues": [...] }</plan> block; main.ts turns
// that list into one sandbox/branch per issue. Kept in its own module so it can be
// unit-tested (plan.test.ts) without importing main.ts, whose top-level loop would
// run on import.
//
// Base-branch resolution is label-driven and reads the project's `labelBases` map +
// `baseBranch` (see config.ts). A ticket carrying a label in the map forks from — and
// targets — that label's base; every other ticket uses `baseBranch`. This is what lets
// the same code serve a repo with per-effort epic branches (design-system's RGAA epic)
// and a repo with a single trunk, with the difference living entirely in config.

/** A single issue the planner chose for this round. */
export interface PlannedIssue {
  number: number;
  title: string;
  branch: string;
  /**
   * Base the planner *believes* applies. Advisory only — main.ts re-derives it from
   * the issue's labels (the authoritative source). Absent when the planner omitted it
   * or named a ref outside `allowedBases`.
   */
  base?: string;
}

/**
 * Shape a planner-proposed branch name must have.
 *
 * The branch is agent-authored and ends up in `git push`, `git log` and `glab mr
 * create` arguments. Those go through argv rather than a shell string, so this is
 * defence in depth, not the only barrier — but a name with a space, a `;` or a
 * `$(…)` in it is a bug either way, and cheaper to reject here than to debug a
 * half-created MR. Deliberately narrower than git's own rules.
 */
const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The set of bases a run is allowed to fork from. Built in main.ts from the project
 * config — `baseBranch`, the `labelBases` values and `chainableBases` — and passed
 * into {@link parsePlan} so the planner's advisory `base` can be checked against
 * exactly the bases this project uses.
 */
export type AllowedBases = readonly string[];

/**
 * Authoritative base-branch rule, derived from an issue's labels via the project's
 * `labelBases` map. First matching label (in the order the host returns them) wins;
 * no match → `defaultBase` (the project's `baseBranch`).
 *
 * Host-side and label-driven on purpose: the base ends up as a `git worktree` fork
 * point and a `--target-branch` argument, so it must not depend on an agent getting
 * a label lookup right — which is also why the planner's own `base` is only ever a
 * cross-check, never the source of truth.
 */
export function baseForLabels(
  labels: readonly string[],
  labelBases: Readonly<Record<string, string>>,
  defaultBase: string,
): string {
  for (const label of labels) {
    const base = labelBases[label];
    if (base !== undefined) return base;
  }
  return defaultBase;
}

/**
 * The subset of a queued issue this module needs to derive a base: its number (for
 * the `SANDCASTLE_ONLY` narrowing) and its labels. `host.ts`'s `QueueIssue`
 * satisfies it structurally, so plan.ts keeps importing nothing.
 */
export interface QueueTicket {
  readonly number: number;
  readonly labels: readonly string[];
}

/**
 * The distinct bases a round's queued tickets derive — the input to the planner's
 * chain mode (issue #30, `decidePlannerChainMode` in chain.ts) and to the dry
 * run's chain report.
 *
 * Each ticket's base comes from {@link baseForLabels}, the same authoritative walk
 * main.ts runs per planned issue — never the planner's advisory `base`.
 *
 * `only` narrows the input exactly as it narrows the round ({@link applyOnly}
 * enforces the same restriction on the plan): a round restricted to one `main`
 * ticket must not be told the chain is on because a DIFFERENT queued ticket
 * carries the epic label. `null` (env unset) is an unrestricted round.
 *
 * Order follows the queue, deduped — the result is quoted back to the operator in
 * the downgrade message, so a repeated base would read as noise. Empty (nothing
 * queued, or `only` matching nothing) is a legitimate answer and is what
 * `decidePlannerChainMode` treats as "no downgrade".
 */
export function queueChainBases(
  queue: readonly QueueTicket[],
  cfg: {
    labelBases: Readonly<Record<string, string>>;
    baseBranch: string;
    only: readonly number[] | null;
  },
): string[] {
  const allow = cfg.only === null ? null : new Set(cfg.only);
  const bases = new Set<string>();
  for (const ticket of queue) {
    if (allow !== null && !allow.has(ticket.number)) continue;
    bases.add(baseForLabels(ticket.labels, cfg.labelBases, cfg.baseBranch));
  }
  return [...bases];
}

// Extract and parse the <plan> block. Throws when the tag is absent (the planner
// misbehaved — fail the iteration loudly). An explicit empty issues list is valid
// and signals the backlog is drained.
//
// Shape is validated rather than trusted: a string `number` would reach the host as
// `glab issue view NaN`, and an empty `branch` would have createSandbox fork a
// nameless branch — both fail far from here, with an opaque message.
export function parsePlan(stdout: string, allowedBases: AllowedBases): PlannedIssue[] {
  const match = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!match) {
    throw new Error('Planner did not produce a <plan> tag.\n\n' + stdout);
  }
  const parsed = JSON.parse(match[1] ?? '') as { issues?: unknown };
  const raw = parsed.issues;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`Planner emitted a non-array \`issues\`: ${JSON.stringify(raw)}`);
  }

  return raw.map((entry): PlannedIssue => {
    const issue = entry as Partial<PlannedIssue>;
    if (typeof issue.number !== 'number' || !Number.isInteger(issue.number)) {
      throw new Error(`Planned issue has no integer \`number\`: ${JSON.stringify(entry)}`);
    }
    if (typeof issue.branch !== 'string' || issue.branch.trim() === '') {
      throw new Error(`Planned issue #${issue.number} has no \`branch\`.`);
    }
    if (!BRANCH_SHAPE.test(issue.branch)) {
      throw new Error(
        `Planned issue #${issue.number} has an unusable branch name ` +
          `${JSON.stringify(issue.branch)}: expected ${String(BRANCH_SHAPE)}.`,
      );
    }
    if (typeof issue.title !== 'string' || issue.title.trim() === '') {
      throw new Error(`Planned issue #${issue.number} has no \`title\`.`);
    }
    // Drop rather than throw: the base is advisory, and main.ts asks the host
    // anyway. Throwing here would sink a whole round over a cosmetic field.
    const base =
      typeof issue.base === 'string' && allowedBases.includes(issue.base) ? issue.base : undefined;
    return base === undefined
      ? { number: issue.number, title: issue.title, branch: issue.branch }
      : { number: issue.number, title: issue.title, branch: issue.branch, base };
  });
}

/**
 * Apply the `SANDCASTLE_ONLY` operator restriction to a planned set: keep only the
 * issues whose number is in `only`, drop the rest. `only === null` (the env unset)
 * is an unrestricted round — everything is kept.
 *
 * The planner is also told the allow-list (it cannot read process.env), but the
 * planner is an agent, so main.ts calls this to *enforce* the restriction on
 * whatever the planner actually returned. `SANDCASTLE_FORCE` (re-run issues that
 * already have an open MR) is a planner concern only — it changes what the planner
 * proposes, not what this filter accepts, so it has no place here.
 */
export function applyOnly(
  issues: readonly PlannedIssue[],
  only: number[] | null,
): { kept: PlannedIssue[]; dropped: PlannedIssue[] } {
  if (only === null) return { kept: [...issues], dropped: [] };
  const allow = new Set(only);
  const kept: PlannedIssue[] = [];
  const dropped: PlannedIssue[] = [];
  for (const issue of issues) (allow.has(issue.number) ? kept : dropped).push(issue);
  return { kept, dropped };
}
