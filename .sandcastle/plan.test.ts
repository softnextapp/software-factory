// Tests for the config-parameterized plan module.
//
// Ports design-system's plan.test.ts onto the canonical signatures — parsePlan now
// takes `allowedBases`, and baseForLabels takes the project's `labelBases` map +
// `defaultBase` (no hardcoded EPIC_BASE / A11Y_LABEL) — and merges the task #2
// signature-contract cases. Pure: no network, no process.env.
// Run: npx tsx .sandcastle/plan.test.ts
import assert from 'node:assert/strict';
import { baseForLabels, parsePlan, applyOnly } from './plan.ts';
import { test, throws, finish } from './test-harness.ts';

// A representative project: a trunk plus one label-routed epic base. allowedBases is
// what main.ts derives from config (baseBranch + labelBases values + chainableBases).
const ALLOWED = ['main', 'epic/rgaa-accessibilite'];
const LABEL_BASES = { accessibilite: 'epic/rgaa-accessibilite' };

// --- parsePlan --------------------------------------------------------------

test('extracts the plan from surrounding agent chatter', () => {
  const issues = parsePlan(
    'blah <plan>{"issues":[{"number":7,"title":"Fix X","branch":"sandcastle/issue-7-fix-x","base":"main"}]}</plan> done',
    ALLOWED,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.number, 7);
  assert.equal(issues[0]?.branch, 'sandcastle/issue-7-fix-x');
  assert.equal(issues[0]?.base, 'main');
});

test('advisory base inside allowedBases is kept', () => {
  assert.equal(
    parsePlan(
      '<plan>{"issues":[{"number":4,"title":"T","branch":"b","base":"epic/rgaa-accessibilite"}]}</plan>',
      ALLOWED,
    )[0]?.base,
    'epic/rgaa-accessibilite',
  );
});

test('advisory base outside allowedBases is dropped, not propagated', () => {
  // A bogus base would otherwise become a --target-branch; undefined means "ask the host".
  assert.equal(
    parsePlan(
      '<plan>{"issues":[{"number":4,"title":"T","branch":"b","base":"release/v9"}]}</plan>',
      ALLOWED,
    )[0]?.base,
    undefined,
  );
});

test('omitted base is undefined (main.ts resolves it from the labels)', () => {
  assert.equal(
    parsePlan('<plan>{"issues":[{"number":4,"title":"T","branch":"b"}]}</plan>', ALLOWED)[0]?.base,
    undefined,
  );
});

test('empty issues list is valid (backlog drained)', () => {
  assert.deepEqual(parsePlan('<plan>{"issues":[]}</plan>', ALLOWED), []);
});

test('missing issues key → empty list', () => {
  assert.deepEqual(parsePlan('<plan>{}</plan>', ALLOWED), []);
});

test('missing <plan> tag throws', () => {
  throws(() => parsePlan('planner produced no plan tag', ALLOWED));
});

test('malformed JSON inside the tag throws (fail-closed)', () => {
  throws(() => parsePlan('<plan>{not json}</plan>', ALLOWED));
});

test('non-integer number throws (would reach the host as `view NaN`)', () => {
  throws(() =>
    parsePlan('<plan>{"issues":[{"number":"7","title":"T","branch":"b"}]}</plan>', ALLOWED),
  );
});

test('empty branch throws (would fork a nameless branch)', () => {
  throws(() => parsePlan('<plan>{"issues":[{"number":7,"title":"T","branch":""}]}</plan>', ALLOWED));
});

test('non-array issues throws', () => {
  throws(() => parsePlan('<plan>{"issues":"not-an-array"}</plan>', ALLOWED));
});

test('branch name failing the shape guard throws', () => {
  // BRANCH_SHAPE rejects spaces, $(…) and the like — agent-authored names that would
  // break a git/glab argv even though execFileSync already quotes them.
  throws(() =>
    parsePlan('<plan>{"issues":[{"number":7,"title":"T","branch":"bad name"}]}</plan>', ALLOWED),
  );
});

// --- baseForLabels ----------------------------------------------------------

test('label in map → that label’s base (amid other labels)', () => {
  assert.equal(
    baseForLabels(['Status::Todo', 'accessibilite', 'sandcastle'], LABEL_BASES, 'main'),
    'epic/rgaa-accessibilite',
  );
});

test('no mapped label → defaultBase', () => {
  assert.equal(baseForLabels(['Status::Todo', 'sandcastle'], LABEL_BASES, 'main'), 'main');
  assert.equal(baseForLabels([], LABEL_BASES, 'main'), 'main');
});

test('empty labelBases → always defaultBase', () => {
  assert.equal(baseForLabels(['x', 'y'], {}, 'main'), 'main');
});

test('first matching label wins (host label order)', () => {
  const labelBases = { accessibilite: 'epic/a', refactor: 'epic/b' };
  assert.equal(baseForLabels(['accessibilite', 'refactor'], labelBases, 'main'), 'epic/a');
  assert.equal(baseForLabels(['refactor', 'accessibilite'], labelBases, 'main'), 'epic/b');
});

// --- applyOnly (SANDCASTLE_ONLY restriction) --------------------------------

// Issues a planner might propose; numbers chosen so order is intentionally mixed.
const PLANNED = [
  { number: 7, title: 'Fix X', branch: 'sandcastle/issue-7-fix-x' },
  { number: 42, title: 'Add Y', branch: 'sandcastle/issue-42-add-y' },
  { number: 3, title: 'Polish Z', branch: 'sandcastle/issue-3-polish-z' },
];

test('only === null → everything kept, nothing dropped (unrestricted round)', () => {
  const r = applyOnly(PLANNED, null);
  assert.equal(r.kept.length, 3);
  assert.equal(r.dropped.length, 0);
  assert.deepEqual(
    r.kept.map((i) => i.number),
    [7, 42, 3],
  );
});

test('only set → kept are exactly the allow-listed numbers, rest dropped, order preserved', () => {
  const r = applyOnly(PLANNED, [42, 3]);
  assert.deepEqual(
    r.kept.map((i) => i.number),
    [42, 3],
  );
  assert.deepEqual(
    r.dropped.map((i) => i.number),
    [7],
  );
});

test('only set but no planner issue matches → kept empty, all dropped', () => {
  const r = applyOnly(PLANNED, [999]);
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.length, 3);
});

test('only numbers not in the plan are silently ignored (no phantom issues created)', () => {
  const r = applyOnly(PLANNED, [7, 999]);
  assert.deepEqual(
    r.kept.map((i) => i.number),
    [7],
  );
});

test('only with a single entry restricts to that one issue', () => {
  const r = applyOnly(PLANNED, [42]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0]?.number, 42);
});

finish();
