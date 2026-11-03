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
  mgtreviews: 'Compliance', calibrations: 'Compliance', apiq2: 'Compliance', dcr: 'Compliance',
  invoices: 'Sales & AR', receipts: 'Sales & AR', salesorders: 'CRM', leads: 'CRM', activities: 'CRM',
  trainings: 'Human Resources',
  items: 'Inventory', stockmoves: 'Inventory',
  purchaseorders: 'Procurement', grns: 'Procurement', vendorbills: 'Procurement', payments: 'Procurement',
  assets: 'Fixed Assets', maintenance: 'Fixed Assets',
  // Inspection: work orders, client contracts and the saved inspection-report
  // library. These used to live only in the browser that wrote them, so a
  // report (or contract, or lead) filed at one site was invisible elsewhere.
  workorders: 'Inspection', contracts: 'Inspection', ir_library: 'Inspection',
  // where a job happened: Location (from the shared master) + Sub Location
  insplocs: 'Inspection',
  // Accounting (multi-company double-entry GL) — companies (each with its
  // own embedded chart of accounts), currencies and journal entries used to
  // live ONLY in the browser that entered them (a single JSON blob in
  // localStorage), invisible to every other sign-in. Same fix as everything
  // else above: real rows in erp_records, shared by everyone.
  glcompanies: 'Accounting', glcurrencies: 'Accounting', gljournals: 'Accounting',
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

/* ---------------- approval, and who may grant it ----------------
   A report or a work order carries an approval state. The browser holds
   anything still InProcess on the machine that wrote it; this is the
   other half of that rule, enforced where it cannot be edited:

     - Approved is the HOD's word. Whoever pushes a record may not hand
       it to themselves, so a push may not raise a record to Approved
       unless the pusher is that record's approver (an admin, or the HOD
       the record's author reports to).
     - An approval a push does not mention is not changed. An offline app
       that has never heard of approval cannot clear one by saving.
*/
const APPR_MODS = new Set(['ir_library', 'workorders']);
const APPROVALS = ['InProcess', 'ReleasedForApproval', 'Approved'];
function isAdminTier(role) { return role === 'Administrator' || role === 'Sub Admin'; }
function apprOf(rec) {
  const v = rec && rec.approval;
  return APPROVALS.indexOf(v) >= 0 ? v : 'InProcess';
}
/* Everyone who reports to this person, as employees.id values. Used both
   to decide whether they may approve and to address a notification. */
async function hodOf(employeeRowId) {
  const [rows] = await pool.query(
    'SELECT reports_to FROM erp_employee_profile WHERE employee_id = ? LIMIT 1',
    [employeeRowId]
  );
  return (rows[0] && rows[0].reports_to) || null;
}
async function currentApproval(module, id) {
  const [rows] = await pool.query(
    'SELECT data FROM erp_records WHERE module = ? AND id = ? LIMIT 1', [module, id]
  );
  if (!rows[0]) return null;
  try { return apprOf(JSON.parse(rows[0].data)); } catch (e) { return null; }
}
/* One notice per record per recipient, refreshed rather than repeated. */
async function notify(recipientId, actorId, kind, module, recordId, title, body) {
  if (!recipientId) return false;
  if (recipientId === actorId) return false;      // nobody is told about themselves
  await pool.query(
    `INSERT INTO erp_notifications (recipient_id, actor_id, kind, module, record_id, title, body)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE actor_id = VALUES(actor_id), title = VALUES(title),
       body = VALUES(body), created_at = NOW(), read_at = NULL`,
    [recipientId, actorId || null, kind, module || null, recordId || null, title, body || null]
  );
  return true;
}

function cleanRecord(body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = { ...body, id };
  return rec;
}

