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

import { execFileSync, spawnSync } from 'node:child_process';
import type { GitHost } from './config.ts';
import { type OpenMergeRequest } from './chain.ts';
import type { IssueInfo } from './mr-body.ts';

/** Per-host display terms for operator-facing messages (main.ts error fallback, chain logs, etc.). */
export const HOST_TERMS: Readonly<Record<GitHost, { cr: string; cli: string; name: string; ref: string }>> = {
  glab: { cr: 'merge request', cli: 'glab', name: 'GitLab', ref: '!' },
  gh: { cr: 'pull request', cli: 'gh', name: 'GitHub', ref: '#' },
  // `local` has no collaboration CLI: the terms are placeholders so the Record<GitHost,…>
  // type stays total. The no-tracker loop is fenced in main.ts (v0.1 ships the two tracker
  // hosts), so these never reach a host command — they exist only to satisfy the type and
  // to read sensibly if ever printed in a config/dry-run report.
  local: { cr: 'change', cli: '', name: 'local (no tracker)', ref: '' },
};

// ---------------------------------------------------------------------------
// Host-CLI auth token (issue #17)
//
// The role prompts run `gh`/`glab` INSIDE the agent sandbox (planner reads the
// queue + issue, implementer unlabels + comments at queue-exit). Those sandboxes
// carry the binary but, before this, no credentials — so every in-sandbox host
// command exited 4 (`please run: gh auth login`) and Phase 1 died before emitting
// a plan. The fix is NOT another envFor() relay: the Engine's resolveEnv already
// merges .sandcastle/.env into every sandbox, so a conventionally-named token
// placed there (or exported in the shell, which resolveEnv also picks up per key)
// auths the in-sandbox CLI with zero main.ts patching. main.ts only VALIDATES it is
// present at startup — these helpers say which key, per host, and build the
// actionable missing-token message.
// ---------------------------------------------------------------------------

/**
 * The env var the host CLI reads for auth, by `gitHost`:
 *   gh → GH_TOKEN, glab → GITLAB_TOKEN, local → null (no host CLI, no token).
 * `null` is how main.ts' startup guard knows a host needs NO token — a local /
 * no-tracker consumer is never asked for one (issue #17, acceptance #2).
 */
export function hostTokenKey(host: GitHost): string | null {
  if (host === 'gh') return 'GH_TOKEN';
  if (host === 'glab') return 'GITLAB_TOKEN';
  return null; // 'local'
}

/**
 * The actionable message thrown at startup when a required host token is missing
 * (neither the environment nor `.sandcastle/.env` sets it). Names the var AND the
 * file resolveEnv flows, plus the host's own `auth login` / `auth token` commands,
 * so an operator copy-pastes their way out. Never called for `local`
 * (hostTokenKey('local') === null ⇒ no requirement) — defensive generic fallback
 * if it ever is.
 */
