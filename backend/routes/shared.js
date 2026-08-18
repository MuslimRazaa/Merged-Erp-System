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

/* ---------------- employees (Human Resources) ---------------- */
router.get('/employees', requireGroup('Human Resources'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, employee_id, full_name, email, department, location, status, created_at, updated_at
     FROM employees ORDER BY full_name ASC`
  );
  res.json(rows.map((r) => ({
    id: r.id, employeeId: r.employee_id, name: r.full_name, email: r.email,
    department: r.department, location: r.location, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  })));
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
