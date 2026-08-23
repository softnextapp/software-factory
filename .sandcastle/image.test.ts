// Tests for the sandbox-image pre-flight (issue #16).
//
// image.ts owns only the PURE pieces: the image-name derivation (the Engine tags
// the sandbox as `sandcastle:<lowercased-repo-basename>`), the daemon-aware
// status decision (the false-positive guard), and the actionable error message.
// The docker IO itself (docker info / docker image inspect) stays in main.ts and
// is NOT unit-tested — same split as chain.ts (pure walk) vs main.ts (git IO).
//
// Pure: no network, no CLI, no process.env, no docker. Run: npx tsx .sandcastle/image.test.ts
import assert from 'node:assert/strict';
import {
  sandboxImageName,
  decideImageStatus,
  describeImageStatus,
  buildMissingImageMessage,
  parseToolRequirements,
  toolProbeScript,
  toolProbeArgv,
  parseToolProbeOutput,
  describeToolProbe,
} from './image.ts';
import { test, finish } from './test-harness.ts';

// --- sandboxImageName -------------------------------------------------------

test('sandboxImageName: lowercased repo basename (the captable-manager case)', () => {
  assert.equal(sandboxImageName('/home/chris/captable-manager'), 'sandcastle:captable-manager');
});

test('sandboxImageName: lowercases mixed-case directory names', () => {
  assert.equal(sandboxImageName('/dev/My-Cool-Repo'), 'sandcastle:my-cool-repo');
});

test('sandboxImageName: a trailing slash does not yield an empty segment', () => {
  assert.equal(sandboxImageName('/home/chris/repo/'), 'sandcastle:repo');
});

// --- decideImageStatus ------------------------------------------------------
// The 3-way decision main.ts composes with its two docker probes. The guard is
// the whole point: a dead daemon must NOT read as "image missing".

test('decideImageStatus: daemon down → daemon-down, even when the image is reported present', () => {
  // imageExists is unknowable when the daemon is unreachable; the guard must win.
  assert.equal(decideImageStatus({ daemonUp: false, imageExists: true }), 'daemon-down');
  assert.equal(decideImageStatus({ daemonUp: false, imageExists: false }), 'daemon-down');
});

test('decideImageStatus: daemon up + image present → built', () => {
  assert.equal(decideImageStatus({ daemonUp: true, imageExists: true }), 'built');
});

test('decideImageStatus: daemon up + image absent → missing', () => {
  assert.equal(decideImageStatus({ daemonUp: true, imageExists: false }), 'missing');
});

// --- describeImageStatus ----------------------------------------------------

test('describeImageStatus: built names the image', () => {
  assert.equal(describeImageStatus('sandcastle:captable-manager', 'built'), 'sandcastle:captable-manager (built)');
});

test('describeImageStatus: missing names the image, flags MISSING, and points at the build command', () => {
  const s = describeImageStatus('sandcastle:captable-manager', 'missing');
  assert.ok(s.includes('sandcastle:captable-manager'));
  assert.ok(s.includes('MISSING'));
  assert.ok(s.includes('npx @ai-hero/sandcastle docker build-image'));
});

test('describeImageStatus: daemon-down names the image and says docker could not be reached', () => {
  const s = describeImageStatus('sandcastle:captable-manager', 'daemon-down');
  assert.ok(s.includes('sandcastle:captable-manager'));
  assert.ok(s.toLowerCase().includes('docker'));
});

// --- buildMissingImageMessage ----------------------------------------------
// This message IS the deliverable (issue #16): the operator must be able to act
// on it — or paste the embedded prompt into Claude Code — without reading code.

test('buildMissingImageMessage: names the missing image', () => {
  assert.ok(buildMissingImageMessage('sandcastle:captable-manager', 'gh').includes('sandcastle:captable-manager'));
});

test('buildMissingImageMessage: explains the two-layer model (base + project Dockerfile)', () => {
  const m = buildMissingImageMessage('sandcastle:captable-manager', 'gh');
  assert.ok(m.includes('sandcastle-base'), 'must name the universal base');
  assert.ok(m.includes('.sandcastle/Dockerfile'), 'must point at the project-layer Dockerfile');
  assert.ok(m.includes('FROM sandcastle-base'), 'must give the FROM line');
  assert.ok(m.includes('ENTRYPOINT'), 'must re-declare the entrypoint');
  assert.ok(m.includes('sleep'), 'entrypoint must be sleep infinity');
  assert.ok(m.includes('infinity'));
});

test('buildMissingImageMessage: gives the build command', () => {
  assert.ok(
    buildMissingImageMessage('sandcastle:captable-manager', 'gh').includes('npx @ai-hero/sandcastle docker build-image'),
  );
});

test('buildMissingImageMessage: names the host CLI for the project git host (gh vs glab)', () => {
  const gh = buildMissingImageMessage('sandcastle:captable-manager', 'gh');
  const glab = buildMissingImageMessage('sandcastle:captable-manager', 'glab');
  assert.ok(gh.includes('gh'), 'gh project → gh CLI');
  assert.ok(glab.includes('glab'), 'glab project → glab CLI');
  assert.notEqual(gh, glab, 'the two hosts must produce different messages');
});

test('buildMissingImageMessage: includes a Claude-Code-pasteable prompt', () => {
  const m = buildMissingImageMessage('sandcastle:captable-manager', 'gh');
  assert.ok(m.includes('Claude Code'), 'must reference Claude Code');
  // The prompt restates the build command so it is self-sufficient once pasted.
  assert.ok(m.includes('build-image'));
});

