// Google Analytics 4 (Firebase Analytics) через Analytics Data API.
// Ключ сервисного аккаунта: GA_SERVICE_ACCOUNT_JSON (содержимое JSON), GA_SERVICE_ACCOUNT_FILE (путь к файлу)
// или пара GA_CLIENT_EMAIL + GA_PRIVATE_KEY (переводы строк можно писать как \n).
// Сервисному аккаунту нужна роль «Читатель» (Viewer) на GA4-свойстве.
const crypto = require('crypto'), fs = require('fs');

const APPS = {
  wonga: { title: 'Wonga', propertyId: process.env.GA_PROPERTY_WONGA || '546879836' },
  // Mpowa — Firebase-проект in-emergency-loan-guide (Android: com.emergencyloanguide.app). ID свойства GA4 задаётся в GA_PROPERTY_MPOWA
  mpowa: { title: 'Mpowa', propertyId: process.env.GA_PROPERTY_MPOWA || '', findByName: 'in-emergency-loan-guide' },
  // Navo Calculator — Firebase-проект navo-calculator (Android: com.navo.navo_calculator)
  navo: { title: 'Navo', propertyId: process.env.GA_PROPERTY_NAVO || '555903500', findByName: 'navo-calculator' },
};

const fail = (code, message) => Object.assign(new Error(message), { code });

