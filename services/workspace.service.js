'use strict';

const { v4: uuidv4 } = require('uuid');
const pool           = require('../db/pool');

// ─── Create Workspace ──────────────────────────────────────────────────────────

async function createWorkspace(payload) {
  const { workspaceName, projectTitle, projectDescription, srsDocument, githubRepoUrl, githubRepoId, githubUsers } = payload;

  const normalizedRepo = githubRepoUrl.trim().toLowerCase().replace(/\/$/, '');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Duplicate repo guard
    const dup = await client.query(
      'SELECT id FROM workspaces WHERE github_repo = $1 OR github_repo_id = $2 LIMIT 1',
      [normalizedRepo, githubRepoId]
    );
    if (dup.rowCount > 0) {
      const err = new Error('A workspace for this repository already exists.');
      err.status = 409; err.code = 'DUPLICATE_REPO'; throw err;
    }

    const workspaceId  = uuidv4();
    const dashboardKey = uuidv4();

    await client.query(
      `INSERT INTO workspaces (id, name, title, description, srs, github_repo, github_repo_id, dashboard_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workspaceId, workspaceName.trim(), projectTitle.trim(), projectDescription.trim(),
       srsDocument, normalizedRepo, githubRepoId, dashboardKey]
    );

    const members = [];
    for (const username of githubUsers) {
      const userId  = uuidv4();
      const userUid = uuidv4();
      await client.query(
        'INSERT INTO users (id, workspace_id, github_username, user_uid) VALUES ($1,$2,$3,$4)',
        [userId, workspaceId, username.trim().toLowerCase(), userUid]
      );
      members.push({ githubUsername: username, userUid });
    }

    await client.query('COMMIT');
    return { workspaceId, dashboardAccessKey: dashboardKey, members };

  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const e = new Error('A workspace for this repository already exists.');
      e.status = 409; e.code = 'DUPLICATE_REPO'; throw e;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Join Workspace ────────────────────────────────────────────────────────────

async function joinWorkspace(userUid) {
  const userResult = await pool.query(
    'SELECT * FROM users WHERE user_uid = $1 LIMIT 1',
    [userUid]
  );
  if (userResult.rowCount === 0) {
    const err = new Error('User not found.'); err.status = 404; throw err;
  }
  const user = userResult.rows[0];

  const [ws, features, blockers] = await Promise.all([
    pool.query('SELECT * FROM workspaces WHERE id = $1', [user.workspace_id]),
    pool.query('SELECT * FROM features WHERE workspace_id = $1 AND (owner_uid = $2 OR owner_uid IS NULL)', [user.workspace_id, user.id]),
    pool.query("SELECT * FROM blockers WHERE workspace_id = $1 AND resolved = false", [user.workspace_id]),
  ]);

  await pool.query('UPDATE users SET last_active = NOW() WHERE user_uid = $1', [userUid]);

  const workspace = ws.rows[0];
  return {
    workspaceId:   workspace.id,
    workspaceName: workspace.name,
    projectTitle:  workspace.title,
    healthScore:   workspace.health_score,
    features:      features.rows,
    activeBlockers: blockers.rows,
  };
}

// ─── Get Dashboard ─────────────────────────────────────────────────────────────

async function getDashboard(dashboardAccessKey) {
  const wsResult = await pool.query(
    'SELECT * FROM workspaces WHERE dashboard_key = $1 LIMIT 1',
    [dashboardAccessKey]
  );
  if (wsResult.rowCount === 0) {
    const err = new Error('Invalid access key.'); err.status = 403; throw err;
  }
  const ws = wsResult.rows[0];

  const [members, features, deps, branches, blockers] = await Promise.all([
    pool.query('SELECT id, github_username, last_active FROM users WHERE workspace_id = $1', [ws.id]),
    pool.query('SELECT * FROM features WHERE workspace_id = $1 ORDER BY priority DESC', [ws.id]),
    pool.query(`SELECT fd.*, f.name AS feature_name, f2.name AS depends_on_name
                FROM feature_dependencies fd
                JOIN features f  ON f.id  = fd.feature_id
                JOIN features f2 ON f2.id = fd.depends_on_feature_id
                WHERE f.workspace_id = $1`, [ws.id]),
    pool.query('SELECT DISTINCT branch_name FROM file_activity WHERE workspace_id = $1', [ws.id]),
    pool.query("SELECT * FROM blockers WHERE workspace_id = $1 AND resolved = false ORDER BY severity DESC", [ws.id]),
  ]);

  return {
    workspace:       { id: ws.id, name: ws.name, title: ws.title, healthScore: ws.health_score },
    members:         members.rows,
    features:        features.rows,
    dependencyGraph: deps.rows,
    activeBranches:  branches.rows.map(r => r.branch_name),
    activeBlockers:  blockers.rows,
  };
}

module.exports = { createWorkspace, joinWorkspace, getDashboard };