export function hostTokenMissingMessage(key: string, host: GitHost, dotenvPath: string): string {
  // Only gh/glab are ever validated (hostTokenKey('local') === null ⇒ no requirement ⇒ this
  // is never called for `local`); the generic fallback below is defensive. The two tracker
  // hosts share one message shape — they differ only in the CLI name, which IS the host.
  if (host !== 'gh' && host !== 'glab') {
    return `${key} is not set in the environment or in ${dotenvPath}.`;
  }
  const cli = host; // 'gh' | 'glab'
  return (
    `${key} is not set. The planner/implementer run \`${cli}\` inside the sandbox, which needs ` +
    `auth there. Put the token in ${dotenvPath} — the Engine's resolveEnv flows that file ` +
    `into every sandbox, so no main.ts patch is needed:\n` +
    `  echo "${key}=$(${cli} auth token)" >> ${dotenvPath}   # after \`${cli} auth login\`\n` +
    `…or export it once in your shell (~/.bashrc); resolveEnv picks up env vars too. ` +
    `A \`local\` gitHost (no tracker) needs no host token.`
  );
}

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
// Draft change-request OUTPUT (issue #21)
//
// `gh pr create` (and, defensively, `glab mr create`) prints the new MR/PR URL to
// stdout but ALSO emits, to stderr, a line like "Warning: 2 uncommitted changes".
// That warning is about the HOST working tree — the consumer's main checkout that
// main.ts runs from, which carries the adopt-time `@ai-hero/sandcastle` runtime dep
// in `package.json`/lockfile and is therefore never clean. It is NEVER about the
// agent's work: the implementer committed to the worktree branch and Phase 3 pushed
// it before this call, so the agent's changes are already on the remote branch, not
// sitting uncommitted in the host tree. Printed bare between `git push` and the PR
// URL, it reads exactly like "the implementer left work behind" — the same cosmetic
// noise #20 was filed for, but a different cause (#20 traced it to the agent
// worktree's `.pnpm-store/`; the live captable run pinned it here, on gh).
//
// So the publish phase CAPTURES the host CLI's output instead of inheriting its
// stdio, drops that one misleading line, and prints the URL + any real stderr (auth
// errors, other warnings) verbatim. The filter is surgical — only the exact host-tree
// uncommitted-changes warning is removed, never stderr at large (acceptance #2: a
// genuine signal still surfaces). Pure, unit-tested in host.test.ts.
// ---------------------------------------------------------------------------

/** Matches gh's "Warning: N uncommitted changes" — the host-tree false positive we drop. */
const UNCOMMITTED_CHANGES_WARNING = /^\s*warning:\s+\d+\s+uncommitted\s+change/i;

/** True for the host-tree "Warning: N uncommitted changes" line only (real signal is left alone). */
export function isUncommittedChangesWarning(line: string): boolean {
  return UNCOMMITTED_CHANGES_WARNING.test(line);
}

/** Remove the uncommitted-changes warning line(s) from a stream, leaving every other line. */
function dropUncommittedChangesWarning(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isUncommittedChangesWarning(line))
    .join('\n');
}

/** The host CLI's `create` output, classified for the publish phase. */
export interface DraftCreateOutput {
  /** Stdout with the warning line removed — the MR/PR URL rides here (printed verbatim). */
  readonly out: string;
  /** Filtered stderr — the warning line removed, trimmed. Real signal; surfaced if non-empty. */
  readonly advisory: string;
}

/**
 * Split captured `gh pr create` / `glab mr create` output into the success output
 * (printed — the URL) and advisory stderr (surfaced unless empty). The host-tree
 * "Warning: N uncommitted changes" line is dropped from BOTH streams; every other
 * line — the URL, "Creating pull request for …", a DIFFERENT warning, an auth error
 * — is preserved. Pure: no CLI, no process, unit-tested in host.test.ts.
 */
