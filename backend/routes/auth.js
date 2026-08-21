/* ============================================================
   ERP auth — backed by the SAME `employees` table the ISO/LMS backend
   (iso-server-backend-PTIS) uses. Same employee_id + password logs into
   both systems. This file only ever SELECTs from `employees` (read-only)
   plus reads/writes its own new `erp_employee_roles` table — it never
   ALTERs or writes to `employees` itself, so ISO logins/behaviour are
   completely unaffected by anything here.
   ============================================================ */
'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { issue, verify } = require('../token');
const { ROLES, GROUPS_ALL, canAccess } = require('../roles');

// A role is valid if it's one of the 9 named presets, OR a comma-separated
// list of module names picked directly on the Employees form's multi-select
// (e.g. "CRM,Human Resources") — every token must be a real module group.
function isValidRole(role) {
  if (ROLES[role]) return true;
  const tokens = String(role || '').split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => GROUPS_ALL.includes(t));
}

const router = express.Router();

/* ---------------- login rate limiting (in-memory, per process) ---------------- */
const FAILS = new Map();
function rateKey(req, id) { return (req.ip || '') + '|' + String(id || '').toLowerCase(); }
function rateCheck(key) {
  const f = FAILS.get(key);
  if (f && f.until && Date.now() < f.until) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}
function rateFail(key) {
  const f = FAILS.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  FAILS.set(key, f);
}

async function audit(byEmployee, action, target) {
  try { await pool.query('INSERT INTO erp_audit (by_employee, action, target) VALUES (?,?,?)', [byEmployee || null, action, target || null]); }
  catch (e) { console.error('[erp-audit] failed:', e.message); }
}

async function findEmployeeWithRole(employeeId) {
  const [rows] = await pool.query(
    `SELECT e.id, e.employee_id, e.full_name, e.email, e.password, e.department, e.location, e.status,
            r.role, r.desig, r.active AS erp_active
     FROM employees e
     LEFT JOIN erp_employee_roles r ON r.employee_id = e.id
     WHERE e.employee_id = ?`,
    [employeeId]
  );
  return rows[0] || null;
}

function pubEmployee(e) {
  return {
    id: e.id, employeeId: e.employee_id, name: e.full_name, email: e.email,
    department: e.department, location: e.location, role: e.role || null, desig: e.desig || '',
  };
}

/* ---------------- middleware ---------------- */
async function requireAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Not signed in.' });
  const p = verify(m[1]);
  if (!p) return res.status(401).json({ error: 'Session expired — please log in again.' });
  const [rows] = await pool.query(
    `SELECT e.id, e.employee_id, e.full_name, e.email, e.department, e.location, e.status,
            r.role, r.desig, r.active AS erp_active
     FROM employees e LEFT JOIN erp_employee_roles r ON r.employee_id = e.id
     WHERE e.id = ?`,
    [p.sub]
  );
  const u = rows[0];
  if (!u || u.status === 'Inactive' || !u.role || u.erp_active === 0) return res.status(401).json({ error: 'Not signed in.' });
  req.erpUser = pubEmployee(u);
  next();
}
function requireAdmin(req, res, next) {
  if (req.erpUser.role !== 'Administrator') return res.status(403).json({ error: 'Administrator only.' });
  next();
}

/* ---------------- routes ---------------- */

// Has anyone claimed the first Administrator seat yet?
router.get('/status', async (req, res) => {
  const [rows] = await pool.query("SELECT COUNT(*) c FROM erp_employee_roles WHERE role='Administrator' AND active=1");
  res.json({ setup: rows[0].c > 0 });
});

router.post('/login', async (req, res) => {
  const employeeId = String(req.body.employeeId || req.body.employee_id || '').trim();
  const password = String(req.body.password || '');
  const key = rateKey(req, employeeId);
  const wait = rateCheck(key);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });

  const e = await findEmployeeWithRole(employeeId);
  const ok = e && e.status !== 'Inactive' && (await bcrypt.compare(password, e.password).catch(() => false));
  if (!ok) { rateFail(key); await audit(employeeId, 'login-failed', employeeId); return res.status(401).json({ error: 'Invalid employee ID or password.' }); }
  if (!e.role || e.erp_active === 0) {
    return res.status(403).json({ error: 'This account has no ERP access yet. Ask your ERP Administrator to grant a role.' });
  }
  FAILS.delete(key);
  const { token, expires } = issue(e.id, { role: e.role });
  await audit(employeeId, 'login', employeeId);
  res.json({ token, expires, user: pubEmployee(e) });
});

// First-run only: an existing ISO employee claims the ERP Administrator seat.
// No new user/employee is created — it must be a real employees row (same
// credentials as ISO).
router.post('/claim-admin', async (req, res) => {
  const [existing] = await pool.query("SELECT COUNT(*) c FROM erp_employee_roles WHERE role='Administrator' AND active=1");
  if (existing[0].c > 0) return res.status(403).json({ error: 'An ERP administrator already exists.' });

  const employeeId = String(req.body.employeeId || req.body.employee_id || '').trim();
  const password = String(req.body.password || '');
  const e = await findEmployeeWithRole(employeeId);
  const ok = e && e.status !== 'Inactive' && (await bcrypt.compare(password, e.password).catch(() => false));
  if (!ok) return res.status(401).json({ error: 'Invalid employee ID or password. Use an existing ISO employee login.' });

  await pool.query(
    'INSERT INTO erp_employee_roles (employee_id, role, desig, active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), active=1',
    [e.id, 'Administrator', req.body.desig || '']
  );
  const { token, expires } = issue(e.id, { role: 'Administrator' });
  await audit(employeeId, 'claim-admin', employeeId);
  e.role = 'Administrator';
  res.status(201).json({ token, expires, user: pubEmployee(e) });
});

router.get('/me', requireAuth, (req, res) => res.json(req.erpUser));

router.get('/roles', (req, res) => res.json(Object.keys(ROLES)));

// Admin: list every ISO employee with their current ERP role (or null = not granted).
router.get('/erp-users', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.id, e.employee_id, e.full_name, e.email, e.department, e.location, e.status,
            r.role, r.desig, r.active AS erp_active
     FROM employees e LEFT JOIN erp_employee_roles r ON r.employee_id = e.id
     ORDER BY e.full_name ASC`
  );
  res.json(rows.map(pubEmployee).map((u, i) => ({ ...u, erpActive: rows[i].erp_active !== 0 })));
});

router.post('/erp-users/:employeeId/role', requireAuth, requireAdmin, async (req, res) => {
  const id = +req.params.employeeId;
  if (!isValidRole(req.body.role)) return res.status(400).json({ error: 'Unknown role / module list.' });
  const [emp] = await pool.query('SELECT id FROM employees WHERE id = ?', [id]);
  if (!emp.length) return res.status(404).json({ error: 'Employee not found.' });
  await pool.query(
    'INSERT INTO erp_employee_roles (employee_id, role, desig, active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), desig=VALUES(desig), active=1',
    [id, req.body.role, req.body.desig || '']
  );
  await audit(req.erpUser.employeeId, 'erp-role-granted', `${id} -> ${req.body.role}`);
  res.json({ ok: true });
});

router.post('/erp-users/:employeeId/revoke', requireAuth, requireAdmin, async (req, res) => {
  const id = +req.params.employeeId;
  if (id === req.erpUser.id) return res.status(400).json({ error: 'You cannot revoke your own ERP access.' });
  await pool.query('UPDATE erp_employee_roles SET active = 0 WHERE employee_id = ?', [id]);
  await audit(req.erpUser.employeeId, 'erp-role-revoked', String(id));
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireAdmin, audit };
