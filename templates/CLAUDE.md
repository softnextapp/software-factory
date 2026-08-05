# CLAUDE.md — <project name>

> This is the project-context skeleton the Factory ships. The implement and review
> agents load `@CLAUDE.md` as the authority for everything below — the build/test
> gate, the coding standards, the extra suites, the commit style, and the domain
> specs. A Sandcastle loop run here cannot do useful work until these sections
> describe *this* repo. Fill them in after cloning — the Factory boundary keeps
> project context in the consumer, never in the Factory itself (ADR-0003).
>
> Delete any section that does not apply, but do not leave a placeholder in place of
> a real instruction — the agents read everything here literally.

## Build / test gate

The exact commands the implementer must run to prove a change, **in order**. This is
what the review prompt calls "the gate." The implementer runs it after every change;
the reviewer re-runs it before committing. A change whose gate is not green does not
survive review.

```sh
# lint
# typecheck
# tests
# build (if this repo produces an artifact)
```

State the real commands — e.g. `npm run lint`, `npm run typecheck -- -p tsconfig.json`,
`npm test`, `npm run build`. If the formatter must run first (so formatting alone does
not fail the gate), say so here.

## Extra suites

Suites the gate keeps **separate** — accessibility, e2e, integration, anything that
runs against a running server or a browser. The implementer and reviewer run these
*only* when the change is in the area one covers, but they must run them exactly as
described here, never collapsed onto one line.

For each suite: the command, what it covers, and the setup it needs (a dev server on
a port, a database, a fixture). If there is none, write "None" and delete the rest.

- **Accessibility** — `<command>`. Covers: `<what>`.
- **E2E** — `<command>`. Covers: `<what>`. Needs: `<a server on :3000, seeded data>`.

## Coding standards

The rules most often broken in this repo, written down so a fresh agent does not have
to guess. Keep it short and concrete — the contract rules, the smell baseline this
repo endorses or suppresses, naming conventions, where state lives and where it must
not. Point at the file if a `CODING_STANDARDS.md` or `CONTRIBUTING.md` already holds
this.

- <rule, with the file/area it binds>

The two-axis code review always carries a fixed Fowler smell baseline on its Standards
axis; a rule documented here **overrides** that baseline where they disagree.

## Commit conventions

How commits in this repo are written. The Factory's prompts branch on
`{{COMMIT_STYLE}}` (`ralph` → `RALPH:`-prefixed subjects, `conventional` →
`type(scope): …`), which `config.ts` (`commitStyle`) drives. If this repo enforces
Conventional Commits through a `commit-msg` hook (commitlint), say so here — the
agents must not use `--no-verify` to get around it.

- Style in use: `<ralph | conventional>`
- Any scope rules, subject-length limits, or required trailers beyond the loop's own.

## Review lane

When the implementer finishes an issue it unlabels it `sandcastle` (removing it from
the queue). If this project uses a **review-lane label** to route work for human
review, name it here so the implementer applies it on close. If there is none, write
"None" and the implementer will only unlabel `sandcastle`.

- Review-lane label: `<e.g. Status::Review, or None>`

## Release tooling

Anything the release automation owns that an agent must **not** edit unless the issue
asks: `CHANGELOG.md`, the `version` field of `package.json`, a `RELEASES.md`, lockfile
versions. Name the tool if there is one (semantic-release, changesets).

- Owned by release tooling (do not touch): `<files>`
- Release tool: `<semantic-release | changesets | none>`

## Domain context

Where this project's domain knowledge lives — a `CONTEXT.md` glossary, specs under
`docs/`, a PRD. The implementer reads the spec an issue references before touching
code; point it at the right place. The glossary's shape is described in the
domain-modeling skill (`.claude/skills/engineering/domain-modeling/CONTEXT-FORMAT.md`).

- Glossary: `<CONTEXT.md at root, or where>`
- Specs: `<docs/specs/, or where>`
