/* ============================================================
   Generic register records (erp_records / erp_record_files) — server-side
   home for the front end's MODULES-driven screens: Compliance (Controlled
   Documents, Audits, NCR/CAPA, Risk, HSE, Management Reviews, M&TE /
   Calibration, API Q2), and — same engine, just a whitelist entry away —
   Inventory, Procurement and Fixed Assets.

   One row per record (data as JSON), so two people editing different
   records never overwrite each other, and a record saved on one PC is
   there on the next login / another PC. The module -> sidebar-group map
   below is the server's own authority on who may touch what (same role
   model as every other route), independent of what the browser claims.
   ============================================================ */
'use strict';
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const MODULE_GROUP = {
  docs: 'Compliance', audits: 'Compliance', ncrs: 'Compliance', risks: 'Compliance', hse: 'Compliance',
  mgtreviews: 'Compliance', calibrations: 'Compliance', apiq2: 'Compliance',
  invoices: 'Sales & AR', receipts: 'Sales & AR', salesorders: 'CRM',
  items: 'Inventory', stockmoves: 'Inventory',
  purchaseorders: 'Procurement', grns: 'Procurement', vendorbills: 'Procurement', payments: 'Procurement',
  assets: 'Fixed Assets', maintenance: 'Fixed Assets',
};

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 10 } });
function handleUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` : err.message,
    });
  }
  next(err);
}

router.param('module', (req, res, next, mod) => {
  const group = MODULE_GROUP[mod];
  if (!group) return res.status(404).json({ error: `Unknown module "${mod}".` });
  if (!canAccess(req.erpUser.role, group)) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to ${group}.` });
  req.recGroup = group;
  next();
});

function requireWrite(req, res, next) {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  next();
}

function parseRow(r) {
  try { return { ...JSON.parse(r.data), id: r.id }; } catch (e) { return { id: r.id }; }
}
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id); }
function cleanRecord(body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = { ...body, id };
  return rec;
}

// GET /api/records/:module — every live (non-deleted) record, oldest first
// (the screens reverse it themselves to show newest on top).
router.get('/:module', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, data FROM erp_records WHERE module = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
    [req.params.module]
  );
  res.json(rows.map(parseRow));
});

// POST /api/records/:module/import { records: [...] } — one-time upload of
// records that already exist only in someone's browser. INSERT IGNORE by id,
// so re-running it, or two PCs uploading the same record, never duplicates
// or overwrites what the server already has.
router.post('/:module/import', requireWrite, async (req, res) => {
  const list = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  if (list.length > 5000) return res.status(400).json({ error: 'Too many records in one import (max 5000).' });
  let added = 0;
  for (const r of list) {
    if (!r || !validId(r.id)) continue;
    const [result] = await pool.query(
      'INSERT IGNORE INTO erp_records (module, id, data, created_by, updated_by) VALUES (?,?,?,?,?)',
      [req.params.module, r.id, JSON.stringify(r), req.erpUser.employeeId, req.erpUser.employeeId]
    );
    if (result.affectedRows) added++;
  }
  if (added) await audit(req.erpUser.employeeId, 'records-import', `${req.params.module}: ${added} record(s)`);
  res.json({ ok: true, added, received: list.length });
});

async function upsert(req, res, id) {
  if (!validId(id)) return res.status(400).json({ error: 'Invalid record id.' });
  const rec = cleanRecord(req.body, id);
  if (!rec) return res.status(400).json({ error: 'Record body must be a JSON object.' });
  await pool.query(
    `INSERT INTO erp_records (module, id, data, created_by, updated_by) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by), deleted_at = NULL`,
    [req.params.module, id, JSON.stringify(rec), req.erpUser.employeeId, req.erpUser.employeeId]
  );
  await audit(req.erpUser.employeeId, 'record-save', `${req.params.module}/${id}`);
  res.json(rec);
}

// POST /api/records/:module — create (client supplies the id, so the browser
// can use it straight away and a retry is idempotent).
router.post('/:module', requireWrite, (req, res) => upsert(req, res, req.body && req.body.id));
// PUT /api/records/:module/:id — update.
router.put('/:module/:id', requireWrite, (req, res) => upsert(req, res, req.params.id));

// DELETE /api/records/:module/:id — soft delete: the row stays in the table
// (and its files stay attached) so an accidental delete is recoverable by
// clearing deleted_at, but it no longer appears in any list.
router.delete('/:module/:id', requireWrite, async (req, res) => {
  const [result] = await pool.query(
    'UPDATE erp_records SET deleted_at = NOW(), updated_by = ? WHERE module = ? AND id = ? AND deleted_at IS NULL',
    [req.erpUser.employeeId, req.params.module, req.params.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Record not found.' });
  await audit(req.erpUser.employeeId, 'record-delete', `${req.params.module}/${req.params.id}`);
  res.json({ ok: true });
});

/* ---------------- attached documents ---------------- */
const fileMeta = (f) => ({ id: f.id, name: f.file_name, type: f.mime_type, size: f.file_size, at: f.uploaded_at });

router.get('/:module/:id/files', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, file_name, mime_type, file_size, uploaded_at FROM erp_record_files WHERE module = ? AND record_id = ? ORDER BY id',
    [req.params.module, req.params.id]
  );
  res.json(rows.map(fileMeta));
});

router.post('/:module/:id/files', requireWrite, upload.array('files', 10), handleUploadErrors, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No file received.' });
  for (const f of files) {
    // multer hands the name over as latin1; browsers send UTF-8 — restore it
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    await pool.query(
      'INSERT INTO erp_record_files (module, record_id, file_name, mime_type, file_size, file_data, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      [req.params.module, req.params.id, name.slice(0, 255), f.mimetype, f.size, f.buffer, req.erpUser.employeeId]
    );
  }
  await audit(req.erpUser.employeeId, 'record-file-add', `${req.params.module}/${req.params.id}: ${files.length} file(s)`);
  const [rows] = await pool.query(
    'SELECT id, file_name, mime_type, file_size, uploaded_at FROM erp_record_files WHERE module = ? AND record_id = ? ORDER BY id',
    [req.params.module, req.params.id]
  );
  res.status(201).json(rows.map(fileMeta));
});

router.get('/:module/:id/files/:fid/download', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT file_name, mime_type, file_data FROM erp_record_files WHERE id = ? AND module = ? AND record_id = ?',
    [req.params.fid, req.params.module, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'File not found.' });
  const f = rows[0];
  res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
  res.send(f.file_data);
});

router.delete('/:module/:id/files/:fid', requireWrite, async (req, res) => {
  const [result] = await pool.query(
    'DELETE FROM erp_record_files WHERE id = ? AND module = ? AND record_id = ?',
    [req.params.fid, req.params.module, req.params.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'File not found.' });
  await audit(req.erpUser.employeeId, 'record-file-delete', `${req.params.module}/${req.params.id}/${req.params.fid}`);
  res.json({ ok: true });
});

module.exports = router;
