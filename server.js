#!/usr/bin/env node
'use strict';
/*
 * Good Look — servidor único.
 *
 * Ele faz duas coisas:
 *   1. entrega o site (index.html, home.html, app.html, sync.js, vídeos...);
 *   2. guarda o que é de todo mundo: contas, vídeos, shorts, conversas e live.
 *
 * Sem dependências: só o Node. Os dados ficam em DATA_DIR/db.json e os arquivos
 * enviados (vídeo da galeria, foto de perfil, foto no chat) em DATA_DIR/uploads.
 *
 * Rodar:  node server.js          (porta 3000, ou PORT=... )
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 30 * 1024 * 1024;     // pushes (perfil, conversas)
const MAX_UPLOAD = 300 * 1024 * 1024;  // vídeo escolhido na galeria (vídeo de celular é grande)
const MAX_DATA_URL = 8 * 1024 * 1024;  // foto em base64 que vira arquivo
const KINDS = ['users', 'videos', 'pubMsgs', 'privMsgs'];
const EXT_OK = ['mp4', 'mov', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ==================== BANCO ==================== */

let clock = Date.now();
let db = { users: {}, videos: {}, pubMsgs: {}, privMsgs: {}, live: null, liveU: 0, del: {}, tokens: {} };

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    KINDS.forEach(function (k) { if (raw[k]) db[k] = raw[k]; });
    db.live = raw.live || null;
    db.liveU = raw.liveU || 0;
    db.del = raw.del || {};
    db.tokens = raw.tokens || {};
    const marcas = [Date.now()];
    KINDS.forEach(function (k) { for (const id in db[k]) marcas.push(db[k][id]._u || 0); });
    db.liveU && marcas.push(db.liveU);
    clock = Math.max.apply(null, marcas);
    console.log('banco carregado: ' + Object.keys(db.users).length + ' contas, ' + Object.keys(db.videos).length + ' vídeos');
  } catch (e) {
    console.log('banco novo em ' + DB_FILE);
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('não deu para salvar o banco:', e.message);
    }
  }, 600);
}

/* ==================== SENHAS E ACESSO ==================== */

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}
function novaSenha(pass) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + hashPass(pass, salt);
}
function confereSenha(pass, guardada) {
  const partes = String(guardada || '').split(':');
  if (partes.length !== 2) return false;
  const calc = hashPass(pass, partes[0]);
  return calc.length === partes[1].length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(partes[1]));
}
function novoToken(userId) {
  const t = crypto.randomBytes(24).toString('hex');
  db.tokens[t] = userId;
  saveDb();
  return t;
}
function logado(req) {
  const h = String(req.headers.authorization || '');
  const t = h.replace(/^Bearer\s+/i, '');
  const uid = db.tokens[t];
  return uid ? db.users[uid] : null;
}
function estaBanido(u) {
  if (!u || !u.banned) return false;
  return u.banUntil === -1 || !u.banUntil || Date.now() < u.banUntil;
}

/* ==================== CONTAS ==================== */

function usuarioPublico(u) {
  const o = Object.assign({}, u);
  delete o.password;
  o._server = true;
  return o;
}

function seedCriador() {
  if (db.users.creator) return;
  db.users.creator = {
    id: 'creator', name: 'tex_tt', username: 'tex_tt', bio: '👑 Criador do Good Look',
    photo: null, followers: 100000, following: [], likes: 0,
    verified: true, verifiedType: 'blue', isCreator: true, isAdmin: true,
    banned: false, banUntil: null, savedVideos: [],
    password: novaSenha('12345678910'), _u: ++clock
  };
  saveDb();
  console.log('conta do criador criada: tex_tt');
}

// Conta de suporte: é o canal oficial para tirar dúvidas e ajudar quem usa o
// app. Vive no servidor, então ela existe para todo mundo e pode ser acessada
// de qualquer aparelho com o nome "suporte good look".
function seedSuporte() {
  if (db.users.suporte) return;
  db.users.suporte = {
    id: 'suporte', name: 'suporte good look', username: 'suporte_good_look',
    bio: '💬 Suporte oficial do Good Look — tire suas dúvidas aqui',
    photo: null, followers: 0, following: [], likes: 0,
    verified: false, verifiedType: null, isCreator: false, isAdmin: false,
    banned: false, banUntil: null, savedVideos: [],
    password: novaSenha('54321'), _u: ++clock
  };
  saveDb();
  console.log('conta de suporte criada: suporte good look');
}

function salvarUsuario(extra) {
  const id = 'u' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const u = Object.assign({
    id: id, photo: null, bio: '', followers: 0, following: [], likes: 0,
    verified: false, verifiedType: null, isCreator: false, isAdmin: false,
    banned: false, banUntil: null, savedVideos: []
  }, extra);
  if (u.photo) u = localizarMedia(u);
  u._u = ++clock;
  db.users[id] = u;
  saveDb();
  return u;
}

function acharPorNome(nome) {
  const alvo = String(nome || '').trim().toLowerCase();
  for (const id in db.users) {
    const u = db.users[id];
    if (String(u.name || '').toLowerCase() === alvo || String(u.username || '').toLowerCase() === alvo) return u;
  }
  return null;
}

