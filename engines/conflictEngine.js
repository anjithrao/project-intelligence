'use strict';

const pool               = require('../db/pool');
const wsManager          = require('../websocket/wsManager');
const { classifySeverity }                            = require('./severityClassifier');
const { upsertConflictBlocker, resolveStaleBlockers, buildDescription } = require('./blockerService');

const BRANCH_OVERLAP_QUERY = `
  SELECT
    file_path,
    COUNT(DISTINCT branch_name)                         AS branch_count,
    ARRAY_AGG(DISTINCT branch_name)                     AS branches,
    BOOL_OR(branch_name IN ('main','master'))           AS touches_main
  FROM file_activity
  WHERE workspace_id   = $1
    AND branch_name NOT IN ('main','master')
    AND updated_at > NOW() - ($2 || ' hours')::INTERVAL
  GROUP BY file_path
  HAVING COUNT(DISTINCT branch_name) > 1`;

const PR_OVERLAP_QUERY = `
  SELECT
    pf.file_path,
    COUNT(DISTINCT pr.id)               AS pr_count,
    ARRAY_AGG(DISTINCT pr.pr_number)    AS pr_numbers,
    ARRAY_AGG(DISTINCT pr.source_branch) AS source_branches
  FROM pr_files pf
  JOIN pull_requests pr ON pr.id = pf.pr_id
  WHERE pr.workspace_id = $1 AND pr.status = 'open'
  GROUP BY pf.file_path
  HAVING COUNT(DISTINCT pr.id) > 1`;

/**
 * Core conflict detection engine.
 * Called asynchronously by the webhook handler — never on a schedule.
 * All reads and writes occur inside one transaction; partial state is never committed.
 */
async function runConflictEngine(workspaceId, modifiedFiles, triggerBranch) {
  if (!modifiedFiles || modifiedFiles.length === 0) return;

  const start = Date.now();
  console.log(`[ConflictEngine] Start — workspace=${workspaceId} branch=${triggerBranch} files=${modifiedFiles.length}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch activity window configured for this workspace
    const wsRow = await client.query(
      'SELECT activity_window_hours FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    const windowHours = wsRow.rows[0]?.activity_window_hours ?? 72;

    // Step 1 — Detect branch overlaps
    const branchResult = await client.query(BRANCH_OVERLAP_QUERY, [workspaceId, windowHours]);

    // Step 2 — Detect PR overlaps
    const prResult = await client.query(PR_OVERLAP_QUERY, [workspaceId]);

    // Step 3 — Merge signals per file (a file may appear in both result sets)
    const conflictMap = new Map();

    for (const row of branchResult.rows) {
      conflictMap.set(row.file_path, {
        branchCount:  parseInt(row.branch_count, 10),
        branches:     row.branches,
        touchesMain:  row.touches_main,
        prCount:      0,
        prNumbers:    [],
      });
    }

    for (const row of prResult.rows) {
      const existing = conflictMap.get(row.file_path) ?? { branchCount: 0, branches: [], touchesMain: false };
      conflictMap.set(row.file_path, {
        ...existing,
        prCount:   parseInt(row.pr_count, 10),
        prNumbers: row.pr_numbers,
      });
    }

    // Step 4 — Classify severity and upsert blockers
    const newBlockers = [];
    for (const [filePath, signals] of conflictMap.entries()) {
      const severity    = classifySeverity(signals);
      const description = buildDescription(filePath, signals);
      await upsertConflictBlocker(client, { workspaceId, filePath, severity, description });
      newBlockers.push({ filePath, severity, signals });
    }

    // Step 5 — Auto-resolve blockers where conflict no longer exists
    await resolveStaleBlockers(client, workspaceId, windowHours);

    await client.query('COMMIT');

    // Step 6 — Broadcast WebSocket events (after commit)
    for (const { filePath, severity, signals } of newBlockers) {
      wsManager.broadcastToWorkspace(workspaceId, {
        type:     'CONFLICT_WARNING',
        file:     filePath,
        branches: signals.branches,
        severity,
      });
    }

    console.log(`[ConflictEngine] Done — ${newBlockers.length} conflicts processed (${Date.now() - start}ms)`);

  } catch (err) {
    await client.query('ROLLBACK');
    // Engine failure must NEVER crash the server — webhook already responded 200
    console.error('[ConflictEngine] Error:', err.message, err.stack);
  } finally {
    client.release();
  }
}

module.exports = { runConflictEngine };
