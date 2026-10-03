// Сервер лобби для "Стального рубежа": раздаёт игру и пересылает сообщения внутри лобби.
// Поддерживает кратковременное восстановление WebSocket-соединения без выброса игрока из боя.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const GAME_VERSION = '1.2.0';
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();
const adminSessions = new Map();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const INDEX = path.join(__dirname, 'index.html');
const ADMIN_HTML = path.join(__dirname, 'admin.html');
const DISCONNECT_GRACE_MS = 60_000;

function sendJson(res, code, data, extra={}) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body='';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function adminToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
function adminAuthorized(req) {
  if (!ADMIN_KEY) return false;
  const token = adminToken(req), exp = adminSessions.get(token);
  if (!token || !exp || exp < Date.now()) { if (token) adminSessions.delete(token); return false; }
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  return true;
}
function adminLogin(req, res, key) {
  if (!ADMIN_KEY || key !== ADMIN_KEY) return sendJson(res, 401, { ok:false, error:'Неверный ключ' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  sendJson(res, 200, { ok:true, token, version:GAME_VERSION });
}
function adminPlayers() {
  return [...clients.values()].map(c => ({ id:c.id, name:c.name, connected:!!c.connected, lobby:c.lobby?.code || null, lobbyName:c.lobby?.name || null, host:c.lobby?.host===c.id, started:!!c.lobby?.started }));
}
function adminLobbies() {
  return [...lobbies.values()].map(L => ({ code:L.code, name:L.name, host:L.host, started:L.started, players:L.players.length, max:MAXP, lock:!!L.pass, members:L.players.map(p=>({id:p.id,name:p.name,connected:!!p.connected})) }));
}
function closeLobby(L, msg='Лобби закрыто администратором') {
  if (!L) return false;
  if (L.started) L.players.forEach(p => { p.lobby=null; jsend(p,{t:'end',msg}); });
  else L.players.forEach(p => { p.lobby=null; jsend(p,{t:'admin',msg}); });
  L.players.forEach(p=>{ revokeSession(p); try{p.ws?.close(4002,'Lobby closed by admin')}catch(e){} });
  for (const p of L.players) clients.delete(p.id);
  lobbies.delete(L.code);
  return true;
}
async function handleAdmin(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/admin' && req.method === 'GET') {
    fs.readFile(ADMIN_HTML, (e,d)=>{
      if (e) return sendJson(res,404,{ok:false,error:'admin.html not found'});
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(d);
    });
    return true;
  }
  if (!url.pathname.startsWith('/api/admin/')) return false;
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    try { const b=await readBody(req); return adminLogin(req,res,String(b.key||'')); } catch(e) { return sendJson(res,400,{ok:false,error:e.message}); }
  }
  if (!adminAuthorized(req)) { sendJson(res,401,{ok:false,error:'Требуется авторизация'}); return true; }
  if (url.pathname === '/api/admin/status' && req.method === 'GET') {
    return sendJson(res,200,{ok:true,version:GAME_VERSION,uptime:Math.floor(process.uptime()),online:connectedCount(),clients:clients.size,lobbies:adminLobbies(),players:adminPlayers()});
  }
  if (url.pathname === '/api/admin/action' && req.method === 'POST') {
    try {
      const b=await readBody(req); const action=String(b.action||'');
      if(action==='broadcast'){
        const msg=clean(b.message,240,''); if(!msg) return sendJson(res,400,{ok:false,error:'Сообщение пустое'});
        for(const c of clients.values()) jsend(c,{t:'admin',msg});
        return sendJson(res,200,{ok:true});
      }
      if(action==='kick'){
        const id=Number(b.id), c=clients.get(id); if(!c) return sendJson(res,404,{ok:false,error:'Игрок не найден'});
        leave(c);
        try{c.ws?.close(4001,'Kicked by admin')}catch(e){}
        return sendJson(res,200,{ok:true});
      }
      if(action==='closeLobby'){
        const code=String(b.code||'').toUpperCase().trim(), L=lobbies.get(code); if(!L) return sendJson(res,404,{ok:false,error:'Лобби не найдено'});
        closeLobby(L); return sendJson(res,200,{ok:true});
      }
      if(action==='restart'){
        sendJson(res,200,{ok:true});
        setTimeout(()=>shutdown('ADMIN_RESTART'),250);
        return true;
      }
      if(action==='logout'){
        const token=adminToken(req); adminSessions.delete(token); return sendJson(res,200,{ok:true});
      }
      return sendJson(res,400,{ok:false,error:'Неизвестное действие'});
    } catch(e) { return sendJson(res,400,{ok:false,error:e.message}); }
  }
  sendJson(res,404,{ok:false,error:'not found'}); return true;
}