/* ---------------- what is waiting on you ----------------
   Declared BEFORE /:module, or Express reads "approvals" as a module name
   and the :module param handler turns it down as unknown.

   Who may decide: an admin tier sees everything, everyone else only the
   records whose author reports to them. That is the test upsert() applies
   when the approval is actually pushed, so nothing is offered here that
   would be refused there.

   data is LONGTEXT rather than a JSON column; MySQL casts it for
   JSON_EXTRACT. A record saved by an older build has no approval key at
   all and is simply not released, which is how apprOf() reads it too.
*/
const APPR_SQL_FROM = `
  FROM erp_records r
  LEFT JOIN employees e ON e.employee_id = r.created_by
  LEFT JOIN erp_employee_profile p ON p.employee_id = e.id
 WHERE r.module IN (?) AND r.deleted_at IS NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.approval')) = 'ReleasedForApproval'
   AND (r.created_by IS NULL OR r.created_by <> ?)
   AND (? = 1 OR p.reports_to = ?)`;

function apprArgs(req) {
  return [[...APPR_MODS], req.erpUser.employeeId,
          isAdminTier(req.erpUser.role) ? 1 : 0, req.erpUser.id];
}
/* May this person accept this record? The author is ruled out before
   anything else, because an approval you grant yourself is not one.
   Both doors into the decision - a pushed Approved and the Approve
   button - go through here, so they cannot drift apart. */
async function mayApprove(req, authorCode) {
  if (authorCode && authorCode === req.erpUser.employeeId) return false;
  if (isAdminTier(req.erpUser.role)) return true;
  if (!authorCode) return false;
  const [authorRow] = await pool.query(
    'SELECT id FROM employees WHERE employee_id = ? LIMIT 1', [authorCode]
  );
  const authorId = authorRow[0] && authorRow[0].id;
  return !!authorId && (await hodOf(authorId)) === req.erpUser.id;
}

/* Whether to show the Requests button at all, and the number on it.
   isApprover also tells the browser who may be offered "Approved". */
router.get('/approvals/pending-count', async (req, res) => {
  const [rows] = await pool.query(`SELECT COUNT(*) c ${APPR_SQL_FROM}`, apprArgs(req));
  const [reports] = await pool.query(
    'SELECT COUNT(*) c FROM erp_employee_profile WHERE reports_to = ?', [req.erpUser.id]
  );
  res.json({
    count: rows[0].c,
    isApprover: isAdminTier(req.erpUser.role) || reports[0].c > 0,
  });
});

/* POST /api/records/approvals/:module/:id/approve - the HOD's word.

   Same test as upsert() applies to a pushed Approved, re-run here because
   this is a separate door into the same decision and a door is only as
   good as its own lock. */
