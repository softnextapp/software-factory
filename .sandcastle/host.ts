// The host abstraction — the single place that knows the difference between the
// GitLab (`glab`) and GitHub (`gh`) collaboration CLIs.
//
// Why this exists
// ---------------
// v0.1 shipped glab-only: every host-touching call in main.ts (issue view for
// labels + MR-body facts, `mr create --draft`, `mr list`) and the queue/MR
// commands baked into the role prompts spoke GitLab, so a project whose `origin`
// is GitHub could not run end-to-end (issue #6). The blocker was never the git
// layer — `git push origin` works mechanically against either host — only the
// collaboration layer (issues + MRs/PRs).
//
// This module owns that layer. Everything host-specific lives here:
//   - the argv each CLI expects (glab `--source-branch`/`--description` vs gh
//     `--head`/`--body`, glab `issue update --unlabel` vs gh `issue edit
//     --remove-label`, glab `issue note` vs gh `issue comment`, …);
//   - the JSON shape each returns (glab snake_case + `web_url` + string labels;
//     gh camelCase + `url` + `{name}` label objects);
//   - the prompt-time command strings the planner/implementer/reviewer run, so
//     the prompt files stay host-neutral and a single `{{KEY}}` substitution
//     picks the right CLI (see plan-prompt.md / implement-prompt.md).
//
// Everything is pure except the executing wrappers inside createHost(), so the
// argv builders and parsers are unit-tested (host.test.ts) with no CLI / no
// network — exactly the seam chain.ts established.

import { execFileSync } from 'node:child_process';
import type { GitHost } from './config.ts';
import { type OpenMergeRequest } from './chain.ts';
import type { IssueInfo } from './mr-body.ts';

/** Per-host display terms for operator-facing messages (main.ts error fallback, chain logs, etc.). */
export const HOST_TERMS: Readonly<Record<GitHost, { cr: string; cli: string; name: string; ref: string }>> = {
  glab: { cr: 'merge request', cli: 'glab', name: 'GitLab', ref: '!' },
  gh: { cr: 'pull request', cli: 'gh', name: 'GitHub', ref: '#' },
};

// ---------------------------------------------------------------------------
// Prompt-time command strings
//
// Sandcastle substitutes `{{KEY}}` → value in a promptFile before it runs a
// `!`cmd`` block, and that substitution is SINGLE-PASS: a value containing
// `{{...}}` is inserted verbatim and NOT re-scanned. So a command that embeds
// the issue number is split into a binary/prefix promptArg (`{{ISSUE_CLI}}`,
// `{{UNLABEL_PREFIX}}`) plus a literal `{{ISSUE_NUMBER}}` that lives at the
// prompt's top level — both resolve in the one pass. The one remaining Phase-1
// command (the open-MR list below) embeds no issue number, so it rides as a full
// command string.
//
// The work QUEUE used to be a Phase-1 command too; issue #15 moved it to the
// orchestration (main.ts enumerates per configured queue label and unions), so
// the planner now receives the queue as inline JSON instead of running a command.
// ---------------------------------------------------------------------------

/**
 * The open-MR/PR command for `plan-prompt.md`: lists open changes as
 * `[{iid, source_branch, target_branch, title}]` — `source_branch`/`target_branch`
 * on BOTH hosts, so chain.ts's parser and the planner see one shape.
 */
export function openMrsCommand(host: GitHost): string {
  if (host === 'gh') {
    return (
      'gh pr list --state open --limit 100 --json number,headRefName,baseRefName,title ' +
      "--jq '[.[] | {iid: .number, source_branch: .headRefName, target_branch: .baseRefName, title}]'"
    );
  }
  return 'glab mr list --output json --per-page 100 ' + "--jq '[.[] | {iid, source_branch, target_branch, title}]'";
}

/**
 * The verbs the implement/review prompts need to view / unlabel / comment on an
 * issue. These differ by MORE than the binary across hosts (gh has no
 * `issue update --unlabel` and no `issue note`), so the prompt composes
 * `{{PREFIX}} {{ISSUE_NUMBER}} {{FLAG}} …` from these pieces.
 */
