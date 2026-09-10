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
function shapeRfq(r, items, attachments, quotations) {
  return {
    id: r.id, rfqNo: r.rfq_no, receivedDate: dstr(r.received_date), source: r.source,
    customerId: r.customer_id, customerName: r.customer_name, customerCode: r.customer_code,
    subject: r.subject, dueDate: dstr(r.due_date), status: r.status, notes: r.notes,
    enteredBy: r.entered_by, enteredByName: r.entered_by_name,
    createdAt: r.created_at, updatedAt: r.updated_at,
    items: (items || []).map((it) => ({ id: it.id, itemDesc: it.item_desc, qty: it.qty, unit: it.unit, spec: it.spec, scope: it.scope })),
    attachments: (attachments || []).map(shapeAttachmentMeta),
    quotations: (quotations || []).map((q) => ({ id: q.id, quotationNo: q.quotation_no, revision: q.revision, status: q.status })),
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
  const [rows] = await pool.query(`${RFQ_SELECT} WHERE r.deleted_at IS NULL ORDER BY r.received_date DESC, r.id DESC`);
  if (!rows.length) return res.json([]);
  const ids = rows.map((r) => r.id);
  const [items] = await pool.query(
    `SELECT * FROM erp_crm_rfq_items WHERE rfq_id IN (${ids.map(() => '?').join(',')}) ORDER BY rfq_id, sort_order`,
    ids
  );
  const itemsByRfq = new Map();
  for (const it of items) { if (!itemsByRfq.has(it.rfq_id)) itemsByRfq.set(it.rfq_id, []); itemsByRfq.get(it.rfq_id).push(it); }
  const attByRfq = await fetchGrouped('erp_crm_rfq_attachments', 'id, rfq_id, file_name, mime_type, file_size, uploaded_at', ids);
  const qtnByRfq = await fetchGrouped('erp_crm_quotations', 'id, rfq_id, quotation_no, revision, status', ids);
  res.json(rows.map((r) => shapeRfq(r, itemsByRfq.get(r.id), attByRfq.get(r.id), qtnByRfq.get(r.id))));
});

