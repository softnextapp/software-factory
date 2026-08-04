// The Factory's canonical config surface — the contract every orchestration
// (main.ts) and role prompt consumes.
// See docs/adr/0004-converged-config-driven-orchestration.md.
//
// Two layers, because that is how the four source instances actually work:
//
//   - RunConfig     : per-run knobs read from env — which profile, how many
//                     iterations, chained on/off this run, dry-run, etc.
//   - ProjectConfig : static project identity — the provider table, the profile
//                     bindings, git host (gh|glab), merge strategy (agent|human),
//                     commit style, base-branch policy. A consumer clones
//                     DEFAULT_PROJECT_CONFIG and edits it.
//
// main.ts calls loadConfig(project?) once, then reads the resolved FactoryConfig.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reasoning effort. Exactly the engine's `claudeCode(model, { effort })` enum
 * (@ai-hero/sandcastle `ClaudeCodeOptions.effort`): low … max. It is a literal
 * here rather than imported from the engine so config.ts stays engine-free and
 * unit-testable in isolation — task #1's tests run with no engine installed.
 * z.ai maps it onto its own server-side `reasoning_effort`; an invalid value
 * 400s there, so this is an exhaustive union, not a loose string. (z.ai's server
 * enum is wider — none, minimal — but `claude --effort` never offers them, so a
 * provider can never send them; they are omitted on purpose.)
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A provider is the quadruplet {model, base URL, token key, reasoning effort}.
 * `baseUrl: null` is meaningful: it omits ANTHROPIC_BASE_URL, which is what makes
 * claude-code hit api.anthropic.com (the Anthropic provider).
 */
export interface Provider {
  readonly model: string;
  readonly tokenKey: string;
  readonly baseUrl: string | null;
  readonly effort: Effort;
}
export type ProviderTable = Readonly<Record<string, Provider>>;

/** Agent roles in the orchestration. `merger` exists only under MERGE_STRATEGY=agent. */
export type Role = 'planner' | 'implementer' | 'reviewer' | 'merger';
export const CORE_ROLES: readonly Role[] = ['planner', 'implementer', 'reviewer'];

export type ProfileName = 'split' | 'opus';
export const PROFILE_NAMES: readonly ProfileName[] = ['split', 'opus'];

/** Role → provider name. `merger` is optional: required only under agent merge. */
export type ProfileBinding = Partial<Record<Role, string>>;
export type Profiles = Readonly<Record<ProfileName, ProfileBinding>>;

export type MergeStrategy = 'agent' | 'human';
export type CommitStyle = 'ralph' | 'conventional';
export type GitHost = 'gh' | 'glab';

/**
 * Static project identity. The part of the Factory a consumer edits to describe
 * *their* repo. Lives in code (or a config file), not in env — a project is on
 * GitHub or GitLab, full stop; that does not change per run.
 */
export interface ProjectConfig {
  readonly providers: ProviderTable;
  readonly profiles: Profiles;
  readonly mergeStrategy: MergeStrategy;
  readonly commitStyle: CommitStyle;
  readonly gitHost: GitHost;
  readonly baseBranch: string;
  /** label → base branch (design-system's per-issue base resolution). Contract data consumed by
   *  the orchestration layer's base-resolution (main.ts); empty ⇒ always baseBranch. */
  readonly labelBases: Readonly<Record<string, string>>;
  /** Base branches eligible for chained mode. Contract data enforced by the chain module
   *  (main.ts/chain.ts) — NOT by this config layer: effectiveMaxParallel needs only the boolean. */
  readonly chainableBases: readonly string[];
  /** glab wants a username; gh uses @me. null ⇒ let the host default. */
  readonly assignee: string | null;
}

/** Per-run knobs, read from env. */
export interface RunConfig {
  readonly profile: ProfileName;
  readonly maxIterations: number;
  readonly maxParallel: number;
  readonly chain: boolean;
  readonly dryRun: boolean;
  readonly only: number[] | null;
  readonly force: boolean;
}

/** The fully-resolved config main.ts consumes. */
export interface FactoryConfig {
  readonly project: ProjectConfig;
  readonly run: RunConfig;
  /** Roles active under this project's merge strategy (merger iff agent). */
  readonly roles: readonly Role[];
  readonly activeProfile: ProfileBinding;
  readonly providerFor: (role: Role) => Provider;
  /** Chained mode serialises the round: chain ⇒ 1, else maxParallel. */
  readonly effectiveMaxParallel: number;
}

// ---------------------------------------------------------------------------
// Defaults — the v0.1 baseline shape (Omniris / GitLab / human-merge).
// A ccsnoop-style consumer overrides gitHost='gh', mergeStrategy='agent', and
// adds a `merger` binding to each profile (see config.test.ts).
// ---------------------------------------------------------------------------

const GLM_MODEL = 'glm-5.2[1m]';
const OPUS_MODEL = 'claude-opus-5';
const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';

