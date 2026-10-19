// Google Analytics 4 (Firebase Analytics) через Analytics Data API.
// Ключ сервисного аккаунта: GA_SERVICE_ACCOUNT_JSON (содержимое JSON) или GA_SERVICE_ACCOUNT_FILE (путь к файлу).
// Сервисному аккаунту нужна роль «Читатель» (Viewer) на GA4-свойстве.
const crypto = require('crypto'), fs = require('fs');

const APPS = {
  wonga: { title: 'Wonga', propertyId: process.env.GA_PROPERTY_WONGA || '546879836' },
};

const fail = (code, message) => Object.assign(new Error(message), { code });

function loadCreds() {
  let raw = process.env.GA_SERVICE_ACCOUNT_JSON;
  if (!raw && process.env.GA_SERVICE_ACCOUNT_FILE) {
    try { raw = fs.readFileSync(process.env.GA_SERVICE_ACCOUNT_FILE, 'utf8'); } catch { throw fail('ga_no_credentials', 'Не удалось прочитать файл ключа (GA_SERVICE_ACCOUNT_FILE)'); }
  }
  if (!raw) throw fail('ga_no_credentials', 'Не задан ключ Google (GA_SERVICE_ACCOUNT_JSON или GA_SERVICE_ACCOUNT_FILE)');
  try { const c = JSON.parse(raw); if (!c.client_email || !c.private_key) throw 0; return c; } catch { throw fail('ga_no_credentials', 'Ключ Google повреждён: нужен JSON сервисного аккаунта'); }
}

let tok = { v: null, exp: 0 };
async function accessToken() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const c = loadCreds(), now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(c.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw fail('ga_auth', 'Google отклонил ключ сервисного аккаунта (' + r.status + ')');
  const j = await r.json(); tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return tok.v;
}

async function gpost(propertyId, method, body) {
  const t = await accessToken();
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (r.status === 401 || r.status === 403) throw Object.assign(fail('ga_access', 'Нет доступа к GA4-свойству: добавьте сервисный аккаунт с ролью «Читатель»'), { final: true });
      if (r.status === 429 || r.status >= 500) throw fail('ga_upstream', 'Google Analytics: ошибка ' + r.status);
      if (!r.ok) throw Object.assign(fail('ga_upstream', 'Google Analytics: ошибка ' + r.status), { final: true });
      return await r.json();
    } catch (e) { last = e.code ? e : fail('network', 'Сетевая ошибка при обращении к Google'); if (last.final) break; await new Promise(r => setTimeout(r, 400 * 2 ** i)); }
  }
  throw last;
}
const rows = j => (j.rows || []).map(r => ({ d: r.dimensionValues.map(x => x.value), m: r.metricValues.map(x => Number(x.value)) }));
const isoDate = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function report(propertyId, days) {
  const range = [{ startDate: days - 1 + 'daysAgo', endDate: 'today' }];
  const [act, ver, cty, evt, rt, rtc] = await Promise.all([
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'date' }], metrics: [{ name: 'active1DayUsers' }, { name: 'active7DayUsers' }, { name: 'active28DayUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 }),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'date' }, { name: 'appVersion' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 10000 }),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 15 }),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 15 }),
    gpost(propertyId, 'runRealtimeReport', { dimensions: [{ name: 'minutesAgo' }], metrics: [{ name: 'activeUsers' }], limit: 40 }),
    gpost(propertyId, 'runRealtimeReport', { dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 5 }),
  ]);
  const dates = rows(act).map(r => isoDate(r.d[0]));
  const activity = { dates, d1: rows(act).map(r => r.m[0]), d7: rows(act).map(r => r.m[1]), d28: rows(act).map(r => r.m[2]) };
  const vr = rows(ver), tot = {};
  for (const r of vr) tot[r.d[1]] = (tot[r.d[1]] || 0) + r.m[0];
  const top = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, 4);
  const vmap = {}; for (const r of vr) (vmap[r.d[1]] ||= {})[isoDate(r.d[0])] = r.m[0];
  const versions = { dates, series: top.map(v => ({ name: v, values: dates.map(d => vmap[v][d] || 0) })) };
  const perMin = Array(30).fill(0); for (const r of rows(rt)) { const i = Number(r.d[0]); if (i >= 0 && i < 30) perMin[i] = r.m[0]; }
  const realtime = { total: rows(rt).reduce((a, r) => a + r.m[0], 0), perMinute: perMin, countries: rows(rtc).map(r => ({ name: r.d[0], value: r.m[0] })) };
  return { demo: false, days, activity, realtime, versions, countries: rows(cty).map(r => ({ name: r.d[0], value: r.m[0] })), events: rows(evt).map(r => ({ name: r.d[0], value: r.m[0] })), updatedAt: new Date().toISOString() };
}

// Демо для проверки интерфейса (GA_MOCK=1)
function mock(days) {
  const end = new Date(); const dates = [...Array(days)].map((_, i) => { const d = new Date(end); d.setDate(d.getDate() - (days - 1 - i)); return d.toISOString().slice(0, 10); });
  const w = (b, a, n) => dates.map((_, i) => Math.round(b + a * Math.sin(i / 2.3 + n)));
  return { demo: true, days, activity: { dates, d1: w(30, 14, 0), d7: w(215, 14, 1), d28: w(850, 25, 2) },
    realtime: { total: 1, perMinute: Array(30).fill(0).map((_, i) => (i === 17 ? 1 : 0)), countries: [{ name: 'South Africa', value: 1 }] },
    versions: { dates, series: [{ name: '1.2.2', values: w(38, 14, 3) }, { name: '1.1.1', values: w(2, 2, 5).map(x => Math.max(0, x)) }] },
    countries: [['South Africa', 336], ['United Kingdom', 6], ['Russia', 6], ['Romania', 5], ['United States', 4], ['Poland', 3], ['United Arab Emirates', 2]].map(([name, value]) => ({ name, value })),
    events: [['screen_view', 2800], ['user_engagement', 1300], ['offer_tap', 932], ['offer_open_webview', 926], ['webview_open', 896], ['session_start', 614], ['first_open', 283]].map(([name, value]) => ({ name, value })),
    updatedAt: new Date().toISOString() };
}

const cache = new Map();
async function getApp(app, days) {
  const a = APPS[app]; if (!a) throw fail('not_found', 'Неизвестное приложение');
  days = [7, 30, 90].includes(days) ? days : 30;
  if (process.env.GA_MOCK === '1') return mock(days);
  const k = app + days, c = cache.get(k);
  if (c && Date.now() - c.t < 20000) return c.v;
  const v = await report(a.propertyId, days); cache.set(k, { t: Date.now(), v }); return v;
}
module.exports = { getApp, APPS };