router.get('/rfqs/:id', async (req, res) => {
  const [rows] = await pool.query(`${RFQ_SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'RFQ not found.' });
  const [items] = await pool.query('SELECT * FROM erp_crm_rfq_items WHERE rfq_id = ? ORDER BY sort_order', [req.params.id]);
  const [atts] = await pool.query('SELECT id, rfq_id, file_name, mime_type, file_size, uploaded_at FROM erp_crm_rfq_attachments WHERE rfq_id = ? ORDER BY id', [req.params.id]);
  const [qtns] = await pool.query('SELECT id, rfq_id, quotation_no, revision, status FROM erp_crm_quotations WHERE rfq_id = ? ORDER BY id', [req.params.id]);
  res.json(shapeRfq(rows[0], items, atts, qtns));
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
  const [rows] = await pool.query('SELECT id FROM erp_crm_rfqs WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'RFQ not found.' });
  await softDeleteRfqUnit(+req.params.id, req.erpUser.employeeId); // also recycles its linked quotation(s)
  res.json({ ok: true, recycled: true });
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

/* ---------------- Quotations (always against an RFQ) ---------------- */
// Single shared Quotation terms block — edited once (rich HTML), used on
// every quotation PDF (pages 4-5 in the paper document). This is the
// best-effort seed; VERIFY against the authoritative wording.
const DEFAULT_TERMS_HTML =
  '<p><b>General Terms and Conditions</b></p>' +
  '<p>PTIS will issue invoice after the completion of job attached with all supporting documentation and delivery notes and will submit to the finance department.</p>' +
  '<p>All payments to PTIS shall be made by direct transfer within 15 days from the day of the submission of all invoices.</p>' +
  "<p>Client shall provide PTIS team with accommodation and meals, which shall be of the standard as applicable to customer's own senior staff.</p>" +
  '<p>Proof loads, Crane, Fork lifter and other accessories for load testing, Pipe racks, handling and dope to be supplied by the client.</p>' +
  '<p>Client to support our services by providing Forklift, air pump and power supply for onsite jobs.</p>' +
  '<p>PTIS shall provide two signed and stamped original hard copies of the inspection report upon completion of the job.</p>' +
  '<p>Client must give a minimum notice of 24 hours before the start of the job.</p>' +
  '<p>Day is considered as maximum of 10 working hours.</p>' +
  '<p>General Sales Tax shall be added on top of the invoice amount (as all prices are exclusive of GST).</p>' +
  '<p>All Covid-19 Protocols shall be adhered to as per the client policy but any charges shall be charged back to the client At Actual along with proof.</p>' +
  '<p><b>Removal of Equipment / Grease</b></p>' +
  '<p>The client is responsible for safely disassembling or removing any equipment, grease, or unwanted compounds that are attached to the equipment or plant that requires calibration.</p>' +
  '<p>The client should ensure that the equipment is in a safe and suitable condition for calibration, including ensuring that all relevant accessories or attachments are in place.</p>' +
  '<p><b>Functional Testing</b></p>' +
  "<p>Prior to calibration, the PTIS calibration team will conduct a functional test of the equipment in the presence of the client's representative.</p>" +
  '<p>The purpose of this test is to ensure that the equipment is in working order and its functional / operating parameters are within the standard for testing and measurement.</p>' +
  '<p>Any discrepancies or issues identified during the functional testing will be reported to the client for necessary corrective actions.</p>';

async function getCrmConfig() {
  const [rows] = await pool.query('SELECT last_client_ref, quotation_terms_html FROM erp_crm_config WHERE id = 1');
  const row = rows[0] || {};
  return {
    lastClientRef: row.last_client_ref || '',
    quotationTermsHtml: row.quotation_terms_html || DEFAULT_TERMS_HTML,
  };
}
// "FOT-100926-1190" -> "FOT-100926-1191" (increments the trailing number,
// keeps its digit width). Returns '' if there's no trailing number.
function nextClientRef(prev) {
  const s = String(prev || '').trim();
  const m = s.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return '';
  const width = m[2].length;
  return m[1] + String(parseInt(m[2], 10) + 1).padStart(width, '0') + m[3];
}

async function nextQuotationSerial(dateStr) {
  const fyLabel = financialYearLabel(dateStr);
  const [rows] = await pool.query("SELECT quotation_no FROM erp_crm_quotations WHERE quotation_no LIKE ?", [`QTN-${fyLabel}/%`]);
  let max = 0;
  for (const r of rows) {
    const m = String(r.quotation_no).match(/\/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `QTN-${fyLabel}/${String(max + 1).padStart(3, '0')}`;
}

const QTN_SELECT = `
  SELECT q.*, r.rfq_no, r.subject AS rfq_subject, r.deleted_at AS rfq_deleted_at,
         c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
         c.address AS customer_address, c.city AS customer_city, c.country AS customer_country,
         c.contact_person AS customer_contact,
         e.full_name AS created_by_name
  FROM erp_crm_quotations q
  JOIN erp_crm_rfqs r ON r.id = q.rfq_id
  JOIN erp_crm_customers c ON c.id = r.customer_id
  LEFT JOIN employees e ON e.id = q.created_by`;

function shapeQuotationItem(it) {
  const qty = it.qty == null ? null : Number(it.qty);
  const rate = it.rate == null ? null : Number(it.rate);
  return {
    id: it.id, equipmentId: it.equipment_id, standardId: it.standard_id, itemDescriptionId: it.item_description_id,
    equipmentName: it.equipment_name || null, standardName: it.standard_name || null, itemDescription: it.item_description || null,
    size: it.size, unit: it.unit, qty, rate, spec: it.spec || null, scope: it.scope || null,
    total: qty != null && rate != null ? +(qty * rate).toFixed(2) : null,
  };
}
function shapeQuotation(q, items) {
  const shapedItems = (items || []).map(shapeQuotationItem);
  const totalCost = shapedItems.reduce((s, it) => s + (it.total || 0), 0);
  const srbPercent = Number(q.srb_percent);
  const srbAmount = +(totalCost * srbPercent / 100).toFixed(2);
  return {
    id: q.id, quotationNo: q.quotation_no, rfqId: q.rfq_id, rfqNo: q.rfq_no, rfqSubject: q.rfq_subject,
    revision: q.revision, quotationDate: dstr(q.quotation_date), serviceType: q.service_type,
    clientReferenceNo: q.client_reference_no, attentionName: q.attention_name, subject: q.subject,
    currency: q.currency, srbPercent, status: q.status,
    customerId: q.customer_id, customerName: q.customer_name, customerCode: q.customer_code,
    customerAddress: q.customer_address, customerCity: q.customer_city, customerCountry: q.customer_country,
    customerContact: q.customer_contact,
    createdBy: q.created_by, createdByName: q.created_by_name, createdAt: q.created_at, updatedAt: q.updated_at,
    items: shapedItems,
    totalCost: +totalCost.toFixed(2), srbAmount, grandTotal: +(totalCost + srbAmount).toFixed(2),
  };
}

async function fetchQuotationItems(quotationId) {
  const [rows] = await pool.query(
    `SELECT qi.*, eq.name AS equipment_name, st.name AS standard_name, it.description AS item_description
     FROM erp_crm_quotation_items qi
     LEFT JOIN erp_crm_equipment eq ON eq.id = qi.equipment_id
     LEFT JOIN erp_crm_standards st ON st.id = qi.standard_id
     LEFT JOIN erp_crm_item_descriptions it ON it.id = qi.item_description_id
     WHERE qi.quotation_id = ? ORDER BY qi.sort_order`,
    [quotationId]
  );
  return rows;
}
function normScope(s) { return s === 'Out of Scope' ? 'Out of Scope' : 'Scope'; }
async function saveQuotationItems(quotationId, items) {
  await pool.query('DELETE FROM erp_crm_quotation_items WHERE quotation_id = ?', [quotationId]);
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    if (!it.equipmentId && !it.standardId && !it.itemDescriptionId && !it.size && it.qty == null && it.rate == null && !it.spec) continue;
    await pool.query(
      `INSERT INTO erp_crm_quotation_items (quotation_id, sort_order, equipment_id, standard_id, item_description_id, size, unit, qty, rate, spec, scope)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [quotationId, i, it.equipmentId || null, it.standardId || null, it.itemDescriptionId || null,
       it.size || null, it.unit || null, it.qty === '' || it.qty == null ? null : it.qty,
       it.rate === '' || it.rate == null ? null : it.rate, it.spec || null, normScope(it.scope)]
    );
  }
}
// RFQ items are derived from the quotation's line items (one modal now).
async function rfqItemsFromQuotationItems(items) {
  const list = Array.isArray(items) ? items : [];
  const idIds = [...new Set(list.map((it) => +it.itemDescriptionId).filter(Boolean))];
  const descById = new Map();
  if (idIds.length) {
    const [rows] = await pool.query(`SELECT id, description FROM erp_crm_item_descriptions WHERE id IN (${idIds.map(() => '?').join(',')})`, idIds);
    for (const r of rows) descById.set(r.id, r.description);
  }
  return list
    .map((it) => ({
      itemDesc: descById.get(+it.itemDescriptionId) || it.spec || it.size || '',
      qty: it.qty, unit: it.unit, spec: it.spec || null, scope: normScope(it.scope),
    }))
    .filter((it) => String(it.itemDesc || '').trim());
}

