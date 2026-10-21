/* ============================================================
   Payroll — generates a full payroll report for a date range (the
   company's cycle: 25th of one month to 25th of the next = that later
   month's payroll) by pulling straight from the same day-by-day attendance
   classification the Attendance Report uses (routes/attendance.js's
   computeAttendanceRows), plus each employee's Gross Salary / Field
   Allowance already on file (routes/shared.js's erp_employee_profile).
   No new attendance/leave logic here — this only totals what already
   exists, so it can never drift from what HR sees on the Attendance Report.

   Per-day pay rules:
     Present, check-in + check-out both recorded -> 1 paid day, checked for Late
     Present, only check-out missing             -> 1 paid day (NO half-day
                                                     deduction — salary stays
                                                     normal), flagged for
                                                     manual review
     Present, only check-in missing               -> 1 paid day (same — no
                                                     deduction), flagged for
                                                     review, AND always
                                                     counts as a Late (arrival
                                                     time can't be verified)
     Absent                                       -> 0 paid day (deduction)
     WeeklyOff / Holiday                          -> 1 paid day (no deduction)
     Leave (Approved)      Half Day request -> 0.5 paid day, else 1 paid day
     LeaveWithoutPay        Half Day request -> 0.5 deducted day, else 1
   Half-day pay is driven ONLY by an actual Half-Day leave request
   (leave_request_type) — never inferred from a missing punch.
   Late: every 3 late arrivals (after the late-sitting offset below) = 1
   extra deducted day (latePenaltyDays). A LATE SITTING (attendance.js's
   LATE_SITTING_MIN_MINUTES — staying 60+ minutes past shift_end) is a flat
   COUNT, not minutes: one late sitting cancels exactly one late arrival,
   day for day — not weighted by how late the arrival was or how long the
   sitting ran. This is a MONTHLY POOL, not just same-day: a late sitting on
   any day in the selected range can cancel a late arrival on any OTHER day
   in it (late arrival on the 3rd, late sitting on the 20th still cancels
   it) — which late arrival gets cancelled doesn't matter since it's a flat
   1-for-1 swap, so there's no "smallest first" ordering to worry about
   anymore. A missing-check-in Late can never be cancelled this way — it
   always counts.
   Per-Day Rate = Gross Salary ÷ (days in the PAYROLL MONTH — 30/31/28/29,
   whichever calendar month the "To" date falls in). This is fixed by the
   month, NOT by how many days happen to be in the selected date range — a
   1-day range and a 20-day range in the same September both divide by 30.
   Payslip breakdown (each its own column):
     Net Salary = Gross Salary − Other Deductions − Late Deduction − Income Tax − Loan Deduction
     Other Deductions = Per-Day Rate × (Absent Days + Unpaid Leave Days)
     Late Deduction    = Per-Day Rate × Late Penalty Days
     Income Tax        = FBR salaried-individual slab tax for the payroll's tax year (see
                          FBR_SLABS_BY_TAX_YEAR / computeMonthlyIncomeTax) — add a new entry
                          there when a Finance Act changes the rates.
     Loan Deduction    = the employee's active loan's monthly instalment (erp_employee_loans),
                          capped at whatever balance is still remaining so the last instalment
                          never over-deducts. POST /save is the only place this is actually
                          posted to erp_loan_payments (once per employee per locked month) —
                          /generate only previews the number.
   The columns always add up: Net = Per-Day Rate × Payable Days − Income Tax − Loan Deduction,
   where Payable Days = the payroll month's days (or fewer, for a shorter range) minus Absent,
   Unpaid Leave and Late Penalty days. A 25th-to-25th cycle is 31–32 calendar days but
   a month is 28–31 pay days: the extra calendar days are NOT paid on top, they only
   make absences count — earlier every extra day was paid as if it were a normal day.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth, audit } = require('./auth');
const { canAccess } = require('../roles');
const { computeAttendanceRows } = require('./attendance');

const router = express.Router();
router.use(requireAuth);

function requireHr(req, res, next) {
  if (!canAccess(req.erpUser.role, 'Human Resources')) return res.status(403).json({ error: `Your role (${req.erpUser.role}) has no access to Human Resources.` });
  next();
}

// FBR salaried-individual income tax slabs — annual income (PKR), by TAX YEAR
// (the year the July–June fiscal year ends in: Tax Year 2026 = Jul 2025–Jun 2026).
// Each slab: tax = base + rate × (annual income − previous slab's upper limit).
// A payroll uses the slabs of the tax year its "To" date falls in; if that year
// has no entry yet (a new Finance Act not loaded), the most recent entry
// below it is used and the report says so. Add a new entry here — and only
// here — when the rates change.
const FBR_SLABS_BY_TAX_YEAR = {
  2025: { label: 'Tax Year 2025 (Jul 2024 – Jun 2025)', slabs: [
    { upTo: 600000, rate: 0, base: 0 },
    { upTo: 1200000, rate: 0.05, base: 0 },
    { upTo: 2200000, rate: 0.15, base: 30000 },
    { upTo: 3200000, rate: 0.25, base: 180000 },
    { upTo: 4100000, rate: 0.30, base: 430000 },
    { upTo: Infinity, rate: 0.35, base: 700000 },
  ] },
  2026: { label: 'Tax Year 2026 (Jul 2025 – Jun 2026)', slabs: [
    { upTo: 600000, rate: 0, base: 0 },
    { upTo: 1200000, rate: 0.01, base: 0 },
    { upTo: 2200000, rate: 0.11, base: 6000 },
    { upTo: 3200000, rate: 0.23, base: 116000 },
    { upTo: 4100000, rate: 0.30, base: 346000 },
    { upTo: Infinity, rate: 0.35, base: 616000 },
  ] },
  2027: { label: 'Tax Year 2027 (Jul 2026 – Jun 2027)', slabs: [
    { upTo: 600000, rate: 0, base: 0 },
    { upTo: 1200000, rate: 0.01, base: 0 },
    { upTo: 2200000, rate: 0.11, base: 6000 },
    { upTo: 3200000, rate: 0.20, base: 116000 },
    { upTo: 4100000, rate: 0.25, base: 316000 },
    { upTo: 5600000, rate: 0.29, base: 541000 },
    { upTo: 7000000, rate: 0.32, base: 976000 },
    { upTo: Infinity, rate: 0.35, base: 1424000 },
  ] },
};
// Which slab table applies to a payroll ending on `toYmd` ('YYYY-MM-DD').
function taxTableFor(toYmd) {
  const [y, m] = String(toYmd).split('-').map(Number);
  const taxYear = m >= 7 ? y + 1 : y; // July onwards belongs to the tax year that ends next June
  const known = Object.keys(FBR_SLABS_BY_TAX_YEAR).map(Number).sort((a, b) => b - a);
  const used = known.find((k) => k <= taxYear) ?? known[known.length - 1];
  return { taxYear, used, table: FBR_SLABS_BY_TAX_YEAR[used], fallback: used !== taxYear };
}
// Approximates the standard withholding calculation: annualize the monthly
// Gross Salary (x12), find its slab, apply that slab's rate to the amount
// ABOVE the previous slab's threshold, add the previous slabs' fixed base —
// then divide back down to a monthly figure. Real withholding can differ
// slightly (rounding, mid-year revisions, other taxable heads, the high-income
// surcharge) — treat this as the standard estimate, not a substitute for
// FBR's own calculator.
function computeMonthlyIncomeTax(grossSalaryMonthly, slabs) {
  if (!(grossSalaryMonthly > 0)) return 0;
  const annual = grossSalaryMonthly * 12;
  let prevThreshold = 0;
  for (const slab of slabs) {
    if (annual <= slab.upTo) {
      const annualTax = slab.base + (annual - prevThreshold) * slab.rate;
      return Math.max(0, annualTax / 12);
    }
    prevThreshold = slab.upTo;
  }
  return 0;
}

// Tax breakdown for one annual income under a slab table — used by the Finance
// Tax Calculator so it can show WHICH slab applied and the tax per slab.
function taxBreakdown(annual, slabs) {
  let prev = 0; const lines = []; let tax = 0;
  for (const slab of slabs) {
    if (annual <= prev) break;
    const top = Math.min(annual, slab.upTo);
    lines.push({ from: prev, to: slab.upTo === Infinity ? null : slab.upTo, rate: slab.rate, taxableInSlab: top - prev });
    if (annual <= slab.upTo) tax = slab.base + (annual - prev) * slab.rate;
    prev = slab.upTo;
  }
  return { annualTax: Math.max(0, tax), slabs: lines };
}

// GET /api/payroll/tax-calc?salary=200000&period=monthly|annual&taxYear=2027
// Open to any signed-in user whose role can see HR or Accounting.
router.get('/tax-calc', (req, res) => {
  const role = req.erpUser.role;
  if (!canAccess(role, 'Human Resources') && !canAccess(role, 'Accounting')) return res.status(403).json({ error: 'No access to the Tax Calculator.' });
  const amount = Number(req.query.salary);
  if (!(amount >= 0) || !isFinite(amount)) return res.status(400).json({ error: 'Enter a valid salary amount.' });
  const years = Object.keys(FBR_SLABS_BY_TAX_YEAR).map(Number).sort((a, b) => b - a);
  const taxYear = Number(req.query.taxYear) || years[0];
  const table = FBR_SLABS_BY_TAX_YEAR[taxYear];
  if (!table) return res.status(400).json({ error: 'No slabs loaded for Tax Year ' + taxYear + '.' });
  const annualGross = req.query.period === 'annual' ? amount : amount * 12;
  const b = taxBreakdown(annualGross, table.slabs);
  res.json({
    taxYear, label: table.label, availableYears: years.map((y) => ({ taxYear: y, label: FBR_SLABS_BY_TAX_YEAR[y].label })),
    annualGross, monthlyGross: annualGross / 12,
    annualTax: b.annualTax, monthlyTax: b.annualTax / 12,
    annualNet: annualGross - b.annualTax, monthlyNet: (annualGross - b.annualTax) / 12,
    effectiveRatePct: annualGross > 0 ? (b.annualTax / annualGross) * 100 : 0,
    slabs: b.slabs,
  });
});


// 'YYYY-MM' of a payroll's own "To" date — this, not the exact from/to
// values, is what a saved run locks: ANY generate/save for the same
// calendar month is refused once one exists, regardless of mode or which
// employees/departments it covered.
function monthKeyOf(toYmd) { return String(toYmd).slice(0, 7); }
function monthLabelOf(toYmd) {
  const d = new Date(String(toYmd) + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
async function findLockedMonth(monthKey) {
  const [rows] = await pool.query('SELECT id, month_label FROM erp_payroll_runs WHERE month_key = ?', [monthKey]);
  return rows[0] || null;
}

// Shared by POST /generate (preview — never persisted) and POST /save
// (persists exactly this same computation). Validates from/to/mode/
// departments/employees and returns either { error, status } or the full
// report { from, to, totalDaysInRange, daysInMonth, taxYear, taxYearFallback, rows }.
async function buildPayrollReport({ from, to, mode, departments, employees }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return { error: 'from/to must be YYYY-MM-DD.', status: 400 };
  }
  if (new Date(to) < new Date(from)) return { error: '"To" date must not be before "From" date.', status: 400 };

  departments = Array.isArray(departments) ? departments.filter(Boolean) : [];
  const employeeIds = Array.isArray(employees) ? employees.map(Number).filter(Number.isFinite) : [];
  if (mode === 'employee' && !employeeIds.length) return { error: 'Select at least one employee.', status: 400 };
  if (mode === 'department' && !departments.length) return { error: 'Select at least one department.', status: 400 };

  const totalDaysInRange = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  // Per-Day Rate always divides by the days in the PAYROLL MONTH (30 for
  // September, 31 for August/October, ...) — never by however many days
  // happen to be in the selected range. The payroll month follows the "To"
  // date (the company's cycle is 25th-to-25th, e.g. 25-Aug to 25-Sep is
  // September's payroll), same rule the frontend's Payroll Month field uses.
  const toDate = new Date(to + 'T00:00:00');
  const daysInMonth = new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate();

  // Fetch attendance rows scoped to the exact employees requested (employee
  // mode) — for department mode, pull everyone and filter by department in
  // JS below, same cost either way since this is one office's roster.
  const rows = await computeAttendanceRows(from, to, mode === 'employee' ? { employeeIds } : {});
  const scoped = mode === 'department' ? rows.filter((r) => departments.includes(r.department)) : rows;

  // Gross Salary / Field Allowance rate — straight from the profile, same
  // source the Employees form's Compensation tab reads/writes.
  const empIds = [...new Set(scoped.map((r) => r.employeeId).filter(Boolean))];
  const profileById = new Map();
  if (empIds.length) {
    const [profiles] = await pool.query(
      `SELECT employee_id, gross_salary, field_allowance, currency FROM erp_employee_profile WHERE employee_id IN (${empIds.map(() => '?').join(',')})`,
      empIds
    );
    for (const p of profiles) profileById.set(p.employee_id, p);
  }

  const tax = taxTableFor(to);

  // Active loan (if any) + remaining balance, per employee — folded into
  // Net Salary below exactly like an Absence or Late deduction. Capped at
  // the remaining balance so a loan's last instalment never deducts more
  // than what's actually still owed. This is a read-only preview number
  // here (safe to call from /generate too); POST /save is the only place
  // that actually posts it as a real erp_loan_payments row.
  const loanByEmployee = new Map();
  if (empIds.length) {
    const [loans] = await pool.query(
      `SELECT id, employee_id, principal_amount, monthly_deduction FROM erp_employee_loans WHERE employee_id IN (${empIds.map(() => '?').join(',')}) AND status = 'Active'`,
      empIds
    );
    if (loans.length) {
      const loanIds = loans.map((l) => l.id);
      const [paidRows] = await pool.query(
        `SELECT loan_id, COALESCE(SUM(amount),0) paid FROM erp_loan_payments WHERE loan_id IN (${loanIds.map(() => '?').join(',')}) GROUP BY loan_id`,
        loanIds
      );
      const paidByLoan = new Map(paidRows.map((p) => [p.loan_id, Number(p.paid)]));
      for (const l of loans) {
        const remaining = Math.max(0, Number(l.principal_amount) - (paidByLoan.get(l.id) || 0));
        loanByEmployee.set(l.employee_id, { loanId: l.id, deduction: Math.min(Number(l.monthly_deduction), remaining) });
      }
    }
  }

  // Group the day-by-day rows per employee.
  const byEmployee = new Map();
  for (const r of scoped) {
    if (!r.employeeId) continue; // unmapped device punches don't belong to a payroll
    if (!byEmployee.has(r.employeeId)) byEmployee.set(r.employeeId, { meta: r, days: [] });
    byEmployee.get(r.employeeId).days.push(r);
  }

  const report = [];
  for (const { meta, days } of byEmployee.values()) {
    // Sunday and a rotational Saturday off are both dayType='WeeklyOff'
    // (same pay treatment — 1 paid day, no deduction) but shown/counted
    // separately: Sunday as "Gazetted Holiday (Sunday)", Saturday as the
    // ordinary "Weekly Off".
    let fieldDays = 0; // present because a JLR field job covers the day (no machine punch)
    let presentDays = 0, absentDays = 0, sundayDays = 0, saturdayOffDays = 0, holidayDays = 0, paidLeaveDays = 0, unpaidLeaveDays = 0;
    let lateSittingsTotal = 0; // count of days with a qualifying late sitting, not minutes
    const reviewFlags = [];
    // Late-sitting offset is a MONTHLY POOL, not just same-day: a late
    // sitting on any day in this payroll run can cancel a late arrival on
    // ANY other day in it (before or after) — e.g. late arrival on the 3rd,
    // a late sitting on the 20th still cancels it. A missing-check-in Late
    // can never be cancelled this way, so it always counts.
    let forgivableLateCount = 0; // measurable (check-in present) lates
    let forcedLateCount = 0; // missing-check-in lates — always counted
    for (const d of days) {
      if (d.lateSitting) lateSittingsTotal++;
      if (d.dayType === 'Present') {
        // Present is always a full paid day regardless of which punch is
        // missing — half-day pay only ever comes from an actual Half-Day
        // leave request (below), never from a missing punch.
        presentDays++;
        if (!d.checkOut) reviewFlags.push(`${d.date}: Check-out missing — manual review`);
        if (!d.checkIn) reviewFlags.push(`${d.date}: Check-in missing — manual review`);
        if (d.late) {
          if (!d.checkIn) forcedLateCount++;
          else forgivableLateCount++;
        }
      } else if (d.dayType === 'Field') { presentDays++; fieldDays++; } // out on a job (JLR) instead of at an office machine — paid the same as Present
      else if (d.dayType === 'Absent') absentDays++;
      else if (d.dayType === 'WeeklyOff') { if (d.dayOfWeek === 0) sundayDays++; else saturdayOffDays++; }
      else if (d.dayType === 'Holiday' || d.dayType === 'CompanyOff') holidayDays++;
      else if (d.dayType === 'Leave') paidLeaveDays += d.leaveRequestType === 'Half Day' ? 0.5 : 1;
      else if (d.dayType === 'LeaveWithoutPay') unpaidLeaveDays += d.leaveRequestType === 'Half Day' ? 0.5 : 1;
    }
    // Each late sitting cancels exactly one late arrival — a flat count
    // swap, so which specific arrival gets cancelled doesn't matter and
    // there's no "smallest first" ordering needed anymore.
    const lateForgivenByLateSitting = Math.min(forgivableLateCount, lateSittingsTotal);
    const unforgivenLateCount = forgivableLateCount - lateForgivenByLateSitting;
    const lateCount = unforgivenLateCount + forcedLateCount;
    const lateArrivals = forgivableLateCount + forcedLateCount; // every late arrival, before late-sitting forgiveness
    const weeklyOffDays = sundayDays + saturdayOffDays;

    const latePenaltyDays = Math.floor(lateCount / 3);
    const paidDays = presentDays + weeklyOffDays + holidayDays + paidLeaveDays;
    // Payable days = a full pay month (or the range, if shorter) less every
    // deducted day. NOT paidDays − penalty: a 25th-to-25th cycle is 31–32
    // calendar days against a 30-day pay month, so counting every paid calendar
    // day paid the extra days on top of the salary and hid absences.
    const baseDays = Math.min(totalDaysInRange, daysInMonth);
    const netPaidDays = Math.max(0, baseDays - absentDays - unpaidLeaveDays - latePenaltyDays);

    const profile = profileById.get(meta.employeeId);
    const grossSalary = profile && profile.gross_salary != null ? Number(profile.gross_salary) : null;
    const salaryMissing = grossSalary == null;
    const perDayRate = grossSalary != null ? grossSalary / daysInMonth : null;

    const loanInfo = loanByEmployee.get(meta.employeeId) || null;
    const loanId = loanInfo ? loanInfo.loanId : null;
    const loanDeduction = loanInfo ? loanInfo.deduction : 0;

    // Payslip-style breakdown — each a column of its own, per the deduction
    // rules in the header comment above.
    const otherDeductionAmount = perDayRate != null ? perDayRate * (absentDays + unpaidLeaveDays) : null;
    const lateDeductionAmount = perDayRate != null ? perDayRate * latePenaltyDays : null;
    const incomeTax = grossSalary != null ? computeMonthlyIncomeTax(grossSalary, tax.table.slabs) : null;
    // perDayRate*netPaidDays already excludes absent/unpaid days (paidDays
    // never counted them) and the late penalty (netPaidDays already
    // subtracts latePenaltyDays) — otherDeductionAmount/lateDeductionAmount
    // above are the same amounts shown as their own columns for a payslip
    // breakdown, not a second subtraction on top of this. loanDeduction IS
    // a real subtraction on top (an active loan's monthly instalment).
    const netSalary = perDayRate != null ? perDayRate * netPaidDays - (incomeTax || 0) - loanDeduction : null;

    // Field Allowance = this employee's per-day rate × however many days in
    // THIS payroll range JLR actually had them out on a field job
    // (fieldDays above — the same count the Attendance Report shows, from
    // fieldJobs.js's job-presence data). Used to be driven by a separate,
    // manually-filed-and-approved "Field Shift" leave request instead; that
    // required someone to remember to file one and never reflected what JLR
    // itself already knew, so it's gone in favor of this single source of
    // truth.
    const fieldAllowancePerDay = profile && profile.field_allowance != null ? Number(profile.field_allowance) : 0;
    const fieldAllowanceTotal = fieldAllowancePerDay * fieldDays;

    report.push({
      employeeId: meta.employeeId, employeeCode: meta.employeeCode, employeeName: meta.name, department: meta.department,
      currency: (profile && profile.currency) || 'AED',
      grossSalary, salaryMissing, daysInMonth, totalDaysInRange, perDayRate,
      presentDays, fieldDays, officeDays: presentDays - fieldDays, absentDays, sundayDays, saturdayOffDays, weeklyOffDays, holidayDays, paidLeaveDays, unpaidLeaveDays,
      lateCount, lateArrivals, lateForgivenByLateSitting, latePenaltyDays, lateSittingsTotal,
      paidDays, netPaidDays, baseDays,
      otherDeductionAmount, lateDeductionAmount, incomeTax, loanId, loanDeduction, netSalary,
      fieldAllowancePerDay, fieldAllowanceTotal,
      grossPayable: netSalary != null ? netSalary + fieldAllowanceTotal : null,
      reviewFlags,
    });
  }

  report.sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.employeeName || '').localeCompare(b.employeeName || ''));
  return { from, to, totalDaysInRange, daysInMonth, taxYear: tax.table.label, taxYearFallback: tax.fallback, rows: report };
}

// POST /api/payroll/generate — live PREVIEW only, nothing is persisted.
// { from, to, mode: 'department'|'employee', departments: [name,...], employees: [id,...] }
// Refused outright once a payroll has been SAVED for this calendar month
// (see POST /save) — regenerating/previewing a finalized month is exactly
// what saving is meant to prevent, so the lock applies here too, not just
// on save.
router.post('/generate', requireHr, async (req, res) => {
  const { from, to, mode, departments, employees } = req.body || {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    const locked = await findLockedMonth(monthKeyOf(to));
    if (locked) return res.status(409).json({ error: `Payroll for ${locked.month_label} has already been saved and locked. Delete it first (Payroll / Slips → Payrolls) if you need to regenerate it.`, locked: true, monthLabel: locked.month_label });
  }
  const result = await buildPayrollReport({ from, to, mode, departments, employees });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// POST /api/payroll/save — runs the exact same computation as /generate,
// then permanently locks this calendar month: a snapshot of the report is
// stored in erp_payroll_runs and no generate/save for this month will be
// allowed again (in any mode) until this row is deleted (see DELETE below).
router.post('/save', requireHr, async (req, res) => {
  const { from, to, mode, departments, employees } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
  const monthKey = monthKeyOf(to);
  const locked = await findLockedMonth(monthKey);
  if (locked) return res.status(409).json({ error: `Payroll for ${locked.month_label} has already been saved and locked.`, locked: true, monthLabel: locked.month_label });

  const result = await buildPayrollReport({ from, to, mode, departments, employees });
  if (result.error) return res.status(result.status).json({ error: result.error });
  if (!result.rows.length) return res.status(400).json({ error: 'Nothing to save — the generated payroll has no rows.' });

  const monthLabel = monthLabelOf(to);
  const totalGrossPayable = result.rows.reduce((s, r) => s + (r.grossPayable || 0), 0);

  // The run itself + every active loan's instalment it triggers are one
  // atomic unit: a save that half-applied (run locked but a loan payment
  // missing, or vice versa) would leave no safe way to retry, since the
  // month is already locked the moment the run row exists.
  const conn = await pool.getConnection();
  let insertId;
  try {
    await conn.beginTransaction();
    try {
      const [ins] = await conn.query(
        `INSERT INTO erp_payroll_runs (month_key, month_label, from_date, to_date, mode, departments, employee_ids, employee_count, total_gross_payable, data, saved_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [monthKey, monthLabel, from, to, mode || '', JSON.stringify(departments || []), JSON.stringify(employees || []), result.rows.length, totalGrossPayable, JSON.stringify(result), req.erpUser.id]
      );
      insertId = ins.insertId;
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Payroll for ${monthLabel} has already been saved and locked.`, locked: true, monthLabel });
      throw e;
    }

    // Post each row's loan instalment as a real payment, tagged with this
    // run's id so DELETE /saved/:id can cleanly reverse exactly these
    // payments (and only these) if this month needs correcting.
    for (const row of result.rows) {
      if (!row.loanId || !(row.loanDeduction > 0)) continue;
      await conn.query(
        `INSERT INTO erp_loan_payments (loan_id, payroll_run_id, amount, payment_type, payment_date, notes, created_by) VALUES (?,?,?,?,?,?,?)`,
        [row.loanId, insertId, row.loanDeduction, 'Monthly', to, `Auto-deducted via payroll — ${monthLabel}`, req.erpUser.id]
      );
      const [[loanRow]] = await conn.query('SELECT principal_amount FROM erp_employee_loans WHERE id = ?', [row.loanId]);
      const [[paidRow]] = await conn.query('SELECT COALESCE(SUM(amount),0) s FROM erp_loan_payments WHERE loan_id = ?', [row.loanId]);
      if (loanRow && Number(loanRow.principal_amount) - Number(paidRow.s) <= 0) {
        await conn.query("UPDATE erp_employee_loans SET status = 'Closed', closed_at = NOW() WHERE id = ?", [row.loanId]);
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  await audit(req.erpUser.employeeId, 'payroll-saved', `${monthLabel} (${result.rows.length} employee(s))`);
  for (const row of result.rows) {
    if (row.loanId && row.loanDeduction > 0) {
      await audit(req.erpUser.employeeId, 'loan-payment', `loan ${row.loanId}, Monthly ${row.loanDeduction} (auto via payroll ${monthLabel})`);
    }
  }
  res.status(201).json({ id: insertId, monthKey, monthLabel, employeeCount: result.rows.length, totalGrossPayable });
});

// mysql2 hands a DATE column back as a JS Date at LOCAL midnight — letting
// res.json()'s default toISOString() serialize it shifts it into the
// PREVIOUS calendar day for any positive UTC offset (e.g. Pakistan,
// UTC+5). Same bug, same fix as everywhere else in this codebase that
// shows a DATE column (JLR's change dates, leave requests' from/to, ...).
function dateOnly(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// GET /api/payroll/saved — month-wise list for the Payroll/Slips → Payrolls
// tab. Optional ?year=2026 filters to that calendar year (by month_key).
router.get('/saved', requireHr, async (req, res) => {
  const where = [], params = [];
  if (req.query.year && /^\d{4}$/.test(req.query.year)) { where.push('month_key LIKE ?'); params.push(req.query.year + '-%'); }
  const sql = `SELECT r.id, r.month_key, r.month_label, r.from_date, r.to_date, r.mode, r.employee_count, r.total_gross_payable, r.saved_at,
                      e.full_name AS saved_by_name
               FROM erp_payroll_runs r LEFT JOIN employees e ON e.id = r.saved_by
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY r.month_key DESC`;
  const [rows] = await pool.query(sql, params);
  res.json(rows.map((r) => ({ ...r, from_date: dateOnly(r.from_date), to_date: dateOnly(r.to_date) })));
});

// GET /api/payroll/saved/:id — the full saved snapshot (for re-viewing the
// exact report that was finalized — never recomputed).
router.get('/saved/:id', requireHr, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.*, e.full_name AS saved_by_name FROM erp_payroll_runs r LEFT JOIN employees e ON e.id = r.saved_by WHERE r.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const row = rows[0];
  res.json({
    id: row.id, monthKey: row.month_key, monthLabel: row.month_label,
    fromDate: dateOnly(row.from_date), toDate: dateOnly(row.to_date), mode: row.mode,
    departments: JSON.parse(row.departments || '[]'), employeeIds: JSON.parse(row.employee_ids || '[]'),
    employeeCount: row.employee_count, totalGrossPayable: row.total_gross_payable,
    savedBy: row.saved_by, savedByName: row.saved_by_name, savedAt: row.saved_at,
    report: JSON.parse(row.data),
  });
});

// DELETE /api/payroll/saved/:id — unlocks the month so payroll can be run
// again (e.g. a correction is needed). Administrator/Sub Admin only (a
// plain HR Officer can generate/save payroll but not undo a finalized
// one), AND the caller must echo back this exact record's month_key as
// req.body.confirmMonthKey — a lightweight server-side guard against this
// ever firing from anything other than the UI's own 2-step confirmation,
// which shows the month label and makes the user type/confirm it first.
router.delete('/saved/:id', async (req, res) => {
  if (req.erpUser.role !== 'Administrator' && req.erpUser.role !== 'Sub Admin') {
    return res.status(403).json({ error: 'Only an Administrator or Sub Admin can delete a saved payroll.' });
  }
  const [rows] = await pool.query('SELECT month_key, month_label FROM erp_payroll_runs WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const { month_key, month_label } = rows[0];
  if (String(req.body && req.body.confirmMonthKey) !== month_key) {
    return res.status(400).json({ error: 'Confirmation did not match — this payroll was not deleted.' });
  }

  // Undo any loan instalments this run auto-posted (see POST /save) before
  // the run itself goes — otherwise re-saving this month later would charge
  // that loan a second time for a month that's being corrected/redone.
  const [autoPayments] = await pool.query('SELECT DISTINCT loan_id FROM erp_loan_payments WHERE payroll_run_id = ?', [req.params.id]);
  await pool.query('DELETE FROM erp_loan_payments WHERE payroll_run_id = ?', [req.params.id]);
  for (const { loan_id } of autoPayments) {
    const [[loanRow]] = await pool.query('SELECT principal_amount, status FROM erp_employee_loans WHERE id = ?', [loan_id]);
    if (!loanRow) continue;
    const [[paidRow]] = await pool.query('SELECT COALESCE(SUM(amount),0) s FROM erp_loan_payments WHERE loan_id = ?', [loan_id]);
    if (loanRow.status === 'Closed' && Number(loanRow.principal_amount) - Number(paidRow.s) > 0) {
      await pool.query("UPDATE erp_employee_loans SET status = 'Active', closed_at = NULL WHERE id = ?", [loan_id]);
    }
  }

  await pool.query('DELETE FROM erp_payroll_runs WHERE id = ?', [req.params.id]);
  await audit(req.erpUser.employeeId, 'payroll-deleted', month_label);
  res.json({ ok: true, monthLabel: month_label });
});

/* ================================================================
   Payslips — generated on demand from an already-SAVED payroll run, never
   stored as files. 221 employees × however many months would otherwise be
   221×N PDFs sitting on disk/DB for no reason: the run's JSON snapshot
   (already being kept for the Payrolls tab) is the only thing that persists;
   every payslip PDF is built fresh, in-memory, right before it's downloaded
   or emailed, then discarded. This app's own PDF writer (pdfDoc.js, a
   straight Node port of the frontend's) builds one in a few milliseconds,
   so "on demand" costs nothing noticeable even for the whole roster.
   ================================================================ */
