/* ============================================================
   Employee Loans (erp_employee_loans + erp_loan_payments) — HR records a
   loan (principal + fixed monthly deduction); payments (the regular monthly
   deduction, or a one-off extra payment/waiver) are logged against it.
   Remaining balance is always computed as principal - SUM(payments), never
   stored redundantly, so it can never drift out of sync with the ledger.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_TYPES = ['Monthly', 'Extra', 'Waiver'];

function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}
function canView(req, employeeId) {
  return employeeId === req.erpUser.id || canAccess(req.erpUser.role, 'Human Resources');
}

async function shapeLoan(loan) {
  const [payments] = await pool.query(
    'SELECT id, amount, payment_type, payment_date, notes, created_at FROM erp_loan_payments WHERE loan_id = ? ORDER BY payment_date ASC, id ASC',
    [loan.id]
  );
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const remaining = Math.max(Number(loan.principal_amount) - totalPaid, 0);
  const monthsPaid = loan.monthly_deduction > 0 ? Math.floor(totalPaid / Number(loan.monthly_deduction)) : 0;
  const monthsRemaining = loan.monthly_deduction > 0 ? Math.ceil(remaining / Number(loan.monthly_deduction)) : null;
  return {
    id: loan.id, employeeId: loan.employee_id,
    principalAmount: Number(loan.principal_amount), monthlyDeduction: Number(loan.monthly_deduction),
    currency: loan.currency, notes: loan.notes, status: loan.status,
    createdAt: loan.created_at, closedAt: loan.closed_at,
    totalPaid, remaining, monthsPaid, monthsRemaining,
    payments: payments.map((p) => ({ id: p.id, amount: Number(p.amount), type: p.payment_type, date: p.payment_date, notes: p.notes, createdAt: p.created_at })),
  };
}

// GET /api/loans/:employeeId — every loan (Active + Closed) for one
// employee, each with its full payment ledger. Self, or HR.
router.get('/:employeeId', async (req, res) => {
  const employeeId = +req.params.employeeId;
  if (!canView(req, employeeId)) return res.status(403).json({ error: 'You cannot view this.' });
  const [loans] = await pool.query('SELECT * FROM erp_employee_loans WHERE employee_id = ? ORDER BY created_at DESC', [employeeId]);
  res.json(await Promise.all(loans.map(shapeLoan)));
});

// POST /api/loans  { employeeId, principalAmount, monthlyDeduction, currency, notes }
// HR only. Refuses a second loan while one is still Active — pay off (or
// waive) the existing one first, keeps the ledger unambiguous.
router.post('/', requireHr, async (req, res) => {
  const { employeeId, principalAmount, monthlyDeduction, currency, notes } = req.body || {};
  const empId = +employeeId;
  if (!Number.isFinite(empId)) return res.status(400).json({ error: 'Invalid employee.' });
  if (!(Number(principalAmount) > 0)) return res.status(400).json({ error: 'Principal amount must be greater than 0.' });
  if (!(Number(monthlyDeduction) > 0)) return res.status(400).json({ error: 'Monthly deduction must be greater than 0.' });
  const [active] = await pool.query("SELECT id FROM erp_employee_loans WHERE employee_id = ? AND status = 'Active'", [empId]);
  if (active.length) return res.status(409).json({ error: 'This employee already has an active loan — settle or waive it before adding a new one.' });
  const [emp] = await pool.query('SELECT id FROM employees WHERE id = ?', [empId]);
  if (!emp.length) return res.status(404).json({ error: 'Employee not found.' });
  const [result] = await pool.query(
    'INSERT INTO erp_employee_loans (employee_id, principal_amount, monthly_deduction, currency, notes, created_by) VALUES (?,?,?,?,?,?)',
    [empId, Number(principalAmount), Number(monthlyDeduction), currency || 'AED', notes || null, req.erpUser.id]
  );
  await audit(req.erpUser.employeeId, 'loan-created', `employee ${empId}, ${principalAmount} ${currency || 'AED'}`);
  const [rows] = await pool.query('SELECT * FROM erp_employee_loans WHERE id = ?', [result.insertId]);
  res.status(201).json(await shapeLoan(rows[0]));
});

// POST /api/loans/:loanId/payments  { amount, type, date, notes }
// HR only. type: Monthly (the regular deduction) / Extra (early paydown) /
// Waiver (writes off part or all of the remaining balance without the
// employee having paid it — e.g. a goodwill gesture). Auto-closes the loan
// once the running balance hits 0.
router.post('/:loanId/payments', requireHr, async (req, res) => {
  const loanId = +req.params.loanId;
  const { amount, type, date, notes } = req.body || {};
  if (!(Number(amount) > 0)) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!PAYMENT_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${PAYMENT_TYPES.join(', ')}.` });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
  const [loans] = await pool.query('SELECT * FROM erp_employee_loans WHERE id = ?', [loanId]);
  if (!loans.length) return res.status(404).json({ error: 'Loan not found.' });
  const loan = loans[0];
  if (loan.status !== 'Active') return res.status(400).json({ error: 'This loan is already closed.' });
  await pool.query(
    'INSERT INTO erp_loan_payments (loan_id, amount, payment_type, payment_date, notes, created_by) VALUES (?,?,?,?,?,?)',
    [loanId, Number(amount), type, date, notes || null, req.erpUser.id]
  );
  const shaped = await shapeLoan(loan); // re-queries payments, so this already reflects the row just inserted
  if (shaped.remaining <= 0) {
    await pool.query("UPDATE erp_employee_loans SET status = 'Closed', closed_at = NOW() WHERE id = ?", [loanId]);
  }
  await audit(req.erpUser.employeeId, 'loan-payment', `loan ${loanId}, ${type} ${amount}`);
  const [refreshed] = await pool.query('SELECT * FROM erp_employee_loans WHERE id = ?', [loanId]);
  res.status(201).json(await shapeLoan(refreshed[0]));
});

// DELETE /api/loans/:loanId — HR only, and only if it has no payments yet
// (undo an entry mistake; once real money's moved, close it out via a
// Waiver payment instead of deleting history).
router.delete('/:loanId', requireHr, async (req, res) => {
  const loanId = +req.params.loanId;
  const [payments] = await pool.query('SELECT COUNT(*) c FROM erp_loan_payments WHERE loan_id = ?', [loanId]);
  if (payments[0].c > 0) return res.status(400).json({ error: 'This loan already has payments recorded — it cannot be deleted, only paid off or waived.' });
  const [result] = await pool.query('DELETE FROM erp_employee_loans WHERE id = ?', [loanId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Loan not found.' });
  await audit(req.erpUser.employeeId, 'loan-deleted', String(loanId));
  res.json({ ok: true });
});

module.exports = router;
