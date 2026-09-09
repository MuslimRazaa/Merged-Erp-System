/* ============================================================
   CRM — Customers master list + RFQs (Request for Quotation).
   Brand-new ERP-only tables (erp_crm_customers, erp_crm_rfqs,
   erp_crm_rfq_items — see migrate.js). No ISO table is touched.

   Design note (see the RFQ/Quotation discussion): an RFQ can arrive as a
   call, an email (table or plain text) or a PDF/scanned document — there
   is no fixed inbound format, so this never tries to parse one. A
   Sales/CRM user reads whatever arrived and keys in the handful of
   structured fields below; the moment that happens the RFQ gets a fixed,
   permanent rfq_no. Every Quotation built against it (once Quotations
   move to the backend too) will reference this row's id, so a Quotation
   always traces back to exactly the RFQ — and its line items — it was
   quoted from, no matter how that RFQ originally showed up.
   ============================================================ */
'use strict';
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

// RFQ attachments go over real multipart/form-data (memory storage — no
// disk writes, straight into erp_crm_rfq_attachments as a BLOB, same as
// before), not base64 embedded in a JSON body. A base64 blob inside JSON
// is a known WAF-evasion pattern some hosts' firewalls (Imunify360,
// ModSecurity) flag and block outright regardless of the file's actual
// size or content — a real file upload field is the normal, expected
// shape and doesn't trip that.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB per file
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 } });
function handleUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'One of the attached files is over the 15MB limit.' });
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

function requireGroup(group) {
  return (req, res, next) => {
    if (!canAccess(req.erpUser.role, group)) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to ${group}.` });
    next();
  };
}
router.use(requireGroup('CRM'));

// mysql2 hands back a DATE column as a JS Date at local midnight; letting
// JSON.stringify's default toISOString() serialize it shifts the calendar
// date backward for any positive UTC offset (e.g. PKT). Format it off the
// local getters instead so "2026-09-08" round-trips as "2026-09-08".
function dstr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shapeCustomer(r) {
  return {
    id: r.id, code: r.code, name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone,
    customerType: r.customer_type, taxRegNo: r.tax_reg_no, paymentTerms: r.payment_terms, address: r.address,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    telephoneNumber: r.telephone_number, country: r.country, district: r.district, city: r.city,
    cnic: r.cnic, ntn: r.ntn, strn: r.strn, preferredCurrency: r.preferred_currency,
    bankName: r.bank_name, iban: r.iban, bankAddress: r.bank_address, bankAddress2: r.bank_address_2,
    bankAccountNumber: r.bank_account_number, accountType: r.account_type, branchCode: r.branch_code,
  };
}

/* ---------------- Customers ---------------- */
router.get('/customers', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM erp_crm_customers ORDER BY name ASC');
  res.json(rows.map(shapeCustomer));
});

// camelCase (request body) -> DB column, shared by create and update so
// the "Business Partner" onboarding fields are handled in exactly one
// place. name/phone/email/address/paymentTerms double as Business Partner
// Name/Mobile Number/Email/Address/Payment Terms on the form.
const CUSTOMER_FIELD_MAP = {
  code: 'code', name: 'name', contactPerson: 'contact_person', email: 'email', phone: 'phone',
  customerType: 'customer_type', taxRegNo: 'tax_reg_no', paymentTerms: 'payment_terms', address: 'address', status: 'status',
  telephoneNumber: 'telephone_number', country: 'country', district: 'district', city: 'city',
  cnic: 'cnic', ntn: 'ntn', strn: 'strn', preferredCurrency: 'preferred_currency',
  bankName: 'bank_name', iban: 'iban', bankAddress: 'bank_address', bankAddress2: 'bank_address_2',
  bankAccountNumber: 'bank_account_number', accountType: 'account_type', branchCode: 'branch_code',
};

router.post('/customers', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Business Partner Name is required.' });
  let code = String(req.body.code || '').trim();
  const cols = ['code', 'created_by']; const values = [code || `TEMP-${Date.now()}`, req.erpUser.id];
  for (const [k, col] of Object.entries(CUSTOMER_FIELD_MAP)) {
    if (k === 'code') continue;
    if (req.body[k] !== undefined) { cols.push(col); values.push(req.body[k] || null); }
  }
  if (!cols.includes('customer_type')) { cols.push('customer_type'); values.push('Customer'); }
  if (!cols.includes('status')) { cols.push('status'); values.push('Active'); }
  const [result] = await pool.query(
    `INSERT INTO erp_crm_customers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values
  );
  if (!code) {
    code = `CUST-${String(result.insertId).padStart(4, '0')}`;
    await pool.query('UPDATE erp_crm_customers SET code = ? WHERE id = ?', [code, result.insertId]);
  }
  const [rows] = await pool.query('SELECT * FROM erp_crm_customers WHERE id = ?', [result.insertId]);
  await audit(req.erpUser.employeeId, 'crm-customer-created', code);
  res.status(201).json(shapeCustomer(rows[0]));
});

