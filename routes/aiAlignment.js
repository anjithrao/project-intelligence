'use strict';

const express = require('express');
const router  = express.Router();

// ─── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_URL          = process.env.OLLAMA_URL    || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL        = process.env.OLLAMA_MODEL  || 'deepseek-hackathon';
const TIMEOUT_MS          = 15_000;
const MAX_RETRIES         = 1;
const RETRY_DELAY_MS      = 1_500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 10;

const _rateLimitMap = new Map(); // workspaceId → { count, windowStart }

// ─── Fallback ──────────────────────────────────────────────────────────────────
const FALLBACK = Object.freeze({
  alignment_score : 50,
  drift_detected  : false,
  regression_risk : 'Unknown',
  explanation     : 'AI unavailable',
});

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info  : (msg, meta = {}) => console.log (JSON.stringify({ level: 'INFO',  msg, ...meta, ts: new Date().toISOString() })),
  warn  : (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...meta, ts: new Date().toISOString() })),
  error : (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...meta, ts: new Date().toISOString() })),
};

// ─── Rate Limiter ──────────────────────────────────────────────────────────────
function checkRateLimit(workspaceId) {
  const now   = Date.now();
  const entry = _rateLimitMap.get(workspaceId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateLimitMap.set(workspaceId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_CALLS) {
    log.warn('Rate limit exceeded', { workspaceId, count: entry.count });
    return false;
  }
  entry.count++;
  return true;
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────
function buildPrompt({ projectContext, featureDescription, prDiff }) {
  const safe = (str, max = 3000) => String(str ?? '').replace(/```/g, "'''").slice(0, max);
  return `You are a software alignment analyzer. Respond ONLY with a valid JSON object. No markdown, no fences, no prose outside JSON.

Required fields: alignment_score (integer 0-100), drift_detected (boolean), regression_risk ("Low"|"Medium"|"High"), explanation (max 3 sentences).

<PROJECT_CONTEXT>
${safe(projectContext)}
</PROJECT_CONTEXT>

<FEATURE_DESCRIPTION>
${safe(featureDescription, 1000)}
</FEATURE_DESCRIPTION>

<PR_DIFF>
${safe(prDiff, 4000)}
</PR_DIFF>`.trim();
}

// ─── JSON Extraction ───────────────────────────────────────────────────────────
function validateShape(obj) {
  if (typeof obj !== 'object' || obj === null) throw new Error('Not an object');
  let score = Number(obj.alignment_score);
  if (isNaN(score)) throw new Error('Invalid alignment_score');
  score = Math.max(0, Math.min(100, Math.round(score)));
  let drift = typeof obj.drift_detected === 'boolean' ? obj.drift_detected : score < 70;
  const RISKS = ['Low','Medium','High'];
  const risk  = RISKS.find(r => r.toLowerCase() === String(obj.regression_risk ?? '').toLowerCase()) ?? 'Medium';
  const explanation = String(obj.explanation ?? '').slice(0, 500);
  return { alignment_score: score, drift_detected: drift, regression_risk: risk, explanation };
}

function extractJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return validateShape(JSON.parse(raw)); } catch (_) {}
  try { return validateShape(JSON.parse(raw.replace(/^```(?:json)?\s*/im,'').replace(/\s*```$/m,'').trim())); } catch (_) {}
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) { try { return validateShape(JSON.parse(m[0])); } catch (_) {} }
  return null;
}

// ─── Ollama Caller ─────────────────────────────────────────────────────────────
async function callOllamaOnce(prompt) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return data?.response ?? '';
  } finally {
    clearTimeout(timer);
  }
}

async function callOllamaWithRetry(prompt) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.warn('Retrying Ollama call', { attempt });
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    try { return await callOllamaOnce(prompt); }
    catch (err) {
      lastError = err;
      const isTransient = err.name === 'AbortError' || err.message.startsWith('fetch');
      log.warn('Ollama call failed', { attempt, error: err.message, isTransient });
      if (!isTransient) break;
    }
  }
  throw lastError;
}

// ─── Route ─────────────────────────────────────────────────────────────────────
router.post('/alignment', async (req, res) => {
  const { workspaceId, featureDescription, projectContext, prDiff } = req.body ?? {};
  const startMs = Date.now();

  const missing = ['workspaceId','featureDescription','projectContext','prDiff'].filter(k => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: 'Invalid request', details: missing.map(k => `${k} is required`) });

  if (!checkRateLimit(workspaceId)) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: `Max ${RATE_LIMIT_MAX_CALLS} AI calls per minute per workspace` });
  }

  log.info('Alignment request received', { workspaceId });

  let aiResult     = null;
  let usedFallback = false;

  try {
    const raw = await callOllamaWithRetry(buildPrompt({ projectContext, featureDescription, prDiff }));
    log.info('Ollama responded', { workspaceId, raw_length: raw.length });
    aiResult = extractJson(raw);
    if (!aiResult) { log.warn('JSON extraction failed — using fallback', { workspaceId }); usedFallback = true; }
  } catch (err) {
    log.error('Ollama call failed — using fallback', { workspaceId, error: err.message, timeout: err.name === 'AbortError' });
    usedFallback = true;
  }

  const result     = aiResult ?? { ...FALLBACK };
  const durationMs = Date.now() - startMs;

  log.info('Alignment response dispatched', { workspaceId, alignment_score: result.alignment_score, used_fallback: usedFallback, duration_ms: durationMs });

  return res.status(200).json({ ...result, meta: { used_fallback: usedFallback, duration_ms: durationMs, model: OLLAMA_MODEL } });
});

module.exports = router;
