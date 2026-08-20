// The Factory's canonical Orchestration — plan → implement+review (≤ MAX_PARALLEL)
// → Draft MR per branch, all driven by the config surface in ./config.ts.
//
// This is the converged shape of the four diverged per-instance main.* files
// (ccsnoop + omniris api/back-office/design-system). It reads its entire regime —
// providers, profiles, merge strategy, commit style, git host, base-branch policy,
// per-run knobs — from loadConfig(); there are no inline provider tables or
// SANDCASTLE_* parsers left here. See docs/adr/0004-converged-config-driven-orchestration.md.
//
//   Phase 1 (Plan):    one agent lists the queue and emits <plan> JSON choosing the
//                      issues to work this round and a branch for each.
//   Phase 2 (Work):    up to MAX_PARALLEL issues run at once. Per issue: an
//                      implementer then a *fix-in-place* reviewer that edits and
//                      commits refinements directly on the branch (no verdict, no
//                      re-implement loop). Two *sequential* sandboxes per issue on
//                      the same branch, because the provider env is baked at sandbox
//                      level — see "Model profiles" below.
//   Phase 3 (Publish): host-side `git push` + a Draft MR/PR (glab or gh, via the
//                      host module) for every branch that got commits. Never
//                      auto-merged (MERGE_STRATEGY=human, the Omniris majority):
//                      a human reviews and merges.
//
// v0.1 scope: the split regime + human-merge + BOTH host shapes (GitLab/glab and
// GitHub/gh), out of the box — see host.ts. The Merger role (MERGE_STRATEGY=agent,
// ccsnoop's auto-merging 4th agent) remains a follow-up module — see the guard
// below. Opus is just another profile in config.ts and works mechanically; it is
// not specially tested here.
//
// Usage (from the repo root — promptFile and SECRETS_PATH are CWD-relative):
//   npx tsx .sandcastle/main.ts                          # profile `split` (default)
//   SANDCASTLE_PROFILE=opus npx tsx .sandcastle/main.ts   # all roles on Opus
//   SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts       # print the wiring, launch nothing
//   SANDCASTLE_CHAIN=1 npx tsx .sandcastle/main.ts        # stacked MRs, one issue per round

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import {
  resolveChainedBase,
  decideBaseSync,
  decideChainFeasibility,
  decidePlannerChainMode,
  derivableBases,
  buildUnchainableBaseWarning,
  type OpenMergeRequest,
} from './chain.ts';
import {
  createHost,
  HOST_TERMS,
  openMrsCommand,
  promptHostArgs,
  inferGitHostFromUrl,
  manualCreateHint,
  claimLabels,
  hostTokenKey,
  hostTokenMissingMessage,
  type Host,
  type QueueIssue,
} from './host.ts';
import {
  buildMrDescription,
  buildMrTitle,
  extractMrSummary,
  extractReviewLedger,
  type CommitInfo,
  type DiffStat,
} from './mr-body.ts';
import {
  baseForLabels,
  parsePlan,
  applyOnly,
  queueChainBases,
  type PlannedIssue,
} from './plan.ts';
import {
  isLostIterationError,
  recordLostIteration,
  isRunLost,
  describeLostIteration,
  describeIterationLosses,
  type LostIteration,
} from './iteration.ts';
import { loadConfig, type Provider, type Role } from './config.ts';
import {
  buildRunBranch,
  mintRunId,
  isAgentBranch,
  runBranchBases,
  decideSweep,
  describeSweep,
  type BranchFacts,
  type RunId,
} from './branch-sweep.ts';
import { ensureWorktreeExclude } from './worktree-exclude.ts';
import {
  classifyReport,
  renderReport,
  reportCrashed,
  reportPromptArgs,
  shouldRunReport,
  type ReportOutcome,
} from './report.ts';
import {
  decideResume,
  dropPendingIssues,
  pendingFileSummary,
  readPendingPublishes,
  recordPendingPublish,
  writePendingPublishes,
  type PendingPublish,
} from './publish.ts';
import {
  parseEnvFile,
  resolveToken,
  resolveTokens,
  tokenStatus,
  assertNoTokenKeyInDotEnv,
  type ResolvedToken,
} from './tokens.ts';
import {
  sandboxImageName,
  decideImageStatus,
  describeImageStatus,
  buildMissingImageMessage,
  type SandboxImageStatus,
} from './image.ts';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;
type RunResult = Awaited<ReturnType<Sandbox['run']>>;

// ---------------------------------------------------------------------------
// Resolve the regime — everything below this line is driven by `cfg`.
//
// A *profile* assigns a *provider* to each *role*. A provider is the quadruplet
// {model, base URL, token key, reasoning effort}; a role is planner / implementer /
// reviewer (a `merger` joins only under MERGE_STRATEGY=agent, out of scope for v0.1).
// Which profile is active is a parameter of the RUN (SANDCASTLE_PROFILE), never a
// state of this file: the same regime has to hold across repos, and the config
// layer is tracked in every consumer (issue #29) — an edited main.ts or config.ts
// is reverted with `git checkout --` like any other file. A regime you cannot
// undo is worse than a verbose command line.
//
// Diversity invariant (CONDITIONAL on the profile, enforced by config.ts):
//   - `split`: the reviewer runs a different model than the implementer, so it does
//     not validate the author model's own blind spots. This is the nominal regime.
//   - `opus`:  that guarantee is deliberately given up for high-stakes tickets. Only
//     context diversity remains (fresh context, distinct prompt, isolated sandbox).
//
// The planner is assigned independently of the implementer on purpose: its output
// feeds parsePlan(), which throws for the whole round if the <plan> JSON is
// malformed, and its token cost is negligible.
// ---------------------------------------------------------------------------

const cfg = loadConfig();

// v0.1 wires BOTH tracker hosts (GitLab/glab and GitHub/gh). `local` (no tracker) is
// recognised by the token layer — hostTokenKey('local') === null, so a local consumer
// is never asked for a host token (issue #17) — but the full no-tracker loop (Phase 1-3
// without a host CLI) is not wired yet, the same fence the mergeStrategy guard below
// uses. Fail here, BEFORE createHost, rather than letting createHost silently fall
// through to the glab shape for an unwired host.
if (cfg.project.gitHost !== 'glab' && cfg.project.gitHost !== 'gh') {
  throw new Error(
    `gitHost=${cfg.project.gitHost} is not wired. v0.1 ships the GitLab (glab) and ` +
      `GitHub (gh) tracker hosts only. \`local\` is token-exempt (no host token needed) ` +
      `but its no-tracker loop is a follow-up; set gitHost: 'gh' or 'glab' to run today.`,
  );
}

// The host module owns every glab-vs-gh difference (issue view/labels, draft MR/PR
// creation, open-MR/PR listing, and the prompt-time command strings). main.ts never
// spells `glab` or `gh` itself; it goes through `host` below. See host.ts.
const host: Host = createHost(cfg.project.gitHost);
const hostTerms = HOST_TERMS[cfg.project.gitHost];

// v0.1 runs the human-merge shape only. MERGE_STRATEGY=agent (ccsnoop's auto-merging
// 4th agent) is a follow-up module; failing here, loudly and early, keeps
// mergeStrategy truthful — config.ts would otherwise add `merger` to cfg.roles,
// validateTokens would demand a merger token, and the loop below would never call it:
// the same silent no-op the gitHost guard above exists to forbid.
if (cfg.project.mergeStrategy !== 'human') {
  throw new Error(
    `mergeStrategy=${cfg.project.mergeStrategy} is reserved: v0.1 ships the human-merge shape ` +
      `only (no merger role runs). The agent Merger lands as a follow-up module. Set ` +
      `mergeStrategy: 'human' in config.ts for now.`,
  );
}

// The only bases a run may fork from / open MRs against: the project trunk, every
// configured label base, and every chainable base. Computed once, handed to parsePlan
// for the planner's advisory `base` cross-check.
const ALLOWED_BASES: readonly string[] = [
  ...new Set([
    cfg.project.baseBranch,
    ...Object.values(cfg.project.labelBases),
    ...cfg.project.chainableBases,
  ]),
];

// ---------------------------------------------------------------------------
// Chain feasibility (issue #24)
//
// The guard the revue incident asked for: SANDCASTLE_CHAIN=1 with no chainable
// base used to fall through to the plain label base without a word, and the
// operator found out only after the agents had run. Refuse HERE — before the
// dry-run report, before tokens, before any sandbox. The predicate is pure and
// lives in chain.ts (the seam this module shares with decideBaseSync); this is
// only its side-effecting edge.
//
// Placed ABOVE the dry-run block on purpose: `SANDCASTLE_DRYRUN=1` must return
// the SAME verdict as the live run, not a more optimistic one. A dry run that
// printed a healthy chain report while the live run would refuse is exactly the
// divergence the issue's fourth criterion forbids.
//
// `off` is not an error — chain simply is not active, and the round runs
// unchained like before. Only `no-chainable-base` throws.
// ---------------------------------------------------------------------------
const CHAIN_FEASIBILITY = decideChainFeasibility({
  chain: cfg.run.chain,
  baseBranch: cfg.project.baseBranch,
  labelBases: cfg.project.labelBases,
  chainableBases: cfg.project.chainableBases,
});
if (!CHAIN_FEASIBILITY.feasible && CHAIN_FEASIBILITY.reason === 'no-chainable-base') {
  throw new Error(CHAIN_FEASIBILITY.message);
}

// ---------------------------------------------------------------------------
// Auth-token isolation (env-first)
//
// A required token resolves as process.env[key] ?? .env.secrets[key] — environment
// FIRST, the gitignored .sandcastle/.env.secrets file as fallback. A consumer who
// exports the two tokens once in their shell profile (~/.bashrc) can therefore run
// any Factory instance with NO per-instance secret file (plug-and-play). The pure
// precedence lives in tokens.ts; this file does the file IO, masking, and logging.
//
// Why tokens stay out of .env (unchanged by env-first): sandcastle's resolveEnv
// merges ALL of .sandcastle/.env into every sandbox, and docker({ env }) can only
// ADD keys, never remove them. Two auth tokens in .env would both leak into every
// sandbox → claude-code picks whichever it prefers and sends it to the wrong base
// URL → 401. Env-first puts real tokens in process.env; combined with resolveEnv's
// per-key fallback to process.env, a token key accidentally placed in .env would
// leak the same way. So a startup guard below throws if .env declares any active
// provider's tokenKey, and the per-instance file is .env.secrets — gitignored,
// never read by resolveEnv, baked one-per-sandbox.
//
// Paths are CWD-relative like the promptFile paths: the loop is always run from
// inside the repo (`cd <repo> && npx tsx .sandcastle/main.ts`).
// ---------------------------------------------------------------------------

const SECRETS_PATH = path.join(process.cwd(), '.sandcastle', '.env.secrets');
const DOTENV_PATH = path.join(process.cwd(), '.sandcastle', '.env');