function acharCriador() {
  for (const id in db.users) if (db.users[id].isCreator) return db.users[id];
  return null;
}

/* ==================== MÍDIA ==================== */

function localizarMedia(item) {
  ['photo', 'image'].forEach(function (campo) {
    const v = item[campo];
    if (typeof v !== 'string' || v.indexOf('data:') !== 0 || v.indexOf(';base64,') < 0) return;
    if (v.length > MAX_DATA_URL) { item[campo] = null; return; }
    const m = v.match(/^data:([^;]+);base64,([\s\S]*)$/);
    if (!m) return;
    let ext = (m[1].split('/')[1] || 'bin').toLowerCase().replace('jpeg', 'jpg').replace('quicktime', 'mov');
    if (EXT_OK.indexOf(ext) < 0) ext = 'bin';
    const nome = 'mid' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, nome), Buffer.from(m[2], 'base64'));
      item[campo] = '/uploads/' + nome;
    } catch (e) {
      console.error('não deu para guardar a mídia:', e.message);
      item[campo] = null;
    }
  });
  return item;
}

/* ==================== SINCRONIA ==================== */

function deltasDe(since) {
  const out = { now: clock, users: [], videos: [], pubMsgs: [], privMsgs: [], deleted: {}, live: db.live, liveU: db.liveU };
  KINDS.forEach(function (kind) {
    const bag = db[kind], del = db.del[kind] || {};
    out.deleted[kind] = [];
    for (const id in bag) if ((bag[id]._u || 0) > since) out[kind].push(kind === 'users' ? usuarioPublico(bag[id]) : bag[id]);
    for (const id in del) if (del[id] > since) out.deleted[kind].push(id);
  });
  return out;
}

function aplicarPush(body, quem) {
  let mexeu = false;
  KINDS.forEach(function (kind) {
    const itens = Array.isArray(body[kind]) ? body[kind] : [];
    itens.forEach(function (item) {
      if (!item || !item.id) return;
      let novo = Object.assign({}, item);
      if (kind === 'users') {
        // Cada um edita o próprio perfil; só o criador mexe na conta dos outros.
        if (novo.id !== quem.id && !quem.isCreator) return;
        const antigo = db.users[novo.id];
        delete novo.password;
        novo._server = true;
        novo = localizarMedia(novo);
        if (antigo && antigo.password) novo.password = antigo.password;
        if (antigo && antigo.isCreator && !novo.isCreator) novo.isCreator = true;
      }
      if (kind === 'videos' || kind === 'pubMsgs' || kind === 'privMsgs') novo = localizarMedia(novo);
      novo._u = ++clock;
      db[kind][novo.id] = novo;
      if (db.del[kind]) delete db.del[kind][novo.id];
      mexeu = true;
    });
    const apagar = (body.deleted && Array.isArray(body.deleted[kind])) ? body.deleted[kind] : [];
    apagar.forEach(function (id) {
      if (!id) return;
      if (kind === 'users' && id !== quem.id && !quem.isCreator) return;
      delete db[kind][id];
      db.del[kind] = db.del[kind] || {};
      db.del[kind][id] = ++clock;
      mexeu = true;
    });
  });
  if (body.temLive) {
    db.live = body.live || null;
    db.liveU = ++clock;
    mexeu = true;
  }
  if (mexeu) saveDb();
  return { ok: true, now: clock, mexeu: mexeu };
}