router.post('/approvals/:module/:id/approve', requireWrite, async (req, res) => {
  const { module, id } = req.params;
  if (!APPR_MODS.has(module)) return res.status(400).json({ error: `Nothing is approved in "${module}".` });
  if (!canAccess(req.erpUser.role, MODULE_GROUP[module])) {
    return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to ${MODULE_GROUP[module]}.` });
  }
  const [rows] = await pool.query(
    'SELECT data, created_by FROM erp_records WHERE module = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [module, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'That record is no longer on the server.' });

  if (!(await mayApprove(req, rows[0].created_by))) {
    return res.status(403).json({
      error: rows[0].created_by === req.erpUser.employeeId
        ? 'You released this one, so it is not yours to approve.'
        : 'Only the HOD this record answers to can approve it.' });
  }

  let rec;
  try { rec = JSON.parse(rows[0].data); } catch (e) { return res.status(500).json({ error: 'That record cannot be read.' }); }
  if (apprOf(rec) !== 'ReleasedForApproval') {
    return res.status(409).json({ error: `It is ${apprOf(rec)}, not waiting for approval.` });
  }
  rec.approval = 'Approved';
  rec.id = id;
  await pool.query(
    'UPDATE erp_records SET data = ?, updated_by = ? WHERE module = ? AND id = ?',
    [JSON.stringify(rec), req.erpUser.employeeId, module, id]
  );
  await audit(req.erpUser.employeeId, 'record-approve', `${module}/${id}`);
  /* The thing they were told about is done, so the notice stops waiting. */
  await pool.query(
    'UPDATE erp_notifications SET read_at = NOW() WHERE recipient_id = ? AND module = ? AND record_id = ? AND read_at IS NULL',
    [req.erpUser.id, module, id]
  );
  res.json(rec);
});

/* The list. Only the handful of fields the panel shows: a report carries
   its photographs in `data`, and nobody needs those to decide. */
router.get('/approvals/pending', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.module, r.id, r.created_by, r.updated_at,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.type'))          AS type,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.fields.docId'))  AS docId,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.fields.no'))     AS repNo,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.fields.client')) AS repClient,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.fields.date'))   AS repDate,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.no'))            AS woNo,
            JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.client'))        AS woClient,
            e.full_name AS authorName
       ${APPR_SQL_FROM} ORDER BY r.updated_at DESC LIMIT 100`,
    apprArgs(req)
  );
  res.json(rows.map((r) => ({
    module: r.module,
    id: r.id,
    what: r.module === 'workorders' ? 'Work order' : 'Report',
    label: r.module === 'workorders' ? (r.woNo || r.id) : (r.docId || r.repNo || r.id),
    type: r.module === 'workorders' ? '' : (r.type || ''),
    client: (r.module === 'workorders' ? r.woClient : r.repClient) || '',
    date: r.repDate || '',
    author: r.authorName || r.created_by || '',
    at: r.updated_at,
  })));
});

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

  const module = req.params.module;
  let released = false;
  if (APPR_MODS.has(module)) {
    const was = await currentApproval(module, id);
    /* A body that says nothing about approval leaves it as it was. */
    const want = Object.prototype.hasOwnProperty.call(req.body, 'approval')
      ? apprOf(req.body) : (was || 'InProcess');
    if (want === 'Approved' && was !== 'Approved') {
      /* Only the person this work answers to may accept it. The author is
         whoever first created the row; on a first push that is the pusher
         themselves, which is exactly the case this refuses. */
      const [owner] = await pool.query(
        'SELECT created_by FROM erp_records WHERE module = ? AND id = ? LIMIT 1', [module, id]
      );
      const authorCode = owner[0] && owner[0].created_by;
      if (!(await mayApprove(req, authorCode))) {
        return res.status(403).json({
          error: authorCode === req.erpUser.employeeId
            ? 'You released this one, so it is not yours to approve.'
            : 'Only the HOD this report answers to can approve it.' });
      }
    }
    rec.approval = want;
    released = want === 'ReleasedForApproval' && was !== 'ReleasedForApproval';
  }

  await pool.query(
    `INSERT INTO erp_records (module, id, data, created_by, updated_by) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by), deleted_at = NULL`,
    [req.params.module, id, JSON.stringify(rec), req.erpUser.employeeId, req.erpUser.employeeId]
  );
  await audit(req.erpUser.employeeId, 'record-save', `${req.params.module}/${id}`);
  /* Pushed and released: the person this inspector reports to is told,
     here, where we know it actually reached the server. A failure to
     notify must not lose the record that was just saved. */
  if (released) {
    try {
      const hod = await hodOf(req.erpUser.id);
      const what = module === 'workorders' ? 'Work order' : 'Report';
      const label = (rec.fields && (rec.fields.docId || rec.fields.no)) || rec.no || id;
      await notify(hod, req.erpUser.id, 'approval', module, id,
        what + ' ' + label + ' is released for approval',
        (req.erpUser.name || req.erpUser.employeeId) + ' released it for your approval.');
    } catch (e) { console.warn('[records] notify failed:', e.message); }
  }
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

// GET /api/records/:module/files-summary — { recordId: fileCount, ... } for
// every record in this module that has at least one file, in one request —
// lets a list screen show a per-row "has attachment" pill without an N+1
// request per row.
router.get('/:module/files-summary', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT record_id, COUNT(*) c FROM erp_record_files WHERE module = ? GROUP BY record_id',
    [req.params.module]
  );
  const out = {};
  rows.forEach((r) => { out[r.record_id] = r.c; });
  res.json(out);
});

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
    /* A report photograph is named by the sha256 of its own bytes, so the
       same name IS the same picture: receiving it again replaces it rather
       than storing a second copy. Deliberately only these names - two
       documents a person attached can both be called scan.pdf, and
       dropping one of those would lose somebody's certificate. */
    if (/^img-[0-9a-f]{64}\.[a-z0-9]+$/i.test(name)) {
      await pool.query(
        'DELETE FROM erp_record_files WHERE module = ? AND record_id = ? AND file_name = ?',
        [req.params.module, req.params.id, name]
      );
    }
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
