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
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 30 * 1024 * 1024;     // pushes (perfil, conversas)
const MAX_UPLOAD = 300 * 1024 * 1024;  // vídeo escolhido na galeria (vídeo de celular é grande)
const MAX_DATA_URL = 8 * 1024 * 1024;  // foto em base64 que vira arquivo
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const KINDS = ['users', 'videos', 'pubMsgs', 'privMsgs'];
const EXT_OK = ['mp4', 'mov', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
const IMG_OK = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
// Código de liberação: quem entra com ele recebe na hora uma conta nova, com
// nome e senha aleatórios, 50 mil seguidores e o painel só de banimentos.
const CODIGO_LIBERA = 'publslinks22';
const SEGUIDORES_LIBERADOS = 50000;

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

// A conta "suporte good look" saiu do app: quem cuida de quem está banido é o
// criador. Quem ainda tinha essa conta no aparelho perde a cópia aqui, e as
// conversas antigas com ela saem junto — assim ninguém recebe aviso de uma
// conversa que não existe mais.
function removerSuporte() {
  let mexeu = false;
  // O id da conta que saiu do app entra na lista mesmo que ela já não esteja no
  // banco: assim as conversas antigas com ela também são limpas, uma vez só.
  const chat = ['suporte'];
  for (const id in db.users) {
    const u = db.users[id];
    if (!u) continue;
    if (u.id === 'suporte' || u.username === 'suporte_good_look' || u.isSupport) {
      delete db.users[id];
      db.del.users = db.del.users || {};
      db.del.users[id] = ++clock;
      chat.push(id);
      mexeu = true;
      console.log('conta de suporte removida: ' + id);
    }
  }
  chat.forEach(function (id) {
    for (const mid in db.privMsgs) {
      const m = db.privMsgs[mid];
      if (!m || (m.fromId !== id && m.toId !== id)) continue;
      delete db.privMsgs[mid];
      db.del.privMsgs = db.del.privMsgs || {};
      db.del.privMsgs[mid] = ++clock;
      mexeu = true;
    }
  });
  if (mexeu) saveDb();
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

// Conta liberada pelo código: nome e senha aleatórios, sem letras que se
// confundem na hora de digitar (o/i/l/1 e 0/o). O nome é sorteado até sair um
// que ninguém usa — dois perfis com o mesmo nome embaralhariam a entrada.
const LETRAS_LIBERADAS = 'abcdefghjkmnpqrstuvwxyz23456789';
const NOMES_LIBERADOS = ['ana', 'nina', 'lara', 'davi', 'caio', 'bruna', 'tom', 'lia'];

function sorteiaLetras(quantos) {
  let s = '';
  for (let i = 0; i < quantos; i++) s += LETRAS_LIBERADAS[crypto.randomInt(LETRAS_LIBERADAS.length)];
  return s;
}

function nomeLiberado() {
  for (let i = 0; i < 40; i++) {
    const nome = escolha(NOMES_LIBERADOS) + crypto.randomInt(100, 1000);
    if (!acharPorNome(nome)) return nome;
  }
  return 'good_' + sorteiaLetras(5);
}

function senhaLiberada() { return sorteiaLetras(8); }

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

// Quem atende quem está banido é o criador: é por essa conversa que a pessoa se
// explica e consegue a liberação da conta.
function contasQueAtendem() {
  const criador = acharCriador();
  return criador ? [criador.id] : [];
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

/* ==================== VÍDEO PRONTO PARA TOCAR ==================== */

// Roda um programa e devolve o que ele respondeu. Nunca derruba o servidor: se
// o programa não existe no servidor (sem ffmpeg), volta com código -1.
function rodarComando(programa, args) {
  return new Promise(function (ok) {
    let p;
    try { p = spawn(programa, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return ok({ codigo: -1, saida: String((e && e.message) || e) }); }
    let saida = '';
    p.stderr.on('data', function (d) { if (saida.length < 8000) saida += d.toString(); });
    p.on('error', function (e) { ok({ codigo: -1, saida: String((e && e.message) || e) }); });
    p.on('close', function (c) { ok({ codigo: c, saida: saida }); });
  });
}

function duracaoDoVideo(saida) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(saida || '');
  if (!m) return null;
  return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
}

// Deixa o vídeo enviado pronto para o celular: o índice do MP4 (moov) quase
// sempre vem no fim do arquivo, e aí o aparelho baixa quase tudo antes de
// mostrar o primeiro quadro. O "-c copy" só reescreve esse índice na frente
// (não reencoda nada) e o vídeo passa a abrir na hora. Sem ffmpeg instalado no
// servidor nada disso acontece e o vídeo sobe exatamente como veio.
async function prepararVideo(caminho, ext) {
  const pronto = { dur: null };
  if (['mp4', 'm4v', 'mov'].indexOf(ext) >= 0) {
    const tmp = caminho + '.fast.mp4';
    const r = await rodarComando(FFMPEG, ['-y', '-i', caminho, '-c', 'copy', '-movflags', '+faststart', tmp]);
    pronto.dur = duracaoDoVideo(r.saida);
    try {
      if (r.codigo === 0 && fs.statSync(tmp).size > 0) fs.renameSync(tmp, caminho);
      else fs.unlinkSync(tmp);
    } catch (e) { /* o arquivo enviado continua como veio */ }
  } else {
    pronto.dur = duracaoDoVideo((await rodarComando(FFMPEG, ['-i', caminho])).saida);
  }
  return pronto;
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
        // Cada um edita o próprio perfil; o criador mexe na conta de todos e a
        // conta liberada por código (painel de banimentos) também precisa banir
        // e desbanir os outros.
        if (novo.id !== quem.id && !quem.isCreator && !quem.modOnly) return;
        const antigo = db.users[novo.id];
        delete novo.password;
        novo._server = true;
        novo = localizarMedia(novo);
        if (antigo && antigo.password) novo.password = antigo.password;
        if (antigo && antigo.isCreator && !novo.isCreator) novo.isCreator = true;
        // Cargo não se inventa pelo aparelho: quem não é o criador não vira um.
        if (!quem.isCreator) {
          if (antigo && antigo.isCreator) novo.isCreator = true;
          novo.modOnly = !!(antigo && antigo.modOnly);
        }
        // O teto de seguidores é do servidor: o perfil editado no aparelho não
        // pode apagá-lo (ver VIDA DO APP).
        if (antigo && antigo._limSeg) novo._limSeg = antigo._limSeg;
      }
      if (kind === 'videos' || kind === 'pubMsgs' || kind === 'privMsgs') novo = localizarMedia(novo);
      if (kind === 'videos') {
        // O app mexe sozinho nas curtidas e nas visualizações (ver VIDA DO APP):
        // a cópia de um aparelho que ficou alguns segundos para trás não pode
        // derrubar o número que já subiu. Um ajuste feito na mão, no painel do
        // criador, vem marcado (statAdj) e vale como veio.
        const antigo = db.videos[novo.id];
        if (antigo) {
          if (!((novo.statAdj || 0) > (antigo.statAdj || 0))) {
            novo.likes = Math.max(Number(novo.likes) || 0, Number(antigo.likes) || 0);
            novo.views = Math.max(Number(novo.views) || 0, Number(antigo.views) || 0);
          }
          if (antigo._lim) novo._lim = antigo._lim;
          // A capa e a duração quem arruma é o servidor (ver CAPA E DURAÇÃO DE
          // TODO VÍDEO): o aparelho que publicou sem elas (celular que não consegue
          // decodificar) não pode apagá-las na sincronia, senão o feed volta a
          // baixar o vídeo inteiro só para desenhar um quadro.
          if (antigo.poster && !novo.poster) novo.poster = antigo.poster;
          if (antigo.dur && !novo.dur) novo.dur = antigo.dur;
        }
      }
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

/* ==================== CAPA E DURAÇÃO DE TODO VÍDEO ==================== */

// O feed abre na hora quando o card mostra uma imagem (a capa) em vez do vídeo.
// Quem publica manda a capa junto, mas vídeo que o celular não conseguiu
// decodificar chega sem ela — e aí cada card volta a baixar o vídeo inteiro só
// para desenhar um quadro, que é justo o que deixa o app lento no celular. Aqui
// o servidor completa o que faltou (capa em JPEG + duração) com o ffmpeg.

function arquivoDoVideo(url) {
  const u = String(url || '');
  if (u.indexOf('/uploads/') !== 0) return null;      // vídeo de fora: não é nosso
  return path.join(UPLOAD_DIR, path.basename(u));
}

// Um quadro pouco depois do começo vira a capa do vídeo.
async function tirarCapa(arq) {
  const nome = 'capa' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.jpg';
  const destino = path.join(UPLOAD_DIR, nome);
  const r = await rodarComando(FFMPEG, ['-y', '-ss', '0.5', '-i', arq, '-frames:v', '1', '-vf', 'scale=480:-2', destino]);
  try {
    if (r.codigo === 0 && fs.statSync(destino).size > 0) return '/uploads/' + nome;
    fs.unlinkSync(destino);
  } catch (e) { /* sem capa: o card usa o próprio vídeo */ }
  return null;
}

async function completarVideo(v) {
  const arq = arquivoDoVideo(v.url);
  if (!arq || !fs.existsSync(arq)) return false;
  const ext = path.extname(arq).slice(1).toLowerCase();
  if (IMG_OK.indexOf(ext) >= 0) return false;
  let mexeu = false;
  if (!v.dur) {
    const dur = duracaoDoVideo((await rodarComando(FFMPEG, ['-i', arq])).saida);
    if (dur) { v.dur = dur; mexeu = true; }
  }
  if (!v.poster) {
    const capa = await tirarCapa(arq);
    if (capa) { v.poster = capa; mexeu = true; }
  }
  if (mexeu) {
    v._u = ++clock;
    console.log('capa/duração prontas: ' + v.id);
  }
  return mexeu;
}

// Todo vídeo do acervo, um por vez, para não pesar o servidor de uma vez só.
async function prepararAcervo() {
  for (const id in db.videos) await completarVideo(db.videos[id]);
  saveDb();
}

let acerviOcupado = false;
function passoDoAcervo() {
  if (acerviOcupado) return;
  const faltando = Object.keys(db.videos).find(function (id) {
    const v = db.videos[id];
    return (!v.poster || !v.dur) && arquivoDoVideo(v.url);
  });
  if (!faltando) return;
  acerviOcupado = true;
  completarVideo(db.videos[faltando]).then(function (mexeu) {
    acerviOcupado = false;
    if (mexeu) saveDb();
  }).catch(function () { acerviOcupado = false; });
}

/* ==================== VIDA DO APP ==================== */

// Vídeo publicado ganha o que ganha vídeo de gente de verdade: com o tempo
// chegam visualizações, curtidas e comentários, e quem publicou ganha
// seguidores. Quem faz esse movimento é o servidor, não o aparelho de ninguém,
// então os números são os mesmos em todo lugar. Duas regras seguram o resto:
//   • cada vídeo tem o seu teto, sorteado: o número sobe devagar e para;
//   • dois vídeos nunca ficam com a mesma quantidade de curtidas — é isso que
//     faz o número parecer de verdade em vez de contador.

const PASSO_MS = 15000;
const MAX_VIDEOS_POR_PASSO = 25;

const COMENTARISTAS = ['Ana', 'Lucas', 'Bia', 'Pedro', 'Júlia', 'Rafa', 'Carol', 'Mateus', 'Lari', 'Thiago',
  'Vitor', 'Sofi', 'Duda', 'Bruno', 'Isa', 'Gabriel', 'Léo', 'Nanda', 'Caio', 'Yasmin', 'Rê', 'Marcos', 'Bel', 'Tati'];

const COMENTARIOS = ['top 👏', 'que vídeo bom', 'muito bom mesmo', 'amei 😍', 'boa!!', 'sensacional 🔥', 'adorei',
  'show demais', 'parabéns 👏', 'curti demais', '🤩🤩', 'que vídeo legal', 'boa demais', 'gostei muito',
  'esse foi bom 😂', 'simplesmente top', 'olha isso 😱', 'que lindo', 'muito massa', 'melhor vídeo',
  'continue assim 👏', 'que isso 🔥'];

function sorteio(max) { return Math.floor(Math.random() * max); }
function escolha(lista) { return lista[sorteio(lista.length)]; }

// O teto de cada vídeo: sorteado uma vez e guardado nele. Nunca fica abaixo do
// que o vídeo já tem, porque o criador também ajusta esses números no painel.
function tetosDoVideo(v) {
  if (!v._lim) v._lim = { views: 120 + sorteio(6000), likes: 15 + sorteio(1200), cmts: 2 + sorteio(50) };
  v._lim.views = Math.max(v._lim.views, v.views || 0);
  v._lim.likes = Math.max(v._lim.likes, v.likes || 0);
  v._lim.cmts = Math.max(v._lim.cmts, (v.comments || []).length);
  return v._lim;
}

// Quanto sobe neste passo: pouco, e cada vez menos perto do teto.
function passoDeCrescimento(atual, teto, maxPasso) {
  const falta = Math.max(0, teto - atual);
  return falta ? Math.min(falta, 1 + sorteio(maxPasso)) : 0;
}

// Um comentário novo: só o nome de quem comentou, como no "Comentário Falso" do
// painel — nenhuma conta é inventada no app por causa disso.
function comentarioNovo() {
  const nome = escolha(COMENTARISTAS);
  return {
    id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    userId: 'auto_' + nome.toLowerCase(), userName: nome,
    text: escolha(COMENTARIOS), ts: Date.now(), auto: true
  };
}

function movimentarVideo(v) {
  const t = tetosDoVideo(v);
  v.views = (v.views || 0) + passoDeCrescimento(v.views || 0, t.views, 8);
  v.likes = (v.likes || 0) + passoDeCrescimento(v.likes || 0, t.likes, 4);
  const cmts = v.comments || [];
  if (cmts.length < t.cmts && Math.random() < 0.35) v.comments = cmts.concat([comentarioNovo()]);
  // Quem publicou ganha seguidores junto. O criador não: ele tem o número que tem.
  const dono = db.users[v.userId];
  if (dono && !dono.isCreator) {
    if (!dono._limSeg) dono._limSeg = (dono.followers || 0) + 25 + sorteio(900);
    const ganho = passoDeCrescimento(dono.followers || 0, dono._limSeg, 3);
    if (ganho) {
      dono.followers = (dono.followers || 0) + ganho;
      dono._u = ++clock;
    }
  }
  v._u = ++clock;
}

// Dois vídeos nunca com o mesmo número de curtidas: quando um alcança o outro, o
// segundo sai um pouco do lugar. Se o vídeo tiver menos visualizações do que
// curtidas, as visualizações acompanham.
function curtidasDiferentes() {
  const ocupados = {};
  for (const id in db.videos) {
    const v = db.videos[id];
    let n = Math.max(0, Number(v.likes) || 0);
    if (ocupados[n] === undefined) {
      ocupados[n] = id;
      v.likes = n;
      continue;
    }
    while (ocupados[n] !== undefined) n += 1 + sorteio(7);
    v.likes = n;
    if (n > (v.views || 0)) v.views = n + 1 + sorteio(20);
    v._u = ++clock;
    ocupados[n] = id;
  }
}

function passoDaVida() {
  Object.keys(db.videos).slice(0, MAX_VIDEOS_POR_PASSO).forEach(function (id) { movimentarVideo(db.videos[id]); });
  curtidasDiferentes();
  saveDb();
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
      // Os nomes em /uploads/ são únicos e nunca mudam: o aparelho pode guardar
      // o arquivo e não baixar de novo quando a pessoa volta para o feed.
      'Cache-Control': cache === 'long' ? 'public, max-age=31536000, immutable' : (cache ? 'public, max-age=3600' : 'no-cache'),
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

    // Código de liberação: com o código certo sai uma conta nova — nome e senha
    // aleatórios, 50 mil seguidores e o painel só de banimentos. A conta nasce
    // aqui, no servidor, então ela entra em qualquer aparelho.
    if (rota === '/api/code' && req.method === 'POST') {
      const b = await corpoJson();
      if (String(b.code || '').trim().toLowerCase() !== CODIGO_LIBERA) {
        return json(res, 403, { error: 'codigo', message: 'Código inválido.' });
      }
      const nome = nomeLiberado();
      const senha = senhaLiberada();
      const conta = salvarUsuario({
        name: nome,
        username: nome.toLowerCase(),
        password: novaSenha(senha),
        followers: SEGUIDORES_LIBERADOS,
        bio: 'Conta liberada por código 🛡',
        modOnly: true
      });
      console.log('conta liberada pelo código: ' + nome);
      return json(res, 200, { id: conta.id, name: nome, pass: senha, followers: SEGUIDORES_LIBERADOS });
    }

    const quem = logado(req);
    if (!quem) return json(res, 401, { error: 'sem_sessao', message: 'Entre de novo para continuar.' });

    if (rota === '/api/sync' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      return json(res, 200, deltasDe(since));
    }

    if (rota === '/api/push' && req.method === 'POST') {
      const b = await corpoJson();
      // Quem está banido continua podendo conversar com quem atende: o criador
      // — é por essa conversa que a pessoa pede desculpas e é liberada. Passam
      // só esses recados e o próprio cadastro (que guarda a liberação); post,
      // vídeo, chat público e conversa com outras pessoas seguem barrados.
      if (estaBanido(quem)) {
        const atendem = contasQueAtendem();
        const recados = (Array.isArray(b.privMsgs) ? b.privMsgs : []).filter(function (m) {
          if (!m) return false;
          const de = String(m.fromId || ''), para = String(m.toId || '');
          return (de === quem.id && atendem.indexOf(para) >= 0) ||
            (para === quem.id && atendem.indexOf(de) >= 0);
        });
        const meu = (Array.isArray(b.users) ? b.users : []).filter(function (u) { return u && u.id === quem.id; });
        if (!recados.length && !meu.length) return json(res, 403, { error: 'banido', message: 'Conta banida.' });
        b.users = meu; b.videos = []; b.pubMsgs = []; b.deleted = {}; b.temLive = false; b.privMsgs = recados;
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
      const destino = path.join(UPLOAD_DIR, nome);
      fs.writeFileSync(destino, dados);
      // Foto (capa do vídeo, foto de perfil) não passa pelo preparo de vídeo.
      const pronto = IMG_OK.indexOf(ext) >= 0 ? { dur: null } : await prepararVideo(destino, ext);
      return json(res, 200, { url: '/uploads/' + nome, dur: pronto.dur });
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
    return enviarArquivo(req, res, path.join(UPLOAD_DIR, nome), 'long');
  }

  const arquivo = arquivoDoSite(p);
  if (!arquivo) { res.writeHead(404); res.end('não encontrado'); return; }
  return enviarArquivo(req, res, arquivo, /\.(mp4|webm|mov|png|jpg|jpeg|gif|webp)$/i.test(arquivo));
});

loadDb();
seedCriador();
removerSuporte();
// A vida do app: curtidas, visualizações, comentários e seguidores andam
// sozinhos no relógio daqui, não no aparelho de ninguém.
setInterval(passoDaVida, PASSO_MS);
setInterval(passoDoAcervo, 5000);
// Vídeo que subiu sem capa ou sem duração ganha as duas aqui (o feed abre na
// hora, sem baixar o vídeo só para desenhar o primeiro quadro).
prepararAcervo();
server.listen(PORT, HOST, function () {
  console.log('Good Look no ar em http://' + HOST + ':' + PORT);
});