router.put('/customers/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  for (const [k, col] of Object.entries(CUSTOMER_FIELD_MAP)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k] || null); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);
  const [result] = await pool.query(`UPDATE erp_crm_customers SET ${fields.join(', ')} WHERE id = ?`, values);
  if (!result.affectedRows) return res.status(404).json({ error: 'Customer not found.' });
  await audit(req.erpUser.employeeId, 'crm-customer-updated', String(req.params.id));
  res.json({ ok: true });
});

router.delete('/customers/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [rfqs] = await pool.query('SELECT COUNT(*) c FROM erp_crm_rfqs WHERE customer_id = ?', [req.params.id]);
  if (rfqs[0].c > 0) return res.status(409).json({ error: `This customer has ${rfqs[0].c} RFQ(s) on file — remove/reassign those first.` });
  const [result] = await pool.query('DELETE FROM erp_crm_customers WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Customer not found.' });
  await audit(req.erpUser.employeeId, 'crm-customer-deleted', String(req.params.id));
  res.json({ ok: true });
});

// Bulk delete — { ids: [...] } for a selection, or { all: true } for every
// customer on file. Same guard as the single DELETE above, applied per
// row so one customer with RFQs on file never blocks the rest of the batch.
router.delete('/customers', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  let ids;
  if (req.body && req.body.all === true) {
    const [rows] = await pool.query('SELECT id FROM erp_crm_customers');
    ids = rows.map((r) => r.id);
  } else {
    ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  }
  if (!ids.length) return res.status(400).json({ error: 'No customers selected.' });
  if (ids.length > 5000) return res.status(400).json({ error: 'Too many customers in one request (max 5000).' });

  let deleted = 0;
  const skipped = [];
  for (const id of ids) {
    const [rfqs] = await pool.query('SELECT COUNT(*) c FROM erp_crm_rfqs WHERE customer_id = ?', [id]);
    if (rfqs[0].c > 0) { skipped.push({ id, reason: `Has ${rfqs[0].c} RFQ(s) on file.` }); continue; }
    const [result] = await pool.query('DELETE FROM erp_crm_customers WHERE id = ?', [id]);
    if (result.affectedRows) deleted++; else skipped.push({ id, reason: 'Not found.' });
  }
  await audit(req.erpUser.employeeId, 'crm-customers-bulk-deleted', `deleted=${deleted} skipped=${skipped.length}`);
  res.json({ deleted, skipped });
});

// Bulk import — the simplest possible intake: just Name + Address per row
// (everything else — bank details, tax numbers, contact info — gets
// filled in later via Edit). No dedupe key like the Employees import has
// (no Emp Code equivalent here), so every row becomes a new customer.
router.post('/customers/import', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows in one import (max 5000).' });

  let created = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const name = String((rows[i] || {}).name || '').trim();
    const address = String((rows[i] || {}).address || '').trim();
    if (!name) { errors.push({ row: i + 1, message: 'Missing Name.' }); continue; }
    try {
      const [result] = await pool.query(
        'INSERT INTO erp_crm_customers (code, name, address, customer_type, status, created_by) VALUES (?,?,?,?,?,?)',
        [`TEMP-${Date.now()}-${i}`, name, address || null, 'Customer', 'Active', req.erpUser.id]
      );
      const code = `CUST-${String(result.insertId).padStart(4, '0')}`;
      await pool.query('UPDATE erp_crm_customers SET code = ? WHERE id = ?', [code, result.insertId]);
      created++;
    } catch (e) {
      errors.push({ row: i + 1, message: e.message });
    }
  }
  await audit(req.erpUser.employeeId, 'crm-customers-imported', `created=${created} errors=${errors.length}`);
  res.json({ created, errors });
});

