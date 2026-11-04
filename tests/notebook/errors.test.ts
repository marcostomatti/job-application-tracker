import { describe, expect, test } from 'bun:test'

import { NotebookRequestError, NotebookUnavailableError, statusFor } from '../../src/errors.ts'
import { describeError } from '../../src/mcp/result.ts'

describe('the notebook errors', () => {
  test('map to 503 and 502', () => {
    expect(statusFor(new NotebookUnavailableError('the connection failed'))).toBe(503)
    expect(statusFor(new NotebookRequestError(422, 'the notebook refused the request (422)'))).toBe(502)
  })

  test('are shown to a caller by name and message, and the cause is not', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.9:5055')
    const described = describeError(new NotebookUnavailableError('the connection failed', { cause }))
    expect(described).toEqual({ name: 'NotebookUnavailableError', message: 'the notebook is unavailable: the connection failed' })
    expect(JSON.stringify(described)).not.toContain('10.0.0.9')
  })
})
