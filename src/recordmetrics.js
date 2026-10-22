'use strict';
// Aggregate, anonymous gauges about the stored student records, for Prometheus/Grafana.
// Runs on the BACKUP pod (it holds every record). No names, reg numbers or logins are ever emitted:
// only counts and averages per shard, so label cardinality is small and fixed.
const GENDERS = ['Female', 'Male', 'Other'];
const COURSES = ['CSE', 'IT', 'AI & DS', 'ECE', 'EEE', 'Mechanical', 'Civil'];
const RESIDENCES = ['Hostel', 'Day scholar'];
const AGE_BANDS = [['16-17', 16, 17], ['18', 18, 18], ['19', 19, 19], ['20', 20, 20], ['21', 21, 21], ['22', 22, 22], ['23', 23, 23], ['24+', 24, 99]];
const MARK_BANDS = [['0-39', 0, 40], ['40-59', 40, 60], ['60-79', 60, 80], ['80-100', 80, 101]];

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (n) => Math.round(n * 100) / 100;

function render(S) {
  const byShard = new Map(); // route -> { accounts, rows[] }
  const slot = (route) => { if (!byShard.has(route)) byShard.set(route, { accounts: 0, rows: [] }); return byShard.get(route); };
  for (const s of S.shards || []) slot(s.name); // a shard with no records still shows up as 0
  for (const [login, route] of Object.entries(S.routes || {})) slot(route).accounts++;
  for (const [login, list] of Object.entries(S.data || {})) {
    const route = (S.routes && S.routes[login]) || 'unassigned';
    slot(route).rows.push(...list);
  }

  const out = [];
  const gauge = (name, help) => { out.push(`# HELP ${name} ${help}`); out.push(`# TYPE ${name} gauge`); };
  const line = (name, labels, v) => out.push(`${name}{${Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',')}} ${v}`);
  const dim = (name, help, keys, get) => {
    gauge(name, help);
    for (const [shard, d] of byShard) for (const k of keys) line(name, { shard, [name.split('_by_')[1]]: k }, d.rows.filter((r) => get(r) === k).length);
  };

  gauge('vle7_records', 'Student records held per shard.');
  for (const [shard, d] of byShard) line('vle7_records', { shard }, d.rows.length);
  gauge('vle7_accounts', 'Accounts routed to each shard.');
  for (const [shard, d] of byShard) line('vle7_accounts', { shard }, d.accounts);

  dim('vle7_records_by_gender', 'Records by gender (Unknown = not filled in).', [...GENDERS, 'Unknown'], (r) => (GENDERS.includes(r.gender) ? r.gender : 'Unknown'));
  dim('vle7_records_by_course', 'Records by course (Unknown = not filled in).', [...COURSES, 'Unknown'], (r) => (COURSES.includes(r.course) ? r.course : 'Unknown'));
  dim('vle7_records_by_year', 'Records by year of study (0 = not filled in).', ['0', '1', '2', '3', '4'], (r) => String(Number.isInteger(r.year) ? r.year : 0));
  dim('vle7_records_by_residence', 'Records by residence (Unknown = not filled in).', [...RESIDENCES, 'Unknown'], (r) => (RESIDENCES.includes(r.residence) ? r.residence : 'Unknown'));
  gauge('vle7_records_by_age', 'Records by age band (students without an age are not counted here).');
  for (const [shard, d] of byShard) for (const [band, lo, hi] of AGE_BANDS) line('vle7_records_by_age', { shard, age: band }, d.rows.filter((r) => Number.isInteger(r.age) && r.age >= lo && r.age <= hi).length);
  gauge('vle7_records_by_marks', 'Records by marks band (percent).');
  for (const [shard, d] of byShard) for (const [band, lo, hi] of MARK_BANDS) line('vle7_records_by_marks', { shard, marks: band }, d.rows.filter((r) => r.marks >= lo && r.marks < hi).length);

  gauge('vle7_marks_avg', 'Average marks percent per shard.');
  for (const [shard, d] of byShard) if (d.rows.length) line('vle7_marks_avg', { shard }, r2(avg(d.rows.map((r) => r.marks))));
  gauge('vle7_attendance_avg', 'Average attendance percent per shard.');
  for (const [shard, d] of byShard) if (d.rows.length) line('vle7_attendance_avg', { shard }, r2(avg(d.rows.map((r) => r.attendance))));
  gauge('vle7_records_low_attendance', 'Records under 75 percent attendance, per shard.');
  for (const [shard, d] of byShard) line('vle7_records_low_attendance', { shard }, d.rows.filter((r) => r.attendance < 75).length);
  gauge('vle7_marks_avg_by_course', 'Average marks percent per shard and course (only courses that have records).');
  for (const [shard, d] of byShard) for (const c of COURSES) {
    const l = d.rows.filter((r) => r.course === c);
    if (l.length) line('vle7_marks_avg_by_course', { shard, course: c }, r2(avg(l.map((r) => r.marks))));
  }
  return out.join('\n') + '\n';
}

module.exports = { render };
