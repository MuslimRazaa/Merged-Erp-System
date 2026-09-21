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
const { loadFieldPresence, financialYearRange, toYmd, daysBetween, localYmd } = require('../fieldJobs');

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

    // Match the device's numeric code to employees.employee_id tolerant of
    // leading zeros either side (device "09" == HR record "9") but never
    // across genuinely different numbers (9 must never match 90/19/999) —
    // exact string match always wins first for non-numeric IDs.
    const [emp] = await pool.query(
      `SELECT id FROM employees
       WHERE employee_id = ?
          OR (employee_id REGEXP '^[0-9]+$' AND ? REGEXP '^[0-9]+$' AND CAST(employee_id AS UNSIGNED) = CAST(? AS UNSIGNED))
       LIMIT 1`,
      [deviceUserId, deviceUserId, deviceUserId]
    );
    const employeeId = emp.length ? emp[0].id : null;

    const [result] = await pool.query(
      `INSERT IGNORE INTO erp_attendance_logs (device_user_id, device_user_name, employee_id, punch_time, verify_mode, in_out_mode, source, device_location)
       VALUES (?,?,?,?,?,?,?,?)`,
      [deviceUserId, p.deviceUserName || null, employeeId, punchTime, p.verifyMode ?? null, p.inOutMode ?? null, 'zkteco-k70', p.location || null]
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
// Local-midnight arithmetic throughout this file — NOT toISOString()/bare
// `new Date(string)`, both UTC-based and known to silently shift dates back
// a day in timezones ahead of UTC (Pakistan Standard Time). mysql2 returns
// DATE columns as real JS Date objects, not strings, so parseYMD branches.
const parseYMD = (s) => (s instanceof Date ? new Date(s.getFullYear(), s.getMonth(), s.getDate()) : (() => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); })());
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function saturdaysInMonth(year, month /* 1-12 */) {
  const days = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) { if (d.getDay() === 6) days.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return days;
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
    SELECT l.id, l.device_user_id, l.device_user_name, l.employee_id, l.punch_time, l.verify_mode, l.in_out_mode, l.device_location,
           e.employee_id AS emp_code, e.full_name
    FROM erp_attendance_logs l
    LEFT JOIN employees e ON e.id = l.employee_id
    WHERE DATE(l.punch_time) BETWEEN ? AND ?`;
  if (req.query.employeeId) { sql += ' AND l.employee_id = ?'; params.push(req.query.employeeId); }
  if (req.query.location) { sql += ' AND l.device_location = ?'; params.push(req.query.location); }
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
      unmapped: !r.employee_id, location: r.device_location || null,
      time: r.punch_time, type,
      verifyMode: r.verify_mode, inOutMode: r.in_out_mode,
    };
  });
  out.sort((a, b) => new Date(b.time) - new Date(a.time)); // newest first
  res.json(out);
});

// GET /api/attendance/locations — distinct machine/office labels seen in
// the punch log so far (agent.js's DEVICE_NAME / DEVICE_2_NAME / ...), for
// the Location filter dropdown. Detected automatically from real punches —
// nothing to configure by hand, and a location only appears here once that
// office's machine has actually pushed at least one punch.
router.get('/locations', requireHr, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DISTINCT device_location FROM erp_attendance_logs WHERE device_location IS NOT NULL AND device_location <> '' ORDER BY device_location ASC`
  );
  res.json(rows.map((r) => r.device_location));
});