/* ---------------- RFQs ---------------- */
const RFQ_SELECT = `
  SELECT r.*, c.name AS customer_name, c.code AS customer_code, e.full_name AS entered_by_name
  FROM erp_crm_rfqs r
  JOIN erp_crm_customers c ON c.id = r.customer_id
  LEFT JOIN employees e ON e.id = r.entered_by`;

function shapeAttachmentMeta(a) {
  return { id: a.id, fileName: a.file_name, mimeType: a.mime_type, fileSize: a.file_size, uploadedAt: a.uploaded_at };
}
function shapeRfq(r, items, attachments) {
  return {
    id: r.id, rfqNo: r.rfq_no, receivedDate: dstr(r.received_date), source: r.source,
    customerId: r.customer_id, customerName: r.customer_name, customerCode: r.customer_code,
    subject: r.subject, dueDate: dstr(r.due_date), status: r.status, notes: r.notes,
    enteredBy: r.entered_by, enteredByName: r.entered_by_name,
    createdAt: r.created_at, updatedAt: r.updated_at,
    items: (items || []).map((it) => ({ id: it.id, itemDesc: it.item_desc, qty: it.qty, unit: it.unit, spec: it.spec, scope: it.scope })),
    attachments: (attachments || []).map(shapeAttachmentMeta),
  };
}

// Groups arbitrary child rows (items, attachment metadata) keyed by rfq_id
// — one shared helper so both list and single-row endpoints fetch the
// same way.
async function fetchGrouped(table, columns, rfqIds) {
  if (!rfqIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT ${columns} FROM ${table} WHERE rfq_id IN (${rfqIds.map(() => '?').join(',')}) ORDER BY rfq_id, id`,
    rfqIds
  );
  const byRfq = new Map();
  for (const row of rows) { if (!byRfq.has(row.rfq_id)) byRfq.set(row.rfq_id, []); byRfq.get(row.rfq_id).push(row); }
  return byRfq;
}

router.get('/rfqs', async (req, res) => {
  const [rows] = await pool.query(`${RFQ_SELECT} ORDER BY r.received_date DESC, r.id DESC`);
  if (!rows.length) return res.json([]);
  const ids = rows.map((r) => r.id);
  const [items] = await pool.query(
    `SELECT * FROM erp_crm_rfq_items WHERE rfq_id IN (${ids.map(() => '?').join(',')}) ORDER BY rfq_id, sort_order`,
    ids
  );
  const itemsByRfq = new Map();
  for (const it of items) { if (!itemsByRfq.has(it.rfq_id)) itemsByRfq.set(it.rfq_id, []); itemsByRfq.get(it.rfq_id).push(it); }
  const attByRfq = await fetchGrouped('erp_crm_rfq_attachments', 'id, rfq_id, file_name, mime_type, file_size, uploaded_at', ids);
  res.json(rows.map((r) => shapeRfq(r, itemsByRfq.get(r.id), attByRfq.get(r.id))));
});

router.get('/rfqs/:id', async (req, res) => {
  const [rows] = await pool.query(`${RFQ_SELECT} WHERE r.id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'RFQ not found.' });
  const [items] = await pool.query('SELECT * FROM erp_crm_rfq_items WHERE rfq_id = ? ORDER BY sort_order', [req.params.id]);
  const [atts] = await pool.query('SELECT id, rfq_id, file_name, mime_type, file_size, uploaded_at FROM erp_crm_rfq_attachments WHERE rfq_id = ? ORDER BY id', [req.params.id]);
  res.json(shapeRfq(rows[0], items, atts));
});

async function saveRfqItems(rfqId, items) {
  await pool.query('DELETE FROM erp_crm_rfq_items WHERE rfq_id = ?', [rfqId]);
  const list = (Array.isArray(items) ? items : []).filter((it) => it && String(it.itemDesc || '').trim());
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const scope = it.scope === 'Out of Scope' ? 'Out of Scope' : 'Scope';
    await pool.query(
      'INSERT INTO erp_crm_rfq_items (rfq_id, sort_order, item_desc, qty, unit, spec, scope) VALUES (?,?,?,?,?,?,?)',
      [rfqId, i, String(it.itemDesc).trim(), it.qty || null, it.unit || null, it.spec || null, scope]
    );
  }
}

