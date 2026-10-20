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
const STAT = { completed: 'Опубликован', inProgress: 'Раскатка', halted: 'Остановлен', draft: 'Черновик' };
const TRACK = { production: 'Production', beta: 'Открытое тестирование', alpha: 'Закрытое тестирование', internal: 'Внутреннее тестирование' };

async function oneApp(p, token) {
  try {
    // Чтение дорожек требует временной «правки» (так устроен API): создаём, читаем, сразу удаляем. Ничего не публикуется.
    const edit = await pget(p.id, '/edits', token, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    let tracks = [];
    try { tracks = (await pget(p.id, '/edits/' + edit.id + '/tracks', token)).tracks || []; }
    finally { pget(p.id, '/edits/' + edit.id, token, { method: 'DELETE' }).catch(() => {}); }
    const out = tracks.map(t => ({ track: t.track, name: TRACK[t.track] || ('Закрытое тестирование: ' + t.track), releases: (t.releases || []).map(r => ({ name: r.name || '', status: r.status, statusText: r.status === 'inProgress' && r.userFraction ? 'Раскатка ' + Math.round(r.userFraction * 100) + '%' : (STAT[r.status] || r.status), fraction: r.userFraction || null, versionCodes: r.versionCodes || [], notes: ((r.releaseNotes || [])[0] || {}).text || '' })) }));
    let reviews = [];
    try { reviews = ((await pget(p.id, '/reviews?maxResults=5', token)).reviews || []).map(r => { const c = ((r.comments || [])[0] || {}).userComment || {}; return { author: r.authorName || '', stars: c.starRating || 0, text: c.text || '', date: c.lastModified ? Number(c.lastModified.seconds) * 1000 : 0, version: c.appVersionName || '', device: (c.deviceMetadata || {}).productName || '' }; }); } catch {}
    return { id: p.id, title: p.title, ok: true, tracks: out, reviews };
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
