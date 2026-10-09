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
     Net Salary = Gross Salary − Other Deductions − Late Deduction − Income Tax
     Other Deductions = Per-Day Rate × (Absent Days + Unpaid Leave Days)
     Late Deduction    = Per-Day Rate × Late Penalty Days
     Income Tax        = FBR salaried-individual slab tax for the payroll's tax year (see
                          FBR_SLABS_BY_TAX_YEAR / computeMonthlyIncomeTax) — add a new entry
                          there when a Finance Act changes the rates.
   The columns always add up: Net = Per-Day Rate × Payable Days − Income Tax, where
   Payable Days = the payroll month's days (or fewer, for a shorter range) minus Absent,
   Unpaid Leave and Late Penalty days. A 25th-to-25th cycle is 31–32 calendar days but
   a month is 28–31 pay days: the extra calendar days are NOT paid on top, they only
   make absences count — earlier every extra day was paid as if it were a normal day.
   ============================================================ */
'use strict';
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('./auth');
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


// POST /api/payroll/generate
// { from, to, mode: 'department'|'employee', departments: [name,...], employees: [id,...] }
router.post('/generate', requireHr, async (req, res) => {
  const { from, to, mode } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD.' });
  }
  if (new Date(to) < new Date(from)) return res.status(400).json({ error: '"To" date must not be before "From" date.' });

  const departments = Array.isArray(req.body.departments) ? req.body.departments.filter(Boolean) : [];
  const employeeIds = Array.isArray(req.body.employees) ? req.body.employees.map(Number).filter(Number.isFinite) : [];
  if (mode === 'employee' && !employeeIds.length) return res.status(400).json({ error: 'Select at least one employee.' });
  if (mode === 'department' && !departments.length) return res.status(400).json({ error: 'Select at least one department.' });

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

    // Payslip-style breakdown — each a column of its own, per the deduction
    // rules in the header comment above.
    const otherDeductionAmount = perDayRate != null ? perDayRate * (absentDays + unpaidLeaveDays) : null;
    const lateDeductionAmount = perDayRate != null ? perDayRate * latePenaltyDays : null;
    const incomeTax = grossSalary != null ? computeMonthlyIncomeTax(grossSalary, tax.table.slabs) : null;
    // perDayRate*netPaidDays already excludes absent/unpaid days (paidDays
    // never counted them) and the late penalty (netPaidDays already
    // subtracts latePenaltyDays) — otherDeductionAmount/lateDeductionAmount
    // above are the same amounts shown as their own columns for a payslip
    // breakdown, not a second subtraction on top of this.
    const netSalary = perDayRate != null ? perDayRate * netPaidDays - (incomeTax || 0) : null;

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
      otherDeductionAmount, lateDeductionAmount, incomeTax, netSalary,
      fieldAllowancePerDay, fieldAllowanceTotal,
      grossPayable: netSalary != null ? netSalary + fieldAllowanceTotal : null,
      reviewFlags,
    });
  }

  report.sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.employeeName || '').localeCompare(b.employeeName || ''));
  res.json({ from, to, totalDaysInRange, daysInMonth, taxYear: tax.table.label, taxYearFallback: tax.fallback, rows: report });
});

module.exports = router;
