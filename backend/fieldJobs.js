/* ============================================================
   Field-job presence — which ERP employees were "on a field job" on which
   days, worked out from the JLR (Job Log Register) tables.

   READ-ONLY: only SELECTs job_log_entries / job_log_inspector_changes (the
   ISO backend owns and writes those); nothing here alters an ISO table.

   Rules (agreed with HR):
   - A job puts its Inspector Name + Inspector Team on the field for every
     day from Start Date to End Date, Sundays / Saturdays / holidays
     included (the attendance code decides what a leave day overrides).
   - No End Date: the job counts through TODAY, but only while that is safe:
       * a Completion Date, if there is one, is used as the end;
       * status "Completed" with no end at all -> only the start day (the
         real end is unknown, so nothing is invented);
       * a job whose start is more than OPEN_JOB_MAX_DAYS old with still no
         end -> only the start day (a stale, never-finished entry must not
         keep marking people present for years — its End Date needs filling).
   - Mid-job changes, applied in the order they were recorded (id):
       add     -> the person is on the job for [start,end] of the change
       replace -> old person is OFF for [start,end], new person is ON
       remove  -> the person is OFF every day outside [start,end]
                  (start = when they joined the job, end = last day they
                  were on it)
     Nobody is ever on a job outside the job's own start..end window.
   - People are matched to ERP employees by EXACT (case / punctuation /
     spacing-insensitive) full name. A name shared by two employees is
     ambiguous and is skipped rather than guessed; a name with no employee
     (a labourer) simply has no effect on attendance.
   ============================================================ */
'use strict';

const OPEN_JOB_MAX_DAYS = 90;

const pad = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// mysql2 hands DATE columns back as local-midnight Date objects; anything
// else is treated as 'YYYY-MM-DD...' text. Everything below compares plain
// 'YYYY-MM-DD' strings, which sort correctly and can't drift across time zones.
function toYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : localYmd(v);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return localYmd(new Date(y, m - 1, d + n));
}
function daysBetween(a, b) { // b - a, in whole days
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
const maxYmd = (a, b) => (a > b ? a : b);
const minYmd = (a, b) => (a < b ? a : b);

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const splitNames = (s) => String(s || '').split(/[+,;\/\n]|\band\b|&/i).map(normName).filter(Boolean);

// The job's own start..end window, or null when it has none / is unusable.
function effectiveJobRange(job, today) {
  const start = toYmd(job.start_date);
  if (!start) return null;
  const end = toYmd(job.end_date);
  if (end) return end < start ? null : { start, end, open: false };
  const completion = toYmd(job.completion_date);
  if (completion) return completion < start ? null : { start, end: completion, open: false };
  if (String(job.status || '').trim().toLowerCase() === 'completed') return { start, end: start, open: false, unknownEnd: true };
  if (start > today) return null; // hasn't started yet
  if (daysBetween(start, today) > OPEN_JOB_MAX_DAYS) return { start, end: start, open: false, unknownEnd: true, stale: true };
  return { start, end: today, open: true };
}

// Is member `m` (normalized name) on this job on day `d`?
function onJobOn(m, d, range, baseTokens, changes) {
  if (d < range.start || d > range.end) return false;
  let on = baseTokens.has(m);
  for (const c of changes) {
    const cs = toYmd(c.start_date), ce = toYmd(c.end_date);
    if (!cs || !ce) continue;
    const inRange = d >= cs && d <= ce;
    const oldN = normName(c.old_value), newN = normName(c.new_value);
    if (c.change_type === 'add') {
      if (newN === m && inRange) on = true;
    } else if (c.change_type === 'replace') {
      if (oldN === m && inRange) on = false;
      if (newN === m && inRange) on = true;
    } else if (c.change_type === 'remove') {
      if (oldN === m && !inRange) on = false;
    }
  }
  return on;
}

/* Pure core. job: a job_log_entries row; changes: that job's
   job_log_inspector_changes rows in ascending id order; nameToEmp: Map of
   normalized name -> employee id (unique names only). Returns
   Map<empId, string[] of 'YYYY-MM-DD'> for days inside [from, to]. */
function jobPresence(job, changes, today, from, to, nameToEmp) {
  const result = new Map();
  const range = effectiveJobRange(job, today);
  if (!range) return result;
  const ws = maxYmd(range.start, from), we = minYmd(range.end, to);
  if (ws > we) return result;

  const baseTokens = new Set([...splitNames(job.inspector_name), ...splitNames(job.inspector_team)]);
  const members = new Set(baseTokens);
  for (const c of changes) {
    const o = normName(c.old_value), n = normName(c.new_value);
    if (o) members.add(o);
    if (n) members.add(n);
  }
  for (const m of members) {
    const empId = nameToEmp.get(m);
    if (empId == null) continue;
    for (let d = ws; d <= we; d = addDays(d, 1)) {
      if (onJobOn(m, d, range, baseTokens, changes)) {
        if (!result.has(empId)) result.set(empId, new Set());
        result.get(empId).add(d);
      }
    }
  }
  return new Map([...result].map(([id, set]) => [id, [...set].sort()]));
}

// Map of normalized full_name -> employee id, dropping any name that
// belongs to more than one employee (never guess between two people).
function buildNameMap(employees) {
  const seen = new Map();
  const ambiguous = new Set();
  for (const e of employees) {
    const n = normName(e.full_name);
    if (!n) continue;
    if (seen.has(n) && seen.get(n) !== e.id) ambiguous.add(n);
    else seen.set(n, e.id);
  }
  for (const n of ambiguous) seen.delete(n);
  return { nameToEmp: seen, ambiguous: [...ambiguous] };
}

const isMissingTable = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);

