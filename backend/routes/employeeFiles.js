/* ============================================================
   Employee files (erp_employee_files) — the HR "Documents" tab on the
   Employee view: profile photo, CV, ID copies, certificates, contracts...
   Human Resources access only (same gate as the rest of HR), and
   read-only accounts can't upload or delete.
   Files travel as real multipart uploads (memory storage -> LONGBLOB), not
   base64 inside JSON, same as the other ERP file uploads.
   ============================================================ */
'use strict';
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['Photo', 'CV', 'ID / Passport', 'Education', 'Certificate', 'Contract', 'Other'];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
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

function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}
function requireWrite(req, res, next) {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  next();
}
router.use(requireHr);

router.param('employeeId', async (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid employee id.' });
  const [rows] = await pool.query('SELECT id FROM employees WHERE id = ?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Employee not found.' });
  next();
});

const meta = (f) => ({ id: f.id, category: f.category, name: f.file_name, type: f.mime_type, size: f.file_size, at: f.uploaded_at, by: f.uploaded_by });

// GET /api/employee-files/:employeeId — everything on file (no bytes).
router.get('/:employeeId', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, category, file_name, mime_type, file_size, uploaded_at, uploaded_by FROM erp_employee_files WHERE employee_id = ? ORDER BY id DESC',
    [req.params.employeeId]
  );
  res.json(rows.map(meta));
});

// GET /api/employee-files/:employeeId/photo — the current profile photo, or 404.
router.get('/:employeeId/photo', async (req, res) => {
  const [rows] = await pool.query(
    "SELECT mime_type, file_data FROM erp_employee_files WHERE employee_id = ? AND category = 'Photo' ORDER BY id DESC LIMIT 1",
    [req.params.employeeId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No photo.' });
  res.setHeader('Content-Type', rows[0].mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.send(rows[0].file_data);
});

// POST /api/employee-files/:employeeId  multipart: files[] + category
// A Photo replaces the previous one (only one profile photo is kept) and
// must be an image; every other category just adds to the pile.
router.post('/:employeeId', requireWrite, upload.array('files', 10), handleUploadErrors, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No file received.' });
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  if (category === 'Photo') {
    if (files.length > 1) return res.status(400).json({ error: 'Upload one photo at a time.' });
    if (!/^image\//.test(files[0].mimetype)) return res.status(400).json({ error: 'The photograph must be an image file.' });
    if (files[0].size > MAX_PHOTO_BYTES) return res.status(413).json({ error: `The photograph is larger than ${MAX_PHOTO_BYTES / 1024 / 1024} MB.` });
    await pool.query("DELETE FROM erp_employee_files WHERE employee_id = ? AND category = 'Photo'", [req.params.employeeId]);
  }
  for (const f of files) {
    // multer hands the name over as latin1; browsers send UTF-8 — restore it
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    await pool.query(
      'INSERT INTO erp_employee_files (employee_id, category, file_name, mime_type, file_size, file_data, uploaded_by) VALUES (?,?,?,?,?,?,?)',
      [req.params.employeeId, category, name.slice(0, 255), f.mimetype, f.size, f.buffer, req.erpUser.employeeId]
    );
  }
  await audit(req.erpUser.employeeId, 'employee-file-add', `employee ${req.params.employeeId}: ${files.length} ${category} file(s)`);
  const [rows] = await pool.query(
    'SELECT id, category, file_name, mime_type, file_size, uploaded_at, uploaded_by FROM erp_employee_files WHERE employee_id = ? ORDER BY id DESC',
    [req.params.employeeId]
  );
  res.status(201).json(rows.map(meta));
});

router.get('/:employeeId/:fid/download', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT file_name, mime_type, file_data FROM erp_employee_files WHERE id = ? AND employee_id = ?',
    [req.params.fid, req.params.employeeId]
  );
  if (!rows.length) return res.status(404).json({ error: 'File not found.' });
  res.setHeader('Content-Type', rows[0].mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`);
  res.send(rows[0].file_data);
});

router.delete('/:employeeId/:fid', requireWrite, async (req, res) => {
  const [result] = await pool.query('DELETE FROM erp_employee_files WHERE id = ? AND employee_id = ?', [req.params.fid, req.params.employeeId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'File not found.' });
  await audit(req.erpUser.employeeId, 'employee-file-delete', `employee ${req.params.employeeId}: file ${req.params.fid}`);
  res.json({ ok: true });
});

module.exports = router;