// files: multer's req.files (memory storage) — real multipart uploads, not
// base64-in-JSON (see the note by MAX_ATTACHMENT_BYTES above for why).
async function saveRfqAttachmentFiles(rfqId, files, uploadedBy) {
  const list = Array.isArray(files) ? files : [];
  for (const f of list) {
    await pool.query(
      'INSERT INTO erp_crm_rfq_attachments (rfq_id, file_name, mime_type, file_size, file_data, uploaded_by) VALUES (?,?,?,?,?,?)',
      [rfqId, f.originalname, f.mimetype || null, f.size, f.buffer, uploadedBy]
    );
  }
}

// Serial No. format "2026-27/001" — company financial year is July-June,
// so a date in Jul-Dec belongs to the FY starting that same calendar year,
// and a date in Jan-Jun belongs to the FY that started the previous July.
// The counter resets to 001 at the start of each new financial year (it's
// read off the highest existing serial already used for that FY, not a
// running COUNT(*), so a deleted RFQ in the middle of a year never causes
// a duplicate number to be re-issued).
function financialYearLabel(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  const startYear = m >= 7 ? y : y - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}
async function nextRfqSerial(dateStr) {
  const fyLabel = financialYearLabel(dateStr);
  const [rows] = await pool.query('SELECT rfq_no FROM erp_crm_rfqs WHERE rfq_no LIKE ?', [`${fyLabel}/%`]);
  let max = 0;
  for (const r of rows) {
    const m = String(r.rfq_no).match(/\/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${fyLabel}/${String(max + 1).padStart(3, '0')}`;
}

// One call creates the RFQ header AND its line items AND its attachments —
// multipart/form-data now (not JSON): text fields as usual, "items" as a
// JSON-stringified array field, files under the "attachments" field name.
router.post('/rfqs', upload.array('attachments', 10), handleUploadErrors, async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const customerId = +req.body.customerId;
  const receivedDate = String(req.body.receivedDate || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
  if (!receivedDate) return res.status(400).json({ error: 'Received date is required.' });
  const [cust] = await pool.query('SELECT id FROM erp_crm_customers WHERE id = ?', [customerId]);
  if (!cust.length) return res.status(400).json({ error: 'Selected customer was not found.' });

  let items = [];
  try { items = JSON.parse(req.body.items || '[]'); } catch (e) { return res.status(400).json({ error: 'Malformed items.' }); }

  const [result] = await pool.query(
    `INSERT INTO erp_crm_rfqs (received_date, source, customer_id, subject, due_date, status, notes, entered_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [receivedDate, req.body.source || 'Email', customerId, req.body.subject || null, req.body.dueDate || null,
     'Open', req.body.notes || null, req.erpUser.id]
  );
  const rfqNo = await nextRfqSerial(receivedDate);
  await pool.query('UPDATE erp_crm_rfqs SET rfq_no = ? WHERE id = ?', [rfqNo, result.insertId]);
  await saveRfqItems(result.insertId, items);
  await saveRfqAttachmentFiles(result.insertId, req.files, req.erpUser.id);

  const [rows] = await pool.query(`${RFQ_SELECT} WHERE r.id = ?`, [result.insertId]);
  const [savedItems] = await pool.query('SELECT * FROM erp_crm_rfq_items WHERE rfq_id = ? ORDER BY sort_order', [result.insertId]);
  const [atts] = await pool.query('SELECT id, rfq_id, file_name, mime_type, file_size, uploaded_at FROM erp_crm_rfq_attachments WHERE rfq_id = ? ORDER BY id', [result.insertId]);
  await audit(req.erpUser.employeeId, 'crm-rfq-created', rfqNo);
  res.status(201).json(shapeRfq(rows[0], savedItems, atts));
});

router.put('/rfqs/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  const map = {
    receivedDate: 'received_date', source: 'source', customerId: 'customer_id',
    subject: 'subject', dueDate: 'due_date', status: 'status', notes: 'notes',
  };
  for (const [k, col] of Object.entries(map)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k] || null); }
  }
  if (fields.length) {
    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE erp_crm_rfqs SET ${fields.join(', ')} WHERE id = ?`, values);
    if (!result.affectedRows) return res.status(404).json({ error: 'RFQ not found.' });
  }
  if (req.body.items !== undefined) await saveRfqItems(req.params.id, req.body.items);
  await audit(req.erpUser.employeeId, 'crm-rfq-updated', String(req.params.id));
  res.json({ ok: true });
});

// Attachments on an already-saved RFQ — uploaded/removed immediately
// (unlike a brand-new RFQ, where files ride along with the create above).
// Multipart/form-data, file(s) under field name "files".
router.post('/rfqs/:id/attachments', upload.array('files', 10), handleUploadErrors, async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [rfq] = await pool.query('SELECT id FROM erp_crm_rfqs WHERE id = ?', [req.params.id]);
  if (!rfq.length) return res.status(404).json({ error: 'RFQ not found.' });
  await saveRfqAttachmentFiles(req.params.id, req.files, req.erpUser.id);
  const [atts] = await pool.query('SELECT id, rfq_id, file_name, mime_type, file_size, uploaded_at FROM erp_crm_rfq_attachments WHERE rfq_id = ? ORDER BY id', [req.params.id]);
  await audit(req.erpUser.employeeId, 'crm-rfq-attachment-added', String(req.params.id));
  res.status(201).json(atts.map(shapeAttachmentMeta));
});

router.get('/rfqs/:id/attachments/:attId/download', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT file_name, mime_type, file_data FROM erp_crm_rfq_attachments WHERE id = ? AND rfq_id = ?',
    [req.params.attId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Attachment not found.' });
  const a = rows[0];
  // ?inline=1 lets the browser render it in a new tab (PDF viewer, image,
  // etc.) instead of forcing a save-to-disk — used by the RFQ View page's
  // "View" button; "Download" (no query param) keeps the old force-save.
  const disposition = req.query.inline ? 'inline' : 'attachment';
  res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${String(a.file_name).replace(/"/g, '')}"`);
  res.send(a.file_data);
});

