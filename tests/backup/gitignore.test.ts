import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { backupFileName, partialFileName } from '../../src/backup/retention.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * Asks git itself whether it would ignore a path: exit 0 is ignored, 1 is not. Git answers
 * from the repository's real ignore rules, so this cannot pass on a comment or a pattern that
 * looks right and matches nothing, which a test that read `.gitignore` as text could.
 */
async function gitIgnores(path: string): Promise<boolean> {
  const child = Bun.spawn(['git', 'check-ignore', '--quiet', '--', path], { cwd: REPO_ROOT, stdout: 'ignore', stderr: 'ignore' })
  const code = await child.exited
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed with exit code ${code}`)
  return code === 0
}

const NAME = backupFileName(new Date('2026-11-03T09:05:07Z'))

describe('what git ignores, because a dump is the whole search in one file', () => {
  test('a dump written by runDump, in the default directory, is ignored', async () => {
    expect(await gitIgnores(`backups/${NAME}`)).toBe(true)
  })

  test('a partial dump in the default directory is ignored', async () => {
    expect(await gitIgnores(`backups/${partialFileName(NAME)}`)).toBe(true)
  })

  test('a dump and a partial in a directory of the caller\'s choosing are ignored too', async () => {
    expect(await gitIgnores(`elsewhere/${NAME}`)).toBe(true)
    expect(await gitIgnores(`elsewhere/${partialFileName(NAME)}`)).toBe(true)
  })

  test('the check can say no: the backup source is not ignored', async () => {
    expect(await gitIgnores('src/backup/dump.ts')).toBe(false)
    expect(await gitIgnores('scripts/pg_dump-docker.sh')).toBe(false)
  })
})
