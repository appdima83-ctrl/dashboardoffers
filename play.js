// Google Play Developer API (Android Publisher): статусы выпусков и отзывы. Только чтение.
// Служебный аккаунт приглашён в Play Console с правом «Просмотр информации о приложении».
const { accessToken, fail, listProperties } = require('./ga.js');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
// Пакеты приложений: PLAY_PACKAGES="com.a.b:Название,com.c.d:Другое"
const DEFAULTS = 'com.wonga.otpusk_planner:Wonga,com.wonga.loanpointer:Wonga Loan Pointer,com.prestomin.guia:Prestomin,com.navo.navo_calculator:Navo Calculator,com.mepresta.dinerorapidocalc:Mepresta Calc,com.prestomin.dinerorapido:Prestomin Dinero Rápido';
const packages = () => (process.env.PLAY_PACKAGES || DEFAULTS).split(',').map(x => x.trim()).filter(Boolean).map(x => { const [id, ...n] = x.split(':'); return { id: id.trim(), title: (n.join(':') || id).trim() }; });

async function pget(pkg, path, token, init = {}) {
  const r = await fetch(API + pkg + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || ('Play API ' + r.status)), { status: r.status, gstatus: j.error && j.error.status });
  return j;
}
const STAT = { completed: 'Выпущен', inProgress: 'Раскатка', halted: 'Остановлен', draft: 'Черновик' };
const TRACK = { production: 'Production', beta: 'Открытое тестирование', alpha: 'Закрытое тестирование', internal: 'Внутреннее тестирование' };

// Что видят пользователи: публичная страница Google Play. 404 во всех проверенных странах = в магазине приложения нет.
const STORE_GL = ['US', 'MX', 'CO', 'ZA', 'IN'];
const storeCache = new Map();
async function storePage(pkg, gl) {
  const r = await fetch('https://play.google.com/store/apps/details?id=' + pkg + '&hl=en&gl=' + gl, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return { live: false };
  if (!r.ok) return { error: r.status };
  const html = await r.text(), m = html.match(/\[\[\["(\d+(?:\.\d+)+)"\]\]/);
  return { live: true, version: m ? m[1] : '', gl };
}
async function storeInfo(pkg) {
  const hit = storeCache.get(pkg); if (hit && Date.now() - hit.t < 600000) return hit.v;
  let v;
  try {
    const res = await Promise.all(STORE_GL.map(gl => storePage(pkg, gl).catch(() => ({ error: 'net' }))));
    const live = res.find(x => x.live);
    v = live || (res.every(x => x.live === false) ? { live: false } : { error: true });
  } catch { v = { error: true }; }
  if (!v.error) storeCache.set(pkg, { t: Date.now(), v });
  return v;
}
const vnum = x => String(x || '').match(/\d+(?:\.\d+)+/) ? String(x).match(/\d+(?:\.\d+)+/)[0].split('.').map(Number) : null;
const vcmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
// Автоматический статус Production: сравниваем выпуск из консоли с тем, что есть в магазине
function derive(out, store) {
  const prod = (out.find(t => t.track === 'production') || {}).releases || [], r = prod[0];
  if (!r) return { state: 'none', text: 'Нет выпуска', hint: 'В Production ничего не выпущено (только тестовые треки).' };
  if (r.status === 'halted') return { state: 'bad', text: 'Остановлен', hint: 'Раскатка остановлена в консоли.' };
  if (r.status === 'draft') return { state: 'idle', text: 'Черновик', hint: 'Выпуск создан, но не отправлен на проверку.' };
  if (store.error) return { state: 'idle', text: 'Не удалось проверить', hint: 'Страница магазина сейчас недоступна для проверки, повторите позже.', consoleVersion: r.name };
  if (!store.live) return { state: 'review', text: 'На проверке', hint: 'Выпуск есть в консоли, но в магазине приложения ещё нет (проверка Google или приложение снято с публикации).', consoleVersion: r.name };
  const cv = vnum(r.name), sv = vnum(store.version);
  if (cv && sv && vcmp(cv, sv) > 0) return { state: 'review', text: 'Обновление на проверке', hint: 'В консоли ' + r.name + ', в магазине пока ' + store.version + '.', storeVersion: store.version, consoleVersion: r.name };
  return { state: 'live', text: r.status === 'inProgress' && r.fraction ? 'Раскатка ' + Math.round(r.fraction * 100) + '%' : 'Опубликовано', hint: 'Версия в магазине' + (store.version ? ': ' + store.version : '') + ', совпадает с консолью.', storeVersion: store.version, consoleVersion: r.name };
}

// ---- Даты версий: когда версия впервые появилась у пользователей (по Google Analytics) ----
let gaMap = null, gaMapT = 0;
async function gaStreams() {
  if (gaMap && Date.now() - gaMapT < 3600000) return gaMap;
  const t = await accessToken(undefined), m = {};
  for (const p of await listProperties()) {
    const r = await fetch('https://analyticsadmin.googleapis.com/v1beta/properties/' + p.property + '/dataStreams', { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(20000) });
    for (const s of (await r.json()).dataStreams || []) if (s.androidAppStreamData) m[s.androidAppStreamData.packageName] = { property: p.property, streamId: s.name.split('/').pop() };
  }
  gaMap = m; gaMapT = Date.now(); return m;
}
const verDates = new Map();
async function versionDates(pkg) {
  const hit = verDates.get(pkg); if (hit && Date.now() - hit.t < 1800000) return hit.v;
  let v = {};
  try {
    const m = (await gaStreams())[pkg];
    if (!m) v = { _err: 'нет потока Analytics для пакета (или нет доступа к свойству)' };
    if (m) {
      const t = await accessToken(undefined);
      const r = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + m.property + ':runReport', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ dateRanges: [{ startDate: '730daysAgo', endDate: 'today' }], dimensions: [{ name: 'appVersion' }, { name: 'date' }], metrics: [{ name: 'activeUsers' }], dimensionFilter: { filter: { fieldName: 'streamId', stringFilter: { matchType: 'EXACT', value: m.streamId } } }, limit: 100000 }) });
      const rep = await r.json();
      if (!r.ok) v._err = 'Analytics: ' + (rep.error && rep.error.message || r.status);
      for (const row of rep.rows || []) {
        const ver = row.dimensionValues[0].value, d = row.dimensionValues[1].value, iso = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
        if (Number(row.metricValues[0].value) > 0 && (!v[ver] || iso < v[ver])) v[ver] = iso;
      }
    }
  } catch (e) { v._err = 'Analytics: ' + e.message; }
  verDates.set(pkg, { t: Date.now(), v }); return v;
}
const dateFor = (name, dates) => { for (const c of String(name || '').match(/\d+(?:\.\d+)+/g) || []) if (dates[c]) return dates[c]; return ''; };