router.delete('/rfqs/:id/attachments/:attId', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [result] = await pool.query('DELETE FROM erp_crm_rfq_attachments WHERE id = ? AND rfq_id = ?', [req.params.attId, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Attachment not found.' });
  await audit(req.erpUser.employeeId, 'crm-rfq-attachment-deleted', String(req.params.attId));
  res.json({ ok: true });
});

router.delete('/rfqs/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [result] = await pool.query('DELETE FROM erp_crm_rfqs WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'RFQ not found.' });
  await audit(req.erpUser.employeeId, 'crm-rfq-deleted', String(req.params.id));
  res.json({ ok: true });
});

/* ============================================================
   Service Catalogue reference data — Equipment -> Standards -> Item
   Descriptions. Imported from a spreadsheet with a distinctive layout
   (the company's own convention, colour-coded yellow/green/pink there):

     Drill Pipe,,,,,,                              <- Equipment name (own row)
     DS-1 Cat 5,DS-1 Cat 4,...,API RP 7G-2 - DP,,  <- one Standard per column
     I) Visual...,I) Visual...,...,I) Visual...    <- one Item Description
     ,,,,"MPI of End Areas...",,                      per column per row,
     ,,,,Visual Thread Inspection,,                    blank where a
                                                        column has no more
     <blank row = next Equipment block starts>          items on that row

   A block with only ONE populated Standard column (e.g. "Transportation"
   / "Tran" / a long single-column list) is just the general case with
   1 standard instead of many — no special-casing needed.
   ============================================================ */

// Collapses a value that may contain a literal newline (the sheet just
// word-wrapped a label) into one line, trimming stray whitespace.
function normCell(s) {
  return String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

// Full CSV text -> 2D array. Needs its own parser (not a per-line split)
// because real cells here contain literal newlines inside quotes.
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip — \n follows */ }
    else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// rows -> [{ name, standards: [{ name, items: [...] }] }]
function parseEquipmentCatalog(rows) {
  const isEmptyRow = (r) => !r || r.every((c) => !String(c || '').trim());
  const equipment = [];
  let i = 0;
  while (i < rows.length) {
    while (i < rows.length && isEmptyRow(rows[i])) i++;
    if (i >= rows.length) break;
    const equipName = normCell(rows[i].find((c) => String(c || '').trim()) || '');
    i++;
    if (i >= rows.length || isEmptyRow(rows[i])) { if (equipName) equipment.push({ name: equipName, standards: [] }); continue; }
    const standards = rows[i].map((s) => ({ name: normCell(s), items: [] }));
    i++;
    while (i < rows.length && !isEmptyRow(rows[i])) {
      const r = rows[i];
      for (let c = 0; c < standards.length; c++) {
        const val = normCell(r[c]);
        if (val && standards[c].name) standards[c].items.push(val);
      }
      i++;
    }
    if (equipName) equipment.push({ name: equipName, standards: standards.filter((s) => s.name) });
  }
  return equipment;
}

