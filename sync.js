/*
 * Good Look — sincronia entre aparelhos.
 *
 * O app continua funcionando com o que está guardado no aparelho; este arquivo
 * só mantém a mesma coleção no servidor. O que muda aqui sobe para o servidor e,
 * a cada poucos segundos, o que mudou lá desce para cá. Assim o vídeo, o short,
 * o perfil e a conversa aparecem para todo mundo, em qualquer celular.
 *
 * Sem servidor (site aberto direto, tipo GitHub Pages), nada disso roda e o app
 * segue funcionando sozinho no aparelho.
 */
var SYNC = (function () {
  var TOKEN = 'gl_token';
  var SINCE = 'gl_sync_since';
  var ATUAL = 'gl_current_user';
  var KINDS = { users: 'gl_users', videos: 'gl_videos', pubMsgs: 'gl_pubmsg', privMsgs: 'gl_privmsg' };

  var since = Number(localStorage.getItem(SINCE) || 0) || 0;
  var snap = {};
  var dirty = {};
  var timer = null, agenda = null, rodando = false, iniciado = false, renderPendente = false;

  function token() { return localStorage.getItem(TOKEN) || ''; }
  function logged() { return !!token(); }

  function api(rota, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token()) opts.headers.Authorization = 'Bearer ' + token();
    return fetch(rota, opts).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = null; }
        if (r.ok && j) return j;
        // Resposta que não é da API (site aberto sem servidor, tipo GitHub Pages):
        // não é erro de senha nem de conta, é só "sem servidor".
        if (j === null) throw new Error('sem servidor');
        if (r.status === 401 && token()) {
          localStorage.removeItem(TOKEN);
          if (window.showNotif) showNotif('Sua sessão caiu — entre de novo para sincronizar 📲');
        }
        var erro = new Error(j.message || j.error || ('erro ' + r.status));
        erro.status = r.status;
        erro.dados = j;
        throw erro;
      });
    });
  }

  function lista(kind) {
    try { return JSON.parse(localStorage.getItem(KINDS[kind]) || '[]') || []; } catch (e) { return []; }
  }
  function grava(kind, arr) { localStorage.setItem(KINDS[kind], JSON.stringify(arr)); }

  // O que pode ir para o servidor: sem senha, sem vídeo que só existe neste
  // aparelho (blob:) e sem conta antiga que o servidor não conhece.
  function limpar(kind, item) {
    if (!item || !item.id) return null;
    if (kind === 'videos' && typeof item.url === 'string' && item.url.indexOf('blob:') === 0) return null;
    var o = Object.assign({}, item);
    if (kind === 'users') {
      delete o.password;
      if (!o._server && o.id !== localStorage.getItem(ATUAL)) return null;
    }
    return o;
  }

  function marcarConhecido(kind) {
    snap[kind] = {};
    lista(kind).forEach(function (it) {
      var c = limpar(kind, it);
      if (c) snap[kind][it.id] = JSON.stringify(c);
    });
  }

  function digitando() {
    var a = document.activeElement;
    return !!a && /INPUT|TEXTAREA/.test(a.tagName || '');
  }

  function desenhar() {
    if (typeof window.render !== 'function') return;
    if (digitando()) { renderPendente = true; return; }
    window.render();
  }

  function pull() {
    if (!logged()) return Promise.resolve(false);
    return api('/api/sync?since=' + since).then(function (res) {
      var mexeu = false;
      Object.keys(KINDS).forEach(function (kind) {
        var porId = {}, mudouAqui = false;
        lista(kind).forEach(function (it) { if (it && it.id) porId[it.id] = it; });
        (Array.isArray(res[kind]) ? res[kind] : []).forEach(function (item) {
          if (!item || !item.id) return;
          if (JSON.stringify(porId[item.id]) !== JSON.stringify(item)) mudouAqui = true;
          porId[item.id] = item;
        });
        ((res.deleted || {})[kind] || []).forEach(function (id) {
          if (porId[id]) { delete porId[id]; mudouAqui = true; }
        });
        if (mudouAqui) { grava(kind, Object.keys(porId).map(function (k) { return porId[k]; })); mexeu = true; }
        if (!dirty[kind]) marcarConhecido(kind);
      });
      if (res.liveU && res.liveU > since) {
        var novo = res.live ? JSON.stringify(res.live) : null;
        if (localStorage.getItem('gl_live') !== novo) {
          if (novo) localStorage.setItem('gl_live', novo); else localStorage.removeItem('gl_live');
          mexeu = true;
        }
      }
      since = res.now || since;
      localStorage.setItem(SINCE, String(since));
      if (mexeu) desenhar();
      return mexeu;
    });
  }

  function push() {
    if (!logged()) return Promise.resolve(false);
    var body = { users: [], videos: [], pubMsgs: [], privMsgs: [], deleted: { users: [], videos: [], pubMsgs: [], privMsgs: [] }, temLive: false };
    var mandou = false;

    Object.keys(KINDS).forEach(function (kind) {
      if (!dirty[kind]) return;
      var conhecidos = snap[kind] || {}, vistos = {};
      lista(kind).forEach(function (it) {
        var c = limpar(kind, it);
        if (!c) return;
        vistos[c.id] = 1;
        if (conhecidos[c.id] !== JSON.stringify(c)) { body[kind].push(c); mandou = true; }
      });
      Object.keys(conhecidos).forEach(function (id) {
        if (!vistos[id]) { body.deleted[kind].push(id); mandou = true; }
      });
    });

    if (dirty.live) {
      body.temLive = true;
      try { body.live = JSON.parse(localStorage.getItem('gl_live') || 'null'); } catch (e) { body.live = null; }
      mandou = true;
    }

    dirty = {};
    if (!mandou) return Promise.resolve(false);

    return api('/api/push', { method: 'POST', body: JSON.stringify(body) }).then(function () {
      Object.keys(KINDS).forEach(function (kind) { if (!dirty[kind]) marcarConhecido(kind); });
      return true;
    });
  }

  function tick() {
    if (!logged() || rodando) return Promise.resolve();
    rodando = true;
    if (renderPendente && !digitando()) { renderPendente = false; desenhar(); }
    return pull().then(push).then(function (mandou) {
      return mandou ? pull() : null;
    }).then(function () {
      rodando = false;
    }).catch(function () {
      rodando = false;
    });
  }

  function save(kind) {
    if (!logged() || !iniciado) return;
    dirty[kind] = 1;
    if (agenda) clearTimeout(agenda);
    agenda = setTimeout(function () { agenda = null; tick(); }, 400);
  }

  function start() {
    if (iniciado || !logged()) return;
    iniciado = true;
    // Primeira rodada: tudo o que já existe neste aparelho vai para o servidor.
    Object.keys(KINDS).forEach(function (k) { dirty[k] = 1; });
    dirty.live = 1;
    tick();
    timer = setInterval(tick, 3000);
    window.addEventListener('online', tick);
  }

  function sair() {
    localStorage.removeItem(TOKEN);
    localStorage.removeItem(SINCE);
    since = 0;
    iniciado = false;
    if (timer) clearInterval(timer);
  }

  function upload(file, ext) {
    if (!logged() || !file) return Promise.reject(new Error('sem servidor'));
    return fetch('/api/upload?ext=' + encodeURIComponent(ext || 'mp4'), {
      method: 'POST',
      body: file,
      headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/octet-stream' }
    }).then(function (r) {
      if (!r.ok) throw new Error('upload ' + r.status);
      return r.json();
    });
  }

  function guardarSessao(j) {
    localStorage.setItem(TOKEN, j.token);
    var u = Object.assign({}, j.user);
    u._server = true;
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('gl_users') || '[]') || []; } catch (e) { arr = []; }
    var achei = -1;
    arr.forEach(function (x, i) { if (x && x.id === u.id) achei = i; });
    if (achei >= 0) arr[achei] = Object.assign({}, arr[achei], u); else arr.push(u);
    localStorage.setItem('gl_users', JSON.stringify(arr));
    localStorage.setItem(ATUAL, u.id);
    return u;
  }

  function entrar(name, pass) {
    return api('/api/login', { method: 'POST', body: JSON.stringify({ name: name, pass: pass }) });
  }
  function criar(name, pass, photo) {
    return api('/api/signup', { method: 'POST', body: JSON.stringify({ name: name, pass: pass, photo: photo || null }) });
  }
  function sairConta(userId) {
    return api('/api/users/' + encodeURIComponent(userId)).catch(function () { });
  }
  function ping() {
    return fetch('/api/ping', { method: 'GET' }).then(function (r) { if (!r.ok) throw new Error('sem servidor'); return r.json(); });
  }

  return {
    token: token, logged: logged, start: start, save: save, tick: tick, sair: sair,
    upload: upload, guardarSessao: guardarSessao, entrar: entrar, criar: criar, ping: ping
  };
})();
