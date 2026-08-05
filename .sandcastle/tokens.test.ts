// Contract tests for env-first auth-token resolution.
// Pure: no network, no files, no process.env (env + file secrets are passed in).
// Run: npx tsx .sandcastle/tokens.test.ts
//
// The seam is resolveToken(key, env, fileSecrets): a required token resolves from
// the environment first, falling back to .sandcastle/.env.secrets, so a consumer
// who exports the tokens once in their shell profile needs no per-instance secret
// file. See GitHub issue #2.
import assert from 'node:assert/strict';
import {
  parseEnvFile,
  resolveToken,
  resolveTokens,
  assertNoTokenKeyInDotEnv,
  tokenStatus,
  type ResolvedToken,
} from './tokens.ts';

import { test, throws, finish } from './test-harness.ts';

// ---------------------------------------------------------------------------
// resolveToken — env-first precedence
// ---------------------------------------------------------------------------

test('env wins over .env.secrets', () => {
  const t = resolveToken('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_TOKEN: 'env-tok' }, { ANTHROPIC_AUTH_TOKEN: 'file-tok' });
  assert.equal(t.source, 'env');
  assert.equal(t.value, 'env-tok');
});

test('env set, file unset → env', () => {
  const t = resolveToken('K', { K: 'env-tok' }, {});
  assert.equal(t.source, 'env');
  assert.equal(t.value, 'env-tok');
  assert.equal(t.conflict, false);
});

test('env unset, file set → .env.secrets fallback', () => {
  const t = resolveToken('K', {}, { K: 'file-tok' });
  assert.equal(t.source, '.env.secrets');
  assert.equal(t.value, 'file-tok');
  assert.equal(t.conflict, false);
});

test('both unset → MISSING', () => {
  const t = resolveToken('K', {}, {});
  assert.equal(t.source, 'MISSING');
  assert.equal(t.value, '');
});

test('empty-string value counts as unset → MISSING when both empty', () => {
  // The parser/need() treat '' as missing; resolution must agree so an
  // `ANTHROPIC_AUTH_TOKEN=` line never reads as a present token.
  assert.equal(resolveToken('K', { K: '' }, { K: '' }).source, 'MISSING');
  assert.equal(resolveToken('K', { K: '' }, {}).source, 'MISSING');
  assert.equal(resolveToken('K', {}, { K: '' }).source, 'MISSING');
});

test('empty env value falls back to a set file value', () => {
  const t = resolveToken('K', { K: '' }, { K: 'file-tok' });
  assert.equal(t.source, '.env.secrets');
  assert.equal(t.value, 'file-tok');
});

test('both set with the SAME value → env, no conflict (no spurious warning)', () => {
  const t = resolveToken('K', { K: 'same' }, { K: 'same' });
  assert.equal(t.source, 'env');
  assert.equal(t.value, 'same');
  assert.equal(t.conflict, false);
});

test('both set with DIFFERENT values → env wins AND conflict flagged', () => {
  const t = resolveToken('K', { K: 'env-tok' }, { K: 'file-tok' });
  assert.equal(t.source, 'env');
  assert.equal(t.value, 'env-tok');
  assert.equal(t.conflict, true);
});

test('an unrelated env var does not satisfy a missing token', () => {
  assert.equal(resolveToken('K', { OTHER: 'x' }, {}).source, 'MISSING');
});

// --- fileSource label (issue #17): the host token resolves against .env, not .env.secrets ---

test('resolveToken labels the file source via fileSource (default .env.secrets, unchanged)', () => {
  // Default behaviour is byte-identical for every existing caller.
  const t = resolveToken('GH_TOKEN', {}, { GH_TOKEN: 'tok' });
  assert.equal(t.source, '.env.secrets');
  assert.equal(t.value, 'tok');
});

test('resolveToken with fileSource=".env" reports source .env for a file-only value', () => {
  // The host-CLI token lives in .env (resolveEnv flows it); its file fallback is .env,
  // so a value filed there must report '.env', not mislabel itself '.env.secrets'.
  const t = resolveToken('GH_TOKEN', {}, { GH_TOKEN: 'tok' }, '.env');
  assert.equal(t.source, '.env');
  assert.equal(t.value, 'tok');
  assert.equal(t.conflict, false);
});

test('resolveToken fileSource=".env": env still wins, and flags a conflict', () => {
  const envWins = resolveToken('GH_TOKEN', { GH_TOKEN: 'env' }, { GH_TOKEN: 'file' }, '.env');
  assert.equal(envWins.source, 'env');
  assert.equal(envWins.value, 'env');
  assert.equal(envWins.conflict, true);
  assert.equal(resolveToken('GH_TOKEN', {}, {}, '.env').source, 'MISSING');
});

test('tokenStatus masks a host token resolved from .env (value-free diagnostic)', () => {
  const status = tokenStatus(resolveToken('GH_TOKEN', {}, { GH_TOKEN: 'secret' }, '.env'));
  assert.equal(status.source, '.env');
  assert.equal(status.value, 'SET'); // never the raw token
});

// ---------------------------------------------------------------------------
// resolveTokens — batch + conflict detection
// ---------------------------------------------------------------------------

test('resolveTokens returns one entry per key, in order', () => {
  const out = resolveTokens(['A', 'B', 'C'], { A: '1' }, { B: '2' });
  assert.deepEqual(out.map((t) => t.key), ['A', 'B', 'C']);
  assert.equal(out[0].source, 'env');
  assert.equal(out[1].source, '.env.secrets');
  assert.equal(out[2].source, 'MISSING');
});

test('resolveTokens dedups keys so two providers sharing a token report once', () => {
  // Distinct providers may share a tokenKey; the batch only resolves each key once.
  const out = resolveTokens(['K', 'K'], { K: 'env-tok' }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'env');
});

test('only differing env/file pairs are marked conflict', () => {
  const out = resolveTokens(
    ['SAME', 'DIFF', 'FILE_ONLY'],
    { SAME: 'v', DIFF: 'env-v' },
    { SAME: 'v', DIFF: 'file-v', FILE_ONLY: 'f' },
  );
  const byKey = Object.fromEntries(out.map((t) => [t.key, t])) as Record<string, ResolvedToken>;
  assert.equal(byKey['SAME'].conflict, false);
  assert.equal(byKey['DIFF'].conflict, true);
  assert.equal(byKey['FILE_ONLY'].conflict, false);
});

// ---------------------------------------------------------------------------
// tokenStatus — the masked, value-free diagnostic record
// ---------------------------------------------------------------------------

test('tokenStatus never leaks the raw value: SET for present, MISSING for absent', () => {
  const env = tokenStatus(resolveToken('K', { K: 'secret-value' }, {}));
  assert.equal(env.value, 'SET');
  assert.equal((env as { value: string }).value, 'SET'); // no raw token anywhere
  assert.equal(env.source, 'env');

  const file = tokenStatus(resolveToken('K', {}, { K: 'secret-value' }));
  assert.equal(file.value, 'SET');
  assert.equal(file.source, '.env.secrets');

  const missing = tokenStatus(resolveToken('K', {}, {}));
  assert.equal(missing.value, 'MISSING');
  assert.equal(missing.source, 'MISSING');
});

// ---------------------------------------------------------------------------
// parseEnvFile — the KEY=VALUE parser (also drives the .env guard)
// ---------------------------------------------------------------------------

test('parseEnvFile: KEY=VALUE, skips blanks/comments, strips matching quotes', () => {
  const raw = [
    '# a comment',
    '',
    '  ANTHROPIC_AUTH_TOKEN="quoted-value"  ',
    "CLAUDE_CODE_OAUTH_TOKEN='apostrophed'",
    'BARE=bare-value',
    'NO_EQUAL_LINE',
  ].join('\n');
  assert.deepEqual(parseEnvFile(raw), {
    ANTHROPIC_AUTH_TOKEN: 'quoted-value',
    CLAUDE_CODE_OAUTH_TOKEN: 'apostrophed',
    BARE: 'bare-value',
  });
});

test('parseEnvFile: a leading-# line is ignored even if it looks like a token', () => {
  // A commented-out token must NOT count as declared — the guard relies on this.
  const parsed = parseEnvFile('#ANTHROPIC_AUTH_TOKEN=leaked\nOTHER=1\n');
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in parsed));
  assert.equal(parsed['OTHER'], '1');
});

