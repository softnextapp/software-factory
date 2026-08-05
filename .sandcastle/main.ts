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
//   Phase 3 (Publish): host-side `git push` + `glab mr create --draft` for every
//                      branch that got commits. Never auto-merged (MERGE_STRATEGY=human,
//                      the Omniris majority): a human reviews and merges.
//
// v0.1 scope: the split regime + human-merge + GitLab shape, out of the box. The
// Merger role (MERGE_STRATEGY=agent, ccsnoop's auto-merging 4th agent) and the GitHub
// host (gitHost='gh') land as follow-up modules — see the guards below. Opus is just
// another profile in config.ts and works mechanically; it is not specially tested here.
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
import { fetchOpenMergeRequests, resolveChainedBase } from './chain.ts';
import {
  buildMrDescription,
  buildMrTitle,
  extractMrSummary,
  extractReviewLedger,
  type CommitInfo,
  type DiffStat,
  type IssueInfo,
} from './mr-body.ts';
import { baseForLabels, parsePlan, applyOnly, type PlannedIssue } from './plan.ts';
import { loadConfig, type Provider, type Role } from './config.ts';

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

// v0.1 wires the GitLab host only. GitHub (gitHost='gh', ccsnoop's gh/pr-create
// shape) is a follow-up module; failing here, loudly and early, keeps gitHost
// truthful instead of a silent no-op on the glab code paths below.
if (cfg.project.gitHost !== 'glab') {
  throw new Error(
    `gitHost=${cfg.project.gitHost} is reserved: v0.1 ships the GitLab (glab) host only. ` +
      `GitHub support lands as a follow-up module. Set gitHost: 'glab' in config.ts for now.`,
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
// Auth-token isolation
//
// sandcastle's resolveEnv merges ALL of .sandcastle/.env into every sandbox, and
// docker({ env }) can only ADD keys, never remove them. Two auth tokens in .env
// would both leak into every sandbox → claude-code picks whichever it prefers and
// sends it to the wrong base URL → 401. So .env keeps only what every agent needs,
// and the auth tokens live in .env.secrets — gitignored, never read by resolveEnv,
// and baked one-per-sandbox below.
//
// Path is CWD-relative like the promptFile paths: the loop is always run from inside
// the repo (`cd <repo> && npx tsx .sandcastle/main.ts`).
// ---------------------------------------------------------------------------

const SECRETS_PATH = path.join(process.cwd(), '.sandcastle', '.env.secrets');

function loadSecrets(dryRun: boolean): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(SECRETS_PATH, 'utf8');
  } catch {
    // A dry run is exactly what you reach for on a fresh checkout, before the secrets
    // file exists: crashing here would hide everything else it checks (profile wiring,
    // base branches). It reports the tokens as <MISSING> instead.
    if (dryRun) {
      console.warn(`[dryrun] no ${SECRETS_PATH} yet — tokens will report as <MISSING>.`);
      return {};
    }
    throw new Error(
      `Missing ${SECRETS_PATH}. Create it from .env.secrets.example with the auth tokens ` +
        `the active profile's providers need.\n` +
        'Auth tokens must NOT live in .sandcastle/.env — resolveEnv merges all of .env into ' +
        'every sandbox, so two tokens there leak to every sandbox → 401.',
    );
  }
  const secrets: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
}

const secrets = loadSecrets(cfg.run.dryRun);

const need = (key: string): string => {
  const value = secrets[key];
  if (value === undefined || value === '') {
    throw new Error(`Profile \`${cfg.run.profile}\` requires ${key}, missing in ${SECRETS_PATH}.`);
  }
  return value;
};

// Distinct providers bound to the active profile's roles. Only these tokens are
// required — fail at startup, not at the first createSandbox.
const requiredProviders: readonly string[] = [
  ...new Set(cfg.roles.map((role) => cfg.activeProfile[role]).filter((n): n is string => typeof n === 'string')),
];

