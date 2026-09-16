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

const POLL_INTERVAL_MS = Math.max(5, +(process.env.POLL_INTERVAL_SECONDS || 20)) * 1000;
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.AGENT_KEY || '';
const BACKFILL_ALL = String(process.env.BACKFILL_ALL || '').toLowerCase() === 'true';
// Only matters on a device's very first run (no state file yet). Import
// everything from this date onward instead of either "nothing existing"
// (the default) or "absolutely everything ever" (BACKFILL_ALL=true).
// e.g. BACKFILL_SINCE=2026-08-21 — only takes effect if BACKFILL_ALL isn't
// also set (BACKFILL_ALL wins, since it means "literally all of it").
let BACKFILL_SINCE = null;
if (!BACKFILL_ALL && process.env.BACKFILL_SINCE) {
  const d = new Date(process.env.BACKFILL_SINCE);
  if (isNaN(d.getTime())) console.error(`[WARN] BACKFILL_SINCE="${process.env.BACKFILL_SINCE}" isn't a valid date (use YYYY-MM-DD) — ignoring it.`);
  else BACKFILL_SINCE = d;
}
// Leave unset (default) to auto-detect the device's clock error every poll
// by asking the device its own idea of the current time (CMD_GET_TIME)
// and comparing to this VM's clock — see detectTimeOffsetHours() below.
// Only set this if auto-detect isn't reliable for some reason (e.g. the
// VM's own clock is also wrong) — then it's used as a fixed override
// instead, in hours, and can be negative. Applies to every device.
const MANUAL_TIME_OFFSET_HOURS = process.env.TIME_OFFSET_HOURS === undefined || process.env.TIME_OFFSET_HOURS === ''
  ? null : +process.env.TIME_OFFSET_HOURS;

if (!BACKEND_URL || !AGENT_KEY) {
  console.error('[FATAL] BACKEND_URL and AGENT_KEY must be set in .env (see .env.example).');
  process.exit(1);
}

// One agent process can poll several K70s (one per office) — each gets its
// own IP/port and its own state.json-equivalent so their "last synced"
// marks never collide. Device 1 keeps using the original, unnumbered
// DEVICE_IP/DEVICE_PORT/state.json (so an existing .env — e.g. the
// Karachi machine already deployed — needs zero changes); every device
// after that is added purely by appending DEVICE_2_IP, DEVICE_3_IP, ...
// to the same .env, nothing existing is touched.
function slugify(name, fallback) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;
}
function parseDevices() {
  const devices = [];
  if (process.env.DEVICE_IP || !process.env.DEVICE_1_IP) {
    devices.push({
      name: process.env.DEVICE_NAME || 'Device 1',
      ip: process.env.DEVICE_IP || '192.168.30.64',
      port: +(process.env.DEVICE_PORT || 4370),
      stateFile: path.join(__dirname, 'state.json'),
    });
  }
  if (process.env.DEVICE_1_IP && !process.env.DEVICE_IP) {
    devices.push({
      name: process.env.DEVICE_1_NAME || 'Device 1',
      ip: process.env.DEVICE_1_IP,
      port: +(process.env.DEVICE_1_PORT || 4370),
      stateFile: path.join(__dirname, `state-${slugify(process.env.DEVICE_1_NAME || 'device-1', 'device-1')}.json`),
    });
  }
  let i = 2; // device 1 (whichever form it took) is always already pushed above
  while (process.env[`DEVICE_${i}_IP`]) {
    const name = process.env[`DEVICE_${i}_NAME`] || `Device ${i}`;
    devices.push({
      name,
      ip: process.env[`DEVICE_${i}_IP`],
      port: +(process.env[`DEVICE_${i}_PORT`] || 4370),
      stateFile: path.join(__dirname, `state-${slugify(name, `device-${i}`)}.json`),
    });
    i++;
  }
  return devices;
}

function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (e) { return { lastSyncTime: null }; }
}
function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
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