export interface PromptHostArgs {
  /** CLI binary for `issue view` (same subcommand on both hosts). */
  readonly ISSUE_CLI: string;
  /** `<cli> <subcommand>` before the issue number on the unlabel step. */
  readonly UNLABEL_PREFIX: string;
  readonly UNLABEL_FLAG: string;
  /** `<cli> <subcommand>` before the issue number on the comment step. */
  readonly NOTE_PREFIX: string;
  readonly NOTE_FLAG: string;
}

export function promptHostArgs(host: GitHost): PromptHostArgs {
  if (host === 'gh') {
  return {
    ISSUE_CLI: 'gh',
    UNLABEL_PREFIX: 'gh issue edit',
    UNLABEL_FLAG: '--remove-label',
    NOTE_PREFIX: 'gh issue comment',
    NOTE_FLAG: '--body',
  };
  }
  return {
    ISSUE_CLI: 'glab',
    UNLABEL_PREFIX: 'glab issue update',
    UNLABEL_FLAG: '--unlabel',
    NOTE_PREFIX: 'glab issue note',
    NOTE_FLAG: '-m',
  };
}

// ---------------------------------------------------------------------------
// glab parsers — factored out of main.ts unchanged, so main.ts no longer holds
// host-specific JSON knowledge. Behaviour is identical to the inline versions.
// ---------------------------------------------------------------------------

/**
 * Read a milestone title from either host's issue JSON. glab and gh both nest it
 * as `{ title }` (or null); this shared helper keeps that shape in one place so the
 * glab/gh issue parsers don't duplicate the `milestone?.title` walk.
 */
function readMilestoneTitle(parsed: Record<string, unknown>): string | null {
  const milestone = parsed['milestone'];
  return milestone && typeof milestone === 'object' && 'title' in milestone
    ? String((milestone as { title: unknown }).title)
    : null;
}

/** Parse `glab issue view <n> --output json --jq .labels` (a JSON string array). */
export function parseGlabIssueLabels(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`glab returned a non-array label list: ${raw}`);
  }
  return parsed.filter((label): label is string => typeof label === 'string');
}

/** Parse `glab issue view <n> --output json` into an IssueInfo. */
export function parseGlabIssue(raw: string, fallbackTitle: string, issueNumber: number): IssueInfo {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const labels = Array.isArray(parsed['labels'])
    ? parsed['labels'].filter((label): label is string => typeof label === 'string')
    : undefined;
  return {
    number: issueNumber,
    title: typeof parsed['title'] === 'string' ? parsed['title'] : fallbackTitle,
    url: typeof parsed['web_url'] === 'string' ? parsed['web_url'] : undefined,
    labels,
    milestone: readMilestoneTitle(parsed),
  };
}

// ---------------------------------------------------------------------------
// gh argv builders + parsers
// ---------------------------------------------------------------------------

/** `gh issue view <n> --json labels --jq '.labels[].name'` (raw, one name/line). */
export function ghIssueLabelsArgs(issueNumber: number): readonly string[] {
  return ['issue', 'view', String(issueNumber), '--json', 'labels', '--jq', '.labels[].name'];
}