export const DEFAULT_PROVIDERS: ProviderTable = {
  zai: {
    model: GLM_MODEL,
    tokenKey: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: ZAI_BASE_URL,
    effort: 'max',
  },
  anthropic: {
    model: OPUS_MODEL,
    tokenKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    baseUrl: null,
    effort: 'medium',
  },
};

export const DEFAULT_PROFILES: Profiles = {
  split: { planner: 'zai', implementer: 'zai', reviewer: 'anthropic' },
  opus: { planner: 'anthropic', implementer: 'anthropic', reviewer: 'anthropic' },
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  providers: DEFAULT_PROVIDERS,
  profiles: DEFAULT_PROFILES,
  mergeStrategy: 'human',
  commitStyle: 'ralph',
  gitHost: 'glab',
  baseBranch: 'main',
  labelBases: {},
  chainableBases: [],
  assignee: null,
};

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

function isProfileName(s: string): s is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(s);
}

/**
 * '1' or 'true' (case-insensitive) ⇒ true; everything else ('0', 'false', '',
 * undefined) ⇒ false. Stricter than `Boolean(env.X)` so that
 * `SANDCASTLE_CHAIN=0` reads as *off*, not the truthy string '0'.
 */
function flag(v: string | undefined): boolean {
  if (v == null) return false;
  const lower = v.toLowerCase();
  return lower === '1' || lower === 'true';
}

function positiveInt(v: string | undefined, def: number, name: string): number {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}.`);
  }
  return n;
}

function parseOnly(raw: string | undefined): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `SANDCASTLE_ONLY must be a comma list of positive issue numbers, got ${JSON.stringify(raw)}.`,
      );
    }
    nums.push(n);
  }
  return nums;
}

export function loadRunConfig(env: Record<string, string | undefined> = process.env): RunConfig {
  const profileRaw = env.SANDCASTLE_PROFILE ?? 'split';
  if (!isProfileName(profileRaw)) {
    throw new Error(
      `Unknown SANDCASTLE_PROFILE=${JSON.stringify(profileRaw)}. ` +
        `Valid profiles: ${PROFILE_NAMES.join(', ')}.`,
    );
  }
  const only = parseOnly(env.SANDCASTLE_ONLY);
  const force = flag(env.SANDCASTLE_FORCE);
  if (force && only === null) {
    throw new Error('SANDCASTLE_FORCE=1 requires SANDCASTLE_ONLY=<issue numbers>.');
  }
  return {
    profile: profileRaw,
    maxIterations: positiveInt(env.SANDCASTLE_MAX_ITERATIONS, 10, 'SANDCASTLE_MAX_ITERATIONS'),
    maxParallel: positiveInt(env.SANDCASTLE_MAX_PARALLEL, 4, 'SANDCASTLE_MAX_PARALLEL'),
    chain: flag(env.SANDCASTLE_CHAIN),
    dryRun: flag(env.SANDCASTLE_DRYRUN),
    only,
    force,
  };
}

// ---------------------------------------------------------------------------
// Resolution — validate project × run, derive the active role set and providers.
// ---------------------------------------------------------------------------

export function resolveConfig(project: ProjectConfig, run: RunConfig): FactoryConfig {
  const activeProfile = project.profiles[run.profile];
  if (activeProfile == null) {
    throw new Error(
      `Profile ${JSON.stringify(run.profile)} is not defined in this project's profiles ` +
        `(have: ${Object.keys(project.profiles).join(', ') || 'none'}).`,
    );
  }

  const roles: Role[] =
    project.mergeStrategy === 'agent' ? [...CORE_ROLES, 'merger'] : [...CORE_ROLES];

  for (const role of roles) {
    const providerName = activeProfile[role];
    if (providerName == null) {
      throw new Error(
        `Profile ${JSON.stringify(run.profile)} does not bind the required role ` +
          `${JSON.stringify(role)} (MERGE_STRATEGY=${project.mergeStrategy}).`,
      );
    }
    if (!(providerName in project.providers)) {
      throw new Error(
        `Profile ${JSON.stringify(run.profile)} binds role ${JSON.stringify(role)} to unknown ` +
          `provider ${JSON.stringify(providerName)} (known: ${Object.keys(project.providers).join(', ') || 'none'}).`,
      );
    }
  }

  const providerFor = (role: Role): Provider => {
    const name = activeProfile[role];
    const p = name != null ? project.providers[name] : undefined;
    if (p == null) {
      // roles are validated above; the only unbound case is `merger` under human strategy.
      throw new Error(
        `No provider bound for role ${JSON.stringify(role)} under profile ${JSON.stringify(run.profile)}.`,
      );
    }
    return p;
  };

  return {
    project,
    run,
    roles,
    activeProfile,
    providerFor,
    effectiveMaxParallel: run.chain ? 1 : run.maxParallel,
  };
}

/** Convenience: read process.env + a project config in one call. */
export function loadConfig(
  project: ProjectConfig = DEFAULT_PROJECT_CONFIG,
  env: Record<string, string | undefined> = process.env,
): FactoryConfig {
  return resolveConfig(project, loadRunConfig(env));
}
