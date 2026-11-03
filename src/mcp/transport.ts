export type McpTransport = 'stdio' | 'http'

/** The environment variable the `@open-tomato/service-mcp` package reads to pick its transport. */
const TRANSPORT_VARIABLE = 'MCP_TRANSPORT'

/**
 * Picks the transport from the environment, failing closed. An unset or blank value means
 * stdio, the exact value `stdio` means stdio, and the exact value `http` means HTTP. Anything
 * else throws, naming what it got.
 *
 * The package itself treats every value except the exact string `stdio` as HTTP, which would
 * turn a blank line in `.env`, a wrong case or a typo into an unauthenticated network port
 * carrying every tool. This is the guard in front of that.
 */
export function resolveTransport(env: Record<string, string | undefined>): McpTransport {
  const value = env[TRANSPORT_VARIABLE]
  if (value === undefined || value.trim() === '' || value === 'stdio') return 'stdio'
  if (value === 'http') return 'http'
  throw new Error(
    `${TRANSPORT_VARIABLE} is ${JSON.stringify(value)}, which is not a transport. ` +
      `Leave it unset or set it to "stdio" for stdio, or set it to "http" for HTTP.`,
  )
}

/** The two effects `applyTransport` needs, passed in so a test can observe them. */
export type TransportIo = {
  write: (text: string) => void
  exit: (code: number) => unknown
}

/**
 * Resolves the transport and writes the result back into `env` as exactly `stdio` or `http`,
 * so the package never reads a blank or odd value. On an unknown value it writes the reason,
 * exits with 1 and returns undefined, leaving `env` as it was.
 */
export function applyTransport(env: Record<string, string | undefined>, io: TransportIo): McpTransport | undefined {
  try {
    const transport = resolveTransport(env)
    env[TRANSPORT_VARIABLE] = transport
    return transport
  } catch (error: unknown) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
    return undefined
  }
}
