/* ============================================================
   Overtime / Manual Late Sitting — Home -> Overtime.

   An employee logs their own late-sitting time themselves (nobody logs it
   for them): pick today or yesterday, the OUT TIME shown is read live off
   their own device's clock at the moment they submit, with an optional
   screenshot as proof (an email, a message — whatever backs up the claim).

   Every submission writes TWO things:
   1. A row here (erp_late_sittings) — this feature's own record: who, which
      day, what time, the proof file if any, when it was actually submitted.
      This is the audit trail HR/Admin read via GET / below.
   2. A REAL row straight into erp_attendance_logs (in_out_mode=5, OT-out,
      source='late-sitting') — this is what actually makes it count. Once
      it's in there, routes/attendance.js's computeAttendanceRows treats it
      exactly like a device OT-out punch: it can become the day's checkout
      time (picking whichever of Check-out/OT-out is latest — see
      computeAttendanceRows), which is what then drives Attendance Report
      and Payroll's late-sitting math. No changes needed there at all.

   Trust model, as specified: self-reported, no approval step — it counts
   the moment it's submitted. The two guards below (date restricted to
   today/yesterday, server-side; time can't be minutes into the future) stop
   the most obvious misuse, but this ultimately relies on an employee's own
   device clock being honest, same as the feature was asked for. HR/Admin's
   audit list (GET /) is the check on that: who logged what, when, with what
   proof, all visible after the fact.
   ============================================================ */
'use strict';
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
function handleUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `The attachment is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` : err.message,
    });
  }
  next(err);
}
function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}
// Local-calendar-day arithmetic — see attendance.js's identical note: NOT
// toISOString(), which is UTC-based and shifts a date back a day in
// timezones ahead of UTC (Pakistan Standard Time).
const ymdLocal = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// The two ways a logged late sitting was actually worked — shown as a
// required pick on the Overtime form before it can be submitted (see
// otOpenConfirm() on the front end), stored so HR's audit list shows which
// one it was, not just that a late sitting happened.
const WORK_MODES = ['Offsite working', 'Work From Home'];

function shapeMine(r) {
  return { id: r.id, workDate: ymdLocal(new Date(r.work_date)), outTime: r.out_time, workMode: r.work_mode, hasAttachment: !!r.attachment_name, submittedAt: r.created_at };
}

// GET /api/late-sittings/mine — the signed-in employee's own submissions,
// most recent first.
router.get('/mine', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, work_date, out_time, work_mode, attachment_name, created_at FROM erp_late_sittings WHERE employee_id = ? ORDER BY work_date DESC, out_time DESC',
    [req.erpUser.id]
  );
  res.json(rows.map(shapeMine));
});