// --- image capability pre-flight (issue #53) --------------------------------
//
// Same split one dimension over: these are the MECHANICS of asking an image what
// it carries. No docker, no network — the container run stays in main.ts.

test('parseToolRequirements: a prefix says HOW to look, not what the tool is', () => {
  const { ok, malformed } = parseToolRequirements(['cmd:gh', 'py:edge_tts']);
  assert.equal(malformed.length, 0);
  assert.deepEqual(
    ok.map((r) => [r.kind, r.name, r.raw]),
    [
      ['command', 'gh', 'cmd:gh'],
      ['python-module', 'edge_tts', 'py:edge_tts'],
    ],
  );
});

test('parseToolRequirements: a bare name is malformed, not guessed at', () => {
  // Guessing between `command -v` and an import is exactly the silent default
  // this pre-flight exists to remove. An unprobeable declaration is an absence.
  const { ok, malformed } = parseToolRequirements(['gh', 'npm:tsx']);
  assert.equal(ok.length, 0);
  assert.deepEqual(malformed, ['gh', 'npm:tsx']);
});

test('parseToolRequirements: nothing that could reach a shell survives the parse', () => {
  // The probe script is BUILT AS A STRING, so this is the control that makes it
  // safe rather than lucky. Every one of these must be refused BY NAME.
  const hostile = [
    "cmd:gh; rm -rf /",
    "cmd:gh'",
    'py:os; import subprocess',
    'py:$(whoami)',
    'cmd:`id`',
    'cmd:a b',
    'py:',
    'cmd:-flag',
  ];
  const { ok, malformed } = parseToolRequirements(hostile);
  assert.equal(ok.length, 0, 'a hostile declaration reached the probe');
  assert.deepEqual(malformed, hostile);
  // And the script built from what survived is empty — nothing to inject into.
  assert.equal(toolProbeScript(ok), '');
});

test('toolProbeScript: one line per requirement, each probed in its own idiom', () => {
  const { ok } = parseToolRequirements(['cmd:gh', 'py:edge_tts']);
  const script = toolProbeScript(ok);
  assert.equal(script.split('\n').length, 2);
  assert.match(script, /command -v gh /);
  assert.match(script, /python3 -c 'import edge_tts'/);
  // The declaration, verbatim, is what comes back — so the parse of the output
  // needs no positional agreement with the input.
  assert.match(script, /echo 'ok cmd:gh'/);
  assert.match(script, /echo 'no py:edge_tts'/);
});

test('toolProbeArgv: the entrypoint is overridden — without it the probe hangs forever', () => {
  // The consumer project layer re-declares ENTRYPOINT ["sleep","infinity"] (the
  // Engine needs a container that stays alive), so `docker run <image> sh -c …`
  // runs `sleep infinity sh -c …`. The probe would hang exactly where it exists
  // to save half an hour. This assertion is the whole reason the argv is a
  // function and not a template at the call site.
  const argv = toolProbeArgv('sandcastle:revue', "echo 'ok cmd:gh'");
  const i = argv.indexOf('--entrypoint');
  assert.ok(i >= 0, 'the sleep entrypoint would swallow the probe');
  assert.equal(argv[i + 1], 'sh');
  assert.ok(argv.includes('--rm'), 'a probe container must not survive its answer');
  // An import is a local question; a probe that can dial out could pass for a
  // reason the real run will not reproduce.
  const n = argv.indexOf('--network');
  assert.equal(argv[n + 1], 'none');
  assert.equal(argv[argv.length - 2], '-c');
  assert.equal(argv[argv.length - 1], "echo 'ok cmd:gh'");
  assert.ok(argv.indexOf('sandcastle:revue') < argv.length - 2, 'the image precedes its command');
});

test('parseToolProbeOutput: a requirement with no line is UNPROVEN, not satisfied', () => {
  const probes = parseToolProbeOutput(
    ["sh: warning: something", 'ok cmd:gh', 'no py:edge_tts', ''].join('\n'),
  );
  assert.equal(probes['cmd:gh'], true);
  assert.equal(probes['py:edge_tts'], false);
  // Absent from the map — the caller's `!== true` is what makes that an absence.
  assert.equal(Object.prototype.hasOwnProperty.call(probes, 'cmd:jq'), false);
});

test('describeToolProbe: an empty declaration says the image is not being asked', () => {
  const line = describeToolProbe('sandcastle:revue', [], null);
  assert.match(line, /not probed/);
  assert.match(line, /requiredTools/);
});

test('describeToolProbe: unprobeable is said as such, never as absent', () => {
  const line = describeToolProbe('sandcastle:revue', ['py:edge_tts'], null);
  assert.match(line, /cannot probe/);
  assert.doesNotMatch(line, /ABSENT/);
});

test('describeToolProbe: what is carried, what is missing, what is unprobeable', () => {
  const line = describeToolProbe('sandcastle:revue', ['cmd:gh', 'py:edge_tts', 'tsx'], {
    'cmd:gh': true,
    'py:edge_tts': false,
  });
  assert.match(line, /cmd:gh ✓/);
  assert.match(line, /py:edge_tts ABSENT/);
  assert.match(line, /tsx MALFORMED/);
  assert.match(line, /sandcastle:revue/);
});

finish();
