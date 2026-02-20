'use strict';

/**
 * Pure function — no I/O, no state.
 * Classifies conflict severity for a single file from SQL-derived signals.
 *
 * @param {{ branchCount: number, prCount: number, touchesMain: boolean }} signals
 * @returns {'LOW'|'MEDIUM'|'HIGH'}
 */
function classifySeverity({ branchCount, prCount, touchesMain }) {
  if (prCount >= 2)      return 'HIGH';   // two open PRs = confirmed incoming conflict
  if (touchesMain)       return 'HIGH';   // any overlap with main = escalate
  if (branchCount >= 3)  return 'HIGH';   // 3+ competing branches = high collision risk
  if (branchCount >= 2)  return 'MEDIUM';
  return 'LOW';
}

module.exports = { classifySeverity };
