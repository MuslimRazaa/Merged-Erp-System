/* ============================================================
   Leave Request / Field Duty module.
   Brand-new ERP-only table (erp_leave_requests) — no ISO table is touched.

   Two-stage approval when a HOD is registered (erp_employee_profile.
   reports_to — see the Employees form's Access tab):
   - Employee fills the form: status starts 'InProcess'. Setting status to
     'ReleasedForApproval' is the employee's own "submit" action — at this
     point, if a HOD is assigned, ONLY that HOD can act on it; HR/Admin see
     nothing yet.
   - The HOD's decision (Approved/Rejected/...) is a RECOMMENDATION, not
     final — it's recorded separately (hod_status/hod_decided_by/
     hod_decided_at/hod_remarks) and the request moves to
     'PendingHRApproval'. HR now sees it, with the HOD's name and remarks.
   - HR/Admin then makes the actual FINAL call (decided_by/decided_at/
     decision_remarks) — THIS is what becomes the request's `status` and
     what the employee ultimately sees as the outcome. An
     Administrator/Sub Admin's decision is always final and immediate, at
     any stage (they can act in the HOD's place, or override HR).
   - No HOD assigned: unchanged single-stage flow — 'ReleasedForApproval'
     goes straight to any HR-access user, whose decision is final.
   - Escalation: if an HR-tier employee releases THEIR OWN leave for
     approval and has no HOD assigned, it's flagged requires_admin_approval
     — ordinary HR staff can still see it (read-only) but only an
     Administrator or Sub Admin can decide it.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const LEAVE_TYPES = ['Annual Leave', 'Casual Leave', 'Medical Leave', 'Field Break', 'Leave Without Pay', 'Field Shift', 'Compensatory Leave', 'Work From Home', 'Maternity Leave'];
const REQUEST_TYPES = ['Full Day', 'Half Day'];
const EMPLOYEE_STATUSES = ['InProcess', 'ReleasedForApproval', 'Cancelled'];
// Both the HOD's recommendation and HR/Admin's final call are picked from
// this same set — only PUT /:id/status's own logic below decides which of
// the two stages a given call belongs to. 'PendingHRApproval' is a distinct,
// server-only intermediate status (never accepted directly from a client)
// set automatically once a HOD has recorded their recommendation.
const DECISION_STATUSES = ['Approved', 'Rejected', 'Leave Without Pay', 'Cancelled', 'No Order', 'Valid for Reporting'];
const PENDING_HR_STATUS = 'PendingHRApproval';

function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}
function isAdminTier(role) { return role === 'Administrator' || role === 'Sub Admin'; }

// hod_id/hod_code/hod_name (the employee's registered HOD, via
// erp_employee_profile.reports_to — see the Employees form's Access tab)
// ride along on every row so every route below can make its HOD-routing
// decision from data it already has, with no extra query.
const ROW_SELECT = `
  SELECT lr.*, e.employee_id AS emp_code, e.full_name AS emp_name, e.department, e.location,
         cb.employee_id AS created_by_code, cb.full_name AS created_by_name,
         db.employee_id AS decided_by_code, db.full_name AS decided_by_name,
         hdb.employee_id AS hod_decided_by_code, hdb.full_name AS hod_decided_by_name,
         p.reports_to AS hod_id, hod.employee_id AS hod_code, hod.full_name AS hod_name
  FROM erp_leave_requests lr
  JOIN employees e ON e.id = lr.employee_id
  JOIN employees cb ON cb.id = lr.created_by
  LEFT JOIN employees db ON db.id = lr.decided_by
  LEFT JOIN employees hdb ON hdb.id = lr.hod_decided_by
  LEFT JOIN erp_employee_profile p ON p.employee_id = lr.employee_id
  LEFT JOIN employees hod ON hod.id = p.reports_to
`;
function shapeRow(r) {
  return {
    id: r.id, docNo: r.doc_no,
    employeeId: r.employee_id, employeeCode: r.emp_code, employeeName: r.emp_name,
    department: r.department, location: r.location,
    createdBy: r.created_by, createdByCode: r.created_by_code, createdByName: r.created_by_name,
    leaveRequestType: r.leave_request_type, leaveType: r.leave_type,
    fromDate: r.from_date, toDate: r.to_date, requestDate: r.request_date,
    purpose: r.purpose, remarks: r.remarks, status: r.status,
    requiresAdminApproval: r.requires_admin_approval === 1,
    // HOD's recommendation — NOT final; see decidedBy/decisionRemarks below for that.
    hodStatus: r.hod_status || null,
    hodDecidedByCode: r.hod_decided_by_code || null, hodDecidedByName: r.hod_decided_by_name || null,
    hodDecidedAt: r.hod_decided_at, hodRemarks: r.hod_remarks || null,
    // HR/Admin's FINAL decision — this is what `status` reflects once set.
    decidedBy: r.decided_by, decidedByCode: r.decided_by_code || null, decidedByName: r.decided_by_name || null,
    decidedAt: r.decided_at, decisionRemarks: r.decision_remarks || null,
    hodId: r.hod_id || null, hodCode: r.hod_code || null, hodName: r.hod_name || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// POST /api/leave — create a new request. Defaults to the caller's own
// leave; an explicit employeeId (someone else's) requires HR access.
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!REQUEST_TYPES.includes(b.leaveRequestType)) return res.status(400).json({ error: 'Invalid leave request type.' });
  if (!LEAVE_TYPES.includes(b.leaveType)) return res.status(400).json({ error: 'Invalid type of leave.' });
  if (!b.fromDate || !b.toDate) return res.status(400).json({ error: 'From Date and To Date are required.' });

  let targetId = req.erpUser.id;
  if (b.employeeId && +b.employeeId !== req.erpUser.id) {
    if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: 'Only HR can file a leave request on someone else\'s behalf.' });
    const [emp] = await pool.query('SELECT id FROM employees WHERE id = ?', [+b.employeeId]);
    if (!emp.length) return res.status(404).json({ error: 'Employee not found.' });
    targetId = +b.employeeId;
  }

  const [result] = await pool.query(
    `INSERT INTO erp_leave_requests
       (employee_id, created_by, leave_request_type, leave_type, from_date, to_date, request_date, purpose, remarks, status)
     VALUES (?,?,?,?,?,?,?,?,?,'InProcess')`,
    [targetId, req.erpUser.id, b.leaveRequestType, b.leaveType, b.fromDate, b.toDate, b.requestDate || new Date().toISOString().slice(0, 10), b.purpose || null, b.remarks || null]
  );
  const docNo = 'LV-' + String(result.insertId).padStart(6, '0');
  await pool.query('UPDATE erp_leave_requests SET doc_no = ? WHERE id = ?', [docNo, result.insertId]);
  await audit(req.erpUser.employeeId, 'leave-created', docNo);

  const [rows] = await pool.query(ROW_SELECT + ' WHERE lr.id = ?', [result.insertId]);
  res.status(201).json(shapeRow(rows[0]));
});

// PUT /api/leave/:id — edit the details of a request that's still InProcess
// (the owner/creator, or HR, can correct dates/type/purpose before submitting).
router.put('/:id', async (req, res) => {
  const id = +req.params.id;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const [rows] = await pool.query('SELECT * FROM erp_leave_requests WHERE id = ?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Leave request not found.' });
  const row = rows[0];
  const isOwnerOrCreator = req.erpUser.id === row.employee_id || req.erpUser.id === row.created_by;
  const hasHr = canAccess(req.erpUser.role, 'Human Resources');
  if (!isOwnerOrCreator && !hasHr) return res.status(403).json({ error: 'You cannot edit this leave request.' });
  if (row.status !== 'InProcess') return res.status(400).json({ error: 'Only a request still InProcess can be edited.' });

  const b = req.body || {};
  const fields = []; const values = [];
  if (b.leaveRequestType !== undefined) { if (!REQUEST_TYPES.includes(b.leaveRequestType)) return res.status(400).json({ error: 'Invalid leave request type.' }); fields.push('leave_request_type = ?'); values.push(b.leaveRequestType); }
  if (b.leaveType !== undefined) { if (!LEAVE_TYPES.includes(b.leaveType)) return res.status(400).json({ error: 'Invalid type of leave.' }); fields.push('leave_type = ?'); values.push(b.leaveType); }
  if (b.fromDate !== undefined) { fields.push('from_date = ?'); values.push(b.fromDate); }
  if (b.toDate !== undefined) { fields.push('to_date = ?'); values.push(b.toDate); }
  if (b.purpose !== undefined) { fields.push('purpose = ?'); values.push(b.purpose); }
  if (b.remarks !== undefined) { fields.push('remarks = ?'); values.push(b.remarks); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(id);
  await pool.query(`UPDATE erp_leave_requests SET ${fields.join(', ')} WHERE id = ?`, values);

  const [out] = await pool.query(ROW_SELECT + ' WHERE lr.id = ?', [id]);
  res.json(shapeRow(out[0]));
});

// PUT /api/leave/:id/status — the actual workflow engine. `status` is either
// one of EMPLOYEE_STATUSES (submit/cancel, by the owner/creator or HR) or one
// of DECISION_STATUSES (HR's call, escalated to Admin-tier only when this
// leave's requires_admin_approval flag is set).
router.put('/:id/status', async (req, res) => {
  const id = +req.params.id;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const status = String(req.body.status || '');
  const [rows] = await pool.query(ROW_SELECT + ' WHERE lr.id = ?', [id]); // ROW_SELECT (not a bare SELECT *) so row.hod_id is available below
  if (!rows.length) return res.status(404).json({ error: 'Leave request not found.' });
  const row = rows[0];

  const isOwnerOrCreator = req.erpUser.id === row.employee_id || req.erpUser.id === row.created_by;
  const hasHr = canAccess(req.erpUser.role, 'Human Resources');
  const adminTier = isAdminTier(req.erpUser.role);
  const escalated = row.requires_admin_approval === 1;
  const isHod = !!row.hod_id && row.hod_id === req.erpUser.id;

  if (EMPLOYEE_STATUSES.includes(status)) {
    if (!isOwnerOrCreator && !hasHr) return res.status(403).json({ error: 'You cannot change this leave request.' });
    if (DECISION_STATUSES.includes(row.status) && row.status !== 'Cancelled') {
      return res.status(400).json({ error: 'This request has already been decided by HR — it can no longer be resubmitted.' });
    }
    let requiresAdmin = row.requires_admin_approval;
    if (status === 'ReleasedForApproval') {
      // Escalate only for a SELF-filed request (employee filing their own
      // leave, not HR filing on someone else's behalf) by someone who
      // themselves has HR module access.
      const selfFiled = row.employee_id === row.created_by;
      const [erole] = await pool.query('SELECT role FROM erp_employee_roles WHERE employee_id = ? AND active = 1', [row.employee_id]);
      const empHasHr = erole.length && canAccess(erole[0].role, 'Human Resources');
      requiresAdmin = (selfFiled && empHasHr) ? 1 : 0;
    }
    await pool.query('UPDATE erp_leave_requests SET status = ?, requires_admin_approval = ? WHERE id = ?', [status, requiresAdmin, id]);
  } else if (DECISION_STATUSES.includes(status)) {
    const remarks = req.body.decisionRemarks != null ? String(req.body.decisionRemarks).trim() || null : null;
    const hodTurn = row.status === 'ReleasedForApproval' && !!row.hod_id && !adminTier;

    if (hodTurn) {
      // Stage 1 — the HOD's RECOMMENDATION, not final. Must be the actual
      // registered HOD; ordinary HR (even with full Human Resources access)
      // cannot act here at all, and never sees this request until the HOD
      // has recorded a call.
      if (!isHod) return res.status(403).json({ error: `This request must first go to ${row.hod_name || 'this employee\'s HOD'} — only their registered HOD or an Administrator/Sub Admin can act on it.` });
      await pool.query(
        `UPDATE erp_leave_requests SET status = ?, hod_status = ?, hod_decided_by = ?, hod_decided_at = NOW(), hod_remarks = ? WHERE id = ?`,
        [PENDING_HR_STATUS, status, req.erpUser.id, remarks, id]
      );
    } else {
      // Stage 2 — the FINAL call. Reached either because there's no HOD at
      // all, the HOD has already recommended (status = PendingHRApproval),
      // or an Administrator/Sub Admin is stepping in directly — an admin's
      // decision is always immediate and final, at any stage, no HOD
      // recommendation required first.
      if (!adminTier) {
        if (row.status === 'ReleasedForApproval') {
          // No HOD assigned — original single-stage rule: any HR-access
          // user decides directly, subject to the HR-tier self-filed escalation.
          if (!hasHr) return res.status(403).json({ error: 'Only HR can decide a leave request.' });
          if (escalated) return res.status(403).json({ error: 'This request was filed by an HR-tier employee for themselves — only an Administrator or Sub Admin can decide it.' });
        } else if (row.status === PENDING_HR_STATUS) {
          if (!hasHr) return res.status(403).json({ error: 'Only HR can give the final decision on a leave request.' });
        } else {
          return res.status(400).json({ error: `This request is not awaiting a decision (current status: ${row.status}).` });
        }
      }
      await pool.query(
        'UPDATE erp_leave_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?',
        [status, req.erpUser.id, remarks, id]
      );
    }
  } else {
    return res.status(400).json({ error: 'Unknown status.' });
  }

  await audit(req.erpUser.employeeId, 'leave-status-changed', `${row.doc_no || id} -> ${status}`);
  const [out] = await pool.query(ROW_SELECT + ' WHERE lr.id = ?', [id]);
  res.json(shapeRow(out[0]));
});

// GET /api/leave/mine — the caller's own leave history (any role).
router.get('/mine', async (req, res) => {
  const [rows] = await pool.query(ROW_SELECT + ' WHERE lr.employee_id = ? ORDER BY lr.created_at DESC', [req.erpUser.id]);
  res.json(rows.map(shapeRow));
});

// GET /api/leave/pending-count — for the nav badge / notification poll.
// Not gated to HR any more: a plain employee who is someone's registered
// HOD needs this too, so their team's requests reach them even without any
// Human Resources module access.
router.get('/pending-count', async (req, res) => {
  const adminTier = isAdminTier(req.erpUser.role);
  const hasHr = canAccess(req.erpUser.role, 'Human Resources');
  // isHod: is this person registered as ANYONE's HOD at all (regardless of
  // whether anything is pending right now) — the frontend uses this (plus
  // hasHr, which it already knows) to decide whether to show the Leave
  // Inbox bell at all. Someone who is neither HR nor anyone's HOD should
  // never see it, not even an empty one.
  const [hodCheck] = await pool.query('SELECT COUNT(*) c FROM erp_employee_profile WHERE reports_to = ?', [req.erpUser.id]);
  const isHod = hodCheck[0].c > 0;
  if (adminTier) {
    // An Administrator/Sub Admin can act at either stage — both a
    // still-with-the-HOD request and one already forwarded to HR count.
    const [rows] = await pool.query(`SELECT COUNT(*) c FROM erp_leave_requests WHERE status IN ('ReleasedForApproval', '${PENDING_HR_STATUS}')`);
    return res.json({ count: rows[0].c, isHod });
  }
  const [hodRows] = await pool.query(
    `SELECT COUNT(*) c FROM erp_leave_requests lr JOIN erp_employee_profile p ON p.employee_id = lr.employee_id
     WHERE lr.status = 'ReleasedForApproval' AND p.reports_to = ?`,
    [req.erpUser.id]
  );
  let count = hodRows[0].c;
  if (hasHr) {
    // + requests HR owns directly at the final stage: either no HOD was
    // ever assigned (straight to HR, unescalated), or a HOD already
    // recommended and it's now PendingHRApproval (any HOD, not just this
    // person's own reports — that's the "reflects back to HR" step).
    const [hrRows] = await pool.query(
      `SELECT COUNT(*) c FROM erp_leave_requests lr LEFT JOIN erp_employee_profile p ON p.employee_id = lr.employee_id
       WHERE (lr.status = '${PENDING_HR_STATUS}')
          OR (lr.status = 'ReleasedForApproval' AND (p.reports_to IS NULL OR p.employee_id IS NULL) AND (lr.requires_admin_approval = 0 OR lr.employee_id = ?))`,
      [req.erpUser.id]
    );
    count += hrRows[0].c;
  }
  res.json({ count, isHod });
});

// GET /api/leave — the decision queue: every request this caller is allowed
// to act on or should see. Administrator/Sub Admin see everything.
// - HR (non-admin-tier): sees everything EXCEPT another employee's still-
//   PENDING request that belongs to someone else's HOD to decide, or another
//   HR-tier peer's still-pending escalated self-filed request — i.e. HR is
//   blocked only from acting early, not from seeing a request once it's been
//   decided (that's the "reflects back to HR, with who approved it" bit).
// - Anyone else (no HR access — relying purely on being someone's HOD):
//   sees only their own reports' requests.
router.get('/', async (req, res) => {
  const adminTier = isAdminTier(req.erpUser.role);
  const hasHr = canAccess(req.erpUser.role, 'Human Resources');
  const where = [];
  const params = [];
  if (!adminTier) {
    if (hasHr) {
      where.push(`NOT (
        (p.reports_to IS NOT NULL AND p.reports_to <> ? AND lr.status = 'ReleasedForApproval')
        OR (lr.requires_admin_approval = 1 AND lr.employee_id <> ? AND lr.status = 'ReleasedForApproval')
      )`);
      params.push(req.erpUser.id, req.erpUser.id);
    } else {
      where.push('p.reports_to = ?');
      params.push(req.erpUser.id);
    }
  }
  if (req.query.status) {
    // Comma-separated is allowed (e.g. "ReleasedForApproval,PendingHRApproval"
    // for the topbar Leave Inbox, which needs both pending stages at once).
    const statuses = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length) { where.push(`lr.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  }
  const sql = ROW_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY lr.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(shapeRow));
});

// GET /api/leave/field-shift-days/:employeeId — total approved "Field Shift"
// leave days for one employee, used to compute their running Field Allowance
// total (per-day rate × these days) on the Employees/Compensation tab. Half
// Day requests count as 0.5/day; Full Day counts every day in the range.
// An employee can check their own; HR can check anyone's.
router.get('/field-shift-days/:employeeId', async (req, res) => {
  const employeeId = +req.params.employeeId;
  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Invalid employee id.' });
  if (employeeId !== req.erpUser.id && !canAccess(req.erpUser.role, 'Human Resources')) {
    return res.status(403).json({ error: 'You cannot view this.' });
  }
  const [rows] = await pool.query(
    `SELECT from_date, to_date, leave_request_type FROM erp_leave_requests
     WHERE employee_id = ? AND leave_type = 'Field Shift' AND status = 'Approved'`,
    [employeeId]
  );
  let days = 0;
  for (const r of rows) {
    const span = Math.round((new Date(r.to_date) - new Date(r.from_date)) / 86400000) + 1;
    days += r.leave_request_type === 'Half Day' ? span * 0.5 : span;
  }
  res.json({ days });
});

// GET /api/leave/:id — a single request, for the "Open" link from the HR
// inbox/queue (which only carries a list of summaries, not full detail).
// Registered LAST: it's a wildcard on the next path segment, so it must not
// shadow the more specific /mine and /pending-count routes above it.
router.get('/:id', async (req, res) => {
  const id = +req.params.id;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const [rows] = await pool.query(ROW_SELECT + ' WHERE lr.id = ?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Leave request not found.' });
  const row = rows[0];
  const isOwnerOrCreator = req.erpUser.id === row.employee_id || req.erpUser.id === row.created_by;
  const hasHr = canAccess(req.erpUser.role, 'Human Resources');
  const isHod = !!row.hod_id && row.hod_id === req.erpUser.id;
  if (!isOwnerOrCreator && !hasHr && !isHod) return res.status(403).json({ error: 'You cannot view this leave request.' });
  if (hasHr && !isOwnerOrCreator && !isHod && row.requires_admin_approval === 1 && !isAdminTier(req.erpUser.role)) {
    return res.status(403).json({ error: 'Only an Administrator or Sub Admin can view this request.' });
  }
  res.json(shapeRow(row));
});

module.exports = router;
