'use strict';

require('dotenv').config();

const http       = require('http');
const express    = require('express');
const wsManager  = require('./websocket/wsManager');
const { errorHandler } = require('./middleware/errorHandler');

const app    = express();
const server = http.createServer(app);

// rawBody required for HMAC signature verification in webhook
app.use(express.json({
  limit:  '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/workspace', require('./routes/workspace'));
app.use('/webhook',   require('./routes/webhook'));
app.use('/ai',        require('./routes/aiAlignment'));

// Health-check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Global Error Handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ─── WebSocket ─────────────────────────────────────────────────────────────────
wsManager.init(server);

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Env: ${process.env.NODE_ENV || 'development'}`);
});
//=====-=rhjkladsafgd
module.exports = { app, server };