// .env.secrets is OPTIONAL under env-first: tokens may come entirely from the
// environment. A missing file → empty record, and validateTokens()/need() decide
// whether a required token is actually missing (neither env nor file sets it).
function loadSecrets(dryRun: boolean): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(SECRETS_PATH, 'utf8');
  } catch {
    if (dryRun) {
      console.warn(
        `[dryrun] no ${SECRETS_PATH} — tokens resolve from the environment or report <MISSING>.`,
      );
    }
    return {};
  }
  return parseEnvFile(raw);
}

const secrets = loadSecrets(cfg.run.dryRun);

// Bind the two token sources (env-first) once. Every lookup below goes through one of
// these so call sites don't repeat (process.env, secrets) and the precedence lives in
// exactly one place — the pure resolveToken/resolveTokens in tokens.ts.
const resolveKey = (key: string): ResolvedToken => resolveToken(key, process.env, secrets);
const resolveKeys = (keys: readonly string[]): ResolvedToken[] => resolveTokens(keys, process.env, secrets);

// need() routes through resolveToken so a token present in the environment satisfies
// a role even when .env.secrets omits it. Throws on MISSING (neither env nor file).
const need = (key: string): string => {
  const t = resolveKey(key);
  if (t.source === 'MISSING') {
    throw new Error(
      `Profile \`${cfg.run.profile}\` requires ${key}, but it is not set in the environment ` +
        `or in ${SECRETS_PATH}.`,
    );
  }
  return t.value;
};

// Distinct providers bound to the active profile's roles. Only these tokens are
// required — fail at startup, not at the first createSandbox.
const requiredProviders: readonly string[] = [
  ...new Set(cfg.roles.map((role) => cfg.activeProfile[role]).filter((n): n is string => typeof n === 'string')),
];
const requiredTokenKeys: readonly string[] = [
  ...new Set(requiredProviders.map((name) => cfg.project.providers[name].tokenKey)),
];

// .sandcastle/.env — read ONCE and shared by the token-key guard below and the
// host-token resolution further down. resolveEnv merges this file into every sandbox,
// so it is the ONE place a secret is allowed BY DESIGN: the host-CLI token
// (GH_TOKEN/GITLAB_TOKEN), which must flow to every sandbox so the in-sandbox `gh`/
// `glab` is authed (issue #17). Provider LLM tokens stay out of it — the guard right
// below enforces that. Missing file → empty record (the common fresh-checkout case).
let dotEnvRaw: string | undefined;
try {
  dotEnvRaw = readFileSync(DOTENV_PATH, 'utf8');
} catch {
  // No .env — the common case on a fresh checkout.
}
const dotEnv: Record<string, string> = dotEnvRaw !== undefined ? parseEnvFile(dotEnvRaw) : {};

// .env token-key guard (startup fence, like gitHost / mergeStrategy above). A PROVIDER
// token key in .env leaks into every sandbox under env-first → 401; fail loudly before
// any agent runs. The host token (GH_TOKEN/GITLAB_TOKEN) is the deliberate, documented
// exception: it is NOT a provider tokenKey, so this guard lets it through on purpose —
// it MUST be in .env (or the env) so resolveEnv flows it. See tokens.ts / issue #17.
if (dotEnvRaw !== undefined) assertNoTokenKeyInDotEnv(dotEnvRaw, requiredTokenKeys);

// Warn when a token is set in BOTH the environment and .env.secrets with different
// values — env still wins; this just surfaces "why is it using the wrong token".
// Shared by reportTokens (startup) and the dry-run block so the wording is identical.
const warnConflicts = (resolved: readonly ResolvedToken[]): void => {
  for (const t of resolved) {
    if (t.conflict) {
      console.warn(
        `  ⚠ ${t.key} is set in both the environment and ${SECRETS_PATH} with different ` +
          `values — using the environment value.`,
      );
    }
  }
};

// Startup report: resolve every required token env-first, print each one's source
// (env / .env.secrets / MISSING) with the value masked, and warn on env-vs-file
// conflicts. No throw — validateTokens() throws on MISSING after this returns. The
// dry-run block builds its own structured report but reuses warnConflicts() so the
// conflict wording stays identical across modes.
const reportTokens = (): ResolvedToken[] => {
  const resolved = resolveKeys(requiredTokenKeys);
  for (const t of resolved) {
    const status = tokenStatus(t);
    console.log(`  • ${t.key}: ${status.source} (${status.value})`);
  }
  warnConflicts(resolved);
  return resolved;
};

// Startup validation: report, then fail if any required token resolves to MISSING.
const validateTokens = (): void => {
  const resolved = reportTokens();
  const missing = resolved.filter((t) => t.source === 'MISSING');
  if (missing.length > 0) {
    throw new Error(
      `Profile \`${cfg.run.profile}\` requires ${missing.map((m) => m.key).join(', ')} — ` +
        `not set in the environment or in ${SECRETS_PATH}.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Host-CLI token (issue #17)
//
// The planner/implementer prompts run `gh`/`glab` INSIDE the sandbox; that sandbox
// must have the host CLI authed. The Engine's resolveEnv already flows .env (and, per
// key, the environment) into every sandbox, so the token is NOT injected via envFor —
// main.ts only VALIDATES it is present at startup, then reports it. A consumer who
// drops the conventionally-named token into .env (or exports it) therefore runs the
// planner with no main.ts patch (the captable hack that patched envFor is obsolete).
//
// Resolves env-first against .env — NOT .env.secrets: resolveEnv does not read
// .env.secrets, so a host token filed there would never reach the sandbox. `local`
// (no tracker) needs no host token: hostTokenKey('local') === null skips entirely.
// ---------------------------------------------------------------------------
const hostKey = hostTokenKey(cfg.project.gitHost);
const hostToken: ResolvedToken | null =
  hostKey === null ? null : resolveToken(hostKey, process.env, dotEnv, '.env');

// Source-only report (value masked via tokenStatus), labelled so it reads as the host
// credential alongside the provider tokens above. Skipped for `local`.
const reportHostToken = (): void => {
  if (hostToken === null) return;
  const status = tokenStatus(hostToken);
  console.log(`  • ${hostToken.key}: ${status.source} (${status.value}) — in-sandbox ${hostTerms.cli} auth`);
};

// A host token placed in .env.secrets (the LLM-token file) looks set to the operator
// but does NOT flow to the sandbox — resolveEnv reads .env, not .env.secrets — so the
// in-sandbox CLI would still be unauthed and exit 4. Warn and point at .env. Uses
// hostToken.key (not the outer hostKey) so the guard needs no separate null-narrowing.
const warnHostTokenInSecrets = (): void => {
  if (hostToken === null || hostToken.source !== 'MISSING') return;
  const inSecrets = secrets[hostToken.key];
  if (inSecrets !== undefined && inSecrets !== '') {
    console.warn(
      `  ⚠ ${hostToken.key} is set in ${SECRETS_PATH}, but resolveEnv does not read that file — ` +
        `move it to ${DOTENV_PATH} (or export it in your shell) so it flows into every sandbox.`,
    );
  }
};

// Startup guard (mirrors validateTokens): fail before the first sandbox, naming the var
// AND the file resolveEnv flows. No-op for `local` (no host CLI → no token required).
const validateHostToken = (): void => {
  if (hostToken === null) return;
  if (hostToken.source === 'MISSING') {
    throw new Error(hostTokenMissingMessage(hostToken.key, cfg.project.gitHost, DOTENV_PATH));
  }
};

// ---------------------------------------------------------------------------
// Sandbox-image pre-flight (issue #16)
//
// The Engine tags the sandbox `sandcastle:<lowercased-repo-basename>`. If that
// image isn't built, the planner sandbox dies with a raw WorktreeError mid-loop.
// Probe it here — before any agent burns tokens — and turn a missing image into
// an actionable build prompt. The pure name/decision/message logic lives in
// image.ts (unit-tested in image.test.ts); only the docker IO is here.
const SANDBOX_IMAGE = sandboxImageName(process.cwd());

// `docker info` first: a dead daemon makes `docker image inspect` fail for EVERY
// image, so probing the image while the daemon is down would cry "missing" and
// mislead. decideImageStatus (image.ts) makes that guard explicit.
const sandboxImageStatus = (): SandboxImageStatus => {
  let daemonUp = true;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    daemonUp = false;
  }
  let imageExists = false;
  if (daemonUp) {
    try {
      execFileSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore' });
      imageExists = true;
    } catch {
      imageExists = false;
    }
  }
  return decideImageStatus({ daemonUp, imageExists });
};

/**
 * Abort the round with an actionable message when the sandbox image is missing.
 * `daemon-down` and `built` both fall through: the former lets the Engine surface
 * docker's own daemon error (never claim "image missing" when we couldn't even
 * reach docker), the latter is the happy path. The call site catches the throw
 * and renders the message cleanly, so the operator sees guidance — not a stack.
 */
const preflightSandboxImage = (): void => {
  if (sandboxImageStatus() === 'missing') {
    throw new Error(buildMissingImageMessage(SANDBOX_IMAGE, cfg.project.gitHost));
  }
};

// Per-sandbox provider env, baked on docker({ env }) — layered ON TOP of resolvedEnv.
// Exactly ONE auth token per sandbox. All three ANTHROPIC_DEFAULT_*_MODEL are set so
// subagents and Haiku-tier calls can't silently fall through to the other provider's
// model names.
const buildEnv = (provider: Provider, token: string): Record<string, string> => ({
  ...(provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
  [provider.tokenKey]: token,
  ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.model,
});

const envFor = (role: Role): Record<string, string> => {
  const provider = cfg.providerFor(role);
  return buildEnv(provider, need(provider.tokenKey));
};

const modelFor = (role: Role): string => cfg.providerFor(role).model;

// Effort follows the PROVIDER, not the role: SANDCASTLE_PROFILE=opus therefore drops
// the GLM ceiling on its own, with nothing else to remember. If planner and
// implementer ever need to diverge, add a ROLE_EFFORT override here — a per-role
// table read *before* this fallback — rather than a second env-var regime.
const effortFor = (role: Role) => cfg.providerFor(role).effort;

const agentFor = (role: Role) => sandcastle.claudeCode(modelFor(role), { effort: effortFor(role) });

// ---------------------------------------------------------------------------
// Project toolchain — now config-driven (issue #19)
//
// The install hook and the worktree-copy list are repo-specific (yarn 4 / npm / pnpm /
// none), so they live in config.ts as ProjectConfig.hooks / .copyToWorktree and a
// consumer sets them there — not by editing this file. The Factory still ships NO
// install hook and copies node_modules only when present (a no-op in a repo that has
// none); both are the ProjectConfig defaults. A yarn-4 repo sets, in config.ts:
//   hooks: { sandbox: { onSandboxReady: [{ command: 'yarn install --immutable' }] } }
// main.ts only READS them off cfg.project below.
//
// copyToWorktree is adapted to a mutable string[] here because the Engine's option is
// typed `string[]` while the config surface stays readonly (like every other ProjectConfig
// collection); hooks passes through unchanged — config's SandboxHooks and the Engine's
// are both readonly and structurally identical.
// ---------------------------------------------------------------------------
const { hooks } = cfg.project;
const copyToWorktree: string[] = [...cfg.project.copyToWorktree];

// ---------------------------------------------------------------------------
// Chained base (SANDCASTLE_CHAIN=1)
//
// Off by default. On, a round forks from the head of the open-MR stack rooted at the
// ticket's normal base — i.e. from the previous ticket's unmerged branch — and opens
// its MR against that same branch. See chain.ts for the walk, the shape it builds,
// and what it costs (bottom-up merge order, retarget-on-merge).
//
// Two guards, both deliberate:
//   - ONLY bases in `chainableBases` chain. Chaining onto a trunk would pick up
//     whatever unrelated MR happens to be open — a colleague's, a bot's — and
//     silently make it the foundation of a ticket. A designated chainable base is a
//     private staging area for one effort, which is what makes the "most recent open
//     MR" rule safe there and nowhere else. Empty by default: a consumer opts in.
//   - ONE issue per round (effectiveMaxParallel=1 under chain). A second issue in the
//     same round would have to fork from a branch its sibling has not created yet;
//     the stack head only becomes real once Phase 3 has pushed it. Sequential is not
//     a limitation of this implementation, it is what a stack means.
// ---------------------------------------------------------------------------

// No shell-quoting helper here: every host-side command in this file goes through
// execFileSync with an argv array, so there is no shell to quote for. Phase 3
// explains why that matters for agent-authored strings.

// ---------------------------------------------------------------------------
// Base branch resolution
//
// Authoritative source is the issue's labels, read on the host via
// `host.labelsOf` — not the planner's `base` field, which is only cross-checked.
// A base ends up as a worktree fork point AND the draft change request's target
// branch; neither should depend on an agent. The host layer (host.ts) owns the
// glab-vs-gh detail of that label read; this file just consumes `string[]`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MR body inputs — the host-derived half of the Draft-MR/PR description
//
// These are facts about the issue and the branch, read from the host and git
// rather than from an agent, so they render even when an agent says nothing
// useful. Each collector is best-effort: a Draft MR/PR with a thinner description
// is a nuisance, a round that dies in Phase 3 after two agent cycles is a loss.
// `host.issueInfoOf` (host.ts) supplies the issue half; commitsOn/diffstatOf
// below supply the git half. See mr-body.ts.
//
// The repo-specific half — "what do I run to see this branch work?" (Storybook,
// make targets, etc.) and the audit command — is project context the consumer
// supplies by editing main.ts after cloning (ADR-0002). It is omitted here on
// purpose: a Factory-default MR body rests on the agents' own words and the
// derived facts, and says so (see mr-body.ts's optional `testing` / `auditCommand`).
// ---------------------------------------------------------------------------

const MR_FILE_CAP = 25;

// Newest first, which is what buildMrTitle relies on to find the implementer's
// (oldest) commit rather than the reviewer's (newest).
const commitsOn = (base: string, branch: string): CommitInfo[] => {
  try {
    return execFileSync('git', ['log', `${base}..${branch}`, '--format=%h%x09%s'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [sha, ...rest] = line.split('\t');
        return { sha: sha ?? '', subject: rest.join('\t') };
      });
  } catch (error) {
    console.error(`  ⚠ could not list commits on \`${branch}\` — ${error}`);
    return [];
  }
};

