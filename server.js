// Мини-сервер: отдаёт UI и /api/stats. Ключ AFFISE_API_KEY живёт только здесь.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
// .env без зависимостей
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch {}
const PASSWORD = process.env.DASH_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sha = x => crypto.createHash('sha256').update(x).digest();
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const makeToken = () => { const exp = Date.now() + 30 * 864e5; return exp + '.' + sign('s' + exp); };
const okToken = t => { const [exp, sig] = (t || '').split('.'); return !!sig && +exp > Date.now() && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign('s' + exp))); };
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).map(c => c.split(/=(.*)/s).slice(0, 2)));
const tries = new Map(); // ip -> [время попыток]
const LOGIN = err => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0a0a"><title>Вход</title><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16171b radial-gradient(700px 350px at 80% -80px,rgba(76,141,255,.16),transparent);color:#F2F4F8;font:15px Inter,system-ui,sans-serif}form{width:min(360px,92vw);background:#1c1d22;border:1px solid rgba(255,255,255,.07);border-radius:28px;padding:28px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:20px}input{background:#0f1013;color:#F2F4F8;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px;font:inherit;font-size:16px}button{border:0;border-radius:999px;padding:12px;font:inherit;font-weight:600;color:#fff;background:linear-gradient(180deg,#5B9BFF,#2563EB);cursor:pointer}.e{color:#ff8a6a;font-size:13px;min-height:16px}</style></head><body><form method="post" action="/login"><img src="/icon-192.png" alt="" width="64" height="64" style="align-self:center;filter:drop-shadow(0 8px 16px rgba(40,70,200,.45))"><h1 style="text-align:center">Статистика ProfitCash</h1><input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required><div class="e">${err || ''}</div><button>Войти</button></form></body></html>`;
const PORT = process.env.PORT || 3000;
const KEY = process.env.AFFISE_API_KEY || '';

const { statsResponse, CONFIG, days } = require('./demo.js');
const ga = require('./ga.js');

