import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFrontmatter } from '../../src/discovery/frontmatter.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillDir = join(repoRoot, 'skills', 'pfl');

/** Walk a directory recursively and collect SKILL.md paths. */
async function findSkillMds(dir: string, skip: Set<string>): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || skip.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findSkillMds(fullPath, skip)));
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  } catch {
    // unreadable — skip
  }
  return results;
}

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('skill package', () => {
  it('has valid frontmatter in skills/pfl/SKILL.md', async () => {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
    const { facts, malformed } = readFrontmatter(content);

    expect(malformed).toBe(false);
    expect(facts.hasFrontmatter).toBe(true);
    expect(facts.keys).toContain('name');
    expect(facts.keys).toContain('description');
    expect(facts.descriptionLength).toBeGreaterThan(0);
    expect(facts.descriptionLength).toBeLessThanOrEqual(1024);

    // Extract name from frontmatter lines for value checks.
    const lines = content.split('\n');
    const nameLine = lines.find((l) => /^\s*name\s*:/.test(l));
    expect(nameLine).toBeDefined();
    const name = nameLine?.replace(/^\s*name\s*:\s*/, '').trim() ?? '';

    expect(name).toBe('pfl');
    expect(name).toBe(basename(skillDir));
    expect(name).toMatch(KEBAB_CASE);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('skill directory has no README.md or _-prefixed entries', async () => {
    const entries = await readdir(skillDir, { withFileTypes: true });
    const topLevel = entries.filter((e) => e.name !== '.DS_Store');
    const names = topLevel.map((e) => e.name);

    expect(names).not.toContain('README.md');
    for (const name of names) {
      expect(name.startsWith('_')).toBe(false);
    }
  });

  it('no SKILL.md exists outside test/fixtures and skills/pfl', async () => {
    const skip = new Set(['coverage', 'dist', 'graft', '.letta', '.worktrees', '.github']);
    const allSkillMds = await findSkillMds(repoRoot, skip);
    const outsideFixtures = allSkillMds.filter((p) => !p.includes(`${join('test', 'fixtures')}`));

    expect(outsideFixtures).toEqual([join(skillDir, 'SKILL.md')]);
  });

  it('no root SKILL.md exists', async () => {
    let exists = false;
    try {
      await stat(join(repoRoot, 'SKILL.md'));
      exists = true;
    } catch {
      // expected
    }
    expect(exists).toBe(false);
  });
});
