import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { CriteriaSetConflictError } from '../../src/data/schema/criteria.ts'
import { ArchivedError, BulkItemError, ConflictError, NotFoundError } from '../../src/errors.ts'
import { errorResult, okResult, unwrapSingleItem } from '../../src/mcp/result.ts'

/** What a Postgres driver fault looks like: the failed statement and the constraint it names. */
function driverFault(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "positions_position_key_unique"'),
    {
      query: 'insert into "positions" ("position_key", "title") values ($1, $2)',
      constraint_name: 'positions_position_key_unique',
      detail: 'Key (position_key)=(acme-dev) already exists.',
    },
  )
}

function textOf(result: ReturnType<typeof errorResult>): string {
  const [first] = result.content
  if (first?.type !== 'text') throw new Error('expected a text block')
  return first.text
}

describe('okResult', () => {
  test('okResult carries the value as JSON text', () => {
    const result = okResult({ id: 7, tags: ['a'] })

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '{"id":7,"tags":["a"]}' }])
  })

  test('okResult sends undefined as null, because a text block needs a string', () => {
    expect(okResult(undefined).content).toEqual([{ type: 'text', text: 'null' }])
  })

  test('okResult sends a Date as its ISO string', () => {
    const text = okResult({ at: new Date('2026-11-03T10:00:00.000Z') }).content[0]
    expect(text).toEqual({ type: 'text', text: '{"at":"2026-11-03T10:00:00.000Z"}' })
  })

  test('okResult throws on a value JSON cannot hold, so the handler can turn it into an error', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    expect(() => okResult({ n: 1n })).toThrow(TypeError)
    expect(() => okResult(cycle)).toThrow(TypeError)
  })
})

describe('errorResult', () => {
  test('errorResult names a NotFoundError and sets isError', () => {
    const result = errorResult(new NotFoundError('position', 7))

    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: { name: 'NotFoundError', message: 'position 7 does not exist' },
    })
  })

  test('errorResult names a ConflictError by its message', () => {
    const result = errorResult(new ConflictError('position_key', 'acme-dev'))

    expect(JSON.parse(textOf(result))).toEqual({
      error: { name: 'ConflictError', message: 'position_key acme-dev already exists' },
    })
  })

  test('errorResult catches a CriteriaSetConflictError through ConflictError and keeps its own name', () => {
    const result = errorResult(new CriteriaSetConflictError('acme', 1))

    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).error.name).toBe('CriteriaSetConflictError')
  })

  test('errorResult names an ArchivedError', () => {
    expect(JSON.parse(textOf(errorResult(new ArchivedError('route', 3))))).toEqual({
      error: { name: 'ArchivedError', message: 'route 3 is archived' },
    })
  })

  test('errorResult names a BulkItemError with its index and nothing of its cause', () => {
    const result = errorResult(new BulkItemError(2, new NotFoundError('route', 9)))

    expect(JSON.parse(textOf(result))).toEqual({
      error: { name: 'BulkItemError', message: 'bulk item 2 failed' },
    })
  })

  test('errorResult leaks neither the SQL nor the constraint name of a ConflictError cause', () => {
    const conflict = new ConflictError('position_key', 'acme-dev', { cause: driverFault() })

    const text = JSON.stringify(errorResult(conflict))

    expect(text).toContain('position_key acme-dev already exists')
    expect(text).not.toContain('insert into')
    expect(text).not.toContain('positions_position_key_unique')
    expect(text).not.toContain('constraint')
    expect(text).not.toContain('cause')
  })

  test('errorResult leaks nothing of a driver fault that sits under a BulkItemError and a NotFoundError', () => {
    const notFound = new NotFoundError('route', 4, { cause: driverFault() })

    const text = JSON.stringify(errorResult(new BulkItemError(0, notFound)))

    expect(text).not.toContain('insert into')
    expect(text).not.toContain('positions_position_key_unique')
  })

  test('errorResult hides an unknown error behind "internal error"', () => {
    const result = errorResult(new Error('connect ECONNREFUSED on port 5439'))

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('5439')
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED')
    expect(JSON.parse(textOf(result))).toEqual({
      error: { name: 'InternalError', message: 'internal error' },
    })
  })

  test('errorResult shows no detail of a subclass of Error it does not know', () => {
    class DriverError extends Error {
      override name = 'PostgresError'
    }

    const text = JSON.stringify(errorResult(new DriverError('password authentication failed')))

    expect(text).not.toContain('PostgresError')
    expect(text).not.toContain('password')
  })

  test.each([
    ['a thrown string', 'postgres://user:secret@/db'],
    ['null', null],
    ['an object', { message: 'postgres://user:secret@/db' }],
  ])('errorResult reduces %s to internal error', (_label, thrown) => {
    const text = JSON.stringify(errorResult(thrown))

    expect(text).not.toContain('secret')
    expect(text).toContain('internal error')
  })

  test('errorResult reduces a ZodError to internal error, because the SDK parses the input before run is reached', () => {
    const parsed = z.strictObject({ id: z.number() }).safeParse({ id: 'x' })
    if (parsed.success) throw new Error('expected the parse to fail')

    const text = JSON.stringify(errorResult(parsed.error))

    expect(text).toContain('internal error')
    expect(text).not.toContain('invalid_type')
  })
})

describe('unwrapSingleItem', () => {
  test('unwrapSingleItem returns the cause of a BulkItemError at index 0', () => {
    const real = new NotFoundError('position', 7)

    expect(unwrapSingleItem(new BulkItemError(0, real))).toBe(real)
  })

  test('unwrapSingleItem leaves a BulkItemError at another index unchanged', () => {
    const failure = new BulkItemError(1, new NotFoundError('position', 7))

    expect(unwrapSingleItem(failure)).toBe(failure)
  })

  test('unwrapSingleItem leaves any other error and any non-error unchanged', () => {
    const plain = new ConflictError('position_key', 'acme-dev')

    expect(unwrapSingleItem(plain)).toBe(plain)
    expect(unwrapSingleItem('text')).toBe('text')
    expect(unwrapSingleItem(undefined)).toBeUndefined()
  })
})
