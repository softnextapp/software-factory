# CLAUDE.md — Software Factory

> The Factory's **own project context** — the self-hosting layer for the loop this
> repo runs on its own issues (github.com/softnextapp/software-factory). A consumer
> rewriting this file starts from `templates/CLAUDE.md`; this copy describes THIS
> repo and nothing else.

## Build / test gate

The exact commands, in order. The implementer runs them after every change; the
reviewer re-runs them before committing. A change whose gate is not green does not
survive review.

```sh
npm test             # contract tests — one process per *.test.ts via test-harness.ts
npm run typecheck    # tsc --noEmit over .sandcastle/
npm run skills:check # .claude/skills/ matches skills-lock.json
npm run image:check  # Dockerfile.base matches the universal-runtime contract
SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts   # the modified config's wiring; launches nothing
```

The last line is the **config smoke**: it loads the changed `.sandcastle/` and
prints the resolved wiring (profile, token sources, base branches, sandbox image).
Every `.sandcastle/*.ts` change must keep it green — it is the cheapest end-to-end
read of the config surface this repo ships.

## Extra suites

None. The contract tests are pure by construction (see standards below); there is
no integration/e2e suite in this repo. Live E2E of a Factory change (adopt into a
real consumer, run a round) happens at human-review time — see the review lane.

## Coding standards

- **Config-only boundary** ([ADR-0001](docs/adr/0001-factory-scope-config-only.md)):
  `.sandcastle/*.ts` contains no Engine code; the Engine stays the pinned
  `@ai-hero/sandcastle` dependency. Never vendor or fork Engine internals.
- **Project context stays in the consumer**
  ([ADR-0003](docs/adr/0003-factory-boundary.md)): nothing project-specific enters
  the Factory beyond the `templates/` skeletons and this file.
- **Tests stay pure**: `node:assert/strict` under `tsx` — no network, no secrets,
  no `process.env` reads. Each `*.test.ts` runs as its own process via
  `.sandcastle/test-harness.ts`; a new test file must be added to the `test`
  script in `package.json`.
- **Language**: code, comments, README, ADRs and commit messages are English.
  Issue titles are French — quote them verbatim, never translate. One exception,
  and only one: **the body of an own skill under `skills/` is French** (it is read
  by an operator working in French); its test, its code comments and its commit
  message stay English. Role prompts (the `*-prompt.md` files in `.sandcastle/`)
  are not skills and stay English.
- The glossary in [CONTEXT.md](CONTEXT.md) is the naming authority (Factory vs
  Engine vs instance; Orchestration; roles; modes). Do not coin synonyms.

## Commit conventions

- Style: `conventional` (`type(scope): …`), driven by `commitStyle` in
  `.sandcastle/config.ts`; the PR title stays a valid Conventional Commit header.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`. The scope is the module
  touched — `adopt`, `host`, `worktree`, `config`, `chain`, `plan`, `image`,
  `skills`, `docs`.
- Last line of the commit body, as a trailer, so the loop can find its own
  commits: `Ralph: issue-#<N>`. Never omit it on an issue-driven change.
- No `--no-verify` (no commit-msg hook is enforced here anyway).

## Review lane

- Review-lane label: **None**. Taking an issue out of the queue (unlabelling
  `ready-for-agent`) is the whole close step; the draft PR carries the human review.
- **Adoption smoke** — for any change touching `adopt.ts`, the `main.ts`
  bootstrap, the ESM shim, or `host.ts`, re-run the consumer-shaped check before
  finishing (commit first; `git archive HEAD` ships only committed state):

  ```sh
  rm -rf /tmp/factory-smoke && git clone -q "$PWD" /tmp/factory-smoke
  npx tsx .sandcastle/adopt.ts /tmp/factory-smoke --force
  (cd /tmp/factory-smoke && SANDCASTLE_DRYRUN=1 npx tsx .sandcastle/main.ts)
  ```

- Deeper E2E (adopt into captable-manager, one `SANDCASTLE_ONLY` round) is the
  human's call at merge time — not the agent's.

## Release tooling

- `skills-lock.json` is regenerated only via `npm run skills:lock` — never
  hand-edited; `npm run skills:check` must stay green.
- No CHANGELOG, no `version` management, no semantic-release — nothing else is
  fenced.
