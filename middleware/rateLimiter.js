'use strict';

const rateLimit = require('express-rate-limit');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  keyGenerator: (req) => req.ip,
  skip: (req) => req.webhookSignatureVerified === true,
});

module.exports = { webhookLimiter };