// Imports the CSV, merging into the reference tables — existing
// Equipment/Standard names are reused (not duplicated), and an Item
// Description already on file for a Standard is skipped, so re-uploading
// an updated version of the same sheet only adds what's new.
router.post('/equipment-catalog/import', upload.single('file'), handleUploadErrors, async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const catalog = parseEquipmentCatalog(parseCsvText(req.file.buffer.toString('utf8')));
  if (!catalog.length) return res.status(400).json({ error: 'Could not find any Equipment blocks in this file.' });

  const [existingEquip] = await pool.query('SELECT id, name FROM erp_crm_equipment');
  const equipByName = new Map(existingEquip.map((e) => [e.name.toLowerCase(), e.id]));
  const [existingStd] = await pool.query('SELECT id, equipment_id, name FROM erp_crm_standards');
  const stdByKey = new Map(existingStd.map((s) => [s.equipment_id + '|' + s.name.toLowerCase(), s.id]));
  const [existingItems] = await pool.query('SELECT standard_id, description FROM erp_crm_item_descriptions');
  const itemSeen = new Set(existingItems.map((it) => it.standard_id + '|' + it.description));

  let equipmentAdded = 0, standardsAdded = 0, itemsAdded = 0;
  for (const e of catalog) {
    let equipId = equipByName.get(e.name.toLowerCase());
    if (!equipId) {
      const [r] = await pool.query('INSERT INTO erp_crm_equipment (name) VALUES (?)', [e.name]);
      equipId = r.insertId; equipByName.set(e.name.toLowerCase(), equipId); equipmentAdded++;
    }
    for (const s of e.standards) {
      const stdKey = equipId + '|' + s.name.toLowerCase();
      let stdId = stdByKey.get(stdKey);
      if (!stdId) {
        const [r] = await pool.query('INSERT INTO erp_crm_standards (equipment_id, name) VALUES (?,?)', [equipId, s.name]);
        stdId = r.insertId; stdByKey.set(stdKey, stdId); standardsAdded++;
      }
      for (const desc of s.items) {
        const itemKey = stdId + '|' + desc;
        if (itemSeen.has(itemKey)) continue;
        await pool.query('INSERT INTO erp_crm_item_descriptions (standard_id, description) VALUES (?,?)', [stdId, desc]);
        itemSeen.add(itemKey); itemsAdded++;
      }
    }
  }
  await audit(req.erpUser.employeeId, 'crm-equipment-catalog-imported', `equip+${equipmentAdded} std+${standardsAdded} items+${itemsAdded}`);
  res.json({ equipmentAdded, standardsAdded, itemsAdded, equipmentInFile: catalog.length });
});

// One call, all three levels — small enough dataset that the cascading
// Equipment -> Standard -> Item Description dropdowns just filter this
// client-side rather than round-tripping per selection.
router.get('/equipment-catalog', async (req, res) => {
  const [equipment] = await pool.query('SELECT id, name FROM erp_crm_equipment ORDER BY name');
  const [standards] = await pool.query('SELECT id, equipment_id, name FROM erp_crm_standards ORDER BY name');
  const [items] = await pool.query('SELECT id, standard_id, description FROM erp_crm_item_descriptions ORDER BY description');
  res.json({
    equipment: equipment.map((e) => ({ id: e.id, name: e.name })),
    standards: standards.map((s) => ({ id: s.id, equipmentId: s.equipment_id, name: s.name })),
    itemDescriptions: items.map((it) => ({ id: it.id, standardId: it.standard_id, description: it.description })),
  });
});

