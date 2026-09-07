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
   Late: every 3 late arrivals (after the overtime offset below) = 1 extra
   deducted day (latePenaltyDays). Overtime offset is a MONTHLY POOL, not
   just same-day: total overtime minutes across the whole selected range can
   forgive lateness from ANY day in it, not only the day it was earned on
   (late 09:45 today, 30 min overtime tomorrow still forgives today's
   lateness) — smallest lates are forgiven first to clear as many incidents
   as the pool allows. A missing-check-in Late has no minutes to compare, so
   it's never forgiven by the pool — it always counts.
   Per-Day Rate = Gross Salary ÷ (days in the PAYROLL MONTH — 30/31/28/29,
   whichever calendar month the "To" date falls in). This is fixed by the
   month, NOT by how many days happen to be in the selected date range — a
   1-day range and a 20-day range in the same September both divide by 30.
   Payslip breakdown (each its own column):
     Net Salary = Gross Salary − Other Deductions − Late Deduction − Income Tax
     Other Deductions = Per-Day Rate × (Absent Days + Unpaid Leave Days)
     Late Deduction    = Per-Day Rate × Late Penalty Days
     Income Tax        = FBR salaried-individual slab tax (see computeMonthlyIncomeTax) —
                          verify against the current FBR notification each tax year.
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

