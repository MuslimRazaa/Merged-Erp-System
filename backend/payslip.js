/* ============================================================
   Payslip PDF — "Premium Gradient" template: a navy-to-red gradient
   header with the company mark and a PAY SLIP badge, sitting above a
   white rounded card with employee info, an Allowances|Deductions grid,
   Loan Sanctioned and a highlighted Net Amount Payable box.

   Pure data in, PDF bytes out — buildPayslipPdf() doesn't touch the
   database itself, so it's reusable for both the single-employee
   download and the bulk "Send Payslips" email job (routes/payroll.js
   assembles the data object from the saved payroll run + current
   profile/loan lookups, this just lays it out).
   ============================================================ */
'use strict';
const { PdfDoc } = require('./pdfDoc');

const WO_CO_NAME_1 = 'PREMIER TUBULAR';
const WO_CO_NAME_2 = 'INSPECTION SERVICES (PVT.) LTD';
const WO_TAGLINE = 'THE STRONGEST LINK';

// Brand palette — same navy/red already used elsewhere in the ERP's own UI
// (public/index.html's --side / --rose CSS variables), so the payslip
// matches the app it comes from rather than inventing a new palette.
const NAVY = '#0B1524';
const NAVY_2 = '#1A2A3F';
const RED = '#C2372B';
const RED_DARK = '#8E1F1A';
const PAGE_BG = '#EEF1F6';
const CARD_BG = '#FFFFFF';
const ROW_ALT = '#F6F8FB';
const INK = '#16202E';
const SOFT = '#6B7A90';
const NET_BG = '#FBEAE8';

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
  const L = 40, R = doc.w - 40, W = R - L;
  const TY = t => doc.h - t;

  // ---------- page background ----------
  doc.rect(0, 0, doc.w, doc.h, PAGE_BG);

  // ---------- gradient header ----------
  const headerH = 128;
  doc.gradientH(0, doc.h - headerH, doc.w, headerH, NAVY, RED, 60);
  // a diagonal accent wedge layered over the gradient, same visual trick
  // the reference template uses to break up the flat gradient
  doc.polygon([
    [doc.w * 0.52, doc.h],
    [doc.w, doc.h],
    [doc.w, doc.h - headerH],
    [doc.w * 0.78, doc.h - headerH],
  ], RED_DARK);

  // logo mark
  doc.roundedRect(L, doc.h - 36 - 56, 56, 56, 14, '#FFFFFF');
  doc.textC(L + 28, doc.h - 36 - 56 + 20, 'PT', 20, true, NAVY);

  // company name + tagline
  const nameX = L + 70;
  doc.text(nameX, TY(42), WO_CO_NAME_1, 15, true, '#FFFFFF');
  doc.text(nameX, TY(59), WO_CO_NAME_2, 11, true, '#FFFFFF');
  doc.text(nameX, TY(76), WO_TAGLINE, 7.5, false, '#E7CFCB');

  // PAY SLIP badge, top-right
  const badgeW = 150, badgeH = 42;
  doc.roundedRect(R - badgeW, doc.h - 28 - badgeH, badgeW, badgeH, 10, NAVY_2);
  doc.textC(R - badgeW / 2, TY(44), 'PAY SLIP', 11, true, '#FFFFFF');
  doc.textC(R - badgeW / 2, TY(58), String(data.monthLabel || '').toUpperCase(), 8.5, false, '#D8DEE8');

  // ---------- white card ----------
  const cardTop = headerH + 8; // distance from top of page
  const cardBottomMargin = 40;
  const cardH = doc.h - cardTop - cardBottomMargin;
  doc.roundedRect(L, cardBottomMargin, W, cardH, { tl: 16, tr: 16, bl: 0, br: 0 }, CARD_BG);

  let t = cardTop + 28;

  // "EMPLOYEE INFORMATION" + "N DAYS WORKED" pill
  doc.text(L + 24, TY(t), 'EMPLOYEE INFORMATION', 11.5, true, NAVY);
  const daysLabel = (data.daysWorked == null ? '' : data.daysWorked) + ' DAYS WORKED';
  const pillW = Math.max(110, doc.twx(daysLabel, 8, true) + 28);
  doc.roundedRect(R - 24 - pillW, doc.h - t - 10, pillW, 20, 10, RED);
  doc.textC(R - 24 - pillW / 2, TY(t + 4), daysLabel, 8, true, '#FFFFFF');
  t += 16;
  doc.rule(L + 24, TY(t), R - 24, TY(t), 0.6, '#D6DCE6');
  t += 18;

  // employee info rows, zebra-striped
  const infoRows = [
    ['Employee Code', data.employeeCode],
    ['Name', data.name],
    ['Date of Joining', data.dateOfJoining],
    ['Designation', data.designation],
    ['Department', data.department],
    ['Bank Name', data.bankName],
    ['Bank Account No.', data.bankAccountNo],
  ];
  const rowH = 20;
  infoRows.forEach(([label, value], i) => {
    if (i % 2 === 0) doc.rect(L + 24, TY(t + 15), W - 48, rowH, ROW_ALT);
    doc.text(L + 32, TY(t + 10), label, 8.5, false, SOFT);
    doc.text(L + 220, TY(t + 10), String(value || ''), 9, true, INK);
    t += rowH;
  });
  t += 20;

  // "PAY & DEDUCTIONS" heading with a short red accent bar
  doc.rect(L + 24, TY(t + 10), 3, 12, RED);
  doc.text(L + 34, TY(t), 'PAY & DEDUCTIONS', 11.5, true, NAVY);
  t += 18;

  // column header row
  const colW = (W - 48) / 2;
  const hdrH = 20;
  doc.rect(L + 24, TY(t + hdrH), W - 48, hdrH, '#F0F3F8');
  doc.text(L + 32, TY(t + 14), 'ALLOWANCES', 8.5, true, SOFT);
  doc.textR(L + 24 + colW - 90, TY(t + 14), 'STANDARD', 7.5, true, SOFT);
  doc.textR(L + 24 + colW - 8, TY(t + 14), 'PAYABLE', 7.5, true, SOFT);
  doc.text(L + 24 + colW + 8, TY(t + 14), 'DEDUCTIONS', 8.5, true, SOFT);
  doc.textR(R - 24, TY(t + 14), 'AMOUNT', 7.5, true, SOFT);
  t += hdrH;

  const allowances = data.allowances || [];
  const deductions = data.deductions || [];
  const lineCount = Math.max(allowances.length, deductions.length, 1);
  for (let i = 0; i < lineCount; i++) {
    if (i % 2 === 1) doc.rect(L + 24, TY(t + 18), W - 48, 18, ROW_ALT);
    const a = allowances[i];
    if (a) {
      doc.text(L + 32, TY(t + 12), a.label, 8.5, false, INK);
      doc.textR(L + 24 + colW - 90, TY(t + 12), fmt(a.standard), 8.5, false, INK);
      doc.textR(L + 24 + colW - 8, TY(t + 12), fmt(a.payable), 8.5, true, INK);
    }
    const d = deductions[i];
    if (d) {
      doc.text(L + 24 + colW + 8, TY(t + 12), d.label, 8.5, false, INK);
      doc.textR(R - 24, TY(t + 12), fmt0(d.amount), 8.5, true, INK);
    }
    t += 18;
  }
  t += 16;

  // GROSS PAY / TOTAL DEDUCTIONS
  doc.text(L + 24, TY(t), 'GROSS PAY', 8.5, true, SOFT);
  doc.text(L + 24 + colW + 8, TY(t), 'TOTAL DEDUCTIONS', 8.5, true, SOFT);
  t += 16;
  doc.text(L + 24, TY(t), fmt0(data.grossPayable), 14, true, NAVY);
  doc.text(L + 24 + colW + 8, TY(t), fmt0(data.totalDeductions), 14, true, NAVY);
  t += 26;

  // ---------- Loan Sanctioned ----------
  const loanH = 56;
  doc.roundedRect(L + 24, doc.h - t - loanH, W - 48, loanH, 10, '#F3F5F9');
  doc.rect(L + 24, doc.h - t - loanH, 4, loanH, RED);
  doc.text(L + 38, TY(t + 16), 'LOAN SANCTIONED', 9, true, NAVY);
  doc.textR(L + 38 + 150, TY(t + 16), data.loan ? fmt0(data.loan.sanctioned) : '—', 9, true, INK);
  const loanColW = (W - 48 - 190) / 3;
  const loanColX = L + 220;
  const loanCols = [
    ['Current Month Deduction', data.loan ? fmt0(data.loan.currentMonthDeduction) : '—'],
    ['Total Deduction', data.loan ? fmt0(data.loan.totalDeduction) : '—'],
    ['Balance', data.loan ? fmt0(data.loan.balance) : '—'],
  ];
  loanCols.forEach(([label, value], i) => {
    const cx = loanColX + i * loanColW;
    doc.text(cx, TY(t + 16), label, 7.5, false, SOFT);
    doc.text(cx, TY(t + 32), value, 10, true, INK);
  });
  t += loanH + 18;

  // ---------- Net Amount Payable ----------
  const netRounded = Math.round(+data.netPayable || 0);
  const netH = 46;
  doc.roundedRect(L + 24, doc.h - t - netH, W - 48, netH, 10, NET_BG);
  doc.rect(L + 24, doc.h - t - netH, 4, netH, RED);
  doc.text(L + 38, TY(t + 19), 'NET AMOUNT PAYABLE', 10, true, NAVY);
  doc.text(L + 38, TY(t + 34), 'PKR', 8.5, false, SOFT);
  doc.textR(R - 24, TY(t + 30), fmt0(netRounded), 22, true, RED);
  t += netH + 20;

  // ---------- footer ----------
  doc.rule(L + 24, TY(t), R - 24, TY(t), 0.5, '#D6DCE6');
  t += 14;
  doc.text(L + 24, TY(t), 'This is an electronically generated document and does not require a signature.', 7.5, false, SOFT);
  doc.textR(R - 24, TY(t), 'PTIS • PAYROLL', 7.5, true, SOFT);

  if (password) doc.encrypt(password);
  return doc.bytes();
}

module.exports = { buildPayslipPdf, amountWords };
