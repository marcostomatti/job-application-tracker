import { createLogger } from '@open-tomato/service-logger'

/** The three levels this repository logs at, each taking a context object and a message. */
export type Log = {
  info(context: object, message: string): void
  warn(context: object, message: string): void
  error(context: object, message: string): void
}

/**
 * A function that returns the named logger, built on its first call and reused after. The
 * logger is not made when this is called, nor when the importing module is loaded, so a module
 * whose logging sits in a branch that may never run (an authenticating service that has its
 * key) never builds a logger it does not use. The `service-logger` `Logger` satisfies `Log`.
 */
export function lazyLogger(name: string): () => Log {
  let cached: Log | undefined
  return () => {
    cached ??= createLogger(name)
    return cached
  }
}
