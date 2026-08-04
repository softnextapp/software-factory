// Signature contract tests for the config-parameterized plan module.
//
// The fuller design-system suite (malformed plans, branch-shape rejection, missing
// fields) is ported in task #7. These lock the two signatures THIS refactor changed:
//   - baseForLabels now takes the project's `labelBases` map + `defaultBase`
//     (no hardcoded EPIC_BASE / A11Y_LABEL).
//   - parsePlan now takes `allowedBases` (derived from config in main.ts).
//
// Pure: no network, no process.env. Run: npx tsx .sandcastle/plan.test.ts
import assert from 'node:assert/strict';
import { baseForLabels, parsePlan } from './plan.ts';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL   ' + name + '\n        ' + (e as Error).message);
  }
}
function throws(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected the call to throw, but it did not');
}

// ---------------------------------------------------------------------------
// baseForLabels — config-driven label → base
// ---------------------------------------------------------------------------

test('empty labelBases → always defaultBase', () => {
  assert.equal(baseForLabels(['x', 'y'], {}, 'main'), 'main');
  assert.equal(baseForLabels([], {}, 'main'), 'main');
});

test('label in map → that label’s base', () => {
  const labelBases = { accessibilite: 'epic/rgaa-accessibilite', bug: 'main' };
  assert.equal(baseForLabels(['accessibilite'], labelBases, 'main'), 'epic/rgaa-accessibilite');
  assert.equal(baseForLabels(['bug'], labelBases, 'trunk'), 'main');
});

test('first matching label wins (host label order)', () => {
  const labelBases = { accessibilite: 'epic/a', refactor: 'epic/b' };
  assert.equal(baseForLabels(['accessibilite', 'refactor'], labelBases, 'main'), 'epic/a');
  assert.equal(baseForLabels(['refactor', 'accessibilite'], labelBases, 'main'), 'epic/b');
});

test('unmapped labels fall through to defaultBase', () => {
  assert.equal(baseForLabels([' discussion ', 'wontfix'], { bug: 'main' }, 'main'), 'main');
});

// ---------------------------------------------------------------------------
// parsePlan — allowedBases gates the advisory base
// ---------------------------------------------------------------------------

test('advisory base outside allowedBases is dropped, not thrown', () => {
  const out = parsePlan(
    '<plan>{"issues":[{"number":7,"title":"t","branch":"iss-7","base":"bogus"}]}</plan>',
    ['main'],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.base, undefined);
});

test('advisory base inside allowedBases is kept', () => {
  const out = parsePlan(
    '<plan>{"issues":[{"number":7,"title":"t","branch":"iss-7","base":"main"}]}</plan>',
    ['main', 'epic/x'],
  );
  assert.equal(out[0]?.base, 'main');
});

test('empty issues list is valid (backlog drained)', () => {
  assert.deepEqual(parsePlan('<plan>{"issues":[]}</plan>', ['main']), []);
});

test('missing <plan> tag throws', () => {
  throws(() => parsePlan('the planner rambled, no tag', ['main']));
});

test('non-integer number throws', () => {
  throws(() =>
    parsePlan('<plan>{"issues":[{"number":"7","title":"t","branch":"iss-7"}]}</plan>', ['main']),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
