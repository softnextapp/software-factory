// Contract validator for the Factory's runtime base image recipe (`.sandcastle/Dockerfile.base`).
//
// The base is the universal Sandcastle runtime — Node + system deps + the `agent` user
// aligned to the host UID/GID + the pinned Claude Code CLI — and the layer every consumer
// image is built `FROM`. It must NOT carry any project-specific dependency (a host CLI,
// Playwright, PHP, PostgreSQL, …): those belong in the consumer's project Dockerfile. See
// GitHub issue #1 and the README "Sandbox image" section for the two-layer model; this
// module only pins its contract so the recipe cannot drift either way. It is the drift guard
// behind `npm run image:check` — the base-image analogue of `npm run skills:check`.
//
// Pure: takes the recipe contents as a string, returns a result. No fs inside the validator.
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ValidationResult = { ok: boolean; problems: string[] };

type Check = { pass: (contents: string) => boolean; msg: string };

// The universal-runtime structure. Each entry is one acceptance criterion from issue #1;
// a missing element pushes its message into `problems`.
const REQUIRED: Check[] = [
  {
    pass: (c) => /^FROM\s+node:22-bookworm\s*$/m.test(c),
    msg: 'base image must be FROM node:22-bookworm (the universal Sandcastle runtime)',
  },
  {
    pass: (c) => ['git', 'curl', 'jq'].every((d) => new RegExp('\\b' + d + '\\b').test(c)),
    msg: 'must install the system deps git, curl, jq',
  },
  {
    pass: (c) => /^ARG\s+AGENT_UID\b/m.test(c),
    msg: 'must declare ARG AGENT_UID (host-UID alignment for the Engine pre-flight check)',
  },
  {
    pass: (c) => /^ARG\s+AGENT_GID\b/m.test(c),
    msg: 'must declare ARG AGENT_GID (host-GID alignment)',
  },
  {
    pass: (c) => /\bgroupmod\b/.test(c) && /\$AGENT_GID/.test(c) && /-n\s+agent\b/.test(c),
    msg: 'must rename group node→agent aligned to $AGENT_GID (groupmod -n agent)',
  },
  {
    pass: (c) => /\busermod\b/.test(c) && /\$AGENT_UID/.test(c) && /-l\s+agent\b/.test(c),
    msg: 'must rename user node→agent aligned to $AGENT_UID (usermod -l agent)',
  },
  {
    pass: (c) => /claude\.ai\/install\.sh.*?\d+\.\d+\.\d+/.test(c),
    msg: 'must install the Claude Code CLI pinned to a specific version',
  },
  {
    pass: (c) => /^WORKDIR\s+\/home\/agent\s*$/m.test(c),
    msg: 'must set WORKDIR /home/agent',
  },
  {
    pass: (c) => /^ENTRYPOINT\s+\["sleep",\s*"infinity"\]\s*$/m.test(c),
    msg: 'must set ENTRYPOINT ["sleep", "infinity"]',
  },
];

// Project-specific deps that must NOT appear in the universal base — the real leakers
// observed across the four source instances (ccsnoop, omniris/{api, back-office,
// design-system}), each of which belongs in that project's own Dockerfile. The host CLIs
// (gh, glab) are here too: which tracker a project uses is project context (ADR-0003), and
// the v0.1 loop runs glab host-side anyway, so neither belongs in the runtime base.
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /\bgh\b/i, label: 'gh' },
  { re: /\bglab/i, label: 'glab' },
  { re: /\bplaywright/i, label: 'playwright' },
  { re: /\bchromium/i, label: 'chromium' },
  { re: /\bphp/i, label: 'php' },
  { re: /\bcomposer/i, label: 'composer' },
  { re: /postgres/i, label: 'postgres' }, // matches postgres + postgresql
  { re: /http-server/i, label: 'http-server' },
  { re: /\bcorepack/i, label: 'corepack' },
];

/** Drop full-line comments so the contract is checked against instructions, not prose.
 * (Lets the recipe document why a dep is absent — "No host CLI (glab/gh) here …" — without
 * tripping its own forbidden-token guard. Inline `#` inside a RUN is not a Dockerfile
 * comment and is preserved.) */
function stripComments(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Validate a Dockerfile.base recipe against the universal-runtime contract. */
export function validateDockerfileBase(contents: string): ValidationResult {
  const recipe = stripComments(contents);
  const problems: string[] = [];
  for (const c of REQUIRED) {
    if (!c.pass(recipe)) problems.push(c.msg);
  }
  for (const f of FORBIDDEN) {
    if (f.re.test(recipe)) {
      problems.push(
        `project-specific dependency '${f.label}' must not be in the universal base — it belongs in the consumer's project Dockerfile`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// CLI — `npm run image:check`: verify the shipped recipe has not drifted.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const DOCKERFILE_BASE = join(ROOT, '.sandcastle', 'Dockerfile.base');

function main(): void {
  if (!existsSync(DOCKERFILE_BASE)) {
    console.error(`No base image recipe at ${relative(ROOT, DOCKERFILE_BASE)}.`);
    process.exit(1);
  }
  const result = validateDockerfileBase(readFileSync(DOCKERFILE_BASE, 'utf8'));
  if (result.ok) {
    console.log(`dockerfile-base OK — ${relative(ROOT, DOCKERFILE_BASE)} is the universal Sandcastle runtime.`);
    return;
  }
  console.error(`${relative(ROOT, DOCKERFILE_BASE)} drifted from the universal-runtime contract:`);
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Run only when invoked directly, not when imported by the test suite.
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
