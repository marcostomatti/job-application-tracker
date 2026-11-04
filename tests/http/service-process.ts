import type { Subprocess } from 'bun'
import { join } from 'node:path'

/** One line the service logged, parsed. */
export type LogEntry = Readonly<Record<string, unknown>>

/** Everything a service process wrote, once it has exited. */
export interface ServiceOutput {
  readonly code: number
  /** stdout and stderr together, the fixture's own lines included. */
  readonly raw: string
  /** The service's JSON log lines, without the fixture's own. */
  readonly entries: readonly LogEntry[]
}

/** A service answering at `origin` in a process of its own. */
export interface ServiceProcess {
  readonly origin: string
  /** Stops the service, waits for the process to exit, and returns what it wrote. */
  stop(): Promise<ServiceOutput>
}

type FixtureLine = { readonly fixture: 'listening'; readonly origin: string } | { readonly fixture: 'failed'; readonly message: string }

type Launched = {
  readonly announced: Promise<FixtureLine | undefined>
  finish(): Promise<ServiceOutput>
}

const FIXTURE = join(import.meta.dir, 'fixtures/service-process.ts')

/** Every child not yet awaited, so a test that fails before stopping its service leaves no process behind. */
const running = new Set<Subprocess<'pipe', 'pipe', 'pipe'>>()

/** Each complete line of `text` that parses as a JSON object. */
function jsonLines(text: string): LogEntry[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry]
      } catch {
        return []
      }
    })
}

function launch(env: Readonly<Record<string, string | undefined>>): Launched {
  const child = Bun.spawn(['bun', FIXTURE], {
    // LOG_LEVEL is pinned so a level exported in the shell cannot hide the lines the tests read.
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  running.add(child)

  let out = ''
  let announce: (line: FixtureLine | undefined) => void = () => {}
  const announced = new Promise<FixtureLine | undefined>((resolve) => {
    announce = resolve
  })
  const outDone = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true })
      const line = jsonLines(out).find((entry) => 'fixture' in entry)
      if (line !== undefined) announce(line as FixtureLine)
    }
    announce(undefined)
  })()
  const errDone = new Response(child.stderr).text()

  return {
    announced,
    async finish(): Promise<ServiceOutput> {
      child.stdin.end()
      const code = await child.exited
      running.delete(child)
      await outDone
      const raw = `${out}\n${await errDone}`
      return { code, raw, entries: jsonLines(raw).filter((entry) => !('fixture' in entry)) }
    },
  }
}

/**
 * Starts the service in a child process with `env` laid over this one's, and resolves once it
 * listens. A start that fails rejects with everything the process wrote, so the reason is in
 * the test's failure and nowhere else.
 */
export async function spawnService(env: Readonly<Record<string, string | undefined>> = {}): Promise<ServiceProcess> {
  const launched = launch(env)
  const line = await launched.announced
  if (line?.fixture !== 'listening') {
    const output = await launched.finish()
    throw new Error(`the service process did not start (exit ${output.code}):\n${output.raw}`)
  }
  return { origin: line.origin, stop: () => launched.finish() }
}

/** Starts the service in a child process expecting it to refuse, and returns the refusal with what was logged. */
export async function spawnRefusedService(
  env: Readonly<Record<string, string | undefined>>,
): Promise<ServiceOutput & { readonly message: string | undefined }> {
  const launched = launch(env)
  const line = await launched.announced
  const output = await launched.finish()
  return { ...output, message: line?.fixture === 'failed' ? line.message : undefined }
}

/** Kills and awaits any child a test left running. For a file's `afterAll`. */
export async function stopStrayServices(): Promise<void> {
  const strays = [...running]
  running.clear()
  for (const child of strays) child.kill()
  await Promise.all(strays.map((child) => child.exited))
}
