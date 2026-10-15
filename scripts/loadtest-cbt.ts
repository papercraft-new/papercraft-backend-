/**
 * CBT load test: N students start a test, answer with autosave, then ALL submit at the same moment.
 *
 *   npx tsx scripts/loadtest-cbt.ts --code ABCD1234 --students 300
 *   npx tsx scripts/loadtest-cbt.ts --code ABCD1234 --cleanup-only
 *
 * Options
 *   --code <code>          the test's 8-character code (required). Use a throwaway test.
 *   --students <n>         how many fake students (default 200)
 *   --base <url>           API base (default http://localhost:4000/api)
 *   --concurrency <n>      students entering at once (default 50)
 *   --saves <n>            autosave calls per student before submit (default 3)
 *   --cleanup              afterwards, delete the fake "LoadTest" attempts of this test (needs DATABASE_URL)
 *   --cleanup-only         only delete them, send no traffic
 *   --allow-remote         needed to run against anything but localhost. Do not point this at production.
 *
 * Every fake student answers option label "a" on every question, so with a fixed answer pattern all of
 * them must end with the SAME score (even with shuffling on). Different scores mean a grading bug.
 * Rate limits apply as in production: raise PUBLIC_ENTRY_PER_MIN / PUBLIC_IP_PER_MIN on the test
 * server for more than ~500 students from one machine.
 */

type Json = any;

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (name: string) => args.includes(`--${name}`);

const BASE = (opt('base', process.env.LOADTEST_BASE || 'http://localhost:4000/api') as string).replace(/\/+$/, '');
const CODE = String(opt('code', '') || '').toLowerCase();
const N = Math.max(1, parseInt(opt('students', '200') as string, 10) || 200);
const CONC = Math.max(1, parseInt(opt('concurrency', '50') as string, 10) || 50);
const SAVES = Math.max(0, parseInt(opt('saves', '3') as string, 10) || 0);
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

const lat: Record<string, number[]> = {};
const statuses: Record<string, Record<string, number>> = {};
const errors: string[] = [];
let leaks = 0;

