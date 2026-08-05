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
import { resolveChainedBase, decideBaseSync } from './chain.ts';
import {
  createHost,
  HOST_TERMS,
  openMrsCommand,
  promptHostArgs,
  inferGitHostFromUrl,
  manualCreateHint,
  claimLabels,
  type Host,
} from './host.ts';
import {
  buildMrDescription,
  buildMrTitle,
  extractMrSummary,
  extractReviewLedger,
  type CommitInfo,
  type DiffStat,
} from './mr-body.ts';
import { baseForLabels, parsePlan, applyOnly, type PlannedIssue } from './plan.ts';
import { loadConfig, type Provider, type Role } from './config.ts';
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
// state of this file: the same regime has to hold across repos, and .sandcastle/ is
// gitignored in consumer repos — so an edited main.ts cannot be reverted with `git
// checkout --`. A regime you cannot undo is worse than a verbose command line.
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

// The host module owns every glab-vs-gh difference (issue view/labels, draft MR/PR
// creation, open-MR/PR listing, and the prompt-time command strings). main.ts never
// spells `glab` or `gh` itself; it goes through `host` below. See host.ts.
const host: Host = createHost(cfg.project.gitHost);
const hostTerms = HOST_TERMS[cfg.project.gitHost];

// v0.1 wires BOTH host shapes (GitLab/glab and GitHub/gh). config.ts constrains
// gitHost to that union, so a future host added there would silently fall through
// createHost's glab default — fail loudly here instead of no-op'ing on the host
// code paths below, the same fence the mergeStrategy guard uses.
if (cfg.project.gitHost !== 'glab' && cfg.project.gitHost !== 'gh') {
  throw new Error(
    `gitHost=${cfg.project.gitHost} is not wired. v0.1 ships the GitLab (glab) and ` +
      `GitHub (gh) hosts only. Add the host to host.ts and this guard.`,
  );
}

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

// .env token-key guard (startup fence, like gitHost / mergeStrategy above). A token
// key in .env leaks into every sandbox under env-first → 401; fail loudly before any
// agent runs. No .env file → nothing to guard. See tokens.ts.
{
  let dotEnvRaw: string | undefined;
  try {
    dotEnvRaw = readFileSync(DOTENV_PATH, 'utf8');
  } catch {
    // No .env — the common case on a fresh checkout.
  }
  if (dotEnvRaw !== undefined) assertNoTokenKeyInDotEnv(dotEnvRaw, requiredTokenKeys);
}

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
// Project toolchain defaults
//
// The install hook and the worktree copy are repo-specific (yarn 4 / npm / pnpm /
// none), so the Factory ships NO install hook and copies node_modules only when
// present (a harmless no-op in a repo that has none). A consumer edits both after
// cloning — ADR-0002 (clone-and-own). A yarn-4 repo, for instance, sets:
//   const hooks = { sandbox: { onSandboxReady: [{ command: 'yarn install --immutable' }] } };
// ---------------------------------------------------------------------------
const hooks = {};
const copyToWorktree = ['node_modules'];

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
const resolveBase = (labelBase: string): string => {
  if (!cfg.run.chain || !cfg.project.chainableBases.includes(labelBase)) return labelBase;

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

// What resolveBase() would return tonight, for the dry run. Read-only: no fetch, no
// local ref created. Never throws — a dry run on a machine where glab is not authed
// must still print the profile wiring it was mainly asked about.
const chainDryRun = (): Record<string, unknown> => {
  const bases = cfg.project.chainableBases;
  if (bases.length === 0) return { chainableBases: [] };
  try {
    const openMrs = host.openChangeRequests();
    return {
      chainableBases: bases.map((root) => {
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
    return { error: `could not read open MRs — ${(error as Error).message}` };
  }
};

// Commit style → MR title style. `conventional` repos run commitlint (and perhaps
// semantic-release) and may squash the MR title into a commit, so the title must stay
// a valid Conventional Commit header. `ralph` repos have no such constraint.
const titleStyle = cfg.project.commitStyle === 'conventional' ? 'conventional' : 'plain';

// Best-effort host-mismatch warning: a `gitHost` that disagrees with the actual
// `origin` remote is the most likely misconfiguration on a fresh adopt (a GitHub
// repo cloned with the Factory's default gitHost='glab'). Surfacing it here —
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
      hostMismatch: warnHostMismatch(),
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

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= cfg.run.maxIterations; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${cfg.run.maxIterations} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // A throwaway sandbox where the planner reads the `sandcastle` queue and emits
  // <plan>{ issues: [...] }</plan>. Empty list → backlog drained, stop.
  // -------------------------------------------------------------------------
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
    // ONLY/FORCE are the same kind of run-knob the planner cannot see. ONLY tells it
    // the round is restricted to specific issue numbers (it should propose from that
    // set); FORCE tells it to re-propose them even if they already have an open MR.
    // main.ts still enforces ONLY on the result (see applyOnly below) — the planner
    // is an agent — so a value here is guidance, not trust.
    promptArgs: {
      CHAIN_MODE: cfg.run.chain ? 'on' : 'off',
      ONLY: cfg.run.only === null ? 'none' : cfg.run.only.join(', '),
      FORCE: cfg.run.force ? 'on' : 'off',
      // Host-specific open-MR command (plan-prompt.md runs it verbatim) plus the
      // work queue, enumerated host-side over EVERY configured queue label and
      // deduped (issue #15): the planner no longer runs a queue command, it
      // receives this list inline as the sole source of truth (see plan-prompt.md).
      ISSUE_QUEUE_JSON: JSON.stringify(host.queueIssues(cfg.project.queueLabels)),
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
    const base = resolveBase(labelBase);
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
      // Unique per round. A blocked/no-commit issue keeps its queue label and
      // is re-planned next round with the same issue.branch; the -r suffix stops
      // createSandbox from colliding with the leftover branch.
      const branch = `${issue.branch}-r${iteration}`;
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
    try {
      execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });

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
      const issueInfo = host.issueInfoOf(issue.number, issue.title);
      const mrTitle = buildMrTitle({
        style: titleStyle,
        issue: { number: issue.number, title: issue.title },
        summary,
        commits,
      });
      const mrDesc = buildMrDescription({
        issue: issueInfo,
        branch,
        base: issue.base,
        summary,
        ...(summaryError ? { summaryError } : {}),
        review: {
          reviewed,
          found: extractReviewLedger(reviewStdout, 'found').data,
          resolved: extractReviewLedger(reviewStdout, 'resolved').data,
        },
        commits,
        diffstat: diffstatOf(issue.base, branch),
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
      console.error(
        `  ✗ #${issue.number}: publish failed for \`${branch}\` — the commits are on the ` +
          `${hostTerms.cr} by hand:\n` +
          `    git push -u origin ${branch} && ${manualCreateHint(cfg.project.gitHost, branch, issue.base)}\n` +
          `    ${String(error)}`,
      );
    }
  }
}

console.log('\nAll done.');
