/* ============================================================
   Systems-automatic attendance entry — records a single attendance event
   for an employee at a given date/time.

   Pushes through the SAME /api/attendance/ingest endpoint the K70 agent
   itself uses (same AGENT_KEY, same backend), so this entry behaves
   identically to a device-scanned one everywhere — dedup, Late/On-time
   calculation, Attendance Report, payroll — no different from any other
   attendance record.

   Usage (run from this folder, C:\erp-attendance-agent on the live VM):
     node systems-automatic.js <employeeId> <YYYY-MM-DD> <HH:MM[:SS]> [in|out]

   Examples:
     node systems-automatic.js 1878 2026-09-18 09:05 in
     node systems-automatic.js 1878 2026-09-18 17:30 out
     node systems-automatic.js 1878 2026-09-18 09:05
       (no in/out given — backend alternates 1st entry that day = in,
        2nd = out, same as it always has for older records)
   ============================================================ */
'use strict';
require('dotenv').config();

const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';

function usage() {
  console.log(`
Usage: node systems-automatic.js <employeeId> <YYYY-MM-DD> <HH:MM[:SS]> [in|out]

  employeeId   The employee's ID exactly as enrolled on the K70 / in the ERP
               (e.g. 1878) — this is how the entry gets linked to them.
  YYYY-MM-DD   Date of the entry, e.g. 2026-09-18
  HH:MM[:SS]   Time of the entry, 24-hour, e.g. 09:05 or 09:05:30
  in|out       Optional — "in" for Check-in, "out" for Check-out.
               If omitted, the backend guesses (1st entry that day = in,
               2nd = out, alternating) same as it does for older records.

Example:
  node systems-automatic.js 1878 2026-09-18 09:05 in
`);
}

if (!BACKEND_URL || !AGENT_KEY) {
  console.error('[FATAL] BACKEND_URL and AGENT_KEY must be set in .env (the same .env agent.js already uses).');
  process.exit(1);
}

const [, , employeeId, dateArg, timeArg, typeArg] = process.argv;

if (!employeeId || !dateArg || !timeArg) { usage(); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) { console.error(`"${dateArg}" isn't YYYY-MM-DD.`); usage(); process.exit(1); }
if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeArg)) { console.error(`"${timeArg}" isn't HH:MM or HH:MM:SS (24-hour).`); usage(); process.exit(1); }

const timeFull = timeArg.length === 5 ? timeArg + ':00' : timeArg;
const timestamp = new Date(`${dateArg}T${timeFull}`);
if (isNaN(timestamp.getTime())) { console.error(`"${dateArg} ${timeArg}" isn't a real date/time.`); process.exit(1); }

let inOutMode = null;
if (typeArg) {
  const t = typeArg.toLowerCase();
  if (t === 'in') inOutMode = 0;
  else if (t === 'out') inOutMode = 1;
  else { console.error(`The 4th argument must be "in" or "out" (got "${typeArg}").`); usage(); process.exit(1); }
}

(async () => {
  const punches = [{
    deviceUserId: String(employeeId).trim(),
    deviceUserName: null,
    timestamp: timestamp.toISOString(),
    verifyMode: null,
    inOutMode,
    // No `location` tag here on purpose — this entry must look and behave
    // exactly like a device-scanned punch everywhere in the ERP (same as
    // the frontend already shows for a day with no location data at all).
  }];

  const label = inOutMode === 0 ? 'Check-in' : inOutMode === 1 ? 'Check-out' : 'auto in/out';
  console.log(`Recording attendance — employee ${employeeId}, ${timestamp.toString()} (${label})...`);

  try {
    const res = await fetch(`${BACKEND_URL}/api/attendance/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_KEY },
      body: JSON.stringify({ punches }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`Backend rejected it (HTTP ${res.status}): ${body.error || res.statusText}`);
      process.exit(1);
    }
    if (body.saved) {
      console.log(`Saved. It'll show up in Live Attendance / Attendance Report right away.`);
    } else {
      console.log(`Backend says saved=0, skipped=${body.skipped} — an entry for this exact employee at this exact second already exists (duplicate), so nothing new was added.`);
    }
  } catch (e) {
    console.error(`Could not reach the backend (${BACKEND_URL}): ${e.message}`);
    process.exit(1);
  }
})();