const { buildPayslipPdf } = require('../payslip');
const { sendMail, mailConfigured } = require('../mailer');

// Combines one employee's row from the saved run's snapshot (financial
// totals already computed and LOCKED at save time — never recomputed here)
// with their CURRENT salary-component breakdown, designation and bank
// details (none of which the saved snapshot carries, and none of which
// rewrites history the way re-running attendance/tax would). If a change to
// someone's Basic/HRA/Utility split happens after a month is saved,
// re-printing that old month's payslip reflects the new split's numbers
// added up to the SAME already-locked total — a known, minor edge case,
// not a bug. The loan instalment (row.loanId/row.loanDeduction) is already
// LOCKED at save time too — POST /save actually posted it as a real
// erp_loan_payments row, so re-downloading this payslip never re-deducts it.
async function buildPayslipData(row, monthLabel) {
  const [[p]] = await pool.query(
    `SELECT designation, join_date, bank_name, account_no, salary, hra, utility_allowance
     FROM erp_employee_profile WHERE employee_id = ?`, [row.employeeId]
  );
  const profile = p || {};
  let basic = +profile.salary || 0, hra = +profile.hra || 0, utility = +profile.utility_allowance || 0;
  let standardTotal = basic + hra + utility;
  if (standardTotal <= 0 && row.grossSalary) {
    // No detailed Basic/HRA/Utility split on file for this employee — fall
    // back to the single Gross Salary figure payroll itself already relies
    // on, as "Basic Salary" alone, rather than printing a broken 0/0/0 split
    // while still charging the already-correct tax/late deductions below.
    basic = +row.grossSalary; hra = 0; utility = 0; standardTotal = basic;
  }
  // Only the ABSENCE/unpaid-leave portion of the deduction shrinks the
  // allowance columns (Standard -> Payable) — tax and late deduction are
  // their own line items on the right, not folded into these, matching the
  // reference layout (and buildPayrollReport()'s own otherDeductionAmount
  // vs lateDeductionAmount split).
  const absenceDeduction = +row.otherDeductionAmount || 0;
  const proration = standardTotal > 0 ? Math.max(0, 1 - absenceDeduction / standardTotal) : 1;
  const payableBasic = basic * proration, payableHra = hra * proration, payableUtility = utility * proration;
  const grossPayable = payableBasic + payableHra + payableUtility;

  // row.loanDeduction is the amount actually posted against the loan when
  // this run was saved (see POST /save) — use that, not a fresh read of the
  // loan's current monthly_deduction, so an old payslip always matches what
  // was really deducted that month even if the loan's terms changed since.
  const loanDeductionAmount = +row.loanDeduction || 0;
  let loan = null;
  if (row.loanId) {
    const [[l]] = await pool.query('SELECT id, principal_amount FROM erp_employee_loans WHERE id = ?', [row.loanId]);
    if (l) {
      const [[paid]] = await pool.query('SELECT COALESCE(SUM(amount),0) s FROM erp_loan_payments WHERE loan_id = ?', [l.id]);
      loan = { sanctioned: +l.principal_amount, currentMonthDeduction: loanDeductionAmount, totalDeduction: +paid.s, balance: Math.max(0, +l.principal_amount - +paid.s) };
    }
  } else if (row.loanDeduction == null) {
    // A saved run from before this feature existed — it never captured
    // loanId/loanDeduction, so nothing was actually deducted for it. Fall
    // back to today's live active loan just so the payslip still shows
    // something, informational only (can't retroactively change a locked
    // month's math).
    const [loanRows] = await pool.query(
      `SELECT id, principal_amount, monthly_deduction FROM erp_employee_loans WHERE employee_id = ? AND status = 'Active' LIMIT 1`,
      [row.employeeId]
    );
    if (loanRows.length) {
      const l = loanRows[0];
      const [[paid]] = await pool.query('SELECT COALESCE(SUM(amount),0) s FROM erp_loan_payments WHERE loan_id = ?', [l.id]);
      loan = { sanctioned: +l.principal_amount, currentMonthDeduction: +l.monthly_deduction, totalDeduction: +paid.s, balance: +l.principal_amount - +paid.s };
    }
  }

  // Net Payable mirrors buildPayrollReport()'s own netSalary math exactly
  // (gross minus tax minus late deduction minus this month's loan instalment).
  const totalDeductions = (+row.incomeTax || 0) + (+row.lateDeductionAmount || 0) + loanDeductionAmount;
  const netPayable = grossPayable - totalDeductions;

  return {
    employeeCode: row.employeeCode,
    name: row.employeeName,
    dateOfJoining: profile.join_date ? dmyMon(dateOnly(profile.join_date)) : '',
    designation: profile.designation || '',
    department: row.department || '',
    bankName: profile.bank_name || '',
    bankAccountNo: profile.account_no || '',
    monthLabel,
    daysWorked: row.netPaidDays,
    allowances: [
      { label: 'Basic Salary', standard: basic, payable: payableBasic },
      { label: 'House Rent', standard: hra, payable: payableHra },
      { label: 'Utility Allowance', standard: utility, payable: payableUtility },
    ].filter((a) => a.standard || a.payable),
    deductions: [
      ...(row.incomeTax ? [{ label: 'Income Tax', amount: row.incomeTax }] : []),
      ...(row.lateDeductionAmount ? [{ label: 'Late Deduction', amount: row.lateDeductionAmount }] : []),
      ...(loanDeductionAmount ? [{ label: 'Loan Installment', amount: loanDeductionAmount }] : []),
    ],
    grossStandard: standardTotal, grossPayable, totalDeductions, loan, netPayable,
  };
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dmyMon(ymd) { // 'YYYY-MM-DD' -> '29-Oct-2025', matching the reference payslip
  const [y, m, d] = String(ymd).split('-');
  return d + '-' + MON3[(+m) - 1] + '-' + y;
}
function findRunRow(id) {
  return pool.query('SELECT * FROM erp_payroll_runs WHERE id = ?', [id]).then(([rows]) => rows[0] || null);
}

// GET /api/payroll/saved/:id/payslip/:employeeId — one employee's payslip,
// straight download, password-protected with their own employee code.
router.get('/saved/:id/payslip/:employeeId', requireHr, async (req, res) => {
  const run = await findRunRow(req.params.id);
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });
  const report = JSON.parse(run.data);
  const row = (report.rows || []).find((r) => String(r.employeeId) === String(req.params.employeeId));
  if (!row) return res.status(404).json({ error: 'That employee is not in this payroll run.' });
  const data = await buildPayslipData(row, run.month_label);
  const bytes = buildPayslipPdf(data, row.employeeCode);
  await audit(req.erpUser.employeeId, 'payslip-downloaded', `${run.month_label}: ${row.employeeName}`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Payslip-${row.employeeCode}-${run.month_key}.pdf"`);
  res.send(bytes);
});

