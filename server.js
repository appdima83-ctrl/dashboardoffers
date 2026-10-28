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
const LOGIN = err => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0a0a"><title>Вход</title><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c radial-gradient(700px 350px at 80% -80px,rgba(255,106,26,.16),transparent);color:#F2F4F8;font:15px Inter,system-ui,sans-serif}form{width:min(360px,92vw);background:#131313;border:1px solid #242424;border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:20px}input{background:#0b0b0c;color:#F2F4F8;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px;font:inherit;font-size:16px}button{border:0;border-radius:10px;padding:12px;font:inherit;font-weight:600;color:#fff;background:linear-gradient(180deg,#FF7A2E,#F25C05);cursor:pointer}.e{color:#ff8a6a;font-size:13px;min-height:16px}</style></head><body><form method="post" action="/login"><img src="/icon-192.png" alt="" width="64" height="64" style="align-self:center;filter:drop-shadow(0 8px 16px rgba(40,70,200,.45))"><h1 style="text-align:center">Статистика ProfitCash</h1><input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required><div class="e">${err || ''}</div><button>Войти</button></form></body></html>`;
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
// Курсы валют Affise: rate = единиц валюты за 1 USD (USD = 1)
async function getRates() {
  return cached('rates', async () => {
    const out = { USD: 1 };
    try {
      const j = await aget('/3.0/currencies', []);
      for (const c of Object.values(j.currencies || {})) if (c && c.code && c.rate) out[String(c.code).toUpperCase()] = Number(c.rate);
    } catch (e) {
      const j = await aget('/3.0/admin/currency', []);
      for (const [k, v] of Object.entries(j.quotes || {})) out[k.toUpperCase()] = Number(v);
    }
    return out;
  }, 3600000);
}
const toUsd = (amount, code, rates) => { const r = rates[String(code).toUpperCase()]; return r ? amount / r : null; };
async function fetchBalance() {
  const [j, rates] = await Promise.all([aget('/3.0/balance', []), getRates()]);
  const b = j.balance || {};
  const conv = o => { let usd = 0; const parts = []; for (const [c, v] of Object.entries(o || {})) { const n = num(v); if (!n) continue; const u = toUsd(n, c, rates); if (u === null) continue; usd += u; parts.push({ code: c.toUpperCase(), amount: r4(n), usd: r4(u), rate: c.toUpperCase() === 'USD' ? 1 : r4(u / n) }); } return { usd: r4(usd), parts }; };
  const t = conv(b.balance), a = conv(b.available), h = conv(b.hold);
  return { total: { USD: t.usd }, available: { USD: a.usd }, hold: h.usd ? { USD: h.usd } : {}, parts: t.parts };
}
// Трафик по приложениям: приложения передают своё имя в sub1 ссылки оффера
async function sources(from, to) {
  const base = [['filter[date_from]', from], ['filter[date_to]', to], ['timezone', TZ]];
  return cached(['src', from, to].join('|'), async () => {
    const [bySrc, bySO, bySC, bySOC] = await Promise.all([
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'sub1']]),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'sub1'], ['slice[]', 'offer']]).catch(() => []),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'sub1'], ['slice[]', 'country']]).catch(() => []),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'sub1'], ['slice[]', 'offer'], ['slice[]', 'country']]).catch(() => []),
    ]);
    const oc = {};
    for (const x of bySOC) {
      const c = String(x.slice.country || '').toUpperCase(), n = norm(x);
      if (!x.slice.offer || !/^[A-Z]{2}$/.test(c) || !(n.hosts || n.clicks)) continue;
      ((oc[String(x.slice.sub1 || '').trim().toLowerCase() + '|' + x.slice.offer.id] ||= [])).push({ code: c, hosts: n.hosts, clicks: n.clicks });
    }
    const cty = {};
    for (const x of bySC) {
      const k = String(x.slice.sub1 || '').trim().toLowerCase(), c = String(x.slice.country || '').toUpperCase(), n = norm(x);
      if (!/^[A-Z]{2}$/.test(c) || !(n.hosts || n.clicks)) continue;
      (cty[k] ||= []).push({ code: c, hosts: n.hosts, clicks: n.clicks, conversions: n.conversions, amount: n.amount });
    }
    const hide = new Set((process.env.HIDE_OFFERS !== undefined ? process.env.HIDE_OFFERS : 'Finpug.co.za [CPL]').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    const inner = {};
    for (const x of bySO) {
      const k = String(x.slice.sub1 || '').trim().toLowerCase(), n = norm(x);
      if (!x.slice.offer || !(n.hosts || n.clicks || n.conversions)) continue;
      const ot = x.slice.offer.title.replace(/\[ /g, '[').replace(/ \]/g, ']').toLowerCase();
      if (hide.has(String(x.slice.offer.id).toLowerCase()) || hide.has(ot)) continue;
      (inner[k] ||= []).push({ id: String(x.slice.offer.id), title: x.slice.offer.title.replace(/\[ /g, '[').replace(/ \]/g, ']'), ...n, countries: (oc[k + '|' + x.slice.offer.id] || []).sort((a, b) => b.clicks - a.clicks) });
    }
    const map = {};
    for (const x of bySrc) {
      const k = String(x.slice.sub1 || '').trim().toLowerCase(), n = norm(x);
      const m = map[k] ||= { sub1: k, hosts: 0, clicks: 0, conversions: 0, amount: 0 };
      m.hosts += n.hosts; m.clicks += n.clicks; m.conversions += n.conversions; m.amount = r4(m.amount + n.amount);
    }
    const sources = Object.values(map).filter(m => m.hosts || m.clicks || m.conversions || m.amount)
      .map(m => ({ ...m, countries: (cty[m.sub1] || []).sort((a, b) => b.clicks - a.clicks || b.hosts - a.hosts), offers: (inner[m.sub1] || []).sort((a, b) => b.amount - a.amount || b.clicks - a.clicks) }))
      .sort((a, b) => b.amount - a.amount || b.clicks - a.clicks);
    const sp = Object.fromEntries((process.env.SRC_APPS !== undefined ? process.env.SRC_APPS : 'pautang=com.navo.navo_calculator').split(',').map(x => x.trim().split('=')).filter(x => x[0] && x[1]));
    for (const x of sources) if (sp[x.sub1]) x.pkg = sp[x.sub1];
    // Название и страна для меток без приложения в Google Play: метка=Название|ISO2
    const sm = Object.fromEntries((process.env.SRC_META !== undefined ? process.env.SRC_META : 'pautang=Mepresta Dinero rapido calc|MX|555903500').split(',').map(x => x.trim().split('=')).filter(x => x[0] && x[1]).map(([k, v]) => [k, v.split('|')]));
    for (const x of sources) if (sm[x.sub1]) { x.title = sm[x.sub1][0]; x.country = (sm[x.sub1][1] || '').toUpperCase(); x.gaProperty = sm[x.sub1][2] || ''; }
    await Promise.all(sources.filter(x => x.gaProperty).map(async x => { try { x.gaCountries = await ga.countriesBetween(x.gaProperty, from, to); } catch (e) { x.gaCountries = []; x.gaError = e.message; } }));
    return { demo: false, currency: 'USD', sources, updatedAt: new Date().toISOString() };
  }, 30000);
}