// The actual computation behind GET /summary below — pulled out so
// routes/payroll.js can reuse the exact same day-by-day classification
// (Sunday/Saturday-quota/Holiday/Leave/Present/Absent, late-vs-shift) for
// payroll instead of re-deriving it and risking the two silently drifting
// apart. `filter.q` free-texts on ID/name; `filter.employeeIds` restricts to
// specific internal ids (payroll's "employee-wise" mode); passing neither
// returns the whole roster (payroll's "department-wise" mode filters by
// department in JS afterward, since it's a small in-memory list either way).
// Precedence for each day's dayType (highest wins):
//   1. Company holiday (erp_holidays — Gazetted/Islamic/CompanyOff)
//   2. Sunday -> WeeklyOff
//   3. Approved leave -> Leave (paid, no deduction)
//   4. Leave Without Pay -> LeaveWithoutPay (deducted)
//   5. Actual attendance exists -> Present (showing up always counts,
//      even on an otherwise-off day)
//   6. Saturday, and within this employee's month's free-Saturday quota
//      (Permanent = 2 mandatory/month, everyone else = 0 free) -> WeeklyOff
//   7. otherwise -> Absent
// check-in/check-out use the REAL status the K70 reports (in_out_mode)
// whenever any punch that day has one; "late" is computed against the
// employee's own shift start (see PUT /shift/:employeeId), and
// lateMinutes/overtimeMinutes (beyond shift_end, when set) ride along too —
// payroll needs the actual minutes, not just the boolean, for its "3 lates =
// 1 absent, offset by same-day overtime" rule.
async function computeAttendanceRows(from, to, filter = {}) {
  const rangeFrom = parseYMD(from), rangeTo = parseYMD(to);

  let empSql = `
    SELECT e.id, e.employee_id AS emp_code, e.full_name, e.department, e.location,
           p.employment_type,
           COALESCE(sft.shift_start, '09:00:00') AS shift_start, sft.shift_end, COALESCE(sft.grace_minutes, 15) AS grace_minutes
    FROM employees e
    LEFT JOIN erp_employee_profile p ON p.employee_id = e.id
    LEFT JOIN erp_employee_shifts sft ON sft.employee_id = e.id
    WHERE 1=1`;
  const empParams = [];
  if (filter.q) {
    empSql += ' AND (e.employee_id LIKE ? OR e.full_name LIKE ?)';
    const like = `%${filter.q}%`;
    empParams.push(like, like);
  }
  if (filter.employeeIds && filter.employeeIds.length) {
    empSql += ` AND e.id IN (${filter.employeeIds.map(() => '?').join(',')})`;
    empParams.push(...filter.employeeIds);
  }
  const [employees] = await pool.query(empSql, empParams);

  const [punchRows] = await pool.query(
    `SELECT DATE_FORMAT(punch_time, '%Y-%m-%d') AS day, employee_id, punch_time, in_out_mode, source, device_location
     FROM erp_attendance_logs WHERE employee_id IS NOT NULL AND DATE(punch_time) BETWEEN ? AND ?${filter.employeeIds && filter.employeeIds.length ? ` AND employee_id IN (${filter.employeeIds.map(() => '?').join(',')})` : ''}`,
    [from, to, ...(filter.employeeIds && filter.employeeIds.length ? filter.employeeIds : [])]
  );
  const punchesByEmpDay = new Map(); // "empId|day" -> [{time, mode, source, location}]
  for (const r of punchRows) {
    const key = r.employee_id + '|' + r.day;
    if (!punchesByEmpDay.has(key)) punchesByEmpDay.set(key, []);
    punchesByEmpDay.get(key).push({ time: r.punch_time, mode: r.in_out_mode, source: r.source, location: r.device_location });
  }
  // Real device punches still win over any older manual/imported rows for
  // the same day (manual entry/bulk import are retired going forward, but
  // historical rows tagged that way may still exist).
  for (const [key, list] of punchesByEmpDay) {
    const real = list.filter((p) => p.source !== 'import' && p.source !== 'manual');
    if (real.length) punchesByEmpDay.set(key, real);
  }

  const [holidayRows] = await pool.query(
    'SELECT holiday_date, type, name FROM erp_holidays WHERE holiday_date BETWEEN ? AND ?',
    [from, to]
  );
  const holidayByDate = new Map(); // 'YYYY-MM-DD' -> {type, name}
  for (const h of holidayRows) holidayByDate.set(ymd(parseYMD(h.holiday_date)), { type: h.type, name: h.name });

  // Leave overlay (Approved + Leave Without Pay) — fetched for every whole
  // calendar month the range touches, not just [from,to], because the
  // Saturday quota below needs full-month leave data to know which
  // Saturdays are already excused before it hands out the free ones.
  const monthStart = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), 1);
  const monthEnd = new Date(rangeTo.getFullYear(), rangeTo.getMonth() + 1, 0);
  const [leaveRows] = await pool.query(
    `SELECT employee_id, from_date, to_date, leave_type, leave_request_type, doc_no, status FROM erp_leave_requests
     WHERE status IN ('Approved','Leave Without Pay') AND from_date <= ? AND to_date >= ?`,
    [ymd(monthEnd), ymd(monthStart)]
  );
  const leaveByEmpDate = new Map(); // "empId|YYYY-MM-DD" -> {leaveType, leaveRequestType, docNo, status}
  for (const lr of leaveRows) {
    const leaveFrom = parseYMD(lr.from_date), leaveTo = parseYMD(lr.to_date);
    const start = leaveFrom > monthStart ? leaveFrom : monthStart;
    const end = leaveTo < monthEnd ? leaveTo : monthEnd;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      leaveByEmpDate.set(lr.employee_id + '|' + ymd(d), { leaveType: lr.leave_type, leaveRequestType: lr.leave_request_type, leaveDocNo: lr.doc_no, status: lr.status });
    }
  }

  // Field jobs — who was out on a JLR job on which day (start..end, open-ended
  // jobs through today, Add / Replace / Remove changes applied). All the
  // rules live in ../fieldJobs.js. Names are matched against the FULL employee
  // roster (not just this call's filtered list) so a name shared by two
  // employees is recognised as ambiguous even when only one of them is asked for.
  const [allEmployeeNames] = await pool.query('SELECT id, full_name FROM employees');
  const { byEmpDate: fieldJobByEmpDate } = await loadFieldPresence(pool, { from, to, employees: allEmployeeNames });

  // Saturday weekly-off quota, per employee per month: a Saturday the
  // employee actually attended, that a leave already covers, or that a
  // field job already covers, is settled on its own and never consumes/needs
  // the quota. Of the remaining "bare" Saturdays, up to the free count
  // become WeeklyOff; any beyond it are Absent.
  const satOffByEmpDate = new Set(); // "empId|YYYY-MM-DD"
  const monthSaturdays = saturdaysInMonth(monthStart.getFullYear(), monthStart.getMonth() + 1);
  for (const emp of employees) {
    const freeCount = emp.employment_type === 'Permanent' ? Math.max(monthSaturdays.length - 2, 0) : 0;
    if (!freeCount) continue;
    const bare = monthSaturdays.filter((sat) => {
      const key = emp.id + '|' + sat;
      return !punchesByEmpDay.has(key) && !leaveByEmpDate.has(key) && !fieldJobByEmpDate.has(key);
    });
    bare.slice(0, freeCount).forEach((sat) => satOffByEmpDate.add(emp.id + '|' + sat));
  }

  const out = [];
  for (const emp of employees) {
    const shiftStart = String(emp.shift_start).slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
    for (let d = new Date(rangeFrom); d <= rangeTo; d.setDate(d.getDate() + 1)) {
      const day = ymd(d);
      const dow = d.getDay();
      const key = emp.id + '|' + day;
      const punches = punchesByEmpDay.get(key) || [];
      const holiday = holidayByDate.get(day);
      const leave = leaveByEmpDate.get(key);

      let checkIn = null, checkOut = null, late = false, lateMinutes = 0, overtimeMinutes = 0;
      if (punches.length) {
        const hasKnownStatus = punches.some((p) => p.mode !== null && p.mode !== undefined);
        if (hasKnownStatus) {
          const ins = punches.filter((p) => p.mode === 0);
          const outs = punches.filter((p) => p.mode === 1);
          checkIn = ins.length ? ins[0].time : null;
          checkOut = outs.length ? outs[outs.length - 1].time : null;
        } else {
          checkIn = punches[0].time;
          checkOut = punches.length > 1 ? punches[punches.length - 1].time : null;
        }
        if (checkIn) {
          const [sh, sm] = shiftStart.split(':').map(Number);
          const cutoff = new Date(checkIn);
          cutoff.setHours(sh, sm + emp.grace_minutes, 0, 0);
          late = checkIn > cutoff;
          if (late) lateMinutes = Math.round((checkIn - cutoff) / 60000);
        } else if (checkOut) {
          // Check-out recorded but no check-in at all that day — arrival
          // time can't be verified, so it always counts as late (payroll's
          // "3 lates = 1 absent" rule), with no overtime offset possible
          // (there's nothing to compare the missing check-in against).
          late = true;
        }
        // Overtime: minutes checked out AFTER shift_end (only computable when
        // a shift_end is actually configured — see PUT /shift/:employeeId).
        // Payroll uses this to offset the same day's lateMinutes (an
        // employee who leaves late having also arrived late isn't
        // double-penalized if their overtime covers the lateness).
        if (checkOut && emp.shift_end) {
          const [eh, em2] = String(emp.shift_end).slice(0, 5).split(':').map(Number);
          const shiftEndAt = new Date(checkOut);
          shiftEndAt.setHours(eh, em2, 0, 0);
          if (checkOut > shiftEndAt) overtimeMinutes = Math.round((checkOut - shiftEndAt) / 60000);
        }
      }

      const fieldJob = fieldJobByEmpDate.get(key);
      // On a field job that day and no approved leave / leave-without-pay
      // covering it -> it counts as attendance. That includes a Sunday,
      // Saturday or holiday in the middle of the job (those are worked days
      // out in the field, not days off); a real machine punch on an ordinary
      // weekday still shows as Present as before. A leave on the day wins
      // over the field job, and a Sunday/holiday with a leave keeps its usual
      // day-off treatment so the leave isn't consumed by it.
      const fieldWins = !!fieldJob && !leave;
      let dayType;
      if (fieldWins && (!punches.length || holiday || dow === 0)) dayType = 'Field';
      else if (holiday) dayType = holiday.type === 'CompanyOff' ? 'CompanyOff' : 'Holiday';
      else if (dow === 0) dayType = 'WeeklyOff';
      else if (leave && leave.status === 'Approved') dayType = 'Leave';
      else if (leave && leave.status === 'Leave Without Pay') dayType = 'LeaveWithoutPay';
      else if (punches.length) dayType = 'Present';
      else if (dow === 6 && satOffByEmpDate.has(key)) dayType = 'WeeklyOff';
      else dayType = 'Absent';

      // Location is detected from the machine the day's punches actually came
      // from (agent.js's DEVICE_NAME) — falls back to the employee's own HR
      // record only on days with no punch at all (e.g. absent/leave), so
      // those days still land under the employee's usual office.
      const punchLoc = (punches.find((p) => p.location) || {}).location;

      out.push({
        date: day, employeeId: emp.id, employeeCode: emp.emp_code, name: emp.full_name,
        fieldJobRef: dayType === 'Field' ? [fieldJob.client, fieldJob.workOrder ? ('WO ' + fieldJob.workOrder) : ''].filter(Boolean).join(' — ') : null,
        fieldJobId: dayType === 'Field' ? fieldJob.jobId : null,
        fieldJobOpen: dayType === 'Field' ? fieldJob.open : false,
        // A day worked in the field that would otherwise have been a day off
        // (a Sunday, or any holiday) earns one Field Break — see computeFieldBreaks.
        fieldBreakEarned: dayType === 'Field' && (dow === 0 || !!holiday),
        unmapped: false, department: emp.department, location: punchLoc || emp.location,
        checkIn, checkOut, punches: punches.length,
        shiftStart, graceMinutes: emp.grace_minutes, late, lateMinutes, overtimeMinutes,
        dayType, holidayName: holiday ? holiday.name : null,
        onLeave: dayType === 'Leave' || dayType === 'LeaveWithoutPay',
        // dayOfWeek (0=Sunday..6=Saturday) so a WeeklyOff day can be shown/
        // counted as "Gazetted Holiday (Sunday)" vs a rotational Saturday
        // off — both are the same dayType internally (paid, no deduction),
        // this is only about which label/column a Sunday gets.
        dayOfWeek: dow,
        leaveType: leave ? leave.leaveType : null, leaveRequestType: leave ? leave.leaveRequestType : null, leaveDocNo: leave ? leave.leaveDocNo : null,
      });
    }
  }

  // Unmapped device punches (no matching employee account) still surface as
  // their own rows, same as before — a device ID nobody's linked to yet
  // must never just silently vanish from the report. Skipped when payroll
  // is asking for a specific employee list — an unmapped punch belongs to
  // no employee, so it's just noise for a payroll run.
  const unmappedRows = filter.employeeIds ? [] : (await pool.query(
    `SELECT DATE_FORMAT(punch_time, '%Y-%m-%d') AS day, device_user_id, device_user_name, punch_time, in_out_mode, device_location
     FROM erp_attendance_logs WHERE employee_id IS NULL AND DATE(punch_time) BETWEEN ? AND ?
     ORDER BY device_user_id ASC, punch_time ASC`,
    [from, to]
  ))[0];
  const unmappedGroups = new Map();
  for (const r of unmappedRows) {
    const key = r.day + '|' + r.device_user_id;
    if (!unmappedGroups.has(key)) unmappedGroups.set(key, { meta: r, punches: [] });
    unmappedGroups.get(key).punches.push({ time: r.punch_time, mode: r.in_out_mode, location: r.device_location });
  }
  for (const { meta: r, punches } of unmappedGroups.values()) {
    const hasKnownStatus = punches.some((p) => p.mode !== null && p.mode !== undefined);
    let checkIn, checkOut;
    if (hasKnownStatus) {
      const ins = punches.filter((p) => p.mode === 0), outs = punches.filter((p) => p.mode === 1);
      checkIn = ins.length ? ins[0].time : null; checkOut = outs.length ? outs[outs.length - 1].time : null;
    } else {
      checkIn = punches[0].time; checkOut = punches.length > 1 ? punches[punches.length - 1].time : null;
    }
    out.push({
      date: r.day, employeeId: null, employeeCode: r.device_user_id, name: r.device_user_name || null,
      unmapped: true, department: null, location: (punches.find((p) => p.location) || {}).location || null,
      checkIn, checkOut, punches: punches.length,
      shiftStart: null, graceMinutes: null, late: false, lateMinutes: 0, overtimeMinutes: 0,
      dayType: 'Present', holidayName: null, onLeave: false, dayOfWeek: parseYMD(r.day).getDay(), leaveType: null, leaveRequestType: null, leaveDocNo: null,
    });
  }

  out.sort((a, b) => (b.date + (b.checkIn || '')).localeCompare(a.date + (a.checkIn || '')));
  return out;
}

