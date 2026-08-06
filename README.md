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
| `.sandcastle/chain.ts` | Chained-MR base resolution — the pure, host-agnostic stack walk. |
| `.sandcastle/host.ts` | The host abstraction — owns every glab-vs-gh difference (issue view/labels, draft MR/PR creation, open-MR/PR listing, work-queue enumeration, and the prompt-time command strings). |
| `.sandcastle/mr-body.ts` | Builds Draft-MR titles + descriptions from agent output + git/host facts. |
| `.sandcastle/Dockerfile.base` | The universal Sandcastle runtime base image recipe — the layer every consumer image is built `FROM`. See [Sandbox image](#sandbox-image). |
| `.sandcastle/*.test.ts` | Contract tests (run with `npm test`). |
| `.sandcastle/skills-lock.ts` | Hashes, scans, and verifies the vendored skills; regenerates `skills-lock.json`. |
| `.sandcastle/adopt.ts` | One-command in-place adoption into an existing repo — see [Adopt into an existing repo](#adopt-into-an-existing-repo). |
| `.claude/skills/` | The vendored Matt Pocock skills — see [Vendored skills](#vendored-skills). |
| `skills-lock.json` | Manifest of record for the vendored skills (source + path + content hash each). |
| `templates/` | Project-context skeletons a consumer fills in after cloning — see [Project context](#consuming-the-factory-clone-and-own). |
| `.sandcastle/.env.secrets.example` | Template for the provider-token file `main.ts` reads (copy to `.env.secrets`). |
| `.sandcastle/.env.example` | Template for the `.env` file `resolveEnv` merges into every sandbox — holds the host-CLI token (`GH_TOKEN`/`GITLAB_TOKEN`). |
| `docs/adr/` | Architecture decision records. |

## The Orchestration

`main.ts` runs the Engine in a three-phase loop, all driven by `loadConfig()`:

1. **Plan** — the queue (open issues carrying any `queueLabels` label — `sandcastle`
   and `ready-for-agent` by default) is enumerated host-side and handed to a
   throwaway Planner sandbox, which emits `<plan>{ "issues": [...] }</plan>` choosing
   the issues for this round and a branch for each.
2. **Work** — up to **`SANDCASTLE_MAX_PARALLEL`** issues run at once. Per issue, an
   **Implementer** then a **Reviewer** that fixes *in place* (edits + commits
   directly on the branch — no verdict loop). Two *sequential* sandboxes on the
   same branch, because the provider env is baked at sandbox level.
3. **Publish** — host-side `git push` + a Draft MR/PR (`glab mr create` or `gh pr
   create`, via `host.ts`) for every branch that got commits. **Never auto-merged**
   (`MERGE_STRATEGY=human`): a human
   reviews and merges.

The **Agent roles** are Planner, Implementer, Reviewer — plus an optional Merger
(only under `MERGE_STRATEGY=agent`, fenced in v0.1). The active **Profile** fixes
the provider and reasoning effort for every role.

## Consuming the Factory (clone-and-own)

Consumption is a **clone-and-own template**, not a submodule
([ADR-0002](docs/adr/0002-consumption-template-model.md)). You clone, drop `.git`,
and the `.sandcastle/` config becomes *your* project's, with no ongoing link. Drift
after cloning is expected; re-sync from the Factory by hand when you want upstream
improvements. There are two ways in: a **greenfield clone** ([Setup](#setup) below)
for a brand-new repo, or **[adopting into an existing repo](#adopt-into-an-existing-repo)**
that already has its own history and remote.

### Prerequisites

The loop is not pure TypeScript — it drives a container runtime and a host CLI, so a fresh
machine needs all four. Node's floor matches the base image; the others just need to be
recent.

| Tool | Version | Why |
|---|---|---|
| **Node.js** | ≥ 22 LTS | Runs the Engine and `tsx`; matches the `node:22-bookworm` base image. |
| **Docker or Podman** | recent (Docker tested 29.x) | The sandbox container runtime. `main.ts` drives the Engine's `docker()` in v0.1; Podman is also Engine-supported and a follow-up to wire. |
| **git** | any modern | Clone the Factory / your repo; Phase 3 pushes feature branches. |
| **glab** *or* **gh** | glab ≥ 1.107 / gh ≥ 2.40 | The host CLI: Phase 3 opens the Draft MR/PR **host-side**. Install the one matching your `gitHost` (`glab` for GitLab, `gh` for GitHub). |

### Setup

```sh
# 1. Clone (or use as a GitHub template) and make it yours.
git clone <this-repo> my-project && cd my-project && rm -rf .git && git init

# 2. Point it at your repo and seed the trunk. `rm -rf .git` wiped the remote AND the
#    history, so add `origin` back (at your host — GitLab or GitHub), make the initial
#    commit on `main` (the Factory's default base branch), and publish it. Phase 3
#    (`git push -u origin`) and the startup base-branch check both need an `origin`
#    with your trunk on it — without this step both fail, silently, at the first run.
git remote add origin <your-repo-url>
git add -A && git commit -m "Initial commit from Software Factory"
git branch -M main
git push -u origin main

# 3. Install — this pulls the Engine (@ai-hero/sandcastle, pinned).
npm install

# 4. Authenticate against your host (GitLab or GitHub). Then set `gitHost` in
#    config.ts to match — the default is 'glab'; a GitHub repo sets 'gh'. The loop
#    warns at startup if gitHost disagrees with the `origin` remote's host.
glab auth login   # or: gh auth login

# 5. Provide auth tokens — env-first (preferred) or a secrets file. See "Auth token isolation" below.
#    Plug-and-play: export the two tokens in your shell profile (~/.bashrc) and skip the file.
cp .sandcastle/.env.secrets.example .sandcastle/.env.secrets   # optional fallback
$EDITOR .sandcastle/.env.secrets

# 5b. Provide the host-CLI token so the in-sandbox `gh`/`glab` the planner/implementer
#     run is authed. resolveEnv merges .env into every sandbox — no main.ts patch needed.
#     Set the var matching your gitHost: GH_TOKEN (gh) / GITLAB_TOKEN (glab). Skip for `local`.
cp .sandcastle/.env.example .sandcastle/.env                    # optional fallback
echo "GITLAB_TOKEN=$(glab auth token)" >> .sandcastle/.env      # or GH_TOKEN=$(gh auth token)

# 6. (Optional, recommended) Configure your project identity — see below.
$EDITOR .sandcastle/config.ts

# 7. Dry-run first: prints the resolved wiring and validates base branches, launches nothing.
#    Needs no sandbox image and exits 0 even with both tokens MISSING — a fresh clone is green here.
SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts

# 8. Build the sandbox image — see "Sandbox image" below (required before a real run, not for the dry-run).

# 9. Run the loop.
npx tsx .sandcastle/main.ts
```

### Adopt into an existing repo

The greenfield path above (`git clone … && rm -rf .git && git init`) erases the
target's history and assumes the Factory becomes the repo root. For a repo that
already exists — its own history, its own remote — adopt `.sandcastle/` **in place**
with one command, run from the Factory root:

```sh
npx tsx .sandcastle/adopt.ts /path/to/your-repo   # add --force to re-sync from upstream later
```

It does four things, none of which touch the consumer's tracked `.gitignore`:

1. **Copy `.sandcastle/`** — tracked Factory files only (`git archive HEAD`), so the
   copy is secret-free by construction. It refuses to clobber an already-adopted
   `.sandcastle/`; `--force` re-syncs from the Factory HEAD (this overwrites the
   tracked files, including `config.ts` — back up local edits first).
2. **Wire the runtime** — installs whatever the Factory's `package.json` declares that
   your repo does not already have: the Engine (`@ai-hero/sandcastle`) plus the
   `tsx` / `typescript` / `@types/node` dev tools. The package manager is detected from
   your lockfile (pnpm/yarn/bun, else npm). Deps you already declare at any version are
   left alone — your versions are yours ([ADR-0003](docs/adr/0003-factory-boundary.md)).
   If the install genuinely fails (offline, unknown manager), it falls back to
   symlinking the Engine out of the Factory clone and warns — make it permanent with a
   real `add` later. A non-zero exit that still leaves the Engine installed (e.g. pnpm's
   `ERR_PNPM_IGNORED_BUILDS` warning for unapproved native build scripts such as
   esbuild) is treated as success, not a failure. The saved range follows your package
   manager's default (npm adds a `^`); pin exact (`@0.12.0`) if you need to.
3. **Self-contained ESM** — `main.ts` uses top-level `await`, so `.sandcastle/` ships its
   own `{"type":"module"}` package.json. It lands with the step-1 copy and makes
   `main.ts` transpile regardless of your repo's root `package.json` (issue #8) — CJS or
   ESM alike. Adopt repairs it in place only if a stale copy is somehow missing it.
4. **Ignore `.sandcastle/` locally** — appends to `.git/info/exclude`, so the Factory
   config stays untracked without editing your committed `.gitignore`.

After adopting, fill in the project-context skeletons (they ship in the Factory's
`templates/`, not in the copy) and then follow [Setup](#setup) from the **Authenticate**
step onward (the adopt path already installed the runtime and your existing repo already
has its `origin` — so steps 1-3 above do not apply):

```sh
cp templates/CLAUDE.md  /path/to/your-repo/CLAUDE.md
cp templates/CONTEXT.md /path/to/your-repo/CONTEXT.md   # domain glossary (delete if you have none yet)
$EDITOR /path/to/your-repo/.sandcastle/config.ts
SANDCASTLE_DRYRUN=1 npx tsx /path/to/your-repo/.sandcastle/main.ts
```

> **`.sandcastle/` is the whole copy.** Adoption ships only the orchestration layer —
> the same config-only boundary as a greenfield clone ([ADR-0001](docs/adr/0001-factory-scope-config-only.md)).
> The project-context skeletons (`templates/CLAUDE.md`, `templates/CONTEXT.md`) and
> your sandbox project layer (`.sandcastle/Dockerfile`) are yours to add afterward.

### Sandbox image

The sandbox is a container the Engine starts per agent. Its image is **two layers**, and
only the first ships in the Factory:

1. **Runtime base (universal → `.sandcastle/Dockerfile.base`).** Node + system deps
   (git/curl/jq) + the `agent` user aligned to your host UID/GID + the pinned Claude Code
   CLI. Built once per host. This is the only image recipe the Factory ships.
2. **Project layer (consumer → `.sandcastle/Dockerfile`).** `FROM sandcastle-base`, adds
   *this* project's build/test deps — including its host CLI (`glab` or `gh`) — and
   re-declares `ENTRYPOINT ["sleep", "infinity"]`. Project context
   ([ADR-0003](docs/adr/0003-factory-boundary.md)) — yours to write.

```sh
# (a) Build the universal base (no COPY in it, so no build context is needed — pipe it in).
docker build -t sandcastle-base:latest \
  --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) \
  - < .sandcastle/Dockerfile.base

# (b) Write your project layer at .sandcastle/Dockerfile (the name the Engine reads):
#       FROM sandcastle-base:latest
#       RUN <your project's build/test deps>
#       ENTRYPOINT ["sleep", "infinity"]

# (c) Build the sandbox image the loop will use. The Engine reads .sandcastle/Dockerfile,
#     tags the image, and passes your host UID/GID as AGENT_UID/AGENT_GID for you.
npx @ai-hero/sandcastle docker build-image
```

**Missing image → actionable abort.** Before the loop starts, `main.ts` probes
`sandcastle:<repo>` and, if the daemon is up but the image is missing, aborts
with the two build steps above (plus a Claude-Code-pasteable prompt) instead of
letting the planner sandbox die on a `WorktreeError` mid-round. A daemon that
can't be reached is left for the Engine's own error — never reported as "missing".
The dry run (`SANDCASTLE_DRYRUN=1`) surfaces it as
`sandboxImage: <name> (built | MISSING | docker daemon unreachable)`.

Two Engine mechanics this relies on, so the image you build is the image the loop expects:

- **Image name.** `main.ts` runs `docker()` without an `imageName`, so the Engine derives
  it from the repo directory — `sandcastle:<lowercased-repo-basename>` (e.g.
  `sandcastle:my-project`). `build-image` tags it that way automatically; there is nothing
  to pass. (Hand-rolling `docker build -t sandcastle:my-project …` works too, as long as
  the tag matches the repo directory.)
- **UID pre-flight check.** Before starting a sandbox the Engine inspects the image's
  `USER`, parses the UID, and throws `UID mismatch … Rebuild the image with 'sandcastle
  docker build-image'` if it differs from your host UID. The `AGENT_UID`/`AGENT_GID`
  build-args and the `node → agent` rename in `Dockerfile.base` are exactly what make a
  `build-image`-built image pass on any host.

The four instances this Factory converged from (ccsnoop; omniris/{api, back-office,
design-system}) each currently inline the *whole* runtime in their own Dockerfile — the
drift this factoring removes. Their **project layers** are the model for yours: a UI repo
adds a browser toolchain, an API repo adds its runtime plus a local database, and so on. A
consumer on the Factory builds `Dockerfile.base` once and keeps only those project-specific
lines. The base stays free of them — `npm run image:check` guards that.

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
> cp .sandcastle/.env.secrets.example .sandcastle/.env.secrets   # optional — or export the tokens in your shell
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
| `gitHost` | `'gh' \| 'glab'` | `'glab'` | Host integration (`gh` = GitHub, `glab` = GitLab). Both are wired in v0.1 — see `host.ts`. |
| `baseBranch` | `string` | `'main'` | The project trunk. A live run fast-forwards each base to `origin` before agents fork, so a round never builds on stale code; a base curated locally ahead of origin is kept as-is (#14). |
| `labelBases` | `Record<string,string>` | `{}` | Issue label → base branch. Empty ⇒ every issue forks from `baseBranch`. |
| `queueLabels` | `string[]` | `['sandcastle', 'ready-for-agent']` | Queue trigger labels — an open issue carrying ANY of these is candidate work. Default accepts both so the Factory (`sandcastle`) and captable (`ready-for-agent`) queue with no relabelling; narrow per consumer (#15). |
| `chainableBases` | `string[]` | `[]` | Bases eligible for Chained mode. Empty ⇒ chaining is inert even with `SANDCASTLE_CHAIN=1`. |
| `assignee` | `string \| null` | `null` | Host assignee. glab wants a username; gh accepts `@me`. `null` ⇒ leave the MR/PR unassigned. |
| `worktreeExclude` | `string[]` | `['.pnpm-store/']` | Gitignore patterns for generated artifacts (package-manager stores, …) the Engine's "uncommitted changes" check would otherwise flag in an agent worktree. Written to the shared `.git/info/exclude`, so a tracked-but-uncommitted change still warns (#20). |

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

A consumer on GitHub sets `gitHost: 'gh'` (the GitHub host ships in v0.1 — see
`host.ts`). The ccsnoop shape adds agent-merge: `mergeStrategy: 'agent'` plus a
`merger` binding on each profile (see `config.test.ts`) — **that** override is still
fenced in v0.1 until the Merger module lands.

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

So the Factory keeps **auth tokens out of `.env`**, resolving each one **env-first**:
`process.env[key] ?? .sandcastle/.env.secrets[key]`. Export the tokens once in your
shell profile and any Factory instance runs with **no per-instance secret file**
(plug-and-play):

```sh
# ~/.bashrc (or ~/.zshrc) — export once, reuse across every Factory instance
export ANTHROPIC_AUTH_TOKEN=...      # the z.ai / GLM token (provider "zai")
export CLAUDE_CODE_OAUTH_TOKEN=...   # the Anthropic token (provider "anthropic")
```

The gitignored `.sandcastle/.env.secrets` file is the **fallback** for machines where
you'd rather not export the tokens in the shell — same keys, read only by `main.ts`
and baked one-per-sandbox, optional when the env vars above are set:

```sh
# .sandcastle/.env.secrets  (gitignored — never committed; optional when exported above)
ANTHROPIC_AUTH_TOKEN=...      # the z.ai / GLM token (provider "zai")
CLAUDE_CODE_OAUTH_TOKEN=...   # the Anthropic token (provider "anthropic")
```

`main.ts` resolves each required token env-first, prints its **source** at startup and
in `SANDCASTLE_DRYRUN` (`env` / `.env.secrets` / `MISSING`, value masked — never the
token itself), warns when the env and the file carry *different* values (the env value
wins), and **throws at startup if `.sandcastle/.env` declares any active provider's
`tokenKey`** — the exact leak the `.env` / `.env.secrets` split exists to stop. Only
the tokens the **active profile's** providers need are required; `.env` keeps only what
*every* agent needs.

### Host-CLI token (the one secret that lives in `.env`)

The planner/implementer prompts run `gh` / `glab` **inside** the sandbox, and that
sandbox must have the CLI authed — otherwise the planner's `gh pr list` exits 4 and
Phase 1 dies before emitting a plan. The provider-token rule above does **not** apply
to the host-CLI credential: there is exactly one per host, it is the same for every
sandbox, and claude-code never reads it, so there is no cross-provider 401. So the
conventionally-named token goes **in `.env`**, where `resolveEnv` flows it to every
sandbox with **no `main.ts` patch** (the `.env` / `.env.secrets` split is what makes
that safe):

```sh
# .sandcastle/.env  (gitignored — resolveEnv merges this into every sandbox)
GH_TOKEN=...        # gitHost: 'gh'
GITLAB_TOKEN=...    # gitHost: 'glab' (default)
# gitHost: 'local' → none (no host CLI, no token required)
```

`main.ts` resolves the host token **env-first against `.env`** (not `.env.secrets` —
`resolveEnv` does not read that file), prints its source at startup and in
`SANDCASTLE_DRYRUN`, and **throws at startup naming the var and the file** if it is
missing — before the first sandbox, not inside it. Obtain the value with the host CLI
(`gh auth token` / `glab auth token` after `auth login`), or export it once in your
shell and skip the file. See [`.env.example`](.sandcastle/.env.example).

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

**Served out of the box:** the **Split** profile + **human-merge** (draft MR/PR,
awaiting review) + **both** host shapes — **GitLab** (`glab`) and **GitHub** (`gh`),
via `host.ts`. The GitLab shape is the default (the Omniris majority); a GitHub
project flips `gitHost: 'gh'` in `config.ts`.

**Fenced with a loud, early guard** (it throws at startup, not silently no-op):

| Capability | Guard | Status |
|---|---|---|
| `mergeStrategy: 'agent'` (the auto-merging Merger role) | `main.ts` throws if `mergeStrategy !== 'human'` | Follow-up module. |

`gitHost: 'gh'` is **no longer fenced** — the GitHub host landed in `host.ts`, and the
loop warns at startup when `gitHost` disagrees with the `origin` remote's host.
`SANDCASTLE_PROFILE=opus` is **not fenced**; it works but is not specially tested (see
[Modes](#modes)).

## Developing

```sh
npm test          # config + tokens + plan + chain + host + skills-lock + dockerfile-base + adopt + esm-shim contract tests
npm run typecheck # tsc --noEmit over .sandcastle/
npm run skills:check  # verify .claude/skills/ against skills-lock.json
npm run image:check   # verify .sandcastle/Dockerfile.base against the universal-runtime contract
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