// --- Affise API (поля сверены с кабинетом: хосты = traffic.uniq, клики = traffic.raw,
// конверсии = actions.total.count, «Итого» = actions.total.revenue) ---
const BASE = process.env.AFFISE_BASE || 'https://api-profitcash.affise.com';
const TZ = process.env.TIMEZONE || 'Indian/Kerguelen';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function aget(pathname, params) {
  const url = BASE + pathname + '?' + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'API-Key': KEY }, signal: AbortSignal.timeout(20000) });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Affise отклонил ключ (доступ запрещён)'), { code: 'access', final: true });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error('Affise: ошибка ' + r.status), { code: r.status === 429 ? 'rate_limit' : 'upstream' });
      if (!r.ok) throw Object.assign(new Error('Affise: ошибка ' + r.status), { code: 'upstream', final: true });
      return await r.json();
    } catch (e) {
      last = e.code ? e : Object.assign(new Error('Сетевая ошибка при обращении к Affise'), { code: 'network' });
      if (last.final) break;
      await sleep(400 * 2 ** i);
    }
  }
  throw last;
}
async function allPages(pathname, params) {
  const out = []; let page = 1;
  for (;;) {
    const j = await aget(pathname, [...params, ['limit', 500], ['page', page]]);
    if (j.status !== 1) throw Object.assign(new Error('Affise вернул статус ' + j.status), { code: 'upstream' });
    out.push(...j.stats);
    if (out.length >= (j.pagination?.total_count ?? out.length) || !j.stats.length) return out;
    page++;
  }
}
const num = x => Number(x) || 0, r4 = x => Math.round(x * 1e4) / 1e4;
const norm = s => ({ hosts: num(s.traffic?.uniq), clicks: num(s.traffic?.raw), conversions: num(s.actions?.total?.count), amount: r4(num(s.actions?.total?.revenue)) });
const cache = new Map();
async function cached(key, fn, ttl = 15000) {
  const c = cache.get(key); if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn(); cache.set(key, { t: Date.now(), v }); return v;
}
async function fetchBalance() {
  const j = await aget('/3.0/balance', []);
  const b = j.balance || {}, pick = o => Object.fromEntries(Object.entries(o || {}).map(([c, v]) => [c, r4(num(v))]).filter(([c, v]) => v !== 0));
  return { total: pick(b.balance), available: pick(b.available), hold: pick(b.hold) };
}
async function affise(from, to, q) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw Object.assign(new Error('Некорректные даты'), { code: 'bad_request' });
  const offer = q.get('offer');
  const base = [['filter[date_from]', from], ['filter[date_to]', to], ['timezone', TZ]];
  const balP = cached('bal', fetchBalance, 5000).catch(() => null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // сегодняшняя дата в часовом поясе кабинета
  const todayP = cached('today|' + today, () => allPages('/3.0/stats/custom', [['filter[date_from]', today], ['filter[date_to]', today], ['timezone', TZ], ['slice[]', 'offer']]), 15000)
    .then(st => Object.fromEntries(st.map(x => [String(x.slice.offer.id), norm(x)]))).catch(() => null);
  const data = await cached(['s', from, to, offer].join('|'), async () => {
    const [daily, byOff] = await Promise.all([
      allPages('/3.0/stats/getbydate', offer && offer !== 'all' ? [...base, ['filter[offer]', offer]] : base),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'offer']]),
    ]);
    const map = {};
    for (const s of daily) { const d = s.slice; map[`${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`] = norm(s); }
    const rows = days(from, to).map(date => ({ date, ...(map[date] || { hosts: 0, clicks: 0, conversions: 0, amount: 0 }) }));
    const offers = byOff.map(s => ({ id: String(s.slice.offer.id), title: s.slice.offer.title.replace(/\[ /g, '[').replace(/ \]/g, ']'), ...norm(s) }));
    return { demo: false, currency: 'USD', rows, offers, offersSource: 'affise', updatedAt: new Date().toISOString() };
  });
  return { ...data, balance: await balP, today, offersToday: await todayP };
}
async function offersList() {
  return cached('offers', async () => {
    const t = new Date().toISOString().slice(0, 10);
    const st = await allPages('/3.0/stats/custom', [['filter[date_from]', '2026-09-01'], ['filter[date_to]', t], ['timezone', TZ], ['slice[]', 'offer']]);
    return st.map(s => ({ id: String(s.slice.offer.id), title: s.slice.offer.title.replace(/\[ /g, '[').replace(/ \]/g, ']') }));
  }, 600000);
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const authed = okToken(cookieOf(req).pc_session);
  if (u.pathname === '/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress, now = Date.now();
    const t = (tries.get(ip) || []).filter(x => now - x < 60000);
    let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
    const pw = new URLSearchParams(body).get('password') || '';
    res.setHeader('Cache-Control', 'no-store');
    if (t.length >= 5) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN('Слишком много попыток. Подождите минуту.')); }
    if (!PASSWORD || !crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) { t.push(now); tries.set(ip, t); res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN(PASSWORD ? 'Неверный пароль' : 'Пароль не задан на сервере (DASH_PASSWORD)')); }
    res.writeHead(303, { Location: '/', 'Set-Cookie': `pc_session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}` }); return res.end();
  }
  if (u.pathname === '/logout') { res.writeHead(204, { 'Set-Cookie': 'pc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); return res.end(); }
  if (u.pathname === '/login') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(LOGIN()); }
  const PUBLIC = ['/manifest.webmanifest', '/sw.js', '/favicon-32.png', '/favicon-64.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
  if (!authed && !PUBLIC.includes(u.pathname)) {
    if (u.pathname.startsWith('/api/')) return send(res, 401, { error: 'auth', message: 'Требуется вход' });
    res.writeHead(303, { Location: '/login' }); return res.end();
  }
  if (u.pathname === '/api/config') {
    if (!KEY) return send(res, 200, { ...CONFIG, hasKey: false });
    try { return send(res, 200, { ...CONFIG, hasKey: true, offers: await offersList() }); } catch (e) { return send(res, 200, { ...CONFIG, hasKey: true }); }
  }
  if (u.pathname.startsWith('/api/ga/')) {
    try { return send(res, 200, await ga.getApp(u.pathname.slice(8), +u.searchParams.get('days'))); }
    catch (e) { return send(res, e.code === 'not_found' ? 404 : 502, { error: e.code || 'upstream', message: e.message }); }
  }
  if (u.pathname === '/api/stats') {
    const q = u.searchParams, from = q.get('from'), to = q.get('to');
    if (q.get('fail') === 'network') return send(res, 502, { error: 'network', message: 'Сетевая ошибка при обращении к Affise API' });
    if (!KEY) { await new Promise(r => setTimeout(r, 500)); return send(res, 200, statsResponse(from, to, q.get('offer'))); }
    try { return send(res, 200, await affise(from, to, q)); } catch (e) { return send(res, 502, { error: e.code || 'upstream', message: e.message }); }
  }
  const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': (T[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }); fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('http://localhost:' + PORT));
