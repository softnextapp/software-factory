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
import { dirname, join, resolve } from 'node:path';
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

// ---------------------------------------------------------------------------
// Side-effecting helpers (used by main only)
// ---------------------------------------------------------------------------

function readPkg(root: string): string | null {
  const p = join(root, 'package.json');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Fallback used only when `<pm> add` fails: link the Engine out of the Factory clone
 * so adoption still succeeds offline. Returns false if the Factory has no installed
 * `node_modules/@ai-hero` to link (operator must `npm install` the Factory first). */
function linkEngine(factoryRoot: string, consumerRoot: string): boolean {
  const src = join(factoryRoot, 'node_modules', '@ai-hero');
  const destParent = join(consumerRoot, 'node_modules');
  const dest = join(destParent, '@ai-hero');
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

/** Does the Engine resolve in the consumer's OWN tree? Used to tell a benign non-zero
 * install exit from a genuine failure, so adopt does not clobber a good install with the
 * linkEngine fallback (issue #13): pnpm v11 exits non-zero on ERR_PNPM_IGNORED_BUILDS
 * (unapproved native build scripts, e.g. esbuild via tsx) even when the package installed
 * fine. The Engine is a direct dep, so it lives at the consumer's top-level node_modules
 * (npm's real dir, or pnpm's symlink into the store — `existsSync` follows it). Resolving
 * the bare specifier would trip the Engine's ESM-only exports map, so check its manifest. */
function engineResolves(consumerRoot: string): boolean {
  return existsSync(join(consumerRoot, 'node_modules', '@ai-hero', 'sandcastle', 'package.json'));
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

  // 2. Wire the Factory runtime (Engine + dev tools) into the consumer.
  const consumerPkg = readPkg(consumerRoot);
  const missing = computeMissing(runtime, consumerPkg);
  const missingDepSpecs = toSpecs(missing.deps);
  const missingDevSpecs = toSpecs(missing.devDeps);
  let wiredVia: 'install' | 'symlink' | 'present' = 'present';
  if (missingDepSpecs.length || missingDevSpecs.length) {
    const pm = detectPackageManager(readdirSync(consumerRoot));
    // Clear a stale foreign `@ai-hero` symlink (linkEngine fallback / manual workaround)
    // BEFORE installing — otherwise `<pm> add` writes through it into another tree and
    // the Engine ends up declared yet unresolvable (issue #11). A real dir is the
    // package manager's own layout and is left alone. `lstatSync` (not stat) so a symlink
    // is seen as a symlink, not the target's dir.
    const aiHero = join(consumerRoot, 'node_modules', '@ai-hero');
    if (shouldClearEngineLink(existsSync(aiHero) ? lstatSync(aiHero) : null)) {
      info('② clear stale @ai-hero symlink (foreign link; issue #11) before install');
      rmSync(aiHero, { recursive: true, force: true });
    }
    try {
      if (missingDepSpecs.length) {
        info(`② install runtime deps (${pm}): ${missingDepSpecs.join(', ')}`);
        execFileSync(pm, pmAddArgs(pm, missingDepSpecs, false), { cwd: consumerRoot, stdio: 'inherit' });
      }
      if (missingDevSpecs.length) {
        info(`② install runtime devDeps (${pm} -D): ${missingDevSpecs.join(', ')}`);
        execFileSync(pm, pmAddArgs(pm, missingDevSpecs, true), { cwd: consumerRoot, stdio: 'inherit' });
      }
      wiredVia = 'install';
    } catch {
      // A non-zero exit is not always failure — a package manager can exit non-zero on
      // a benign warning yet still install the package (see `engineResolves`). If the
      // Engine landed anyway, treat the install as successful; do NOT fall back to
      // linkEngine, which would overwrite the good install with a Factory symlink (#13).
      if (engineResolves(consumerRoot)) {
        wiredVia = 'install';
        warn(
          `'${pm} add' exited non-zero but @ai-hero/sandcastle resolves in the consumer — treating as installed\n` +
            `  (likely a benign ${pm} warning, e.g. ignored build scripts; issue #13).`,
        );
      } else if (linkEngine(FACTORY_ROOT, consumerRoot)) {
        // Offline / unknown pm / genuine install failure — link the Engine as a fallback
        // so adoption still lands. Only @ai-hero can be meaningfully symlinked; tsx/
        // typescript are left to the consumer (most TS projects already have them).
        wiredVia = 'symlink';
        const allSpecs = [...missingDepSpecs, ...missingDevSpecs];
        warn(
          `'${pm} add' failed — linked @ai-hero/sandcastle from the Factory clone as a fallback.\n` +
            `  This breaks if the Factory clone moves or is removed; make it permanent with:\n` +
            `    ${pm === 'npm' ? 'npm install' : pm + ' add'}${missingDevSpecs.length ? ' -D' : ''} ${allSpecs.join(' ')}`,
        );
      } else {
        console.error(
          `Package-manager install failed and the Engine symlink fallback could not be created\n` +
            `(no node_modules/@ai-hero in the Factory — run \`npm install\` there first).\n` +
            `Install the runtime in the consumer manually, then re-run with --force.`,
        );
        process.exit(1);
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
  info(`  Engine  : ${wiredVia === 'symlink' ? 'symlinked from the Factory clone (fallback)' : wiredVia === 'install' ? 'installed into the consumer' : 'already present in the consumer'}`);
  info('\nNext:');
  info('  - Fill in project context (skeletons live in the Factory, not the copy):');
  info('      cp <factory>/templates/CLAUDE.md   <consumer>/CLAUDE.md');
  info('      cp <factory>/templates/CONTEXT.md  <consumer>/CONTEXT.md   # domain glossary (delete if you have none yet)');
  info('  - Configure identity:    $EDITOR <consumer>/.sandcastle/config.ts');
  info('  - Authenticate the host: glab auth login   (glab is the only host wired in v0.1)');
  info('  - Dry-run first:         SANDCASTLE_DRYRUN=1 npx tsx <consumer>/.sandcastle/main.ts');
}

// Run only when invoked directly, not when imported by the test suite.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