// Приводит ключ к корректному PEM: убирает кавычки/запятые/пробелы, понимает «\n» текстом и настоящие переносы
function normalizePem(v) {
  const m = String(v).replace(/\\r/g, '').replace(/\\n/g, '\n').match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw fail('ga_no_credentials', 'GA_PRIVATE_KEY: не найден блок -----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----');
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`;
}
const cleanEmail = v => String(v).replace(/["',\s]/g, '');

function loadCreds(app) {
  const sfx = app ? '_' + String(app).toUpperCase() : '';
  if (app && (process.env['GA_CLIENT_EMAIL' + sfx] || process.env['GA_SERVICE_ACCOUNT_JSON' + sfx] || process.env['GA_SERVICE_ACCOUNT_FILE' + sfx])) return loadCredsFrom(sfx);
  return loadCredsFrom('');
}
function loadCredsFrom(sfx) {
  if (process.env['GA_CLIENT_EMAIL' + sfx] && process.env['GA_PRIVATE_KEY' + sfx]) return { client_email: cleanEmail(process.env['GA_CLIENT_EMAIL' + sfx]), private_key: normalizePem(process.env['GA_PRIVATE_KEY' + sfx]) };
  let raw = process.env['GA_SERVICE_ACCOUNT_JSON' + sfx];
  if (!raw && process.env['GA_SERVICE_ACCOUNT_FILE' + sfx]) {
    try { raw = fs.readFileSync(process.env['GA_SERVICE_ACCOUNT_FILE' + sfx], 'utf8'); } catch { throw fail('ga_no_credentials', 'Не удалось прочитать файл ключа (GA_SERVICE_ACCOUNT_FILE)'); }
  }
  if (!raw) throw fail('ga_no_credentials', 'Не задан ключ Google (GA_SERVICE_ACCOUNT_JSON или GA_SERVICE_ACCOUNT_FILE)');
  try { const c = JSON.parse(raw); if (!c.client_email || !c.private_key) throw 0; return { client_email: cleanEmail(c.client_email), private_key: normalizePem(c.private_key) }; } catch { throw fail('ga_no_credentials', 'Ключ Google повреждён: нужен JSON сервисного аккаунта'); }
}

const toks = new Map();
async function accessToken(app, scope = 'https://www.googleapis.com/auth/analytics.readonly') {
  const c = loadCreds(app), hit = toks.get(c.client_email + '|' + scope);
  if (hit && Date.now() < hit.exp) return hit.v;
  const now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: c.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(c.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw fail('ga_auth', 'Google отклонил ключ сервисного аккаунта (' + r.status + ')');
  const j = await r.json(); toks.set(c.client_email + '|' + scope, { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

async function gpost(propertyId, method, body, app) {
  const t = await accessToken(app);
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

async function report(propertyId, days, app) {
  const range = [{ startDate: days - 1 + 'daysAgo', endDate: 'today' }];
  const [act, ver, cty, evt, rt, rtc, ctyT, evtT] = await Promise.all([
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'date' }], metrics: [{ name: 'active1DayUsers' }, { name: 'active7DayUsers' }, { name: 'active28DayUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 }, app),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'date' }, { name: 'appVersion' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 10000 }, app),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 15 }, app),
    gpost(propertyId, 'runReport', { dateRanges: range, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 15 }, app),
    gpost(propertyId, 'runRealtimeReport', { dimensions: [{ name: 'minutesAgo' }], metrics: [{ name: 'activeUsers' }], limit: 40 }, app),
    gpost(propertyId, 'runRealtimeReport', { dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 5 }, app),
    // прирост за сегодня (текущие сутки в часовом поясе свойства GA)
    gpost(propertyId, 'runReport', { dateRanges: [{ startDate: 'today', endDate: 'today' }], dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], limit: 250 }, app).catch(() => ({})),
    gpost(propertyId, 'runReport', { dateRanges: [{ startDate: 'today', endDate: 'today' }], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], limit: 250 }, app).catch(() => ({})),
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
  return { demo: false, days, activity, realtime, versions, countries: rows(cty).map(r => ({ name: r.d[0], value: r.m[0] })), events: rows(evt).map(r => ({ name: r.d[0], value: r.m[0] })), countriesToday: Object.fromEntries(rows(ctyT).map(r => [r.d[0], r.m[0]])), eventsToday: Object.fromEntries(rows(evtT).map(r => [r.d[0], r.m[0]])), updatedAt: new Date().toISOString() };
}

// Страны пользователей (ISO-2) за период по свойству GA4 — для вкладки «По приложениям»
async function countriesBetween(propertyId, from, to, app = 'wonga') {
  const j = await gpost(propertyId, 'runReport', { dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: 'countryId' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 25 }, app);
  return rows(j).filter(r => /^[A-Za-z]{2}$/.test(r.d[0])).map(r => ({ code: r.d[0].toUpperCase(), users: r.m[0] }));
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

// Какие GA4-свойства видит сервисный аккаунт (для подбора ID: node -e "require('./ga.js').listProperties().then(console.log)")
async function listProperties(app) {
  const t = await accessToken(app);
  const r = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw fail('ga_upstream', 'Admin API: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return (j.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p => ({ account: a.displayName, property: p.property.replace('properties/', ''), name: p.displayName })));
}
// ID свойства: из переменной окружения или по названию среди доступных сервисному аккаунту свойств
const found = new Map();
async function resolveProperty(app, a) {
  if (a.propertyId) return a.propertyId;
  if (!a.findByName) return '';
  const hit = found.get(app); if (hit && Date.now() - hit.t < 600000) return hit.id;
  const list = await listProperties(app), p = list.find(x => x.name.toLowerCase() === a.findByName.toLowerCase());
  if (!p) throw fail('ga_access', 'Сервисный аккаунт ' + loadCreds(app).client_email + ' не видит свойство «' + a.findByName + '»');
  found.set(app, { id: p.property, t: Date.now() }); return p.property;
}
const cache = new Map();
async function getApp(app, days) {
  const a = APPS[app]; if (!a) throw fail('not_found', 'Неизвестное приложение');
  days = [7, 30, 90].includes(days) ? days : 30;
  if (process.env.GA_MOCK === '1') return mock(days);
  const pid = await resolveProperty(app, a);
  if (!pid) throw fail('ga_no_property', 'Для приложения ' + a.title + ' не задан ID свойства GA4 (переменная GA_PROPERTY_' + app.toUpperCase() + ')');
  const k = app + days, c = cache.get(k);
  if (c && Date.now() - c.t < 20000) return c.v;
  const v = await report(pid, days, app); cache.set(k, { t: Date.now(), v }); return v;
}
module.exports = { countriesBetween, getApp, APPS, listProperties, accessToken, fail };
