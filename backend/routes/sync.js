/* ============================================================
   Generic key/value sync — backs public/index.html's existing syncNow()
   engine EXACTLY as it already calls it:
     GET  {base}/sync/pull                -> { keys: { key: { ts, value } } }
     POST {base}/sync/push {keys:{...}}   -> { ok: true, saved }
   (aliased at /api/sync/pull and /api/sync/push too — see server.js)

   Previously erp-ptis-complete/server.js implemented a DIFFERENT shape
   here ({collections, blobs}) that the shipped front end never actually
   matched, so sync silently pushed/pulled nothing. This replaces that
   with the contract the front end genuinely uses, backed by MySQL
   (erp_kv_store) instead of the old flat JSON files.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/pull', async (req, res) => {
  const since = +(req.query.since || 0);
  const [rows] = since
    ? await pool.query('SELECT `key`, value, ts FROM erp_kv_store WHERE ts > ?', [since])
    : await pool.query('SELECT `key`, value, ts FROM erp_kv_store');
  const keys = {};
  rows.forEach((r) => { keys[r.key] = { ts: Number(r.ts), value: r.value }; });
  res.json({ keys, serverTimeUtc: new Date().toISOString() });
});

router.post('/push', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const entries = Object.entries(req.body.keys || {});
  let saved = 0;
  for (const [key, rec] of entries) {
    if (typeof key !== 'string' || !key.startsWith('perp_')) continue; // only ERP's own namespace
    await pool.query(
      'INSERT INTO erp_kv_store (`key`, value, ts, updated_by) VALUES (?,?,?,?) ' +
      'ON DUPLICATE KEY UPDATE value = VALUES(value), ts = VALUES(ts), updated_by = VALUES(updated_by)',
      [key, String(rec.value ?? ''), +rec.ts || Date.now(), req.erpUser.employeeId]
    );
    saved++;
  }
  await audit(req.erpUser.employeeId, 'sync-push', `${saved} key(s)`);
  res.json({ ok: true, saved });
});

module.exports = router;
