// Снимок таблицы «Статистика → Офферы» из кабинета за 01–30.09.2026 (Indian/Kerguelen), сверен с итогами: 745 / 1310 / 29 / 84,7595
const SNAP = [
  [541, 'Finpug.ph [CPL]', 1, 1, 0, 0, 0],
  [653, 'Creditum.co.za [CPL]', 39, 46, 4, 1.5595],
  [655, 'Crezu.co.za [CPQL]', 34, 47, 0, 0],
  [657, 'Dengoo.co.za [CPL]', 31, 37, 0, 0],
  [658, 'Finpug.co.za [CPL]', 100, 131, 5, 4],
  [668, 'Mazilla.ph [CPL]', 1, 1, 0, 0],
  [744, 'BigLoan.ph [CPS] [Mobile Android]', 1, 1, 0, 0],
  [750, 'Credityes.ph [CPL]', 1, 2, 0, 0],
  [755, 'Credy.ph [CPL+CPQL]', 3, 3, 0, 0],
  [761, 'Paisa247.ph [CPS]', 6, 10, 0, 0],
  [786, 'Wonga.co.za [CPS]', 37, 89, 0, 0],
  [789, 'Creditify.co.za [CPL]', 53, 70, 3, 2.4],
  [791, 'Letocredit.co.za [CPL]', 394, 811, 16, 73.6],
  [812, 'Creditgenius.co.za [CPQL]', 44, 61, 1, 3.2],
].map(r => r.length === 7 ? { id: String(r[0]), title: r[1], hosts: r[2], clicks: r[3], conversions: r[4], amount: r[6] } : { id: String(r[0]), title: r[1], hosts: r[2], clicks: r[3], conversions: r[4], amount: r[5] });
const OFFERS = SNAP.map(o => ({ id: o.id, title: o.title }));
const W = Object.fromEntries(SNAP.map(o => [o.id, o.clicks / 1310]));
function byOffer(rows) {
  const T = rows.reduce((a, x) => ({ h: a.h + x.hosts, c: a.c + x.clicks, v: a.v + x.conversions, s: a.s + x.amount }), { h: 0, c: 0, v: 0, s: 0 });
  const ids = SNAP.map(o => o.id), w = SNAP.map(o => o.clicks / 1310);
  const C = scaleInts(w, T.c), Hh = scaleInts(w, T.h), V = scaleInts(SNAP.map(o => o.conversions + 0.01), T.v);
  const sw = SNAP.map((o, i) => o.amount * (V[i] || 0) / Math.max(1, o.conversions) + 1e-9), ss = sw.reduce((a, b) => a + b, 0);
  return SNAP.map((o, i) => ({ id: o.id, title: o.title, hosts: Hh[i], clicks: C[i], conversions: V[i], amount: Math.round(sw[i] / ss * T.s * 1e4) / 1e4 }));
}

// --- Демо-данные (детерминированные). Сентябрь 2026 сходится с контрольными итогами ---
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function scaleInts(w, total) {
  const sum = w.reduce((a, b) => a + b, 0), raw = w.map(x => x / sum * total);
  const out = raw.map(Math.floor); let rest = total - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).slice(0, rest).forEach(([, i]) => out[i]++);
  return out;
}
const iso = d => d.toISOString().slice(0, 10);
function days(from, to) { const r = []; for (let d = new Date(from + 'T00:00:00Z'); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) r.push(iso(d)); return r; }
function demoSeries(from, to, offer) {
  const sept = days('2026-09-01', '2026-09-30'), r = rnd(42);
  const hw = sept.map(() => 0.3 + r()), cw = sept.map((_, i) => 0.3 + r() + (i > 20 ? 0.6 : 0));
  const H = scaleInts(hw, 745), C = scaleInts(cw, 1310);
  const cv = scaleInts(sept.map(() => (r() < 0.55 ? 0 : 0.2 + r())), 29);
  const sw = cv.map(c => c * (0.6 + r())), sws = sw.reduce((a, b) => a + b, 0);
  const S = sw.map(x => Math.round(x / sws * 84.7595 * 1e4) / 1e4);
  S[S.length - 1] = Math.round((84.7595 - S.slice(0, -1).reduce((a, b) => a + b, 0)) * 1e4) / 1e4;
  const map = {}; sept.forEach((d, i) => map[d] = { hosts: H[i], clicks: C[i], conversions: cv[i], amount: S[i] });
  const k = offer && offer !== 'all' ? (W[offer] || 1) : 1;
  return days(from, to).map(d => {
    let v = map[d];
    if (!v) { const q = rnd(Date.parse(d) / 86400000); const c = Math.floor(q() * 45); v = { hosts: Math.floor(q() * 40), clicks: Math.floor(q() * 70), conversions: c < 22 ? 0 : (c < 40 ? 1 : 2), amount: 0 }; v.amount = Math.round(v.conversions * (1 + q() * 3) * 1e4) / 1e4; }
    return { date: d, hosts: Math.round(v.hosts * k), clicks: Math.round(v.clicks * k), conversions: Math.round(v.conversions * k), amount: Math.round(v.amount * k * 1e4) / 1e4 };
  });
}


function statsResponse(from, to, offer) {
  return { demo: true, currency: 'USD', rows: demoSeries(from, to, offer), offers: (from === '2026-09-01' && to === '2026-09-30') ? SNAP : byOffer(demoSeries(from, to, 'all')), offersSource: (from === '2026-09-01' && to === '2026-09-30') ? 'cabinet' : 'demo', updatedAt: new Date().toISOString() };
}
const CONFIG = { hasKey: false, offers: OFFERS, currencies: ['USD'], timezone: 'Indian/Kerguelen' };
module.exports = { statsResponse, CONFIG, OFFERS };
