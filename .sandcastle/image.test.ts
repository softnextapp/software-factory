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

finish();