// Three dots: the diff against the MERGE BASE, which is what GitLab shows in the
// Changes tab. Two dots would fold in whatever landed on the base meanwhile.
// --- The pre-MR report phase (revue issue #26, parcours P2) -------------------
// Runs between the push and the MR creation, in its own sandbox, only when a
// consumer configured `project.report`. Everything decidable about it lives in
// report.ts — this is the side effect and nothing else.
//
// It borrows a core role's provider rather than owning one: a report is a
// reading-and-explaining job, the same shape as the review, and adding a fourth
// provider slot would make every consumer configure a model for a phase most of
// them will never enable.
const runReportPhase = async (input: {
  readonly issue: { number: number; title: string; base: string };
  readonly branch: string;
  readonly changedLines: number;
}): Promise<ReportOutcome | null> => {
  const report = cfg.project.report;
  if (report === null) return null;
  const skill = report.skill;
  try {
    const result = await sandcastle.run({
      name: `report #${input.issue.number}`,
      agent: agentFor(report.role),
      // The branch is already pushed, so a throwaway worktree at its head is all
      // the phase needs — and `run` (not `createSandbox`) is what guarantees it
      // cannot leave a commit behind on the branch the reviewer just approved.
      sandbox: docker({
        env: { ...envFor(report.role), ...report.env },
        // The Engine mounts only the worktree, so a skill symlinked into the
        // host's ~/.claude/skills is invisible in here. A consumer that wants one
        // mounts the RESOLVED directory — and, just as importantly, mounts the
        // durable drop where a failed publish leaves its replayable package. A
        // package written inside the sandbox dies with the sandbox, which is the
        // exact loss the degraded path exists to prevent.
        mounts: report.mounts,
      }),
      promptFile: report.promptFile,
      promptArgs: reportPromptArgs({
        issueNumber: input.issue.number,
        issueTitle: input.issue.title,
        branch: input.branch,
        base: input.issue.base,
        changedLines: input.changedLines,
        skill,
      }),
      idleTimeoutSeconds: report.idleTimeoutSeconds,
    });
    return classifyReport(skill, result.stdout);
  } catch (error) {
    // Never rethrown. The MR is the work; the report is a courtesy. A crash here
    // becomes a line in the MR body — the same posture the reviewer already has.
    return reportCrashed(skill, error);
  }
};

const diffstatOf = (base: string, branch: string): DiffStat => {
  try {
    const lines = execFileSync('git', ['diff', '--numstat', `${base}...${branch}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.trim() !== '');
    const all = lines.map((line) => {
      const [added, removed, ...pathParts] = line.split('\t');
      // A binary file reports `-` for both counts; Number('-') is NaN, so clamp to 0.
      const toCount = (value: string | undefined): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return {
        path: pathParts.join('\t'),
        added: toCount(added),
        removed: toCount(removed),
      };
    });
    return {
      files: all.slice(0, MR_FILE_CAP),
      omitted: Math.max(0, all.length - MR_FILE_CAP),
      insertions: all.reduce((sum, file) => sum + file.added, 0),
      deletions: all.reduce((sum, file) => sum + file.removed, 0),
    };
  } catch (error) {
    console.error(`  ⚠ could not diff \`${base}...${branch}\` — ${error}`);
    return { files: [], omitted: 0, insertions: 0, deletions: 0 };
  }
};

// A base must exist BOTH locally (git worktree forks from the local ref) and on
// origin (the host's draft-create `--target-branch`/`--base` 404s otherwise).
// Checked once per base per run, before any sandbox is created: discovering it at
// publish time would mean throwing away a full implement+review cycle.
const verifiedBases = new Set<string>();
const assertBaseUsable = (base: string): void => {
  if (verifiedBases.has(base)) return;
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${base}`], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `Base branch \`${base}\` does not exist locally. Create it before running the loop:\n` +
        `  git fetch origin && git switch ${base}`,
    );
  }
  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', base], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error(
      `Base branch \`${base}\` is not published on origin, so the host's ` +
        `\`${manualCreateHint(cfg.project.gitHost, '<branch>', base)}\` would fail ` +
        `after a full implement+review cycle.\n` +
        `  git push -u origin ${base}`,
    );
  }
  // In the DRY RUN this staleness compare is advisory and read-only (it prints the
  // warning below). In a LIVE run, syncBaseToOrigin reconciles the base instead, so
  // the compare is skipped here to avoid a misleading "forking from stale local"
  // message right before the sync fast-forwards it (issue #14). Being ahead of origin
  // is legitimate (a base you are curating locally) and never rewound either way.
  if (cfg.run.dryRun) {
    try {
      const local = execFileSync('git', ['rev-parse', `refs/heads/${base}`], {
        encoding: 'utf8',
      }).trim();
      const remote = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${base}`], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)[0];
      if (remote !== undefined && remote !== local) {
        console.warn(
          `  ⚠ base \`${base}\`: local ${local.slice(0, 8)} ≠ origin ${remote.slice(0, 8)}. ` +
            `Agents fork from the LOCAL ref — if it is behind, this round is built on old code.\n` +
            `    git fetch origin && git switch ${base} && git pull`,
        );
      }
    } catch {
      // Comparison is advisory; the two hard checks above already passed.
    }
  }
  verifiedBases.add(base);
};

// A chained base is a branch a PREVIOUS round pushed, so unlike a curated base it can
// legitimately be absent from this clone — another machine ran that round, or the
// local ref was pruned. Recover it from origin instead of telling the operator to
// create a branch that already exists. Silent when the ref is already there.
const ensureLocalRef = (branch: string): void => {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { stdio: 'ignore' });
    return;
  } catch {
    // Not local yet — fall through and try to bring it down.
  }
  console.log(`  ↓ fetching chained base \`${branch}\` from origin (absent locally)`);
  // Explicit refspec, not a bare `git fetch`: this must create the LOCAL branch,
  // which is what `git worktree` forks from. Fails loudly if origin lost it too.
  execFileSync('git', ['fetch', 'origin', `${branch}:${branch}`], { stdio: 'inherit' });
};

