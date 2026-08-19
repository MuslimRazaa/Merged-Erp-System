/* ============================================================
   Attendance — ingest from the ZKTeco K70 polling agent
   (attendance-agent/, running on the office VM) and serve it to the ERP
   front end. ERP-only data: a brand-new table (erp_attendance_logs), no
   ISO table is touched.

   Two different auth models on purpose:
   - POST /ingest is called by the unattended agent, not a human, so it
     authenticates with a long-lived static key (ATTENDANCE_AGENT_KEY),
     not an employee JWT.
   - Everything else is called by signed-in ERP users and goes through the
     normal requireAuth + Human Resources group check, same as
     routes/shared.js.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();

function requireAgentKey(req, res, next) {
  const key = req.headers['x-agent-key'] || '';
  const expected = process.env.ATTENDANCE_AGENT_KEY || '';
  if (!expected) return res.status(500).json({ error: 'ATTENDANCE_AGENT_KEY is not configured on the server.' });
  if (key !== expected) return res.status(401).json({ error: 'Invalid agent key.' });
  next();
}

// POST /api/attendance/ingest  { punches: [{ deviceUserId, timestamp, verifyMode, inOutMode }, ...] }
router.post('/ingest', requireAgentKey, async (req, res) => {
  const punches = Array.isArray(req.body.punches) ? req.body.punches : [];
  if (!punches.length) return res.json({ ok: true, saved: 0, skipped: 0 });

  let saved = 0;
  let skipped = 0;
  for (const p of punches) {
    const deviceUserId = String(p.deviceUserId ?? '').trim();
    const punchTime = p.timestamp ? new Date(p.timestamp) : null;
    if (!deviceUserId || !punchTime || Number.isNaN(punchTime.getTime())) { skipped++; continue; }

    const [emp] = await pool.query('SELECT id FROM employees WHERE employee_id = ?', [deviceUserId]);
    const employeeId = emp.length ? emp[0].id : null;

    const [result] = await pool.query(
      `INSERT IGNORE INTO erp_attendance_logs (device_user_id, employee_id, punch_time, verify_mode, in_out_mode, source)
       VALUES (?,?,?,?,?,?)`,
      [deviceUserId, employeeId, punchTime, p.verifyMode ?? null, p.inOutMode ?? null, 'zkteco-k70']
    );
    if (result.affectedRows) saved++; else skipped++; // skipped here = duplicate punch, already ingested
  }

  res.json({ ok: true, saved, skipped, at: new Date().toISOString() });
});

/* ---------------- everything below is for signed-in ERP users ---------------- */
router.use(requireAuth);
function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}

// GET /api/attendance/logs?date=YYYY-MM-DD&employeeId=123 — raw punches
router.get('/logs', requireHr, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const params = [date];
  let sql = `
    SELECT l.id, l.device_user_id, l.employee_id, l.punch_time, l.verify_mode, l.in_out_mode,
           e.employee_id AS emp_code, e.full_name
    FROM erp_attendance_logs l
    LEFT JOIN employees e ON e.id = l.employee_id
    WHERE DATE(l.punch_time) = ?`;
  if (req.query.employeeId) { sql += ' AND l.employee_id = ?'; params.push(req.query.employeeId); }
  sql += ' ORDER BY l.punch_time ASC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map((r) => ({
    id: r.id, deviceUserId: r.device_user_id, employeeId: r.employee_id,
    employeeCode: r.emp_code, employeeName: r.full_name || (r.employee_id ? null : `Unmapped (${r.device_user_id})`),
    time: r.punch_time, verifyMode: r.verify_mode, inOutMode: r.in_out_mode,
  })));
});

// GET /api/attendance/summary?date=YYYY-MM-DD — one row per employee: first
// punch of the day = check-in, last punch = check-out (the K70 doesn't
// reliably report in/out mode on every punch, so first/last is the
// pragmatic standard approach).
router.get('/summary', requireHr, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [rows] = await pool.query(
    `SELECT e.id AS employee_id, e.employee_id AS emp_code, e.full_name, e.department, e.location,
            MIN(l.punch_time) AS check_in, MAX(l.punch_time) AS check_out, COUNT(*) AS punches
     FROM erp_attendance_logs l
     JOIN employees e ON e.id = l.employee_id
     WHERE DATE(l.punch_time) = ?
     GROUP BY e.id, e.employee_id, e.full_name, e.department, e.location
     ORDER BY e.full_name ASC`,
    [date]
  );
  res.json(rows.map((r) => ({
    employeeId: r.employee_id, employeeCode: r.emp_code, name: r.full_name,
    department: r.department, location: r.location,
    checkIn: r.check_in, checkOut: r.punches > 1 ? r.check_out : null, punches: r.punches,
  })));
});

module.exports = router;
