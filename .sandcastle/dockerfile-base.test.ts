// Contract tests for the Factory's runtime base image recipe (.sandcastle/Dockerfile.base).
// Pure: reads one committed static file + feeds synthetic strings to the validator — no
// network, no secrets, no process.env. Run: npx tsx .sandcastle/dockerfile-base.test.ts
//
// The base image is the universal Sandcastle runtime (see GitHub issue #1): Node + system
// deps + the agent user aligned to the host UID/GID + the Claude Code CLI. It must NOT
// carry any project-specific dependency (Playwright, PHP, PostgreSQL, glab, …) — those
// belong in the consumer's project Dockerfile (FROM <this base>). These tests pin both
// halves of that contract so the recipe cannot silently drift either way.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { validateDockerfileBase } from './dockerfile-base.ts';

import { test, finish } from './test-harness.ts';

/** The shipped recipe under test (repo root is process.cwd() under `npm test`). */
const RECIPE_PATH = join(process.cwd(), '.sandcastle', 'Dockerfile.base');

/**
 * A minimal base that satisfies every required check. Used as the substrate for the
 * mutation cases below — each mutation breaks exactly one rule, proving the validator
 * catches that rule in isolation.
 */
function valid(): string {
  return [
    'FROM node:22-bookworm',
    'RUN apt-get update && apt-get install -y \\',
    '  git \\',
    '  curl \\',
    '  jq \\',
    '  && rm -rf /var/lib/apt/lists/*',
    'ARG AGENT_UID=1000',
    'ARG AGENT_GID=1000',
    'RUN groupmod -o -g $AGENT_GID -n agent node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node',
    'USER ${AGENT_UID}:${AGENT_GID}',
    'RUN curl -fsSL https://claude.ai/install.sh | bash -s -- 2.1.195',
    'ENV PATH="/home/agent/.local/bin:$PATH"',
    'WORKDIR /home/agent',
    'ENTRYPOINT ["sleep", "infinity"]',
    '',
  ].join('\n');
}

/** Assert `contents` is invalid, and at least one problem mentions every `needles`. */
function invalid(contents: string, ...needles: string[]): void {
  const r = validateDockerfileBase(contents);
  assert.equal(r.ok, false, 'expected the recipe to be INVALID');
  for (const n of needles) {
    assert.ok(
      r.problems.some((p) => p.includes(n)),
      `expected a problem mentioning '${n}', got: ${JSON.stringify(r.problems)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The shipped recipe — the real .sandcastle/Dockerfile.base
// ---------------------------------------------------------------------------

test('the shipped .sandcastle/Dockerfile.base exists and satisfies the universal-runtime contract', () => {
  assert.ok(existsSync(RECIPE_PATH), `${RECIPE_PATH} should be committed with the Factory`);
  const r = validateDockerfileBase(readFileSync(RECIPE_PATH, 'utf8'));
  assert.equal(r.ok, true, `shipped recipe is invalid: ${JSON.stringify(r.problems)}`);
  assert.deepEqual(r.problems, []);
});

// ---------------------------------------------------------------------------
// A conformant base validates; the validator is not just a rubber stamp
// ---------------------------------------------------------------------------

test('a minimal conformant base validates (ok, no problems)', () => {
  const r = validateDockerfileBase(valid());
  assert.equal(r.ok, true, `unexpected problems: ${JSON.stringify(r.problems)}`);
});

// ---------------------------------------------------------------------------
// Required — universal runtime structure (each mutation breaks one rule)
// ---------------------------------------------------------------------------

test('base image must be FROM node:22-bookworm (rejects node:20)', () => {
  invalid(valid().replace('node:22-bookworm', 'node:20-bookworm'), 'node:22-bookworm');
});

test('must install the git/curl/jq system deps (rejects a missing dep)', () => {
  invalid(valid().replace(/^  jq \\\n/m, ''), 'system deps');
});

test('must declare ARG AGENT_UID (host-UID alignment for the Engine pre-flight check)', () => {
  invalid(valid().replace(/^ARG AGENT_UID=1000\n/m, ''), 'AGENT_UID');
});

test('must declare ARG AGENT_GID (host-GID alignment)', () => {
  invalid(valid().replace(/^ARG AGENT_GID=1000\n/m, ''), 'AGENT_GID');
});

test('must align the group via groupmod -n agent $AGENT_GID', () => {
  invalid(valid().replace('groupmod -o -g $AGENT_GID -n agent node && ', ''), 'groupmod');
});

test('must rename the user via usermod -l agent $AGENT_UID', () => {
  invalid(valid().replace(' && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node', ''), 'usermod');
});

test('must install the Claude Code CLI pinned to a version (rejects unpinned)', () => {
  invalid(valid().replace('| bash -s -- 2.1.195', '| bash'), 'Claude Code CLI');
});

test('must set WORKDIR /home/agent', () => {
  invalid(valid().replace(/^WORKDIR \/home\/agent\n/m, ''), 'WORKDIR');
});

test('must set ENTRYPOINT ["sleep","infinity"]', () => {
  invalid(valid().replace(/^ENTRYPOINT.*\n/m, ''), 'ENTRYPOINT');
});

// ---------------------------------------------------------------------------
// Required — no project-specific dependency leaks (stays the universal runtime)
// ---------------------------------------------------------------------------

test('rejects Playwright (project test dep — belongs in the project Dockerfile)', () => {
  invalid(valid() + 'RUN npx playwright install --with-deps chromium\n', 'playwright');
});

test('rejects PHP (project runtime)', () => {
  invalid(valid() + 'RUN apt-get install -y php\n', 'php');
});

test('rejects PostgreSQL (project service)', () => {
  invalid(valid() + 'RUN apt-get install -y postgresql-17\n', 'postgres');
});

test('rejects gh (host/tracker CLI is project context — the base is host-agnostic)', () => {
  invalid(valid() + 'RUN apt-get install -y gh\n', 'gh');
});

test('rejects glab (host/tracker CLI is project context — the base is host-agnostic)', () => {
  invalid(valid() + 'RUN dpkg -i glab_1.107.0_linux_amd64.deb\n', 'glab');
});

test('rejects corepack (package-manager shim is a project-layer concern)', () => {
  invalid(valid() + 'RUN corepack enable\n', 'corepack');
});

test('reports each leak separately when several are present', () => {
  const r = validateDockerfileBase(valid() + 'RUN apt-get install -y php\nRUN corepack enable\n');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('php')), JSON.stringify(r.problems));
  assert.ok(r.problems.some((p) => p.includes('corepack')), JSON.stringify(r.problems));
});

test('a forbidden token in a comment is not a leak (the validator reads instructions, not prose)', () => {
  // A recipe may document WHY a dep is absent — "No host CLI (glab/gh) here" — without that
  // prose tripping its own guard. Only instructions count.
  const r = validateDockerfileBase(valid() + '# We deliberately install neither glab nor gh here.\n');
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test('an empty recipe is invalid', () => {
  const r = validateDockerfileBase('');
  assert.equal(r.ok, false);
  assert.ok(r.problems.length > 0);
});

finish();
