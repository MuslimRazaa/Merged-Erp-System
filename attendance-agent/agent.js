/* ============================================================
   ERP Attendance Agent — bridges a ZKTeco K70 (office LAN only, no cloud)
   to the Premier ERP backend (internet-hosted).

   Runs on the office VM (same LAN as the K70), NOT on cPanel. Every
   POLL_INTERVAL_SECONDS it:
     1. connects to the K70 over the LAN (TCP port 4370)
     2. asks the device what IT thinks the current time is (CMD_GET_TIME)
        and compares that to this VM's own clock, to work out exactly how
        far off the device's clock is — no guessing, no hardcoded number.
        That correction is applied to every record's timestamp.
     3. reads all punches currently stored on the device, decoding the
        real Check-in/Check-out status the device itself reports (byte 31
        of each 40-byte record — see getAttendancesRaw below), NOT a
        guess. node-zklib's own getAttendances() doesn't expose this byte,
        so this file decodes the raw record itself, matching node-zklib's
        own field offsets for everything else.
     4. reads the device's own user list (getUsers()) so a punch from
        someone not yet added in the ERP can still show their real name
        instead of just a raw ID ("unmapped" employees).
     5. keeps only the punches newer than the last successful sync
        (state.json, next to this file)
     6. POSTs those to the ERP backend's /api/attendance/ingest
     7. only advances the "last synced" mark once the backend confirms —
        so a failed request is retried next poll instead of losing data

   The K70 is never exposed to the internet; only this agent talks to it,
   and only over the office LAN. See README-SETUP.md for how to install
   this as a Windows Service so it survives reboots.
   ============================================================ */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ZKLib = require('node-zklib');
const { REQUEST_DATA, COMMANDS } = require('node-zklib/constants');

const DEVICE_IP = process.env.DEVICE_IP || '192.168.30.64';
const DEVICE_PORT = +(process.env.DEVICE_PORT || 4370);
const POLL_INTERVAL_MS = Math.max(5, +(process.env.POLL_INTERVAL_SECONDS || 20)) * 1000;
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const BACKFILL_ALL = String(process.env.BACKFILL_ALL || '').toLowerCase() === 'true';
// Leave unset (default) to auto-detect the device's clock error every poll
// by asking the device its own idea of the current time (CMD_GET_TIME)
// and comparing to this VM's clock — see detectTimeOffsetHours() below.
// Only set this if auto-detect isn't reliable for some reason (e.g. the
// VM's own clock is also wrong) — then it's used as a fixed override
// instead, in hours, and can be negative.
const MANUAL_TIME_OFFSET_HOURS = process.env.TIME_OFFSET_HOURS === undefined || process.env.TIME_OFFSET_HOURS === ''
  ? null : +process.env.TIME_OFFSET_HOURS;

if (!BACKEND_URL || !AGENT_KEY) {
  console.error('[FATAL] BACKEND_URL and AGENT_KEY must be set in .env (see .env.example).');
  process.exit(1);
}

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { lastSyncTime: null }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ---------------- ZKTeco packed-time decode (documented 24-hour encoding, no AM/PM concept) ---------------- */
function decodeTime(value) {
  let v = value;
  const second = v % 60; v = (v - second) / 60;
  const minute = v % 60; v = (v - minute) / 60;
  const hour = v % 24; v = (v - hour) / 24;
  const day = (v % 31) + 1; v = (v - (day - 1)) / 31;
  const month = v % 12; v = (v - month) / 12;
  const year = v + 2000;
  return new Date(year, month, day, hour, minute, second);
}

/* ---------------- ask the device what time IT thinks it is ---------------- */
async function getDeviceTime(zk) {
  const reply = await zk.zklibTcp.executeCmd(COMMANDS.CMD_GET_TIME, '');
  return decodeTime(reply.readUInt32LE(8));
}

/* ---------------- raw attendance decode (adds the status byte node-zklib drops) ----------------
   40-byte record layout (from the ZK protocol's data-record spec):
     0  uint16LE  user_sn
     2  9 bytes   user_id (ascii, NUL-padded)     <- same as node-zklib's deviceUserId
     26 uint8     verify_type  (0=password, 1=fingerprint, 2=RF card)
     27 uint32LE  record_time  (ZKTeco packed time encoding)
     31 uint8     verify_state (0=Check-in, 1=Check-out, 2=Break-out, 3=Break-in, 4=OT-in, 5=OT-out)
*/
async function getAttendancesRaw(zk) {
  const tcp = zk.zklibTcp;
  if (tcp.socket) await tcp.freeData();
  const data = await tcp.readWithBuffer(REQUEST_DATA.GET_ATTENDANCE_LOGS);
  if (tcp.socket) await tcp.freeData();

  const RECORD_SIZE = 40;
  let buf = data.data.subarray(4);
  const records = [];
  while (buf.length >= RECORD_SIZE) {
    const rec = buf.subarray(0, RECORD_SIZE);
    records.push({
      deviceUserId: rec.subarray(2, 11).toString('ascii').split('\0').shift(),
      verifyType: rec.readUIntLE(26, 1),
      recordTime: decodeTime(rec.readUInt32LE(27)),
      verifyState: rec.readUIntLE(31, 1),
    });
    buf = buf.subarray(RECORD_SIZE);
  }
  return { data: records, err: data.err };
}