async function affise(from, to, q) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw Object.assign(new Error('Некорректные даты'), { code: 'bad_request' });
  const offer = q.get('offer');
  const base = [['filter[date_from]', from], ['filter[date_to]', to], ['timezone', TZ]];
  const balP = cached('bal', fetchBalance, 5000).catch(() => null);
  const catP = offersCatalog().catch(() => ({}));
  const ratesP = getRates().catch(() => ({ USD: 1 }));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // сегодняшняя дата в часовом поясе кабинета
  const todayP = cached('today|' + today, () => allPages('/3.0/stats/custom', [['filter[date_from]', today], ['filter[date_to]', today], ['timezone', TZ], ['slice[]', 'offer']]), 15000)
    .then(st => Object.fromEntries(st.map(x => [String(x.slice.offer.id), norm(x)]))).catch(() => null);
  const data = await cached(['s', from, to, offer].join('|'), async () => {
    const [daily, byOff, byCountry, byCO] = await Promise.all([
      allPages('/3.0/stats/getbydate', offer && offer !== 'all' ? [...base, ['filter[offer]', offer]] : base),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'offer']]),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'country']]).catch(() => []),
      allPages('/3.0/stats/custom', [...base, ['slice[]', 'country'], ['slice[]', 'offer']]).catch(() => []),
    ]);
    const map = {};
    for (const s of daily) { const d = s.slice; map[`${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`] = norm(s); }
    const rows = days(from, to).map(date => ({ date, ...(map[date] || { hosts: 0, clicks: 0, conversions: 0, amount: 0 }) }));
    const offers = byOff.map(s => ({ id: String(s.slice.offer.id), title: s.slice.offer.title.replace(/\[ /g, '[').replace(/ \]/g, ']'), ...norm(s) }));
    // Трафик по странам: хосты/клики по стране + топ офферов внутри страны
    const cl = t => String(t || '').replace(/\[ /g, '[').replace(/ \]/g, ']');
    const inner = {};
    for (const x of byCO) { const c = String(x.slice.country || '').toUpperCase(), n = norm(x); if (!c || !x.slice.offer || !(n.hosts || n.clicks)) continue; (inner[c] ||= []).push({ id: String(x.slice.offer.id), title: cl(x.slice.offer.title), hosts: n.hosts, clicks: n.clicks }); }
    const geo = byCountry.map(x => ({ code: String(x.slice.country || '').toUpperCase(), ...norm(x) })).filter(g => /^[A-Z]{2}$/.test(g.code) && (g.hosts || g.clicks))
      .sort((a, b) => b.hosts - a.hosts || b.clicks - a.clicks).slice(0, 25).map(g => ({ ...g, offers: (inner[g.code] || []).sort((a, b) => b.hosts - a.hosts || b.clicks - a.clicks).slice(0, 4) }));
    return { demo: false, currency: 'USD', rows, offers, geo, offersSource: 'affise', updatedAt: new Date().toISOString() };
  });
  const cat = await catP, rates = await ratesP;
  // Скрытые офферы (названия или ID через запятую, регистр не важен). HIDE_OFFERS= пусто — показывать все.
  const hide = new Set((process.env.HIDE_OFFERS !== undefined ? process.env.HIDE_OFFERS : 'Finpug.co.za [CPL]').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const hidden = o => hide.has(String(o.id).toLowerCase()) || hide.has(String(o.title || '').toLowerCase());
  data.offers = data.offers.filter(o => !hidden(o));
  data.geo = (data.geo || []).map(g => ({ ...g, offers: (g.offers || []).filter(o => !hidden(o)) }));
  return { ...data, offers: data.offers.map(o => ({ ...o, countries: (cat[o.id] || {}).countries || [], payouts: ((cat[o.id] || {}).payouts || []).map(p => { if (p.type === 'percent' || p.currency === 'USD') return p; const u = toUsd(p.revenue, p.currency, rates); return u === null ? p : { ...p, usd: r4(u), rate: r4(u / p.revenue) }; }) })), balance: await balP, today, offersToday: await todayP };
}
// Каталог офферов: страны оффера = страны из тарифов (payments) + двухбуквенные категории (ZA, IN, PH…)
async function offersCatalog() {
  return cached('catalog', async () => {
    const map = {}; let page = 1;
    for (;;) {
      const j = await aget('/3.0/partner/offers', [['limit', 100], ['page', page]]);
      for (const o of j.offers || []) {
        const set = new Set();
        (o.payments || []).forEach(p => { if (!p.country_exclude) (p.countries || []).forEach(c => /^[A-Za-z]{2}$/.test(c) && set.add(c.toUpperCase())); });
        (o.categories || []).forEach(c => /^[A-Z]{2}$/.test(c) && set.add(c));
        const seen = new Set(), payouts = [];
        (o.payments || []).forEach(p => {
          if (p.country_exclude) return;
          const r = Number(p.revenue) || 0, goal = String(p.title || p.goal || '').toUpperCase(), cur = String(p.currency || 'usd').toUpperCase(), k = [goal, r, cur, p.type].join('|');
          if (!seen.has(k)) { seen.add(k); payouts.push({ goal, revenue: r, currency: cur, type: p.type === 'percent' ? 'percent' : 'fixed' }); }
        });
        map[String(o.id)] = { countries: [...set], payouts };
      }
      if (!j.pagination || !j.pagination.next_page || !(j.offers || []).length) break;
      page = j.pagination.next_page;
    }
    return map;
  }, 600000);
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
  const PUBLIC = ['/manifest.webmanifest', '/sw.js', '/favicon-32.png', '/favicon-64.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/logo-glyph.png'];
  if (!authed && !PUBLIC.includes(u.pathname)) {
    if (u.pathname.startsWith('/api/')) return send(res, 401, { error: 'auth', message: 'Требуется вход' });
    res.writeHead(303, { Location: '/login' }); return res.end();
  }
  if (u.pathname === '/api/config') {
    if (!KEY) return send(res, 200, { ...CONFIG, hasKey: false });
    try { return send(res, 200, { ...CONFIG, hasKey: true, offers: await offersList() }); } catch (e) { return send(res, 200, { ...CONFIG, hasKey: true }); }
  }
  if (u.pathname === '/api/sources') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return send(res, 400, { error: 'bad_request', message: 'Некорректные даты' });
    if (!KEY) return send(res, 200, { demo: true, sources: [], updatedAt: new Date().toISOString() });
    try { return send(res, 200, await sources(from, to)); } catch (e) { return send(res, 502, { error: e.code || 'upstream', message: e.message }); }
  }
  if (u.pathname === '/api/play') {
    try { return send(res, 200, await require('./play.js').getPlay()); }
    catch (e) { return send(res, 502, { error: e.code || 'upstream', message: e.message }); }
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
