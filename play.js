// Google Play Developer API (Android Publisher): статусы выпусков и отзывы. Только чтение.
// Служебный аккаунт приглашён в Play Console с правом «Просмотр информации о приложении».
const { accessToken, fail } = require('./ga.js');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
// Пакеты приложений: PLAY_PACKAGES="com.a.b:Название,com.c.d:Другое"
const DEFAULTS = 'com.wonga.otpusk_planner:Wonga,com.wonga.loanpointer:Wonga Loan Pointer,com.prestomin.guia:Prestomin,com.navo.navo_calculator:Navo Calculator,com.mepresta.dinerorapidocalc:Mepresta Calc';
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

async function oneApp(p, token) {
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
    const store = await storeInfo(p.id);
    return { id: p.id, title: storeTitle || p.title, ok: true, icon, tracks: out, reviews, status: derive(out, store) };
  } catch (e) {
    const denied = e.status === 403 || e.status === 404;
    return { id: p.id, title: p.title, ok: false, error: denied ? 'no_access' : 'upstream', message: e.status === 403 && /has not been used|disabled/i.test(e.message) ? 'Google Play Android Developer API не включён в проекте Cloud' : denied ? 'Нет доступа: добавьте служебный аккаунт в Play Console и выдайте права на это приложение (или проверьте имя пакета)' : e.message };
  }
}
let cache = null;
async function getPlay() {
  if (cache && Date.now() - cache.t < 120000) return cache.v;
  const token = await accessToken(undefined, SCOPE);
  const apps = await Promise.all(packages().map(p => oneApp(p, token)));
  const v = { apps, updatedAt: new Date().toISOString() }; cache = { t: Date.now(), v }; return v;
}
module.exports = { getPlay };