function pct(arr: number[], p: number) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function call(phase: string, method: string, path: string, body?: Json, token?: string): Promise<{ status: number; json: Json }> {
  const t0 = performance.now();
  let status = 0;
  let json: Json = null;
  try {
    const res = await fetch(`${BASE}/public/tests${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Attempt-Token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
    if (phase === 'load' && /"isCorrect"|"correct"/.test(text)) leaks++;
  } catch (err) {
    status = 0;
    json = { error: String((err as Error)?.message || err) };
  }
  (lat[phase] ||= []).push(performance.now() - t0);
  const k = String(status);
  ((statuses[phase] ||= {})[k] = (statuses[phase][k] || 0) + 1);
  if (status !== 200 && !phase.startsWith('dup') && errors.length < 12) errors.push(`${phase} ${method} ${path} -> ${status} ${json?.code || ''} ${json?.error || ''}`.trim());
  return { status, json };
}

async function pool<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

async function cleanup() {
  try { await import('dotenv/config' as string); } catch { /* optional */ }
  const { prisma } = await import('../src/utils/prisma');
  const r = await prisma.attempt.deleteMany({ where: { test: { code: CODE }, name: { startsWith: 'LoadTest' } } });
  console.log(`Cleanup: deleted ${r.count} LoadTest attempt(s) of test ${CODE}.`);
  await prisma.$disconnect();
}

interface Ready { token: string; qids: string[] }

async function main() {
  if (!CODE) { console.error('Missing --code. See the header of this file.'); process.exit(2); }
  const host = new URL(BASE).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !flag('allow-remote')) {
    console.error(`Refusing to load-test ${host}. This script creates fake students. Use a local or staging server, or pass --allow-remote.`);
    process.exit(2);
  }
  if (flag('cleanup-only')) { await cleanup(); return; }

  const info = await call('info', 'GET', `/${CODE}`);
  if (info.status !== 200) { console.error(`Cannot read test ${CODE}: ${info.status} ${info.json?.error || ''}`); process.exit(2); }
  if (info.json.state !== 'open') { console.error(`Test is "${info.json.state}". Open it first (status PUBLISHED, inside its time window).`); process.exit(2); }
  console.log(`Test "${info.json.title}": ${info.json.questionCount} questions, ${info.json.durationMin} min. ${N} students, ${CONC} entering at once, run ${RUN}.\n`);

  let failed = 0;

  // 1) Race: five simultaneous starts for ONE roll number must end with exactly one live attempt.
  const dupName = 'LoadTest Dup';
  const dupRoll = `LTDUP${RUN}`;
  const dups = await Promise.all(Array.from({ length: 5 }, () => call('dup-start', 'POST', `/${CODE}/start`, { name: dupName, rollNo: dupRoll })));
  const tokens = dups.filter(d => d.status === 200).map(d => d.json.token as string);
  const live = (await Promise.all(tokens.map(t => call('dup-load', 'GET', '/attempt', undefined, t)))).filter(r => r.status === 200).length;
  const dupOk = tokens.length >= 1 && live === 1;
  console.log(`Same-roll race: 5 simultaneous starts -> ${tokens.length} accepted, ${live} live attempt(s). ${dupOk ? 'OK' : 'FAIL (expected exactly 1)'}`);
  if (!dupOk) failed++;

  // 2) Students enter, load the exam and autosave a few answers.
  const ready: (Ready | null)[] = new Array(N).fill(null);
  const t0 = performance.now();
  await pool(Array.from({ length: N }, (_, i) => i), CONC, async i => {
    const name = `LoadTest ${String(i + 1).padStart(4, '0')}`;
    const rollNo = `LT${RUN}${String(i + 1).padStart(4, '0')}`;
    const chk = await call('check', 'POST', `/${CODE}/check`, { name, rollNo });
    if (chk.status !== 200) return;
    const st = await call('start', 'POST', `/${CODE}/start`, { name, rollNo });
    if (st.status !== 200) return;
    const token = st.json.token as string;
    const ld = await call('load', 'GET', '/attempt', undefined, token);
    if (ld.status !== 200 || ld.json.status !== 'IN_PROGRESS') return;
    const qids: string[] = ld.json.sections.flatMap((s: Json) => s.questions.map((q: Json) => q.id));
    const per = Math.max(1, Math.ceil(qids.length / Math.max(1, SAVES)));
    for (let k = 0; k < SAVES; k++) {
      const body: Json = {};
      qids.slice(k * per, (k + 1) * per).forEach(id => { body[id] = { selected: 'a', marked: false, visited: true, t: 3 }; });
      if (Object.keys(body).length) await call('save', 'PUT', '/attempt/answers', { answers: body }, token);
    }
    ready[i] = { token, qids };
  });
  const students = ready.filter((r): r is Ready => !!r);
  console.log(`Entered: ${students.length}/${N} students ready in ${((performance.now() - t0) / 1000).toFixed(1)}s.`);

  // 3) Everyone submits at the same moment, with the FULL answers map.
  const tSub = performance.now();
  const results = await Promise.all(students.map(async s => {
    const answers: Json = {};
    s.qids.forEach(id => { answers[id] = { selected: 'a', marked: false, visited: true, t: 5 }; });
    const r = await call('submit', 'POST', '/attempt/submit', { answers, tabSwitches: 0 }, s.token);
    return { token: s.token, status: r.status, score: r.json?.score as number | undefined };
  }));
  const subSec = (performance.now() - tSub) / 1000;
  const submitted = results.filter(r => r.status === 200);
  console.log(`Submitted: ${submitted.length}/${students.length} in ${subSec.toFixed(1)}s (all at once).`);

  // 4) Same answers must give the same score; a sample is re-read from the server.
  const scores = submitted.map(r => r.score).filter((x): x is number => typeof x === 'number');
  let scoreOk = true;
  if (scores.length === 0) console.log('Scores: hidden (showResult is off), score check skipped.');
  else {
    const uniq = Array.from(new Set(scores));
    scoreOk = uniq.length === 1;
    console.log(`Scores: ${uniq.length === 1 ? `all ${scores.length} equal ${uniq[0]}. OK` : `FAIL, ${uniq.length} different values: ${uniq.slice(0, 6).join(', ')}`}`);
    const sample = submitted.filter((_, i) => i % 20 === 0);
    const again = await Promise.all(sample.map(r => call('result', 'GET', '/attempt/result', undefined, r.token)));
    const same = again.every((a, i) => a.status === 200 && a.json?.score === sample[i].score);
    console.log(`Re-read ${sample.length} results: ${same ? 'same scores. OK' : 'FAIL, a stored score differs'}`);
    if (!same) scoreOk = false;
  }
  if (!scoreOk) failed++;
  console.log(`Answer leak check: ${leaks === 0 ? 'no isCorrect/correct in any exam response. OK' : `FAIL, ${leaks} response(s) contained correct answers`}`);
  if (leaks) failed++;

  // 5) Report
  console.log('\nPhase        calls   p50ms   p95ms   p99ms   maxms   status codes');
  for (const ph of ['check', 'start', 'load', 'save', 'submit', 'result']) {
    const a = lat[ph];
    if (!a?.length) continue;
    console.log(`${ph.padEnd(11)} ${String(a.length).padStart(6)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)} ${Math.max(...a).toFixed(0).padStart(7)}   ${JSON.stringify(statuses[ph])}`);
  }
  const badCalls = Object.entries(statuses).filter(([ph]) => !ph.startsWith('dup')).reduce((n, [, m]) => n + Object.entries(m).filter(([c]) => c !== '200').reduce((x, [, v]) => x + v, 0), 0);
  if (errors.length) { console.log('\nFirst errors:'); errors.forEach(e => console.log('  ' + e)); }
  if (students.length < N || submitted.length < students.length || badCalls > 0) failed++;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${failed === 0 ? 'no failed calls, scores consistent, nothing leaked.' : 'see above.'}`);

  if (flag('cleanup')) await cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });