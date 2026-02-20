-- ─────────────────────────────────────────────────────────────────────────────
-- AI-Powered Code-Aware Project Intelligence System
-- Complete Database Schema (merged from all modules)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── WORKSPACES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL CHECK (char_length(trim(name)) >= 3),
  title            VARCHAR(100) NOT NULL CHECK (char_length(trim(title)) >= 3),
  description      VARCHAR(1000) NOT NULL CHECK (char_length(trim(description)) >= 10),
  srs              TEXT        NOT NULL CHECK (char_length(trim(srs)) > 0),
  github_repo      VARCHAR(255) NOT NULL,
  github_repo_id   BIGINT      NOT NULL,          -- rename-proof repo identity
  dashboard_key    UUID        NOT NULL DEFAULT gen_random_uuid(),
  health_score     SMALLINT    NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  activity_window_hours INTEGER NOT NULL DEFAULT 72,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_github_repo     UNIQUE (github_repo),
  CONSTRAINT uq_github_repo_id  UNIQUE (github_repo_id),
  CONSTRAINT uq_dashboard_key   UNIQUE (dashboard_key)
);

-- ─── USERS ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_username  VARCHAR(100) NOT NULL CHECK (char_length(trim(github_username)) > 0),
  user_uid         UUID        NOT NULL DEFAULT gen_random_uuid(),
  last_active      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_uid                    UNIQUE (user_uid),
  CONSTRAINT uq_workspace_github_username   UNIQUE (workspace_id, github_username)
);

-- ─── FEATURES ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS features (
  id                    UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID      NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  VARCHAR(200) NOT NULL,
  description           TEXT,
  owner_uid             UUID      REFERENCES users(id) ON DELETE SET NULL,
  priority              VARCHAR(10) NOT NULL DEFAULT 'MEDIUM'
                          CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  status                VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','BLOCKED','COMPLETE')),
  completion_percentage SMALLINT  NOT NULL DEFAULT 0
                          CHECK (completion_percentage BETWEEN 0 AND 100),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── FEATURE DEPENDENCIES ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feature_dependencies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id            UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  depends_on_feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  CONSTRAINT uq_feature_dep  UNIQUE (feature_id, depends_on_feature_id),
  CONSTRAINT no_self_dep     CHECK (feature_id <> depends_on_feature_id)
);

-- ─── FILE ACTIVITY ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS file_activity (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_name      TEXT        NOT NULL,
  file_path        TEXT        NOT NULL,
  last_commit_hash TEXT        NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_file_activity_workspace_branch_file
    UNIQUE (workspace_id, branch_name, file_path)
);

-- ─── BLOCKERS ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blockers (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN (
                 'FILE_CONFLICT_RISK',
                 'DEPENDENCY_BLOCK',
                 'INACTIVITY',
                 'ALIGNMENT_DRIFT'
               )),
  reference_id TEXT    NOT NULL,    -- file_path for conflicts, feature UUID for deps
  description  TEXT    NOT NULL,
  severity     TEXT    NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PULL REQUESTS ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pull_requests (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pr_number     INTEGER NOT NULL,
  source_branch TEXT    NOT NULL,
  target_branch TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','merged','closed')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_pr UNIQUE (workspace_id, pr_number)
);

-- ─── PR FILES ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pr_files (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id     UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  CONSTRAINT uq_pr_file UNIQUE (pr_id, file_path)
);

-- ─── WEBHOOK DELIVERIES (idempotency log) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  TEXT    PRIMARY KEY,
  repo_id      BIGINT,
  branch_name  TEXT,
  commit_hash  TEXT,
  duration_ms  INTEGER,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- workspaces
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_dashboard_key  ON workspaces (dashboard_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_github_repo_id ON workspaces (github_repo_id);

-- users
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_uid       ON users (user_uid);
CREATE        INDEX IF NOT EXISTS idx_users_workspace_id   ON users (workspace_id);

-- features
CREATE INDEX IF NOT EXISTS idx_features_workspace_id  ON features (workspace_id);
CREATE INDEX IF NOT EXISTS idx_features_owner_uid     ON features (owner_uid);
CREATE INDEX IF NOT EXISTS idx_features_status        ON features (workspace_id, status);

-- feature_dependencies
CREATE INDEX IF NOT EXISTS idx_feature_deps_feature_id  ON feature_dependencies (feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_deps_depends_on  ON feature_dependencies (depends_on_feature_id);

-- file_activity
CREATE INDEX IF NOT EXISTS idx_file_activity_workspace_file    ON file_activity (workspace_id, file_path);
CREATE INDEX IF NOT EXISTS idx_file_activity_workspace_branch  ON file_activity (workspace_id, branch_name);
CREATE INDEX IF NOT EXISTS idx_file_activity_updated_at        ON file_activity (workspace_id, updated_at DESC);

-- blockers
CREATE INDEX IF NOT EXISTS idx_blockers_workspace_active   ON blockers (workspace_id, resolved, type);
CREATE INDEX IF NOT EXISTS idx_blockers_reference          ON blockers (workspace_id, reference_id, type, resolved);
-- DB-level dedup: only one active blocker per file per type per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockers_unique_active
  ON blockers (workspace_id, type, reference_id) WHERE resolved = FALSE;

-- pull requests
CREATE INDEX IF NOT EXISTS idx_pr_files_file_path ON pr_files (file_path);