async function pollOnce(device, state) {
  const tag = device.name;
  const zk = new ZKLib(device.ip, device.port, 10000, 4000);
  try {
    await zk.createSocket();
  } catch (e) {
    log(tag, `Could not reach the K70 at ${device.ip}:${device.port} — ${e.message}. Will retry next poll.`);
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
        if (offsetHours) log(tag, `Device clock is off by ${offsetHours}h vs this VM (device says ${deviceNow.toString()}) — auto-correcting.`);
      } catch (e) {
        log(tag, `Could not read the device's clock (CMD_GET_TIME failed: ${e.message}) — leaving timestamps uncorrected this poll.`);
      }
    }

    const { data: records, err } = await getAttendancesRaw(zk);
    if (err) log(tag, `Device reported a partial-read warning: ${err.message || err}`);
    if (offsetHours) records.forEach((r) => { r.recordTime = new Date(r.recordTime.getTime() + offsetHours * 3600000); });

    // First-ever run (no state file yet): default is a baseline only —
    // nothing existing on the device gets imported, to avoid flooding the
    // backend with old history on day one. BACKFILL_ALL=true imports
    // literally everything; BACKFILL_SINCE=YYYY-MM-DD imports only from
    // that date onward (e.g. "give me data from 21 August onward").
    let since;
    if (!state.lastSyncTime) {
      if (BACKFILL_ALL) since = new Date(0);
      else if (BACKFILL_SINCE) since = BACKFILL_SINCE;
      else {
        const latest = records.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), new Date(0));
        state.lastSyncTime = (records.length ? latest : new Date()).toISOString();
        saveState(device.stateFile, state);
        log(tag, `First run — baseline set to ${state.lastSyncTime} (existing ${records.length} punches on the device were NOT imported). Set BACKFILL_ALL=true (everything) or BACKFILL_SINCE=YYYY-MM-DD (from a specific date), delete ${path.basename(device.stateFile)}, and restart to import history instead.`);
        return;
      }
    } else {
      since = new Date(state.lastSyncTime);
    }

    const fresh = records.filter((r) => r.recordTime > since);
    if (!fresh.length) { log(tag, `No new punches (device has ${records.length} total).`); return; }

    // Names registered directly on the device — so a punch from someone
    // not yet added in the ERP still shows a real name (flagged
    // "unmapped" on the ERP screen), not just a raw ID. Only bother
    // fetching when there's actually something new to push.
    let nameByDeviceId = {};
    try {
      const { data: users } = await zk.getUsers();
      nameByDeviceId = Object.fromEntries(users.map((u) => [u.userId, u.name]));
    } catch (e) {
      log(tag, `Could not read the device's user list (names will be blank for unmapped punches): ${e.message}`);
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
    if (!res.ok) { log(tag, `Backend rejected the push (HTTP ${res.status}): ${body.error || res.statusText}. Will retry next poll.`); return; }

    const latest = fresh.reduce((max, r) => (r.recordTime > max ? r.recordTime : max), since);
    state.lastSyncTime = latest.toISOString();
    saveState(device.stateFile, state);
    log(tag, `Pushed ${fresh.length} punch(es) — saved=${body.saved} skipped(duplicates)=${body.skipped}. Latest: ${latest.toString()}`);
  } catch (e) {
    log(tag, `Poll failed: ${e.message}. Will retry next poll.`);
  } finally {
    try { await zk.disconnect(); } catch (e) { /* already gone */ }
  }
}

async function loop(devices) {
  // sequential, not parallel — keeps log output readable and avoids piling
  // up concurrent TCP sessions if one device is slow/unreachable.
  for (const device of devices) {
    const state = loadState(device.stateFile);
    await pollOnce(device, state);
  }
  setTimeout(() => loop(devices), POLL_INTERVAL_MS);
}

const DEVICES = parseDevices();
if (!DEVICES.length) {
  console.error('[FATAL] No device configured — set DEVICE_IP (or DEVICE_1_IP) in .env.');
  process.exit(1);
}
console.log(`[${new Date().toISOString()}] ERP Attendance Agent starting — ${DEVICES.length} device(s): ` +
  DEVICES.map((d) => `${d.name} (${d.ip}:${d.port})`).join(', ') +
  ` — backend ${BACKEND_URL}, polling every ${POLL_INTERVAL_MS / 1000}s.`);
loop(DEVICES);
