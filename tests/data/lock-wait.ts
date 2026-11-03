import type postgres from 'postgres'

/** Polls until some backend is blocked on a lock, which is the moment the other transaction may commit. */
export async function waitUntilABackendWaitsOnALock(observer: postgres.Sql): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await observer`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`
    if ((row?.waiting ?? 0) > 0) return
    await Bun.sleep(20)
  }
  throw new Error('no backend ever waited on a lock')
}
