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
| `.sandcastle/{plan,implement,review}-prompt.md` | The three agent prompts the Engine's `promptFile` loads — the planner's receives the queue inline and the effective `CHAIN_MODE`/`ONLY`/`FORCE` knobs. |
| `.sandcastle/chain.ts` | Chained-MR base resolution — the pure, host-agnostic stack walk. |
| `.sandcastle/host.ts` | The host abstraction — owns every glab-vs-gh difference (issue view/labels, draft MR/PR creation, open-MR/PR listing, work-queue enumeration, and the prompt-time command strings). Host reads retry on transient failure (#25) and classify their failure as transient vs definitive (#31). |
| `.sandcastle/report.ts` | The **pre-MR report phase** — a client skill that explains the pushed branch and hands back one url for the MR body. Pure half: what counts as a report, what does not, and what the MR says either way. Off by default (`ProjectConfig.report: null`). |
| `.sandcastle/report-prompt.md` | The prompt driving that phase's sandbox. |
| `.sandcastle/publish.ts` | The publish ledger — a durable trace of a pushed branch whose MR/PR creation failed, drained by the next run (issue #26). |
| `.sandcastle/iteration.ts` | The per-iteration failure boundary — the pure decision of whether a failure loses its iteration or stops the run (issue #31). `main.ts` owns the try/catch. |
| `.sandcastle/branch-sweep.ts` | Per-run unique branch names (`-r<run>` suffix) and the startup sweep of dead runs' empty branches (issue #28). |
| `.sandcastle/mr-body.ts` | Builds Draft-MR titles + descriptions from agent output + git/host facts, and states the issue's fate (`Closes #n` on the default branch, an explicit why-not note on any other base). |
| `.sandcastle/Dockerfile.base` | The universal Sandcastle runtime base image recipe — the layer every consumer image is built `FROM`. See [Sandbox image](#sandbox-image). |
| `.sandcastle/*.test.ts` | Contract tests (run with `npm test`). |
| `.sandcastle/skills-lock.ts` | Hashes, scans, and verifies the vendored skills; regenerates `skills-lock.json`. |
| `.sandcastle/adopt.ts` | One-command in-place adoption into an existing repo — copies the config layer, wires the runtime, and puts the config under git in the consumer. See [Adopt into an existing repo](#adopt-into-an-existing-repo). |
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
3. **Publish** — host-side `git push`, then — **only if the consumer enabled it** — the
   optional **report phase**, then a Draft MR/PR (`glab mr create` or `gh pr create`, via
   `host.ts`) for every branch that got commits. **Never auto-merged**
   (`MERGE_STRATEGY=human`): a human
   reviews and merges.

### The report phase (optional, off by default)

Between the push and the MR creation, `main.ts` can run one more sandbox: a **client
skill** that reads the branch that was just pushed, writes a review report, publishes it
somewhere, and prints a url. That url goes into the MR body, above the diff — so the
human who opens the MR has something to read before the code.

It is `null` in `DEFAULT_PROJECT_CONFIG` and it stays that way for every consumer who
does not opt in. That is not timidity: `adopt --force` copies `main.ts` and `config.ts`
into every consumer, and most of them have no such skill and nothing to publish to
(ADR-0004, optional modules). What the skill *is* — its name, its doctrine, the platform
it publishes to — is project context and lives in the consumer's `config.ts` (ADR-0003).

```ts
report: {
  skill: 'explain-diff',
  promptFile: './.sandcastle/report-prompt.md',
  role: 'reviewer',                       // borrows that role's provider and model
  mounts: [
    // The Engine mounts only the worktree. A skill symlinked into the HOST's
    // ~/.claude/skills does not exist inside the sandbox — mount the real directory.
    { hostPath: '~/revue/skills/explain-diff', sandboxPath: '/home/agent/.claude/skills/explain-diff' },
    // And mount somewhere durable for whatever the skill leaves behind on failure:
    // anything written inside the sandbox dies with the sandbox.
    { hostPath: '~/.revue/paquets', sandboxPath: '/home/agent/paquets' },
  ],
  env: { REVUE_PAQUETS: '/home/agent/paquets' },
  idleTimeoutSeconds: 1800,
}
```

**Its failure never costs the MR.** The MR is the work; the report is a courtesy.
`runReportPhase` catches everything and returns an outcome — never rethrows. That matters
more than it looks: it sits inside the `try` whose `catch` writes a `PendingPublish`
trace, with `pushed` already true, so an escaping error would be filed as "the MR
creation failed" for an MR that was never attempted. A missing report is **stated in the
MR body**; a publish that degraded leaves the **replay command** there instead of a dead
link. Secrets (instance urls, tokens) belong in `.sandcastle/.env`, not in the tracked
`config.ts`.

A publish whose **push succeeds but whose MR/PR creation fails** (a host 503) is not
lost: the run records a trace in the gitignored `.sandcastle/publish-pending.json`,
and the **next run drains the ledger before planning** — it opens the missing MR/PR
from the recorded title and description (no agent re-runs), or explains why it
cannot (the MR already exists → trace cleared; the branch is gone from origin →
merged-and-deleted, trace cleared). While a trace is pending, its issue is held out
of the planner queue so the ticket is never re-implemented on a duplicate branch
(issue #26). `SANDCASTLE_FORCE=1 SANDCASTLE_ONLY=<n>` bypasses the hold — the
operator asked for the re-run.

A failure inside the loop is **bounded to its iteration** (issue #31): a host
read that outlives its retries (#25's backoff spent on a long-enough outage)
ends its *iteration*, not the run — the next iteration's first act is a fresh
queue read on a host that may have healed, and everything delivered before the
failure stays. A **definitive** host failure (bad credentials, exhausted quota)
or any non-host throw (a config error, a bug in the loop) still stops the run —
retrying ten iterations on an invalid token is ten losses, not ten chances.
Lost iterations are counted and named in the log, never silent, and a run that
lost *all* of them exits non-zero.

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
#    config.ts to match — the default is 'gh' (the Factory's own host); a GitLab
#    repo sets 'glab'. The loop warns at startup if gitHost disagrees with the
#    `origin` remote's host.
glab auth login   # or: gh auth login

# 5. Provide auth tokens — env-first (preferred) or a secrets file. See "Auth token isolation" below.
#    Plug-and-play: export the two tokens in your shell profile (~/.bashrc) and skip the file.
cp .sandcastle/.env.secrets.example .sandcastle/.env.secrets   # optional fallback
$EDITOR .sandcastle/.env.secrets

# 5b. Provide the host-CLI token so the in-sandbox `gh`/`glab` the planner/implementer
#     run is authed. resolveEnv merges .env into every sandbox — no main.ts patch needed.
#     Set the var matching your gitHost: GH_TOKEN (gh) / GITLAB_TOKEN (glab).
cp .sandcastle/.env.example .sandcastle/.env                    # optional fallback
echo "GH_TOKEN=$(gh auth token)" >> .sandcastle/.env            # or GITLAB_TOKEN=$(glab auth token)

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

It does four things, none of which touch the consumer's tracked root `.gitignore`,
its root `package.json` / lockfile, or its history (adoption stages; it never
commits on your behalf):

1. **Copy `.sandcastle/`** — tracked Factory files only (`git archive HEAD`), so the
   copy is secret-free by construction. The Factory's own contract tests
   (`*.test.ts` / `*.spec.ts`) and test harness are stripped from the copy, so a
   consumer's test runner (vitest/jest) doesn't collect them as red files (issue #22).
   It refuses to clobber an already-adopted `.sandcastle/`; `--force` re-syncs from the
   Factory HEAD — and it **deletes the consumer's whole `.sandcastle/` first,
   gitignored files included**, before re-copying. See
   [Re-syncing a consumer after Factory changes](#re-syncing-a-consumer-after-factory-changes).
2. **Wire the runtime** — two locations, chosen so the consumer's tracked root manifest
   stays clean (issue #22):
   - **Dev tools** (`tsx` / `typescript` / `@types/node`) → your repo's **root**. These
     are general-purpose and `npx tsx` resolves them from the root `node_modules/.bin`;
     only what your repo doesn't already declare is added (your versions are yours,
     [ADR-0003](docs/adr/0003-factory-boundary.md)).
   - **Engine** (`@ai-hero/sandcastle`) → **out-of-tree** under `.sandcastle/node_modules`,
     declared in the `.sandcastle/package.json` ESM shim. The install (`<pm> add` with
     `cwd: .sandcastle/`) never touches your root `package.json` or lockfile, so there is
     no uncommitted `@ai-hero/sandcastle` dep for a reviewer to flag. `main.ts` resolves
     it via `.sandcastle/node_modules` before the root.

   The package manager is detected from your lockfile (pnpm/yarn/bun, else npm). If the
   Engine install genuinely fails (offline, unknown manager), it falls back to symlinking
   the Engine from the Factory clone into `.sandcastle/` and warns — make it permanent
   with a real `add` (run inside `.sandcastle/`) later. A non-zero exit that still leaves
   the Engine installed (e.g. pnpm's `ERR_PNPM_IGNORED_BUILDS` warning for unapproved
   native build scripts such as esbuild) is treated as success, not a failure. A repo
   adopted before this change may still carry a stale root `@ai-hero/sandcastle` entry —
   adopt never removes a dep you declared ([ADR-0003](docs/adr/0003-factory-boundary.md));
   drop it yourself to go fully clean.
3. **Self-contained ESM** — `main.ts` uses top-level `await`, so `.sandcastle/` ships its
   own `{"type":"module"}` package.json. It lands with the step-1 copy and makes
   `main.ts` transpile regardless of your repo's root `package.json` (issue #8) — CJS or
   ESM alike. Adopt repairs it in place only if a stale copy is somehow missing it.
4. **Version the config** (issue #29) — `.sandcastle/` is **staged** into your repo, and
   it stays there: the orchestration configuration is a project deliverable, reviewed
   and diffed like any other code. `config.ts` carries project decisions —
   `labelBases` and `chainableBases` decide fork bases and MR targets — that were
   previously invisible: unversioned, they were neither re-readable in review,
   restorable with `git checkout --`, nor visible to a fresh clone, and an agent
   isolated in a linked worktree could not touch them at all. The artifact boundary
   ships with the copy as a nested, scoped `.sandcastle/.gitignore` (`.env*`, `logs/`,
   `worktrees/`, the out-of-tree Engine install), so secrets never become tracked —
   this is exactly the posture the Factory holds on itself. Your root `.gitignore` and
   `.git/info/exclude` are left alone. A repo adopted **before** this change carries a
   whole-dir `.sandcastle/` line in its `.git/info/exclude`; adopt reads both that file and
   your root `.gitignore`, recognises every spelling of the rule (`.sandcastle/`,
   `/.sandcastle/`, `.sandcastle/*`, `.sandcastle/**`) and prints the exact line to remove —
   it never edits your ignore files behind your back.

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

> **The configuration is a project deliverable.** Everything under `.sandcastle/`
> except the runtime artifacts (`.env*`, `logs/`, `worktrees/`, the Engine install)
> is tracked in your repo from the moment you adopt — `config.ts` included. Edit it,
> review the diff, and commit it like any other change to your project: a base-branch
> or queue-label decision made there is exactly as review-worthy as the code it
> governs. The same boundary file (`.sandcastle/.gitignore`) is what keeps the
> secret files out — never bypass it with `git add -f` on `.sandcastle/`.

> **`.sandcastle/` is the whole copy.** Adoption ships only the orchestration layer —
> the same config-only boundary as a greenfield clone ([ADR-0001](docs/adr/0001-factory-scope-config-only.md)).
> The project-context skeletons (`templates/CLAUDE.md`, `templates/CONTEXT.md`) and
> your sandbox project layer (`.sandcastle/Dockerfile`) are yours to add afterward.

### Re-syncing a consumer after Factory changes

Consumption is clone-and-own ([ADR-0002](docs/adr/0002-consumption-template-model.md)):
drift after adoption is expected, and pulling upstream improvements in is a manual
gesture — the same command that adopted the consumer, re-run with `--force`. The
procedure below is written from the consumer's side and is self-contained: an agent
(or human) in the consumer repo needs only a Factory clone at the revision to adopt.

**Prerequisite — Factory side.** The changes (bug fixes, features) must be
**committed on the Factory's `main`**: the copy streams `git archive HEAD`, so
Factory work still sitting in a working tree does not travel.

**1. Back up what `--force` destroys.** `--force` does not merge — it deletes the
consumer's whole `.sandcastle/` directory before re-copying the tracked Factory
files, re-stripping the Factory's dev-only tests (issue #22), re-wiring the
runtime (the out-of-tree Engine install is rebuilt), and re-staging `.sandcastle/`.
Everything gitignored inside `.sandcastle/` is therefore **gone, not overwritten**:

| File in the consumer | Recoverable from the consumer's git? | Before re-syncing |
|---|---|---|
| `config.ts` — the project identity (`gitHost`, `labelBases`, `queueLabels`, `assignee`, providers…) | Yes — tracked since #29 | Nothing, but see step 3 |
| `.env` (host-CLI token), `.env.secrets` (provider tokens) | No — ignored by design | Copy out of the tree |
| `Dockerfile` — the project layer | Yes **iff committed** | Commit it if it is not |
| `publish-pending.json` — the publish ledger (issue #26) | No — ignored | Copy out if present and non-empty |
| `logs/`, `worktrees/` | Regenerable | Nothing |

One gesture covers every row — copy the whole directory out of the tree, and
delete the copy when done (it holds the tokens):

```sh
cp -r /path/to/consumer/.sandcastle /tmp/consumer-sandcastle-backup
```

Which rows git actually answers for depends on the consumer's **posture** —
check before relying on it (run inside the consumer):

```sh
git ls-files .sandcastle/ | wc -l    # 0 → adopted BEFORE #29: nothing tracked
```

A consumer adopted **before #29** ignores the whole directory (a
`.git/info/exclude` or root `.gitignore` line — adopt warns about it and names
the line) and tracks **nothing**: for it the backup is the only recovery path
for `config.ts` and `Dockerfile` too, and step 3 restores from the backup
instead of from git.

And never re-sync while a run is active — live worktrees and a non-empty ledger
belong to that run.

**2. Run the re-sync from the Factory root** (a clone at the revision you want —
its own working tree is irrelevant; only its `HEAD` matters):

```sh
npx tsx .sandcastle/adopt.ts /path/to/consumer --force
```

**3. Restore the project identity, then diff it against the fresh copy.**
Post-#29 consumer (config tracked): `git checkout -- .sandcastle/config.ts`
brings yours back — the re-sync only touched the working tree, not the
consumer's history — and since adopt re-staged the Factory's fresh copy,
`git diff -- .sandcastle/config.ts` shows exactly the drift, in both
directions. Pre-#29 consumer (nothing tracked): restore from the backup
(`config.ts` and the project `Dockerfile`), and diff against the fresh copy
before overwriting it:

```sh
diff /tmp/consumer-sandcastle-backup/config.ts /path/to/consumer/.sandcastle/config.ts
```

Read the diff before deciding: if it shows only the consumer's identity values,
the restored file is complete — keep it. If it shows **new Factory-side
fields** (a config surface this release added), the old file is incomplete for
the new `main.ts` — start from the freshly copied `config.ts` instead and
re-apply the identity (`gitHost`, `labelBases`, `queueLabels`, `assignee`,
providers…) on top. Restore the backed-up `.env` / `.env.secrets` /
`publish-pending.json` in the same pass.

**4. Validate and commit, from the consumer root:**

```sh
SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts   # resolved wiring, launches nothing
git status      # adopt re-staged .sandcastle/ — review the diff, then commit it
```

Adopt stages; it never commits on the consumer's behalf. The re-sync lands as an
ordinary reviewed change — the config is a project deliverable (issue #29, step 4
of the adopt list above), and an upstream sync is exactly as review-worthy as the
code it governs.

A pre-#29 consumer should **migrate here** rather than stay on the backup-only
posture: adopt's warning names the exact whole-dir ignore line to remove
(`.git/info/exclude` or the root `.gitignore`) — remove it, and this step's
staging turns the config into a tracked deliverable, so the **next** re-sync
recovers `config.ts` from git instead of from a `/tmp` copy.

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
| `SANDCASTLE_CHAIN` | off | `1`/`true` (case-insensitive) → on; everything else → off. On, a round forks from the head of the open-MR stack and stacks its MR — see [Chained](#modes) below. **Refuses at startup** (before the planner runs) when no base of the round can chain — `chainableBases` empty or naming no base a ticket derives — with a message naming both `labelBases` and `chainableBases`: neither setting suffices alone. When the config is feasible but **no queued ticket derives a chainable base**, the round still runs and the planner is told `CHAIN_MODE: off` (the mode states what the round can build, not what was asked) — the log says the mode was downgraded, with the cause. |
| `SANDCASTLE_DRYRUN` | off | `1`/`true` → on. Prints the resolved wiring (profile, per-role model/effort/env with tokens masked, base-branch checks, chain state) and exits. Launches nothing. Renders the **same chain verdict as a live run** — the startup refusal fires here too, the chain report names the derivable bases that would not chain (the live per-ticket warnings), and `plannerMode` states the mode the planner would receive over tonight's queue (the **effective** mode, downgrades included — not the requested one). |
| `SANDCASTLE_ONLY` | unset | A comma list of positive issue numbers to restrict the round to (e.g. `42` or `42,43`). The planner is told the allow-list, and `main.ts` **enforces** it on the result — issues outside the list are dropped even if the planner proposed them. If none match, the round stops. |
| `SANDCASTLE_FORCE` | off | `1`/`true` → on. **Requires `SANDCASTLE_ONLY`** (config throws otherwise). Tells the planner to re-propose the `ONLY` issues even if they already have an open MR or appear resolved — a deliberate re-run. |

### Project identity (`ProjectConfig`, in `config.ts`)

Edit `DEFAULT_PROJECT_CONFIG` to describe *your* repo.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `providers` | `ProviderTable` | see below | Named providers — the `{model, baseUrl, tokenKey, effort}` quadruplets. |
| `profiles` | `Profiles` | see below | Per-profile role → provider bindings. |
| `mergeStrategy` | `'agent' \| 'human'` | `'human'` | Who merges. `human` = Draft MRs await review (v0.1). `agent` = a Merger auto-merges (fenced). |
| `commitStyle` | `'ralph' \| 'conventional'` | `'conventional'` | MR title style. `conventional` keeps titles valid Conventional Commit headers. |
| `gitHost` | `'gh' \| 'glab' \| 'local'` | `'gh'` | Host integration (`gh` = GitHub, `glab` = GitLab). Both are wired in v0.1 — see `host.ts`. `'local'` is token-exempt but **fenced** — see [v0.1 scope](#v01-scope). |
| `baseBranch` | `string` | `'main'` | The project trunk. A live run fast-forwards each base to `origin` before agents fork, so a round never builds on stale code; a base curated locally ahead of origin is kept as-is (#14). |
| `labelBases` | `Record<string,string>` | `{}` | Issue label → base branch. Empty ⇒ every issue forks from `baseBranch`. |
| `queueLabels` | `string[]` | `['sandcastle', 'ready-for-agent']` | Queue trigger labels — an open issue carrying ANY of these is candidate work. Default accepts both so the Factory (`sandcastle`) and captable (`ready-for-agent`) queue with no relabelling; narrow per consumer (#15). |
| `chainableBases` | `string[]` | `[]` | Bases eligible for Chained mode. Must name at least one base the round's tickets can derive (a `labelBases` value, or `baseBranch`) when `SANDCASTLE_CHAIN=1` — otherwise the run **refuses at startup**, naming both `labelBases` and `chainableBases`. A ticket whose derived base is not listed still runs, **unchained, with a per-ticket warning** in the log. |
| `hooks` | `SandboxHooks` | `{}` | Sandbox lifecycle hooks (install / `sandbox-setup`). The Factory ships none — the toolchain is repo-specific; a consumer sets one here instead of editing `main.ts` (#19). |
| `copyToWorktree` | `string[]` | `['node_modules']` | Paths copied from the host worktree into each sandbox. A pnpm repo sets `[]` — pnpm rejects a host-copied `node_modules` (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, #19). |
| `assignee` | `string \| null` | `'@me'` | Host assignee. gh accepts `@me`; a GitLab consumer gives a real username (glab wants one). `null` ⇒ leave the MR/PR unassigned. |
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

### Defaults (the self-hosted baseline — GitHub / human-merge)

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

A GitLab consumer flips `gitHost: 'glab'` and gives `assignee` a real username
(`@me` is gh-only); both host shapes ship in v0.1 — see `host.ts`. The ccsnoop
shape adds agent-merge: `mergeStrategy: 'agent'` plus a
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
  The mode **declares itself**: a run with no chainable base refuses at startup
  (before any agent) rather than silently building unchained, and a ticket whose
  base is outside `chainableBases` gets a per-ticket warning in the log — it runs
  unchained and will not see the stack. The planner is told the mode the round
  **can build** (`CHAIN_MODE` derives from the feasibility verdict crossed with
  the bases the queued tickets derive): asked-but-unbuildable reads `off`, the
  log states the downgrade — the relaxed `Blocked by:` rule never rests on a
  stack no branch will have. `SANDCASTLE_DRYRUN=1` returns the same verdict, not
  a more optimistic one. For turning it on, see
  [Enabling Chained mode](#enabling-chained-mode-step-by-step) below.

### Enabling Chained mode (step by step)

Chained is opt-in **twice**: a config field designates the bases that may carry a
stack, and the env var activates the mode for the run. Neither suffices alone —
the startup guard names both settings when one is missing.

**1. Designate a chainable base in `config.ts`.** A chainable base must be one the
round's tickets can derive — a `labelBases` value, or `baseBranch` itself. The
intended shape is a **per-effort staging branch**, not the trunk: the stack head
is picked by "most recent open MR", a rule that is safe on a private staging
branch and nowhere else — on the trunk it would adopt whatever unrelated MR
happens to be open (a colleague's, a bot's) as the next ticket's foundation.

```ts
// .sandcastle/config.ts — DEFAULT_PROJECT_CONFIG
labelBases:      { 'epic:rgaa': 'epic/rgaa-accessibilite' }, // the effort's issues carry the label
chainableBases:  ['epic/rgaa-accessibilite'],                 // …and that base may carry a stack
```

A flat repo (no `labelBases`) may chain on its trunk — `chainableBases: ['main']`
— accepting that any open MR against `main` becomes the stack head.

**2. Check the verdict with a dry run.** The startup refusal fires identically
here and in a live run — the dry run returns the *same* verdict, never a more
optimistic one:

```sh
SANDCASTLE_CHAIN=1 SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts
```

With no derivable base chainable, this exits non-zero naming both `labelBases`
and `chainableBases` — fix step 1. When feasible, the report's `chain` block
names the chainable bases, the derivable bases that will not chain
(`unchainableDerivableBases` — the live run's per-ticket warnings, visible before
any agent runs), per chainable base the stack as it stands (`wouldForkFrom`, the
MR list, any `rivals` — two MRs on the same base, the most recent won), and
`plannerMode`: the **effective** mode the planner would receive over tonight's
queue, downgrades included — feasible config whose queued tickets all derive
unchainable bases reads `off`, not `on`.

**3. Run.**

```sh
SANDCASTLE_CHAIN=1 npx tsx .sandcastle/main.ts
```

One issue per round (`SANDCASTLE_MAX_PARALLEL` is forced to `1`): the first
ticket of a wave forks from the chainable base as usual and opens the stack's
root MR against it; every subsequent round forks from — and targets — the head of
that stack. The log narrates the walk (`no open MR on … — starting a new stack`,
`N unmerged MR(s) stacked on …`, `forking from and targeting …`). A ticket whose
derived base is outside `chainableBases` still runs — unchained, with the
per-ticket warning: the startup guard proved the round *can* chain, not that
every ticket does.

**4. Review bottom-up.** A stack is only as healthy as its lowest unmerged MR:
merge from the root up (merging the head first would drag the root's commits in
under the wrong name), expect the host to retarget the MR above when a merge
deletes the source branch (a kept branch means retargeting by hand), and know
that a rejected ticket poisons everything stacked above it. That trade —
merge-order freedom for the ability to keep going — is the mode's whole point.

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
GH_TOKEN=...        # gitHost: 'gh' (default)
GITLAB_TOKEN=...    # gitHost: 'glab'
# 'local' needs no host token — but it is fenced in v0.1 (see v0.1 scope).
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
via `host.ts`. The GitHub shape is the default (the Factory's own host — where its
self-hosted loop runs); a GitLab project flips `gitHost: 'glab'` in `config.ts`.

**Fenced with a loud, early guard** (it throws at startup, not silently no-op):

| Capability | Guard | Status |
|---|---|---|
| `mergeStrategy: 'agent'` (the auto-merging Merger role) | `main.ts` throws if `mergeStrategy !== 'human'` | Follow-up module. |
| `gitHost: 'local'` (no tracker, no host CLI) | `main.ts` throws if `gitHost` is neither `'gh'` nor `'glab'` | Token-exempt already (the token layer knows `'local'`); the no-tracker loop is a follow-up. |

`gitHost: 'gh'` is **no longer fenced** — the GitHub host landed in `host.ts`, and the
loop warns at startup when `gitHost` disagrees with the `origin` remote's host.
`SANDCASTLE_PROFILE=opus` is **not fenced**; it works but is not specially tested (see
[Modes](#modes)).

## Developing

```sh
npm test          # every .sandcastle/*.test.ts, one process per file via test-harness.ts
npm run typecheck # tsc --noEmit over .sandcastle/
npm run skills:check  # verify .claude/skills/ against skills-lock.json
npm run image:check   # verify .sandcastle/Dockerfile.base against the universal-runtime contract
SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts   # config smoke: print the resolved wiring, launch nothing
```

A new `*.test.ts` must be added to the `test` script in `package.json` — the
script is an explicit per-file list, not a glob. Every `.sandcastle/*.ts` change
must keep the config smoke green — it is the cheapest end-to-end read of the
config surface.

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