/* Loads every relevant job for [from, to] and returns
   { byEmpDate: Map<"empId|YYYY-MM-DD", ref>, ambiguous: [names] }.
   ref = { jobId, client, workOrder, location, open }. */
async function loadFieldPresence(pool, { from, to, employees, today }) {
  const byEmpDate = new Map();
  const todayYmd = today || localYmd(new Date());
  const { nameToEmp, ambiguous } = buildNameMap(employees);
  if (!nameToEmp.size) return { byEmpDate, ambiguous };

  let jobs, changesRows;
  try {
    [jobs] = await pool.query(
      `SELECT id, inspector_name, inspector_team, start_date, end_date, completion_date, status, client, work_order, location
       FROM job_log_entries
       WHERE start_date IS NOT NULL AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY id ASC`,
      [to, from]
    );
    if (!jobs.length) return { byEmpDate, ambiguous };
    [changesRows] = await pool.query(
      `SELECT * FROM job_log_inspector_changes WHERE job_log_id IN (${jobs.map(() => '?').join(',')}) ORDER BY id ASC`,
      jobs.map((j) => j.id)
    );
  } catch (e) {
    if (isMissingTable(e)) return { byEmpDate, ambiguous }; // JLR tables not created on this database — nothing to apply
    throw e;
  }
  const changesByJob = new Map();
  for (const c of changesRows) {
    if (!changesByJob.has(c.job_log_id)) changesByJob.set(c.job_log_id, []);
    changesByJob.get(c.job_log_id).push(c);
  }
  for (const job of jobs) {
    const presence = jobPresence(job, changesByJob.get(job.id) || [], todayYmd, from, to, nameToEmp);
    if (!presence.size) continue;
    const open = !!effectiveJobRange(job, todayYmd)?.open;
    const ref = { jobId: job.id, client: job.client || '', workOrder: job.work_order || '', location: job.location || '', open };
    for (const [empId, days] of presence) {
      for (const d of days) {
        const key = empId + '|' + d;
        if (!byEmpDate.has(key)) byEmpDate.set(key, ref); // first job (lowest id) wins if someone is on two at once
      }
    }
  }
  return { byEmpDate, ambiguous };
}

// July–June financial year containing `ymd`, e.g. 2026-09-21 -> 2026-07-01..2027-06-30 "2026-27".
function financialYearRange(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const startYear = m >= 7 ? y : y - 1;
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30`, label: `${startYear}-${String(startYear + 1).slice(2)}` };
}

module.exports = {
  OPEN_JOB_MAX_DAYS, toYmd, addDays, daysBetween, normName, splitNames,
  effectiveJobRange, jobPresence, buildNameMap, loadFieldPresence, financialYearRange, localYmd,
};
