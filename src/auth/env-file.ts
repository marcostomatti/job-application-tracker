/** An active `NAME=` line: indented or after `export`, as a shell or dotenv parser allows. Commented lines are not active. */
function activeLine(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name}=`)
}

function assertName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`not an env variable name: ${name}`)
}

/**
 * The text of an env file with `name` set to `value`: every active `name=` line is replaced
 * (its line ending kept), or one line is appended when there is none. Other lines are untouched.
 * Reads and writes nothing.
 */
export function setEnvValue(current: string, name: string, value: string): string {
  assertName(name)
  if (value.length === 0 || /[\s#'"$]/.test(value)) throw new Error(`${name} must be non-empty, with no whitespace, quote, # or $.`)
  const line = activeLine(name)
  const lines = current.split('\n')
  if (lines.some((text) => line.test(text))) {
    return lines.map((text) => (line.test(text) ? `${name}=${value}${text.endsWith('\r') ? '\r' : ''}` : text)).join('\n')
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  if (current.length === 0) return `${name}=${value}${newline}`
  return `${current}${current.endsWith('\n') ? '' : newline}${name}=${value}${newline}`
}

/** The text with every active `name=` line removed, and whether there was one. Commented lines stay. */
export function removeEnvValue(current: string, name: string): { text: string; removed: boolean } {
  assertName(name)
  const line = activeLine(name)
  const lines = current.split('\n')
  const kept = lines.filter((text) => !line.test(text))
  return { text: kept.join('\n'), removed: kept.length !== lines.length }
}

/** The value of the last active `name=` line, unquoted, or `undefined`. Enough to read AUTH_MODE back; not a dotenv parser. */
export function readEnvValue(current: string, name: string): string | undefined {
  assertName(name)
  const line = activeLine(name)
  const found = current.split('\n').filter((text) => line.test(text)).at(-1)
  if (found === undefined) return undefined
  const raw = found.slice(found.indexOf('=') + 1).replace(/\s+#.*$/, '').trim()
  return raw.replace(/^(["'])(.*)\1$/, '$2')
}