async function pollOnce(state) {
  const zk = new ZKLib(DEVICE_IP, DEVICE_PORT, 10000, 4000);
  try {
    await zk.createSocket();
  } catch (e) {
    log(`Could not reach the K70 at ${DEVICE_IP}:${DEVICE_PORT} — ${e.message}. Will retry next poll.`);
    return;
  }

  try {
    // Work out this poll's correction: ask the device its own clock,
    // compare to this VM's clock, round to the nearest whole hour (clock
    // configuration mistakes are almost always whole hours, and rounding
    // avoids jittering minute/second noise into every timestamp).
    let offsetHours = 0;
    if (MANUAL_TIME_OFFSET_HOURS !== null) {
      offsetHours = MANUAL_TIME_OFFSET_HOURS;
    } else {
      try {
        const deviceNow = await getDeviceTime(zk);
        offsetHours = Math.round((Date.now() - deviceNow.getTime()) / 3600000);
        if (offsetHours) log(`Device clock is off by ${offsetHours}h vs this VM (device says ${deviceNow.toString()}) — auto-correcting.`);
      } catch (e) {
        log(`Could not read the device's clock (CMD_GET_TIME failed: ${e.message}) — leaving timestamps uncorrected this poll.`);
      }
    }

    const { data: records, err } = await getAttendancesRaw(zk);
    if (err) log(`Device reported a partial-read warning: ${err.message || err}`);
    if (offsetHours) records.forEach((r) => { r.recordTime = new Date(r.recordTime.getTime() + offsetHours * 3600000); });

    // First-ever run: establish a baseline instead of flooding the backend
    // with the device's entire history (unless BACKFILL_ALL=true).
    if (!state.lastSyncTime && !BACKFILL_ALL) {
      const latest = records.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), new Date(0));
      state.lastSyncTime = (records.length ? latest : new Date()).toISOString();
      saveState(state);
      log(`First run — baseline set to ${state.lastSyncTime} (existing ${records.length} punches on the device were NOT imported). Set BACKFILL_ALL=true and delete state.json to import full history instead.`);
      return;
    }

    const since = state.lastSyncTime ? new Date(state.lastSyncTime) : new Date(0);
    const fresh = records.filter((r) => r.recordTime > since);
    if (!fresh.length) { log(`No new punches (device has ${records.length} total).`); return; }

    // Names registered directly on the device — so a punch from someone
    // not yet added in the ERP still shows a real name (flagged
    // "unmapped" on the ERP screen), not just a raw ID. Only bother
    // fetching when there's actually something new to push.
    let nameByDeviceId = {};
    try {
      const { data: users } = await zk.getUsers();
      nameByDeviceId = Object.fromEntries(users.map((u) => [u.userId, u.name]));
    } catch (e) {
      log(`Could not read the device's user list (names will be blank for unmapped punches): ${e.message}`);
    }

    const punches = fresh.map((r) => ({
      deviceUserId: r.deviceUserId,
      deviceUserName: nameByDeviceId[r.deviceUserId] || null,
      timestamp: r.recordTime.toISOString(),
      verifyMode: r.verifyType,
      inOutMode: r.verifyState,
    }));

    const res = await fetch(`${BACKEND_URL}/api/attendance/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': AGENT_KEY },
      body: JSON.stringify({ punches }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { log(`Backend rejected the push (HTTP ${res.status}): ${body.error || res.statusText}. Will retry next poll.`); return; }

    const latest = fresh.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), since);
    state.lastSyncTime = latest.toISOString();
    saveState(state);
    log(`Pushed ${fresh.length} punch(es) — saved=${body.saved} skipped(duplicates)=${body.skipped}. Latest: ${latest.toString()}`);
  } catch (e) {
    log(`Poll failed: ${e.message}. Will retry next poll.`);
  } finally {
    try { await zk.disconnect(); } catch (e) { /* already gone */ }
  }
}

async function loop() {
  const state = loadState();
  await pollOnce(state);
  setTimeout(loop, POLL_INTERVAL_MS);
}

log(`ERP Attendance Agent starting — device ${DEVICE_IP}:${DEVICE_PORT}, backend ${BACKEND_URL}, polling every ${POLL_INTERVAL_MS / 1000}s.`);
loop();
