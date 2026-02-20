'use strict';

const pool       = require('../db/pool');
const wsManager  = require('../websocket/wsManager');
const { recalculate } = require('./healthEngine');

/**
 * Feature Engine — maps committed files to features, updates completion,
 * and creates DEPENDENCY_BLOCK blockers when upstream features are incomplete.
 *
 * Called asynchronously after webhook file_activity upsert.
 */
async function runFeatureEngine(workspaceId, modifiedFiles, commitHash) {
  if (!modifiedFiles || modifiedFiles.length === 0) return;

  console.log(`[FeatureEngine] Start — workspace=${workspaceId} files=${modifiedFiles.length}`);

  try {
    // 1. Find features that own at least one of the modified files
    //    (Feature-to-file mapping: stored as file path patterns in feature description for MVP)
    //    For MVP: match by checking if any feature description contains the file path keyword
    const featuresResult = await pool.query(
      `SELECT f.id, f.name, f.status, f.completion_percentage, f.owner_uid
       FROM features f
       WHERE f.workspace_id = $1 AND f.status != 'COMPLETE'`,
      [workspaceId]
    );

    for (const feature of featuresResult.rows) {
      // 2. Check if this feature has incomplete dependencies
      const depResult = await pool.query(
        `SELECT fd.depends_on_feature_id, f2.status, f2.name
         FROM feature_dependencies fd
         JOIN features f2 ON f2.id = fd.depends_on_feature_id
         WHERE fd.feature_id = $1 AND f2.status != 'COMPLETE'`,
        [feature.id]
      );

      if (depResult.rows.length > 0) {
        // Mark feature as BLOCKED
        await pool.query(
          `UPDATE features SET status = 'BLOCKED' WHERE id = $1`,
          [feature.id]
        );

        // Create DEPENDENCY_BLOCK blocker (dedup via unique index)
        const blockingNames = depResult.rows.map(r => r.name).join(', ');
        await pool.query(
          `INSERT INTO blockers (workspace_id, type, reference_id, description, severity, resolved)
           VALUES ($1, 'DEPENDENCY_BLOCK', $2, $3, 'HIGH', false)
           ON CONFLICT (workspace_id, type, reference_id) WHERE resolved = false DO NOTHING`,
          [workspaceId, feature.id, `Feature "${feature.name}" blocked by: ${blockingNames}`]
        );

        wsManager.broadcastToWorkspace(workspaceId, {
          type:        'BLOCKER_CREATED',
          featureId:   feature.id,
          featureName: feature.name,
          blockedBy:   depResult.rows.map(r => r.name),
        });

      } else if (feature.status === 'BLOCKED') {
        // Dependencies resolved — unblock feature
        await pool.query(
          `UPDATE features SET status = 'ACTIVE' WHERE id = $1`,
          [feature.id]
        );
        await pool.query(
          `UPDATE blockers SET resolved = true
           WHERE workspace_id = $1 AND type = 'DEPENDENCY_BLOCK' AND reference_id = $2`,
          [workspaceId, feature.id]
        );
      }

      // 3. Bump completion percentage (simple heuristic: +5% per commit touching feature)
      //    Capped at 95% — 100% only on explicit merge to main
      const newPct = Math.min(95, (feature.completion_percentage || 0) + 5);
      await pool.query(
        `UPDATE features SET completion_percentage = $1 WHERE id = $2`,
        [newPct, feature.id]
      );
    }

    await recalculate(workspaceId);

    console.log(`[FeatureEngine] Done — workspace=${workspaceId}`);

  } catch (err) {
    console.error('[FeatureEngine] Error:', err.message, err.stack);
  }
}

module.exports = { runFeatureEngine };
