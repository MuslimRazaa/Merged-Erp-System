/* ============================================================
   Bridges to data that ERP and ISO both need to see the same way:
   employees, departments, locations. All three already live in ISO's
   MySQL tables (`employees`, `departments`, `locations`) — this file
   reads/writes those same rows using the exact columns ISO's own models
   (models/Employee.js, models/Department.js, models/Location.js) use, so
   nothing here needs a schema change and edits made from either app show
   up in both.
   ============================================================ */
'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

function requireGroup(group) {
  return (req, res, next) => {
    if (!canAccess(req.erpUser.role, group)) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to ${group}.` });
    next();
  };
}

// ISO's own module-access flags on `employees` — same columns
// iso-server-backend-PTIS's models/Employee.js already reads/writes.
// Listed here once so both the read (GET /employees) and write
// (PUT /employees/:id/iso-access) sides agree on exactly which columns
// this is allowed to touch.
const ISO_ACCESS_COLUMNS = [
  'lms_access', 'portal_access', 'cvs_access', 'reports_access', 'testing_access', 'testing_admin_access',
  'jlr_operations_access', 'jlr_qhse_access', 'jlr_inventory_access', 'jlr_accounts_access', 'jlr_it_access', 'jlr_full_access',
  'iso_forms_access', 'iso_forms_admin_access',
];
// Columns on ERP's own erp_employee_profile table (see migrate.js) — the
// HR form's Personal/Bank/Reference/Kin/Salary sections.
const PROFILE_COLUMNS = [
  'first_name', 'last_name', 'designation', 'employment_type', 'reports_to', 'gender',
  'phone_country', 'phone_code', 'phone_number', 'nic_number',
  'father_husband_name', 'spouse_name', 'spouse_na', 'mother_name', 'mother_na', 'date_of_birth',
  'emergency_country', 'emergency_code', 'emergency_number',
  'marital_status', 'cost_center', 'join_date', 'job_end_date',
  'nationality', 'visa_number', 'visa_expiry', 'home_address', 'mailing_address',
  'bank_name', 'iban', 'account_no', 'account_title', 'blood_group',
  'appraisal_date', 'confirmation_date', 'rejoin_date', 'rejoin_reason',
  'ref_name', 'ref_contact', 'ref_email', 'ref_office',
  'kin_name', 'kin_relation', 'kin_contact', 'kin_nic', 'kin_email',
  'salary', 'gross_salary', 'utility_allowance', 'hra', 'field_allowance', 'currency',
];
// request-body camelCase -> DB snake_case, for the profile columns above.
const PROFILE_FIELD_MAP = Object.fromEntries(PROFILE_COLUMNS.map((c) => [c.replace(/_([a-z])/g, (m, l) => l.toUpperCase()), c]));

/* ---------------- employees (Human Resources) ---------------- */
router.get('/employees', requireGroup('Human Resources'), async (req, res) => {
  // LEFT JOINed so the HR form can show/edit each employee's ERP role,
  // attendance shift, ISO module access and full HR profile all from one
  // screen, instead of scattered across separate pages.
  // NOTE: selects p.<col> individually (not p.*) — erp_employee_profile
  // has its own employee_id/updated_at columns which would otherwise
  // silently clobber employees.employee_id (the human-readable ID string)
  // and employees.updated_at in the merged row object.
  const [rows] = await pool.query(
    `SELECT e.*, r.role AS erp_role, r.desig AS erp_desig, r.active AS erp_active,
            sft.shift_start, sft.shift_end, sft.grace_minutes,
            ${PROFILE_COLUMNS.map((c) => `p.${c}`).join(', ')}
     FROM employees e
     LEFT JOIN erp_employee_roles r ON r.employee_id = e.id
     LEFT JOIN erp_employee_shifts sft ON sft.employee_id = e.id
     LEFT JOIN erp_employee_profile p ON p.employee_id = e.id
     ORDER BY e.full_name ASC`
  );
  res.json(rows.map((r) => {
    const profile = {};
    for (const col of PROFILE_COLUMNS) {
      const key = col.replace(/_([a-z])/g, (m, l) => l.toUpperCase());
      profile[key] = r[col] ?? null;
    }
    profile.spouseNa = r.spouse_na === 1;
    profile.motherNa = r.mother_na === 1;
    const isoAccess = {};
    for (const col of ISO_ACCESS_COLUMNS) isoAccess[col.replace(/_([a-z])/g, (m, l) => l.toUpperCase())] = r[col] === 1;
    return {
      id: r.id, employeeId: r.employee_id, name: r.full_name, email: r.email,
      department: r.department, location: r.location, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
      erpRole: (r.erp_role && r.erp_active !== 0) ? r.erp_role : '', erpDesig: r.erp_desig || '',
      shiftStart: r.shift_start ? String(r.shift_start).slice(0, 5) : '09:00',
      shiftEnd: r.shift_end ? String(r.shift_end).slice(0, 5) : '',
      graceMinutes: r.grace_minutes ?? 15,
      profile, isoAccess,
    };
  }));
});

// Upsert the HR profile sections (Personal/Salary/Address/Bank/Reference/Kin).
router.put('/employees/:id/profile', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const id = +req.params.id;
  const cols = []; const placeholders = []; const values = [id];
  for (const [bodyKey, col] of Object.entries(PROFILE_FIELD_MAP)) {
    if (req.body[bodyKey] === undefined) continue;
    cols.push(col); placeholders.push('?');
    values.push(req.body[bodyKey] === '' ? null : req.body[bodyKey]);
  }
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update.' });
  const updateClause = cols.map((c) => `${c} = VALUES(${c})`).join(', ');
  await pool.query(
    `INSERT INTO erp_employee_profile (employee_id, ${cols.join(', ')}) VALUES (?, ${placeholders.join(', ')})
     ON DUPLICATE KEY UPDATE ${updateClause}`,
    values
  );
  await audit(req.erpUser.employeeId, 'employee-profile-updated', String(id));
  res.json({ ok: true });
});

// Reset an employee's shared login password from the HR form (edit mode —
// creation already sets the initial password via POST /employees).
router.put('/employees/:id/password', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const hashed = await bcrypt.hash(password, 10);
  const [result] = await pool.query('UPDATE employees SET password = ? WHERE id = ?', [hashed, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found.' });
  await audit(req.erpUser.employeeId, 'employee-password-reset', String(req.params.id));
  res.json({ ok: true });
});

// Sets ISO's own module-access flags directly (lms_access, iso_forms_access,
// jlr_*, ...) — the same columns iso-server-backend-PTIS's Employees screen
// writes. Deliberately a real write to ISO's table (not a new ERP table)
// since these ARE ISO's access flags; this exists because the HR form is
// meant to manage them from one place, per the ERP-is-primary direction.
router.put('/employees/:id/iso-access', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const id = +req.params.id;
  const sets = []; const values = [];
  for (const col of ISO_ACCESS_COLUMNS) {
    const key = col.replace(/_([a-z])/g, (m, l) => l.toUpperCase());
    if (req.body[key] === undefined) continue;
    sets.push(`${col} = ?`); values.push(req.body[key] ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(id);
  const [result] = await pool.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, values);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found.' });
  await audit(req.erpUser.employeeId, 'employee-iso-access-updated', String(id));
  res.json({ ok: true });
});

// Create a brand-new employee — same row ISO's own "Add employee" writes.
router.post('/employees', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const { employeeId, name, email, password, department, location, status } = req.body;
  if (!employeeId || !name || !password || !department || !location) {
    return res.status(400).json({ error: 'employeeId, name, password, department and location are required.' });
  }
  const [dupe] = await pool.query('SELECT id FROM employees WHERE employee_id = ?', [employeeId]);
  if (dupe.length) return res.status(409).json({ error: 'Employee ID already exists.' });
  const hashed = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO employees (employee_id, full_name, email, password, department, location, status) VALUES (?,?,?,?,?,?,?)',
    [employeeId, name, email || null, hashed, department, location, status || 'Active']
  );
  await audit(req.erpUser.employeeId, 'employee-created', employeeId);
  res.status(201).json({ id: result.insertId, employeeId, name, email, department, location, status: status || 'Active' });
});

// Update name / department / location / status only — permission flags
// (lms_access, iso_forms_access, ...) stay ISO-managed to avoid the two
// apps fighting over access control.
router.put('/employees/:id', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  if (req.body.employeeId !== undefined) {
    const newEmpId = String(req.body.employeeId).trim();
    if (!newEmpId) return res.status(400).json({ error: 'Employee ID cannot be blank.' });
    const [dupe] = await pool.query('SELECT id FROM employees WHERE employee_id = ? AND id <> ?', [newEmpId, req.params.id]);
    if (dupe.length) return res.status(409).json({ error: `Employee ID "${newEmpId}" is already used by another employee.` });
    fields.push('employee_id = ?'); values.push(newEmpId);
  }
  if (req.body.name !== undefined) { fields.push('full_name = ?'); values.push(req.body.name); }
  if (req.body.email !== undefined) { fields.push('email = ?'); values.push(req.body.email); }
  if (req.body.department !== undefined) { fields.push('department = ?'); values.push(req.body.department); }
  if (req.body.location !== undefined) { fields.push('location = ?'); values.push(req.body.location); }
  if (req.body.status !== undefined) { fields.push('status = ?'); values.push(req.body.status); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);
  const [result] = await pool.query(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, values);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found.' });
  await audit(req.erpUser.employeeId, 'employee-updated', String(req.params.id));
  res.json({ ok: true });
});

// Delete — same row ISO's own "Delete employee" removes. Blocked if the
// employee currently holds ERP access (revoke that first) or is the
// caller's own account, mirroring ISO's own foot-gun guards.
router.delete('/employees/:id', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const id = +req.params.id;
  if (id === req.erpUser.id) return res.status(400).json({ error: 'You cannot delete your own employee record.' });
  if (req.erpUser.role === 'Sub Admin') {
    const [target] = await pool.query('SELECT role FROM erp_employee_roles WHERE employee_id = ? AND active = 1', [id]);
    if (target.length && (target[0].role === 'Administrator' || target[0].role === 'Sub Admin')) {
      return res.status(403).json({ error: 'Only an Administrator can delete this employee.' });
    }
  }
  const [result] = await pool.query('DELETE FROM employees WHERE id = ?', [id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found.' });
  await audit(req.erpUser.employeeId, 'employee-deleted', String(id));
  res.json({ ok: true });
});

// Bulk delete — same per-row guards as the single DELETE above (can't
// delete yourself; a Sub Admin can't delete an Administrator/Sub Admin),
// applied per employee so one protected row never blocks the rest of the
// batch. Body is either { ids: [...] } (selected rows) or { all: true }
// (every employee on file, e.g. to undo a bad bulk import from scratch).
router.delete('/employees', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  let ids;
  if (req.body && req.body.all === true) {
    const [rows] = await pool.query('SELECT id FROM employees');
    ids = rows.map((r) => r.id);
  } else {
    ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  }
  if (!ids.length) return res.status(400).json({ error: 'No employees selected.' });
  if (ids.length > 5000) return res.status(400).json({ error: 'Too many employees in one request (max 5000).' });

  let deleted = 0;
  const skipped = [];
  for (const id of ids) {
    if (id === req.erpUser.id) { skipped.push({ id, reason: 'This is your own account — cannot self-delete.' }); continue; }
    if (req.erpUser.role === 'Sub Admin') {
      const [target] = await pool.query('SELECT role FROM erp_employee_roles WHERE employee_id = ? AND active = 1', [id]);
      if (target.length && (target[0].role === 'Administrator' || target[0].role === 'Sub Admin')) {
        skipped.push({ id, reason: 'Only an Administrator can delete this employee.' });
        continue;
      }
    }
    try {
      const [result] = await pool.query('DELETE FROM employees WHERE id = ?', [id]);
      if (result.affectedRows) deleted++; else skipped.push({ id, reason: 'Not found.' });
    } catch (e) {
      skipped.push({ id, reason: e.message });
    }
  }
  await audit(req.erpUser.employeeId, 'employees-bulk-deleted', `deleted=${deleted} skipped=${skipped.length}`);
  res.json({ deleted, skipped });
});

// Emp Code equality used everywhere in this file — leading-zero tolerant
// ("9" == "09") but never crosses genuinely different numbers ("9" vs "90"
// vs "19" vs "999" all stay distinct), matching the same rule the
// attendance ingest route (routes/attendance.js) uses against the device.
function normEmpCode(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^[0-9]+$/.test(s)) return String(parseInt(s, 10));
  return s.toLowerCase();
}

// CSV "Status" columns are usually a plain Yes/No (currently employed?)
// rather than this system's Active/Inactive wording — map the common
// spellings, and pass anything unrecognized straight through untouched
// rather than guessing at it.
function mapCsvStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return undefined;
  if (['yes', 'y', 'active', 'a'].includes(s)) return 'Active';
  if (['no', 'n', 'inactive', 'resigned', 'terminated', 'left'].includes(s)) return 'Inactive';
  return String(raw).trim();
}

// "Mr Basheer Ahmed" -> { first: 'Mr Basheer', last: 'Ahmed' } — last word
// is the last name, everything before it (titles like Mr/Syed included)
// stays in the first name, matching how this company's HR data is written.
function splitEmployeeName(full) {
  const parts = String(full == null ? '' : full).trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// "Mr"/"MR" -> Male, "Ms"/"MS" -> Female, read off the leading title word
// only (an exact "mr"/"ms" token — "Mrs" is deliberately NOT treated as
// "Mr"). Any other/no title returns undefined so gender is left alone
// rather than guessed.
function detectGenderFromTitle(full) {
  const firstWord = String(full == null ? '' : full).trim().split(/\s+/)[0] || '';
  const t = firstWord.toLowerCase();
  if (t === 'mr') return 'Male';
  if (t === 'ms') return 'Female';
  return undefined;
}

// Pakistani CNIC — strip everything but digits, cap at 13, format 5-7-1.
// Same rule empFormatNic() applies live in the Add/Edit Employee form, so a
// badly-formatted CNIC in the CSV ("3520112345671", "35201-1234567 1", …)
// comes out exactly like typing it into that field by hand would.
// Returns undefined (leave the column alone) when the cell carried no digits.
function formatNic(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '').slice(0, 13);
  if (!digits) return undefined;
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

// Local phone number only, no country code (the HR form keeps phone_country/
// phone_code in their own columns) — strips everything but digits, then a
// leading national trunk '0' or Pakistan's own dialing code '92' if the CSV
// cell carried the full number ("0300-1234567", "+92 300 1234567", "923001234567").
// Returns undefined when the cell carried no digits.
function formatPhoneNumber(raw) {
  let digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length > 10 && digits.startsWith('92')) digits = digits.slice(2);
  else if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// Explicit "Gender" column from a CSV — the sheet almost always already
// spells it exactly like the ERP's own dropdown ('Male'/'Female'/'Other'),
// but normalize case/whitespace so "male"/"FEMALE " etc. still land on a
// real dropdown option instead of silently failing to match one later.
// Returns undefined for a blank cell (caller then falls back to guessing
// from the name's title, same as before this column existed).
function normalizeGender(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  const low = s.toLowerCase();
  if (low === 'male' || low === 'm') return 'Male';
  if (low === 'female' || low === 'f') return 'Female';
  return s; // some other spelling (e.g. "Other") — pass it through as typed
}

// "Permenant" is the almost-universal misspelling this company's own HR
// sheets use for "Permanent" — normalize known variants onto the ERP
// Employment Type dropdown's real option spelling so the saved value
// actually shows as selected next time the form opens, instead of landing
// on a string no <option> matches. Anything else passes through unchanged
// (Probation/Contractual/Part-time already match as typed).
function normalizeEmploymentType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  const low = s.toLowerCase();
  if (low === 'permenant' || low === 'permanant' || low === 'permanent') return 'Permanent';
  if (low === 'probation' || low === 'probationary') return 'Probation';
  if (low === 'contractual' || low === 'contract') return 'Contractual';
  if (low === 'part-time' || low === 'parttime' || low === 'part time') return 'Part-time';
  return s;
}

// "150,000", "PKR 150000", " 150000.00 " -> 150000 — Gross Salary cells come
// out of Excel/CSV in all sorts of dressed-up forms. Returns undefined (leave
// the column alone) for a blank cell or anything that isn't a real number,
// rather than silently writing a 0 salary over whatever was already on file.
function parseCsvNumber(v) {
  if (v == null || v === '') return undefined;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Same idea as parseCsvNumber, but a real "0" cell (e.g. Field Allowance=0,
// meaning this employee genuinely gets none) is kept instead of treated as
// unparseable — only a truly blank/empty cell means "leave it alone".
function parseCsvNumberAllowZero(v) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

// Shift Start / Shift End — "09:00", "9:00", "09:00:00", "9:00 AM", "5:30 PM"
// all read fine; recommended sheet format is 24-hour HH:MM (e.g. 09:00,
// 17:30), but 12-hour AM/PM is accepted too since Excel often shows times
// that way. Returns null for a blank or unreadable cell (left alone — see
// the shift upsert below, which only touches columns the sheet actually gave
// a time for).
function parseCsvTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let [, h, mi, se, ap] = m;
  h = +h; mi = +mi; se = se ? +se : 0;
  if (ap) {
    const isPm = ap.toLowerCase() === 'pm';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
  } else if (h > 23) {
    return null;
  }
  if (h > 23 || mi > 59 || se > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`;
}

// Bulk import from CSV (Employees screen -> "Import Employees"). Matches
// each row to an existing employee by Emp Code (leading-zero tolerant);
// updates it if found, otherwise creates a brand-new employee record with
// no ERP login access (no erp_employee_roles row) until someone explicitly
// grants it from the Access tab — importing data never silently grants
// login. Newly-created/updated employees also get retroactively linked to
// any attendance punches already sitting in erp_attendance_logs under a
// matching (leading-zero tolerant) device code, so "unmapped" punches for
// that Emp Code disappear the moment the employee exists.
//
// An existing employee is matched/UPDATED, never deleted and recreated, so
// their numeric id — and with it every erp_attendance_logs/erp_leave_requests
// row, payroll history and JLR field-job presence already keyed to it —
// stays exactly as it was. Their employees.full_name is also deliberately
// left untouched (see the comment at the UPDATE below): only the HR profile
// fields (CNIC, phone, salary, bank, etc.) get refreshed from the sheet.
router.post('/employees/import', requireGroup('Human Resources'), async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows in one import (max 5000).' });

  const [existingRows] = await pool.query('SELECT id, employee_id, full_name FROM employees');
  const byCode = new Map(); // normEmpCode -> {id, fullName} (existing, or created earlier in this same batch)
  for (const e of existingRows) byCode.set(normEmpCode(e.employee_id), { id: e.id, fullName: e.full_name });

  // Emp Code is the authoritative match key (see the no-rename comment
  // below), but a code that matches while the sheet's Name looks nothing
  // like what's on file is exactly the shape of a typo'd/transposed Emp
  // Code — surfaced as a non-fatal warning (the row still gets applied)
  // rather than silently trusting the code alone.
  function nameLooksMismatched(sheetName, onFileName) {
    const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['mr', 'ms', 'mrs', 'syed', 'muhammad', 'mohammad'].includes(w)));
    const a = words(sheetName), b = words(onFileName);
    if (!a.size || !b.size) return false;
    for (const w of a) if (b.has(w)) return false;
    return true;
  }

  // Department/Office Location/Bank Name dropdowns must never silently
  // reject a sheet value that isn't on the list yet — register every new
  // one up front (one query each, not per-row) so it's there both for the
  // UPDATE below and for anyone opening the Employee form afterwards.
  const [deptRows] = await pool.query('SELECT name FROM departments');
  const [locRows] = await pool.query('SELECT name FROM locations');
  const [bankRows] = await pool.query('SELECT name FROM erp_banks');
  const knownDepts = new Set(deptRows.map((r) => r.name.toLowerCase()));
  const knownLocs = new Set(locRows.map((r) => r.name.toLowerCase()));
  const knownBanks = new Set(bankRows.map((r) => r.name.toLowerCase()));
  const newDepts = new Set(), newLocs = new Set(), newBanks = new Set();
  for (const r of rows) {
    const d = String(r.department || '').trim(); if (d && !knownDepts.has(d.toLowerCase())) newDepts.add(d);
    const l = String(r.location || '').trim(); if (l && !knownLocs.has(l.toLowerCase())) newLocs.add(l);
    const b = String(r.bankName || '').trim(); if (b && !knownBanks.has(b.toLowerCase())) newBanks.add(b);
  }
  for (const d of newDepts) await pool.query('INSERT INTO departments (name) VALUES (?)', [d]);
  for (const l of newLocs) await pool.query('INSERT INTO locations (name) VALUES (?)', [l]);
  for (const b of newBanks) await pool.query('INSERT IGNORE INTO erp_banks (name) VALUES (?)', [b]);
  if (newDepts.size || newLocs.size || newBanks.size) {
    await audit(req.erpUser.employeeId, 'employees-import-new-options', `depts=${[...newDepts].join('|')} locs=${[...newLocs].join('|')} banks=${[...newBanks].join('|')}`);
  }

  let created = 0, updated = 0;
  const errors = [];
  const nameWarnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const rowNum = i + 1;
    const employeeId = String(row.employeeId || '').trim();
    const name = String(row.name || '').trim();
    if (!employeeId) { errors.push({ row: rowNum, employeeId, message: 'Missing Emp Code.' }); continue; }
    if (!name) { errors.push({ row: rowNum, employeeId, message: 'Missing Employee Name.' }); continue; }
    const code = normEmpCode(employeeId);

    try {
      const existing = byCode.get(code);
      let empRowId = existing ? existing.id : undefined;
      if (empRowId && nameLooksMismatched(name, existing.fullName)) {
        nameWarnings.push({ row: rowNum, employeeId, message: `Sheet says "${name}" but Emp Code ${employeeId} is on file as "${existing.fullName}" — double-check this Emp Code before trusting this row's update.` });
      }
      if (empRowId) {
        // Existing employee (already on file, or created earlier in this
        // same CSV) — update email/status, but deliberately NEVER touch
        // full_name here. Attendance, Payroll and JLR's field-job matching
        // all key off the Employee ID staying put (guaranteed — this is an
        // UPDATE, never a delete+recreate) AND the employee's exact name
        // text staying put (JLR matches free-text Inspector/Team names
        // against employees.full_name character-for-character). A CSV
        // re-import meant to fix salary/CNIC/phone format must not silently
        // reword a name and break every past JLR entry that referenced it —
        // renaming someone is a deliberate edit from the Employees form, not
        // a side effect of a bulk import.
        const mappedStatus = mapCsvStatus(row.status);
        const fields = []; const values = [];
        if (row.email) { fields.push('email = ?'); values.push(row.email); }
        if (mappedStatus) { fields.push('status = ?'); values.push(mappedStatus); }
        if (row.department) { fields.push('department = ?'); values.push(String(row.department).trim()); }
        if (row.location) { fields.push('location = ?'); values.push(String(row.location).trim()); }
        if (fields.length) { values.push(empRowId); await pool.query(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, values); }
        updated++;
      } else {
        const randomPassword = crypto.randomBytes(24).toString('hex');
        const hashed = await bcrypt.hash(randomPassword, 10);
        const [result] = await pool.query(
          'INSERT INTO employees (employee_id, full_name, email, password, department, location, status) VALUES (?,?,?,?,?,?,?)',
          [employeeId, name, row.email || null, hashed, String(row.department || '').trim(), String(row.location || '').trim(), mapCsvStatus(row.status) || 'Active']
        );
        empRowId = result.insertId;
        byCode.set(code, { id: empRowId, fullName: name });
        created++;
      }

      // Upsert the HR profile fields the CSV carries (only non-empty ones,
      // so a blank cell never clobbers data already on file).
      const { first: firstName, last: lastName } = splitEmployeeName(name);
      const phoneNumber = formatPhoneNumber(row.phoneNumber);
      const grossSalary = parseCsvNumber(row.grossSalary);
      const profile = {
        first_name: firstName, last_name: lastName,
        // An explicit Gender column in the sheet always wins over guessing
        // from the name's title — only falls back to the guess when the
        // sheet left this cell blank.
        gender: normalizeGender(row.gender) || detectGenderFromTitle(name),
        employment_type: normalizeEmploymentType(row.employmentType),
        field_allowance: parseCsvNumberAllowZero(row.fieldAllowance),
        // This import is this company's Pakistan-payroll employee sheet —
        // every row it touches gets its Compensation tab's Currency set to
        // PKR, overwriting the Employee form's own "AED" fallback (which
        // only ever showed because this column was blank, not because
        // anyone actually chose AED for these people).
        currency: 'PKR',
        father_husband_name: row.fatherHusbandName, mother_name: row.motherName,
        phone_number: phoneNumber, nic_number: formatNic(row.nicNumber),
        bank_name: row.bankName, account_no: row.accountNo, iban: row.iban, account_title: row.accountTitle,
        date_of_birth: parseCsvDate(row.dateOfBirth), nationality: row.nationality,
        designation: row.designation, join_date: parseCsvDate(row.joinDate), job_end_date: parseCsvDate(row.jobEndDate),
        home_address: row.homeAddress,
        // Payroll reads ONLY gross_salary (routes/payroll.js) — this is the
        // field whose absence was paying everyone as "Salary not added".
        // salary/hra/utility_allowance are split out the same way the
        // Add/Edit Employee form's own live calculator does (EMP_SALARY_SPLIT
        // in the front end), purely for the payslip breakdown display.
        gross_salary: grossSalary,
        salary: grossSalary != null ? +(grossSalary * 0.6).toFixed(2) : undefined,
        hra: grossSalary != null ? +(grossSalary * 0.3).toFixed(2) : undefined,
        utility_allowance: grossSalary != null ? +(grossSalary * 0.1).toFixed(2) : undefined,
        // A phone number with no country on file yet defaults to Pakistan —
        // see the COALESCE guard below, which only fills this in when the
        // employee doesn't already have one set (never overwrites a
        // deliberately-chosen country, e.g. someone based in the UAE).
        phone_country: phoneNumber ? 'PK' : undefined,
        phone_code: phoneNumber ? '+92' : undefined,
      };
      const cols = Object.keys(profile).filter((c) => profile[c] !== undefined && profile[c] !== null && profile[c] !== '');
      if (cols.length) {
        const updateSql = cols.map((c) => (
          (c === 'phone_country' || c === 'phone_code') ? `${c} = COALESCE(${c}, VALUES(${c}))` : `${c} = VALUES(${c})`
        )).join(', ');
        await pool.query(
          `INSERT INTO erp_employee_profile (employee_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
           ON DUPLICATE KEY UPDATE ${updateSql}`,
          [empRowId, ...cols.map((c) => profile[c])]
        );
      }

      // Shift Start / Shift End (erp_employee_shifts — see routes/attendance.js's
      // PUT /shift/:employeeId for the same table). Only the columns the sheet
      // actually gave a readable time for are touched: a brand-new employee
      // with no Shift Start cell still gets the schema's 09:00 default (the
      // column is left out of the INSERT entirely), and an existing
      // employee's grace_minutes / the other of the two times is never
      // clobbered by a blank or unreadable cell.
      const shiftCols = {};
      const shiftStart = parseCsvTime(row.shiftStart); if (shiftStart) shiftCols.shift_start = shiftStart;
      const shiftEnd = parseCsvTime(row.shiftEnd); if (shiftEnd) shiftCols.shift_end = shiftEnd;
      const shiftColNames = Object.keys(shiftCols);
      if (shiftColNames.length) {
        const shiftUpdateSql = shiftColNames.map((c) => `${c} = VALUES(${c})`).join(', ');
        await pool.query(
          `INSERT INTO erp_employee_shifts (employee_id, ${shiftColNames.join(', ')}) VALUES (?, ${shiftColNames.map(() => '?').join(', ')})
           ON DUPLICATE KEY UPDATE ${shiftUpdateSql}`,
          [empRowId, ...shiftColNames.map((c) => shiftCols[c])]
        );
      }

      // Retro-link any attendance punches already sitting under this Emp
      // Code (leading-zero tolerant) that came in before this employee
      // record existed — they were showing as "unmapped" until now.
      await pool.query(
        `UPDATE erp_attendance_logs SET employee_id = ?
         WHERE employee_id IS NULL
           AND (device_user_id = ? OR (device_user_id REGEXP '^[0-9]+$' AND ? REGEXP '^[0-9]+$' AND CAST(device_user_id AS UNSIGNED) = CAST(? AS UNSIGNED)))`,
        [empRowId, employeeId, employeeId, employeeId]
      );
    } catch (e) {
      errors.push({ row: rowNum, employeeId, message: e.message });
    }
  }

  await audit(req.erpUser.employeeId, 'employees-imported', `created=${created} updated=${updated} errors=${errors.length} nameWarnings=${nameWarnings.length}`);
  res.json({ created, updated, errors, nameWarnings });
});