// ---------------------------------------------------------------------------
// assertNoTokenKeyInDotEnv — the .env startup guard
// ---------------------------------------------------------------------------

test('guard throws when a tokenKey is declared in .env, naming the key', () => {
  const dotEnv = 'ANTHROPIC_AUTH_TOKEN=oops\nSOMETHING=else\n';
  try {
    assertNoTokenKeyInDotEnv(dotEnv, ['ANTHROPIC_AUTH_TOKEN']);
    assert.fail('should have thrown');
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes('ANTHROPIC_AUTH_TOKEN'), `message should name the key: ${msg}`);
    assert.ok(msg.includes('.env'), `message should name .env: ${msg}`);
  }
});

test('guard passes when no tokenKey is in .env', () => {
  assertNoTokenKeyInDotEnv('OTHER=1\nBASE_URL=https://x\n', ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
});

test('guard passes when the only tokenKey-looking line is commented out', () => {
  assertNoTokenKeyInDotEnv('#ANTHROPIC_AUTH_TOKEN=oops\n', ['ANTHROPIC_AUTH_TOKEN']);
});

test('guard throws for any one of several active tokenKeys', () => {
  // Active providers can require more than one token; any of them in .env is fatal.
  throws(() =>
    assertNoTokenKeyInDotEnv('CLAUDE_CODE_OAUTH_TOKEN=x\n', [
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]),
  );
});

finish();
