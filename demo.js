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
// Реальная таблица по дням из кабинета за 01–30.09.2026: [дата, хосты, клики, конверсии «Все», «Итого»]. Итого: 745 / 1310 / 29 / 84,7596
const DAILY = [
  ['09-01',0,0,0,0],['09-02',0,0,0,0],['09-03',19,41,0,0],['09-04',13,18,0,0],['09-05',9,23,1,4.8],['09-06',5,11,0,0],
  ['09-07',36,72,4,15.2],['09-08',27,52,2,5.1899],['09-09',35,58,1,0.8],['09-10',21,35,3,9.9899],['09-11',33,52,1,4.8],['09-12',10,18,0,0],
  ['09-13',27,43,0,0],['09-14',17,32,1,0.3899],['09-15',35,42,0,0],['09-16',22,50,3,9.6],['09-17',36,70,1,4.8],['09-18',14,17,0,0],
  ['09-19',22,35,0,0],['09-20',33,55,1,0.8],['09-21',40,61,0,0],['09-22',32,50,1,0.3899],['09-23',61,123,1,3.2],['09-24',38,57,3,2.4],
  ['09-25',33,54,1,0.8],['09-26',23,43,0,0],['09-27',19,38,0,0],['09-28',33,70,1,5.2],['09-29',23,42,1,0.8],['09-30',29,48,3,15.6],
];
function demoSeries(from, to, offer) {
  const map = {}; DAILY.forEach(r => map['2026-' + r[0]] = { hosts: r[1], clicks: r[2], conversions: r[3], amount: r[4] });
  const k = offer && offer !== 'all' ? (W[offer] || 1) : 1;
  return days(from, to).map(d => {
    let v = map[d];
    if (!v) { const q = rnd(Date.parse(d) / 86400000); const c = Math.floor(q() * 45); v = { hosts: Math.floor(q() * 40), clicks: Math.floor(q() * 70), conversions: c < 22 ? 0 : (c < 40 ? 1 : 2), amount: 0 }; v.amount = Math.round(v.conversions * (1 + q() * 3) * 1e4) / 1e4; }
    return { date: d, hosts: Math.round(v.hosts * k), clicks: Math.round(v.clicks * k), conversions: Math.round(v.conversions * k), amount: Math.round(v.amount * k * 1e4) / 1e4 };
  });
}


function statsResponse(from, to, offer) {
  const real = (!offer || offer === 'all') && from >= '2026-09-01' && to <= '2026-09-30';
  return { demo: !real, currency: 'USD', rows: demoSeries(from, to, offer), offers: (from === '2026-09-01' && to === '2026-09-30') ? SNAP : byOffer(demoSeries(from, to, 'all')), offersSource: (from === '2026-09-01' && to === '2026-09-30') ? 'cabinet' : 'demo', updatedAt: new Date().toISOString() };
}
const CONFIG = { hasKey: false, offers: OFFERS, currencies: ['USD'], timezone: 'Indian/Kerguelen' };
module.exports = { statsResponse, CONFIG, OFFERS };