/** jq raw output is one bare label name per line; blanks dropped. */
export function parseGhIssueLabels(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `gh issue view <n> --json number,title,url,labels,milestone`. */
export function ghIssueViewArgs(issueNumber: number): readonly string[] {
  return ['issue', 'view', String(issueNumber), '--json', 'number,title,url,labels,milestone'];
}

/** Parse gh's issue JSON (`url`, `labels:[{name}]`, `milestone:{title}|null`). */
export function parseGhIssue(raw: string, fallbackTitle: string, issueNumber: number): IssueInfo {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawLabels = parsed['labels'];
  const labels = Array.isArray(rawLabels)
    ? rawLabels
        .map((label) => (label && typeof label === 'object' && 'name' in label ? label.name : undefined))
        .filter((name): name is string => typeof name === 'string')
    : undefined;
  return {
    number: typeof parsed['number'] === 'number' ? parsed['number'] : issueNumber,
    title: typeof parsed['title'] === 'string' ? parsed['title'] : fallbackTitle,
    url: typeof parsed['url'] === 'string' ? parsed['url'] : undefined,
    labels,
    milestone: readMilestoneTitle(parsed),
  };
}

// ---------------------------------------------------------------------------
// Draft change-request creation (glab MR / gh PR)
// ---------------------------------------------------------------------------

export interface CreateChangeRequestArgs {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
  /** glab wants a username, gh accepts `@me`; null ⇒ leave it unassigned. */
  readonly assignee: string | null;
}

/** glab `mr create` argv (the exact shape main.ts shipped in v0.1). */
export function glabMrCreateArgs(args: CreateChangeRequestArgs): string[] {
  const argv = [
    'mr',
    'create',
    '--source-branch',
    args.sourceBranch,
    '--target-branch',
    args.targetBranch,
    '--draft',
    '--yes',
    '--no-editor',
    '--title',
    args.title,
    '--description',
    args.description,
  ];
  if (args.assignee) argv.push('--assignee', args.assignee);
  return argv;
}

/** gh `pr create` argv — `--head`/`--base`/`--body`; no `--yes`/`--no-editor` (gh is non-interactive with --title+--body). */
export function ghPrCreateArgs(args: CreateChangeRequestArgs): readonly string[] {
  const argv = [
    'pr',
    'create',
    '--head',
    args.sourceBranch,
    '--base',
    args.targetBranch,
    '--draft',
    '--title',
    args.title,
    '--body',
    args.description,
  ];
  if (args.assignee) argv.push('--assignee', args.assignee);
  return argv;
}

/**
 * The human-readable `create` command an operator pastes to finish publishing a
 * branch by hand when Phase 3 fails after the push. Each host's flags differ, so
 * this keeps the host spelling out of main.ts's error fallback.
 */
export function manualCreateHint(host: GitHost, sourceBranch: string, targetBranch: string): string {
  if (host === 'gh') {
    return `gh pr create --head ${sourceBranch} --base ${targetBranch} --draft`;
  }
  return `glab mr create --source-branch ${sourceBranch} --target-branch ${targetBranch} --draft`;
}

// ---------------------------------------------------------------------------
// Open MR / PR list (for chained-base resolution — see chain.ts)
// ---------------------------------------------------------------------------

/** gh `pr list` argv selecting the fields the stack walk needs. */
export function ghPrListArgs(): readonly string[] {
  return [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,headRefName,baseRefName,createdAt,title,url',
  ];
}

/**
 * Normalise `glab mr list --output json`.
 *
 * Fail-closed on a non-array payload: the alternative is an empty stack, which
 * reads as "nothing open" and silently un-chains the round. Individual entries
 * missing the branch fields are dropped rather than fatal — GitLab keeps adding
 * MR kinds, and one odd row should not stop the loop. Moved here from chain.ts
 * so every host parser lives in one place; chain.ts keeps only the pure,
 * host-agnostic stack walk.
 */
export function parseOpenMergeRequests(raw: string): OpenMergeRequest[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`glab returned a non-array MR list: ${raw.slice(0, 200)}`);
  }
  const out: OpenMergeRequest[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const mr = entry as Record<string, unknown>;
    const sourceBranch = mr['source_branch'];
    const targetBranch = mr['target_branch'];
    const iid = mr['iid'];
    if (typeof sourceBranch !== 'string' || sourceBranch === '') continue;
    if (typeof targetBranch !== 'string' || targetBranch === '') continue;
    if (typeof iid !== 'number') continue;
    out.push({
      iid,
      sourceBranch,
      targetBranch,
      createdAt: typeof mr['created_at'] === 'string' ? mr['created_at'] : '',
      title: typeof mr['title'] === 'string' ? mr['title'] : '',
      webUrl: typeof mr['web_url'] === 'string' ? mr['web_url'] : '',
    });
  }
  return out;
}

