// Sandbox-image pre-flight (issue #16).
//
// The sandbox is a container the Engine starts per agent. Its image is two
// layers, and the Factory ships only the first as a recipe (see README §Sandbox
// image; ADR-0003 — project context stays in the consumer):
//
//   1. sandcastle-base:latest — universal runtime (Node + git/curl/jq + Claude
//      Code), built from the Factory-shipped .sandcastle/Dockerfile.base. You
//      build it once per host; it is NOT on a registry.
//   2. sandcastle:<repo>      — the consumer's project layer (.sandcastle/Dockerfile):
//      FROM sandcastle-base, this project's build/test deps + its host CLI, and
//      ENTRYPOINT ["sleep","infinity"].
//
// When layer 2 hasn't been built, the Engine throws a raw WorktreeError mid-loop
// (`Image 'sandcastle:captable-manager' not found locally`) — a stack trace, not
// guidance. This module is the PURE half of a startup pre-flight that catches
// that BEFORE any agent burns tokens and turns it into an actionable message.
//
// The docker IO (docker info / docker image inspect) lives in main.ts; this
// module owns only the host-agnostic, side-effect-free pieces, so they are
// unit-tested here with no docker and no network — the same split as chain.ts.
import type { GitHost } from './config.ts';
import { HOST_TERMS } from './host.ts';

/** The build command the project-layer Dockerfile is built with. */
const BUILD_CMD = 'npx @ai-hero/sandcastle docker build-image';

/** The sandbox image tag the Engine derives from a repo directory, mirrored here. */
export function sandboxImageName(cwd: string): string {
  // The Engine derives the tag from the repo directory's basename, lowercased
  // (README §Sandbox image: `sandcastle:<lowercased-repo-basename>`). Mirror that
  // derivation so the name we probe is exactly the name the loop will ask docker
  // for. The Factory launches from the repo root, so process.cwd() is that dir.
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? '';
  return `sandcastle:${base.toLowerCase()}`;
}

/** Outcome of probing the local docker for the sandbox image. */
export type SandboxImageStatus = 'built' | 'missing' | 'daemon-down';

/**
 * The 3-way decision main.ts composes with its two docker probes
 * (`docker info` → daemonUp; `docker image inspect` → imageExists).
 *
 * The guard is the reason this is a function and not an `&&`: when the daemon is
 * unreachable, `imageExists` is UNKNOWABLE — a dead daemon makes `docker image
 * inspect` fail for every image, so a naive `!imageExists` would cry "missing"
 * when the real problem is docker itself. So daemon-down wins outright and lets
 * the loop fail later with docker's own daemon error instead of a misleading
 * "build the image" prompt.
 */
export function decideImageStatus(probes: {
  daemonUp: boolean;
  imageExists: boolean;
}): SandboxImageStatus {
  if (!probes.daemonUp) return 'daemon-down';
  return probes.imageExists ? 'built' : 'missing';
}

/** One-line status for the dry-run report. */
export function describeImageStatus(imageName: string, status: SandboxImageStatus): string {
  switch (status) {
    case 'built':
      return `${imageName} (built)`;
    case 'missing':
      return `${imageName} (MISSING — build with: ${BUILD_CMD})`;
    case 'daemon-down':
      return `${imageName} (docker daemon unreachable — cannot check)`;
  }
}

/**
 * The actionable error raised when the sandbox image is missing. Names the
 * image, frames the two-layer model with the base as a prerequisite, gives the
 * two build steps (write .sandcastle/Dockerfile; run the build command), and
 * ends with a prompt ready to paste into Claude Code. This message is the
 * deliverable of issue #16 — an operator must be able to act on it without
 * reading source. The host CLI comes from HOST_TERMS (ADR-0004: one place owns
 * the gh/glab vocabulary, not a second switch here).
 */