// FBR salaried-individual income tax slabs — annual income (PKR), tax year
// 2024-25 rates as last known. FBR revises these most years; update this
// table (and only this table) when a new Finance Act changes them.
const FBR_ANNUAL_SLABS = [
  { upTo: 600000, rate: 0, base: 0 },
  { upTo: 1200000, rate: 0.05, base: 0 },
  { upTo: 2200000, rate: 0.15, base: 30000 },
  { upTo: 3200000, rate: 0.25, base: 180000 },
  { upTo: 4100000, rate: 0.30, base: 430000 },
  { upTo: Infinity, rate: 0.35, base: 700000 },
];
// Approximates the standard withholding calculation: annualize the monthly
// Gross Salary (x12), find its slab, apply that slab's rate to the amount
// ABOVE the previous slab's threshold, add the previous slabs' fixed base —
// then divide back down to a monthly figure. Real withholding can differ
// slightly (rounding, mid-year revisions, other taxable heads) — treat this
// as the standard estimate, not a substitute for FBR's own calculator.
function computeMonthlyIncomeTax(grossSalaryMonthly) {
  if (!(grossSalaryMonthly > 0)) return 0;
  const annual = grossSalaryMonthly * 12;
  let prevThreshold = 0;
  for (const slab of FBR_ANNUAL_SLABS) {
    if (annual <= slab.upTo) {
      const annualTax = slab.base + (annual - prevThreshold) * slab.rate;
      return Math.max(0, annualTax / 12);
    }
    prevThreshold = slab.upTo;
  }
  return 0;
}

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

  // Approved "Field Shift" days per employee, same rule as the Compensation
  // tab's running Field Allowance total.
  const [fieldShiftRows] = empIds.length ? await pool.query(
    `SELECT employee_id, from_date, to_date, leave_request_type FROM erp_leave_requests
     WHERE leave_type = 'Field Shift' AND status = 'Approved' AND employee_id IN (${empIds.map(() => '?').join(',')})`,
    empIds
  ) : [[]];
  const fieldShiftDaysById = new Map();
  for (const r of fieldShiftRows) {
    const span = Math.round((new Date(r.to_date) - new Date(r.from_date)) / 86400000) + 1;
    const days = r.leave_request_type === 'Half Day' ? span * 0.5 : span;
    fieldShiftDaysById.set(r.employee_id, (fieldShiftDaysById.get(r.employee_id) || 0) + days);
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
    let presentDays = 0, absentDays = 0, sundayDays = 0, saturdayOffDays = 0, holidayDays = 0, paidLeaveDays = 0, unpaidLeaveDays = 0;
    let overtimeMinutesTotal = 0;
    const reviewFlags = [];
    // Late/overtime offset is a MONTHLY POOL, not just same-day: today's
    // lateness can be forgiven by overtime worked on ANY other day in this
    // payroll run (before or after) — e.g. late 09:45 today, then 30 min
    // overtime tomorrow, forgives today's lateness once the pool covers it.
    // A missing-check-in Late has no measurable minutes, so it always
    // counts and never draws from the pool.
    const lateIncidents = []; // {date, lateMinutes} — only for measurable (check-in present) lates
    let forcedLateCount = 0; // missing-check-in lates — always counted
    for (const d of days) {
      overtimeMinutesTotal += d.overtimeMinutes || 0;
      if (d.dayType === 'Present') {
        // Present is always a full paid day regardless of which punch is
        // missing — half-day pay only ever comes from an actual Half-Day
        // leave request (below), never from a missing punch.
        presentDays++;
        if (!d.checkOut) reviewFlags.push(`${d.date}: Check-out missing — manual review`);
        if (!d.checkIn) reviewFlags.push(`${d.date}: Check-in missing — manual review`);
        if (d.late) {
          if (!d.checkIn) forcedLateCount++;
          else lateIncidents.push({ date: d.date, lateMinutes: d.lateMinutes });
        }
      } else if (d.dayType === 'Absent') absentDays++;
      else if (d.dayType === 'WeeklyOff') { if (d.dayOfWeek === 0) sundayDays++; else saturdayOffDays++; }
      else if (d.dayType === 'Holiday' || d.dayType === 'CompanyOff') holidayDays++;
      else if (d.dayType === 'Leave') paidLeaveDays += d.leaveRequestType === 'Half Day' ? 0.5 : 1;
      else if (d.dayType === 'LeaveWithoutPay') unpaidLeaveDays += d.leaveRequestType === 'Half Day' ? 0.5 : 1;
    }
    // Forgive the SMALLEST lates first — maximizes how many incidents the
    // available overtime pool can clear (each fully forgiven or not at all,
    // no partial credit) before the "3 lates = 1 absent" count is taken.
    let otPool = overtimeMinutesTotal;
    lateIncidents.sort((a, b) => a.lateMinutes - b.lateMinutes);
    let unforgivenLateCount = 0;
    for (const inc of lateIncidents) {
      if (otPool >= inc.lateMinutes) otPool -= inc.lateMinutes;
      else unforgivenLateCount++;
    }
    const lateCount = unforgivenLateCount + forcedLateCount;
    const weeklyOffDays = sundayDays + saturdayOffDays;

    const latePenaltyDays = Math.floor(lateCount / 3);
    const paidDays = presentDays + weeklyOffDays + holidayDays + paidLeaveDays;
    const netPaidDays = Math.max(0, paidDays - latePenaltyDays);

    const profile = profileById.get(meta.employeeId);
    const grossSalary = profile && profile.gross_salary != null ? Number(profile.gross_salary) : null;
    const salaryMissing = grossSalary == null;
    const perDayRate = grossSalary != null ? grossSalary / daysInMonth : null;

    // Payslip-style breakdown — each a column of its own, per the deduction
    // rules in the header comment above.
    const otherDeductionAmount = perDayRate != null ? perDayRate * (absentDays + unpaidLeaveDays) : null;
    const lateDeductionAmount = perDayRate != null ? perDayRate * latePenaltyDays : null;
    const incomeTax = grossSalary != null ? computeMonthlyIncomeTax(grossSalary) : null;
    // perDayRate*netPaidDays already excludes absent/unpaid days (paidDays
    // never counted them) and the late penalty (netPaidDays already
    // subtracts latePenaltyDays) — otherDeductionAmount/lateDeductionAmount
    // above are the same amounts shown as their own columns for a payslip
    // breakdown, not a second subtraction on top of this.
    const netSalary = perDayRate != null ? perDayRate * netPaidDays - (incomeTax || 0) : null;

    const fieldAllowancePerDay = profile && profile.field_allowance != null ? Number(profile.field_allowance) : 0;
    const fieldShiftDays = fieldShiftDaysById.get(meta.employeeId) || 0;
    const fieldAllowanceTotal = fieldAllowancePerDay * fieldShiftDays;

    report.push({
      employeeId: meta.employeeId, employeeCode: meta.employeeCode, employeeName: meta.name, department: meta.department,
      currency: (profile && profile.currency) || 'AED',
      grossSalary, salaryMissing, daysInMonth, totalDaysInRange, perDayRate,
      presentDays, absentDays, sundayDays, saturdayOffDays, weeklyOffDays, holidayDays, paidLeaveDays, unpaidLeaveDays,
      lateCount, latePenaltyDays, overtimeMinutesTotal,
      paidDays, netPaidDays,
      otherDeductionAmount, lateDeductionAmount, incomeTax, netSalary,
      fieldAllowancePerDay, fieldShiftDays, fieldAllowanceTotal,
      grossPayable: netSalary != null ? netSalary + fieldAllowanceTotal : null,
      reviewFlags,
    });
  }

  report.sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.employeeName || '').localeCompare(b.employeeName || ''));
  res.json({ from, to, totalDaysInRange, daysInMonth, rows: report });
});

module.exports = router;
