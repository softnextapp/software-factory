// Tests for the chained-MR base-resolution module.
//
// Ports design-system's chain.test.ts. chain.ts is ported verbatim, so its pure stack
// walk (resolveChainedBase) and glab parser (parseOpenMergeRequests) are exercised
// unchanged — only the harness differs. Pure: no network, no glab, no process.env.
// Run: npx tsx .sandcastle/chain.test.ts
import assert from 'node:assert/strict';
import { parseOpenMergeRequests, resolveChainedBase, type OpenMergeRequest } from './chain.ts';
import { test, throws, finish } from './test-harness.ts';

const ROOT = 'epic/rgaa-accessibilite';

// Deterministic, increasing iids so the "identical createdAt" case can assert the
// tie-break without depending on array order. Module-level: test() runs its callbacks
// synchronously and in order, so the counter stays monotonic across cases.
let nextIid = 1;
const mr = (sourceBranch: string, targetBranch: string, createdAt: string): OpenMergeRequest => {
  const id = nextIid++;
  return {
    iid: id,
    sourceBranch,
    targetBranch,
    createdAt,
    title: `Draft: ${sourceBranch}`,
    webUrl: `https://gitlab.example.com/x/-/merge_requests/${id}`,
  };
};

// --- resolveChainedBase -----------------------------------------------------

test('nothing open → the root itself, and NOT chained (first ticket of a wave)', () => {
  const r = resolveChainedBase([], ROOT);
  assert.equal(r.base, ROOT);
  assert.equal(r.chained, false);
  assert.deepEqual(r.stack, []);
});

test('one open MR on the root → fork from its branch', () => {
  const a = mr('sandcastle/issue-4-a', ROOT, '2026-07-29T08:00:00Z');
  const r = resolveChainedBase([a], ROOT);
  assert.equal(r.base, 'sandcastle/issue-4-a');
  assert.equal(r.chained, true);
  assert.deepEqual(r.stack.map((m) => m.sourceBranch), ['sandcastle/issue-4-a']);
});

test('three-deep stack resolves to the TOP; input array order is irrelevant', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const b = mr('branch-b', 'branch-a', '2026-07-29T09:00:00Z');
  const c = mr('branch-c', 'branch-b', '2026-07-29T10:00:00Z');
  const r = resolveChainedBase([c, a, b], ROOT);
  assert.equal(r.base, 'branch-c');
  assert.deepEqual(
    r.stack.map((m) => m.sourceBranch),
    ['branch-a', 'branch-b', 'branch-c'],
  );
  assert.deepEqual(r.rivals, []);
});

test('MRs outside the stack are ignored (another effort’s MR on main)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const unrelated = mr('feat/something-else', 'main', '2026-07-29T23:00:00Z');
  assert.equal(resolveChainedBase([a, unrelated], ROOT).base, 'branch-a');
  assert.equal(resolveChainedBase([unrelated], ROOT).chained, false);
});

test('forked stack picks the most recent head and reports the loser as a rival', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const older = mr('branch-x', 'branch-a', '2026-07-29T09:00:00Z');
  const newer = mr('branch-y', 'branch-a', '2026-07-29T11:00:00Z');
  const r = resolveChainedBase([a, older, newer], ROOT);
  assert.equal(r.base, 'branch-y');
  assert.deepEqual(r.rivals.map((m) => m.sourceBranch), ['branch-x']);
});

test('identical createdAt is broken by iid (no dependence on glab page order)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const first = mr('branch-p', 'branch-a', '2026-07-29T09:00:00Z');
  const second = mr('branch-q', 'branch-a', '2026-07-29T09:00:00Z');
  assert.ok(second.iid > first.iid);
  assert.equal(resolveChainedBase([a, first, second], ROOT).base, 'branch-q');
  assert.equal(resolveChainedBase([a, second, first], ROOT).base, 'branch-q');
});

test('a hand-made cycle terminates (does not hang the round)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const b = mr('branch-b', 'branch-a', '2026-07-29T09:00:00Z');
  const loop = mr('branch-a', 'branch-b', '2026-07-29T10:00:00Z');
  const r = resolveChainedBase([a, b, loop], ROOT);
  assert.equal(r.base, 'branch-b');
});

// --- parseOpenMergeRequests -------------------------------------------------

test('maps real glab snake_case fields to camelCase', () => {
  const [parsed] = parseOpenMergeRequests(
    JSON.stringify([
      {
        iid: 59,
        source_branch: 'fix/rgaa-lang-viewport',
        target_branch: 'main',
        created_at: '2026-07-28T12:11:47.229Z',
        title: 'Draft: fix(a11y)',
        web_url: 'https://gitlab.example.com/x/-/merge_requests/59',
        state: 'opened',
      },
    ]),
  );
  assert.equal(parsed?.iid, 59);
  assert.equal(parsed?.sourceBranch, 'fix/rgaa-lang-viewport');
  assert.equal(parsed?.targetBranch, 'main');
});

test('rows missing branch fields are dropped, not fatal', () => {
  assert.deepEqual(parseOpenMergeRequests('[{"iid":1},null,3]'), []);
  assert.deepEqual(parseOpenMergeRequests('[]'), []);
});

test('non-array payload is fatal (would otherwise silently un-chain the round)', () => {
  // A 401 body or garbage must NOT read as "no open MR".
  throws(() => parseOpenMergeRequests('{"message":"401 Unauthorized"}'));
  throws(() => parseOpenMergeRequests('not json'));
});

finish();