// Accepts DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD and a few common variants
// (CSV date columns are rarely one consistent format). Returns
// 'YYYY-MM-DD' for a DATE column, or null if it can't be read at all —
// never throws, so one bad date cell never fails the whole row.
function parseCsvDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // YYYY-MM-DD
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD/MM/YYYY or DD-MM-YYYY
  if (m) {
    let [, d, mo, y] = m;
    if (+d > 12 && +mo <= 12) { /* already DD MM */ } else if (+mo > 12 && +d <= 12) { [d, mo] = [mo, d]; }
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/* ---------------- departments (shared master list, bidirectional) ---------------- */
router.get('/departments', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM departments ORDER BY name ASC');
  res.json(rows);
});
router.post('/departments', requireGroup('Human Resources'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name is required.' });
  const [result] = await pool.query('INSERT INTO departments (name) VALUES (?)', [req.body.name]);
  await audit(req.erpUser.employeeId, 'department-created', req.body.name);
  res.status(201).json({ id: result.insertId, name: req.body.name });
});
router.delete('/departments/:id', requireGroup('Human Resources'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Not found.' });
  await audit(req.erpUser.employeeId, 'department-deleted', req.params.id);
  res.json({ ok: true });
});

/* ---------------- banks (ERP-only master list — unlike departments/
   locations above, there's no ISO table for this; see erp_banks in
   migrate.js) ---------------- */