const server = http.createServer(async (req, res) => {
  if (await handleAdmin(req,res)) return;
  if (req.url === '/health') { sendJson(res,200,{ok:true,version:GAME_VERSION,online:connectedCount(),lobbies:lobbies.size}); return; }
  if (req.url === '/' || req.url.startsWith('/index.html')) {
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(404); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
server.on('error', err => {
  console.error('Ошибка HTTP-сервера:', err);
  process.exit(1);
});
wss.on('error', err => {
  console.error('Ошибка WebSocket-сервера:', err);
  process.exit(1);
});

const clients = new Map();   // id -> client, включая игроков в коротком окне переподключения
const sessions = new Map();  // resumeToken -> client
const lobbies = new Map();   // code -> lobby
let NID = 1;
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAXP = 4, MINP = 2;
let shuttingDown = false;

const clean = (s, n, d) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').trim().slice(0, n) || d;
const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CH[Math.random() * CH.length | 0]; if (!lobbies.has(c)) return c; } };
const newToken = () => crypto.randomBytes(24).toString('hex');
const connectedCount = () => { let n = 0; for (const c of clients.values()) if (c.connected && c.ws) n++; return n; };
const jsend = (c, o) => {
  if (shuttingDown || !c || !c.ws || c.ws.readyState !== 1) return;
  try { c.ws.send(JSON.stringify(o)); } catch (e) {}
};
const info = L => ({ t: 'lobby', code: L.code, name: L.name, lock: !!L.pass, host: L.host, started: L.started, max: MAXP, min: MINP,
  players: L.players.map(p => ({ id: p.id, name: p.name, tk: p.tk, connected: !!p.connected })) });
const bcast = (L, o) => L.players.forEach(p => jsend(p, o));

function revokeSession(c) {
  if (c.graceTimer) { clearTimeout(c.graceTimer); c.graceTimer = null; }
  if (c.token) sessions.delete(c.token);
  c.disconnectedUntil = 0;
}

function leave(c) {
  const L = c.lobby; if (!L) { revokeSession(c); return; }
  revokeSession(c);
  c.lobby = null;
  L.players = L.players.filter(p => p !== c);
  if (!L.players.length) { lobbies.delete(L.code); clients.delete(c.id); return; }
  if (L.host === c.id) {
    if (L.started) { // хост ушёл окончательно — симуляция потеряна, игра заканчивается
      L.players.forEach(p => { p.lobby = null; jsend(p, { t: 'end', msg: 'Хост вышел из игры' }); });
      lobbies.delete(L.code);
    } else {
      L.host = L.players[0].id;
      bcast(L, info(L));
    }
  } else {
    bcast(L, info(L));
    if (L.started) bcast(L, { t: 'left', id: c.id });
  }
  clients.delete(c.id);
}

function deferDisconnect(c) {
  if (c.disconnectedUntil || !c.lobby) {
    if (!c.lobby) { revokeSession(c); clients.delete(c.id); }
    return;
  }
  c.connected = false;
  c.disconnectedUntil = Date.now() + DISCONNECT_GRACE_MS;
  c.graceTimer = setTimeout(() => {
    if (c.connected || !c.lobby || Date.now() < c.disconnectedUntil) return;
    leave(c);
  }, DISCONNECT_GRACE_MS + 100);
  if (c.lobby.started) bcast(c.lobby, { t: 'disconnecting', id: c.id });
  else bcast(c.lobby, info(c.lobby));
}

wss.on('connection', ws => {
  let c = { ws, id: NID++, name: 'Игрок', tk: 'std', lobby: null, connected: true, alive: true, n: 0, tw: Date.now(), token: newToken(), disconnectedUntil: 0, graceTimer: null };
  sessions.set(c.token, c);
  clients.set(c.id, c);

  ws.on('pong', () => { if (c.ws === ws) c.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => {
    // После resume c.ws указывает уже на новый сокет, поэтому старый close ничего не ломает.
    if (c.ws !== ws) return;
    c.ws = null;
    c.alive = false;
    deferDisconnect(c);
  });
  ws.on('message', raw => {
    const now = Date.now();
    if (!c.connected || c.ws !== ws) return;
    if (now - c.tw > 2000) { c.tw = now; c.n = 0; }
    if (++c.n > 300) { ws.close(); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    switch (m.t) {
      case 'hello': {
        const rt = clean(m.resume, 64, '');
        const old = rt ? sessions.get(rt) : null;
        if (old && old !== c && !old.connected && old.lobby && old.disconnectedUntil > Date.now()) {
          clients.delete(c.id);
          sessions.delete(c.token);
          if (old.graceTimer) { clearTimeout(old.graceTimer); old.graceTimer = null; }
          c = old;
          c.ws = ws;
          c.connected = true;
          c.alive = true;
          c.disconnectedUntil = 0;
          c.n = 0;
          c.tw = Date.now();
          jsend(c, { t: 'hi', id: c.id, online: connectedCount(), resume: c.token, resumed: true });
          jsend(c, info(c.lobby));
          if (c.lobby.started) jsend(c, { t: 'resume', started: true });
          break;
        }
        c.name = clean(m.pn, 14, c.name);
        c.tk = clean(m.tk, 12, c.tk);
        jsend(c, { t: 'hi', id: c.id, online: connectedCount(), resume: c.token, resumed: false });
        break;
      }
      case 'list':
        jsend(c, { t: 'list', online: connectedCount(), lobbies: [...lobbies.values()].map(L => ({
          code: L.code, name: L.name, n: L.players.length, max: MAXP, lock: !!L.pass, started: L.started })) }); break;
      case 'create': {
        if (c.lobby) leave(c);
        if (lobbies.size >= 200) { jsend(c, { t: 'err', msg: 'Слишком много лобби, попробуй позже' }); break; }
        c.name = clean(m.pn, 14, c.name); c.tk = clean(m.tk, 12, c.tk);
        const L = { code: newCode(), name: clean(m.name, 20, 'Лобби'), pass: clean(m.pass, 16, ''), host: c.id, started: false, players: [c] };
        lobbies.set(L.code, L); c.lobby = L; jsend(c, info(L)); break;
      }
      case 'join': {
        const L = lobbies.get(String(m.code || '').toUpperCase().trim());
        if (!L) { jsend(c, { t: 'err', msg: 'Лобби с таким кодом не найдено' }); break; }
        if (L.started) { jsend(c, { t: 'err', msg: 'Игра в этом лобби уже началась' }); break; }
        if (L.players.length >= MAXP) { jsend(c, { t: 'err', msg: 'Лобби заполнено (4/4)' }); break; }
        if (L.pass && clean(m.pass, 16, '') !== L.pass) { jsend(c, { t: 'err', msg: 'Неверный пароль' }); break; }
        if (c.lobby === L) { jsend(c, info(L)); break; }
        if (c.lobby) leave(c);
        c.name = clean(m.pn, 14, c.name); c.tk = clean(m.tk, 12, c.tk);
        L.players.push(c); c.lobby = L; bcast(L, info(L)); break;
      }
      case 'leave': leave(c); break;
      case 'start': {
        const L = c.lobby; if (!L || L.host !== c.id || L.started) break;
        if (L.players.length < MINP) { jsend(c, { t: 'err', msg: 'Нужно минимум 2 игрока' }); break; }
        L.started = true; bcast(L, info(L)); bcast(L, { t: 'start' }); break;
      }
      case 'r': { // пересылка игровых данных внутри лобби
        const L = c.lobby; if (!L || !L.started) break;
        if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) break;
        let pkt;
        try { pkt = JSON.stringify({ t: 'r', from: c.id, d: m.d }); } catch (e) { break; }
        if (pkt.length > 96 * 1024) break;
        const out = { t: 'r', from: c.id, d: m.d };
        if (m.to === 'all') L.players.forEach(p => { if (p !== c) jsend(p, out); });
        else {
          const tg = m.to === 'host' ? L.players.find(p => p.id === L.host) : L.players.find(p => p.id === m.to);
          if (tg && tg !== c) jsend(tg, out);
        }
        break;
      }
    }
  });
});

// keep-alive: Render разрывает «молчащие» соединения
const heartbeat = setInterval(() => {
  for (const c of clients.values()) {
    if (!c.connected || !c.ws) continue;
    if (!c.alive) { try { c.ws.terminate(); } catch (e) {} continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 25_000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, завершаю сервер…`);
  clearInterval(heartbeat);
  for (const c of clients.values()) {
    if (c.graceTimer) clearTimeout(c.graceTimer);
    try { if (c.ws) c.ws.close(1001, 'Server shutdown'); } catch (e) {}
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  console.error('Необработанная ошибка, процесс будет перезапущен платформой:', err);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('Необработанный Promise rejection, процесс будет перезапущен платформой:', reason);
  process.exit(1);
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
