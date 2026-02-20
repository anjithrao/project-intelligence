'use strict';

const pool      = require('../db/pool');
const wsManager = require('../websocket/wsManager');

/**
 * Health Score Formula (from spec):
 *   Health = (Feature Completion Avg * 0.4)
 *            - (Active Blockers    * 5)
 *            - (Conflict Risks     * 3)
 *            - (Inactive Members   * 5)
 *   Clamped: 0 – 100
 */
async function recalculate(workspaceId) {
  try {
    const [featureAvg, blockerCounts, inactiveCount] = await Promise.all([
      _getFeatureCompletionAvg(workspaceId),
      _getBlockerCounts(workspaceId),
      _getInactiveMemberCount(workspaceId),
    ]);

    const raw = (
        (featureAvg              * 0.4)
      - (blockerCounts.total    * 5)
      - (blockerCounts.conflict * 3)
      - (inactiveCount          * 5)
    );

    const score    = Math.min(100, Math.max(0, Math.round(raw)));
    const riskLevel = score >= 80 ? 'HEALTHY' : score >= 50 ? 'WARNING' : 'CRITICAL';

    // Persist updated score
    await pool.query(
      'UPDATE workspaces SET health_score = $1 WHERE id = $2',
      [score, workspaceId]
    );

    wsManager.broadcastToWorkspace(workspaceId, { type: 'HEALTH_UPDATE', score, riskLevel });

    console.log(`[HealthEngine] workspace=${workspaceId} score=${score} (${riskLevel})`);
    return { score, riskLevel };

  } catch (err) {
    console.error('[HealthEngine] Error:', err.message);
  }
}

async function _getFeatureCompletionAvg(workspaceId) {
  const r = await pool.query(
    'SELECT COALESCE(AVG(completion_percentage), 0) AS avg FROM features WHERE workspace_id = $1',
    [workspaceId]
  );
  return parseFloat(r.rows[0].avg);
}

async function _getBlockerCounts(workspaceId) {
  const r = await pool.query(
    `SELECT
       COUNT(*)                                               AS total,
       COUNT(*) FILTER (WHERE type = 'FILE_CONFLICT_RISK')   AS conflict
     FROM blockers WHERE workspace_id = $1 AND resolved = FALSE`,
    [workspaceId]
  );
  return { total: parseInt(r.rows[0].total), conflict: parseInt(r.rows[0].conflict) };
}

async function _getInactiveMemberCount(workspaceId) {
  // Inactive = no file_activity in last 7 days for any branch containing the username
  const r = await pool.query(
    `SELECT COUNT(*) AS count
     FROM users u
     WHERE u.workspace_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM file_activity fa
         WHERE fa.workspace_id = $1
           AND fa.updated_at >= NOW() - INTERVAL '7 days'
           AND fa.branch_name ILIKE '%' || u.github_username || '%'
       )`,
    [workspaceId]
  );
  return parseInt(r.rows[0].count);
}

module.exports = { recalculate };