router.get('/banks', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM erp_banks ORDER BY name ASC');
  res.json(rows);
});
router.post('/banks', requireGroup('Human Resources'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const [result] = await pool.query('INSERT INTO erp_banks (name) VALUES (?)', [name]);
    await audit(req.erpUser.employeeId, 'bank-created', name);
    res.status(201).json({ id: result.insertId, name });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ ok: true, name }); // already on the list — nothing to do
    throw e;
  }
});
router.delete('/banks/:id', requireGroup('Human Resources'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM erp_banks WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Not found.' });
  await audit(req.erpUser.employeeId, 'bank-deleted', req.params.id);
  res.json({ ok: true });
});

/* ---------------- locations (shared master list, bidirectional) ---------------- */
router.get('/locations', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM locations ORDER BY name ASC');
  res.json(rows);
});
router.post('/locations', requireGroup('Human Resources'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name is required.' });
  const [result] = await pool.query('INSERT INTO locations (name) VALUES (?)', [req.body.name]);
  await audit(req.erpUser.employeeId, 'location-created', req.body.name);
  res.status(201).json({ id: result.insertId, name: req.body.name });
});
router.delete('/locations/:id', requireGroup('Human Resources'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM locations WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Not found.' });
  await audit(req.erpUser.employeeId, 'location-deleted', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
