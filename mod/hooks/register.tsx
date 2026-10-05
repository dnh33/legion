/**
 * Legion mod: the wiring. The runtime (src/wire/legion.tsx) observes and acts; the UI (src/ui/register-ui.tsx) draws.
 */
import type { Register } from 'claude-code'

import { registerUi } from '../src/ui/register-ui.tsx'
import { registerLegion } from '../src/wire/legion.tsx'

export const register: Register = on => {
  registerLegion(on)
  registerUi(on)
}
