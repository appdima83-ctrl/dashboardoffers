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
const LOGIN = err => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0a0a"><title>Вход</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a radial-gradient(700px 350px at 80% -80px,rgba(255,106,26,.16),transparent);color:#F5F1EC;font:15px Inter,system-ui,sans-serif}form{width:min(360px,92vw);background:#131211;border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:26px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:20px}input{background:#0a0a0a;color:#F5F1EC;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px;font:inherit;font-size:16px}button{border:0;border-radius:10px;padding:12px;font:inherit;font-weight:600;color:#1a0a00;background:linear-gradient(180deg,#FF7A2E,#F25C05);cursor:pointer}.e{color:#ff8a6a;font-size:13px;min-height:16px}</style></head><body><form method="post" action="/login"><h1>Статистика ProfitCash</h1><input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required><div class="e">${err || ''}</div><button>Войти</button></form></body></html>`;
const PORT = process.env.PORT || 3000;
const KEY = process.env.AFFISE_API_KEY || '';

const { statsResponse, CONFIG } = require('./demo.js');

// --- Реальный Affise: поля НЕ угаданы, требуется сверка с docs3.1 ---
async function affise() { const e = new Error('Интеграция с Affise ещё не сверена с документацией'); e.code = 'NOT_IMPLEMENTED'; throw e; }

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
  const PUBLIC = ['/manifest.webmanifest', '/icon.svg', '/sw.js'];
  if (!authed && !PUBLIC.includes(u.pathname)) {
    if (u.pathname.startsWith('/api/')) return send(res, 401, { error: 'auth', message: 'Требуется вход' });
    res.writeHead(303, { Location: '/login' }); return res.end();
  }
  if (u.pathname === '/api/config') return send(res, 200, { ...CONFIG, hasKey: !!KEY });
  if (u.pathname === '/api/stats') {
    const q = u.searchParams, from = q.get('from'), to = q.get('to');
    if (q.get('fail') === 'network') return send(res, 502, { error: 'network', message: 'Сетевая ошибка при обращении к Affise API' });
    if (q.get('demo') === '1') { await new Promise(r => setTimeout(r, 500)); return send(res, 200, statsResponse(from, to, q.get('offer'))); }
    if (!KEY) return send(res, 401, { error: 'no_key', message: 'Не задан AFFISE_API_KEY' });
    try { return send(res, 200, await affise(from, to, q)); } catch (e) { return send(res, 502, { error: e.code || 'upstream', message: e.message }); }
  }
  const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const T = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': (T[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }); fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('http://localhost:' + PORT));