export function buildMissingImageMessage(imageName: string, gitHost: GitHost): string {
  const hostCli = HOST_TERMS[gitHost].cli;
  return [
    `Sandbox image \`${imageName}\` is not built — the Factory will not start an agent until it exists.`,
    '',
    'The sandbox image is two layers. The Factory ships the base *recipe*',
    '(.sandcastle/Dockerfile.base); neither image is on a registry, so you build both locally.',
    '',
    'Prerequisite — the universal base (built once per host). If `docker image inspect',
    'sandcastle-base:latest` is missing:',
    '  docker build -t sandcastle-base:latest \\',
    '    --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) - < .sandcastle/Dockerfile.base',
    '',
    'Then the two build steps for this project:',
    '  1. Write .sandcastle/Dockerfile:',
    '       FROM sandcastle-base:latest',
    `       RUN <this project's build/test deps, including the \`${hostCli}\` host CLI>`,
    '       ENTRYPOINT ["sleep","infinity"]',
    `  2. Build the image:  ${BUILD_CMD}`,
    '',
    'Or paste this into Claude Code to do all of it:',
    '',
    '---',
    `Build the missing Software Factory sandbox image \`${imageName}\`.`,
    '1. Check the universal base: run `docker image inspect sandcastle-base:latest`; if it is missing, build it with `docker build -t sandcastle-base:latest --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) - < .sandcastle/Dockerfile.base`.',
    `2. Read package.json to see how this project installs and tests, then write \`.sandcastle/Dockerfile\`: \`FROM sandcastle-base:latest\`, a \`RUN\` line with the build/test dependencies (include the \`${hostCli}\` CLI if the base lacks it), and \`ENTRYPOINT ["sleep","infinity"]\`.`,
    `3. Build the sandbox image: \`${BUILD_CMD}\`.`,
    '4. Re-run the Factory.',
    '---',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Image CAPABILITY pre-flight (issue #53).
//
// `decideReportReadiness` (report.ts, issue #47) says before a half-hour sandbox
// is spent whether a phase can reach a publishable instance. It judges
// environment KEYS. Nothing said the same about what the sandbox IMAGE carries —
// and that premise went stale in a consumer without a sound: its project layer
// asserted "stdlib only, therefore no pip" (true the day it was written, when
// the sandbox ran nothing but a Python gate), then a report phase mounted a
// skill that imports a third-party module. The run published a report with none
// of its audio and the operator learned at the end.
//
// A premise a build depends on has to be asserted mechanically, not written in
// prose. This half owns the MECHANICS of asking an image what it carries; the
// verdict is folded into ReportReadiness by report.ts, because the consequence
// belongs to the phase that declared the need — the phase is skipped, never
// fatal. The docker IO is main.ts's, as with every other probe here.
//
// Why probe the built image and not the Dockerfile: a recipe check is cheaper
// and belongs in the consumer, but it is structurally blind to the failure that
// remains once the recipe is fixed — the recipe is right, the TAGGED image is
// stale, the gate is green, and the run fails anyway. Only the image sees that.
// ---------------------------------------------------------------------------

/** How a declared capability is looked for inside the image. */
export type ToolProbeKind = 'command' | 'python-module';

/** A capability a phase declares its sandbox must carry, parsed and validated. */
export interface ToolRequirement {
  readonly kind: ToolProbeKind;
  /** What to look for, exactly as declared after the prefix. */
  readonly name: string;
  /** The whole declaration, so every message and probe line quotes what the
   *  operator actually wrote rather than a reconstruction of it. */
  readonly raw: string;
}

/**
 * The declaration prefixes. A prefix is a PROBE KIND, not a meaning: it says how
 * to look, never what the tool does (ADR-0003 — the Factory does not learn that
 * `edge_tts` synthesises speech). This is why the declaration is not a bare name:
 * a bare name is not probeable, and guessing between `command -v` and an import
 * is the kind of silent default that produced this issue.
 */
const TOOL_PREFIXES: ReadonlyArray<readonly [string, ToolProbeKind]> = [
  ['cmd:', 'command'],
  ['py:', 'python-module'],
];

/**
 * Plain identifiers only.
 *
 * Two reasons, and the second is the one that matters. It keeps a typo from
 * becoming a mysterious `no`; and it is what makes the probe script safe to
 * BUILD AS A STRING — no quote, space, `;`, `$` or backtick can reach the shell
 * inside the container. A name that fails this is reported as malformed, never
 * interpolated (issue #53, acceptance 3).
 */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** What a declaration list parses to: what can be probed, and what cannot. */
export interface ParsedToolRequirements {
  readonly ok: readonly ToolRequirement[];
  /** Declarations that carry no known prefix, or a name that is not a plain
   *  identifier. Returned rather than dropped: a requirement nobody can probe is
   *  an absence, and an absence is never mute. */
  readonly malformed: readonly string[];
}

export function parseToolRequirements(declared: readonly string[]): ParsedToolRequirements {
  const ok: ToolRequirement[] = [];
  const malformed: string[] = [];
  for (const raw of declared) {
    const match = TOOL_PREFIXES.find(([prefix]) => raw.startsWith(prefix));
    if (match === undefined) {
      malformed.push(raw);
      continue;
    }
    const [prefix, kind] = match;
    const name = raw.slice(prefix.length);
    if (!TOOL_NAME.test(name)) {
      malformed.push(raw);
      continue;
    }
    ok.push({ kind, name, raw });
  }
  return { ok, malformed };
}

/**
 * The shell script that probes one image for every requirement, in one container.
 *
 * One line of output per requirement, `ok <raw>` or `no <raw>`, so the parse is
 * positional-free: a requirement that somehow produces nothing reads as ABSENT
 * rather than as passing, which is the direction an unknown should fall.
 *
 * `python3` is the interpreter a `py:` requirement is judged against, because it
 * is the one the base image and every consumer layer install under that name. A
 * module importable only by some other interpreter is not importable by the code
 * that will run in here, which is the whole question being asked.
 */
export function toolProbeScript(required: readonly ToolRequirement[]): string {
  return required
    .map((req) => {
      const test =
        req.kind === 'command'
          ? `command -v ${req.name} >/dev/null 2>&1`
          : `python3 -c 'import ${req.name}' >/dev/null 2>&1`;
      return `if ${test}; then echo 'ok ${req.raw}'; else echo 'no ${req.raw}'; fi`;
    })
    .join('\n');
}

/**
 * The `docker` argv that runs that script in a throwaway container.
 *
 * `--entrypoint sh` is not decoration and its absence costs a hung round: the
 * consumer's project layer re-declares `ENTRYPOINT ["sleep","infinity"]` (the
 * Engine needs a container that stays alive), so `docker run <image> sh -c …`
 * runs `sleep infinity sh -c …` and never returns. The probe would then hang
 * exactly where it exists to save time.
 *
 * `--network none` because no probe here has any business reaching the network:
 * an import is a local question, and a probe that can dial out could pass for a
 * reason the run will not reproduce.
 */
export function toolProbeArgv(imageName: string, script: string): readonly string[] {
  return ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', imageName, '-c', script];
}

/**
 * Read the probe's stdout back into a verdict per declaration.
 *
 * Unknown lines are ignored (a shell may warn) and a requirement with no line at
 * all is simply absent from the map — callers treat "not present" as unproven,
 * never as satisfied.
 */
export function parseToolProbeOutput(stdout: string): Readonly<Record<string, boolean>> {
  const probes: Record<string, boolean> = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('ok ')) probes[trimmed.slice(3)] = true;
    else if (trimmed.startsWith('no ')) probes[trimmed.slice(3)] = false;
  }
  return probes;
}

/**
 * One line for the dry-run report.
 *
 * An empty declaration is STATED here rather than folded into the phase's
 * verdict. The distinction is deliberate: a phase that needs no third-party tool
 * is not in trouble, so degrading its live-run verdict every round would cry
 * wolf — but the operator asking a dry run what is checked deserves to be told
 * that the image is not being asked anything.
 */
export function describeToolProbe(
  imageName: string,
  declared: readonly string[],
  probes: Readonly<Record<string, boolean>> | null,
): string {
  if (declared.length === 0) {
    return 'no capability declared (`report.requiredTools`) — the image is not probed';
  }
  const { ok, malformed } = parseToolRequirements(declared);
  if (probes === null) {
    return `${declared.join(', ')} (cannot probe ${imageName} — docker unreachable or image not built)`;
  }
  const parts = ok.map((req) => `${req.raw} ${probes[req.raw] === true ? '✓' : 'ABSENT'}`);
  for (const bad of malformed) parts.push(`${bad} MALFORMED`);
  return `${parts.join(', ')} (in ${imageName})`;
}
