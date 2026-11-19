/* ============================================================
   Accounting lookups shared with other modules.

   - Taxes (erp_tax_rates): the sales-tax-on-services keys and rates
     (KPK, SRB, ICT, BRA, PRA ...). Edited on Accounting > Taxes; read by
     anyone signed in, because CRM Quotations pick their tax key + % from
     this list and a Sales/CRM user has no Accounting access.
   - Companies: just id / code / name of the Accounting companies (the
     full records live in erp_records, module 'glcompanies', which only
     Accounting may open). Client Contracts number themselves off the
     company code, e.g. PTIS-CTR-2026-27-00001.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

function requireAccountingWrite(req, res, next) {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  if (!canAccess(req.erpUser.role, 'Accounting')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Accounting.` });
  next();
}

function shapeTax(r) {
  return { id: r.id, key: r.tax_key, description: r.description || '', rate: Number(r.rate), sortOrder: r.sort_order, updatedAt: r.updated_at };
}
function cleanKey(v) { return String(v || '').trim().toUpperCase().slice(0, 20); }
function cleanRate(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? +n.toFixed(2) : null;
}

router.get('/taxes', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM erp_tax_rates ORDER BY sort_order, id');
  res.json(rows.map(shapeTax));
});

router.post('/taxes', requireAccountingWrite, async (req, res) => {
  const key = cleanKey(req.body.key);
  const rate = cleanRate(req.body.rate);
  if (!key) return res.status(400).json({ error: 'Tax key is required.' });
  if (rate == null) return res.status(400).json({ error: 'Rate must be a number between 0 and 100.' });
  const [[mx]] = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM erp_tax_rates');
  try {
    const [r] = await pool.query(
      'INSERT INTO erp_tax_rates (tax_key, description, rate, sort_order, updated_by) VALUES (?,?,?,?,?)',
      [key, String(req.body.description || '').trim().slice(0, 160) || null, rate, mx.m + 1, req.erpUser.id]
    );
    await audit(req.erpUser.employeeId, 'tax-rate-created', `${key} ${rate}%`);
    const [rows] = await pool.query('SELECT * FROM erp_tax_rates WHERE id = ?', [r.insertId]);
    res.status(201).json(shapeTax(rows[0]));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Tax key "${key}" already exists.` });
    throw e;
  }
});

router.put('/taxes/:id', requireAccountingWrite, async (req, res) => {
  const [cur] = await pool.query('SELECT * FROM erp_tax_rates WHERE id = ?', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'Tax not found.' });
  const key = req.body.key !== undefined ? cleanKey(req.body.key) : cur[0].tax_key;
  const rate = req.body.rate !== undefined ? cleanRate(req.body.rate) : Number(cur[0].rate);
  if (!key) return res.status(400).json({ error: 'Tax key is required.' });
  if (rate == null) return res.status(400).json({ error: 'Rate must be a number between 0 and 100.' });
  const description = req.body.description !== undefined ? (String(req.body.description).trim().slice(0, 160) || null) : cur[0].description;
  try {
    await pool.query('UPDATE erp_tax_rates SET tax_key = ?, description = ?, rate = ?, updated_by = ? WHERE id = ?',
      [key, description, rate, req.erpUser.id, req.params.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Tax key "${key}" already exists.` });
    throw e;
  }
  await audit(req.erpUser.employeeId, 'tax-rate-updated', `${cur[0].tax_key} ${Number(cur[0].rate)}% -> ${key} ${rate}%`);
  const [rows] = await pool.query('SELECT * FROM erp_tax_rates WHERE id = ?', [req.params.id]);
  res.json(shapeTax(rows[0]));
});

router.delete('/taxes/:id', requireAccountingWrite, async (req, res) => {
  const [cur] = await pool.query('SELECT * FROM erp_tax_rates WHERE id = ?', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'Tax not found.' });
  await pool.query('DELETE FROM erp_tax_rates WHERE id = ?', [req.params.id]);
  await audit(req.erpUser.employeeId, 'tax-rate-deleted', `${cur[0].tax_key} ${Number(cur[0].rate)}%`);
  res.json({ ok: true });
});

router.get('/companies', async (req, res) => {
  const [rows] = await pool.query("SELECT id, data FROM erp_records WHERE module = 'glcompanies' AND deleted_at IS NULL ORDER BY created_at");
  const out = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.data);
      out.push({ id: d.id || r.id, code: d.code || '', name: d.name || '' });
    } catch (e) { /* skip a malformed row */ }
  }
  res.json(out);
});

module.exports = router;
