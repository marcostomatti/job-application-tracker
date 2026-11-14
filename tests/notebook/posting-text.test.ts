import { afterEach, describe, expect, test } from 'bun:test'

import { NotebookUnavailableError } from '../../src/errors.ts'
import { NotebookClient } from '../../src/notebook/client.ts'
import { postingText } from '../../src/notebook/posting-text.ts'
import { startStubNotebook, type StubServer } from './stub-server.ts'

const KEY = 'example-ab/backend-engineer'

let stub: StubServer | undefined

afterEach(async () => {
  await stub?.stop()
  stub = undefined
})

async function clientWith(sources: Array<{ title: string; content: string }>): Promise<NotebookClient> {
  stub = startStubNotebook({ password: 'pw' })
  const client = new NotebookClient({ url: stub.url, apiKey: 'pw' })
  const notebook = await client.createNotebook({ name: 'Postings', description: '' })
  for (const source of sources) await client.addTextSource({ ...source, notebookIds: [notebook.id], embed: false })
  return client
}

describe('postingText', () => {
  test('without a notebook configured it says so, and asks nothing', async () => {
    expect(await postingText(undefined, KEY)).toEqual({ configured: false })
  })

  test('reads the text of the source titled with the posting key', async () => {
    const client = await clientWith([
      { title: 'example-cd/platform-lead', content: 'another posting' },
      { title: KEY, content: 'the full posting text' },
    ])

    const found = await postingText(client, KEY)

    expect(found).toMatchObject({ configured: true, postingKey: KEY, copies: 1, text: 'the full posting text', totalChars: 21, truncated: false })
    expect(found.configured && found.source?.title).toBe(KEY)
  })

  test('with several copies it reads the newest and counts them all', async () => {
    const client = await clientWith([
      { title: KEY, content: 'old text' },
      { title: KEY, content: 'new text' },
    ])

    const found = await postingText(client, KEY)

    expect(found).toMatchObject({ copies: 2, text: 'new text' })
  })

  test('no source with that title is no text, not an error', async () => {
    const client = await clientWith([{ title: 'example-cd/platform-lead', content: 'another posting' }])

    expect(await postingText(client, KEY)).toMatchObject({ configured: true, postingKey: KEY, copies: 0, source: null, text: null })
  })

  test('a long text is cut at the cap and says so', async () => {
    const client = await clientWith([{ title: KEY, content: 'x'.repeat(50) }])

    expect(await postingText(client, KEY, 20)).toMatchObject({ text: 'x'.repeat(20), totalChars: 50, truncated: true })
  })

  test('a notebook that does not answer is an unavailable error', async () => {
    const client = await clientWith([])
    await stub?.stop()

    await expect(postingText(client, KEY)).rejects.toBeInstanceOf(NotebookUnavailableError)
  })
})
