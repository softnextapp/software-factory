// One-command adoption of the Factory into an EXISTING repo — the in-place
// counterpart to the greenfield `git clone && rm -rf .git && git init` in README
// §Setup. Solves GitHub issue #3: until now, adopting `.sandcastle/` into a repo
// that already has its own history/remote was an undocumented reverse-engineering
// exercise (copy the tracked files, wire the Engine, ignore locally).
//
// This script does all three, plus the two things a real consumer also needs to
// actually run `main.ts`: it wires the full Factory runtime (the Engine + the
// `tsx`/`typescript`/`@types/node` dev tools), and it ensures the self-contained ESM
// shim is present so `main.ts` even transpiles. The shim — `.sandcastle/package.json =
// { "type": "module" }` — ships as a tracked Factory file (issue #8's fix), so step 1's
// `git archive` copy already lands it for every consumer regardless of their root
// `package.json`; step 3 below only repairs it in place if it is somehow missing.
//
// Invoked from the Factory root, targeting a consumer directory:
//   npx tsx .sandcastle/adopt.ts <consumer-path> [--force]
// The Factory is config-only (ADR-0001) and clone-and-own (ADR-0002): adoption
// copies the `.sandcastle/` config layer ONCE and leaves the consumer owning it.
//
// Pure helpers (detectPackageManager, pmAddArgs, consumerRootIsCjs,
// buildExcludePatch, engineRuntimeDeps, computeMissing, toSpecs, parseArgs) are
// exported for the contract test; main() does the fs/spawn side effects and runs
// only when the file is invoked directly (see the guard at the bottom).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// ---------------------------------------------------------------------------
// Pure helpers (the contract-test seam — no fs, no network, no process.env)
// ---------------------------------------------------------------------------

// Lockfile → package manager. Checked in order so a repo with more than one
// lockfile (rare) resolves to the non-npm one; npm is the fallback, not pnpm/yarn.
const LOCKFILES: { file: string; pm: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'package-lock.json', pm: 'npm' },
];

/** Detect the consumer's package manager from its lockfile; default `npm`. */
export function detectPackageManager(dirEntries: string[]): PackageManager {
  for (const { file, pm } of LOCKFILES) {
    if (dirEntries.includes(file)) return pm;
  }
  return 'npm';
}

/** The `add` argv (subcommand + flags + specs) for `execFileSync(pm, …)`. The binary
 * name is NOT included — the caller passes it as the command. `npm` uses `install`;
 * pnpm/yarn/bun use `add`. `dev` → `-D` (devDependency). */
export function pmAddArgs(pm: PackageManager, specs: string[], dev: boolean): string[] {
  const sub = pm === 'npm' ? 'install' : 'add';
  const flags = dev ? ['-D'] : [];
  return [sub, ...flags, ...specs];
}

/**
 * Would a consumer whose root `package.json` is this be left CJS at `.sandcastle/`?
 *
 * `main.ts` uses top-level `await`; tsx/esbuild transpiles it as ESM only when the
 * nearest `package.json` has `"type": "module"`. The self-contained shim
 * (`.sandcastle/package.json`) ships as a tracked file and step 1's copy lands it, so
 * this is normally already satisfied. This predicate gates only the step-3 *repair*:
 * if the shim is somehow missing AND the consumer's root is CJS (no `"type":"module"`,
 * or none at all), the repair writes it. Issue #8.
 */
export function consumerRootIsCjs(consumerPkgJson: string | null): boolean {
  if (!consumerPkgJson) return true; // no package.json → tsx defaults to CJS → shim
  try {
    const pkg = JSON.parse(consumerPkgJson) as { type?: string };
    return pkg?.type !== 'module';
  } catch {
    return true; // unreadable → assume CJS; a redundant shim is harmless at runtime
  }
}

/**
 * Idempotent patch for `.git/info/exclude`: append `.sandcastle/` only if it is not
 * already ignored. Returns the text to append (and whether to append at all).
 */