// GET /api/attendance/summary?from=&to=&q= — thin wrapper around
// computeAttendanceRows() above; see it for the full day-by-day logic.
router.get('/summary', requireHr, async (req, res) => {
  const { from, to } = rangeParams(req);
  res.json(await computeAttendanceRows(from, to, { q: req.query.q }));
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

// Manual single-entry attendance and bulk sheet import have been retired —
// they were papering over gaps (Sundays, holidays, machine mismatches) that
// the erp_holidays calendar + Saturday-quota logic in GET /summary above now
// handles automatically and consistently. Attendance now comes ONLY from the
// real device (POST /ingest). See routes/holidays.js for the replacement.

/* ---------------- Field Breaks ----------------
   A day worked on a field job that would otherwise have been a day off — a
   Sunday, or any holiday (Gazetted / Islamic / Company Off) — earns 1 Field
   Break. Breaks are counted per July–June financial year and start again
   from zero every July 1; a Field Break leave (an approved leave request of
   that type) uses one up. "Earned" is taken straight from
   computeAttendanceRows' own day classification (fieldBreakEarned), so the
   Leave page can never disagree with the Attendance Report about which days
   were field days. */
async function computeFieldBreaks(employeeId, anchorYmd) {
  const today = localYmd(new Date());
  const fy = financialYearRange(anchorYmd || today);
  const accrueTo = fy.end < today ? fy.end : today; // nothing is earned for days that haven't happened yet
  const rows = accrueTo >= fy.start
    ? await computeAttendanceRows(fy.start, accrueTo, { employeeIds: [employeeId] })
    : [];
  const earnedDays = rows
    .filter((r) => r.employeeId === employeeId && r.fieldBreakEarned)
    .map((r) => ({ date: r.date, reason: r.holidayName ? 'Holiday — ' + r.holidayName : 'Sunday', job: r.fieldJobRef || null }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const [leaves] = await pool.query(
    `SELECT from_date, to_date, leave_request_type FROM erp_leave_requests
     WHERE employee_id = ? AND leave_type = 'Field Break' AND status = 'Approved' AND from_date <= ? AND to_date >= ?`,
    [employeeId, fy.end, fy.start]
  );
  let availed = 0;
  for (const l of leaves) {
    const a = toYmd(l.from_date) > fy.start ? toYmd(l.from_date) : fy.start;
    const b = toYmd(l.to_date) < fy.end ? toYmd(l.to_date) : fy.end;
    if (b < a) continue;
    availed += (daysBetween(a, b) + 1) * (l.leave_request_type === 'Half Day' ? 0.5 : 1);
  }
  const earned = earnedDays.length;
  return {
    employeeId, fy: fy.label, from: fy.start, to: fy.end, accruedTo: accrueTo < fy.start ? null : accrueTo,
    earned, availed, remaining: Math.max(0, earned - availed),
    overdrawn: Math.max(0, availed - earned), // only if field days were later removed/corrected in the JLR after a break was already approved
    earnedDays,
  };
}

// GET /api/attendance/field-breaks/:employeeId[?date=YYYY-MM-DD] — the
// employee's Field Break balance for the July–June year containing `date`
// (default: today). Themselves, or HR.
router.get('/field-breaks/:employeeId', async (req, res) => {
  const employeeId = +req.params.employeeId;
  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Invalid employee id.' });
  if (employeeId !== req.erpUser.id && !canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: 'You cannot view this.' });
  const date = req.query.date ? toYmd(req.query.date) : null;
  if (req.query.date && !date) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
  res.json(await computeFieldBreaks(employeeId, date));
});

module.exports = router;
module.exports.computeAttendanceRows = computeAttendanceRows;
module.exports.computeFieldBreaks = computeFieldBreaks;
