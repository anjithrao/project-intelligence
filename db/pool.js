'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:                    process.env.PG_HOST     || 'localhost',
  port:                    parseInt(process.env.PG_PORT) || 5432,
  database:                process.env.PG_DATABASE || 'project_intelligence',
  user:                    process.env.PG_USER     || 'postgres',
  password:                process.env.PG_PASSWORD || '',
  max:                     20,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Idle client error:', err.message);
});

module.exports = pool;
