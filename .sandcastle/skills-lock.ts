// skills-lock.json machinery — the manifest of record for the Matt Pocock skills
// vendored into the Factory's .claude/skills/.
// See docs/adr/0005-matt-skills-vendored-with-lockfile.md.
//
// The lock pins each vendored skill to a content hash so a drifted or hand-edited
// copy is detectable. This module is engine-free and unit-testable in isolation.
//
// CLI:
//   tsx .sandcastle/skills-lock.ts            # verify .claude/skills against the lock (CI)
//   tsx .sandcastle/skills-lock.ts --update   # regenerate the lock from disk
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One vendored skill, as it appears in skills-lock.json. */
export interface SkillEntry {
  /** Skill directory name, e.g. "implement". */
  readonly name: string;
  /** Category directory, e.g. "engineering" or "productivity". */
  readonly category: string;
  /** Repo-relative path to the skill directory, e.g. ".claude/skills/engineering/implement". */
  readonly path: string;
  /** SHA-256 over the skill directory's contents — changes if any byte in it changes. */
  readonly hash: string;
}

/** Immutable provenance of the vendored skills. */
export interface SkillSource {
  /** Upstream repository the skills were copied from. */
  readonly repo: string;
  /** Plugin name in the marketplace. */
  readonly plugin: string;
  /** Marketplace version the skills were copied from. */
  readonly pluginVersion: string;
}

export interface SkillsManifest {
  readonly source: SkillSource;
  readonly skills: SkillEntry[];
}

export interface VerifyResult {
  readonly ok: boolean;
  /** In both lock and on disk, but the hash differs (the skill was edited). */
  readonly mismatched: SkillEntry[];
  /** In the lock but not on disk (the skill was removed). */
  readonly missing: SkillEntry[];
  /** On disk but not in the lock (an untracked skill appeared). */
  readonly extra: SkillEntry[];
}

/** The file whose presence makes a directory a skill. */
const SKILL_MARKER = 'SKILL.md';

/** Stable identity for a skill across lock and disk: `<category>/<name>`. */
function skillKey(e: Pick<SkillEntry, 'category' | 'name'>): string {
  return `${e.category}/${e.name}`;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic SHA-256 over every file under `dir`. Files are walked
 * recursively, sorted by their path relative to `dir` (POSIX-normalised, so the
 * result is identical on any OS and regardless of fs iteration order), and fed
 * to the hash as `<relpath>\0<contents>`. An empty directory hashes to the
 * SHA-256 of the empty string.
 */
export function hashSkillDir(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(abs);
    }
  };
  if (existsSync(dir)) walk(dir);

  files.sort((a, b) => normalizeRel(a, dir).localeCompare(normalizeRel(b, dir)));

  const h = createHash('sha256');
  for (const abs of files) {
    h.update(normalizeRel(abs, dir));
    h.update('\0');
    h.update(readFileSync(abs));
  }
  return h.digest('hex');
}

