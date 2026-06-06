/**
 * F07 · Agent registry bootstrap.
 *
 * Import this once at startup (from index.js, after Prisma + Redis init,
 * before routes mount) to wire every agent handler to its event. Module
 * side effects are intentional — `registerHandler` runs on import.
 *
 * Re-exports `emitEvent` so route handlers can fire events without taking
 * a second dependency on services/eventRegistry.js directly. Keeps the
 * touch-surface of this feature contained to one import path.
 */

import logger from '../../lib/logger.js';
import { registerHandler, emitEvent } from '../eventRegistry.js';
import { careGapAgent } from './careGapAgent.js';
import { pharmacyAgent } from './pharmacyAgent.js';
import { slotHoldAgent } from './slotHoldAgent.js';
import { dashboardSummariser } from './dashboardSummariser.js';

// All four agents listen for the same critical-triage event. The registry
// runs them via Promise.allSettled so one agent's failure can't cascade.
registerHandler('triage.critical.submitted', careGapAgent,        { name: 'careGapAgent' });
registerHandler('triage.critical.submitted', pharmacyAgent,        { name: 'pharmacyAgent' });
registerHandler('triage.critical.submitted', slotHoldAgent,        { name: 'slotHoldAgent' });
registerHandler('triage.critical.submitted', dashboardSummariser, { name: 'dashboardSummariser' });

logger.info('[agents] all critical-triage handlers registered');

export { registerHandler, emitEvent };