// GET /api/late-sittings — EVERY employee's submissions. HR/Admin only —
// this is the audit list: who logged a manual late sitting, which day, what
// time, which work mode, and whether they attached proof.
router.get('/', requireHr, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ls.id, ls.employee_id, ls.work_date, ls.out_time, ls.work_mode, ls.attachment_name, ls.created_at,
            e.employee_id AS emp_code, e.full_name AS emp_name, e.department
     FROM erp_late_sittings ls JOIN employees e ON e.id = ls.employee_id
     ORDER BY ls.work_date DESC, ls.out_time DESC`
  );
  res.json(rows.map((r) => ({
    id: r.id, employeeId: r.employee_id, employeeCode: r.emp_code, employeeName: r.emp_name, department: r.department,
    workDate: ymdLocal(new Date(r.work_date)), outTime: r.out_time, workMode: r.work_mode, hasAttachment: !!r.attachment_name, submittedAt: r.created_at,
  })));
});

// POST /api/late-sittings  multipart/form-data: workDate ('YYYY-MM-DD'),
// outTime ('YYYY-MM-DDTHH:MM:SS', the employee's own device clock at submit
// time), file (optional, the proof screenshot).
// "Yesterday" only makes sense for a late sitting that ran PAST MIDNIGHT —
// the live clock at submit time is then still correct (e.g. 1:15 AM), it
// just belongs to the PREVIOUS calendar day's shift. Outside this early
// window the live clock can only ever describe TODAY, so "Yesterday" isn't
// offered at all — there's no honest way to read "yesterday's" time off a
// clock that only ever shows now. Mirrors the frontend's otDateOptions().
const YESTERDAY_CUTOFF_HOUR = 6;

router.post('/', upload.single('file'), handleUploadErrors, async (req, res) => {
  const workDate = String(req.body.workDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return res.status(400).json({ error: 'workDate must be YYYY-MM-DD.' });

  const workMode = String(req.body.workMode || '');
  if (!WORK_MODES.includes(workMode)) return res.status(400).json({ error: 'Pick whether you were working offsite or from home.' });

  const now = new Date();
  const today = ymdLocal(now);
  const pastMidnight = now.getHours() < YESTERDAY_CUTOFF_HOUR;
  const yesterday = ymdLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const allowed = pastMidnight ? [today, yesterday] : [today];
  if (!allowed.includes(workDate)) {
    return res.status(400).json({
      error: pastMidnight
        ? 'A late sitting can only be logged for today or yesterday.'
        : 'A late sitting can only be logged for today — yesterday is only available in the first few hours after midnight.',
    });
  }

  const outTime = new Date(String(req.body.outTime || ''));
  if (isNaN(outTime.getTime())) return res.status(400).json({ error: 'outTime is not a valid date/time.' });
  if (outTime.getTime() - now.getTime() > 10 * 60 * 1000) {
    return res.status(400).json({ error: 'That time is in the future — check your device clock and try again.' });
  }
  // The clock's own calendar date must match workDate UNLESS this is
  // exactly the past-midnight "logging yesterday's shift" case — there the
  // clock legitimately reads today's early hours while workDate is
  // yesterday on purpose.
  if (ymdLocal(outTime) !== workDate && !(pastMidnight && workDate === yesterday && ymdLocal(outTime) === today)) {
    return res.status(400).json({ error: 'The time shown does not fall on the selected date — reopen this page and try again.' });
  }

  const emp = req.erpUser;
  const file = req.file;
  const fileName = file ? Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let logId;
    try {
      const [logResult] = await conn.query(
        `INSERT INTO erp_attendance_logs (device_user_id, device_user_name, employee_id, punch_time, verify_mode, in_out_mode, source)
         VALUES (?,?,?,?,?,?,?)`,
        [emp.employeeId, emp.name, emp.id, outTime, null, 5, 'late-sitting']
      );
      logId = logResult.insertId;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return res.status(409).json({ error: 'You already logged a late sitting at this exact time.' }); }
      throw e;
    }
    const [result] = await conn.query(
      `INSERT INTO erp_late_sittings (employee_id, work_date, out_time, work_mode, attendance_log_id, attachment_name, attachment_mime, attachment_data)
       VALUES (?,?,?,?,?,?,?,?)`,
      [emp.id, workDate, outTime, workMode, logId, fileName, file ? file.mimetype : null, file ? file.buffer : null]
    );
    await conn.commit();
    await audit(emp.employeeId, 'late-sitting-logged', `${workDate} ${outTime.toTimeString().slice(0, 5)} (${workMode})${file ? ' (with attachment)' : ''}`);
    res.status(201).json({ id: result.insertId, workDate, outTime, workMode, hasAttachment: !!file, submittedAt: new Date() });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// POST /api/late-sittings/backdated — HR/Admin only. Lets HR log a Work
// From Home entry on an EMPLOYEE'S BEHALF for a date that's already in the
// past (the self-service route above only ever allows today/yesterday, read
// live off the submitter's own clock — this is for catching up entries that
// were missed at the time, e.g. filed through Leave Request by mistake).
// Written into the exact same two tables, under the chosen employee's own
// id, with the exact same audit action — so it shows up identically in
// Overtime's "My Late Sittings" / the HR audit list, with nothing marking
// it as HR-entered rather than self-logged.
router.post('/backdated', requireHr, async (req, res) => {
  const employeeId = +req.body.employeeId;
  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Pick an employee.' });
  const [empRows] = await pool.query('SELECT id, employee_id, full_name FROM employees WHERE id = ?', [employeeId]);
  if (!empRows.length) return res.status(404).json({ error: 'Employee not found.' });
  const emp = empRows[0];

  const workDate = String(req.body.workDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return res.status(400).json({ error: 'workDate must be YYYY-MM-DD.' });

  const outTime = new Date(String(req.body.outTime || ''));
  if (isNaN(outTime.getTime())) return res.status(400).json({ error: 'outTime is not a valid date/time.' });
  const now = new Date();
  if (outTime.getTime() - now.getTime() > 10 * 60 * 1000) {
    return res.status(400).json({ error: 'That time is in the future — check it and try again.' });
  }
  if (ymdLocal(outTime) !== workDate) {
    return res.status(400).json({ error: 'The checkout time must fall on the selected date.' });
  }

  const workMode = 'Work From Home';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let logId;
    try {
      const [logResult] = await conn.query(
        `INSERT INTO erp_attendance_logs (device_user_id, device_user_name, employee_id, punch_time, verify_mode, in_out_mode, source)
         VALUES (?,?,?,?,?,?,?)`,
        [emp.employee_id, emp.full_name, emp.id, outTime, null, 5, 'late-sitting']
      );
      logId = logResult.insertId;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return res.status(409).json({ error: 'This employee already has a late sitting logged at this exact time.' }); }
      throw e;
    }
    const [result] = await conn.query(
      `INSERT INTO erp_late_sittings (employee_id, work_date, out_time, work_mode, attendance_log_id)
       VALUES (?,?,?,?,?)`,
      [emp.id, workDate, outTime, workMode, logId]
    );
    await conn.commit();
    await audit(emp.employee_id, 'late-sitting-logged', `${workDate} ${outTime.toTimeString().slice(0, 5)} (${workMode})`);
    res.status(201).json({ id: result.insertId, workDate, outTime, workMode, hasAttachment: false, submittedAt: new Date() });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// GET /api/late-sittings/:id/attachment — the proof screenshot, if one was
// attached. The employee who logged it, or HR/Admin, only.
router.get('/:id/attachment', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT employee_id, attachment_name, attachment_mime, attachment_data FROM erp_late_sittings WHERE id = ?',
    [req.params.id]
  );
  if (!rows.length || !rows[0].attachment_data) return res.status(404).json({ error: 'No attachment on this entry.' });
  const row = rows[0];
  if (row.employee_id !== req.erpUser.id && !canAccess(req.erpUser.role, 'Human Resources')) {
    return res.status(403).json({ error: 'You cannot view this.' });
  }
  res.setHeader('Content-Type', row.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(row.attachment_name || 'attachment') + '"');
  res.send(row.attachment_data);
});

// DELETE /api/late-sittings/:id — HR/Admin only. Removes this entry AND the
// erp_attendance_logs row it wrote (if any), so a mistaken/test entry's
// effect on Attendance Report/Payroll is fully undone too, not just hidden
// from this feature's own list.
router.delete('/:id', requireHr, async (req, res) => {
  const [rows] = await pool.query('SELECT attendance_log_id FROM erp_late_sittings WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Entry not found.' });
  if (rows[0].attendance_log_id) {
    await pool.query("DELETE FROM erp_attendance_logs WHERE id = ? AND source = 'late-sitting'", [rows[0].attendance_log_id]);
  }
  await pool.query('DELETE FROM erp_late_sittings WHERE id = ?', [req.params.id]);
  await audit(req.erpUser.employeeId, 'late-sitting-deleted', String(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
