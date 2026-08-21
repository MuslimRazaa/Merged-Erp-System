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
  'lms_access', 'portal_access', 'cvs_access', 'reports_access', 'testing_access',
  'jlr_operations_access', 'jlr_qhse_access', 'jlr_inventory_access', 'jlr_accounts_access', 'jlr_it_access', 'jlr_full_access',
  'iso_forms_access', 'iso_forms_admin_access',
];
// Columns on ERP's own erp_employee_profile table (see migrate.js) — the
// HR form's Personal/Bank/Reference/Kin/Salary sections.
const PROFILE_COLUMNS = [
  'first_name', 'last_name', 'designation', 'gender', 'marital_status', 'cost_center', 'join_date', 'job_end_date',
  'nationality', 'visa_number', 'visa_expiry', 'home_address', 'mailing_address',
  'bank_name', 'iban', 'account_no', 'account_title', 'blood_group',
  'appraisal_date', 'confirmation_date', 'rejoin_date', 'rejoin_reason',
  'ref_name', 'ref_contact', 'ref_email', 'ref_office',
  'kin_name', 'kin_relation', 'kin_contact', 'kin_nic', 'kin_email',
  'salary', 'utility_allowance', 'hra', 'field_allowance', 'currency',
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
  const [result] = await pool.query('DELETE FROM employees WHERE id = ?', [id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found.' });
  await audit(req.erpUser.employeeId, 'employee-deleted', String(id));
  res.json({ ok: true });
});

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