export function buildExcludePatch(excludeText: string | null): {
  append: boolean;
  content: string;
} {
  const present = (excludeText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .some((l) => l === '.sandcastle/' || l === '.sandcastle');
  if (present) return { append: false, content: '' };
  // Avoid a leading blank line if the file already ends in a newline (or is empty).
  const sep = excludeText && excludeText.length > 0 && !excludeText.endsWith('\n') ? '\n' : '';
  return { append: true, content: `${sep}.sandcastle/\n` };
}

/** The Factory runtime grouped by where it belongs in the consumer: deps vs devDeps. */
export type DepTable = { deps: Record<string, string>; devDeps: Record<string, string> };

/** Parse a package.json's `dependencies` + `devDependencies` into a DepTable. Shared by
 * the Factory read and the consumer read so the two stay in lockstep. Null or
 * unparseable → empty tables (never throws). */
function parseDepTable(json: string | null): DepTable {
  if (!json) return { deps: {}, devDeps: {} };
  try {
    const pkg = JSON.parse(json) as { dependencies?: object; devDependencies?: object };
    return { deps: { ...(pkg.dependencies ?? {}) }, devDeps: { ...(pkg.devDependencies ?? {}) } };
  } catch {
    return { deps: {}, devDeps: {} };
  }
}

/** Read the Factory's `dependencies` + `devDependencies` (the Engine + dev tools). */
export function engineRuntimeDeps(factoryPkgJson: string | null): DepTable {
  return parseDepTable(factoryPkgJson);
}

/**
 * Given the Factory's runtime and the consumer's package.json, compute which specs
 * must still be installed. A dep the consumer already declares (any version, in deps
 * OR devDeps) is left alone — the consumer owns its own versions (ADR-0002/0003); we
 * only inject what is genuinely missing.
 */
export function computeMissing(factory: DepTable, consumerPkgJson: string | null): DepTable {
  const consumer = parseDepTable(consumerPkgJson);
  const have = new Set([...Object.keys(consumer.deps), ...Object.keys(consumer.devDeps)]);
  const pick = (table: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(table).filter(([name]) => !have.has(name)));
  return { deps: pick(factory.deps), devDeps: pick(factory.devDeps) };
}

/** Turn a `{ name: version }` table into `name@version` install specs. */
export function toSpecs(table: Record<string, string>): string[] {
  return Object.entries(table).map(([name, ver]) => `${name}@${ver}`);
}

/**
 * Should adopt clear the consumer's `node_modules/@ai-hero` before the Engine install?
 *
 * Takes the entry's `lstat` fact (or `null` when absent) — NOT a pre-classified enum —
 * so the load-bearing classification lives in this contract-test seam, not inline in
 * main(). `lstat` must not follow the link: a foreign `@ai-hero` SYMLINK (left by
 * `linkEngine`, adopt's offline fallback, or a manual pre-#3 workaround) must read as a
 * symlink, not as the target tree's directory. Clearing it before `<pm> add` lets the
 * package manager write into the consumer's own `node_modules`; otherwise the install
 * writes *through* the link into another tree and the Engine ends up declared yet
 * unresolvable (issue #11). A real DIRECTORY is the package manager's own layout (npm's
 * real dir, or pnpm's `@ai-hero` scope dir that itself contains a store symlink) and is
 * left alone; `null` (absent) needs no clearing.
 */
export function shouldClearEngineLink(fact: { isSymbolicLink(): boolean } | null): boolean {
  return fact !== null && fact.isSymbolicLink();
}

/**
 * Where the Engine (`@ai-hero/sandcastle`) resolves in an adopted consumer: under
 * `.sandcastle/node_modules`, NOT the consumer's root. Installing it out-of-tree — its
 * manifest is the `.sandcastle/package.json` ESM shim, so `<pm> add` runs with
 * `cwd: .sandcastle/` — keeps the consumer's tracked root `package.json` and lockfile
 * pristine: no uncommitted `@ai-hero/sandcastle` dep for a reviewer to flag as noise
 * (issue #22). `engineResolves`, `linkEngine`, and `engineScopeDir` all key off this
 * single path so the out-of-tree location has one source of truth.
 */
export function engineManifestPath(consumerRoot: string): string {
  return join(consumerRoot, '.sandcastle', 'node_modules', '@ai-hero', 'sandcastle', 'package.json');
}

/** The `@ai-hero` scope dir under `.sandcastle/node_modules` — the out-of-tree home of
 * the Engine. Derived from `engineManifestPath` (two `dirname`s up from the manifest)
 * so `linkEngine`'s link target and main's pre-install clear both anchor here instead of
 * re-typing the path. Internal — covered transitively by the `engineManifestPath` tests. */
function engineScopeDir(consumerRoot: string): string {
  return dirname(dirname(engineManifestPath(consumerRoot)));
}

export type ParsedArgs = { ok: true; consumerPath: string; force: boolean } | { ok: false; error: string };

/** Parse `tsx .sandcastle/adopt.ts <consumer-path> [--force|-f]`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // drop node + script path
  const force = args.includes('--force') || args.includes('-f');
  const positional = args.filter((a) => a !== '--force' && a !== '-f');
  if (positional.length !== 1) {
    return { ok: false, error: 'usage: tsx .sandcastle/adopt.ts <consumer-path> [--force]' };
  }
  return { ok: true, consumerPath: positional[0]!, force };
}

/**
 * Should a `.sandcastle/` file ship to a consumer? The Factory's OWN dev tooling —
 * contract tests (`*.test.ts(x)` / `*.spec.ts(x)`) and their harness (`test-harness.ts`,
 * imported by nothing but the tests) — must NOT: step 1's `git archive HEAD -- .sandcastle/`
 * would otherwise land them in the consumer, where the consumer's test runner
 * (vitest/jest, whose default glob matches `*.test.ts` / `*.spec.ts`) collects and runs
 * them in the wrong context — red files that read like the implementer left work behind
 * (issue #22). Every runtime file — sources, prompts, Dockerfiles, the ESM shim, tsconfig
 * — ships.
 *
 * Takes the path relative to the consumer root (`.sandcastle/…`); matches on the
 * basename so a future nested layout is still caught. The `.test.`/`.spec.` delimiter
 * avoids false positives like `latest.ts`; the harness check is exact-name only so
 * `test-harness-config.ts` still ships.
 */
export function isConsumerRuntimeFile(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  if (base === 'test-harness.ts') return false;
  return !/\.(test|spec)\.tsx?$/.test(base);
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (used by main only)
// ---------------------------------------------------------------------------

function readPkg(root: string): string | null {
  const p = join(root, 'package.json');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Fallback used only when `<pm> add` fails: link the Engine out of the Factory clone
 * into `.sandcastle/node_modules/@ai-hero` (out-of-tree, issue #22) so adoption still
 * succeeds offline. Returns false if the Factory has no installed `node_modules/@ai-hero`
 * to link (operator must `npm install` the Factory first). */
function linkEngine(factoryRoot: string, consumerRoot: string): boolean {
  const src = join(factoryRoot, 'node_modules', '@ai-hero');
  const dest = engineScopeDir(consumerRoot);
  const destParent = dirname(dest);
  if (!existsSync(src)) return false;
  try {
    mkdirSync(destParent, { recursive: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    symlinkSync(src, dest, 'dir');
    return true;
  } catch {
    return false;
  }
}

/** Does the Engine resolve in the consumer's tree? Used both to decide whether to
 * install (issue #22) and to tell a benign non-zero install exit from a genuine failure
 * (issue #13: pnpm v11 exits non-zero on ERR_PNPM_IGNORED_BUILDS even when the package
 * installed fine). True when the Engine lives out-of-tree under `.sandcastle/node_modules`
 * (the canonical location since #22) OR at the consumer's root (a prior adopt, or the
 * consumer's own root declaration — left alone, ADR-0002). Resolving the bare specifier
 * would trip the Engine's ESM-only exports map, so check its manifest (`existsSync`
 * follows pnpm's symlink into the store). */
function engineResolves(consumerRoot: string): boolean {
  return (
    existsSync(engineManifestPath(consumerRoot)) ||
    existsSync(join(consumerRoot, 'node_modules', '@ai-hero', 'sandcastle', 'package.json'))
  );
}

/**
 * Remove the Factory's dev-only files (contract tests + harness) the `git archive`
 * copy just landed, so they don't ship to the consumer (issue #22). Walks the
 * extracted `.sandcastle/` recursively; a file is dropped when
 * `isConsumerRuntimeFile` says it must not ship. Returns the paths removed (for
 * logging). Best-effort: a missing dir is a no-op, mirroring adopt's other fs helpers.
 */
function stripDevOnlyFiles(consumerRoot: string): string[] {
  const sandcastle = join(consumerRoot, '.sandcastle');
  if (!existsSync(sandcastle)) return [];
  const removed: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!isConsumerRuntimeFile(relative(consumerRoot, p))) {
        rmSync(p, { force: true });
        removed.push(relative(consumerRoot, p));
      }
    }
  };
  walk(sandcastle);
  return removed;
}

function info(msg: string): void {
  console.log(msg);
}
function warn(msg: string): void {
  console.warn('warning: ' + msg);
}

// Factory root = the parent of this script's directory (.sandcastle/).
const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const consumerRoot = resolve(parsed.consumerPath);
  const force = parsed.force;

  if (!existsSync(consumerRoot) || !statSync(consumerRoot).isDirectory()) {
    console.error(`Consumer path is not an existing directory: ${consumerRoot}`);
    process.exit(1);
  }

  const runtime = engineRuntimeDeps(readPkg(FACTORY_ROOT));
  if (!Object.keys(runtime.deps).length && !Object.keys(runtime.devDeps).length) {
    console.error(
      'Factory package.json declares no @ai-hero/sandcastle / dev tools — cannot wire the runtime. Run `npm install` in the Factory first.',
    );
    process.exit(1);
  }

  const consumerSandcastle = join(consumerRoot, '.sandcastle');

  // 1. Copy the config layer (tracked Factory files only).
  //    `git archive HEAD` streams tracked files — it cannot include the gitignored
  //    `.env`/`.env.secrets`, so the copy is secret-free by construction.
  const alreadyAdopted = existsSync(join(consumerSandcastle, 'main.ts'));
  if (alreadyAdopted && !force) {
    console.error(
      `${consumerSandcastle} already looks adopted (main.ts present).\n` +
        'Re-run with --force to re-sync from the Factory. NOTE: --force overwrites the tracked .sandcastle/ files (incl. config.ts) with the Factory HEAD versions; back up local edits first.',
    );
    process.exit(1);
  }
  if (force && existsSync(consumerSandcastle)) {
    rmSync(consumerSandcastle, { recursive: true, force: true });
  }
  info(`① copy .sandcastle/ (tracked files only) → ${consumerRoot}`);
  const archivePath = join(tmpdir(), `sf-adopt-${process.pid}.tar`);
  try {
    execFileSync('git', ['-C', FACTORY_ROOT, 'archive', '-o', archivePath, 'HEAD', '--', '.sandcastle/']);
    execFileSync('tar', ['-xf', archivePath, '-C', consumerRoot]);
  } finally {
    rmSync(archivePath, { force: true });
  }
  // Strip the Factory's dev-only files (contract tests + harness) the copy just
  // landed — a consumer's test runner would otherwise collect them (issue #22).
  const devOnly = stripDevOnlyFiles(consumerRoot);
  if (devOnly.length) {
    info(`① strip ${devOnly.length} Factory dev-only file(s) (contract tests + harness; issue #22)`);
  }

  // 2. Wire the Factory runtime into the consumer.
  //    Dev tools (tsx/typescript/@types/node) → consumer ROOT. These are general-purpose
  //    (not Factory-specific) and the consumer runs `npx tsx`, which resolves from the
  //    ROOT node_modules/.bin — so they belong at root, where the consumer already owns
  //    them (ADR-0002/0003); only what's missing is added. The Engine (@ai-hero/sandcastle)
  //    is Factory-specific → OUT-OF-TREE under .sandcastle/node_modules: its manifest is
  //    the .sandcastle/package.json ESM shim, so `<pm> add` runs with cwd:.sandcastle/ and
  //    never touches the consumer's tracked root package.json / lockfile — no uncommitted
  //    @ai-hero/sandcastle dep for a reviewer to flag (issue #22). A consumer that already
  //    resolves the Engine (its own root install, or a prior pre-#22 adopt that left it at
  //    root) is left alone: adopt never removes a dep the consumer declared (ADR-0002) —
  //    such a consumer drops the stale root entry itself to go fully clean. Resolution
  //    from .sandcastle/*.ts still finds the out-of-tree copy first (Node hits
  //    .sandcastle/node_modules before the root).
  const consumerPkg = readPkg(consumerRoot);
  const missing = computeMissing(runtime, consumerPkg);
  const missingDevSpecs = toSpecs(missing.devDeps); // dev tools → root
  const engineSpecs = engineResolves(consumerRoot) ? [] : toSpecs(runtime.deps); // Engine → .sandcastle/
  let wiredVia: 'install' | 'symlink' | 'present' = 'present';
  let devToolsFailed = false; // surfaced in the summary: a failed dev-tool install leaves main.ts unrunnable
  if (missingDevSpecs.length || engineSpecs.length) {
    const pm = detectPackageManager(readdirSync(consumerRoot));

    // 2a. Dev tools → consumer root. A failure here is not fatal to the Engine wiring —
    //     dev tools are general-purpose and consumer-owned; most TS projects already
    //     have tsx & co. Warn, record it for the summary, and press on.
    if (missingDevSpecs.length) {
      try {
        info(`② install dev tools (${pm} -D, root): ${missingDevSpecs.join(', ')}`);
        execFileSync(pm, pmAddArgs(pm, missingDevSpecs, true), { cwd: consumerRoot, stdio: 'inherit' });
        wiredVia = 'install';
      } catch {
        devToolsFailed = true;
        warn(
          `'${pm} add -D' for dev tools (${missingDevSpecs.join(', ')}) failed; install them in the consumer yourself.`,
        );
      }
    }

    // 2b. Engine → .sandcastle/ (out-of-tree, issue #22).
    if (engineSpecs.length) {
      // Clear a stale foreign @ai-hero symlink under .sandcastle/ (a prior linkEngine
      // fallback) BEFORE installing — the same hazard as issue #11, relocated
      // out-of-tree: `<pm> add` would otherwise write through the link into another tree
      // and the Engine ends up declared yet unresolvable. A real dir is the package
      // manager's own layout and is left alone. `lstatSync` (not stat) so a symlink is
      // seen as a symlink, not the target's dir.
      const engineScope = engineScopeDir(consumerRoot);
      if (shouldClearEngineLink(existsSync(engineScope) ? lstatSync(engineScope) : null)) {
        info('② clear stale @ai-hero symlink under .sandcastle/ before install (issue #11)');
        rmSync(engineScope, { recursive: true, force: true });
      }
      try {
        info(`② install Engine (${pm}, .sandcastle/ out-of-tree): ${engineSpecs.join(', ')}`);
        execFileSync(pm, pmAddArgs(pm, engineSpecs, false), { cwd: consumerSandcastle, stdio: 'inherit' });
        wiredVia = 'install';
      } catch {
        // A non-zero exit is not always failure — a package manager can exit non-zero on
        // a benign warning yet still install the package (see `engineResolves`). If the
        // Engine landed anyway, treat the install as successful; do NOT fall back to
        // linkEngine, which would overwrite the good install with a Factory symlink (#13).
        if (engineResolves(consumerRoot)) {
          warn(
            `'${pm} add' exited non-zero but @ai-hero/sandcastle resolves under .sandcastle/ — treating as installed\n` +
              `  (likely a benign ${pm} warning, e.g. ignored build scripts; issue #13).`,
          );
        } else if (linkEngine(FACTORY_ROOT, consumerRoot)) {
          // Offline / unknown pm / genuine install failure — link the Engine as a fallback
          // so adoption still lands.
          wiredVia = 'symlink';
          warn(
            `'${pm} add' failed — linked @ai-hero/sandcastle from the Factory clone into .sandcastle/ as a fallback.\n` +
              `  This breaks if the Factory clone moves or is removed; make it permanent with:\n` +
              `    ${pm === 'npm' ? 'npm install' : pm + ' add'} ${engineSpecs.join(' ')}    # run inside .sandcastle/`,
          );
        } else {
          console.error(
            `Engine install failed and the symlink fallback could not be created\n` +
              `(no node_modules/@ai-hero in the Factory — run \`npm install\` there first).\n` +
              `Install @ai-hero/sandcastle in .sandcastle/ manually, then re-run with --force.`,
          );
          process.exit(1);
        }
      }
    }
  } else {
    info('② runtime already resolvable in the consumer — nothing to install.');
  }

  // 3. Ensure the self-contained ESM shim is present (so main.ts transpiles — issue #8).
  //    The shim ships as a tracked `.sandcastle/package.json`, so step 1's copy above
  //    already landed it; this only repairs it in place if a CJS consumer is somehow
  //    missing it (e.g. a partial/stale copy from before this file shipped).
  const shim = join(consumerSandcastle, 'package.json');
  if (consumerRootIsCjs(consumerPkg)) {
    if (!existsSync(shim)) {
      info('③ repair ESM shim .sandcastle/package.json (tracked copy missing; consumer is CJS; issue #8)');
      writeFileSync(shim, JSON.stringify({ type: 'module' }, null, 2) + '\n');
    } else {
      info('③ ESM shim present (shipped with .sandcastle/) — skip.');
    }
  } else {
    info('③ consumer root is already ESM — shim still ships with .sandcastle/ as a belt-and-braces.');
  }

  // 4. Ignore `.sandcastle/` locally without touching the consumer's tracked .gitignore.
  const excludePath = join(consumerRoot, '.git', 'info', 'exclude');
  if (existsSync(excludePath)) {
    const current = readFileSync(excludePath, 'utf8');
    const patch = buildExcludePatch(current);
    if (patch.append) {
      info('④ ignore .sandcastle/ locally (append to .git/info/exclude; tracked .gitignore untouched)');
      writeFileSync(excludePath, current + patch.content);
    } else {
      info('④ .sandcastle/ already ignored in .git/info/exclude — skip.');
    }
  } else {
    warn(
      `No ${excludePath} — could not ignore .sandcastle/ locally (not a git repo, or an unusual layout).\n` +
        '  Add `.sandcastle/` to your .gitignore yourself, or run `git init` first.',
    );
  }

  // 5. Summary + next steps.
  info('\nAdoption complete.');
  info(`  Factory : ${FACTORY_ROOT}`);
  info(`  Consumer: ${consumerRoot}`);
  info(`  Engine  : ${wiredVia === 'symlink' ? 'symlinked from the Factory clone into .sandcastle/ (fallback)' : wiredVia === 'install' ? 'installed under .sandcastle/ (out-of-tree; root package.json untouched)' : 'already resolvable in the consumer'}`);
  if (devToolsFailed) {
    warn(
      '  Dev tools: install FAILED — `npx tsx .sandcastle/main.ts` will not run until you\n' +
        '    install the missing tsx/typescript/@types/node in the consumer.',
    );
  }
  info('\nNext:');
  info('  - Fill in project context (skeletons live in the Factory, not the copy):');
  info('      cp <factory>/templates/CLAUDE.md   <consumer>/CLAUDE.md');
  info('      cp <factory>/templates/CONTEXT.md  <consumer>/CONTEXT.md   # domain glossary (delete if you have none yet)');
  info('  - Configure identity:    $EDITOR <consumer>/.sandcastle/config.ts');
  info('  - Authenticate the host: glab auth login   # or: gh auth login (GitLab vs GitHub)');
  info('      then set `gitHost` in config.ts to match — the loop warns if it disagrees with origin.');
  info('  - Dry-run first:         SANDCASTLE_DRYRUN=1 npx tsx <consumer>/.sandcastle/main.ts');
}

// Run only when invoked directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
