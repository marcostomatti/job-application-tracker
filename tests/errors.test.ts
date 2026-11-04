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
    expect(statusFor(new NotFoundError('posting', 7))).toBe(404)
    expect(statusFor(new ConflictError('posting_key', 'acme-dev'))).toBe(409)
    expect(statusFor(new ArchivedError('route', 3))).toBe(409)
    expect(statusFor(new BulkItemError(2, new Error('boom')))).toBe(400)
    expect(statusFor(new ZodError([]))).toBe(400)
  })

  test('statusFor maps a duplicate criteria set to 409', () => {
    expect(statusFor(new CriteriaSetConflictError('acme', 1))).toBe(409)
  })

  test('CriteriaSetConflictError renders the set and the version it collided on', () => {
    expect(new CriteriaSetConflictError('acme', 1).message).toBe('criteria set "acme" at version 1 already exists')
  })

  test('CriteriaSetConflictError is a ConflictError', () => {
    expect(new CriteriaSetConflictError('acme', 1)).toBeInstanceOf(ConflictError)
  })

  test('statusFor sends an unknown error to 500', () => {
    expect(statusFor(new Error('connection refused'))).toBe(500)
  })

  test('statusFor sends a thrown non-Error value to 500', () => {
    expect(statusFor('postgres://user:secret@host/db')).toBe(500)
  })
})

describe('error messages', () => {
  test('NotFoundError names the entity and the id without a query', () => {
    const error = new NotFoundError('posting', 7)
    expect(error.message).toBe('posting 7 does not exist')
    expect(error.message).not.toContain('select')
  })

  test('NotFoundError may carry the driver fault on cause and keeps it out of the message', () => {
    const cause = new Error('insert into "origin" violates a foreign key')
    const error = new NotFoundError('posting', 7, { cause })
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('posting 7 does not exist')
  })

  test('ConflictError takes its own message, keeps the cause off it, and still names the field and key', () => {
    const cause = new Error('driver detail')
    const error = new ConflictError('criteria set', '3', { message: 'a rating names a requirement outside it', cause })
    expect(error.message).toBe('a rating names a requirement outside it')
    expect(error.cause).toBe(cause)
    expect(error).toMatchObject({ field: 'criteria set', key: '3', name: 'ConflictError' })
    expect(statusFor(error)).toBe(409)
    expect(new ConflictError('a', 'b').message).toBe('a b already exists')
    expect('cause' in new ConflictError('a', 'b')).toBe(false)
  })

  test('ConflictError names the key and not the cause', () => {
    const error = new ConflictError('posting_key', 'acme-dev')
    expect(error.message).toBe('posting_key acme-dev already exists')
    expect(error.name).toBe('ConflictError')
  })

  test('ArchivedError names the entity and the id', () => {
    const error = new ArchivedError('route', 3)
    expect(error.message).toBe('route 3 is archived')
    expect(error.name).toBe('ArchivedError')
  })

  test('BulkItemError reports the index and keeps the cause out of the message', () => {
    const cause = new Error('connection refused')
    const error = new BulkItemError(2, cause)
    expect(error.index).toBe(2)
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('bulk item 2 failed')
    expect(error.message).not.toContain(cause.message)
    expect(error.name).toBe('BulkItemError')
  })
})