export function classifyDraftCreateOutput(stdout: string, stderr: string): DraftCreateOutput {
  return {
    out: dropUncommittedChangesWarning(stdout),
    advisory: dropUncommittedChangesWarning(stderr).trim(),
  };
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

/**
 * Run a host CLI's draft-MR/PR `create`, CAPTURING its output (not inheriting
 * stdio) so the publish phase can drop the host-tree "Warning: N uncommitted
 * changes" false positive and print the URL + real stderr itself (issue #21).
 * Throws on non-zero exit with the CLI's stderr in the message, so main.ts's
 * per-branch catch renders the manual-create hint with useful diagnostics — the
 * same shape `execFileSync`'s exception gave before this captured the stream.
 * The `\`gh pr create\`` / `\`glab mr create\`` prefix in the message is read off
 * the argv so it names the exact command that failed.
 */
function runDraftCreate(cli: 'gh' | 'glab', argv: readonly string[]): void {
  const result = spawnSync(cli, argv, { encoding: 'utf8' });
  if (result.status !== 0) {
    const signal = result.signal ? ` (signal ${result.signal})` : '';
    const stderr = (result.stderr ?? '').trim();
    const detail = stderr !== '' ? stderr : 'no stderr captured';
    const subcommand = argv.slice(0, 2).join(' '); // 'pr create' | 'mr create'
    throw new Error(`\`${cli} ${subcommand}\` failed (exit ${result.status}${signal}):\n${detail}`);
  }
  const { out, advisory } = classifyDraftCreateOutput(result.stdout ?? '', result.stderr ?? '');
  if (out !== '') process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  if (advisory !== '') console.warn(advisory);
}

// ---------------------------------------------------------------------------
// Host-read failure classification + retry (issue #25)
//
// Three of the five verbs below (labelsOf, openChangeRequests, queueIssues) had
// no try, no catch and no retry: a TRANSIENT host outage — 5xx, severed
// connection, timeout — killed the run at whatever iteration it landed on, after
// the agents had already produced work. Observed 2026-08-17 during a partial
// GitHub outage (API Requests in major_outage, GraphQL answering 1-in-8) with
// 4998/5000 requests left: not quota, pure transience. issueInfoOf already
// degraded gracefully on the same grounds — "a thinner MR is a nuisance, a run
// dead after two agent cycles is a loss" (main.ts) — the asymmetry was an
// oversight, not a trade.
//
// A DEFINITIVE failure (404, auth, missing scope, exhausted quota) must NOT be
// retried: waiting changes nothing, and hiding a 404 behind three attempts costs
// time without saving the run. So the classification is a pure function over the
// failing invocation's (status, stderr) — the two things an execFileSync throw
// carries — unit-tested on captured real CLI output like every other parser here.
// ---------------------------------------------------------------------------

/** What a failed host read is, once classified. `reason` rides into the retry log. */
export interface HostFailure {
  /** True when another attempt could plausibly succeed (5xx, outage, quota window). */
  readonly retryable: boolean;
  /** Short stable cause for the log line — 'auth' | 'not-found' | 'quota' | 'outage' | 'unknown'. */
  readonly reason: string;
}

/**
 * Classify a failed `gh`/`glab` invocation from its exit status and captured
 * stderr — the exact fields the thrown execFileSync error exposes (main.ts and
 * the wrappers below read them off `err.status` / `err.stderr`). Both CLIs spell
 * the HTTP status the same way in their error lines (`HTTP 401:` for gh,
 * `: 401 {message:` for glab), so ONE classifier serves both; the fixtures in
 * host.test.ts are byte-accurate captures of each CLI's real output.
 *
 * Fail-open to RETRYABLE: an unrecognised wording must not kill a run on a guess,
 * because an unknown transient is the exact loss this classifier exists to
 * prevent, while an unknown-but-definitive failure still surfaces after the
 * bounded attempts.
 */
export function classifyHostFailure(status: number | null, stderr: string): HostFailure {
  const text = stderr ?? '';
  // gh prints `HTTP 401: …`; glab prints `… : 401 {message: …}`. One scan finds either.
  const ghMatch = /HTTP (\d{3}):/.exec(text);
  const glabMatch = /: (\d{3}) \{message:/.exec(text);
  const code = ghMatch ? Number(ghMatch[1]) : glabMatch ? Number(glabMatch[1]) : null;
  if (code !== null) {
    if (code >= 500 || code === 429) {
      // 5xx: the host is having a moment; 429: the window resets. Both repay waiting.
      return { retryable: true, reason: code === 429 ? 'quota' : 'outage' };
    }
    if (code === 401 || code === 403) {
      // Bad credentials / missing scope — no amount of retrying re-auths the CLI.
      return { retryable: false, reason: 'auth' };
    }
    if (code === 404 || code === 410) {
      // The thing is gone for good; three attempts only hide that.
      return { retryable: false, reason: 'not-found' };
    }
    // Any other 4xx is a request-shape problem the loop cannot fix by repeating it.
    if (code >= 400 && code < 500) return { retryable: false, reason: 'client-error' };
  }
  // gh's GraphQL flavour reports a missing issue/PR with NO status at all —
  // "Could not resolve to an issue or pull request…" — which is its 404.
  if (/could not resolve to (an|a) /i.test(text)) {
    return { retryable: false, reason: 'not-found' };
  }
  // Connection-level failure. Two spellings: the CLIs' own banners (gh "error
  // connecting to <host>", glab "x error connecting to <host>") and the Go HTTP
  // transport line both CLIs surface verbatim when the API is unreachable —
  // `Post "https://…": dial tcp …: connect: connection refused` (captured live).
  // Empty stderr (process killed pre-read) rides here too.
  if (/error connecting/i.test(text) || /\bdial tcp\b|\bi\/o timeout\b|\bcontext deadline exceeded\b/.test(text) || text.trim() === '') {
    return { retryable: true, reason: 'outage' };
  }
  // Unrecognised wording with no status: fail toward the retry, not the run — an
  // unknown transient is the exact loss this classifier exists to prevent, and an
  // unknown-but-definitive failure still surfaces after the bounded attempts.
  return { retryable: true, reason: 'unknown' };
}

/** Bounded attempts for one host read: the initial try plus the retries after it. */
export const HOST_READ_ATTEMPTS = 4;

/** First retry waits this long; each subsequent retry doubles it. */
export const HOST_RETRY_BASE_DELAY_MS = 500;

/**
 * Random extra delay added to each backoff (0…this), so two loops restarting
 * after the same outage do not resynchronise their attempts on the host.
 */
export const HOST_RETRY_JITTER_MS = 250;

/** The delay shape for one retry: the exponential base plus a jitter draw. */
export interface HostRetryPlan {
  readonly delayMs: number;
  readonly jitterMs: number;
}

/**
 * Pure retry plan for the pause BEFORE attempt N+1 (attempt is 0-based, i.e. the
 * number of failures so far). Exposed for tests; the runner below consumes it.
 */
export function hostRetryPlanFor(attempt: number, random: () => number = Math.random): HostRetryPlan {
  const exp = Math.min(attempt, HOST_READ_ATTEMPTS - 2); // cap the exponent with the attempt bound
  return {
    delayMs: HOST_RETRY_BASE_DELAY_MS * 2 ** exp,
    jitterMs: Math.floor(random() * (HOST_RETRY_JITTER_MS + 1)),
  };
}

/** What one executed attempt of a host read looked like — the runner's log input. */
export interface HostReadAttempt {
  readonly attempt: number;
  readonly status: number | null;
  readonly stderr: string;
}

/** The host-facing effects runHostRead needs; injected so tests drive them purely. */
export interface HostReadEffects {
  sleep(ms: number): void;
  log(line: string): void;
  random(): number;
}

const defaultHostReadEffects: HostReadEffects = {
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  log: (line) => console.warn(line),
  random: () => Math.random(),
};

/**
 * Run one host READ (labels / MR list / queue list) with bounded retries: a
 * retryable failure waits the exponential backoff plus jitter and tries again (N
 * attempts total), a definitive one rethrows immediately without consuming the
 * remaining attempts, and every retry logs verb, attempt and cause so a slow run
 * is readable after the fact. The read itself is injected — createHost() passes
 * an execFileSync call, tests pass a recorder — so the loop is deterministic
 * under test and the only time-based part (the sleep) is an effect.
 */
export function runHostRead(
  verb: string,
  read: () => string,
  effects: HostReadEffects = defaultHostReadEffects,
): string {
  for (let attempt = 1; attempt <= HOST_READ_ATTEMPTS; attempt++) {
    try {
      return read();
    } catch (error) {
      const err = error as Error & { status?: number | null; stderr?: string };
      const stderr = typeof err.stderr === 'string' ? err.stderr : err.message ?? '';
      const failure = classifyHostFailure(typeof err.status === 'number' ? err.status : null, stderr);
      if (!failure.retryable || attempt === HOST_READ_ATTEMPTS) {
        throw error;
      }
      const { delayMs, jitterMs } = hostRetryPlanFor(attempt - 1, effects.random);
      const pauseMs = delayMs + jitterMs;
      const cause = stderr.split('\n')[0]?.trim() || 'no stderr captured';
      effects.log(
        `  ⚠ ${verb} failed (attempt ${attempt}/${HOST_READ_ATTEMPTS}, ${failure.reason}): ${cause} — retrying in ${pauseMs}ms`,
      );
      effects.sleep(pauseMs);
    }
  }
  throw new Error(`runHostRead(${verb}): unreachable — the loop always returns or throws`);
}

// ---------------------------------------------------------------------------
// Factory — bind the host's executing wrappers. Each is a thin shell over
// execFileSync (or spawnSync, for the captured-output create above) using the pure
// builders/parsers; the host decision lives in one branch per CLI, and main.ts
// never spells `glab` or `gh` itself.
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
  // One read = one retrying runHostRead. The verb string names the exact CLI
  // invocation in the retry log, so a slow run reads back unambiguously.
  const ghRead = (verb: string, argv: readonly string[]): string =>
    runHostRead(`gh ${verb}`, () => execFileSync('gh', argv, { encoding: 'utf8' }));
  const glabRead = (verb: string, argv: readonly string[]): string =>
    runHostRead(`glab ${verb}`, () => execFileSync('glab', argv, { encoding: 'utf8' }));

  if (host === 'gh') {
    return {
      labelsOf: (issueNumber) =>
        parseGhIssueLabels(ghRead('issue view (labels)', ghIssueLabelsArgs(issueNumber))),
      issueInfoOf: (issueNumber, fallbackTitle) => {
        try {
          const raw = ghRead('issue view (info)', ghIssueViewArgs(issueNumber));
          return parseGhIssue(raw, fallbackTitle, issueNumber);
        } catch (error) {
          console.error(`  ⚠ #${issueNumber}: could not read the issue for the PR body — ${error}`);
          return { number: issueNumber, title: fallbackTitle };
        }
      },
      createDraftChangeRequest: (args) => runDraftCreate('gh', ghPrCreateArgs(args)),
      openChangeRequests: () => parseGhPrList(ghRead('pr list', ghPrListArgs())),
      queueIssues: (labels) =>
        dedupeQueue(
          labels.flatMap((label) =>
            parseGhQueue(ghRead(`issue list --label ${label}`, ghQueueListArgs(label))),
          ),
        ),
    };
  }

  // 'local' (and any future host) has no collaboration CLI wired — refuse instead of
  // silently falling through to the glab shape below. main.ts fences this earlier with
  // a clearer, operator-facing message; this throw is the belt for any direct caller.
  if (host !== 'glab') {
    throw new Error(`createHost: gitHost=${host} has no host-CLI wiring (v0.1 ships gh/glab only).`);
  }

  return {
    labelsOf: (issueNumber) =>
      parseGlabIssueLabels(
        glabRead('issue view (labels)', [
          'issue',
          'view',
          String(issueNumber),
          '--output',
          'json',
          '--jq',
          '.labels',
        ]),
      ),
    issueInfoOf: (issueNumber, fallbackTitle) => {
      try {
        const raw = glabRead('issue view (info)', [
          'issue',
          'view',
          String(issueNumber),
          '--output',
          'json',
        ]);
        return parseGlabIssue(raw, fallbackTitle, issueNumber);
      } catch (error) {
        console.error(`  ⚠ #${issueNumber}: could not read the issue for the MR body — ${error}`);
        return { number: issueNumber, title: fallbackTitle };
      }
    },
    createDraftChangeRequest: (args) => runDraftCreate('glab', glabMrCreateArgs(args)),
    openChangeRequests: () =>
      parseOpenMergeRequests(
        glabRead('mr list', ['mr', 'list', '--output', 'json', '--per-page', '100']),
      ),
    queueIssues: (labels) =>
      dedupeQueue(
        labels.flatMap((label) =>
          parseGlabQueue(glabRead(`issue list --label ${label}`, glabQueueListArgs(label))),
        ),
      ),
  };
}
