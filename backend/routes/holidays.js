/* ============================================================
   Company Holiday Calendar (erp_holidays) — HR declares dates as
   non-working (Gazetted / Islamic / CompanyOff); GET /api/attendance/summary
   applies these to every employee automatically. Replaces the old manual
   attendance entry / bulk sheet import workflow entirely — HR no longer
   hand-fills attendance rows to cover Sundays/holidays/office closures,
   they just mark the date here once.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const TYPES = ['Gazetted', 'Islamic', 'CompanyOff'];

function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}

// GET /api/holidays?from=&to= — every signed-in user can read (needed to
// render the attendance report's day labels), optionally range-filtered.
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT id, holiday_date, type, name FROM erp_holidays';
  const params = [];
  if (from && to) { sql += ' WHERE holiday_date BETWEEN ? AND ?'; params.push(from, to); }
  sql += ' ORDER BY holiday_date ASC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map((r) => ({ id: r.id, date: r.holiday_date, type: r.type, name: r.name })));
});

// POST /api/holidays  { date, type, name } — HR only.
router.post('/', requireHr, async (req, res) => {
  const { date, type, name } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${TYPES.join(', ')}.` });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required.' });
  try {
    const [result] = await pool.query(
      'INSERT INTO erp_holidays (holiday_date, type, name, created_by) VALUES (?,?,?,?)',
      [date, type, String(name).trim(), req.erpUser.id]
    );
    await audit(req.erpUser.employeeId, 'holiday-added', `${date} (${type}) ${name}`);
    res.status(201).json({ id: result.insertId, date, type, name: String(name).trim() });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A holiday is already set for this date.' });
    throw e;
  }
});

// DELETE /api/holidays/:id — HR only.
router.delete('/:id', requireHr, async (req, res) => {
  const [result] = await pool.query('DELETE FROM erp_holidays WHERE id = ?', [+req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Holiday not found.' });
  await audit(req.erpUser.employeeId, 'holiday-removed', String(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
