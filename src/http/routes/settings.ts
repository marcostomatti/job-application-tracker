import { readAppSettings, writeAppSettings } from '../../data/repositories/settings.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { AppSettingsPatchSchema } from '../../schemas/recommendation.ts'
import { route, type RouteSpec } from './spec.ts'

/**
 * The Settings page's read and write, mirroring `settings_get` and `settings_update`. The write
 * is a PATCH under `/api`, so a signed-in browser must send the CSRF header like every other write.
 */
export const settingsRoutes: RouteSpec[] = [
  route('get', '/settings', 'settings_get', EmptyInputSchema, async (_args, db) => readAppSettings(db)),
  route('patch', '/settings', 'settings_update', AppSettingsPatchSchema, async (args, db) => writeAppSettings(db, args)),
]
