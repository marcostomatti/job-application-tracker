import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills?: string }

/** Exit 0 is ignored, 1 is not; git answers from the real rules, as in tests/backup/gitignore.test.ts. */
async function gitIgnores(path: string): Promise<boolean> {
  const child = Bun.spawn(['git', 'check-ignore', '--quiet', '--', path], { cwd: REPO_ROOT, stdout: 'ignore', stderr: 'ignore' })
  const code = await child.exited
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed with exit code ${code}`)
  return code === 0
}

describe('the plugin skills', () => {
  test('the manifest points at the skills directory', () => {
    expect(MANIFEST.skills).toBe('./.claude-plugin/skills/')
  })

  const skillsDir = join(REPO_ROOT, MANIFEST.skills ?? '')
  const committed = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('personal-'))
    .map((entry) => entry.name)

  test('the five committed skills are there', () => {
    expect(committed.sort()).toEqual(['criteria-weighting', 'notebook-store-postings', 'past-work-gates-and-flags', 'recommendation-verdicts', 'scoring-questions'])
  })

  for (const name of committed) {
    test(`${name} has frontmatter whose name is its directory, and a description`, () => {
      const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
      expect(frontmatter).toContain(`name: ${name}\n`)
      expect(frontmatter).toMatch(/^description: .{40,}$/m)
    })
  }

  test('a personal variant is ignored by git, in the plugin and in the project skills', async () => {
    expect(await gitIgnores('.claude-plugin/skills/personal-criteria/SKILL.md')).toBe(true)
    expect(await gitIgnores('.claude/skills/personal-criteria/SKILL.md')).toBe(true)
  })

  test('the check can say no: a committed skill is not ignored', async () => {
    expect(await gitIgnores('.claude-plugin/skills/criteria-weighting/SKILL.md')).toBe(false)
  })
})
