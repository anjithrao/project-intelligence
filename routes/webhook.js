'use strict';

const express              = require('express');
const crypto               = require('crypto');
const pool                 = require('../db/pool');
const { runConflictEngine } = require('../engines/conflictEngine');
const { runFeatureEngine }  = require('../engines/featureEngine');
const { webhookLimiter }    = require('../middleware/rateLimiter');

const router   = express.Router();
const ZERO_SHA = '0000000000000000000000000000000000000000';

// ─── Signature Verification ────────────────────────────────────────────────────

function verifySignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true; // skip in dev if not configured

  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  // Both buffers must be same length for timingSafeEqual
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

router.post('/github', webhookLimiter, async (req, res) => {
  const startTime   = Date.now();
  const eventType   = req.headers['x-github-event'];
  const deliveryId  = req.headers['x-github-delivery'];

  // 1. Header validation
  if (!eventType || !deliveryId) {
    return res.status(400).json({ error: 'Missing required headers' });
  }

  // 2. Only handle push events for MVP
  if (eventType !== 'push') {
    return res.status(200).json({ status: 'ignored', reason: 'unsupported_event', event: eventType });
  }

  // 3. Signature verification
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  req.webhookSignatureVerified = true;

  // 4. Payload validation
  const { ref, after, before, commits, repository, head_commit } = req.body;
  if (!ref || !after || !repository?.id || !repository?.full_name) {
    return res.status(400).json({ error: 'Invalid payload structure' });
  }

  const branch     = ref.replace('refs/heads/', '');
  const commitHash = after;
  const repoId     = repository.id;

  // 5. Classify push type
  const isDeletedBranch = after  === ZERO_SHA;
  const isNewBranch     = before === ZERO_SHA;
  const isEmpty         = !commits || commits.length === 0;
  const isForcePush     = !isNewBranch && !isDeletedBranch && isEmpty;

  const client = await pool.connect();
  let workspaceId;
  let modifiedFiles = [];

  try {
    await client.query('BEGIN');

    // 5a. Idempotency gate — insert delivery ID; skip if already processed
    const dedup = await client.query(
      `INSERT INTO webhook_deliveries (delivery_id, repo_id, branch_name, commit_hash)
       VALUES ($1,$2,$3,$4) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
      [deliveryId, repoId, branch, commitHash]
    );
    if (dedup.rowCount === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ status: 'duplicate', deliveryId });
    }

    // 5b. Resolve workspace by repo ID (rename-proof)
    const wsResult = await client.query(
      'SELECT id FROM workspaces WHERE github_repo_id = $1 LIMIT 1',
      [repoId]
    );
    if (wsResult.rowCount === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ status: 'workspace_not_found', repoId });
    }
    workspaceId = wsResult.rows[0].id;

    // 5c. Deleted branch — wipe file_activity, no engine run needed
    if (isDeletedBranch) {
      await client.query(
        'DELETE FROM file_activity WHERE workspace_id = $1 AND branch_name = $2',
        [workspaceId, branch]
      );
      await client.query('COMMIT');
      return res.status(200).json({ status: 'branch_deleted', branch });
    }

    // 5d. Extract modified files
    if (!isEmpty) {
      const fileSet = new Set();
      for (const commit of commits) {
        for (const f of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
          fileSet.add(f);
        }
      }
      modifiedFiles = [...fileSet];
    } else if (isForcePush && head_commit) {
      const hc = head_commit;
      modifiedFiles = [...new Set([...(hc.added ?? []), ...(hc.modified ?? []), ...(hc.removed ?? [])])];
    }

    // 5e. Batch upsert file_activity
    if (modifiedFiles.length > 0) {
      const values = [];
      const params = [];
      let p = 1;
      for (const filePath of modifiedFiles) {
        values.push(`(gen_random_uuid(), $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
        params.push(workspaceId, branch, filePath, commitHash);
      }
      await client.query(
        `INSERT INTO file_activity (id, workspace_id, branch_name, file_path, last_commit_hash, updated_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (workspace_id, branch_name, file_path)
         DO UPDATE SET last_commit_hash = EXCLUDED.last_commit_hash,
                       updated_at       = EXCLUDED.updated_at`,
        params
      );
    }

    // 5f. Record processing duration
    const durationMs = Date.now() - startTime;
    await client.query(
      'UPDATE webhook_deliveries SET duration_ms = $1 WHERE delivery_id = $2',
      [durationMs, deliveryId]
    );

    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Webhook] Transaction error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }

  // 6. Respond BEFORE firing engines — GitHub expects fast ACK
  res.status(200).json({ status: 'processing', deliveryId });

  // 7. Fire downstream engines asynchronously — never blocks response
  if (workspaceId && modifiedFiles.length > 0) {
    setImmediate(async () => {
      try {
        await runConflictEngine(workspaceId, modifiedFiles, branch);
        await runFeatureEngine(workspaceId, modifiedFiles, commitHash);
      } catch (err) {
        console.error('[Webhook] Downstream engine error:', err.message);
      }
    });
  }
});

module.exports = router;
