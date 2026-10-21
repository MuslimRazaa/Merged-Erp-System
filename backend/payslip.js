/* ============================================================
   Payslip PDF — matches the reference "PAY SLIP" layout: centered
   company header, employee/bank details, an Allowances|Deductions
   two-column grid (Standard vs Payable), a Loan Sanctioned strip, and
   a Net Amount Payable box with the amount spelled out.

   Pure data in, PDF bytes out — buildPayslipPdf() doesn't touch the
   database itself, so it's reusable for both the single-employee
   download and the bulk "Send Payslips" email job (routes/payroll.js
   assembles the data object from the saved payroll run + current
   profile/loan lookups, this just lays it out).
   ============================================================ */
'use strict';
const { PdfDoc } = require('./pdfDoc');

const WO_CO_NAME = 'Premier Tubular Inspection Services (Pvt.) Ltd';

function fmt(n) {
  n = +n || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt0(n) {
  n = +n || 0;
  return Math.round(n).toLocaleString('en-US');
}
function amountWords(n) {
  n = Math.round((+n || 0) * 100) / 100;
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function grp(x) {
    let s = '';
    if (x >= 100) { s += ones[Math.floor(x / 100)] + ' hundred '; x %= 100; }
    if (x >= 20) { s += tens[Math.floor(x / 10)] + (x % 10 ? '-' + ones[x % 10] : '') + ' '; }
    else if (x > 0) s += ones[x] + ' ';
    return s;
  }
  let i = Math.floor(n), f = Math.round((n - i) * 100), out = '', u = [['billion', 1e9], ['million', 1e6], ['thousand', 1e3]];
  if (i === 0) out = 'zero ';
  u.forEach(([nm, v]) => { if (i >= v) { out += grp(Math.floor(i / v)) + nm + ' '; i %= v; } });
  out += grp(i);
  out = out.trim(); out = out.charAt(0).toUpperCase() + out.slice(1);
  return (out + (f ? ' and ' + f + '/100' : '') + ' only').toUpperCase();
}

// data: see the shape built in routes/payroll.js's buildPayslipData()
function buildPayslipPdf(data, password) {
  const doc = new PdfDoc();
  doc.noFooter = true;
  const L = doc.mL, R = doc.w - doc.mR, W = R - L;
  const TY = t => doc.h - t;
  const mid = L + W / 2;

  doc.textC(L + W / 2, TY(26), WO_CO_NAME, 15, true);
  doc.textC(L + W / 2, TY(44), 'PAY SLIP', 11, true);
  doc.text(R - 150, TY(44), 'Days Worked :', 9, true);
  doc.text(R - 60, TY(44), String(data.daysWorked == null ? '' : data.daysWorked), 9, true);
  doc.rule(L, TY(58), R, TY(58), 0.8);

  const lv = L + 110;
  let t = 74;
  const row = (label, value, bold) => { doc.text(L, TY(t), label, 9, true); doc.text(lv, TY(t), String(value || ''), 9, !!bold); t += 14; };
  row('Employee Code:', data.employeeCode);
  row('Name:', data.name, true);
  row('Date of Joining :', data.dateOfJoining);
  t += 4;
  doc.rule(L, TY(t - 10), R, TY(t - 10), 0.5, '0.7 0.7 0.72');
  row('Designation:', data.designation);
  row('Department:', data.department);
  t += 4;
  doc.rule(L, TY(t - 10), R, TY(t - 10), 0.5, '0.7 0.7 0.72');
  row('Bank Name :', data.bankName);
  row('Bank Account # :', data.bankAccountNo);

  t += 10;

  // ---------- Allowances | Deductions header row ----------
  const hdrTop = t, hdrH = 18;
  doc.box(L, TY(hdrTop + hdrH), 130, hdrH, 1.1);
  doc.text(L + 6, TY(hdrTop + 13), 'ALLOWANCES', 9.5, true, '0 0 0.6');
  doc.textR(mid - 100, TY(hdrTop + 13), 'STANDARD', 8, true);
  doc.textR(mid - 10, TY(hdrTop + 13), 'PAYABLE', 8, true);
  doc.box(mid + 10, TY(hdrTop + hdrH), 130, hdrH, 1.1);
  doc.text(mid + 16, TY(hdrTop + 13), 'DEDUCTIONS', 9.5, true, '0 0 0.6');
  doc.textR(R, TY(hdrTop + 13), data.monthLabel || '', 9, true);
  t = hdrTop + hdrH + 2;
  const bodyTop = t;

  // allowances column (left)
  let ta = t;
  (data.allowances || []).forEach(a => {
    doc.text(L + 4, TY(ta + 11), a.label, 8.5);
    doc.textR(mid - 100, TY(ta + 11), fmt(a.standard), 8.5);
    doc.textR(mid - 10, TY(ta + 11), fmt0(a.payable), 8.5);
    ta += 17;
  });
  // deductions column (right)
  let td = t;
  (data.deductions || []).forEach(d => {
    doc.text(mid + 16, TY(td + 11), d.label, 8.5);
    doc.textR(R - 4, TY(td + 11), fmt0(d.amount), 8.5);
    td += 17;
  });

  const bodyBottom = Math.max(ta, td) + 6;
  doc.box(L, TY(bodyBottom), 130, bodyBottom - bodyTop, 1.1);
  doc.box(mid + 10, TY(bodyBottom), 130, bodyBottom - bodyTop, 1.1);
  doc.rule(L, TY(bodyBottom), R, TY(bodyBottom), 1.1);
  doc.rule(L, TY(hdrTop), L, TY(bodyBottom), 1.1);
  doc.rule(R, TY(hdrTop), R, TY(bodyBottom), 1.1);
  doc.rule(mid, TY(hdrTop), mid, TY(bodyBottom), 1.1);

  // GROSS / TOTAL DEDUCTIONS row
  t = bodyBottom + 2;
  const grossH = 18;
  doc.rule(L, TY(t + grossH), R, TY(t + grossH), 1.1);
  doc.box(L, TY(t + grossH), 130, grossH, 1.1);
  doc.text(L + 4, TY(t + 13), 'GROSS :', 9.5, true);
  doc.textR(mid - 100, TY(t + 13), fmt0(data.grossStandard), 9.5, true);
  doc.textR(mid - 10, TY(t + 13), fmt0(data.grossPayable), 9.5, true);
  doc.box(mid + 10, TY(t + grossH), 130, grossH, 1.1);
  doc.text(mid + 16, TY(t + 13), 'TOTAL CURRENT MONTH DEDUCTIONS:', 8, true);
  doc.textR(R - 4, TY(t + 13), fmt0(data.totalDeductions), 9.5, true);
  doc.rule(L, TY(t + grossH), L, TY(t), 1.1); doc.rule(R, TY(t + grossH), R, TY(t), 1.1); doc.rule(mid, TY(t + grossH), mid, TY(t), 1.1);
  t += grossH;

  // ---------- Loan Sanctioned ----------
  const loanTop = t, loanH = 60;
  doc.box(L, TY(loanTop + loanH), W, loanH, 1.1);
  doc.text(L + 4, TY(loanTop + 13), 'LOAN SANCTIONED:', 9, true);
  if (data.loan) {
    doc.textR(L + 150, TY(loanTop + 13), fmt0(data.loan.sanctioned), 9);
    doc.text(L + 170, TY(loanTop + 13), 'Current Month Deduction', 8, true);
    doc.textR(L + 340, TY(loanTop + 13), fmt0(data.loan.currentMonthDeduction), 9);
    doc.text(L + 360, TY(loanTop + 13), 'Total Deduction:', 8, true);
    doc.textR(L + 470, TY(loanTop + 13), fmt0(data.loan.totalDeduction), 9);
    doc.text(L + 4, TY(loanTop + 30), 'Balance:', 8, true);
    doc.textR(L + 150, TY(loanTop + 30), fmt0(data.loan.balance), 9);
  } else {
    doc.text(L + 170, TY(loanTop + 13), 'Current Month Deduction', 8, true, '0.6 0.6 0.6');
    doc.text(L + 360, TY(loanTop + 13), 'Total Deduction:', 8, true, '0.6 0.6 0.6');
    doc.text(L + 4, TY(loanTop + 30), 'Balance:', 8, true, '0.6 0.6 0.6');
  }
  t = loanTop + loanH;

  // ---------- Net Amount Payable ----------
  // Rounded exactly once, then reused for BOTH the headline figure and the
  // spelled-out words — computing amountWords() from the raw unrounded
  // float (e.g. 17741.93) while the figure shows fmt0's rounded 17,742
  // produced a payslip whose own two halves disagreed with each other.
  const netRounded = Math.round(+data.netPayable || 0);
  const netTop = t, netH = 40;
  doc.box(L, TY(netTop + netH), 220, netH, 1.1);
  doc.text(L + 8, TY(netTop + 23), 'NET AMOUNT PAYABLE :', 9.5, true);
  doc.textR(L + 212, TY(netTop + 23), fmt0(netRounded), 11, true);
  doc.box(L + 220, TY(netTop + netH), W - 220, netH, 1.1);
  doc.text(L + 228, TY(netTop + 16), 'In Words :', 8.5, true);
  const words = amountWords(netRounded);
  const wrapped = doc.wrap(words, W - 220 - 90, 8.5, false);
  let wy = netTop + 16;
  wrapped.slice(0, 2).forEach((ln, i) => { doc.text(L + 290, TY(wy), ln, 8.5); wy += 11; });
  t = netTop + netH + 16;

  doc.text(L, TY(t), 'Note :', 8, true, '0.65 0.1 0.1');
  doc.text(L + 40, TY(t), 'This is Electronic Generated Document Does Not Require Signature', 8, false, '0.65 0.1 0.1');

  if (password) doc.encrypt(password);
  return doc.bytes();
}

module.exports = { buildPayslipPdf, amountWords };
