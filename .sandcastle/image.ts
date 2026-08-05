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
