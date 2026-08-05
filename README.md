# Software Factory

The SoftNext shared config-and-orchestration layer for running **Sandcastle**-driven agent
loops across projects. Clone this repo to start a new project instead of
re-assembling a Sandcastle setup by hand and re-tuning it each time.

> **Factory vs Engine.** This repo is the *Factory* — the converged
> config-and-orchestration layer. **Sandcastle** (the *Engine*) is an upstream
> TypeScript runtime (`mattpocock/sandcastle`, npm `@ai-hero/sandcastle`) that the
> Factory drives. The Factory is **config-only**: it contains no Engine code. The
> Engine is an external pinned dependency, installed per consumer via `npm` — see
> [ADR-0001](docs/adr/0001-factory-scope-config-only.md). For the full glossary
> (Factory instance, Project context, Orchestration, Agent role, Split/Opus/Chained,
> MERGE_STRATEGY, skills-lock.json) see [CONTEXT.md](CONTEXT.md).

## What's here

| Path | Role |
|---|---|
| `.sandcastle/config.ts` | The canonical config surface — `RunConfig` × `ProjectConfig` → `FactoryConfig`. |
| `.sandcastle/main.ts` | The **Orchestration**: the converged `plan → implement+review → publish` loop. |
| `.sandcastle/plan.ts` | Parses the planner's `<plan>` JSON; label → base resolution. |
| `.sandcastle/chain.ts` | Chained-MR base resolution. |
| `.sandcastle/mr-body.ts` | Builds Draft-MR titles + descriptions from agent output + git/GitLab facts. |
| `.sandcastle/*.test.ts` | Contract tests (run with `npm test`). |
| `.sandcastle/skills-lock.ts` | Hashes, scans, and verifies the vendored skills; regenerates `skills-lock.json`. |
| `.claude/skills/` | The vendored Matt Pocock skills — see [Vendored skills](#vendored-skills). |
| `skills-lock.json` | Manifest of record for the vendored skills (source + path + content hash each). |
| `templates/` | Project-context skeletons a consumer fills in after cloning — see [Project context](#consuming-the-factory-clone-and-own). |
| `.sandcastle/.env.secrets.example` | Template for the auth-token file `main.ts` reads (copy to `.env.secrets`). |
| `docs/adr/` | Architecture decision records. |

## The Orchestration

`main.ts` runs the Engine in a three-phase loop, all driven by `loadConfig()`:

1. **Plan** — a throwaway Planner sandbox reads the `sandcastle` issue queue and
   emits `<plan>{ "issues": [...] }</plan>` choosing the issues for this round and
   a branch for each.
2. **Work** — up to **`SANDCASTLE_MAX_PARALLEL`** issues run at once. Per issue, an
   **Implementer** then a **Reviewer** that fixes *in place* (edits + commits
   directly on the branch — no verdict loop). Two *sequential* sandboxes on the
   same branch, because the provider env is baked at sandbox level.
3. **Publish** — host-side `git push` + `glab mr create --draft` for every branch
   that got commits. **Never auto-merged** (`MERGE_STRATEGY=human`): a human
   reviews and merges.

The **Agent roles** are Planner, Implementer, Reviewer — plus an optional Merger
(only under `MERGE_STRATEGY=agent`, fenced in v0.1). The active **Profile** fixes
the provider and reasoning effort for every role.

## Consuming the Factory (clone-and-own)

Consumption is a **clone-and-own template**, not a submodule
([ADR-0002](docs/adr/0002-consumption-template-model.md)). You clone, drop `.git`,
and the `.sandcastle/` config becomes *your* project's, with no ongoing link. Drift
after cloning is expected; re-sync from the Factory by hand when you want upstream
improvements.

```sh
# 1. Clone (or use as a GitHub template) and make it yours.
git clone <this-repo> my-project && cd my-project && rm -rf .git && git init

# 2. Install — this pulls the Engine (@ai-hero/sandcastle, pinned).
npm install

# 3. Authenticate against your GitLab (glab is the only host wired in v0.1).
glab auth login

# 4. Create the secrets file from the shipped example — see "Auth token isolation" below.
cp .sandcastle/.env.secrets.example .sandcastle/.env.secrets
$EDITOR .sandcastle/.env.secrets

# 5. (Optional, recommended) Configure your project identity — see below.
$EDITOR .sandcastle/config.ts

# 6. Dry-run first: prints the resolved wiring and validates base branches, launches nothing.
SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts

# 7. Run the loop.
npx tsx .sandcastle/main.ts
```

> **Project context stays in the consumer** ([ADR-0003](docs/adr/0003-factory-boundary.md)):
> your `CLAUDE.md` sections, your domain `CONTEXT.md`, your testing recipe and audit
> command, and `settings.local.json` are yours to supply after cloning. The Factory
> ships only universal orchestration, not project-specific content. It does ship
> **fill-in skeletons** so a loop run on a fresh clone is not flying blind:
>
> ```sh
> # The agents read @CLAUDE.md as the authority for the gate, standards, suites,
> # commit style, review lane, release tooling, and domain context — fill it in
> # before the first run.
> cp templates/CLAUDE.md ./CLAUDE.md
> cp templates/CONTEXT.md ./CONTEXT.md      # domain glossary (delete if you have none yet)
> cp .sandcastle/.env.secrets.example .sandcastle/.env.secrets   # then add the tokens
> ```

## Configuration reference

The Factory resolves a **`FactoryConfig`** from two layers:

- **`RunConfig`** — per-run knobs read from environment variables.
- **`ProjectConfig`** — static project identity, edited in code (`DEFAULT_PROJECT_CONFIG`
  in `config.ts`). A project is on GitLab or GitHub, full stop; that does not change
  per run.

### Run knobs (environment)

| Variable | Default | Effect |
|---|---|---|
| `SANDCASTLE_PROFILE` | `split` | Which profile runs: `split` or `opus`. An unknown value throws and names the valid profiles. |
| `SANDCASTLE_MAX_ITERATIONS` | `10` | Maximum rounds before the loop stops. Must be a positive integer. |
| `SANDCASTLE_MAX_PARALLEL` | `4` | Max issues worked concurrently in Phase 2. Positive integer. **Forced to `1` when `SANDCASTLE_CHAIN=1`** (a stack is built one MR at a time). |
| `SANDCASTLE_CHAIN` | off | `1`/`true` (case-insensitive) → on; everything else → off. On, a round forks from the head of the open-MR stack and stacks its MR — see [Chained](#modes) below. |
| `SANDCASTLE_DRYRUN` | off | `1`/`true` → on. Prints the resolved wiring (profile, per-role model/effort/env with tokens masked, base-branch checks, chain state) and exits. Launches nothing. |
| `SANDCASTLE_ONLY` | unset | A comma list of positive issue numbers to restrict the round to (e.g. `42` or `42,43`). The planner is told the allow-list, and `main.ts` **enforces** it on the result — issues outside the list are dropped even if the planner proposed them. If none match, the round stops. |
| `SANDCASTLE_FORCE` | off | `1`/`true` → on. **Requires `SANDCASTLE_ONLY`** (config throws otherwise). Tells the planner to re-propose the `ONLY` issues even if they already have an open MR or appear resolved — a deliberate re-run. |

### Project identity (`ProjectConfig`, in `config.ts`)

Edit `DEFAULT_PROJECT_CONFIG` to describe *your* repo.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `providers` | `ProviderTable` | see below | Named providers — the `{model, baseUrl, tokenKey, effort}` quadruplets. |
| `profiles` | `Profiles` | see below | Per-profile role → provider bindings. |
| `mergeStrategy` | `'agent' \| 'human'` | `'human'` | Who merges. `human` = Draft MRs await review (v0.1). `agent` = a Merger auto-merges (fenced). |
| `commitStyle` | `'ralph' \| 'conventional'` | `'ralph'` | MR title style. `conventional` keeps titles valid Conventional Commit headers. |
| `gitHost` | `'gh' \| 'glab'` | `'glab'` | Host integration. v0.1 ships `glab` only; `gh` is fenced. |
| `baseBranch` | `string` | `'main'` | The project trunk. |
| `labelBases` | `Record<string,string>` | `{}` | Issue label → base branch. Empty ⇒ every issue forks from `baseBranch`. |
| `chainableBases` | `string[]` | `[]` | Bases eligible for Chained mode. Empty ⇒ chaining is inert even with `SANDCASTLE_CHAIN=1`. |
| `assignee` | `string \| null` | `null` | glab `--assignee` username. `null` ⇒ leave the MR unassigned. |

A **provider** is the quadruplet `{ model, baseUrl, tokenKey, effort }`:

- `model` — e.g. `glm-5.2[1m]`, `claude-opus-5`.
- `baseUrl` — `null` is meaningful: it omits `ANTHROPIC_BASE_URL`, which is what makes
  claude-code hit `api.anthropic.com` (the Anthropic provider). A non-null value points
  at a compatible endpoint (z.ai).
- `tokenKey` — the env var holding the auth token (e.g. `ANTHROPIC_AUTH_TOKEN`).
- `effort` — reasoning effort, exactly the Engine's `claudeCode({ effort })` enum:
  `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Effort follows the **provider**, not
  the role — so `SANDCASTLE_PROFILE=opus` drops the GLM ceiling on its own.

### Defaults (the v0.1 baseline — Omniris / GitLab / human-merge)

```ts
providers: {
  zai:       { model: 'glm-5.2[1m]', baseUrl: 'https://api.z.ai/api/anthropic', tokenKey: 'ANTHROPIC_AUTH_TOKEN',    effort: 'max'    },
  anthropic: { model: 'claude-opus-5', baseUrl: null,                            tokenKey: 'CLAUDE_CODE_OAUTH_TOKEN', effort: 'medium' },
}

profiles: {
  split: { planner: 'zai', implementer: 'zai', reviewer: 'anthropic' },  // cross-provider: reviewer ≠ implementer
  opus:  { planner: 'anthropic', implementer: 'anthropic', reviewer: 'anthropic' },
}
```

A consumer on GitHub with agent-merge (the ccsnoop shape) overrides `gitHost: 'gh'`,
`mergeStrategy: 'agent'`, and adds a `merger` binding to each profile (see
`config.test.ts`) — both overrides are **fenced** in v0.1 until their modules land.

### Modes

- **Split** (default) — Implementer on GLM (z.ai), Reviewer on Claude Opus
  (Anthropic). Cross-provider by construction: the reviewer does not share the
  author's blind spots.
- **Opus** — all roles on Opus, for high-stakes tickets. `SANDCASTLE_PROFILE=opus`.
  Works mechanically (it is just another profile); not specially tested.
- **Chained** — stacks MRs instead of fanning out: ticket N forks from the head of
  N-1's draft MR. `SANDCASTLE_CHAIN=1`, restricted to `chainableBases`, one issue
  per round. Keeps long EPICs reviewable when the loop outpaces human review.

## Auth token isolation

Sandcastle's `resolveEnv` merges **all** of `.sandcastle/.env` into every sandbox,
and a sandbox env can only *add* keys, never remove them. Two auth tokens in `.env`
would both leak into every sandbox → claude-code sends the wrong token to the wrong
base URL → **401**.

So the Factory keeps **auth tokens out of `.env`**, in a separate gitignored file
`.sandcastle/.env.secrets`, read only by `main.ts` and baked one-per-sandbox:

```sh
# .sandcastle/.env.secrets  (gitignored — never committed)
ANTHROPIC_AUTH_TOKEN=...      # the z.ai / GLM token (provider "zai")
CLAUDE_CODE_OAUTH_TOKEN=...   # the Anthropic token (provider "anthropic")
```

Only the tokens the **active profile's** providers need are required; `main.ts`
validates them at startup, not at the first sandbox. `.env` keeps only what *every*
agent needs.

## Vendored skills

The Matt Pocock skills are **vendored directly** into `.claude/skills/`
([ADR-0005](docs/adr/0005-matt-skills-vendored-with-lockfile.md)), so a consumer
clones and starts with **zero network dependency** — no plugin marketplace, no
GitHub fetch at install time (the very thing the Webshare proxy exists to work
around). The set is the engineering suite plus the relevant productivity skills:

- **`engineering/`** — `ask-matt`, `code-review`, `codebase-design`,
  `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`,
  `improve-codebase-architecture`, `prototype`, `research`,
  `resolving-merge-conflicts`, `setup-matt-pocock-skills`, `tdd`, `to-spec`,
  `to-tickets`, `triage`, `wayfinder`.
- **`productivity/`** — `grill-me`, `grilling`, `handoff`, `teach`.

Deliberately **not** vendored: `deprecated/`, `personal/`, `in-progress/`,
`misc/`, and the writing skills — outside the Factory boundary
([ADR-0003](docs/adr/0003-factory-boundary.md)).

`skills-lock.json` is the **manifest of record**: each skill's upstream source,
repo-relative path, and a SHA-256 over its contents. Verify the vendored copy is
intact, or regenerate it after an intentional update:

```sh
npm run skills:check   # verify .claude/skills/ matches the lock (exit 1 on drift)
npm run skills:lock    # regenerate skills-lock.json from the current tree
```

The lock covers every directory containing a `SKILL.md` — which is the whole of
`.claude/skills/`, so the manifest is a complete inventory of the vendored tree.
A consumer who prefers auto-updating skills can ignore the vendored set and
install the `mattpocock-skills` plugin instead — both are documented
alternatives in ADR-0005.

## v0.1 scope

**Served out of the box:** the **Split** profile + **human-merge** (`glab mr create
--draft`) + the **GitLab** (`glab`) host. This is the Omniris majority shape.

**Fenced with loud, early guards** (they throw at startup, not silently no-op):

| Capability | Guard | Status |
|---|---|---|
| `gitHost: 'gh'` (GitHub / `gh pr create`) | `main.ts` throws if `gitHost !== 'glab'` | Follow-up module. |
| `mergeStrategy: 'agent'` (the auto-merging Merger role) | `main.ts` throws if `mergeStrategy !== 'human'` | Follow-up module. |

`SANDCASTLE_PROFILE=opus` is **not fenced**; it works but is not specially tested (see
[Modes](#modes)).

## Developing

```sh
npm test          # config + plan + chain + skills-lock contract tests (59 cases)
npm run typecheck # tsc --noEmit over .sandcastle/
npm run skills:check  # verify .claude/skills/ against skills-lock.json
```

Tests are pure (no network, no secrets, no `process.env`) and use `node:assert/strict`
under `tsx` — no test framework dependency. Each `*.test.ts` runs as its own process
via the shared `.sandcastle/test-harness.ts`.

## Decisions

- [CONTEXT.md](CONTEXT.md) — the glossary (ubiquitous language).
- [docs/adr/0001](docs/adr/0001-factory-scope-config-only.md) — Factory scope is
  config-only; the Engine is an external dependency.
- [docs/adr/0002](docs/adr/0002-consumption-template-model.md) — Consumption is a
  clone-and-own template, not a submodule.
- [docs/adr/0003](docs/adr/0003-factory-boundary.md) — Universal orchestration in,
  project context out.
- [docs/adr/0004](docs/adr/0004-converged-config-driven-orchestration.md) — One
  config-driven canonical Orchestration with optional modules.
- [docs/adr/0005](docs/adr/0005-matt-skills-vendored-with-lockfile.md) — Matt skills
  vendored in the Factory, with `skills-lock.json` as manifest.
