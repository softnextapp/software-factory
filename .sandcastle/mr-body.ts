// Draft-MR title and description — the reviewer-facing surface of a Sandcastle run.
//
// Why this file exists: a Draft MR whose title is `git log -1 --format=%s` and whose
// description is one static sentence forces the human reviewer to reconstruct, from
// the diff alone, everything the agents already knew — the issue's intent, what was
// deliberately left out, which findings the review raised and what became of them.
// That reconstruction is the expensive part of reviewing, and it was being thrown
// away at the end of every round.
//
// Two sources feed the body, and the split matters:
//
//   1. DERIVED, host-side, never trusted to an agent — issue number/title/URL/labels
//      (glab), commits and diffstat (git), target branch, model profile, log paths.
//      These are facts; they are rendered even when every agent misbehaves.
//   2. AUTHORED, by the agents, transported through `RunResult.stdout` — the
//      implementer's `<mr-summary>` JSON block (intent, decisions, out-of-scope,
//      what to look at first) and the reviewer's two `<review-findings>` ledgers.
//      stdout is the same channel scripts/sandcastle-audit.mjs already parses, so
//      nothing new has to survive the sandbox teardown: no file in the worktree
//      (close() drops it), no commit into the repo (it is not the repo's business).
//
// The `## Comment tester` section follows the same split, and it is worth spelling out
// because it is the one place where the two halves answer *different* questions:
// the DERIVED half (`TestingRecipe`, built by the caller in main from the branch, the
// labels and the diffstat) says how to get the branch running in THIS repo; the
// AUTHORED half (`test_paths` / `test_steps` / `test_data` / `not_testable`) says what
// to do once it runs. `verification` stays what it always was — what the agent RAN;
// `test_steps` is what the HUMAN must run. Conflating the two makes both worthless.
//
// Everything here is pure and synchronous: the callers collect the raw strings, this
// module turns them into a title and a markdown body. Tests: `npx tsx
// .sandcastle/mr-body.test.ts`.
//
// The body also states, right under the header, WHAT HAPPENS TO THE ISSUE (issue #27):
// `Closes #n` when the MR targets the project's default branch, or an explicit
// "this MR will NOT close #n, and here is who owns the closing" when it targets any
// other base (a staging base, a stacked branch). Both hosts close an issue only when
// the carrying MR merges into the default branch — so on every other base the defect
// was not the missing keyword but the silence: nothing warned the reviewer that the
// issue would outlive the merge.
//
// This is the Factory's canonical copy. It replaces the three near-identical
// per-instance duplicates (api/.sandcastle/mr-body.mts, back-office/ and
// design-system/.sandcastle/mr-body.ts) that existed only because each repo's
// .sandcastle/ was gitignored with no shared package to import. What varies per repo
// is the *call site* in main.ts — the title style (cfg.commitStyle), the gate
// commands and the audit command (project context the caller supplies or omits) —
// not this module.
//
// Robustness rule, applied throughout: a malformed or missing agent block DEGRADES
// the description, never breaks the publish step. A missing summary is *reported in
// the body* ("l'implémenteur n'a pas émis de résumé") rather than silently omitted —
// a reviewer must be able to tell a clean run from a mute one.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The implementer's `<mr-summary>` block. Every field is optional: a partial
 *  summary is worth rendering, and validating it away would help nobody. */
export interface MrSummary {
  /** Conventional-commit type, e.g. `feat`. Used for the title in repos that enforce them. */
  type?: string;
  /** Conventional-commit scope, e.g. `tokens`. */
  scope?: string;
  /** One imperative line, no trailing period — the headline of the change. */
  headline?: string;
  /** Why the change exists: the need, the spec reference. */
  why?: string;
  /** One entry per changed area: what changes and why. */
  changes?: string[];
  /** Decisions taken, ideally naming the alternative dropped. */
  decisions?: string[];
  /** What was deliberately NOT done, and why. */
  out_of_scope?: string[];
  /** What a reviewer should distrust first. */
  risks?: string[];
  /** Commands run and their outcome, in the agent's own words. */
  verification?: string[];
  /** The file or line where attention pays off most. */
  review_focus?: string;
  /** Where the change is visible: story id, prod route, API endpoint. */
  test_paths?: string[];
  /** Ordered manual scenario, each step stating its expected result. */
  test_steps?: string[];
  /** Seed data / account / privilege the scenario needs to be reachable. */
  test_data?: string[];
  /** What cannot be checked by hand, and why. */
  not_testable?: string[];
}

