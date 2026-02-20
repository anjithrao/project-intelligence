'use strict';

// Global Express error handler — must be last middleware registered
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  console.error(`[ERROR] ${req.method} ${req.path} → ${status}:`, err.message);

  if (status === 409) return res.status(409).json({ error: err.code || 'CONFLICT', message: err.message });
  if (status === 404) return res.status(404).json({ error: 'NOT_FOUND',      message: err.message });
  if (status === 403) return res.status(403).json({ error: 'ACCESS_DENIED',  message: err.message });

  return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong.' });
}

module.exports = { errorHandler };
