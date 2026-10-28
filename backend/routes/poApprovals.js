/* ============================================================
   Purchase Order approval workflow.

   Purchase Orders themselves stay in the generic erp_records table
   (module = 'purchaseorders', routes/records.js) — this file only adds
   the approval step on top: who gets to decide a Draft PO, and the
   PUT that actually decides it.

   Routing rule (confirmed with the business owner):
     - A PO's creator (erp_records.created_by, an employee CODE) is looked
       up against erp_employee_profile.reports_to (their registered
       manager/HOD, set on the Employees form's Access tab).
     - If that employee HAS a manager: the request goes to BOTH that
       manager AND the two standing approvers (employee codes '003' and
       '43').
     - If that employee has NO manager: it goes to the two standing
       approvers only.
   Any one of the resulting approvers deciding it is final — this is a
   single-stage, any-one-of approval, not a sequential chain.

   A PO is "pending" exactly while its stored status is 'Draft' (every
   new PO starts there, enforced client-side by the Purchase Orders form
   — see MODULES.purchaseorders.fields in public/index.html). Deciding it
   sets status to 'Issued' (approved) or 'Rejected'.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Matched numerically (CAST ... AS UNSIGNED), not as exact strings — so
// '003' here still matches an employee_id stored as '3' or '03', and vice
// versa. employee_id is otherwise a plain numeric code throughout this
// database (see employees table), so this is safe.
const STANDING_APPROVER_CODES = [3, 43];

async function standingApproverIds() {
  const [rows] = await pool.query('SELECT id FROM employees WHERE CAST(employee_id AS UNSIGNED) IN (?)', [STANDING_APPROVER_CODES]);
  return rows.map((r) => r.id);
}

// employee CODE (erp_records.created_by) -> { id, reportsTo } — batched into
// one query so the pending list doesn't fire one query per PO.
async function creatorInfoByCode(codes) {
  const map = {};
  if (!codes.length) return map;
  const [rows] = await pool.query(
    `SELECT e.employee_id AS code, e.id AS id, p.reports_to AS reportsTo
     FROM employees e LEFT JOIN erp_employee_profile p ON p.employee_id = e.id
     WHERE e.employee_id IN (?)`,
    [codes]
  );
  rows.forEach((r) => { map[r.code] = { id: r.id, reportsTo: r.reportsTo }; });
  return map;
}

function approverIdsFor(reportsTo, standingIds) {
  const ids = reportsTo ? [reportsTo, ...standingIds] : [...standingIds];
  return [...new Set(ids)];
}

async function draftPoRows() {
  const [rows] = await pool.query(
    "SELECT id, data, created_by FROM erp_records WHERE module = 'purchaseorders' AND deleted_at IS NULL"
  );
  return rows
    .map((r) => { try { return { id: r.id, createdByCode: r.created_by, rec: { ...JSON.parse(r.data), id: r.id } }; } catch (e) { return null; } })
    .filter((r) => r && r.rec.status === 'Draft');
}

// GET /api/po-approvals/pending — Draft POs this caller can decide.
router.get('/pending', async (req, res) => {
  const drafts = await draftPoRows();
  const standingIds = await standingApproverIds();
  const infoByCode = await creatorInfoByCode([...new Set(drafts.map((d) => d.createdByCode).filter(Boolean))]);
  const mine = drafts.filter((d) => {
    const info = infoByCode[d.createdByCode];
    const approverIds = approverIdsFor(info && info.reportsTo, standingIds);
    return approverIds.includes(req.erpUser.id);
  }).map((d) => d.rec);
  res.json(mine);
});

// GET /api/po-approvals/pending-count — badge + "should I even see the
// Requests bell" check for the topbar (same shape idea as GET
// /api/leave/pending-count's {count, isHod}).
router.get('/pending-count', async (req, res) => {
  const drafts = await draftPoRows();
  const standingIds = await standingApproverIds();
  const infoByCode = await creatorInfoByCode([...new Set(drafts.map((d) => d.createdByCode).filter(Boolean))]);
  let count = 0;
  const isApprover = standingIds.includes(req.erpUser.id) || drafts.some((d) => {
    const info = infoByCode[d.createdByCode];
    return info && info.reportsTo === req.erpUser.id;
  });
  drafts.forEach((d) => {
    const info = infoByCode[d.createdByCode];
    const approverIds = approverIdsFor(info && info.reportsTo, standingIds);
    if (approverIds.includes(req.erpUser.id)) count++;
  });
  res.json({ count, isApprover });
});

// PUT /api/po-approvals/:id/decide { decision: 'Issued' | 'Rejected' }
router.put('/:id/decide', async (req, res) => {
  const decision = String(req.body.decision || '');
  if (!['Issued', 'Rejected'].includes(decision)) return res.status(400).json({ error: "decision must be 'Issued' or 'Rejected'." });
  const [rows] = await pool.query(
    "SELECT id, data, created_by FROM erp_records WHERE module = 'purchaseorders' AND id = ? AND deleted_at IS NULL",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Purchase order not found.' });
  const row = rows[0];
  let rec;
  try { rec = JSON.parse(row.data); } catch (e) { return res.status(500).json({ error: 'Stored record is corrupt.' }); }
  if (rec.status !== 'Draft') return res.status(400).json({ error: `This PO has already been decided (status: ${rec.status}).` });

  const standingIds = await standingApproverIds();
  const infoByCode = await creatorInfoByCode([row.created_by].filter(Boolean));
  const info = infoByCode[row.created_by];
  const approverIds = approverIdsFor(info && info.reportsTo, standingIds);
  if (!approverIds.includes(req.erpUser.id)) {
    return res.status(403).json({ error: 'You are not an approver for this purchase order.' });
  }

  rec.status = decision;
  rec.decidedBy = req.erpUser.employeeId;
  rec.decidedByName = req.erpUser.name;
  rec.decidedAt = new Date().toISOString();
  await pool.query(
    'UPDATE erp_records SET data = ?, updated_by = ? WHERE module = ? AND id = ?',
    [JSON.stringify(rec), req.erpUser.employeeId, 'purchaseorders', row.id]
  );
  await audit(req.erpUser.employeeId, 'po-decided', `${rec.no || row.id} -> ${decision}`);
  res.json({ ...rec, id: row.id });
});

module.exports = router;
