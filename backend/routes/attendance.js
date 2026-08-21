/* ============================================================
   Attendance — ingest from the ZKTeco K70 polling agent
   (attendance-agent/, running on the office VM) and serve it to the ERP
   front end. ERP-only data: brand-new tables (erp_attendance_logs,
   erp_employee_shifts), no ISO table is touched.

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

// The K70 reports this itself (byte 31 of each attendance record — see
// attendance-agent/agent.js's getAttendancesRaw) — a real device status,
// not a guess.
const VERIFY_STATE_LABELS = { 0: 'Check-in', 1: 'Check-out', 2: 'Break-out', 3: 'Break-in', 4: 'OT-in', 5: 'OT-out' };

function requireAgentKey(req, res, next) {
  const key = req.headers['x-agent-key'] || '';
  const expected = process.env.ATTENDANCE_AGENT_KEY || '';
  if (!expected) return res.status(500).json({ error: 'ATTENDANCE_AGENT_KEY is not configured on the server.' });
  if (key !== expected) return res.status(401).json({ error: 'Invalid agent key.' });
  next();
}

// POST /api/attendance/ingest  { punches: [{ deviceUserId, deviceUserName, timestamp, verifyMode, inOutMode }, ...] }
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
      `INSERT IGNORE INTO erp_attendance_logs (device_user_id, device_user_name, employee_id, punch_time, verify_mode, in_out_mode, source)
       VALUES (?,?,?,?,?,?,?)`,
      [deviceUserId, p.deviceUserName || null, employeeId, punchTime, p.verifyMode ?? null, p.inOutMode ?? null, 'zkteco-k70']
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
function rangeParams(req) {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || req.query.date || today;
  const to = req.query.to || req.query.date || from;
  return { from, to };
}

// GET /api/attendance/logs?from=&to=&q=&employeeId= — every individual
// punch as its own row, newest first. Unmapped device IDs (no matching
// employee) are still included, flagged unmapped:true, showing the name
// registered on the device itself, so nothing a person actually punched
// is ever hidden. "type" (Check-in/Check-out/...) is the real status the
// K70 reported (in_out_mode) whenever available; for older rows ingested
// before the agent decoded that byte, it falls back to alternating
// Check-in/Check-out in time order (1st = in, 2nd = out, ...).
router.get('/logs', requireHr, async (req, res) => {
  const { from, to } = rangeParams(req);
  const params = [from, to];
  let sql = `
    SELECT l.id, l.device_user_id, l.device_user_name, l.employee_id, l.punch_time, l.verify_mode, l.in_out_mode,
           e.employee_id AS emp_code, e.full_name
    FROM erp_attendance_logs l
    LEFT JOIN employees e ON e.id = l.employee_id
    WHERE DATE(l.punch_time) BETWEEN ? AND ?`;
  if (req.query.employeeId) { sql += ' AND l.employee_id = ?'; params.push(req.query.employeeId); }
  if (req.query.q) { sql += ' AND (e.employee_id LIKE ? OR e.full_name LIKE ? OR l.device_user_id LIKE ? OR l.device_user_name LIKE ?)'; const like = `%${req.query.q}%`; params.push(like, like, like, like); }
  sql += ' ORDER BY l.device_user_id ASC, l.punch_time ASC'; // grouped per person, ascending, so the fallback alternating-type math below is correct

  const [rows] = await pool.query(sql, params);
  const seq = {}; // device_user_id|day -> count so far, only used for rows with no real in_out_mode
  const out = rows.map((r) => {
    const day = new Date(r.punch_time).toISOString().slice(0, 10);
    const key = r.device_user_id + '|' + day;
    seq[key] = (seq[key] || 0) + 1;
    const type = VERIFY_STATE_LABELS[r.in_out_mode] || (seq[key] % 2 === 1 ? 'Check-in' : 'Check-out');
    return {
      id: r.id, deviceUserId: r.device_user_id, employeeId: r.employee_id,
      employeeCode: r.emp_code || r.device_user_id, employeeName: r.full_name || r.device_user_name || null,
      unmapped: !r.employee_id,
      time: r.punch_time, type,
      verifyMode: r.verify_mode, inOutMode: r.in_out_mode,
    };
  });
  out.sort((a, b) => new Date(b.time) - new Date(a.time)); // newest first
  res.json(out);
});

// GET /api/attendance/summary?from=&to=&q= — one row per employee per day.
// check-in/check-out use the REAL status the K70 reports (in_out_mode)
// whenever any punch that day has one: check-in = earliest Check-in-type
// punch, check-out = latest Check-out-type punch — so e.g. a single
// Check-out punch (someone clocking out, never having clocked in that
// day) correctly shows only a check-out, not a fake "Late check-in". Only
// falls back to plain first-punch/last-punch when NONE of that day's
// punches have a known status (older rows ingested before the agent
// decoded that byte). "late" is computed against that employee's own
// shift start (see PUT /shift/:employeeId) — 09:00 + 15 min grace by
// default, and only when there IS a check-in. Unmapped device IDs get
// their own row too, flagged unmapped:true.
router.get('/summary', requireHr, async (req, res) => {
  const { from, to } = rangeParams(req);
  const params = [from, to];
  let sql = `
    SELECT DATE_FORMAT(l.punch_time, '%Y-%m-%d') AS day, l.device_user_id, l.device_user_name, l.punch_time, l.in_out_mode,
           e.id AS employee_id, e.employee_id AS emp_code, e.full_name, e.department, e.location,
           COALESCE(sft.shift_start, '09:00:00') AS shift_start, COALESCE(sft.grace_minutes, 15) AS grace_minutes
    FROM erp_attendance_logs l
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN erp_employee_shifts sft ON sft.employee_id = e.id
    WHERE DATE(l.punch_time) BETWEEN ? AND ?`;
  if (req.query.q) {
    sql += ' AND (e.employee_id LIKE ? OR e.full_name LIKE ? OR l.device_user_id LIKE ? OR l.device_user_name LIKE ?)';
    const like = `%${req.query.q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY day ASC, l.device_user_id ASC, l.punch_time ASC';

  const [rows] = await pool.query(sql, params);

  const groups = new Map(); // "day|device_user_id" -> { meta, punches: [{time, mode}] }
  for (const r of rows) {
    const key = r.day + '|' + r.device_user_id;
    if (!groups.has(key)) groups.set(key, { meta: r, punches: [] });
    groups.get(key).punches.push({ time: r.punch_time, mode: r.in_out_mode });
  }

  const out = [];
  for (const { meta: r, punches } of groups.values()) {
    const hasKnownStatus = punches.some((p) => p.mode !== null && p.mode !== undefined);
    let checkIn = null, checkOut = null;
    if (hasKnownStatus) {
      const ins = punches.filter((p) => p.mode === 0);
      const outs = punches.filter((p) => p.mode === 1);
      checkIn = ins.length ? ins[0].time : null;
      checkOut = outs.length ? outs[outs.length - 1].time : null;
    } else {
      checkIn = punches[0].time;
      checkOut = punches.length > 1 ? punches[punches.length - 1].time : null;
    }

    const shiftStart = String(r.shift_start).slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
    let late = false;
    if (checkIn && r.employee_id) { // unmapped rows have no shift configured — skip Late
      const [sh, sm] = shiftStart.split(':').map(Number);
      const cutoff = new Date(checkIn);
      cutoff.setHours(sh, sm + r.grace_minutes, 0, 0);
      late = checkIn > cutoff;
    }
    out.push({
      date: r.day, employeeId: r.employee_id, employeeCode: r.emp_code || r.device_user_id, name: r.full_name || r.device_user_name || null,
      unmapped: !r.employee_id,
      department: r.department, location: r.location,
      checkIn, checkOut, punches: punches.length,
      shiftStart, graceMinutes: r.grace_minutes, late,
    });
  }
  out.sort((a, b) => (b.date + (b.checkIn || '')).localeCompare(a.date + (a.checkIn || '')));
  res.json(out);
});

// PUT /api/attendance/shift/:employeeId  { shiftStart:'09:00', graceMinutes:15 }
// Sets when this employee's shift starts, for the Late calculation above.
// Editable from the Employees (HR) form — see public/index.html.
router.put('/shift/:employeeId', requireHr, async (req, res) => {
  const id = +req.params.employeeId;
  if (!/^\d{1,2}:\d{2}$/.test(req.body.shiftStart || '')) return res.status(400).json({ error: 'shiftStart must be HH:MM.' });
  if (req.body.shiftEnd !== undefined && req.body.shiftEnd !== '' && !/^\d{1,2}:\d{2}$/.test(req.body.shiftEnd)) return res.status(400).json({ error: 'shiftEnd must be HH:MM.' });
  const shiftStart = req.body.shiftStart + ':00';
  const shiftEnd = req.body.shiftEnd ? req.body.shiftEnd + ':00' : null;
  const grace = Number.isFinite(+req.body.graceMinutes) ? Math.max(0, +req.body.graceMinutes) : 15;
  await pool.query(
    `INSERT INTO erp_employee_shifts (employee_id, shift_start, shift_end, grace_minutes) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE shift_start = VALUES(shift_start), shift_end = VALUES(shift_end), grace_minutes = VALUES(grace_minutes)`,
    [id, shiftStart, shiftEnd, grace]
  );
  await audit(req.erpUser.employeeId, 'attendance-shift-set', `${id} -> ${req.body.shiftStart}-${req.body.shiftEnd || '?'} (+${grace}m grace)`);
  res.json({ ok: true });
});

module.exports = router;
