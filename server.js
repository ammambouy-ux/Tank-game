// Сервер лобби для "Стального рубежа": раздаёт игру и пересылает сообщения внутри лобби.
// Поддерживает кратковременное восстановление WebSocket-соединения без выброса игрока из боя.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();
const adminSessions = new Map();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const INDEX = path.join(__dirname, 'index.html');
const ADMIN_HTML = path.join(__dirname, 'admin.html');
const GAME_VERSION = '1.5.6';
const SFX_DIR = path.join(__dirname, 'PackSFXTanks');
const MUSIC_DIR = path.join(__dirname, 'PackMusic');
const AUDIO_RE = /\.(mp3|wav|ogg)$/i;
const AUDIO_MIME = { '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg' };
function serveAudioFile(res, dir, name, notFound) {
  if (!AUDIO_RE.test(name)) { res.writeHead(notFound ? 404 : 403); res.end('not found'); return; }
  const full = path.join(dir, name);
  if (full !== path.join(dir, path.basename(full)) || !full.startsWith(dir + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': AUDIO_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    res.end(d);
  });
}
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


// ================= Steel Frontier account API =================
const AUTH_GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const authGoogleClient = new OAuth2Client();
const authPool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 7000
}) : null;
let authSchemaPromise = null;
const authAttempts = new Map();
const AUTH_RATE_WINDOW = 15 * 60 * 1000;
const AUTH_RATE_LIMIT = 30;
const AUTH_SESSION_DAYS = 30;
function authCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}
function authLimited(req) {
  const now=Date.now(), key=String(req.socket && req.socket.remoteAddress || 'unknown');
  let item=authAttempts.get(key);
  if(!item||now-item.start>AUTH_RATE_WINDOW)item={start:now,count:0};
  item.count++;authAttempts.set(key,item);
  if(authAttempts.size>5000)for(const [k,v] of authAttempts)if(now-v.start>AUTH_RATE_WINDOW)authAttempts.delete(k);
  return item.count>AUTH_RATE_LIMIT;
}
async function ensureAuthSchema() {
  if(!authPool)throw new Error('AUTH_DATABASE_NOT_CONFIGURED');
  if(!authSchemaPromise)authSchemaPromise=(async()=>{
    await authPool.query("CREATE TABLE IF NOT EXISTS sf_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname VARCHAR(24) NOT NULL, password_salt TEXT, password_hash TEXT, google_sub TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await authPool.query("CREATE TABLE IF NOT EXISTS sf_auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await authPool.query("CREATE INDEX IF NOT EXISTS sf_auth_sessions_user_idx ON sf_auth_sessions(user_id)");
    await authPool.query("CREATE INDEX IF NOT EXISTS sf_auth_sessions_expiry_idx ON sf_auth_sessions(expires_at)");
    await authPool.query("CREATE TABLE IF NOT EXISTS sf_cloud_saves (user_id TEXT PRIMARY KEY REFERENCES sf_users(id) ON DELETE CASCADE, save_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  })().catch(err=>{authSchemaPromise=null;throw err;});
  return authSchemaPromise;
}
function authEmail(v){const s=String(v||'').trim().toLowerCase();return s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)?s:'';}
function authNickname(v,fallback){return String(v||'').replace(/[<>&"'\x60]/g,'').replace(/\s+/g,' ').trim().slice(0,24)||fallback||'Player';}
function authPublicUser(row){return{id:row.id,email:row.email,nickname:row.nickname,createdAt:row.created_at||null};}
function authTokenHash(t){return crypto.createHash('sha256').update(String(t)).digest('hex');}
function authScrypt(password,salt){return new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(e,key)=>e?reject(e):resolve(key.toString('hex'))));}
async function authCreateSession(userId){
  const token=crypto.randomBytes(32).toString('base64url'),expires=new Date(Date.now()+AUTH_SESSION_DAYS*86400000);
  await authPool.query('INSERT INTO sf_auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[authTokenHash(token),userId,expires.toISOString()]);
  return token;
}
async function authCurrentUser(req){
  const m=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);if(!m)return null;
  const token=m[1].trim();if(token.length<32||token.length>256)return null;
  const r=await authPool.query('SELECT u.id,u.email,u.nickname,u.created_at FROM sf_auth_sessions s JOIN sf_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[authTokenHash(token)]);
  return r.rows[0]||null;
}
function authCleanSave(v){
  const src=v&&typeof v==='object'&&!Array.isArray(v)?v:{};
  const num=x=>{const n=Number(x);return Number.isFinite(n)?Math.max(0,Math.min(1000000000000,Math.floor(n))):0;};
  let tanks=[];try{tanks=Array.isArray(src.to)?src.to:(typeof src.to==='string'?JSON.parse(src.to):[]);}catch(e){}
  if(!Array.isArray(tanks))tanks=[];
  tanks=[...new Set(tanks.filter(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,12}$/.test(x)))].slice(0,128);
  if(!tanks.includes('std'))tanks.unshift('std');
  const equipped=typeof src.te==='string'&&/^[a-zA-Z0-9_-]{1,12}$/.test(src.te)?src.te:'std';
  if(!tanks.includes(equipped))tanks.push(equipped);
  return{tb:num(src.tb),tc:num(src.tc),to:tanks,te:equipped};
}
function authSendError(res,status,error){sendJson(res,status,{ok:false,error:error});}
async function handleAuth(req,res){
  const url=new URL(req.url,'http://'+(req.headers.host||'localhost'));
  if(!url.pathname.startsWith('/api/auth/'))return false;
  authCors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return true;}
  if(url.pathname==='/api/auth/config'&&req.method==='GET')return sendJson(res,200,{ok:true,databaseConfigured:!!authPool,googleClientId:AUTH_GOOGLE_CLIENT_ID,googleEnabled:!!AUTH_GOOGLE_CLIENT_ID});
  const route=url.pathname;
  if(!['GET','POST','PUT'].includes(req.method)){authSendError(res,405,'Метод не поддерживается');return true;}
  if(['/api/auth/register','/api/auth/login','/api/auth/google'].includes(route)&&authLimited(req)){authSendError(res,429,'Слишком много попыток. Повторите через 15 минут.');return true;}
  try{
    await ensureAuthSchema();
    if(route==='/api/auth/register'&&req.method==='POST'){
      const b=await readBody(req),email=authEmail(b.email),password=String(b.password||'');
      if(!email){authSendError(res,400,'Укажи корректный адрес электронной почты.');return true;}
      if(password.length<8||password.length>128){authSendError(res,400,'Пароль должен содержать от 8 до 128 символов.');return true;}
      const nick=authNickname(b.nickname,email.split('@')[0].slice(0,24)),salt=crypto.randomBytes(16).toString('hex'),hash=await authScrypt(password,salt),id=crypto.randomUUID();
      let r;try{r=await authPool.query('INSERT INTO sf_users(id,email,nickname,password_salt,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,email,nickname,created_at',[id,email,nick,salt,hash]);}
      catch(e){if(e&&e.code==='23505'){authSendError(res,409,'Аккаунт с таким адресом уже существует. Войди в него.');return true;}throw e;}
      return sendJson(res,201,{ok:true,token:await authCreateSession(id),user:authPublicUser(r.rows[0])});
    }
    if(route==='/api/auth/login'&&req.method==='POST'){
      const b=await readBody(req),email=authEmail(b.email),password=String(b.password||'');
      if(!email||!password||password.length>128){authSendError(res,400,'Проверь адрес почты и пароль.');return true;}
      const r=await authPool.query('SELECT id,email,nickname,created_at,password_salt,password_hash FROM sf_users WHERE email=$1',[email]),u=r.rows[0];
      if(!u||!u.password_hash||!u.password_salt){authSendError(res,401,'Неверная почта или пароль.');return true;}
      const candidate=Buffer.from(await authScrypt(password,u.password_salt),'hex'),stored=Buffer.from(u.password_hash,'hex');
      if(candidate.length!==stored.length||!crypto.timingSafeEqual(candidate,stored)){authSendError(res,401,'Неверная почта или пароль.');return true;}
      return sendJson(res,200,{ok:true,token:await authCreateSession(u.id),user:authPublicUser(u)});
    }
    if(route==='/api/auth/google'&&req.method==='POST'){
      if(!AUTH_GOOGLE_CLIENT_ID){authSendError(res,503,'Вход через Google ещё не настроен на сервере.');return true;}
      const b=await readBody(req),idToken=String(b.idToken||'');
      if(!idToken||idToken.length>12000){authSendError(res,400,'Не удалось получить токен Google.');return true;}
      let payload;try{payload=(await authGoogleClient.verifyIdToken({idToken:idToken,audience:AUTH_GOOGLE_CLIENT_ID})).getPayload();}
      catch(e){authSendError(res,401,'Не удалось подтвердить аккаунт Google. Попробуй ещё раз.');return true;}
      if(!payload||!payload.sub||!payload.email||payload.email_verified!==true){authSendError(res,401,'Google не подтвердил адрес электронной почты.');return true;}
      const email=authEmail(payload.email);if(!email){authSendError(res,400,'Google вернул некорректный адрес почты.');return true;}
      const found=await authPool.query('SELECT id,email,nickname,created_at,google_sub FROM sf_users WHERE google_sub=$1 OR email=$2 LIMIT 1',[String(payload.sub),email]);
      let u=found.rows[0];
      if(u){
        if(u.google_sub&&u.google_sub!==String(payload.sub)){authSendError(res,409,'Этот адрес уже связан с другим аккаунтом Google.');return true;}
        if(!u.google_sub){const linked=await authPool.query('UPDATE sf_users SET google_sub=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,nickname,created_at',[String(payload.sub),u.id]);u=linked.rows[0];}
      }else{
        const id=crypto.randomUUID(),nick=authNickname(b.nickname||payload.name,email.split('@')[0]);
        const created=await authPool.query('INSERT INTO sf_users(id,email,nickname,google_sub) VALUES($1,$2,$3,$4) RETURNING id,email,nickname,created_at',[id,email,nick,String(payload.sub)]);u=created.rows[0];
      }
      return sendJson(res,200,{ok:true,token:await authCreateSession(u.id),user:authPublicUser(u)});
    }
    if(route==='/api/auth/me'&&req.method==='GET'){
      const u=await authCurrentUser(req);if(!u){authSendError(res,401,'Сессия завершена. Войди в аккаунт снова.');return true;}
      return sendJson(res,200,{ok:true,user:authPublicUser(u)});
    }
    if(route==='/api/auth/logout'&&req.method==='POST'){
      const m=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);if(m)await authPool.query('DELETE FROM sf_auth_sessions WHERE token_hash=$1',[authTokenHash(m[1].trim())]);
      return sendJson(res,200,{ok:true});
    }
    if(route==='/api/auth/profile'&&req.method==='POST'){
      const u=await authCurrentUser(req);if(!u){authSendError(res,401,'Сессия завершена. Войди в аккаунт снова.');return true;}
      const b=await readBody(req),nick=authNickname(b.nickname,'');
      if(nick.length<2){authSendError(res,400,'Ник должен содержать минимум 2 символа.');return true;}
      const r=await authPool.query('UPDATE sf_users SET nickname=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,nickname,created_at',[nick,u.id]);
      return sendJson(res,200,{ok:true,user:authPublicUser(r.rows[0])});
    }
    if(route==='/api/auth/save'&&req.method==='GET'){
      const u=await authCurrentUser(req);if(!u){authSendError(res,401,'Сессия завершена. Войди в аккаунт снова.');return true;}
      const r=await authPool.query('SELECT save_json,updated_at FROM sf_cloud_saves WHERE user_id=$1',[u.id]);
      return r.rows.length?sendJson(res,200,{ok:true,exists:true,save:r.rows[0].save_json,updatedAt:r.rows[0].updated_at}):sendJson(res,200,{ok:true,exists:false,save:null});
    }
    if(route==='/api/auth/save'&&req.method==='PUT'){
      const u=await authCurrentUser(req);if(!u){authSendError(res,401,'Сессия завершена. Войди в аккаунт снова.');return true;}
      const b=await readBody(req),save=authCleanSave(b.save);
      await authPool.query('INSERT INTO sf_cloud_saves(user_id,save_json,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(user_id) DO UPDATE SET save_json=EXCLUDED.save_json,updated_at=NOW()',[u.id,JSON.stringify(save)]);
      return sendJson(res,200,{ok:true,save:save});
    }
    authSendError(res,404,'Неизвестный маршрут аккаунта.');return true;
  }catch(e){
    if(!authPool||String(e&&e.message||'').includes('AUTH_DATABASE_NOT_CONFIGURED')){authSendError(res,503,'Аккаунты пока не подключены: серверу нужна постоянная PostgreSQL-база.');return true;}
    console.error('Account API error:',e&&e.message||e);
    authSendError(res,503,'Сервис аккаунтов временно недоступен. Попробуй позже.');return true;
  }
}
// ==============================================================

const server = http.createServer(async (req, res) => {
  if (await handleAuth(req,res)) return;
  if (await handleAdmin(req,res)) return;
  const sfxUrl = decodeURIComponent((req.url || '').split('?')[0]);
  if (sfxUrl === '/api/sfx' && req.method === 'GET') {
    fs.readdir(SFX_DIR, (e, files) => sendJson(res, 200, e ? [] : files.filter(f => AUDIO_RE.test(f))));
    return;
  }
  if (sfxUrl === '/api/music' && req.method === 'GET') {
    fs.readdir(MUSIC_DIR, (e, files) => sendJson(res, 200, e ? [] : files.filter(f => AUDIO_RE.test(f))));
    return;
  }
  if (sfxUrl.startsWith('/PackSFXTanks/') && req.method === 'GET') { serveAudioFile(res, SFX_DIR, path.basename(sfxUrl), true); return; }
  if (sfxUrl.startsWith('/PackMusic/') && req.method === 'GET') { serveAudioFile(res, MUSIC_DIR, path.basename(sfxUrl), true); return; }
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