/* ==================== HTTP ==================== */

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function corpo(req, limite) {
  return new Promise(function (ok, falha) {
    const partes = [];
    let n = 0;
    req.on('data', function (d) {
      n += d.length;
      if (n > limite) { falha(new Error('grande')); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', function () { ok(Buffer.concat(partes)); });
    req.on('error', falha);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

// Range = "me manda só este pedaço do arquivo". É o que o navegador usa para
// abrir o vídeo, pular para um tempo e mostrar o quadro da capa. Sem isso o
// player fica na tela preta (ou não anda) em vários celulares.
function pedacoPedido(req, tamanho) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let inicio, fim;
  if (!m[1]) {                                   // bytes=-500 → os últimos 500
    const n = Number(m[2]);
    if (!n) return null;
    inicio = Math.max(0, tamanho - n);
    fim = tamanho - 1;
  } else {
    inicio = Number(m[1]);
    fim = m[2] ? Number(m[2]) : tamanho - 1;
  }
  if (!isFinite(inicio) || !isFinite(fim) || inicio > fim || inicio >= tamanho) return null;
  return { inicio: inicio, fim: Math.min(fim, tamanho - 1) };
}

function enviarArquivo(req, res, arquivo, cache) {
  fs.stat(arquivo, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('não encontrado'); return; }
    const tipo = TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream';
    const cabecalhos = {
      'Content-Type': tipo,
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
      'Accept-Ranges': 'bytes'
    };
    const pedaco = pedacoPedido(req, st.size);
    if (pedaco) {
      cabecalhos['Content-Range'] = 'bytes ' + pedaco.inicio + '-' + pedaco.fim + '/' + st.size;
      cabecalhos['Content-Length'] = pedaco.fim - pedaco.inicio + 1;
      res.writeHead(206, cabecalhos);
      fs.createReadStream(arquivo, { start: pedaco.inicio, end: pedaco.fim }).pipe(res);
      return;
    }
    cabecalhos['Content-Length'] = st.size;
    res.writeHead(200, cabecalhos);
    fs.createReadStream(arquivo).pipe(res);
  });
}

function arquivoDoSite(p) {
  if (p === '/' || p === '') return path.join(ROOT, 'index.html');
  if (p === '/home') return path.join(ROOT, 'home.html');
  if (p === '/app') return path.join(ROOT, 'app.html');
  const f = path.normalize(path.join(ROOT, p));
  if (f.indexOf(ROOT + path.sep) !== 0) return null;
  return f;
}

async function api(req, res, url) {
  const rota = url.pathname.replace(/\/+$/, '');
  const corpoJson = async function () {
    const b = await corpo(req, MAX_BODY);
    if (!b.length) return {};
    return JSON.parse(b.toString('utf8'));
  };

  try {
    if (rota === '/api/ping' && req.method === 'GET') return json(res, 200, { ok: true, contas: Object.keys(db.users).length, videos: Object.keys(db.videos).length });

    if (rota === '/api/signup' && req.method === 'POST') {
      const b = await corpoJson();
      const name = String(b.name || '').trim();
      const pass = String(b.pass || '');
      if (!name || pass.length < 4) return json(res, 400, { error: 'Preencha nome e senha (mínimo 4 letras).' });
      if (acharPorNome(name)) return json(res, 409, { error: 'Esse nome já existe. Use "Entrar".' });
      const u = salvarUsuario({
        name: name,
        username: name.toLowerCase().replace(/\s+/g, '_').replace(/[^\w]/g, '') || ('u' + Date.now().toString(36)),
        photo: b.photo || null,
        password: novaSenha(pass)
      });
      return json(res, 200, { token: novoToken(u.id), user: usuarioPublico(u) });
    }

    if (rota === '/api/login' && req.method === 'POST') {
      const b = await corpoJson();
      const u = acharPorNome(b.name);
      if (!u) return json(res, 404, { error: 'nao_existe', message: 'Não achei essa conta. Use "Criar conta".' });
      if (!confereSenha(b.pass, u.password)) return json(res, 401, { error: 'senha', message: 'Nome ou senha incorretos' });
      return json(res, 200, { token: novoToken(u.id), user: usuarioPublico(u) });
    }

    const quem = logado(req);
    if (!quem) return json(res, 401, { error: 'sem_sessao', message: 'Entre de novo para continuar.' });

    if (rota === '/api/sync' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      return json(res, 200, deltasDe(since));
    }

    if (rota === '/api/push' && req.method === 'POST') {
      const b = await corpoJson();
      // Quem está banido continua podendo conversar com o criador: é por essa
      // conversa que ela pede desculpas e é liberada. Só os recados para ele
      // passam; post, vídeo, chat público e conversa com outros seguem barrados.
      if (estaBanido(quem)) {
        const criador = acharCriador();
        const recados = (Array.isArray(b.privMsgs) ? b.privMsgs : []).filter(function (m) {
          if (!m || !criador) return false;
          const par = (m.fromId === quem.id && m.toId === criador.id) ||
            (m.fromId === criador.id && m.toId === quem.id);
          return par;
        });
        if (!recados.length) return json(res, 403, { error: 'banido', message: 'Conta banida.' });
        b.users = []; b.videos = []; b.pubMsgs = []; b.deleted = {}; b.temLive = false; b.privMsgs = recados;
      }
      return json(res, 200, aplicarPush(b, quem));
    }

    if (rota === '/api/upload' && req.method === 'POST') {
      if (estaBanido(quem)) return json(res, 403, { error: 'banido' });
      let ext = String(url.searchParams.get('ext') || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (EXT_OK.indexOf(ext) < 0) ext = 'bin';
      const dados = await corpo(req, MAX_UPLOAD);
      if (!dados.length) return json(res, 400, { error: 'arquivo vazio' });
      const nome = 'up' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, nome), dados);
      return json(res, 200, { url: '/uploads/' + nome });
    }

    return json(res, 404, { error: 'rota desconhecida' });
  } catch (e) {
    return json(res, 400, { error: 'pedido inválido', message: e.message });
  }
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p.indexOf('/api/') === 0) return api(req, res, url);

  if (p.indexOf('/uploads/') === 0) {
    const nome = path.basename(p);
    return enviarArquivo(req, res, path.join(UPLOAD_DIR, nome), true);
  }

  const arquivo = arquivoDoSite(p);
  if (!arquivo) { res.writeHead(404); res.end('não encontrado'); return; }
  return enviarArquivo(req, res, arquivo, /\.(mp4|webm|mov|png|jpg|jpeg|gif|webp)$/i.test(arquivo));
});

loadDb();
seedCriador();
seedSuporte();
server.listen(PORT, HOST, function () {
  console.log('Good Look no ar em http://' + HOST + ':' + PORT);
});
