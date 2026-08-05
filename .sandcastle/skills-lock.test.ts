// Contract tests for the skills-lock machinery: deterministic per-skill hashing,
// directory scan, manifest build, and lock-vs-disk verification.
// Pure fixtures (node:os temp dirs) — no repo paths, no network, no real skills.
// Run: npx tsx .sandcastle/skills-lock.test.ts
//
// See docs/adr/0005-matt-skills-vendored-with-lockfile.md.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  hashSkillDir,
  scanSkills,
  buildManifest,
  verifyManifest,
  type SkillEntry,
} from './skills-lock.ts';

import { test, finish } from './test-harness.ts';

// ---------------------------------------------------------------------------
// Fixture helpers — a tiny pretend skills tree.
// ---------------------------------------------------------------------------

/** Make a fresh temp skills root with the given category/skill/file layout. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sf-skills-'));
}

/** Write a skill dir with SKILL.md + optional extra files. */
function writeSkill(
  root: string,
  category: string,
  name: string,
  files: Record<string, string> = { 'SKILL.md': '# ' + name },
): string {
  const dir = join(root, category, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// hashSkillDir
// ---------------------------------------------------------------------------

test('hashSkillDir is deterministic — same contents, same hash', () => {
  const root = makeRoot();
  try {
    const a = writeSkill(root, 'engineering', 'implement', {
      'SKILL.md': '# implement',
      'tests.md': 'body',
    });
    const b = writeSkill(root, 'engineering', 'code-review', {
      'SKILL.md': '# implement',
      'tests.md': 'body',
    });
    assert.equal(hashSkillDir(a), hashSkillDir(b));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashSkillDir changes when a file content changes', () => {
  const root = makeRoot();
  try {
    const dir = writeSkill(root, 'engineering', 'implement', {
      'SKILL.md': '# implement v1',
    });
    const before = hashSkillDir(dir);
    writeFileSync(join(dir, 'SKILL.md'), '# implement v2', 'utf8');
    const after = hashSkillDir(dir);
    assert.notEqual(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashSkillDir changes when a file is added or removed', () => {
  const root = makeRoot();
  try {
    const dir = writeSkill(root, 'engineering', 'implement', {
      'SKILL.md': '# implement',
    });
    const one = hashSkillDir(dir);
    writeFileSync(join(dir, 'extra.md'), 'extra', 'utf8');
    const two = hashSkillDir(dir);
    assert.notEqual(one, two);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashSkillDir is order-independent — fs iteration order does not matter', () => {
  // Two skills with the same files written in different orders hash the same.
  const root = makeRoot();
  try {
    const a = writeSkill(root, 'engineering', 'a', {
      'SKILL.md': '# a',
      'z.md': 'z',
      'm.md': 'm',
    });
    const b = writeSkill(root, 'engineering', 'b', {
      'm.md': 'm',
      'z.md': 'z',
      'SKILL.md': '# a',
    });
    assert.equal(hashSkillDir(a), hashSkillDir(b));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashSkillDir is a 64-char lowercase hex sha256', () => {
  const root = makeRoot();
  try {
    const dir = writeSkill(root, 'engineering', 'implement');
    assert.match(hashSkillDir(dir), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashSkillDir does not crash on an empty directory', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, 'engineering', 'empty'), { recursive: true });
    assert.match(hashSkillDir(join(root, 'engineering', 'empty')), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanSkills
// ---------------------------------------------------------------------------

test('scanSkills finds skills nested under category dirs and reports path/name/category/hash', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    writeSkill(root, 'productivity', 'grilling', {
      'SKILL.md': '# grilling',
    });
    const entries = scanSkills(root, '.claude/skills');
    assert.equal(entries.length, 2);

    const byName = Object.fromEntries(entries.map((e) => [e.name, e])) as Record<
      string,
      SkillEntry
    >;
    assert.equal(byName.implement.category, 'engineering');
    assert.equal(byName.implement.path, '.claude/skills/engineering/implement');
    assert.match(byName.implement.hash, /^[0-9a-f]{64}$/);
    assert.equal(byName.grilling.category, 'productivity');
    assert.equal(byName.grilling.path, '.claude/skills/productivity/grilling');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanSkills ignores category-level files (README) and only descends into skill dirs with SKILL.md', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    writeFileSync(join(root, 'engineering', 'README.md'), '# engineering', 'utf8'); // not a skill
    const entries = scanSkills(root, '.claude/skills');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'implement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanSkills returns an empty array when no skills are present', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, 'engineering'), { recursive: true });
    assert.deepEqual(scanSkills(root, '.claude/skills'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

test('buildManifest wires source metadata onto a sorted skill list', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    writeSkill(root, 'engineering', 'code-review');
    const entries = scanSkills(root, '.claude/skills');
    const manifest = buildManifest(
      { repo: 'https://github.com/mattpocock/skills', plugin: 'mattpocock-skills', pluginVersion: '1.2.0' },
      entries,
    );
    assert.equal(manifest.source.repo, 'https://github.com/mattpocock/skills');
    assert.equal(manifest.source.pluginVersion, '1.2.0');
    assert.equal(manifest.skills.length, 2);
    // Skills are sorted for a stable, reviewable diff.
    const names = manifest.skills.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// verifyManifest
// ---------------------------------------------------------------------------

test('verifyManifest is ok when disk matches the lock exactly', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    writeSkill(root, 'productivity', 'grilling');
    const manifest = buildManifest(
      { repo: 'r', plugin: 'p', pluginVersion: '1' },
      scanSkills(root, '.claude/skills'),
    );
    const result = verifyManifest(manifest, root, '.claude/skills');
    assert.equal(result.ok, true);
    assert.deepEqual(result.mismatched, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyManifest flags an edited skill as mismatched', () => {
  const root = makeRoot();
  try {
    const dir = writeSkill(root, 'engineering', 'implement', { 'SKILL.md': '# v1' });
    const manifest = buildManifest(
      { repo: 'r', plugin: 'p', pluginVersion: '1' },
      scanSkills(root, '.claude/skills'),
    );
    writeFileSync(join(dir, 'SKILL.md'), '# v2', 'utf8'); // edit after lock
    const result = verifyManifest(manifest, root, '.claude/skills');
    assert.equal(result.ok, false);
    assert.equal(result.mismatched.length, 1);
    assert.equal(result.mismatched[0].name, 'implement');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyManifest flags a lock entry whose skill is gone as missing', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    writeSkill(root, 'engineering', 'code-review');
    const manifest = buildManifest(
      { repo: 'r', plugin: 'p', pluginVersion: '1' },
      scanSkills(root, '.claude/skills'),
    );
    rmSync(join(root, 'engineering', 'code-review'), { recursive: true, force: true });
    const result = verifyManifest(manifest, root, '.claude/skills');
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].name, 'code-review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyManifest flags a skill on disk that the lock does not know as extra', () => {
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement'); // only this one is locked
    const manifest = buildManifest(
      { repo: 'r', plugin: 'p', pluginVersion: '1' },
      scanSkills(root, '.claude/skills'),
    );
    writeSkill(root, 'engineering', 'surprise'); // added after lock
    const result = verifyManifest(manifest, root, '.claude/skills');
    assert.equal(result.ok, false);
    assert.equal(result.extra.length, 1);
    assert.equal(result.extra[0].name, 'surprise');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyManifest reports an extra skill with a correct repo-relative path', () => {
  // Regression: extras are scanned from disk, so their `path` must use the same
  // rootRel as locked entries — not a malformed leading-slash '/engineering/...'.
  const root = makeRoot();
  try {
    writeSkill(root, 'engineering', 'implement');
    const manifest = buildManifest(
      { repo: 'r', plugin: 'p', pluginVersion: '1' },
      scanSkills(root, '.claude/skills'),
    );
    writeSkill(root, 'productivity', 'surprise');
    const result = verifyManifest(manifest, root, '.claude/skills');
    assert.equal(result.extra.length, 1);
    assert.equal(result.extra[0].path, '.claude/skills/productivity/surprise');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

finish();