// Combined "RFQ + Quotation" create — one modal submit, two linked
// records. multipart/form-data (so the RFQ can still carry attachment
// files); rfqItems / quotationItems come in as JSON-string fields.
router.post('/rfq-quotation', upload.array('attachments', 10), handleUploadErrors, async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const b = req.body;
  const customerId = +b.customerId;
  const receivedDate = String(b.receivedDate || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
  if (!receivedDate) return res.status(400).json({ error: 'RFQ-Quotation Date is required.' });
  const [cust] = await pool.query('SELECT id FROM erp_crm_customers WHERE id = ?', [customerId]);
  if (!cust.length) return res.status(400).json({ error: 'Selected customer was not found.' });

  let quotationItems = [];
  try { quotationItems = JSON.parse(b.quotationItems || '[]'); } catch (e) { return res.status(400).json({ error: 'Malformed quotation items.' }); }

  // Client Reference No. — auto-numbered off the running counter unless
  // one was typed in.
  const cfg = await getCrmConfig();
  let clientRef = String(b.clientReferenceNo || '').trim();
  if (!clientRef) clientRef = nextClientRef(cfg.lastClientRef) || null;
  if (clientRef) await pool.query('UPDATE erp_crm_config SET last_client_ref = ? WHERE id = 1', [clientRef]);

  // 1) RFQ — its line items are derived from the quotation's line items.
  const [rfqRes] = await pool.query(
    `INSERT INTO erp_crm_rfqs (received_date, source, customer_id, subject, status, notes, entered_by)
     VALUES (?,?,?,?,?,?,?)`,
    [receivedDate, b.source || 'Email', customerId, b.subject || null, 'Open', b.notes || null, req.erpUser.id]
  );
  const rfqId = rfqRes.insertId;
  const rfqNo = await nextRfqSerial(receivedDate);
  await pool.query('UPDATE erp_crm_rfqs SET rfq_no = ? WHERE id = ?', [rfqNo, rfqId]);
  await saveRfqItems(rfqId, await rfqItemsFromQuotationItems(quotationItems));
  await saveRfqAttachmentFiles(rfqId, req.files, req.erpUser.id);

  // 2) Quotation, linked to that RFQ
  const quotationDate = String(b.quotationDate || receivedDate).trim();
  const [qtnRes] = await pool.query(
    `INSERT INTO erp_crm_quotations
       (rfq_id, revision, quotation_date, service_type, client_reference_no, attention_name, subject, currency, srb_percent, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [rfqId, 0, quotationDate, b.serviceType || null, clientRef, b.attentionName || null,
     b.subject || null, b.currency || 'PKR',
     b.srbPercent === undefined || b.srbPercent === '' ? 15 : b.srbPercent, 'Draft', req.erpUser.id]
  );
  const quotationId = qtnRes.insertId;
  const quotationNo = await nextQuotationSerial(quotationDate);
  await pool.query('UPDATE erp_crm_quotations SET quotation_no = ? WHERE id = ?', [quotationNo, quotationId]);
  await saveQuotationItems(quotationId, quotationItems);

  await audit(req.erpUser.employeeId, 'crm-rfq-quotation-created', `${rfqNo} + ${quotationNo}`);
  const [qrows] = await pool.query(`${QTN_SELECT} WHERE q.id = ?`, [quotationId]);
  res.status(201).json({
    rfq: { id: rfqId, rfqNo },
    quotation: { ...shapeQuotation(qrows[0], await fetchQuotationItems(quotationId)), termsHtml: cfg.quotationTermsHtml },
  });
});

router.get('/quotations', async (req, res) => {
  const [rows] = await pool.query(`${QTN_SELECT} WHERE q.deleted_at IS NULL ORDER BY q.id DESC`);
  if (!rows.length) return res.json([]);
  const ids = rows.map((r) => r.id);
  const [items] = await pool.query(
    `SELECT qi.*, eq.name AS equipment_name, st.name AS standard_name, it.description AS item_description
     FROM erp_crm_quotation_items qi
     LEFT JOIN erp_crm_equipment eq ON eq.id = qi.equipment_id
     LEFT JOIN erp_crm_standards st ON st.id = qi.standard_id
     LEFT JOIN erp_crm_item_descriptions it ON it.id = qi.item_description_id
     WHERE qi.quotation_id IN (${ids.map(() => '?').join(',')}) ORDER BY qi.quotation_id, qi.sort_order`,
    ids
  );
  const byQtn = new Map();
  for (const it of items) { if (!byQtn.has(it.quotation_id)) byQtn.set(it.quotation_id, []); byQtn.get(it.quotation_id).push(it); }
  res.json(rows.map((q) => shapeQuotation(q, byQtn.get(q.id))));
});

router.get('/quotations/:id', async (req, res) => {
  const [rows] = await pool.query(`${QTN_SELECT} WHERE q.id = ? AND q.deleted_at IS NULL`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Quotation not found.' });
  const cfg = await getCrmConfig();
  res.json({ ...shapeQuotation(rows[0], await fetchQuotationItems(req.params.id)), termsHtml: cfg.quotationTermsHtml });
});

const QUOTATION_FIELD_MAP = {
  quotationDate: 'quotation_date', serviceType: 'service_type', clientReferenceNo: 'client_reference_no',
  attentionName: 'attention_name', subject: 'subject', currency: 'currency', srbPercent: 'srb_percent',
  status: 'status', revision: 'revision',
};
router.put('/quotations/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  for (const [k, col] of Object.entries(QUOTATION_FIELD_MAP)) {
    if (req.body[k] !== undefined) { fields.push(`${col} = ?`); values.push(req.body[k] === '' ? null : req.body[k]); }
  }
  if (fields.length) {
    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE erp_crm_quotations SET ${fields.join(', ')} WHERE id = ?`, values);
    if (!result.affectedRows) return res.status(404).json({ error: 'Quotation not found.' });
  }
  if (req.body.items !== undefined) {
    await saveQuotationItems(req.params.id, req.body.items);
    // keep the linked RFQ's items mirrored
    const [qr] = await pool.query('SELECT rfq_id FROM erp_crm_quotations WHERE id = ?', [req.params.id]);
    if (qr.length) await saveRfqItems(qr[0].rfq_id, await rfqItemsFromQuotationItems(req.body.items));
  }
  await audit(req.erpUser.employeeId, 'crm-quotation-updated', String(req.params.id));
  res.json({ ok: true });
});