// Manual "+ Add new" for each level — same three tables the CSV import
// writes to, so a manually-added Equipment/Standard/Item Description
// shows up identically in the cascading dropdowns.
router.post('/equipment', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const name = normCell(req.body.name);
  if (!name) return res.status(400).json({ error: 'Equipment name is required.' });
  const [existing] = await pool.query('SELECT id FROM erp_crm_equipment WHERE name = ?', [name]);
  if (existing.length) return res.json({ id: existing[0].id, name });
  const [r] = await pool.query('INSERT INTO erp_crm_equipment (name) VALUES (?)', [name]);
  res.status(201).json({ id: r.insertId, name });
});
router.post('/standards', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const equipmentId = +req.body.equipmentId;
  const name = normCell(req.body.name);
  if (!equipmentId) return res.status(400).json({ error: 'Equipment is required.' });
  if (!name) return res.status(400).json({ error: 'Standard name is required.' });
  const [existing] = await pool.query('SELECT id FROM erp_crm_standards WHERE equipment_id = ? AND name = ?', [equipmentId, name]);
  if (existing.length) return res.json({ id: existing[0].id, equipmentId, name });
  const [r] = await pool.query('INSERT INTO erp_crm_standards (equipment_id, name) VALUES (?,?)', [equipmentId, name]);
  res.status(201).json({ id: r.insertId, equipmentId, name });
});
router.post('/item-descriptions', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const standardId = +req.body.standardId;
  const description = normCell(req.body.description);
  if (!standardId) return res.status(400).json({ error: 'Standard is required.' });
  if (!description) return res.status(400).json({ error: 'Item description is required.' });
  const [r] = await pool.query('INSERT INTO erp_crm_item_descriptions (standard_id, description) VALUES (?,?)', [standardId, description]);
  res.status(201).json({ id: r.insertId, standardId, description });
});

/* ---------------- Service Catalogue ---------------- */
const SVC_SELECT = `
  SELECT sv.*, eq.name AS equipment_name, st.name AS standard_name, it.description AS item_description
  FROM erp_crm_services sv
  LEFT JOIN erp_crm_equipment eq ON eq.id = sv.equipment_id
  LEFT JOIN erp_crm_standards st ON st.id = sv.standard_id
  LEFT JOIN erp_crm_item_descriptions it ON it.id = sv.item_description_id`;
function shapeService(r) {
  return {
    id: r.id, code: r.code, equipmentId: r.equipment_id, equipmentName: r.equipment_name,
    standardId: r.standard_id, standardName: r.standard_name,
    itemDescriptionId: r.item_description_id, itemDescription: r.item_description,
    uom: r.uom, standardRate: r.standard_rate, currency: r.currency, minQty: r.min_qty,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
router.get('/services', async (req, res) => {
  const [rows] = await pool.query(`${SVC_SELECT} ORDER BY sv.id DESC`);
  res.json(rows.map(shapeService));
});
const SERVICE_FIELD_MAP = {
  equipmentId: 'equipment_id', standardId: 'standard_id', itemDescriptionId: 'item_description_id',
  uom: 'uom', standardRate: 'standard_rate', currency: 'currency', minQty: 'min_qty', status: 'status',
};
router.post('/services', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  let code = String(req.body.code || '').trim();
  const cols = ['code', 'created_by']; const values = [code || `TEMP-${Date.now()}`, req.erpUser.id];
  for (const [k, col] of Object.entries(SERVICE_FIELD_MAP)) {
    if (req.body[k] !== undefined) { cols.push(col); values.push(req.body[k] || null); }
  }
  if (!cols.includes('status')) { cols.push('status'); values.push('Active'); }
  const [result] = await pool.query(`INSERT INTO erp_crm_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
  if (!code) {
    code = `SVC-${String(result.insertId).padStart(4, '0')}`;
    await pool.query('UPDATE erp_crm_services SET code = ? WHERE id = ?', [code, result.insertId]);
  }
  const [rows] = await pool.query(`${SVC_SELECT} WHERE sv.id = ?`, [result.insertId]);
  await audit(req.erpUser.employeeId, 'crm-service-created', code);
  res.status(201).json(shapeService(rows[0]));
});
router.put('/services/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  const map = { code: 'code', ...SERVICE_FIELD_MAP };
  for (const [k, col] of Object.entries(map)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k] || null); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.params.id);
  const [result] = await pool.query(`UPDATE erp_crm_services SET ${fields.join(', ')} WHERE id = ?`, values);
  if (!result.affectedRows) return res.status(404).json({ error: 'Service not found.' });
  await audit(req.erpUser.employeeId, 'crm-service-updated', String(req.params.id));
  res.json({ ok: true });
});
router.delete('/services/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [result] = await pool.query('DELETE FROM erp_crm_services WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Service not found.' });
  await audit(req.erpUser.employeeId, 'crm-service-deleted', String(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
