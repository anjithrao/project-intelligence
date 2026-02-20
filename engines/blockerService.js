'use strict';

/**
 * Upserts a FILE_CONFLICT_RISK blocker.
 * - No active blocker → INSERT
 * - Active blocker, same severity → no-op (idempotent)
 * - Active blocker, different severity → UPDATE severity only
 */
async function upsertConflictBlocker(client, { workspaceId, filePath, severity, description }) {
  const existing = await client.query(
    `SELECT id, severity FROM blockers
     WHERE workspace_id = $1 AND type = 'FILE_CONFLICT_RISK'
       AND reference_id = $2 AND resolved = false LIMIT 1`,
    [workspaceId, filePath]
  );

  if (existing.rows.length > 0) {
    const current = existing.rows[0];
    if (current.severity !== severity) {
      await client.query(
        `UPDATE blockers SET severity = $1, description = $2 WHERE id = $3`,
        [severity, description, current.id]
      );
    }
    return; // same severity → no-op
  }

  await client.query(
    `INSERT INTO blockers (workspace_id, type, reference_id, description, severity, resolved, created_at)
     VALUES ($1, 'FILE_CONFLICT_RISK', $2, $3, $4, false, NOW())`,
    [workspaceId, filePath, description, severity]
  );
}

/**
 * Resolves all FILE_CONFLICT_RISK blockers for files no longer in conflict.
 * Single set-based UPDATE — no per-file loops.
 */
async function resolveStaleBlockers(client, workspaceId, windowHours) {
  await client.query(
    `UPDATE blockers SET resolved = true
     WHERE workspace_id = $1
       AND type         = 'FILE_CONFLICT_RISK'
       AND resolved     = false
       AND reference_id NOT IN (
         -- Files still conflicting across branches
         SELECT file_path FROM file_activity
         WHERE workspace_id = $1
           AND branch_name NOT IN ('main','master')
           AND updated_at > NOW() - ($2 || ' hours')::INTERVAL
         GROUP BY file_path HAVING COUNT(DISTINCT branch_name) > 1
         UNION
         -- Files still conflicting across open PRs
         SELECT pf.file_path FROM pr_files pf
         JOIN pull_requests pr ON pr.id = pf.pr_id
         WHERE pr.workspace_id = $1 AND pr.status = 'open'
         GROUP BY pf.file_path HAVING COUNT(DISTINCT pr.id) > 1
       )`,
    [workspaceId, windowHours]
  );
}

/**
 * Builds a human-readable blocker description for the dashboard.
 */
function buildDescription(filePath, { branches, prNumbers, branchCount, prCount, touchesMain }) {
  const parts = [];
  if (branchCount > 1) parts.push(`${branchCount} branches (${branches.join(', ')})`);
  if (prCount > 1)     parts.push(`${prCount} open PRs (#${prNumbers.join(', #')})`);
  if (touchesMain)     parts.push('includes main');
  return `Conflict risk on ${filePath}: ${parts.join(' · ')}`;
}

module.exports = { upsertConflictBlocker, resolveStaleBlockers, buildDescription };
