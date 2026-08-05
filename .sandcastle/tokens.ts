// Env-first auth-token resolution — the pure seam main.ts routes token lookup
// through. Kept in its own module so precedence is unit-testable with an injected
// environment (tokens.test.ts) without importing main.ts, whose top-level loop
// would run on import. See GitHub issue #2.
//
// A required token resolves as `process.env[key] ?? .env.secrets[key]` —
// environment first, the gitignored `.sandcastle/.env.secrets` file as fallback —
// so a consumer who exports the tokens once in their shell profile can run any
// Factory instance with no per-instance secret file (plug-and-play).
//
// This module is deliberately engine-free and side-effect-free: it takes the env
// record and the already-parsed file secrets as arguments and returns data. Reading
// files, masking, logging, and throwing at startup all live in main.ts.

/**
 * Where a resolved token came from. `'MISSING'` means neither the environment nor
 * the file store provided a non-empty value. `'.env'` is the host-CLI token's file
 * store: unlike the LLM tokens (which resolve against gitignored `.env.secrets` and
 * are baked one-per-sandbox), the host token lives in `.env` so the Engine's
 * `resolveEnv` flows it to every sandbox — so its file fallback is `.env`, not
 * `.env.secrets`. See main.ts / GitHub issue #17.
 */
export type TokenSource = 'env' | '.env.secrets' | '.env' | 'MISSING';

/** A single token, resolved env-first. */
export interface ResolvedToken {
  readonly key: string;
  /** The resolved value. Empty string iff `source === 'MISSING'`. */
  readonly value: string;
  readonly source: TokenSource;
  /**
   * true when the env and `.env.secrets` BOTH carry this key with DIFFERENT values.
   * The env value still wins (`source === 'env'`); this flag exists only so main.ts
   * can warn — it helps debug "why is it using the wrong token". Same value in both
   * places is not a conflict (no warning).
   */
  readonly conflict: boolean;
}

/**
 * Parse a KEY=VALUE file (`.env.secrets` or `.env`) into a record.
 *
 * Extracted verbatim from main.ts's old inline `loadSecrets` parser so both files
 * share one definition: blank lines and `#`-prefixed comments are skipped, values
 * are trimmed, and a value wrapped in a matching pair of `"…"` or `'…'` is unquoted.
 * Inline trailing comments are NOT stripped (preserving the prior behaviour).
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Empty string / undefined counts as unset — an `ANTHROPIC_AUTH_TOKEN=` line is not a token. */
function isSet(v: string | undefined): v is string {
  return v != null && v !== '';
}

/**
 * Resolve a single token env-first: `env[key]` wins, then `fileSecrets[key]`,
 * else MISSING. Pure — inject both stores to test precedence.
 *
 * `fileSource` labels which file the fallback record came from in the returned
 * `source` (`.env.secrets` for LLM provider tokens, `.env` for the host-CLI token —
 * see TokenSource). It does NOT change precedence, only the diagnostic label, so a
 * host token resolved from `.env` reports `source: '.env'` rather than mislabelling
 * itself `.env.secrets`. Defaults to `.env.secrets` so every existing caller is
 * unchanged.
 */
export function resolveToken(
  key: string,
  env: Record<string, string | undefined>,
  fileSecrets: Record<string, string>,
  fileSource: '.env.secrets' | '.env' = '.env.secrets',
): ResolvedToken {
  const envValue = env[key];
  const fileValue = fileSecrets[key];
  if (isSet(envValue)) {
    return {
      key,
      value: envValue,
      source: 'env',
      // Conflict only when the file ALSO sets a different value.
      conflict: isSet(fileValue) && fileValue !== envValue,
    };
  }
  if (isSet(fileValue)) {
    return { key, value: fileValue, source: fileSource, conflict: false };
  }
  return { key, value: '', source: 'MISSING', conflict: false };
}

/**
 * Resolve a set of token keys (the active profile's distinct token keys), deduped,
 * preserving first-seen order. main.ts uses the result for startup validation and
 * the dry-run source report.
 */
export function resolveTokens(
  keys: readonly string[],
  env: Record<string, string | undefined>,
  fileSecrets: Record<string, string>,
): ResolvedToken[] {
  const seen = new Set<string>();
  const out: ResolvedToken[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolveToken(key, env, fileSecrets));
  }
  return out;
}

/** The masked, value-free diagnostic record printed for each required token. */
export interface TokenStatus {
  readonly source: TokenSource;
  /** Always `SET` or `MISSING` — never the raw token. */
  readonly value: 'SET' | 'MISSING';
}

/**
 * Turn a resolved token into the safe-to-print `{ source, value }` pair. This is the
 * ONLY shape that reaches a log: the raw token never does. Centralised so the
 * "never print a token value" invariant lives in one tested place.
 */
export function tokenStatus(t: ResolvedToken): TokenStatus {
  return { source: t.source, value: t.source === 'MISSING' ? 'MISSING' : 'SET' };
}

/**
 * Startup guard: throw if `.sandcastle/.env` declares any active provider's
 * `tokenKey`.
 *
 * Env-first puts real tokens in `process.env`; combined with the Engine's
 * `resolveEnv` (which falls back to `process.env` per `.env`-named key), a token
 * key accidentally placed in `.env` would leak that token into every sandbox → 401.
 * This prevents the exact bug class the `.env` / `.env.secrets` split exists to stop.
 * Pass the raw `.env` contents and the active providers' token keys; a missing or
 * comment-only entry does not trigger it.
 */
export function assertNoTokenKeyInDotEnv(dotEnvRaw: string, tokenKeys: readonly string[]): void {
  const declared = parseEnvFile(dotEnvRaw);
  const present = tokenKeys.filter((key) => key in declared);
  if (present.length > 0) {
    throw new Error(
      `Auth token key(s) ${present.map((k) => `\`${k}\``).join(', ')} must NOT be declared in ` +
        `.sandcastle/.env — resolveEnv merges all of .env into every sandbox, so a token ` +
        `there leaks to every sandbox → 401. Put tokens in the environment (~/.bashrc) or in ` +
        `.sandcastle/.env.secrets (gitignored), never in .env.`,
    );
  }
}