/** Relative path with platform separators normalised to '/'. */
function normalizeRel(abs: string, base: string): string {
  return relative(base, abs).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Walk a skills root (e.g. `.claude/skills`) of the shape `<category>/<skill>/SKILL.md`.
 * Only directories that contain a `SKILL.md` are treated as skills; category-level
 * files (README, etc.) are ignored. `rootRel` is the repo-relative path to the
 * skills root, used only to build each entry's `path`.
 */
export function scanSkills(skillsRoot: string, rootRel: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (!existsSync(skillsRoot)) return entries;

  for (const category of dirsOnly(skillsRoot)) {
    const categoryDir = join(skillsRoot, category);
    for (const name of dirsOnly(categoryDir)) {
      const skillDir = join(categoryDir, name);
      if (!existsSync(join(skillDir, SKILL_MARKER))) continue; // not a skill
      entries.push({
        name,
        category,
        path: `${rootRel}/${category}/${name}`,
        hash: hashSkillDir(skillDir),
      });
    }
  }
  return entries;
}

/** Names of immediate subdirectories of `dir`, sorted. */
function dirsOnly(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Manifest build / verify
// ---------------------------------------------------------------------------

/** Assemble a manifest from source metadata + scanned entries, sorted for a stable diff. */
export function buildManifest(source: SkillSource, entries: SkillEntry[]): SkillsManifest {
  const skills = [...entries].sort((a, b) => skillKey(a).localeCompare(skillKey(b)));
  return { source, skills };
}

/**
 * Compare a locked manifest to what is on disk under `skillsRoot`. Identity is
 * `<category>/<name>` (`skillKey`); the `path` field is for human readers, so
 * `rootRel` is passed through so freshly-scanned `extra` entries report the same
 * repo-relative path the lock uses. `ok` is true only when lock and disk agree
 * exactly (no edits, removals, or additions).
 */
export function verifyManifest(
  manifest: SkillsManifest,
  skillsRoot: string,
  rootRel: string,
): VerifyResult {
  const onDisk = new Map(scanSkills(skillsRoot, rootRel).map((e) => [skillKey(e), e]));
  const locked = new Map(manifest.skills.map((e) => [skillKey(e), e]));

  const mismatched: SkillEntry[] = [];
  const missing: SkillEntry[] = [];
  const extra: SkillEntry[] = [];

  for (const [key, lockEntry] of locked) {
    const diskEntry = onDisk.get(key);
    if (diskEntry === undefined) missing.push(lockEntry);
    else if (diskEntry.hash !== lockEntry.hash) mismatched.push(lockEntry);
  }
  for (const [key, diskEntry] of onDisk) {
    if (!locked.has(key)) extra.push(diskEntry);
  }

  return { ok: mismatched.length + missing.length + extra.length === 0, mismatched, missing, extra };
}

// ---------------------------------------------------------------------------
// CLI — verify (default) or regenerate (--update)
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const SKILLS_ROOT_REL = '.claude/skills';
const LOCK_PATH = join(ROOT, 'skills-lock.json');

// Provenance of the vendored skills. `pluginVersion` is the installed marketplace
// version (the plugin cache dir these skills were copied from); the plugin's own
// inner package.json lags at 1.1.0, so the marketplace version is the source of
// truth. `--update` preserves any `source` already in the lock, so a manual
// correction here or in skills-lock.json is not silently overwritten on refresh.
const DEFAULT_SOURCE: SkillSource = {
  repo: 'https://github.com/mattpocock/skills',
  plugin: 'mattpocock-skills',
  pluginVersion: '1.2.0',
};

/** Render a manifest as the on-disk JSON (2-space indent, trailing newline). */
function render(manifest: SkillsManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Read the `source` block from an existing lock, or null if there is none. */
function readExistingSource(lockPath: string): SkillSource | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<SkillsManifest>;
    const s = parsed.source;
    if (s && typeof s.repo === 'string' && typeof s.plugin === 'string' && typeof s.pluginVersion === 'string') {
      return s;
    }
  } catch {
    // A corrupt or partial lock falls back to DEFAULT_SOURCE on --update.
  }
  return null;
}

function main(): void {
  const update = process.argv.slice(2).includes('--update');
  const entries = scanSkills(SKILLS_DIR, SKILLS_ROOT_REL);

  if (entries.length === 0) {
    console.error(`No skills found under ${SKILLS_ROOT_REL}/ (expected <category>/<skill>/SKILL.md).`);
    process.exit(1);
  }

  if (update) {
    // Preserve an existing lock's source so a manual provenance fix survives a refresh.
    const source = readExistingSource(LOCK_PATH) ?? DEFAULT_SOURCE;
    const manifest = buildManifest(source, entries);
    writeFileSync(LOCK_PATH, render(manifest), 'utf8');
    console.log(`Wrote ${relative(ROOT, LOCK_PATH)} (${manifest.skills.length} skills).`);
    return;
  }

  if (!existsSync(LOCK_PATH)) {
    console.error(`No lock at ${relative(ROOT, LOCK_PATH)}. Run with --update to create one.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as SkillsManifest;
  const result = verifyManifest(manifest, SKILLS_DIR, SKILLS_ROOT_REL);
  if (result.ok) {
    console.log(`skills-lock OK — ${manifest.skills.length} skills, all hashes match.`);
    return;
  }
  for (const e of result.mismatched) console.error(`changed   ${e.path}`);
  for (const e of result.missing) console.error(`missing   ${e.path}`);
  for (const e of result.extra) console.error(`untracked ${e.path}`);
  console.error(`\nskills-lock FAILED — re-run with --update if the changes are intended.`);
  process.exit(1);
}

// Run only when invoked directly, not when imported by the test suite.
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
