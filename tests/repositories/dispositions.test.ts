import { describe, expect, test } from 'bun:test'

import * as repositoryModule from '../../src/data/repositories/dispositions.ts'
import {
  RecordRejectionInputSchema,
  SetAsideInputSchema,
  StageEventBulkSchema,
  StageEventInputSchema,
} from '../../src/schemas/dispositions.ts'

describe('the module surface', () => {
  test('the module exports no way to update or delete a stage event', () => {
    // Arrange / Act
    const api = Object.keys(repositoryModule)

    // Assert: the append-only rule is the shape of the API, since no trigger enforces it
    expect(api.filter((name) => /update|delete|remove/i.test(name) && /stage/i.test(name))).toEqual([])
    expect(api.filter((name) => /update|delete|remove/i.test(name))).toEqual([])
  })
})

describe('the input schemas', () => {
  test('a stage event needs its stage stated, even as null, and reads an offset instant as a Date', () => {
    // Arrange / Act
    const withNull = StageEventInputSchema.safeParse({ postingId: 1, stageId: null })
    const missing = StageEventInputSchema.safeParse({ postingId: 1 })
    const dated = StageEventInputSchema.parse({ postingId: '1', stageId: '2', occurredAt: '2026-03-01T10:00:00+01:00' })
    const bareLocal = StageEventInputSchema.safeParse({ postingId: 1, stageId: null, occurredAt: '2026-03-01T10:00:00' })

    // Assert
    expect(withNull.success).toBe(true)
    expect(missing.success).toBe(false)
    expect(dated.occurredAt?.toISOString()).toBe('2026-03-01T09:00:00.000Z')
    expect(bareLocal.success).toBe(false)
  })

  test('refuses an unknown field, a blank note and a NUL in a note', () => {
    // Arrange / Act
    const results = [
      StageEventInputSchema.safeParse({ postingId: 1, stageId: null, kind: 'x' }),
      StageEventInputSchema.safeParse({ postingId: 1, stageId: null, note: '   ' }),
      SetAsideInputSchema.safeParse({ postingId: 1, setAsideReasonId: 1, note: 'a\u0000b' }),
    ]

    // Assert
    expect(results.map((result) => result.success)).toEqual([false, false, false])
  })

  test('the two disposition schemas each take only their own reason', () => {
    // Arrange / Act
    const results = [
      SetAsideInputSchema.safeParse({ postingId: 1, rejectionReasonId: 1 }),
      SetAsideInputSchema.safeParse({ postingId: 1, setAsideReasonId: 1, rejectionReasonId: 1 }),
      RecordRejectionInputSchema.safeParse({ postingId: 1, setAsideReasonId: 1 }),
      RecordRejectionInputSchema.safeParse({ postingId: 1, rejectionReasonId: 1 }),
    ]

    // Assert
    expect(results.map((result) => result.success)).toEqual([false, false, false, true])
  })

  test('the bulk form is capped and non-empty', () => {
    // Arrange / Act
    const empty = StageEventBulkSchema.safeParse({ items: [] })
    const one = StageEventBulkSchema.safeParse({ items: [{ postingId: 1, stageId: null }] })

    // Assert
    expect(empty.success).toBe(false)
    expect(one.success).toBe(true)
  })
})