// ---------------- bulk "Send Payslips" ----------------
// 221 emails in one request would hit SMTP rate limits and tie up the
// request for minutes with no way to show progress. POST kicks off a
// background loop (this is a single Node process — an in-memory Map is
// enough; nothing here needs to survive a server restart) and returns a
// jobId immediately; the frontend polls the status route for progress.
const PAYSLIP_JOBS = new Map();
const SEND_DELAY_MS = 1200; // spacing between sends — gentle on any normal SMTP account's per-minute limit

router.post('/saved/:id/payslips/send', requireHr, async (req, res) => {
  if (!mailConfigured()) return res.status(400).json({ error: 'Mail is not configured yet — ask an Administrator to set SMTP_HOST/SMTP_USER/SMTP_PASS in the backend .env.' });
  const run = await findRunRow(req.params.id);
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });
  const report = JSON.parse(run.data);
  const rows = report.rows || [];
  if (!rows.length) return res.status(400).json({ error: 'This payroll run has no employees.' });

  const empIds = rows.map((r) => r.employeeId);
  const [emails] = await pool.query(`SELECT id, email FROM employees WHERE id IN (${empIds.map(() => '?').join(',')})`, empIds);
  const emailById = new Map(emails.map((e) => [e.id, e.email]));

  const jobId = 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = { total: rows.length, sent: 0, failed: 0, skipped: 0, done: false, results: [], startedAt: new Date().toISOString(), monthLabel: run.month_label };
  PAYSLIP_JOBS.set(jobId, job);
  res.json({ jobId, total: job.total });

  (async () => {
    for (const row of rows) {
      const email = emailById.get(row.employeeId);
      if (!email) {
        job.skipped++; job.results.push({ employeeName: row.employeeName, ok: false, reason: 'No email on file' });
        continue;
      }
      try {
        const data = await buildPayslipData(row, run.month_label);
        const bytes = buildPayslipPdf(data, row.employeeCode);
        await sendMail({
          to: email,
          subject: `Payslip — ${run.month_label}`,
          text: `Dear ${row.employeeName},\n\nPlease find attached your payslip for ${run.month_label}.\nThe PDF is password-protected with your Employee Code.\n\nThis is a system-generated email.`,
          attachments: [{ filename: `Payslip-${row.employeeCode}-${run.month_key}.pdf`, content: bytes }],
        });
        job.sent++; job.results.push({ employeeName: row.employeeName, ok: true });
      } catch (e) {
        job.failed++; job.results.push({ employeeName: row.employeeName, ok: false, reason: e.message });
      }
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
    job.done = true;
    await audit(req.erpUser.employeeId, 'payslips-sent', `${run.month_label}: ${job.sent} sent, ${job.failed} failed, ${job.skipped} skipped (no email)`);
  })().catch(() => { job.done = true; job.failed = job.total - job.sent - job.skipped; });
});

router.get('/payslips/status/:jobId', requireHr, (req, res) => {
  const job = PAYSLIP_JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job (server may have restarted).' });
  res.json(job);
});

module.exports = router;