// Reconcile a base branch with origin before agents fork from it (issue #14): a
// round that forks from a stale local base builds on old code. Fast-forward only — a
// base curated locally ahead of origin is legitimate and never rewound, and true
// divergence is left for the operator. LIVE path only (the dry run keeps the
// read-only staleness warning in assertBaseUsable and exits before the loop).
// Idempotent per base per run: a chained round touches the same trunk repeatedly.
const syncedBases = new Set<string>();
const syncBaseToOrigin = (base: string): void => {
  // Localized non-mutation guarantee (issue #14): the dry run also exits before the
  // loop, but this keeps the "never fetch/ff in a dry run" contract from depending on
  // that exit staying where it is today.
  if (cfg.run.dryRun) return;
  if (syncedBases.has(base)) return;
  syncedBases.add(base);
  try {
    execFileSync('git', ['fetch', 'origin', base], { stdio: 'ignore' });
  } catch {
    console.warn(
      `  ⚠ base \`${base}\`: could not fetch origin to sync — forking from the local ref (it may be stale).`,
    );
    return;
  }
  let local: string;
  let remote: string;
  try {
    local = execFileSync('git', ['rev-parse', `refs/heads/${base}`], { encoding: 'utf8' }).trim();
    remote = execFileSync('git', ['rev-parse', `refs/remotes/origin/${base}`], { encoding: 'utf8' }).trim();
  } catch {
    return; // assertBaseUsable already guaranteed both refs exist.
  }
  if (local === remote) return; // already at origin's tip
  const isAncestor = (a: string, b: string): boolean => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const decision = decideBaseSync({
    originAheadOfLocal: isAncestor(local, remote),
    localAheadOfOrigin: isAncestor(remote, local),
  });
  if (decision === 'fast-forward') {
    try {
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      if (current === base) {
        // Checked out: merge --ff-only moves HEAD and the working tree together.
        execFileSync('git', ['merge', '--ff-only', `origin/${base}`], { stdio: 'inherit' });
      } else {
        // Not checked out: fast-forward the local ref (refuses if it is checked out
        // in any worktree, so this never clobbers a colleague's checkout).
        execFileSync('git', ['fetch', 'origin', `${base}:${base}`], { stdio: 'inherit' });
      }
      console.log(`  ↻ base \`${base}\` fast-forwarded to origin (${local.slice(0, 8)} → ${remote.slice(0, 8)}).`);
    } catch {
      console.warn(`  ⚠ base \`${base}\` could not be fast-forwarded — forking from the local ref.`);
    }
  } else if (decision === 'ahead') {
    console.warn(
      `  ⚠ base \`${base}\` is ahead of origin — keeping the local ref (local curation is legitimate; not pushed back).`,
    );
  } else {
    console.warn(
      `  ⚠ base \`${base}\` diverged from origin — not syncing (fast-forward only). Reconcile by hand if intended.`,
    );
  }
};

// Resolve the base a ticket should actually be built on. Without SANDCASTLE_CHAIN
// this is exactly the label-derived base; with it, the head of the open-MR stack
// rooted there. Logs the whole stack, because "which branch did this fork from" stops
// being obvious the moment it is not the configured base.
//
// A chained round whose ticket's base is NOT chainable warns per ticket (issue #24):
// the startup guard already proved at least one base chains, but this ticket derives
// another one, and the run silently degrading to unchained FOR THIS TICKET is the
// fact the operator needs in the log — ticket by ticket, not as a round-level remark.
const resolveBase = (issueNumber: number, labelBase: string): string => {
  if (!cfg.run.chain) return labelBase;
  // The helper re-checks membership (it returns '' for a chainable base, so it is safe
  // to call anywhere); branching on its result rather than on the list keeps the
  // "chainable ⇒ no warning" invariant in ONE place, and never prints a bare prefix.
  const unchainable = buildUnchainableBaseWarning(issueNumber, labelBase, cfg.project.chainableBases);
  if (unchainable !== '') {
    console.warn(`  ⛓ ⚠ chain: ${unchainable}`);
    return labelBase;
  }

  const resolution = resolveChainedBase(host.openChangeRequests(), labelBase);
  if (!resolution.chained) {
    console.log(`  ⛓ chain: no open MR on \`${labelBase}\` — starting a new stack from it.`);
    return labelBase;
  }

  console.log(`  ⛓ chain: ${resolution.stack.length} unmerged ${hostTerms.cr}(s) stacked on \`${labelBase}\`:`);
  for (const [index, mr] of resolution.stack.entries()) {
    console.log(`      ${index + 1}. ${hostTerms.ref}${mr.iid} ${mr.sourceBranch} → ${mr.targetBranch}`);
  }
  for (const rival of resolution.rivals) {
    // Not an error: two MRs/PRs on one branch is a legal shape. But the loser's work is
    // invisible to the ticket about to start, and that surprises people.
    console.warn(
      `  ⚠ chain: ${hostTerms.ref}${rival.iid} (${rival.sourceBranch}) also builds on this stack but is ` +
        `NOT the head — its work will not be visible to this round.`,
    );
  }
  console.log(`  ⛓ chain: forking from and targeting \`${resolution.base}\`.`);

  ensureLocalRef(resolution.base);
  return resolution.base;
};

// ---------------------------------------------------------------------------
// Startup sweep of dead runs' empty branches (issue #28)
//
// The naming half of the fix lives in branch-sweep.ts; this is the net half. A run
// killed mid-iteration leaves its agent branches behind — a bare pointer at the
// base it forked from. The next run of the same ticket would reuse that name (the
// old `-r${iteration}` suffix restarted at 1) and so fork from the dead run's base
// instead of the resolved one, silently. buildRunBranch() names branches per RUN
// now, so the collision cannot happen; this sweep removes the leftovers that are
// already here and would otherwise sit in the planner's way forever.
//
// What is safe to delete, in one line: a local `sandcastle/*` branch with no
// commit of its own and no open MR. The decision is decideSweep() in
// branch-sweep.ts — pure, unit-tested; this block only gathers the git facts and
// executes the verdict. A branch that carries commits, or an MR, is never touched:
// old and abandoned is not empty, and the whole point is that work survives.
//
// Not before Phase 1: the sweep must know which branches the CURRENT run is about
// to create, and that set is only known once the planner has spoken. A branch of
// THIS run at startup is "empty" by definition — it does not exist yet — so the
// planned names are excluded below. Anything else checked out in a worktree is
// excluded too (git would refuse the delete, and a concurrently running Factory
// instance — a sibling on another terminal — is exactly that).
// ---------------------------------------------------------------------------

/**
 * Every local branch → its tip sha, in ONE for-each-ref. The snapshot the sweep
 * measures emptiness against (see hasOwnCommits); taken once, before any deletion.
 */
const branchTips = (): Map<string, string> => {
  const out = new Map<string, string>();
  const raw = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'],
    { encoding: 'utf8' },
  );
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    out.set(trimmed.slice(0, space), trimmed.slice(space + 1));
  }
  return out;
};

/**
 * Branch → the worktree that has it checked out, from ONE `git worktree list`. A
 * live run may own any of these, so none of them is ever swept; the path is what
 * the sweep would remove alongside the branch.
 *
 * EXACT branch names, never a prefix test: `…-r<run>-1` is a string prefix of
 * `…-r<run>-10`, so matching the porcelain's `branch refs/heads/…` line by prefix
 * hands the sweep of an empty iteration-1 branch the worktree of a LIVE
 * iteration-10 one — which it then removes with `--force`. Reproduced on a
 * throwaway repo; the map keys on the full ref instead.
 */
const worktreeByBranch = (): Map<string, string> => {
  const out = new Map<string, string>();
  const BRANCH = 'branch refs/heads/';
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    let path: string | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith(BRANCH) && path !== null) out.set(line.slice(BRANCH.length).trim(), path);
    }
  } catch {
    // git worktree unavailable — read as "none": decideSweep's checkedOutElsewhere
    // then reads false and the branch still deletes (git's own "already checked
    // out" refusal is the backstop, same as the Engine's create path).
  }
  return out;
};

/**
 * Whether a branch has a commit no OTHER local branch reaches — "un commit
 * au-dessus de sa base". Measured tip-against-tips: `git rev-list <tip> --not
 * <every other branch tip>` walks the branch's history skipping what the rest of
 * the repo already holds, so the count is zero exactly when the branch is a bare
 * pointer at its fork point — including the stale case from the issue, where the
 * branch forked from an old tip of a base that has since moved on (no clean "base
 * ref" exists there, which is why this is measured against ALL other tips rather
 * than a guessed base).
 *
 * TIPS, not ref names, on purpose: the sweep deletes branches in a loop, and a
 * ref name that no longer exists makes the NEXT rev-list fatal. A tip sha keeps
 * meaning the same commit after its ref is gone, so one snapshot taken before the
 * first deletion stays valid for the whole loop — and resolves every branch in a
 * single for-each-ref instead of one rev-parse per branch.
 *
 * NOT `--not --all`: `--all` includes the branch itself, and the count would be
 * zero for everything. NOT remotes either: a branch pushed for a PR then rebased
 * locally would still share its commits with `origin/<branch>` — but its LOCAL
 * content is what this repo owns, so only local refs count.
 *
 * The exclusions go through `--stdin` (`^<sha>` lines) rather than argv: this runs
 * once per agent branch with every OTHER branch's tip, so a repo with a few
 * hundred branches would build a quadratic argument list and eventually hit
 * ARG_MAX. `--stdin` is byte-for-byte the same revision set, off the command line.
 */
const hasOwnCommits = (branch: string, tips: ReadonlyMap<string, string>): boolean => {
  const tip = tips.get(branch);
  if (tip === undefined) return true; // unresolvable ⇒ not provably empty ⇒ kept
  const exclusions = [...tips.entries()]
    .filter(([name]) => name !== branch)
    .map(([, sha]) => `^${sha}\n`)
    .join('');
  try {
    const out = execFileSync('git', ['rev-list', '--count', '--stdin', tip], {
      encoding: 'utf8',
      input: exclusions,
    }).trim();
    return Number(out) > 0;
  } catch {
    // Unreadable ⇒ treat as committed work: a branch we cannot measure is not
    // provably empty, and never swept. Same posture as a vanished base.
    return true;
  }
};

/**
 * Whether the branch's history ties back to the project's trunk — the cheap
 * "is this branch attached to this repo" check, which does not require naming a
 * base the branch no longer has (a leftover forked from an old trunk tip has no
 * base ref of its own once the trunk moves on — that is the exact #28 shape, and
 * it MUST still sweep: being an ancestor of the moved-on trunk is what a dead
 * empty leftover looks like).
 *
 * The one shape this REJECTS is unrelated history: no merge base with the trunk
 * at all — a branch grafted from somewhere else is not provably this repo's
 * leftover, and `--not` emptiness alone is too thin a basis to delete on.
 */
