// Сервер лобби для "Стального рубежа": раздаёт игру (index.html) и пересылает сообщения внутри лобби.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
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
const clients = new Map();   // id -> client
const lobbies = new Map();   // code -> lobby
let NID = 1;
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAXP = 4, MINP = 2;
let shuttingDown = false;

const clean = (s, n, d) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').trim().slice(0, n) || d;
const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CH[Math.random() * CH.length | 0]; if (!lobbies.has(c)) return c; } };
const jsend = (c, o) => {
  if (shuttingDown || !c || !c.ws || c.ws.readyState !== 1) return;
  try { c.ws.send(JSON.stringify(o)); } catch (e) {}
};
const info = L => ({ t: 'lobby', code: L.code, name: L.name, lock: !!L.pass, host: L.host, started: L.started, max: MAXP, min: MINP,
  players: L.players.map(p => ({ id: p.id, name: p.name, tk: p.tk })) });
const bcast = (L, o) => L.players.forEach(p => jsend(p, o));

function leave(c) {
  const L = c.lobby; if (!L) return;
  c.lobby = null; L.players = L.players.filter(p => p !== c);
  if (!L.players.length) { lobbies.delete(L.code); return; }
  if (L.host === c.id) {
    if (L.started) { // хост ушёл посреди боя — симуляция потеряна, игра заканчивается
      L.players.forEach(p => { p.lobby = null; jsend(p, { t: 'end', msg: 'Хост вышел из игры' }); });
      lobbies.delete(L.code); return;
    }
    L.host = L.players[0].id;
  }
  bcast(L, info(L));
  if (L.started) bcast(L, { t: 'left', id: c.id });
}

wss.on('connection', ws => {
  const c = { ws, id: NID++, name: 'Игрок', tk: 'std', lobby: null, alive: true, n: 0, tw: Date.now() };
  clients.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => { leave(c); clients.delete(c.id); });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - c.tw > 2000) { c.tw = now; c.n = 0; }
    if (++c.n > 300) { ws.close(); return; }          // защита от флуда
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        c.name = clean(m.pn, 14, 'Игрок'); c.tk = clean(m.tk, 12, 'std');
        jsend(c, { t: 'hi', id: c.id, online: clients.size }); break;
      case 'list':
        jsend(c, { t: 'list', online: clients.size, lobbies: [...lobbies.values()].map(L => ({
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
        if (m.to === 'all') L.players.forEach(p => { if (p !== c && p.ws.readyState === 1) p.ws.send(pkt); });
        else {
          const tg = m.to === 'host' ? L.players.find(p => p.id === L.host) : L.players.find(p => p.id === m.to);
          if (tg && tg !== c && tg.ws.readyState === 1) tg.ws.send(pkt);
        }
        break;
      }
    }
  });
});

// keep-alive: Render разрывает «молчащие» соединения
const heartbeat = setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { try { c.ws.terminate(); } catch (e) {} continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 25000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, завершаю сервер…`);
  clearInterval(heartbeat);
  for (const c of clients.values()) {
    try { c.ws.close(1001, 'Server shutdown'); } catch (e) {}
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  // Не зависаем при подвисшем соединении.
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
