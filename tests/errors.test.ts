import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'

import { CriteriaSetConflictError } from '../src/data/schema/criteria.ts'
import {
  ArchivedError,
  BulkItemError,
  ConflictError,
  NotFoundError,
  statusFor,
} from '../src/errors.ts'

describe('statusFor', () => {
  test('statusFor maps each error class to its status', () => {
    expect(statusFor(new NotFoundError('position', 7))).toBe(404)
    expect(statusFor(new ConflictError('position_key', 'acme-dev'))).toBe(409)
    expect(statusFor(new ArchivedError('route', 3))).toBe(409)
    expect(statusFor(new BulkItemError(2, new Error('boom')))).toBe(400)
    expect(statusFor(new ZodError([]))).toBe(400)
  })

  test('statusFor maps a duplicate criteria set to 409', () => {
    expect(statusFor(new CriteriaSetConflictError('acme', 1))).toBe(409)
  })

  test('statusFor sends an unknown error to 500', () => {
    expect(statusFor(new Error('connect ECONNREFUSED 127.0.0.1:5439'))).toBe(500)
  })

  test('statusFor sends a thrown non-Error value to 500', () => {
    expect(statusFor('postgres://user:secret@host/db')).toBe(500)
  })
})

describe('error messages', () => {
  test('NotFoundError names the entity and the id without a query', () => {
    const error = new NotFoundError('position', 7)
    expect(error.message).toBe('position 7 does not exist')
    expect(error.message).not.toContain('select')
  })

  test('ConflictError names the key and not the cause', () => {
    const error = new ConflictError('position_key', 'acme-dev')
    expect(error.message).toBe('position_key acme-dev already exists')
    expect(error.name).toBe('ConflictError')
  })

  test('ArchivedError names the entity and the id', () => {
    const error = new ArchivedError('route', 3)
    expect(error.message).toBe('route 3 is archived')
    expect(error.name).toBe('ArchivedError')
  })

  test('BulkItemError reports the index and keeps the cause out of the message', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5439')
    const error = new BulkItemError(2, cause)
    expect(error.index).toBe(2)
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('bulk item 2 failed')
    expect(error.message).not.toContain('ECONNREFUSED')
    expect(error.name).toBe('BulkItemError')
  })
})
