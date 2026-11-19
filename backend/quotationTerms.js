/* ============================================================
   Default Quotation "General Terms and Conditions" template.

   Each bold paragraph is a sub-heading; on the quotation PDF they print
   as 3.1, 3.2 ... under Section 3 and are listed in the Table of
   Contents. Every other paragraph prints as one bullet under the heading
   above it. The template stays editable (CRM > Quotations > Terms
   Template); this is only the starting text.

   The payment sentence ("All payments to PTIS shall be made by direct
   transfer within N days ...") is the one a quotation's Payment Terms
   dropdown swaps out on that quotation's PDF.
   ============================================================ */
'use strict';

const PAYMENT_SENTENCE_RE = /All payments to PTIS shall be made by direct transfer[^.<]*\./i;
const DEFAULT_PAYMENT_SENTENCE = 'All payments to PTIS shall be made by direct transfer within 90 days from the day of the submission of all invoices.';

function quotationTermsHtml(paymentSentence) {
  return (
    '<p><b>Invoicing and Payment</b></p>' +
    '<p>PTIS will issue invoice after the completion of job attached with all supporting documentation and delivery notes and will submit to the finance department.</p>' +
    `<p>${paymentSentence || DEFAULT_PAYMENT_SENTENCE}</p>` +
    '<p>General Sales Tax shall be added on top of the invoice amount (as all prices are exclusive of GST).</p>' +
    '<p><b>Client Responsibilities</b></p>' +
    "<p>Client shall provide PTIS team with accommodation and meals, which shall be of the standard as applicable to customer's own senior staff.</p>" +
    '<p>Proof loads, crane, fork lifter and other accessories for load testing, pipe racks, handling and dope to be supplied by the client.</p>' +
    '<p>Client to support our services by providing forklift, air pump and power supply for onsite jobs.</p>' +
    '<p>Client must give a minimum notice of 24 hours before the start of the job.</p>' +
    '<p><b>Deliverables and Working Conditions</b></p>' +
    '<p>PTIS shall provide two signed and stamped original hard copies of the inspection report upon completion of the job.</p>' +
    '<p>Day is considered as maximum of 10 working hours.</p>' +
    '<p>All Covid-19 protocols shall be adhered to as per the client policy but any charges shall be charged back to the client at actual along with proof.</p>' +
    '<p><b>Removal of Equipment / Grease</b></p>' +
    '<p>The client is responsible for safely disassembling or removing any equipment, grease, or unwanted compounds that are attached to the equipment or plant that requires calibration.</p>' +
    '<p>The client should ensure that the equipment is in a safe and suitable condition for calibration, including ensuring that all relevant accessories or attachments are in place.</p>' +
    '<p><b>Functional Testing</b></p>' +
    "<p>Prior to calibration, the PTIS calibration team will conduct a functional test of the equipment in the presence of the client's representative.</p>" +
    '<p>The purpose of this test is to ensure that the equipment is in working order and its functional / operating parameters are within the standard for testing and measurement.</p>' +
    '<p>Any discrepancies or issues identified during the functional testing will be reported to the client for necessary corrective actions.</p>'
  );
}

module.exports = {
  PAYMENT_SENTENCE_RE,
  DEFAULT_TERMS_HTML: quotationTermsHtml(),
  quotationTermsHtml,
};