// Deleting either side sends the whole RFQ+Quotation unit to the Recycle
// Bin (soft delete) — never a hard delete from here.
async function softDeleteRfqUnit(rfqId, employeeId) {
  await pool.query('UPDATE erp_crm_rfqs SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL', [rfqId]);
  await pool.query('UPDATE erp_crm_quotations SET deleted_at = NOW() WHERE rfq_id = ? AND deleted_at IS NULL', [rfqId]);
  await audit(employeeId, 'crm-rfq-unit-recycled', String(rfqId));
}
router.delete('/quotations/:id', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [rows] = await pool.query('SELECT rfq_id FROM erp_crm_quotations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Quotation not found.' });
  await softDeleteRfqUnit(rows[0].rfq_id, req.erpUser.employeeId);
  res.json({ ok: true, recycled: true });
});

/* ---------------- CRM config (Client Ref counter + shared terms) ---------------- */
router.get('/config', async (req, res) => {
  res.json(await getCrmConfig());
});
router.put('/config', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const fields = []; const values = [];
  if (req.body.lastClientRef !== undefined) { fields.push('last_client_ref = ?'); values.push(String(req.body.lastClientRef || '').trim() || null); }
  if (req.body.quotationTermsHtml !== undefined) { fields.push('quotation_terms_html = ?'); values.push(req.body.quotationTermsHtml || null); }
  if (fields.length) await pool.query(`UPDATE erp_crm_config SET ${fields.join(', ')} WHERE id = 1`, values);
  await audit(req.erpUser.employeeId, 'crm-config-updated', fields.join(','));
  res.json(await getCrmConfig());
});