const validateTokens = (): void => {
  for (const name of requiredProviders) need(cfg.project.providers[name].tokenKey);
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
// Authoritative source is the issue's GitLab labels, read here on the host — not the
// planner's `base` field, which is only cross-checked. A base ends up as a worktree
// fork point AND a `--target-branch`; neither should depend on an agent.
// ---------------------------------------------------------------------------

// execFileSync, not execSync: the issue number is interpolated into an argv slot,
// never into a shell string.
const labelsOf = (issueNumber: number): string[] => {
  const raw = execFileSync(
    'glab',
    ['issue', 'view', String(issueNumber), '--output', 'json', '--jq', '.labels'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`glab returned a non-array label list for #${issueNumber}: ${raw}`);
  }
  return parsed.filter((label): label is string => typeof label === 'string');
};

// ---------------------------------------------------------------------------
// MR body inputs — the host-derived half of the Draft-MR description
//
// These are facts about the issue and the branch, read from GitLab and git rather
// than from an agent, so they render even when an agent says nothing useful. Each
// collector is best-effort: a Draft MR with a thinner description is a nuisance, a
// round that dies in Phase 3 after two agent cycles is a loss. See mr-body.ts.
//
// The repo-specific half — "what do I run to see this branch work?" (Storybook, make
// targets, etc.) and the audit command — is project context the consumer supplies by
// editing main.ts after cloning (ADR-0002). It is omitted here on purpose: a
// Factory-default MR body rests on the agents' own words and the derived facts, and
// says so (see mr-body.ts's optional `testing` / `auditCommand`).
// ---------------------------------------------------------------------------

const MR_FILE_CAP = 25;

const issueInfoOf = (issueNumber: number, fallbackTitle: string): IssueInfo => {
  try {
    const raw = execFileSync('glab', ['issue', 'view', String(issueNumber), '--output', 'json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const labels = Array.isArray(parsed['labels'])
      ? parsed['labels'].filter((label): label is string => typeof label === 'string')
      : undefined;
    const milestone = parsed['milestone'];
    const milestoneTitle =
      milestone && typeof milestone === 'object' && 'title' in milestone
        ? String((milestone as { title: unknown }).title)
        : null;
    return {
      number: issueNumber,
      title: typeof parsed['title'] === 'string' ? parsed['title'] : fallbackTitle,
      url: typeof parsed['web_url'] === 'string' ? parsed['web_url'] : undefined,
      labels,
      milestone: milestoneTitle,
    };
  } catch (error) {
    console.error(`  ⚠ #${issueNumber}: could not read the issue for the MR body — ${error}`);
    return { number: issueNumber, title: fallbackTitle };
  }
};

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
// origin (`glab mr create --target-branch` 404s otherwise). Checked once per base per
// run, before any sandbox is created: discovering it at publish time would mean
// throwing away a full implement+review cycle.
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
      `Base branch \`${base}\` is not published on origin, so \`glab mr create ` +
        `--target-branch ${base}\` would fail after a full implement+review cycle.\n` +
        `  git push -u origin ${base}`,
    );
  }
  // Existing-but-stale is the quiet failure: agents fork off the local ref, so a
  // local base behind origin means every branch this round is built on old code and
  // the MRs read as conflicts nobody caused. A warning rather than a throw — being
  // ahead of origin is legitimate (a base you are curating locally), and only the
  // operator can tell the two apart.
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

// Resolve the base a ticket should actually be built on. Without SANDCASTLE_CHAIN
// this is exactly the label-derived base; with it, the head of the open-MR stack
// rooted there. Logs the whole stack, because "which branch did this fork from" stops
// being obvious the moment it is not the configured base.
const resolveBase = (labelBase: string): string => {
  if (!cfg.run.chain || !cfg.project.chainableBases.includes(labelBase)) return labelBase;

  const resolution = resolveChainedBase(fetchOpenMergeRequests(), labelBase);
  if (!resolution.chained) {
    console.log(`  ⛓ chain: no open MR on \`${labelBase}\` — starting a new stack from it.`);
    return labelBase;
  }

  console.log(`  ⛓ chain: ${resolution.stack.length} unmerged MR(s) stacked on \`${labelBase}\`:`);
  for (const [index, mr] of resolution.stack.entries()) {
    console.log(`      ${index + 1}. !${mr.iid} ${mr.sourceBranch} → ${mr.targetBranch}`);
  }
  for (const rival of resolution.rivals) {
    // Not an error: two MRs on one branch is a legal shape. But the loser's work is
    // invisible to the ticket about to start, and that surprises people.
    console.warn(
      `  ⚠ chain: !${rival.iid} (${rival.sourceBranch}) also builds on this stack but is ` +
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
    const openMrs = fetchOpenMergeRequests();
    return {
      chainableBases: bases.map((root) => {
        const resolution = resolveChainedBase(openMrs, root);
        return {
          root,
          wouldForkFrom: resolution.base,
          chained: resolution.chained,
          stack: resolution.stack.map((mr) => `!${mr.iid} ${mr.sourceBranch} → ${mr.targetBranch}`),
          rivals: resolution.rivals.map((mr) => `!${mr.iid} ${mr.sourceBranch}`),
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

// ---------------------------------------------------------------------------
// Dry run — validate the active profile's wiring without launching a single agent.
//   SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts
// Prints, per role, the exact env object buildEnv() bakes into the sandbox (token
// masked) — not a hand-written copy of it.
// Note: this only checks .env.secrets. It cannot see .sandcastle/.env, so it will NOT
// catch a leftover CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL in
// there — which is exactly what would 401 the impl sandbox. It DOES check that every
// configured base branch is usable, since that is cheap and local.
// ---------------------------------------------------------------------------
if (cfg.run.dryRun) {
  console.log('[dryrun] Factory config (does NOT validate .sandcastle/.env):');
  // console.dir with depth null: console.log collapses past depth 2 and would print
  // the per-role env as [Object], defeating the point.
  console.dir(
    {
      profile: cfg.run.profile,
      roles: Object.fromEntries(
        cfg.roles.map((role) => {
          const provider = cfg.providerFor(role);
          return [
            role,
            {
              provider: cfg.activeProfile[role],
              model: modelFor(role),
              effort: effortFor(role),
              // Stand-in reports presence, so a role whose token is missing does not
              // print a healthy-looking env.
              env: buildEnv(provider, secrets[provider.tokenKey] ? '<set>' : '<MISSING>'),
            },
          ];
        }),
      ),
      requiredTokens: Object.fromEntries(
        requiredProviders.map((name) => {
          const key = cfg.project.providers[name].tokenKey;
          return [key, secrets[key] ? '<set>' : '<MISSING>'];
        }),
      ),
      maxIterations: cfg.run.maxIterations,
      maxParallel: cfg.effectiveMaxParallel,
      mergeStrategy: cfg.project.mergeStrategy,
      commitStyle: cfg.project.commitStyle,
      gitHost: cfg.project.gitHost,
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
    },
    { depth: null },
  );
  process.exit(0);
}

validateTokens();

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

  // Resolve + validate every base before any sandbox is created, so an unpublished
  // base stops the round here rather than after two agent cycles.
  const issues = planned.map((issue) => {
    const labelBase = baseForLabels(labelsOf(issue.number), cfg.project.labelBases, cfg.project.baseBranch);
    if (issue.base !== undefined && issue.base !== labelBase) {
      console.warn(
        `  ⚠ #${issue.number}: planner said base \`${issue.base}\`, labels say \`${labelBase}\` — using the labels.`,
      );
    }
    const base = resolveBase(labelBase);
    assertBaseUsable(base);
    return { ...issue, base };
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
      // Unique per round. A blocked/no-commit issue keeps its `sandcastle` label and
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
    issue: PlannedIssue & { base: string };
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
  // push + open a Draft MR from here (host git/glab are already authed). Never
  // auto-merged (MERGE_STRATEGY=human) — a human reviews and merges. We do NOT use
  // `glab --fill` (it would push the host's *current* branch, not the worktree branch).
  // -------------------------------------------------------------------------
  // Everything here goes through argv (execFileSync), never a shell string: `branch`,
  // `mrTitle` and `mrDesc` are agent-authored — the branch comes from the planner's
  // JSON, the title and body from the implementer's and reviewer's own words. plan.ts
  // constrains the branch shape, but the title and the description are free text
  // (multi-line markdown, backticks, quotes) and quoting that by hand is how
  // injections happen.
  //
  // Per-branch try/catch: a transient `git push` or `glab` failure on one branch must
  // not skip the branches after it, and must not end the run. Their work is committed
  // and their MR can be opened by hand — losing the report of what happened is the
  // expensive part.
  for (const { issue, branch, implStdout, reviewStdout, reviewed, logs } of completed) {
    console.log(`\nPublishing #${issue.number} → ${branch} (target ${issue.base})`);
    try {
      execFileSync('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });

      // Title and description are built here, not left to `git log -1` and a constant:
      // the reviewer's cost is dominated by reconstructing intent, and the run already
      // knows it. Agent-authored halves ride in on stdout; the rest is read from
      // GitLab and git. A mute or malformed agent block degrades the body and is
      // REPORTED in it — never fails the publish. See mr-body.ts.
      const { summary, error: summaryError } = extractMrSummary(implStdout);
      if (summaryError) {
        console.error(`  ⚠ #${issue.number}: ${summaryError} — MR body will say so.`);
      }
      const commits = commitsOn(issue.base, branch);
      const issueInfo = issueInfoOf(issue.number, issue.title);
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
      const mrArgs = [
        'mr',
        'create',
        '--source-branch',
        branch,
        '--target-branch',
        issue.base,
        '--draft',
        '--yes',
        '--no-editor',
        '--title',
        mrTitle,
        '--description',
        mrDesc,
      ];
      // glab wants a username; null ⇒ leave the MR unassigned (host default).
      if (cfg.project.assignee) mrArgs.push('--assignee', cfg.project.assignee);
      execFileSync('glab', mrArgs, { stdio: 'inherit' });
    } catch (error) {
      console.error(
        `  ✗ #${issue.number}: publish failed for \`${branch}\` — the commits are on the ` +
          `branch, open the MR by hand:\n` +
          `    git push -u origin ${branch} && glab mr create --source-branch ${branch} ` +
          `--target-branch ${issue.base} --draft\n    ${String(error)}`,
      );
    }
  }
}

console.log('\nAll done.');