const attachedToTrunk = (branch: string): boolean => {
  const trunk = cfg.project.baseBranch;
  try {
    // Non-zero when the two histories share no commit at all.
    execFileSync('git', ['merge-base', branch, trunk], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const sweepDeadBranches = (protectedBranches: ReadonlySet<string>): void => {
  // Snapshot BEFORE any deletion: hasOwnCommits measures a branch against every
  // other branch TIP, and tips (shas) stay valid after their ref is deleted — see
  // hasOwnCommits. The snapshot is also the semantically right measure: "empty
  // against the repo as the sweep found it".
  let snapshot: Map<string, string>;
  try {
    snapshot = branchTips();
  } catch {
    return; // not a git repo / git broken — nothing to sweep
  }
  const agentBranches = [...snapshot.keys()].filter(isAgentBranch);
  if (agentBranches.length === 0) return;
  let openMrs: ReturnType<typeof host.openChangeRequests> = [];
  try {
    openMrs = host.openChangeRequests();
  } catch (error) {
    // No host read, no sweep: without the MR list a pushed-and-PR'd branch could
    // read as empty. The loop's own host calls will surface the failure anyway.
    console.warn(`  ⚠ sweep skipped — could not list open ${hostTerms.cr}s: ${error}`);
    return;
  }
  const mrSources = new Set(openMrs.map((mr) => mr.sourceBranch));
  const checkedOut = worktreeByBranch();
  let swept = 0;
  for (const branch of agentBranches) {
    if (protectedBranches.has(branch)) continue; // this run's — about to be created
    const facts: BranchFacts = {
      branch,
      hasOwnCommits: hasOwnCommits(branch, snapshot),
      hasOpenMr: mrSources.has(branch),
      attachedToTrunk: attachedToTrunk(branch),
      checkedOutElsewhere: checkedOut.has(branch),
    };
    const verdict = decideSweep(facts);
    if (!verdict.sweep) continue;
    // From the same snapshot the verdict was taken on, so it can only ever name
    // THIS branch's own worktree. Today the checkedOutElsewhere guard means a
    // swept branch never has one — acceptance #2 ("supprimée avec son worktree")
    // and #4 ("ne touche aucune branche d'un run en cours") overlap, and #4 wins:
    // nothing here can tell a dead run's worktree from a live one's. The removal
    // stays as the honest half of #2 and as the belt for a git that reports a
    // worktree the listing above did not.
    const worktree = checkedOut.get(branch) ?? null;
    try {
      if (worktree !== null) {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
      }
      execFileSync('git', ['branch', '-D', branch], { stdio: 'ignore' });
      swept++;
      console.log(
        `  🧹 ${describeSweep(verdict, branch)}${worktree !== null ? ` (worktree ${worktree})` : ''}`,
      );
    } catch (error) {
      console.warn(`  ⚠ could not sweep \`${branch}\` — ${error}`);
    }
  }
  if (swept === 0) {
    console.log(`  🧹 sweep: ${agentBranches.length} agent branch(es) examined, none swept.`);
  } else {
    // Drop worktree metadata the removals may have left (an unremovable dirty
    // worktree leaves a stale administrative entry); the Engine does the same
    // before forking its own.
    try {
      execFileSync('git', ['worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // advisory only
    }
  }
};

// The distinct bases a round's tickets derive (issue #30). The rule itself —
// labels → base, narrowed by SANDCASTLE_ONLY, deduped — is pure and lives in
// plan.ts beside baseForLabels, where plan.test.ts holds it; this closure only
// binds it to this run's config. Shared by the planner-mode derivation and the
// dry run's chain report, so the two can never disagree about what "the queue"
// derives.
const queueIssueBases = (queue: readonly QueueIssue[]): string[] =>
  queueChainBases(queue, {
    labelBases: cfg.project.labelBases,
    baseBranch: cfg.project.baseBranch,
    only: cfg.run.only,
  });

// What resolveBase() would return tonight, for the dry run. Read-only: no fetch, no
// local ref created. Never throws — a dry run on a machine where glab is not authed
// must still print the profile wiring it was mainly asked about.
//
// `feasible` mirrors the startup verdict (which has ALREADY thrown by the time this
// runs — a dry run reached here only because chaining is feasible), and
// `unchainableDerivableBases` names the bases of the second failure mode: bases a
// round's tickets CAN derive but that will never chain, so the per-ticket warning
// of the live run is visible in the dry run too — same verdict, not a more
// optimistic one (issue #24, criterion 4).
//
// `plannerMode` is the mode the live run would hand the planner over THIS queue
// (issue #30, criterion 5): the effective mode, not the requested one. Same
// predicate, same queue walk — the dry run cannot report a healthier mode than
// the round would run. The queue read itself is best-effort like the stack walk
// (an unauthed glab still gets the wiring report); null = could not read, and the
// mode is left to the live run to state.
//
// The per-root stack walk goes under its own `stacks` key rather than overwriting
// `chainableBases`: one key holding a branch-name list on the error path and objects
// on the happy path is unreadable in the printed report, and unusable to anything
// that ever parses it.
const chainDryRun = (): Record<string, unknown> => {
  const bases = cfg.project.chainableBases;
  const derivable = derivableBases(cfg.project.baseBranch, cfg.project.labelBases);
  const report: Record<string, unknown> = {
    feasible: CHAIN_FEASIBILITY.feasible,
    chainableBases: bases,
    unchainableDerivableBases: derivable.filter((base) => !bases.includes(base)),
  };
  let queueBases: string[] | null;
  try {
    queueBases = queueIssueBases(host.queueIssues(cfg.project.queueLabels));
  } catch (error) {
    queueBases = null;
    report.queueError = `could not read the queue — ${(error as Error).message}`;
  }
  if (queueBases !== null) {
    const mode = decidePlannerChainMode({ feasibility: CHAIN_FEASIBILITY, queueBases });
    report.queueBases = queueBases;
    report.plannerMode = mode.mode;
    // Its own key, and not `downgraded`: the decision's `downgraded` is a boolean,
    // and one name holding a flag in the code and a paragraph in the printed report
    // is the kind of ambiguity the `stacks` key was split out to avoid.
    if (mode.mode === 'off' && mode.downgraded) report.plannerModeDowngrade = mode.message;
  }
  try {
    const openMrs = host.openChangeRequests();
    return {
      ...report,
      stacks: bases.map((root) => {
        const resolution = resolveChainedBase(openMrs, root);
        return {
          root,
          wouldForkFrom: resolution.base,
          chained: resolution.chained,
          stack: resolution.stack.map((mr) => `${hostTerms.ref}${mr.iid} ${mr.sourceBranch} → ${mr.targetBranch}`),
          rivals: resolution.rivals.map((mr) => `${hostTerms.ref}${mr.iid} ${mr.sourceBranch}`),
        };
      }),
    };
  } catch (error) {
    return { ...report, error: `could not read open MRs — ${(error as Error).message}` };
  }
};

// Commit style → MR title style. `conventional` repos run commitlint (and perhaps
// semantic-release) and may squash the MR title into a commit, so the title must stay
// a valid Conventional Commit header. `ralph` repos have no such constraint.
const titleStyle = cfg.project.commitStyle === 'conventional' ? 'conventional' : 'plain';

// This run's identity, minted ONCE (issue #28). Agent branches are named
// `<planner-branch>-r<runId>-<iteration>`: the run id differs across two relances
// of the same ticket, so a run killed mid-iteration can no longer have its branch
// resurrected by the next one — which used to fork from the dead run's base
// silently. The format (seconds, UTC) and its reasons live in branch-sweep.ts,
// where it is unit-tested; this is only the clock read.
const RUN_ID: RunId = mintRunId(new Date());

// Best-effort host-mismatch warning: a `gitHost` that disagrees with the actual
// `origin` remote is the most likely misconfiguration on a fresh adopt (a GitLab
// repo adopted with the Factory's default gitHost='gh'). Surfacing it here —
// before a real, token-burning run hits the first glab/gh call — turns a confusing
// mid-loop failure into a one-line "set gitHost: 'gh'". Advisory only: a missing or
// unrecognised origin emits nothing (the operator may know better than the heuristic).
const warnHostMismatch = (): { configured: string; originHost: string | null; ok: boolean } => {
  let originUrl: string;
  try {
    originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    return { configured: cfg.project.gitHost, originHost: null, ok: true };
  }
  const originHost = inferGitHostFromUrl(originUrl);
  const ok = originHost === null || originHost === cfg.project.gitHost;
  if (!ok) {
    const other = HOST_TERMS[originHost as 'glab' | 'gh'];
    console.warn(
      `  ⚠ gitHost is \`${cfg.project.gitHost}\` but origin points at a ${other.name} remote ` +
        `(${originUrl}). The loop will talk to ${hostTerms.name} (${hostTerms.cli}); set ` +
        `gitHost: '${originHost}' in config.ts if origin is the host you mean.`,
    );
  }
  return { configured: cfg.project.gitHost, originHost, ok };
};

// ---------------------------------------------------------------------------
// Publish ledger (issue #26)
//
// A branch pushed whose Draft MR/PR creation failed is not orphaned: the failed
// run records a trace here, and the NEXT run drains the ledger before Phase 1 —
// opening the missing MR from the recorded title/description, or explaining why
// it cannot. A ticket with a pending trace is also held out of the planner queue
// (see Phase 1), so the resume never re-runs the ticket on a `-r2` branch.
//
// Like SECRETS_PATH, the ledger is CWD-relative and gitignored — a run artifact,
// never Factory source. The decisions (create | resolved | gone, the queue hold)
// are the pure functions in publish.ts; this file owns only the host IO.
// ---------------------------------------------------------------------------
const PENDING_PATH = path.join(process.cwd(), '.sandcastle', 'publish-pending.json');
// Reassigned (never mutated in place) as the drain erases/re-records traces and
// Phase 3 appends new ones — the in-memory copy is the source of truth between
// writes, and each write persists it whole.
let pending: PendingPublish[] = readPendingPublishes(PENDING_PATH);

// Persist the in-memory ledger. writePendingPublishes never throws (it returns the
// failure): an unwritable `.sandcastle/` must not abort the drain — nor the publish
// loop, which still has other branches to report — so a failed write is a warning.
// The caller's own message always carries the manual-create hint, which is what the
// operator needs when the trace could not be recorded.
const persistPending = (): void => {
  const error = writePendingPublishes(PENDING_PATH, pending);
  if (error !== null) {
    console.error(`  ⚠ could not write ${PENDING_PATH} — the trace is in memory only: ${error}`);
  }
};

// The branches origin currently holds, for the drain's `gone` ruling. Null (not
// []) means the listing itself failed — `gone` is then undecidable and the drain
// falls back to `create` (see decideResume). Read once per drain, shared by every
// trace.
const remoteBranches = (): string[] | null => {
  try {
    return execFileSync('git', ['ls-remote', '--heads', '--refs', 'origin'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, '') ?? '');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Ledger drain (issue #26) — what the NEXT run does with the previous run's
// "pushed without a MR" traces. Runs once, before Phase 1, in a LIVE run only
// (the dry run reports the ledger instead — see its `pendingPublishes` entry).
//
// Per trace, decideResume rules and this renders it:
//   resolved → the MR exists (operator opened it by hand, or a race): erase only;
//   gone     → origin lost the branch (merged+deleted, dropped): erase and say why;
//   create   → open the MR from the RECORDED title/description — the exact MR the
//              failed run would have opened, rebuilt without re-running any agent —
//              and erase on success. No push: the branch is already on origin (that
//              is what distinguishes `create` from `gone`).
//
// A create that fails again RE-RECORDS the trace with the new reason (a fresh
// 503), so the ledger keeps holding the ticket out of the queue until it lands.
// Erases and re-records are persisted after EACH trace: a drain that dies midway
// (Ctrl-C, a crash) leaves the ledger describing exactly what did not finish.
// ---------------------------------------------------------------------------
const drainPendingPublishes = (): void => {
  if (pending.length === 0) return;
  console.log(`\n▸ ${pending.length} pending publish trace(s) from a previous run — resuming:`);

  let openMrs: OpenMergeRequest[];
  try {
    openMrs = host.openChangeRequests();
  } catch (error) {
    console.error(`  ⚠ could not read open ${hostTerms.cr}s — resume deferred: ${error}`);
    return; // the ledger stays; the next run retries
  }
  const branches = remoteBranches();

  // Iterated over a SNAPSHOT: the body reassigns `pending`, and an array being
  // rewritten under its own for-of stops early — a two-trace ledger would drain
  // only its first trace.
  for (const trace of [...pending]) {
    const without = (): PendingPublish[] => pending.filter((entry) => entry.branch !== trace.branch);
    const erase = (): void => {
      pending = without();
      persistPending();
    };
    const decision = decideResume(trace, openMrs, branches);

    if (decision === 'resolved') {
      console.log(
        `  ✓ #${trace.issue}: a ${hostTerms.cr} for \`${trace.branch}\` is already open — trace cleared.`,
      );
      erase();
      continue;
    }
    if (decision === 'gone') {
      console.log(
        `  ✓ #${trace.issue}: \`${trace.branch}\` no longer on origin (merged and deleted, or ` +
          `dropped) — nothing to publish, trace cleared.`,
      );
      erase();
      continue;
    }

    console.log(
      `  → #${trace.issue}: opening the missing ${hostTerms.cr} for \`${trace.branch}\` → ${trace.base}`,
    );
    try {
      // No re-push here, by construction: `create` is only reached when origin still
      // holds the branch (or when the listing failed and the host is the authority on
      // whether it does). A trace is recorded only AFTER a successful push, so a
      // branch origin has genuinely lost is `gone`, not something to re-push — and
      // pushing from a machine whose LOCAL ref has since been pruned would fail and
      // block the resume for nothing.
      host.createDraftChangeRequest({
        sourceBranch: trace.branch,
        targetBranch: trace.base,
        title: trace.title,
        description: trace.description,
        assignee: cfg.project.assignee,
      });
      erase();
      console.log(`  ✓ #${trace.issue}: ${hostTerms.cr} opened — trace cleared.`);
    } catch (error) {
      pending = recordPendingPublish(without(), { ...trace, reason: String(error) });
      persistPending();
      console.error(
        `  ✗ #${trace.issue}: could not open the ${hostTerms.cr} — trace KEPT, retried next run.\n` +
          `    ${manualCreateHint(cfg.project.gitHost, trace.branch, trace.base)}\n` +
          `    ${String(error)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Dry run — validate the active profile's wiring without launching a single agent.
//   SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts
// Prints, per role, the exact env object buildEnv() bakes into the sandbox (token
// masked) — not a hand-written copy of it. Tokens resolve env-first, so each
// required token reports its SOURCE (env / .env.secrets / MISSING), and a
// fresh-checkout dry run with the tokens exported in the shell reports env without
// needing .env.secrets. The .env token-key guard above has already run, so an
// active tokenKey accidentally placed in .env stops the dry run here too. It DOES
// check that every configured base branch is usable, since that is cheap and local.
// ---------------------------------------------------------------------------
if (cfg.run.dryRun) {
  // Resolve once: feed the structured report below and warn on env-vs-file conflicts
  // (same warnConflicts() the startup report uses).
  const resolvedTokens = resolveKeys(requiredTokenKeys);
  warnConflicts(resolvedTokens);
  warnHostTokenInSecrets();
  console.log('[dryrun] Factory config:');
  // console.dir with depth null: console.log collapses past depth 2 and would print
  // the per-role env as [Object], defeating the point.
  console.dir(
    {
      profile: cfg.run.profile,
      roles: Object.fromEntries(
        cfg.roles.map((role) => {
          const provider = cfg.providerFor(role);
          const resolved = resolveKey(provider.tokenKey);
          return [
            role,
            {
              provider: cfg.activeProfile[role],
              model: modelFor(role),
              effort: effortFor(role),
              // Stand-in reports the resolved source, so a role whose token is missing
              // does not print a healthy-looking env.
              env: buildEnv(provider, resolved.source === 'MISSING' ? '<MISSING>' : '<set>'),
            },
          ];
        }),
      ),
      requiredTokens: Object.fromEntries(resolvedTokens.map((t) => [t.key, tokenStatus(t)])),
      maxIterations: cfg.run.maxIterations,
      maxParallel: cfg.effectiveMaxParallel,
      mergeStrategy: cfg.project.mergeStrategy,
      commitStyle: cfg.project.commitStyle,
      gitHost: cfg.project.gitHost,
      // Repo-specific toolchain knobs, now driven from config (issue #19): surfacing them
      // here lets a consumer confirm their config.ts wiring (e.g. a `sandbox-setup` hook, or
      // an empty copyToWorktree for pnpm) without launching a single sandbox.
      hooks: cfg.project.hooks,
      copyToWorktree: cfg.project.copyToWorktree,
      // The in-sandbox host-CLI credential (issue #17). `local` → not required; gh/glab
      // → the conventionally-named token resolveEnv flows from .env (or the env). A
      // MISSING token is REPORTED here, not thrown — the dry run exits 0 like it does
      // for missing provider tokens; the live path validates it.
      hostCliToken:
        hostToken === null
          ? { required: false, reason: 'local (no tracker) — no host token needed' }
          : { required: true, key: hostToken.key, ...tokenStatus(hostToken) },
      hostMismatch: warnHostMismatch(),
      // The publish ledger (issue #26): reported, never drained, in a dry run —
      // a dry run must not open MRs. Says what a live run would resume.
      pendingPublishes: pendingFileSummary(pending),
      chain: cfg.run.chain
        ? { enabled: true, ...chainDryRun() }
        : { enabled: false, hint: 'SANDCASTLE_CHAIN=1 to stack MRs instead of fanning out' },
      only:
        cfg.run.only === null
          ? { enabled: false, hint: 'SANDCASTLE_ONLY=12,34 to restrict the round to those issues' }
          : {
              enabled: true,
              issues: cfg.run.only,
              force: cfg.run.force
                ? 'on — planner re-proposes them even with an open MR'
                : 'off',
            },
      bases: Object.fromEntries(
        ALLOWED_BASES.map((base) => {
          try {
            assertBaseUsable(base);
            return [base, 'usable (local + origin)'];
          } catch (error) {
            return [base, `UNUSABLE — ${(error as Error).message.split('\n')[0]}`];
          }
        }),
      ),
      sandboxImage: describeImageStatus(SANDBOX_IMAGE, sandboxImageStatus()),
    },
    { depth: null },
  );
  process.exit(0);
}

validateTokens();
// Host-CLI token: report then validate, mirroring the provider-token flow above.
reportHostToken();
warnHostTokenInSecrets();
validateHostToken();

// Missing sandbox image → abort NOW with the actionable build prompt from
// image.ts, caught here (not at top level) so the operator sees guidance, not a
// Node stack trace. A built image or an unreachable daemon both fall through.
try {
  preflightSandboxImage();
} catch (error) {
  console.error(`\n${(error as Error).message}\n`);
  process.exit(1);
}

// Surface a gitHost-vs-origin mismatch before any agent runs (the dry-run block
// above ran the same check into its structured report).
warnHostMismatch();

// Drain the publish ledger before the first sandbox: a pushed-but-MR-less branch
// is finished HERE — by opening its MR — not re-implemented by the round below.
drainPendingPublishes();

// Ensure generated artifacts (`.pnpm-store/`, …) do not trip the Engine's post-run
// "uncommitted changes" check in the agent worktrees forked below (issue #20). Idempotent
// and host-side: writes the patterns into the repo's shared `.git/info/exclude`, honored
// by every linked worktree. A genuinely uncommitted TRACKED change still warns. Best-effort
// — a non-git cwd warns and continues.
ensureWorktreeExclude(process.cwd(), cfg.project.worktreeExclude);

// ---------------------------------------------------------------------------
// Main loop
//
// Per-iteration failure boundary (issue #31). Before it, a host read that
// survived its retries (a `gh issue list` in 503 long enough to outlast the
// #25 backoff) escaped this loop and killed the RUN — iterations delivered,
// branches pushed, then eight more iterations never ran. The boundary below is
// the second half of the fix #25 was the first half of: a TRANSIENT failure
// that outlasted its retries ends its ITERATION only (the next one re-reads
// the queue on a host that may have healed), while a DEFINITIVE one (auth,
// exhausted quota, a config error, any non-host throw) still stops the run —
// retrying ten iterations on an invalid token is ten losses, not ten chances.
//
// A lost iteration is counted and named, never swallowed, and a run that lost
// them ALL exits non-zero (see the tail of the loop): a run that failed nine
// times out of ten must not read as a calm one.
// ---------------------------------------------------------------------------

// Reassigned (never mutated in place), like `pending` above: each lost iteration
// appends immutably via recordLostIteration, and the in-memory tally is the
// source of truth for the end-of-run summary and the all-lost verdict.
let lostIterations: LostIteration[] = [];
let ranIterations = 0;

for (let iteration = 1; iteration <= cfg.run.maxIterations; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${cfg.run.maxIterations} ===\n`);
  ranIterations += 1;
  try {
    // -------------------------------------------------------------------------
    // Phase 1: Plan
    //
    // A throwaway sandbox where the planner reads the `sandcastle` queue and emits
    // <plan>{ issues: [...] }</plan>. Empty list → backlog drained, stop.
    // -------------------------------------------------------------------------
    // The work queue, enumerated host-side over EVERY configured queue label and
    // deduped (issue #15): the planner no longer runs a queue command, it receives
    // this list inline as the sole source of truth (see plan-prompt.md). A ticket
    // with a pending publish trace is held out — resume work the drain above just
    // handled (or deferred), not fresh work; left in, the planner would re-pick it
    // and duplicate a full implement+review cycle on a `-r2` branch (issue #26).
    // FORCE is the operator's explicit exit from the hold: they asked for the
    // re-run, so the trace stops standing in. The hold is LOGGED, never silent —
    // a ticket leaving the queue must say why.
    const queueIssues = host.queueIssues(cfg.project.queueLabels);
    let plannerQueue = queueIssues;
    if (!cfg.run.force && pending.length > 0) {
      const { kept, held } = dropPendingIssues(queueIssues, pending);
      if (held.length > 0) {
        plannerQueue = kept;
        console.log(
          `  ⏸ publish ledger: holding #${held.join(', #')} out of the queue — their branch is ` +
            `pushed but has no ${hostTerms.cr} yet (see .sandcastle/publish-pending.json).`,
        );
      }
    }

    // The chain mode the planner is told, derived from what this round can build
    // (issue #30) — see decidePlannerChainMode in chain.ts. Computed from the
    // planner's own queue (the plan does not exist yet), with each ticket's base
    // derived from the labels the queue listing already carries — the same
    // authoritative source the base-resolution below uses, never the planner's
    // advisory `base` field. No extra host read: QueueIssue ships the labels.
    const plannerChain = decidePlannerChainMode({
      feasibility: CHAIN_FEASIBILITY,
      queueBases: queueIssueBases(plannerQueue),
    });
    if (plannerChain.mode === 'off' && plannerChain.downgraded) {
      console.warn(`  ⛓ ⚠ chain: ${plannerChain.message}`);
    }

    const plan = await sandcastle.run({
      sandbox: docker({ env: envFor('planner') }),
      name: 'planner',
      agent: agentFor('planner'),
      promptFile: './.sandcastle/plan-prompt.md',
      // The planner has to know the mode to apply the `Blocked by:` rule correctly.
      // Off, an issue whose blocker is still open must be skipped — it would fork from
      // the base and not see the blocker's code. On, the stack puts the blocker's
      // branch underneath, so the same issue is workable. Same queue, opposite answer;
      // the planner cannot read process.env, so the mode is passed in.
      //
      // That mode is a fact about THIS round, not the operator's flag (issue #30):
      // `on` here relaxes `Blocked by:`, so promising a stack no branch will have
      // lets the planner select tickets on an inheritance that is not in the tree.
      // decidePlannerChainMode crosses the #24 feasibility verdict with the bases
      // the queued tickets actually derive, and a downgrade is logged — with its
      // cause — before the prompt is even built.
      //
      // ONLY/FORCE are the same kind of run-knob the planner cannot see. ONLY tells it
      // the round is restricted to specific issue numbers (it should propose from that
      // set); FORCE tells it to re-propose them even if they already have an open MR.
      // main.ts still enforces ONLY on the result (see applyOnly below) — the planner
      // is an agent — so a value here is guidance, not trust.
      promptArgs: {
        CHAIN_MODE: plannerChain.mode,
        ONLY: cfg.run.only === null ? 'none' : cfg.run.only.join(', '),
        FORCE: cfg.run.force ? 'on' : 'off',
        ISSUE_QUEUE_JSON: JSON.stringify(plannerQueue),
        OPEN_MRS_CMD: openMrsCommand(cfg.project.gitHost),
      },
    });

    const parsed = parsePlan(plan.stdout, ALLOWED_BASES);
    if (parsed.length === 0) {
      console.log('Planner returned no issues. Stopping.');
      break;
    }

    // SANDCASTLE_ONLY restricts the round to specific issue numbers. Enforced in code
    // (applyOnly), not trusted to the planner: it intersects the plan with the
    // operator's allow-list and drops everything else. FORCE was passed to the planner
    // above so it re-proposes the issues even if they already have an open MR; this
    // filter then guarantees only the allow-list survives.
    let candidates = parsed;
    if (cfg.run.only !== null) {
      const onlyList = cfg.run.only.join(',');
      const { kept, dropped } = applyOnly(parsed, cfg.run.only);
      if (dropped.length > 0) {
        console.log(
          `  ⊘ SANDCASTLE_ONLY=${onlyList}: dropped ${dropped.length} planner issue(s) ` +
            `outside the allow-list (${dropped.map((i) => '#' + i.number).join(', ')}).`,
        );
      }
      if (kept.length === 0) {
        console.log(
          `  ⊘ SANDCASTLE_ONLY=${onlyList}: none of the planned issues match the allow-list. ` +
            `Stopping — if the issue is not in the open queue, the planner cannot pick it.`,
        );
        break;
      }
      candidates = kept;
    }

    // Cap the round to its configured parallelism. In chained mode that cap is 1 (a
    // stack is built one MR at a time — a second issue would fork from a branch that
    // does not exist yet); otherwise it is MAX_PARALLEL. The dropped issues keep their
    // `sandcastle` label and come back next round.
    const planned = candidates.slice(0, cfg.effectiveMaxParallel);
    if (planned.length < candidates.length) {
      if (cfg.run.chain) {
        console.log(
          `  ⛓ chain: ${candidates.length} issue(s) queued; keeping #${planned[0]?.number} ` +
            `only — a stack is built one MR at a time.`,
        );
      } else {
        console.log(
          `  ⛷ max parallel: ${candidates.length} issue(s) queued, cap is ` +
            `${cfg.effectiveMaxParallel}; running #${planned.map((i) => i.number).join(', ')} ` +
            `this round, the rest next round.`,
        );
      }
    }

    // The host's view/unlabel/comment verbs — reused to pre-render the implementer's
    // claim commands below and spread into its promptArgs.
    const hostVerbs = promptHostArgs(cfg.project.gitHost);
    // Resolve + validate every base before any sandbox is created, so an unpublished
    // base stops the round here rather than after two agent cycles.
    const issues = planned.map((issue) => {
      const labels = host.labelsOf(issue.number);
      const labelBase = baseForLabels(labels, cfg.project.labelBases, cfg.project.baseBranch);
      if (issue.base !== undefined && issue.base !== labelBase) {
        console.warn(
          `  ⚠ #${issue.number}: planner said base \`${issue.base}\`, labels say \`${labelBase}\` — using the labels.`,
        );
      }
      const base = resolveBase(issue.number, labelBase);
      assertBaseUsable(base);
      // Fast-forward the base to origin so agent branches fork from the latest
      // published tip, not a stale local ref (issue #14). Live only — the dry run
      // exits before Phase 2.
      syncBaseToOrigin(base);
      // Pre-render the host's unlabel command for each queue label the issue actually
      // carries, so the implementer runs them verbatim instead of re-splitting a label
      // list (issue #15: a captable issue carries `ready-for-agent`, not `sandcastle`).
      const claimCommands = claimLabels(labels, cfg.project.queueLabels)
        .map((label) => `${hostVerbs.UNLABEL_PREFIX} ${issue.number} ${hostVerbs.UNLABEL_FLAG} ${label}`)
        .join('\n');
      return { ...issue, base, claimCommands };
    });

    console.log(`Planned ${issues.length} issue(s) this round:`);
    for (const issue of issues) {
      console.log(`  #${issue.number}: ${issue.title} → ${issue.branch} (base ${issue.base})`);
    }

    // Startup sweep of dead runs' empty branches (issue #28) — first iteration only:
    // later iterations run inside this same process and their predecessors' branches
    // are this run's own. Runs after the planner has spoken so the names THIS run is
    // about to create (every planned branch × every iteration it may still reach) are
    // excluded, and before Phase 2 forks a single worktree.
    if (iteration === 1) {
      console.log(`Sweeping dead-run branches (run ${RUN_ID}):`);
      const mine = new Set(
        runBranchBases(
          issues.map((issue) => ({ branch: issue.branch })),
          RUN_ID,
          Array.from({ length: cfg.run.maxIterations }, (_, i) => i + 1),
        ),
      );
      sweepDeadBranches(mine);
    }

    // -------------------------------------------------------------------------
    // Phase 2: Implement + fix-in-place review, ≤ MAX_PARALLEL concurrent.
    //
    // Hand-rolled semaphore caps concurrency; Promise.allSettled so one failing branch
    // doesn't abort the batch. The reviewer runs only if the implementer produced
    // commits, and it fixes in place (edits + commits directly) rather than gating
    // with a verdict.
    //
    // Each issue gets *two sequential sandboxes on the same branch*: impl then review,
    // each with its role's provider env. That env is baked at sandbox level, so a
    // single sandbox cannot host both. close() drops the impl worktree path but keeps
    // the branch ref + its commits, so the review createSandbox({ branch }) checks out
    // the existing branch and sees the implementation (baseBranch is ignored for an
    // existing branch, which is why passing it twice is harmless). The semaphore is
    // held across both, so concurrency stays capped at effectiveMaxParallel — the cost
    // is wall-clock (the install hook, if any, runs twice per issue).
    // -------------------------------------------------------------------------
    let running = 0;
    const queue: Array<() => void> = [];
    const acquire = (): Promise<void> =>
      running < cfg.effectiveMaxParallel
        ? ((running += 1), Promise.resolve())
        : new Promise<void>((resolve) => queue.push(resolve));
    const release = (): void => {
      running -= 1;
      const next = queue.shift();
      if (next) {
        running += 1;
        next();
      }
    };

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        // Unique per RUN (issue #28): `-r<runId>-<iteration>`. The run id is minted
        // once at startup, so two runs of the same ticket never mint the same name —
        // the killed-run collision this issue was filed for. Iteration still varies
        // within the run, preserving the old guarantee for re-planned tickets.
        const branch = buildRunBranch(issue.branch, RUN_ID, iteration);
        // BASE_BRANCH is ours, not sandcastle's built-in TARGET_BRANCH: in the review
        // worktree the branch already exists, and the built-in resolves from the
        // worktree, which would make `git diff TARGET...BRANCH` a self-diff (empty, no
        // error — the reviewer would silently review nothing).
        const promptArgs = {
          ISSUE_NUMBER: String(issue.number),
          ISSUE_TITLE: issue.title,
          BRANCH: branch,
          BASE_BRANCH: issue.base,
          // Drives the commit-subject format in the implement/review prompts: 'ralph'
          // (RALPH:-prefixed subjects) vs 'conventional' (type(scope): …, commitlint-safe).
          COMMIT_STYLE: cfg.project.commitStyle,
          // Pre-rendered host unlabel command(s) — one per line — that take this issue
          // out of the queue (`sandcastle` OR `ready-for-agent`; issue #15). The
          // implementer runs them verbatim, no label-list re-splitting.
          CLAIM_COMMANDS: issue.claimCommands,
          // Host verbs the prompts compose to view / comment on the issue (glab vs gh
          // differ past the binary). See promptHostArgs() in host.ts.
          ...hostVerbs,
        };
        await acquire();
        try {
          // --- Implement (implementer's provider sandbox, creates the branch) ---
          let implement: RunResult;
          // Inside the try so a createSandbox failure still hits release() below —
          // otherwise a queued issue would wait forever and allSettled never settles.
          const implSandbox = await sandcastle.createSandbox({
            branch,
            baseBranch: issue.base,
            sandbox: docker({ env: envFor('implementer') }),
            hooks,
            copyToWorktree,
          });
          try {
            implement = await implSandbox.run({
              name: `implementer #${issue.number}`,
              agent: agentFor('implementer'),
              promptFile: './.sandcastle/implement-prompt.md',
              promptArgs,
            });
          } finally {
            await implSandbox.close();
          }

          // --- Review (reviewer's provider sandbox, same branch) ---
          // Spun up UNCONDITIONALLY — do not collapse it into the implementer sandbox
          // in profile `opus` just because both envs are identical there. Best-effort
          // refinement: a reviewer failure — including a failure to even create the
          // second sandbox — must NOT reject the issue. The implementer's commits
          // already landed and Phase 3 can publish them. Captured for the MR body: the
          // reviewer's two <review-findings> ledgers travel in its stdout, and
          // `reviewed` distinguishes "no reviewer ran" from "a reviewer ran and
          // reported nothing" — two very different things to a human about to merge.
          let reviewStdout = '';
          let reviewed = false;
          const logs: string[] = [];
          if (implement.logFilePath) logs.push(implement.logFilePath);
          if (implement.commits.length > 0) {
            let reviewSandbox: Sandbox | undefined;
            try {
              reviewSandbox = await sandcastle.createSandbox({
                branch,
                baseBranch: issue.base,
                sandbox: docker({ env: envFor('reviewer') }),
                hooks,
                copyToWorktree,
              });
              const review = await reviewSandbox.run({
                name: `reviewer #${issue.number}`,
                agent: agentFor('reviewer'),
                promptFile: './.sandcastle/review-prompt.md',
                promptArgs,
              });
              reviewStdout = review.stdout;
              reviewed = true;
              if (review.logFilePath) logs.push(review.logFilePath);
            } catch (error) {
              console.error(`  ⚠ #${issue.number} review failed; keeping implementation: ${error}`);
            } finally {
              if (reviewSandbox) await reviewSandbox.close();
            }
          }

          return {
            issue,
            branch,
            commits: implement.commits.length,
            implStdout: implement.stdout,
            reviewStdout,
            reviewed,
            logs,
          };
        } finally {
          release();
        }
      }),
    );

    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        console.error(`  ✗ #${issues[i]?.number} (${issues[i]?.branch}) failed: ${outcome.reason}`);
      }
    });

    type Completed = {
      issue: PlannedIssue & { base: string; claimCommands: string };
      branch: string;
      commits: number;
      implStdout: string;
      reviewStdout: string;
      reviewed: boolean;
      logs: string[];
    };
    const completed = settled
      .filter(
        (o): o is PromiseFulfilledResult<Completed> => o.status === 'fulfilled' && o.value.commits > 0,
      )
      .map((o) => o.value);

    if (completed.length === 0) {
      console.log('No branch produced commits. Stopping.');
      break;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Publish (host-side) — push + Draft MR per completed branch.
    //
    // main.ts runs on the host and branch commits live in the bind-mounted .git, so we
    // push + open a Draft MR/PR from here (host git + the host CLI are already authed).
    // Never auto-merged (MERGE_STRATEGY=human) — a human reviews and merges. We do NOT
    // let the host CLI push (it would push the host's *current* branch, not the worktree
    // branch); we push the worktree branch ourselves, then ask the host to open the MR/PR.
    // -------------------------------------------------------------------------
    // Everything here goes through argv (execFileSync / host.createDraftChangeRequest),
    // never a shell string: `branch`, `mrTitle` and `mrDesc` are agent-authored — the
    // branch comes from the planner's JSON, the title and body from the implementer's
    // and reviewer's own words. plan.ts constrains the branch shape, but the title and
    // the description are free text (multi-line markdown, backticks, quotes) and quoting
    // that by hand is how injections happen.
    //
    // Per-branch try/catch: a transient `git push` or host-CLI failure on one branch
    // must not skip the branches after it, and must not end the run. Their work is
    // committed and their MR/PR can be opened by hand — losing the report of what
    // happened is the expensive part.
    for (const { issue, branch, implStdout, reviewStdout, reviewed, logs } of completed) {
      console.log(`\nPublishing #${issue.number} → ${branch} (target ${issue.base})`);
      // Split into a PUSH half and a CREATE half (issue #26): a push that fails is
      // plain old Phase-3 failure (nothing durable to remember — the branch is not
      // on origin, so a re-plan of the ticket is legitimate). A push that SUCCEEDS
      // followed by a create that fails is exactly the orphan the publish ledger
      // exists for: record a trace so the NEXT run opens the missing MR instead of
      // re-implementing the ticket. mrTitle/mrDesc are hoisted so the trace can
      // carry them when the create itself is what failed.
      let pushed = false;
      let mrTitle: string | undefined;
      let mrDesc: string | undefined;
      try {
        execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });
        pushed = true;

        // Title and description are built here, not left to `git log -1` and a constant:
        // the reviewer's cost is dominated by reconstructing intent, and the run already
        // knows it. Agent-authored halves ride in on stdout; the rest is read from the
        // host and git. A mute or malformed agent block degrades the body and is
        // REPORTED in it — never fails the publish. See mr-body.ts.
        const { summary, error: summaryError } = extractMrSummary(implStdout);
        if (summaryError) {
          console.error(`  ⚠ #${issue.number}: ${summaryError} — MR body will say so.`);
        }
        const commits = commitsOn(issue.base, branch);
        const diffstat = diffstatOf(issue.base, branch);

        // The report phase, between the push and the MR (revue issue #26). It runs
        // here and not earlier because the skill explains a branch that EXISTS on
        // origin — a report whose links point at a branch nobody can fetch is worth
        // less than none. And not later, because its url belongs in the body below.
        //
        // Its failure boundary is inside runReportPhase, which never throws. That
        // matters more than it looks: this `try` is the one whose `catch` records a
        // PendingPublish trace, and `pushed` is already true. An escaping error would
        // be filed as "the MR creation failed" for an MR that was never attempted —
        // the next run would then drain a ledger entry describing a phase, not a
        // publish. See publish.ts and iteration.ts for who owns which failure.
        let report: ReportOutcome | null = null;
        if (shouldRunReport(cfg.project.report, commits.length)) {
          console.log(`  · #${issue.number}: rapport de revue (${cfg.project.report!.skill})…`);
          report = await runReportPhase({
            issue: { number: issue.number, title: issue.title, base: issue.base },
            branch,
            changedLines: diffstat.insertions + diffstat.deletions,
          });
          const rendered = renderReport(report);
          console.log(
            report?.kind === 'published'
              ? `  · #${issue.number}: rapport publié — ${report.url}`
              : `  ⚠ #${issue.number}: ${rendered ? rendered.split('\n').pop() : 'pas de rapport'}`,
          );
        }

        const issueInfo = host.issueInfoOf(issue.number, issue.title);
        mrTitle = buildMrTitle({
          style: titleStyle,
          issue: { number: issue.number, title: issue.title },
          summary,
          commits,
        });
        mrDesc = buildMrDescription({
          issue: issueInfo,
          branch,
          base: issue.base,
          // Drives the closure decision (issue #27): `Closes #n` only when the target
          // IS the trunk, else the explicit why-not note. The trunk comes from the
          // config — never a hardcoded 'main' — so a consumer with another default
          // branch gets the same guarantee.
          defaultBranch: cfg.project.baseBranch,
          summary,
          ...(summaryError ? { summaryError } : {}),
          review: {
            reviewed,
            found: extractReviewLedger(reviewStdout, 'found').data,
            resolved: extractReviewLedger(reviewStdout, 'resolved').data,
          },
          commits,
          diffstat,
          report,
          run: {
            profile: cfg.run.profile,
            implementerModel: modelFor('implementer'),
            reviewerModel: modelFor('reviewer'),
            round: iteration,
            logs,
          },
        });
        // Open the Draft MR/PR through the host layer — glab mr create / gh pr create,
        // argv only. assignee null ⇒ leave it unassigned (host default).
        host.createDraftChangeRequest({
          sourceBranch: branch,
          targetBranch: issue.base,
          title: mrTitle,
          description: mrDesc,
          assignee: cfg.project.assignee,
        });
      } catch (error) {
        if (pushed) {
          // The branch is on origin and its MR is not — durable trace for the next
          // run's drain (issue #26). When the failure was the create itself, the
          // trace carries the built title/description and the resume opens the
          // exact MR this run meant to. When it was earlier (an MR-body builder),
          // the trace falls back to a title rebuilt from the first commit and a
          // body that says so — degraded, but never silently empty. Both fallbacks
          // are LAZY: in the ordinary case (the create 503'd) mrTitle/mrDesc are
          // set, and eagerly rebuilding a title would re-run `git log` — and print
          // its own warning — for a value about to be discarded.
          const fallbackTitle = (): string =>
            buildMrTitle({
              style: titleStyle,
              issue: { number: issue.number, title: issue.title },
              summary: extractMrSummary(implStdout).summary,
              commits: commitsOn(issue.base, branch),
            });
          const fallbackDesc = (): string =>
            `Resumed publish for #${issue.number} (${issue.title}): the branch was pushed by ` +
            `round ${iteration} but its ${hostTerms.cr} could not be opened. The original MR ` +
            `description was not recorded — this MR was opened by the publish-ledger resume.`;
          const trace: PendingPublish = {
            issue: issue.number,
            branch,
            base: issue.base,
            title: mrTitle ?? fallbackTitle(),
            description: mrDesc ?? fallbackDesc(),
            reason: String(error),
            round: iteration,
          };
          pending = recordPendingPublish(pending, trace);
          persistPending();
          console.error(
            `  ✗ #${issue.number}: ${hostTerms.cr} creation failed for pushed \`${branch}\` — ` +
              `trace recorded, the NEXT run will open it (issue #26). Or by hand:\n` +
              `    ${manualCreateHint(cfg.project.gitHost, branch, issue.base)}\n` +
              `    ${String(error)}`,
          );
          continue;
        }
        console.error(
          `  ✗ #${issue.number}: publish failed for \`${branch}\` — the commits are on the ` +
            `${hostTerms.cr} by hand:\n` +
            `    git push -u origin ${branch} && ${manualCreateHint(cfg.project.gitHost, branch, issue.base)}\n` +
            `    ${String(error)}`,
        );
      }
    }
  } catch (error) {
    // The boundary itself (issue #31). Only a host read whose retries are spent
    // is absorbed here; a definitive failure or a non-host throw rethrows and
    // ends the run exactly as before — the discrimination lives in
    // iteration.ts, not in this catch. Nothing already on disk is discarded by
    // taking this path: worktrees/branches the Engine preserved stay put, and a
    // pushed branch without its MR keeps its #26 ledger trace.
    // The guard is a type predicate, so `error` is a HostReadError past this
    // line — no cast at the one site the boundary must not get wrong.
    if (!isLostIterationError(error)) throw error;
    lostIterations = recordLostIteration(lostIterations, iteration, error);
    console.error(describeLostIteration(lostIterations.at(-1)!, cfg.run.maxIterations));
    continue;
  }
}

// The run's tally, said out loud when anything was lost (issue #31, criterion
// 2): the count is the difference between a degraded run and a silent one.
if (lostIterations.length > 0) {
  console.log(`\n${describeIterationLosses(lostIterations, ranIterations)}`);
}

// Criterion 4: a run whose every iteration was lost is not a success. Exit
// non-zero so the operator's automation sees the difference — the log above
// already said it in words.
if (isRunLost(lostIterations, ranIterations)) {
  // "no iteration published", not "nothing was published": drainPendingPublishes()
  // runs BEFORE this loop and may well have opened a previous run's missing MR
  // (issue #26). Claiming otherwise would send the operator looking for a
  // publish that did happen.
  console.error(
    `\nEvery iteration of this run (${ranIterations}) was lost to host failures — no iteration published.`,
  );
  process.exit(1);
}

console.log('\nAll done.');