/** Parse gh's PR list into the host-agnostic `OpenMergeRequest` chain.ts owns. */
export function parseGhPrList(raw: string): OpenMergeRequest[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`gh returned a non-array PR list: ${raw.slice(0, 200)}`);
  }
  const out: OpenMergeRequest[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pr = entry as Record<string, unknown>;
    const sourceBranch = pr['headRefName'];
    const targetBranch = pr['baseRefName'];
    const number = pr['number'];
    if (typeof sourceBranch !== 'string' || sourceBranch === '') continue;
    if (typeof targetBranch !== 'string' || targetBranch === '') continue;
    if (typeof number !== 'number') continue;
    out.push({
      iid: number,
      sourceBranch,
      targetBranch,
      createdAt: typeof pr['createdAt'] === 'string' ? pr['createdAt'] : '',
      title: typeof pr['title'] === 'string' ? pr['title'] : '',
      webUrl: typeof pr['url'] === 'string' ? pr['url'] : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Work-queue enumeration (issue #15)
//
// The queue is no longer a prompt command (see plan-prompt.md): main.ts lists
// issues for EACH configured queue label and unions by number, so a consumer's
// "ready" label need not be `sandcastle`. These pure argv builders + parsers +
// the dedupe are the pieces the host wrappers compose; the wrapper itself
// (queueIssues) lives in createHost() below.
// ---------------------------------------------------------------------------

/** A queued issue, normalized across hosts (glab `iid`/`description` ↔ gh `number`/`body`). */
export interface QueueIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** glab `issue list --label <l> --output json` argv. */
export function glabQueueListArgs(label: string): readonly string[] {
  return ['issue', 'list', '--label', label, '--output', 'json', '--per-page', '100'];
}

/** gh `issue list --label <l> --json number,title,body,labels` argv.
 *  No `--state`: gh AND glab both default to OPEN issues, and glab has no `--state`
 *  flag at all (it uses `--closed`/`--all`), so leaning on the shared default keeps
 *  the two hosts symmetric (issue #15). */
export function ghQueueListArgs(label: string): readonly string[] {
  return ['issue', 'list', '--label', label, '--limit', '100', '--json', 'number,title,body,labels'];
}

/** Shared skeleton for glab/gh issue-list parsing: both emit a JSON array of issues
 *  that differ only by the number key (`iid` vs `number`), the body key
 *  (`description` vs `body`), and the label shape (`string[]` vs `[{name}]`). */
interface QueueListShape {
  readonly numberKey: string;
  readonly bodyKey: string;
  /** Pull a name-only label list out of the raw `labels` field. */
  readonly normalizeLabels: (raw: unknown) => readonly string[];
  /** Host name, for the non-array error message only. */
  readonly host: string;
}
function parseQueueList(raw: string, shape: QueueListShape): QueueIssue[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${shape.host} returned a non-array issue list: ${raw.slice(0, 200)}`);
  }
  const out: QueueIssue[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const issue = entry as Record<string, unknown>;
    const number = issue[shape.numberKey];
    if (typeof number !== 'number') continue;
    const body = issue[shape.bodyKey];
    out.push({
      number,
      title: typeof issue['title'] === 'string' ? issue['title'] : '',
      body: typeof body === 'string' ? body : '',
      labels: shape.normalizeLabels(issue['labels']),
    });
  }
  return out;
}

/** Parse glab's issue list into QueueIssue[]; rows without a numeric `iid` are dropped, not fatal. */
export function parseGlabQueue(raw: string): QueueIssue[] {
  return parseQueueList(raw, {
    host: 'glab',
    numberKey: 'iid',
    bodyKey: 'description',
    normalizeLabels: (raw) =>
      Array.isArray(raw) ? raw.filter((label): label is string => typeof label === 'string') : [],
  });
}

/** Parse gh's issue list (`labels:[{name}]`) into QueueIssue[]; rows without a numeric `number` are dropped, not fatal. */
export function parseGhQueue(raw: string): QueueIssue[] {
  return parseQueueList(raw, {
    host: 'gh',
    numberKey: 'number',
    bodyKey: 'body',
    normalizeLabels: (raw) =>
      Array.isArray(raw)
        ? raw
            .map((label) => (label && typeof label === 'object' && 'name' in label ? label.name : undefined))
            .filter((name): name is string => typeof name === 'string')
        : [],
  });
}

/**
 * Union queued issues by number: an issue with two queue labels appears in two
 * per-label lists — keep the first occurrence only (gh/glab return the issue's
 * FULL label set on every hit, so no label information is lost). Order is stable.
 */
export function dedupeQueue(issues: readonly QueueIssue[]): QueueIssue[] {
  const seen = new Set<number>();
  const out: QueueIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    out.push(issue);
  }
  return out;
}

/**
 * Which configured queue labels an issue actually carries — the set the
 * implementer must REMOVE to take the issue out of the queue (issue #15: a
 * captable issue carries `ready-for-agent`, not `sandcastle`). Returns them in
 * configured order; empty if the issue has none (defensive — it would not have
 * been queued).
 */
export function claimLabels(issueLabels: readonly string[], queueLabels: readonly string[]): string[] {
  return queueLabels.filter((label) => issueLabels.includes(label));
}

// ---------------------------------------------------------------------------
// Origin-host inference — for the startup / dry-run mismatch warning
//
// Conservative: only flags a mismatch when the remote's host is recognisably the
// OTHER supported host. An unrecognised host (a private Gitea, a company git
// server) returns null and emits no warning — it cannot tell the operator
// anything truthful about glab-vs-gh. Both SaaS and self-hosted/Enterprise
// hostnames are matched by substring.
// ---------------------------------------------------------------------------

export function inferGitHostFromUrl(url: string): GitHost | null {
  const lower = url.toLowerCase();
  if (lower.includes('github')) return 'gh';
  if (lower.includes('gitlab')) return 'glab';
  return null;
}

// ---------------------------------------------------------------------------
// Factory — bind the host's executing wrappers. Each is a thin shell over
// execFileSync using the pure builders/parsers above; the host decision lives in
// one branch per CLI, and main.ts never spells `glab` or `gh` itself.
// ---------------------------------------------------------------------------

export interface Host {
  /** Issue's labels, read host-side (the authoritative base-branch source). */
  labelsOf(issueNumber: number): string[];
  /** Issue facts for the Draft-MR/PR body (best-effort: never throws). */
  issueInfoOf(issueNumber: number, fallbackTitle: string): IssueInfo;
  /** Push happened already on the host; this opens the Draft MR/PR. */
  createDraftChangeRequest(args: CreateChangeRequestArgs): void;
  /** Every open MR/PR of the current repo (for chained-base resolution). */
  openChangeRequests(): OpenMergeRequest[];
  /** The work queue: open issues carrying ANY of the given labels, deduped by number. */
  queueIssues(labels: readonly string[]): QueueIssue[];
}

export function createHost(host: GitHost): Host {
  if (host === 'gh') {
    return {
      labelsOf: (issueNumber) =>
        parseGhIssueLabels(
          execFileSync('gh', ghIssueLabelsArgs(issueNumber), { encoding: 'utf8' }),
        ),
      issueInfoOf: (issueNumber, fallbackTitle) => {
        try {
          const raw = execFileSync('gh', ghIssueViewArgs(issueNumber), { encoding: 'utf8' });
          return parseGhIssue(raw, fallbackTitle, issueNumber);
        } catch (error) {
          console.error(`  ⚠ #${issueNumber}: could not read the issue for the PR body — ${error}`);
          return { number: issueNumber, title: fallbackTitle };
        }
      },
      createDraftChangeRequest: (args) => {
        execFileSync('gh', ghPrCreateArgs(args), { stdio: 'inherit' });
      },
      openChangeRequests: () =>
        parseGhPrList(execFileSync('gh', ghPrListArgs(), { encoding: 'utf8' })),
      queueIssues: (labels) =>
        dedupeQueue(
          labels.flatMap((label) =>
            parseGhQueue(execFileSync('gh', ghQueueListArgs(label), { encoding: 'utf8' })),
          ),
        ),
    };
  }

  return {
    labelsOf: (issueNumber) =>
      parseGlabIssueLabels(
        execFileSync(
          'glab',
          ['issue', 'view', String(issueNumber), '--output', 'json', '--jq', '.labels'],
          { encoding: 'utf8' },
        ),
      ),
    issueInfoOf: (issueNumber, fallbackTitle) => {
      try {
        const raw = execFileSync(
          'glab',
          ['issue', 'view', String(issueNumber), '--output', 'json'],
          { encoding: 'utf8' },
        );
        return parseGlabIssue(raw, fallbackTitle, issueNumber);
      } catch (error) {
        console.error(`  ⚠ #${issueNumber}: could not read the issue for the MR body — ${error}`);
        return { number: issueNumber, title: fallbackTitle };
      }
    },
    createDraftChangeRequest: (args) => {
      execFileSync('glab', glabMrCreateArgs(args), { stdio: 'inherit' });
    },
    openChangeRequests: () =>
      parseOpenMergeRequests(
        execFileSync('glab', ['mr', 'list', '--output', 'json', '--per-page', '100'], {
          encoding: 'utf8',
        }),
      ),
    queueIssues: (labels) =>
      dedupeQueue(
        labels.flatMap((label) =>
          parseGlabQueue(execFileSync('glab', glabQueueListArgs(label), { encoding: 'utf8' })),
        ),
      ),
  };
}
