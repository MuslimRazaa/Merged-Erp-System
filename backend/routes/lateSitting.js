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

function shapeMine(r) {
  return { id: r.id, workDate: ymdLocal(new Date(r.work_date)), outTime: r.out_time, hasAttachment: !!r.attachment_name, submittedAt: r.created_at };
}

// GET /api/late-sittings/mine — the signed-in employee's own submissions,
// most recent first.
router.get('/mine', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, work_date, out_time, attachment_name, created_at FROM erp_late_sittings WHERE employee_id = ? ORDER BY work_date DESC, out_time DESC',
    [req.erpUser.id]
  );
  res.json(rows.map(shapeMine));
});

// GET /api/late-sittings — EVERY employee's submissions. HR/Admin only —
// this is the audit list: who logged a manual late sitting, which day, what
// time, and whether they attached proof.
router.get('/', requireHr, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ls.id, ls.employee_id, ls.work_date, ls.out_time, ls.attachment_name, ls.created_at,
            e.employee_id AS emp_code, e.full_name AS emp_name, e.department
     FROM erp_late_sittings ls JOIN employees e ON e.id = ls.employee_id
     ORDER BY ls.work_date DESC, ls.out_time DESC`
  );
  res.json(rows.map((r) => ({
    id: r.id, employeeId: r.employee_id, employeeCode: r.emp_code, employeeName: r.emp_name, department: r.department,
    workDate: ymdLocal(new Date(r.work_date)), outTime: r.out_time, hasAttachment: !!r.attachment_name, submittedAt: r.created_at,
  })));
});

// POST /api/late-sittings  multipart/form-data: workDate ('YYYY-MM-DD'),
// outTime ('YYYY-MM-DDTHH:MM:SS', the employee's own device clock at submit
// time), file (optional, the proof screenshot).
router.post('/', upload.single('file'), handleUploadErrors, async (req, res) => {
  const workDate = String(req.body.workDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return res.status(400).json({ error: 'workDate must be YYYY-MM-DD.' });

  const now = new Date();
  const today = ymdLocal(now);
  const yesterday = ymdLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (workDate !== today && workDate !== yesterday) {
    return res.status(400).json({ error: 'A late sitting can only be logged for today or yesterday.' });
  }

  const outTime = new Date(String(req.body.outTime || ''));
  if (isNaN(outTime.getTime())) return res.status(400).json({ error: 'outTime is not a valid date/time.' });
  if (outTime.getTime() - now.getTime() > 10 * 60 * 1000) {
    return res.status(400).json({ error: 'That time is in the future — check your device clock and try again.' });
  }
  if (ymdLocal(outTime) !== workDate) {
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
      `INSERT INTO erp_late_sittings (employee_id, work_date, out_time, attendance_log_id, attachment_name, attachment_mime, attachment_data)
       VALUES (?,?,?,?,?,?,?)`,
      [emp.id, workDate, outTime, logId, fileName, file ? file.mimetype : null, file ? file.buffer : null]
    );
    await conn.commit();
    await audit(emp.employeeId, 'late-sitting-logged', `${workDate} ${outTime.toTimeString().slice(0, 5)}${file ? ' (with attachment)' : ''}`);
    res.status(201).json({ id: result.insertId, workDate, outTime, hasAttachment: !!file, submittedAt: new Date() });
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

module.exports = router;