/* ---------------- Recycle Bin (soft-deleted RFQ + Quotation units) ---------------- */
router.get('/recycle-bin', async (req, res) => {
  const [rfqs] = await pool.query(
    `SELECT r.id, r.rfq_no, r.subject, r.received_date, r.deleted_at, c.name AS customer_name
     FROM erp_crm_rfqs r JOIN erp_crm_customers c ON c.id = r.customer_id
     WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC`
  );
  if (!rfqs.length) return res.json([]);
  const ids = rfqs.map((r) => r.id);
  const [qtns] = await pool.query(
    `SELECT id, rfq_id, quotation_no, status FROM erp_crm_quotations WHERE rfq_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const byRfq = new Map();
  for (const q of qtns) { if (!byRfq.has(q.rfq_id)) byRfq.set(q.rfq_id, []); byRfq.get(q.rfq_id).push({ id: q.id, quotationNo: q.quotation_no, status: q.status }); }
  res.json(rfqs.map((r) => ({
    rfqId: r.id, rfqNo: r.rfq_no, subject: r.subject, receivedDate: dstr(r.received_date),
    deletedAt: r.deleted_at, customerName: r.customer_name, quotations: byRfq.get(r.id) || [],
  })));
});
router.post('/recycle-bin/restore', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const rfqId = +req.body.rfqId;
  if (!rfqId) return res.status(400).json({ error: 'rfqId is required.' });
  await pool.query('UPDATE erp_crm_rfqs SET deleted_at = NULL WHERE id = ?', [rfqId]);
  await pool.query('UPDATE erp_crm_quotations SET deleted_at = NULL WHERE rfq_id = ?', [rfqId]);
  await audit(req.erpUser.employeeId, 'crm-rfq-unit-restored', String(rfqId));
  res.json({ ok: true });
});
router.delete('/recycle-bin/:rfqId', async (req, res) => {
  if (req.erpUser.role === 'Viewer') return res.status(403).json({ error: 'Viewer accounts are read-only.' });
  const [r] = await pool.query('SELECT id FROM erp_crm_rfqs WHERE id = ? AND deleted_at IS NOT NULL', [req.params.rfqId]);
  if (!r.length) return res.status(404).json({ error: 'Not in the Recycle Bin.' });
  await pool.query('DELETE FROM erp_crm_rfqs WHERE id = ?', [req.params.rfqId]); // FK cascade removes quotations/items/attachments
  await audit(req.erpUser.employeeId, 'crm-rfq-unit-purged', String(req.params.rfqId));
  res.json({ ok: true });
});

module.exports = router;