// ---- Установки: из массовых отчётов Play Console (хранилище pubsite_prod_<ID аккаунта>); нужно право «скачивание массовых отчётов» ----
const DEVS = (process.env.PLAY_DEVELOPER_IDS || '5403334729948184361,8490837588749154483').split(',').map(x => x.trim()).filter(Boolean);
const instCache = new Map(); let instAccess = null;
const ym = d => d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
async function gcsCsv(token, pkg, month, dev) {
  const obj = 'stats/installs/installs_' + pkg + '_' + month + '_overview.csv';
  const r = await fetch('https://storage.googleapis.com/storage/v1/b/pubsite_prod_' + dev + '/o/' + encodeURIComponent(obj) + '?alt=media', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20000) });
  if (r.status === 403) throw Object.assign(new Error('no_access'), { noAccess: true });
  if (!r.ok) return [];
  const buf = Buffer.from(await r.arrayBuffer()), txt = (buf[0] === 0xFF && buf[1] === 0xFE ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter(Boolean), head = lines[0].split(',').map(x => x.replace(/"/g, '').trim());
  return lines.slice(1).map(l => { const c = l.split(',').map(x => x.replace(/"/g, '').trim()); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });
}
async function installsFor(pkg, token) {
  const hit = instCache.get(pkg); if (hit && Date.now() - hit.t < 3600000) return hit.v;
  let v = null, denied = false;
  try {
    const now = new Date(), prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    let rows = [];
    for (const dev of DEVS) {
      try { rows = [...(await gcsCsv(token, pkg, ym(prev), dev)), ...(await gcsCsv(token, pkg, ym(now), dev))]; } catch (e) { if (!e.noAccess) throw e; denied = true; }
      if (rows.length) break;
    }
    rows = rows.filter(r => r['Date']).sort((a, b) => a['Date'] < b['Date'] ? -1 : 1);
    const col = rows.length ? (['Active Device Installs', 'Current Device Installs', 'Total User Installs'].find(c => rows[rows.length - 1][c] !== undefined) || null) : null;
    if (col) { const cur = Number(rows[rows.length - 1][col]), old = rows.length > 28 ? Number(rows[rows.length - 29][col]) : null; v = { installs: cur, change: old ? Math.round((cur - old) / old * 100) : null, column: col, date: rows[rows.length - 1]['Date'] }; }
    instAccess = denied && !rows.length ? false : true;
  } catch (e) { if (e.noAccess) instAccess = false; }
  instCache.set(pkg, { t: Date.now(), v }); return v;
}

async function oneApp(p, token, gcsToken) {
  try {
    // Чтение дорожек требует временной «правки» (так устроен API): создаём, читаем, сразу удаляем. Ничего не публикуется.
    const edit = await pget(p.id, '/edits', token, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    let tracks = [], icon = '', storeTitle = '';
    try {
      tracks = (await pget(p.id, '/edits/' + edit.id + '/tracks', token)).tracks || [];
      // иконка приложения из страницы в Play (первый доступный язык, предпочтительно en-US)
      try {
        const listingsAll = (await pget(p.id, '/edits/' + edit.id + '/listings', token)).listings || [];
        const langs = listingsAll.map(x => x.language).sort((a, b) => (b === 'en-US') - (a === 'en-US'));
        for (const lg of langs) { if (!storeTitle) { const L = (listingsAll.find(x => x.language === lg) || {}); storeTitle = L.title || ''; } const im = ((await pget(p.id, '/edits/' + edit.id + '/listings/' + lg + '/icon', token)).images || [])[0]; if (im && im.url) { icon = im.url; break; } }
      } catch {}
    }
    finally { pget(p.id, '/edits/' + edit.id, token, { method: 'DELETE' }).catch(() => {}); }
    const out = tracks.map(t => ({ track: t.track, name: TRACK[t.track] || ('Закрытое тестирование: ' + t.track), releases: (t.releases || []).map(r => ({ name: r.name || '', status: r.status, statusText: r.status === 'inProgress' && r.userFraction ? 'Раскатка ' + Math.round(r.userFraction * 100) + '%' : (STAT[r.status] || r.status), fraction: r.userFraction || null, versionCodes: r.versionCodes || [], notes: ((r.releaseNotes || [])[0] || {}).text || '' })) }));
    let reviews = [];
    try { reviews = ((await pget(p.id, '/reviews?maxResults=5', token)).reviews || []).map(r => { const c = ((r.comments || [])[0] || {}).userComment || {}; return { author: r.authorName || '', stars: c.starRating || 0, text: c.text || '', date: c.lastModified ? Number(c.lastModified.seconds) * 1000 : 0, version: c.appVersionName || '', device: (c.deviceMetadata || {}).productName || '' }; }); } catch {}
    const [store, dates, inst] = await Promise.all([storeInfo(p.id), versionDates(p.id), gcsToken ? installsFor(p.id, gcsToken) : null]);
    for (const t of out) for (const r of t.releases) r.date = dateFor(r.name, dates);
    return { id: p.id, title: storeTitle || p.title, ok: true, icon, tracks: out, reviews, status: derive(out, store), installs: inst, datesError: dates._err || null };
  } catch (e) {
    const denied = e.status === 403 || e.status === 404;
    return { id: p.id, title: p.title, ok: false, error: denied ? 'no_access' : 'upstream', message: e.status === 403 && /has not been used|disabled/i.test(e.message) ? 'Google Play Android Developer API не включён в проекте Cloud' : denied ? 'Нет доступа: добавьте служебный аккаунт в Play Console и выдайте права на это приложение (или проверьте имя пакета)' : e.message };
  }
}
let cache = null;
async function getPlay() {
  if (cache && Date.now() - cache.t < 10000) return cache.v;
  const token = await accessToken(undefined, SCOPE);
  let gcs = null; try { gcs = await accessToken(undefined, 'https://www.googleapis.com/auth/devstorage.read_only'); } catch {}
  const apps = await Promise.all(packages().map(p => oneApp(p, token, gcs)));
  const v = { apps, installsAccess: apps.some(a => a.installs) ? true : instAccess, updatedAt: new Date().toISOString() }; cache = { t: Date.now(), v }; return v;
}
module.exports = { getPlay };