/**
 * A repo's own answer to "what do I run to see this branch work?".
 *
 * Built by the caller in main — NOT here — because the commands are repo-specific
 * (`make api_restart` vs `yarn storybook`) and because they depend on run facts the
 * caller already holds: the branch name, the issue's labels, the diffstat paths. By
 * the time it reaches this module every string is final: no interpolation, no
 * predicate, no repo knowledge in the renderer. That is what keeps the three copies
 * of this file byte-identical.
 */
export interface TestingRecipe {
  /** Get the branch running here, in order. Rendered as GitLab task-list items. */
  steps: string[];
  /** Booting from nothing — collapsed, because it is rarely the reader's case. */
  coldStart?: string[];
  /** The gate a human can replay locally, verbatim. */
  gate?: string;
  /** Free lines closing the section (pipeline link, CI-is-the-authority reminder). */
  notes?: string[];
}

/** One finding, merged across the reviewer's two ledgers. */
export interface MergedFinding {
  id: string;
  axis?: string;
  severity?: string;
  source?: string;
  location?: string;
  claim?: string;
  disposition?: string;
  evidence?: string;
}

export interface ReviewLedgers {
  /** False when no reviewer ran at all (e.g. the implementer produced no commits). */
  reviewed: boolean;
  found?: unknown;
  resolved?: unknown;
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

export interface FileStat {
  path: string;
  added: number;
  removed: number;
}

export interface DiffStat {
  files: FileStat[];
  /** Files not listed because of the display cap — always disclosed in the body. */
  omitted: number;
  insertions: number;
  deletions: number;
}

export interface IssueInfo {
  number: number;
  title: string;
  url?: string | undefined;
  labels?: string[] | undefined;
  milestone?: string | null | undefined;
}

export interface RunInfo {
  profile: string;
  implementerModel: string;
  reviewerModel: string;
  round: number;
  /** Host paths of the agent logs, for whoever audits the run. */
  logs?: string[];
  /** The command that audits this run's review. */
  auditCommand?: string;
}

export interface MrBodyInput {
  issue: IssueInfo;
  branch: string;
  base: string;
  /** The project trunk (`ProjectConfig.baseBranch`). The closure decision compares
   *  `base` against THIS — not against `origin/HEAD` or a hardcoded name — so a
   *  consumer whose trunk is `master` or `develop` gets the right answer too. */
  defaultBranch: string;
  summary: MrSummary | null;
  /** Set when a `<mr-summary>` block was present but unusable — surfaced in the body. */
  summaryError?: string | undefined;
  review: ReviewLedgers;
  commits: CommitInfo[];
  diffstat: DiffStat;
  run: RunInfo;
  /** Omitted only by a caller that has no recipe to give — the section then rests on
   *  the agent's own words alone, and says so. */
  testing?: TestingRecipe | undefined;
}

/** How a repo wants its MR titles shaped. `conventional` repos run commitlint (and
 *  semantic-release) and may squash the MR title into a commit, so the title has to
 *  stay a valid Conventional Commit header. `plain` repos have no such constraint
 *  and read better with the issue's own words. */
export type TitleStyle = 'conventional' | 'plain';

/** commitlint's `header-max-length` default. Applies to the title of a squash-merged
 *  MR too, which is why `conventional` titles are truncated to it. */
export const TITLE_MAX = 100;

// ---------------------------------------------------------------------------
// Extraction — pull the agent-authored blocks out of a run's stdout
// ---------------------------------------------------------------------------

/** Last fenced-or-bare JSON object inside `<tag …>…</tag>`, parsed.
 *  LAST, not first: an agent that restates its block (a retry, a self-correction)
 *  means the final emission is the one it stands behind. */
function extractTaggedJson(
  stdout: string,
  tag: string,
  attrPattern = '',
): { present: boolean; data?: unknown; parseError?: string } {
  const re = new RegExp(`<${tag}[^>]*${attrPattern}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let last: string | null = null;
  for (const match of stdout.matchAll(re)) last = match[1] ?? null;
  if (last === null) return { present: false };

  let body = last.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(body);
  if (fence?.[1]) {
    body = fence[1].trim();
  } else {
    // No fence: take the outermost braces, so surrounding prose is tolerated.
    const first = body.indexOf('{');
    const lastBrace = body.lastIndexOf('}');
    if (first !== -1 && lastBrace > first) body = body.slice(first, lastBrace + 1);
  }
  try {
    return { present: true, data: JSON.parse(body) as unknown };
  } catch (error) {
    return { present: true, parseError: String((error as Error).message ?? error) };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value.map(asString).filter((entry): entry is string => entry !== undefined);
  return list.length > 0 ? list : undefined;
};

/**
 * Parse the implementer's `<mr-summary>` block out of its stdout.
 *
 * Field-by-field coercion rather than a cast: the block is agent-authored, so a
 * string where a list was asked for must degrade to "that section is missing",
 * not to `["u","n","d",…]` or a crash inside the renderer.
 */
export function extractMrSummary(stdout: string): {
  summary: MrSummary | null;
  error?: string;
} {
  const raw = extractTaggedJson(stdout, 'mr-summary');
  if (!raw.present)
    return { summary: null, error: "aucun bloc <mr-summary> dans la sortie de l'implémenteur" };
  if (raw.parseError)
    return { summary: null, error: `bloc <mr-summary> illisible — ${raw.parseError}` };
  if (!isRecord(raw.data))
    return { summary: null, error: "bloc <mr-summary> présent mais ce n'est pas un objet JSON" };

  const record = raw.data;
  const summary: MrSummary = {};
  const type = asString(record['type']);
  const scope = asString(record['scope']);
  const headline = asString(record['headline']);
  const why = asString(record['why']);
  const reviewFocus = asString(record['review_focus']);
  const changes = asStringList(record['changes']);
  const decisions = asStringList(record['decisions']);
  const outOfScope = asStringList(record['out_of_scope']);
  const risks = asStringList(record['risks']);
  const verification = asStringList(record['verification']);
  const testPaths = asStringList(record['test_paths']);
  const testSteps = asStringList(record['test_steps']);
  const testData = asStringList(record['test_data']);
  const notTestable = asStringList(record['not_testable']);
  if (type) summary.type = type;
  if (scope) summary.scope = scope;
  if (headline) summary.headline = headline;
  if (why) summary.why = why;
  if (reviewFocus) summary.review_focus = reviewFocus;
  if (changes) summary.changes = changes;
  if (decisions) summary.decisions = decisions;
  if (outOfScope) summary.out_of_scope = outOfScope;
  if (risks) summary.risks = risks;
  if (verification) summary.verification = verification;
  if (testPaths) summary.test_paths = testPaths;
  if (testSteps) summary.test_steps = testSteps;
  if (testData) summary.test_data = testData;
  if (notTestable) summary.not_testable = notTestable;

  const meaningful = Object.keys(summary).length > 0;
  return meaningful
    ? { summary }
    : { summary: null, error: 'bloc <mr-summary> vide — aucun champ exploitable' };
}

/** One `<review-findings phase="…">` ledger. Same extraction as
 *  scripts/sandcastle-audit.mjs, deliberately: one format, two readers. */
export function extractReviewLedger(
  stdout: string,
  phase: 'found' | 'resolved',
): { present: boolean; data?: unknown; parseError?: string } {
  return extractTaggedJson(stdout, 'review-findings', `phase=["']${phase}["']`);
}

/**
 * Merge the two ledgers into one list, keyed by finding id.
 *
 * The join is what makes the section worth reading: block 1 says what was wrong,
 * block 2 says what happened to it. A finding present in block 1 and absent from
 * block 2 comes back with `disposition: undefined` — rendered as
 * "non renseignée", because a silently dropped finding is exactly what the human
 * needs to see (and what the audit script fails a run for).
 */
export function mergeFindings(review: ReviewLedgers): MergedFinding[] {
  const readFindings = (ledger: unknown): Record<string, unknown>[] => {
    if (!isRecord(ledger)) return [];
    const findings = ledger['findings'];
    return Array.isArray(findings) ? findings.filter(isRecord) : [];
  };

  const byId = new Map<string, MergedFinding>();
  for (const entry of readFindings(review.found)) {
    const id = asString(entry['id']);
    if (!id) continue;
    const merged: MergedFinding = { id };
    const axis = asString(entry['axis']);
    const severity = asString(entry['severity']);
    const source = asString(entry['source']);
    const location = asString(entry['location']);
    const claim = asString(entry['claim']);
    if (axis) merged.axis = axis;
    if (severity) merged.severity = severity;
    if (source) merged.source = source;
    if (location) merged.location = location;
    if (claim) merged.claim = claim;
    byId.set(id, merged);
  }
  for (const entry of readFindings(review.resolved)) {
    const id = asString(entry['id']);
    if (!id) continue;
    // A disposition for an id that never appeared in block 1 is still shown: it is a
    // discrepancy, and hiding it would make the body prettier than the run was.
    const merged = byId.get(id) ?? { id };
    const disposition = asString(entry['disposition']);
    const evidence = asString(entry['evidence']);
    if (disposition) merged.disposition = disposition;
    if (evidence) merged.evidence = evidence;
    byId.set(id, merged);
  }
  return [...byId.values()];
}

/** The gate command and its result, as the reviewer reported them. */
export function extractGate(review: ReviewLedgers): { command: string; result: string } | null {
  for (const ledger of [review.resolved, review.found]) {
    if (!isRecord(ledger)) continue;
    const gate = ledger['gate'];
    if (!isRecord(gate)) continue;
    const command = asString(gate['command']);
    const result = asString(gate['result']);
    if (command && result) return { command, result };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/** Strip a Conventional-Commit prefix, so a headline can be re-prefixed without doubling it. */
const stripConventionalPrefix = (subject: string): string =>
  subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').trim();

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/**
 * Build the MR title.
 *
 * Deliberately NOT `git log -1`: on a reviewed branch the newest commit is the
 * *reviewer's* refinement (`refactor(tokens): tighten …`), so the title advertised
 * the review instead of the work. The anchor is the implementer's intent — the
 * summary headline, else the FIRST commit on the branch, else the issue title.
 *
 * `conventional` keeps a valid `type(scope): …` header (commitlint + squash), and
 * both styles carry `(#N)` so a title is traceable to its issue in a list view.
 */
export function buildMrTitle(input: {
  style: TitleStyle;
  issue: { number: number; title: string };
  summary: MrSummary | null;
  commits: CommitInfo[];
}): string {
  const { style, issue, summary, commits } = input;
  const firstCommit = commits.length > 0 ? commits[commits.length - 1]?.subject : undefined;
  const suffix = ` (#${issue.number})`;

  if (style === 'plain') {
    const headline = summary?.headline ?? issue.title;
    return truncate(`#${issue.number} — ${headline}`, TITLE_MAX);
  }

  // Conventional: prefer the agent's declared type/scope, fall back to the prefix of
  // the first commit (which commitlint already validated), then to `chore`.
  const fallbackPrefix = /^([a-z]+)(\(([^)]*)\))?!?:/i.exec(firstCommit ?? '');
  const type = summary?.type ?? fallbackPrefix?.[1] ?? 'chore';
  const scope = summary?.scope ?? fallbackPrefix?.[3];
  const headlineSource = summary?.headline ?? firstCommit ?? issue.title;
  const headline = stripConventionalPrefix(headlineSource) || issue.title;
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
  const room = TITLE_MAX - prefix.length - suffix.length;
  return `${prefix}${truncate(headline, Math.max(12, room))}${suffix}`;
}

// ---------------------------------------------------------------------------
// Issue closure (issue #27)
// ---------------------------------------------------------------------------

/** What the MR body promises about the issue it carries. */
export interface ClosureDecision {
  /** True only when the host will actually close the issue at merge time — which
   *  both hosts do ONLY for an MR merged into the project's default branch. */
  closes: boolean;
  /** The ready-to-render sentence for the body: `Closes #n` when it closes, the
   *  explicit why-not note (naming the base, the issue, and who owns the closing)
   *  when it does not. */
  line: string;
}

/**
 * Decide what the MR body says about its issue, from the base it targets and the
 * project's default branch (issue #27).
 *
 * GitHub and GitLab close an issue only when an MR carrying a closing keyword
 * merges into the DEFAULT branch. `mr-body.ts` used to emit no keyword at all, so
 * a fan-out to `main` left every issue open by accident — the absence was never
 * the defect, the SILENCE was: on a stacked or staging base nobody was told the
 * issue would outlive the merge.
 *
 * The keyword stays `Closes` verbatim in every language: the recognized list
 * (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved) is closed and
 * has no translatable equivalent — « Ferme #5 » cross-links but closes nothing.
 * The NOTE around it is prose and may be French, like the rest of the body.
 */
export function decideIssueClosure(base: string, defaultBranch: string, issueNumber: number): ClosureDecision {
  if (base === defaultBranch) {
    return { closes: true, line: `Closes #${issueNumber}` };
  }
  return {
    closes: false,
    line:
      `**Fermeture de l’issue** : cette MR cible \`${base}\`, pas \`${defaultBranch}\` — ` +
      `elle ne fermera **pas** #${issueNumber}. La fermeture revient à la MR ` +
      `\`${base} → ${defaultBranch}\`, ou se fait à la main.`,
  };
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const bullets = (items: string[]): string => items.map((item) => `- ${item}`).join('\n');

/** GitLab renders a table only if every row has the same column count, so cells are
 *  escaped for `|` and newlines rather than trusted. */
const cell = (text: string | undefined, fallback = '—'): string =>
  (text ?? '').trim() === ''
    ? fallback
    : (text as string).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Escape for a raw-HTML context (`<summary>`), where markdown escaping does not apply
 *  and an agent-authored `<`/`&` would break the disclosure widget. */
const html = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Flatten agent text onto one line, and drop a list marker it may have added itself.
 *  A newline inside a `- [ ]` item ends the item, so the rest of the step would render
 *  as a paragraph outside the checklist; a re-added `- ` would render as `- - `. */
const line = (text: string): string =>
  text
    .replace(/\r?\n+/g, ' ')
    .replace(/^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?/, '')
    .trim();

/** GitLab task-list items. It counts every `- [ ]` in the description and shows
 *  `n/m tâches terminées` in the MR header, so a reviewer's progress is visible from
 *  the MR list — the reason the steps are checkboxes and not bullets. */
const tasks = (items: string[]): string =>
  items
    .map(line)
    .filter((item) => item !== '')
    .map((item) => `- [ ] ${item}`)
    .join('\n');

/**
 * Render `## Comment tester`.
 *
 * The section a reviewer opens first and the one the body was missing: without it,
 * the diff is auditable but the change is not observable, and "je verrai bien à la
 * relecture" is how an untested branch gets approved.
 *
 * Both halves are optional and degrade independently. No recipe and no scenario is
 * still a rendered section — one that says nobody explained how to test this, which
 * is itself the finding.
 */
function renderTesting(recipe: TestingRecipe | undefined, summary: MrSummary | null): string {
  const derived = recipe?.steps ? tasks(recipe.steps) : '';
  const scenario = summary?.test_steps ? tasks(summary.test_steps) : '';
  const authored =
    scenario !== '' || summary?.test_paths || summary?.test_data || summary?.not_testable;
  const hostSide =
    derived !== '' || recipe?.gate || recipe?.coldStart?.length || recipe?.notes?.length;
  if (!authored && !hostSide) {
    // Checked first: with nothing from either side, the "no scenario" warning below
    // would be the only content and would read as if the host had done its part.
    return (
      '> Aucune recette de test : ni l’hôte ni l’implémenteur n’ont indiqué comment ' +
      'faire tourner cette branche. À traiter comme une MR non vérifiable en l’état.'
    );
  }

  const parts: string[] = [];

  if (summary?.test_data) {
    // First, deliberately: a scenario that cannot be reached for lack of a seed
    // manifestation or a privilege wastes the whole session before step 1.
    parts.push(`**Ce qu'il faut sous la main**\n\n${bullets(summary.test_data.map(line))}`);
  }

  if (derived !== '') parts.push(`**Récupérer et lancer**\n\n${derived}`);

  if (scenario !== '') parts.push(`**Ce qu'il faut voir**\n\n${scenario}`);

  if (summary?.test_paths) {
    parts.push(`**Où regarder**\n\n${bullets(summary.test_paths.map(line))}`);
  }

  if (scenario === '' && !summary?.test_paths) {
    parts.push(
      "> ⚠ **L'implémenteur n'a pas dit comment vérifier son changement** (ni scénario, " +
        'ni écran, ni endpoint). Le diff ci-dessous est le seul point d’entrée : ' +
        'exiger le scénario avant de merger.',
    );
  }

  if (summary?.not_testable) {
    parts.push(
      `> **Ce qui ne se vérifie pas à la main** — s’appuyer sur les tests pour ces points, ` +
        `ne pas les chercher dans l’UI :\n>\n${summary.not_testable
          .map((entry) => `> - ${line(entry)}`)
          .join('\n')}`,
    );
  }

  const closing: string[] = [];
  if (recipe?.gate) closing.push(`- Rejouer le gate : \`${recipe.gate}\``);
  for (const note of recipe?.notes ?? []) closing.push(`- ${line(note)}`);
  if (closing.length > 0) parts.push(closing.join('\n'));

  if (recipe?.coldStart && recipe.coldStart.length > 0) {
    // Collapsed: the reader almost always has the stack up, and an eight-line boot
    // sequence at full height pushes the actual scenario off the first screen.
    parts.push(
      `<details>\n<summary>Rien n’est encore monté sur ce poste ?</summary>\n\n${bullets(
        recipe.coldStart.map(line),
      )}\n\n</details>`,
    );
  }

  return parts.join('\n\n');
}

const DISPOSITION_MARK: Record<string, string> = {
  fixed: '✔ corrigé',
  rejected: '✖ rejeté',
  deferred: '↷ reporté',
};

function renderFindings(review: ReviewLedgers): string {
  if (!review.reviewed) {
    return (
      '> Aucune revue automatique sur cette branche (le relecteur ne tourne que si ' +
      "l'implémenteur a produit des commits, et il peut avoir échoué — voir les logs). " +
      '**La relecture humaine est le seul filet ici.**'
    );
  }
  const foundPresent = isRecord(review.found);
  const resolvedPresent = isRecord(review.resolved);
  if (!foundPresent && !resolvedPresent) {
    return (
      '> Le relecteur a tourné mais n’a émis aucun registre `<review-findings>` : ' +
      'ses constats ne sont pas traçables. À traiter comme une revue non fiable ' +
      '(`node scripts/sandcastle-audit.mjs` le confirmera).'
    );
  }

  const findings = mergeFindings(review);
  if (findings.length === 0) {
    return 'Le relecteur a passé les deux axes (standards, spec) et **n’a levé aucun constat**.';
  }

  // Findings are rendered one block each, not as table rows: a claim and its evidence
  // run to several sentences here, and a seven-column table of paragraphs is unreadable
  // in GitLab. `fixed` findings are collapsed (the reviewer can spot-check them);
  // anything else is left OPEN, because rejected / deferred / undisposed are exactly
  // the ones needing a human's judgement before the merge.
  const blocks = findings.map((finding) => {
    const disposition = finding.disposition
      ? (DISPOSITION_MARK[finding.disposition] ?? finding.disposition)
      : '⚠ disposition non renseignée';
    // `<summary>` is raw HTML: GitLab does NOT run markdown inside it, so `**S1**`
    // would render as literal asterisks. Tags here, markdown in the body below.
    const heading = [
      `<strong>${html(finding.id)}</strong>`,
      html(cell(finding.axis, '')),
      html(cell(finding.severity, '')),
      html(disposition),
      finding.location ? `<code>${html(cell(finding.location))}</code>` : '',
    ]
      .filter((part) => part !== '')
      .join(' · ');
    const details: string[] = [];
    if (finding.claim) details.push(`**Constat.** ${finding.claim}`);
    if (finding.source) details.push(`**Source.** ${finding.source}`);
    if (finding.evidence) details.push(`**Évidence.** ${finding.evidence}`);
    if (details.length === 0) details.push('_Ni constat ni évidence renseignés._');
    const open = finding.disposition === 'fixed' ? '' : ' open';
    return `<details${open}>\n<summary>${heading}</summary>\n\n${details.join('\n\n')}\n\n</details>`;
  });

  const tally = (predicate: (finding: MergedFinding) => boolean): number =>
    findings.filter(predicate).length;
  const counts = [
    `${tally((f) => f.disposition === 'fixed')} corrigé(s)`,
    `${tally((f) => f.disposition === 'rejected')} rejeté(s)`,
    `${tally((f) => f.disposition === 'deferred')} reporté(s)`,
  ];
  const undisposed = findings.filter((finding) => !finding.disposition);
  if (undisposed.length > 0) counts.push(`**${undisposed.length} sans disposition**`);

  const warnings: string[] = [];
  if (undisposed.length > 0) {
    warnings.push(
      `⚠ **${undisposed.length} constat(s) sans disposition** (${undisposed.map((f) => f.id).join(', ')}) — ` +
        `levés puis abandonnés sans motif. À exiger avant merge.`,
    );
  }
  const deferred = findings.filter((finding) => finding.disposition === 'deferred');
  if (deferred.length > 0) {
    warnings.push(
      `↷ **${deferred.length} constat(s) reportés** (${deferred.map((f) => f.id).join(', ')}) — vérifier qu’un ticket existe.`,
    );
  }
  const rejected = findings.filter((finding) => finding.disposition === 'rejected');
  if (rejected.length > 0) {
    warnings.push(
      `✖ **${rejected.length} constat(s) rejetés** (${rejected.map((f) => f.id).join(', ')}) — ` +
        `le relecteur revient sur son propre constat : c’est le motif qu’il faut relire.`,
    );
  }

  return [
    `**${findings.length} constat(s)** levés par le relecteur — ${counts.join(', ')}.`,
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
    ...blocks,
  ].join('\n');
}

function renderDiffstat(diffstat: DiffStat): string {
  if (diffstat.files.length === 0) return '_Aucun fichier listé._';
  const rows = diffstat.files.map(
    (file) => `| \`${cell(file.path)}\` | +${file.added} | −${file.removed} |`,
  );
  const lines = [
    `**${diffstat.files.length + diffstat.omitted} fichier(s)**, +${diffstat.insertions} / −${diffstat.deletions} ligne(s).`,
    '',
    '| Fichier | + | − |',
    '| --- | --- | --- |',
    ...rows,
  ];
  if (diffstat.omitted > 0) {
    // Never a silent cap: a truncated list that looks complete is a lie about coverage.
    lines.push(
      '',
      `_… et ${diffstat.omitted} autre(s) fichier(s), non listés ici (voir l’onglet Changes)._`,
    );
  }
  return lines.join('\n');
}

/**
 * Assemble the markdown description.
 *
 * Section order is reviewer-first: the issue's fate (closure line), then intent,
 * then what changed, then what the run itself found and verified, then the
 * mechanical inventory. A reviewer who reads only the first screen should already
 * know why the MR exists, what happens to its issue, and where to look.
 */
export function buildMrDescription(input: MrBodyInput): string {
  const { issue, branch, base, defaultBranch, summary, summaryError, review, commits, diffstat, run, testing } =
    input;
  const parts: string[] = [];

  // --- Header: identity and provenance, all host-derived ---
  const issueRef = issue.url ? `[#${issue.number}](${issue.url})` : `#${issue.number}`;
  const header = [
    `**Issue ${issueRef} — ${issue.title}**`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| Branche | \`${branch}\` → \`${base}\` |`,
    `| Labels | ${issue.labels && issue.labels.length > 0 ? issue.labels.map((l) => `\`${l}\``).join(', ') : '—'} |`,
    `| Jalon | ${cell(issue.milestone ?? undefined)} |`,
    `| Produit par | Sandcastle, round ${run.round}, profil \`${run.profile}\` |`,
  ].join('\n');
  parts.push(header);

  // What happens to the issue — host-derived, before anything authored, because it
  // is the one line the merge itself acts on (issue #27). `Closes #n` only when the
  // target IS the default branch; every other base gets the why-not note instead,
  // never a keyword that would silently do nothing.
  parts.push(decideIssueClosure(base, defaultBranch, issue.number).line);

  // A stacked MR is the single most misread shape in chained mode: merged in the
  // wrong order it drags an unreviewed branch in with it. Say so at the top.
  if (base.startsWith('sandcastle/')) {
    parts.push(
      `> ⛓ **MR empilée** : elle cible \`${base}\`, une branche **non mergée**. ` +
        `Merger d’abord la MR de \`${base}\`, puis celle-ci — de bas en haut.`,
    );
  }

  // --- Authored: intent ---
  if (summary?.why) parts.push(`## Pourquoi\n\n${summary.why}`);
  if (summaryError) {
    parts.push(
      `> ⚠ **Résumé d’implémentation absent** (${summaryError}). Les sections ci-dessous ` +
        `sont dérivées du dépôt seul : intention, décisions et points d’attention manquent. ` +
        `À relire avec cette réserve.`,
    );
  }

  if (summary?.changes) parts.push(`## Ce qui change\n\n${bullets(summary.changes)}`);
  if (summary?.decisions) parts.push(`## Décisions prises\n\n${bullets(summary.decisions)}`);
  if (summary?.out_of_scope) {
    parts.push(
      `## Hors périmètre\n\nCe que cette MR ne fait **pas**, volontairement :\n\n${bullets(summary.out_of_scope)}`,
    );
  }

  // --- Authored: where to spend review attention ---
  const attention: string[] = [];
  if (summary?.review_focus) attention.push(`**À regarder d’abord** : ${summary.review_focus}`);
  if (summary?.risks) attention.push(bullets(summary.risks));
  if (attention.length > 0)
    parts.push(`## Points d’attention pour le relecteur\n\n${attention.join('\n\n')}`);

  // --- How the human checks it: before the run's own evidence, on purpose ---
  // The reviewer's next physical act after reading the intent is to run the thing.
  // Findings and inventory are consulted while it runs, not before.
  parts.push(`## Comment tester\n\n${renderTesting(testing, summary)}`);

  // --- Run's own evidence ---
  parts.push(`## Revue automatique\n\n${renderFindings(review)}`);

  const gate = extractGate(review);
  const verification: string[] = [];
  if (gate) {
    const ok = gate.result.toLowerCase().startsWith('pass');
    verification.push(
      `- Gate \`${gate.command}\` : **${ok ? 'vert' : gate.result}**${ok ? '' : ' ⚠'}`,
    );
  }
  if (summary?.verification) verification.push(bullets(summary.verification));
  if (verification.length > 0) {
    parts.push(
      `## Vérifications\n\n${verification.join('\n')}\n\n` +
        `_Déclaré par les agents ; la CI de la MR reste l’autorité._`,
    );
  }

  // --- Mechanical inventory ---
  parts.push(`## Fichiers touchés\n\n${renderDiffstat(diffstat)}`);
  if (commits.length > 0) {
    const list = commits.map((commit) => `- \`${commit.sha}\` ${commit.subject}`).join('\n');
    parts.push(`## Commits (${commits.length})\n\n${list}`);
  }

  // --- Traceability ---
  const trace = [
    `- Issue : ${issueRef} (\`Ralph: issue-#${issue.number}\` en trailer des commits)`,
    `- Modèles : implémenteur \`${run.implementerModel}\`, relecteur \`${run.reviewerModel}\``,
  ];
  if (run.logs && run.logs.length > 0) {
    trace.push(`- Logs des agents : ${run.logs.map((log) => `\`${log}\``).join(', ')}`);
  }
  if (run.auditCommand) {
    trace.push(`- Auditer la revue : \`${run.auditCommand}\``);
  }
  trace.push(
    `- **Draft volontaire** : générée par des agents, jamais auto-mergée. Ni le résumé ni les ` +
      `dispositions ci-dessus ne remplacent une relecture du diff.`,
  );
  parts.push(`## Traçabilité\n\n${trace.join('\n')}`);

  return parts.join('\n\n');
}
