// hub-fundacoes (FASE 3) — routes/hub-auth.js
//
// POST /api/v1/auth/login, /refresh, /logout, /recuperar-senha, /redefinir-senha
// Ref: docs/specs/hub-fundacoes/contracts/auth.md, tasks.md FASE 3 (3.1/3.2/3.3),
// research.md Decisions 8/9/12/14.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (Decision 2).
// Reusa os PADRÕES já maduros do login legado (server.js:198-260: dummy-hash
// anti-enumeração, rate-limit) mas sem tocar o código legado — reimplementados
// aqui contra a tabela `Usuario` do hub.
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────────────

// grupo-unificado-filiais Task 4.1 gerou o dummy hash legado via
// bcrypt.hashSync('dummy-placeholder', 10) (server.js:79-80). Reproduzido aqui
// (arquivo novo, mesma técnica) para equalizar timing de bcrypt.compare quando
// o e-mail não existe (FR-015, contracts/auth.md §login).
const BCRYPT_DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias (Decision 9)

const BLOQUEIO_FALHAS_LIMITE = 5; // FR-017
const BLOQUEIO_JANELA_MS = 15 * 60 * 1000; // FR-017

// Task 3.3.2 / CHK010 — decisão de TTL do token de recuperação de senha
// (Decisão auditável registrada via state-decisions.sh, score 2: FR-021 exige
// apenas "tempo limitado" sem valor concreto; 1h é o padrão de mercado que
// equilibra usabilidade — tempo suficiente para o usuário checar o e-mail
// mock — e janela de exposição do token, alinhado à mesma ordem de grandeza
// do refresh token de sessão (7 dias) sem se aproximar dela).
const RECUPERACAO_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ────────────────────────────────────────────────────────────────────────────
// Helpers puros (mantidos exportados para reuso em testes unitários — mesmo
// padrão de "cópia local" já usado em tests/motorista-unit.test.js, mas aqui
// exportamos direto do módulo por serem puros e sem efeito colateral).
// ────────────────────────────────────────────────────────────────────────────

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function formatoEmailValido(email) {
  return EMAIL_REGEX.test(email);
}

/**
 * Guard de entrada do /login (correção pós-review PR #55, achado #6): valida
 * TIPO antes de qualquer bcrypt.compare. Um body como `{senha: 12345}` (senha
 * não-string) chegava ao bcrypt.compare e estourava 500 ("data and hash
 * arguments required"); aqui ele cai no 401 uniforme (anti-enumeração). Pura.
 * @param {*} emailBruto - valor cru de req.body.email
 * @param {*} senhaBruta - valor cru de req.body.senha
 * @returns {boolean}
 */
function entradaLoginValida(emailBruto, senhaBruta) {
  if (typeof emailBruto !== 'string' || typeof senhaBruta !== 'string') return false;
  if (senhaBruta.length === 0) return false;
  const email = normalizarEmail(emailBruto);
  return Boolean(email) && formatoEmailValido(email);
}

function hashToken(tokenBruto) {
  return crypto.createHash('sha256').update(tokenBruto).digest('hex');
}

// Decision 9 / owasp-security (ASVS L1, >=128 bits de entropia): 256 bits via
// crypto.randomBytes — NUNCA Math.random()/uuid v4 para segredo criptográfico.
function gerarTokenBruto() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Calcula o próximo estado de tentativas/bloqueio após uma falha de login
 * (FR-017). Pura — não acessa o banco.
 * @param {number} tentativasAtuais
 * @param {Date} agora
 * @returns {{tentativas_login: number, bloqueado_ate: string|null}}
 */
function calcularBloqueioAposFalha(tentativasAtuais, agora) {
  const tentativas = (tentativasAtuais || 0) + 1;
  if (tentativas >= BLOQUEIO_FALHAS_LIMITE) {
    return { tentativas_login: tentativas, bloqueado_ate: new Date(agora.getTime() + BLOQUEIO_JANELA_MS).toISOString() };
  }
  return { tentativas_login: tentativas, bloqueado_ate: null };
}

function contaEstaBloqueada(usuario, agora) {
  return Boolean(usuario.bloqueado_ate) && new Date(usuario.bloqueado_ate) > agora;
}

/**
 * Classifica o desfecho da conferência de credencial no /login, DEPOIS do
 * bcrypt.compare (correção pós-review PR #55, achado #4). Pura.
 *   'inativa'        -> conta desativada: resposta uniforme 401, MAS sem
 *                       contabilizar falha (não acumula bloqueio).
 *   'senha_incorreta'-> conta ativa + senha errada: contabiliza falha (FR-017).
 *   'sucesso'        -> conta ativa + senha correta.
 * @param {{ativo: boolean}} usuario
 * @param {boolean} senhaValida
 * @returns {'inativa'|'senha_incorreta'|'sucesso'}
 */
function classificarCredencial(usuario, senhaValida) {
  if (!usuario.ativo) return 'inativa';
  if (!senhaValida) return 'senha_incorreta';
  return 'sucesso';
}

/**
 * Classifica o estado de uma SessaoRefresh apresentada no /refresh (correção
 * pós-review PR #55, achado #5). Pura — não acessa o banco.
 *   'reuso'    -> já revogada (rotacionada) e reapresentada: possível roubo,
 *                 revoga TODA a família (defesa em profundidade, Decision 9).
 *   'expirada' -> ainda não revogada, mas `expira_em` no passado: expiração
 *                 natural benigna de UM device, NÃO derruba os outros.
 *   'valida'   -> ativa e dentro da validade: segue a rotação normal.
 * @param {{revogado_em: string|null, expira_em: string}} sessao
 * @param {Date} agora
 * @returns {'reuso'|'expirada'|'valida'}
 */
function classificarSessaoRefresh(sessao, agora) {
  if (sessao.revogado_em) return 'reuso';
  if (new Date(sessao.expira_em) < agora) return 'expirada';
  return 'valida';
}

// ────────────────────────────────────────────────────────────────────────────
// Rate limiting (Decision 8 — trust proxy é setado em server.js:55, herdado
// por este router porque é montado na MESMA instância `app`; chave composta
// IP + conta normalizada, NUNCA apenas IP)
// ────────────────────────────────────────────────────────────────────────────

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // FR-016 não quantifica (CHK011) — mesma ordem de grandeza do legado server.js:83-92
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${normalizarEmail(req.body && req.body.email)}`,
  handler: (_req, res) => {
    res.status(429).json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' });
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Cookies
// ────────────────────────────────────────────────────────────────────────────

function cookiesSaoSeguras() {
  // secure=true em qualquer ambiente com TLS (hub-test/hub-homolog atrás do
  // Traefik próprio do hub); hub-dev local pode não ter TLS.
  return process.env.APP_ENV !== 'dev';
}

function setAuthCookies(res, accessToken, refreshTokenBruto) {
  const secure = cookiesSaoSeguras();
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
  res.cookie('refreshToken', refreshTokenBruto, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

function clearAuthCookies(res) {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
}

function gerarAccessToken(usuario) {
  // Decision 12: alg-pinning também na assinatura (não deixa a lib inferir).
  return jwt.sign({ sub: usuario.id, email: usuario.email }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

function decodificarUsuarioIdDoAccessToken(accessToken) {
  const payload = decodificarAccessToken(accessToken);
  return payload && payload.sub ? payload.sub : null;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /login (task 3.1)
// ────────────────────────────────────────────────────────────────────────────

router.post('/login', authRateLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const emailBruto = req.body && req.body.email;
    const senha = req.body && req.body.senha;
    const email = typeof emailBruto === 'string' ? normalizarEmail(emailBruto) : '';

    // Resposta uniforme para QUALQUER caminho de credencial inválida
    // (contracts/auth.md: 401 CREDENCIAIS_INVALIDAS, FR-015), INCLUSIVE tipos
    // inesperados (senha/email não-string — correção pós-review PR #55 #6:
    // antes estouravam 500 no bcrypt.compare).
    if (!entradaLoginValida(emailBruto, senha)) {
      // Sem conta candidata: ainda assim equaliza timing (não vaza motivo).
      await bcrypt.compare(typeof senha === 'string' ? senha : '', BCRYPT_DUMMY_HASH);
      await registrarAuditoria({
        acao: 'login_falha',
        recurso: 'Usuario',
        detalhes: { motivo: 'entrada_invalida', email: email || null },
        ip,
      });
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }

    const usuarios = await hubPostgrestRequest(
      `Usuario?email=eq.${encodeURIComponent(email)}&select=id,email,nome,senha_hash,ativo,tentativas_login,bloqueado_ate`
    );

    if (!usuarios || usuarios.length === 0) {
      // FR-015: e-mail inexistente — dummy-hash equaliza timing (mesmo padrão server.js:216-219)
      await bcrypt.compare(senha, BCRYPT_DUMMY_HASH);
      await registrarAuditoria({
        acao: 'login_falha',
        recurso: 'Usuario',
        detalhes: { motivo: 'email_nao_encontrado', email },
        ip,
      });
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }

    const usuario = usuarios[0];
    const agora = new Date();

    // FR-017: conta bloqueada — 423, sem revelar se a senha estaria certa.
    if (contaEstaBloqueada(usuario, agora)) {
      await registrarAuditoria({
        usuarioId: usuario.id,
        acao: 'login_falha',
        recurso: 'Usuario',
        recursoId: usuario.id,
        detalhes: { motivo: 'conta_bloqueada' },
        ip,
      });
      return res.status(423).json({ erro: 'Conta temporariamente bloqueada por excesso de tentativas. Tente novamente mais tarde.' });
    }

    // bcrypt.compare SEMPRE contra um hash real (nunca undefined — evita o
    // crash "data and hash arguments required", mesmo padrão server.js:224-228)
    // Rodado SEMPRE (mesmo para conta inativa) para equalizar timing.
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash || BCRYPT_DUMMY_HASH);

    const desfecho = classificarCredencial(usuario, senhaValida);

    // Correção pós-review PR #55 (achado #4): conta INATIVA não deve acumular
    // bloqueio (senão uma conta desativada com senha correta "auto-bloqueia" a
    // cada tentativa). Ramo separado do de senha incorreta: NÃO incrementa
    // tentativas_login/bloqueado_ate, mas mantém a resposta uniforme
    // (mesmo corpo do 401 de credencial inválida — anti-enumeração, FR-015).
    if (desfecho === 'inativa') {
      await registrarAuditoria({
        usuarioId: usuario.id,
        acao: 'login_falha',
        recurso: 'Usuario',
        recursoId: usuario.id,
        detalhes: { motivo: 'conta_inativa' },
        ip,
      });
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }

    if (desfecho === 'senha_incorreta') {
      const { tentativas_login, bloqueado_ate } = calcularBloqueioAposFalha(usuario.tentativas_login, agora);
      await hubPostgrestRequest(`Usuario?id=eq.${usuario.id}`, 'PATCH', {
        tentativas_login,
        bloqueado_ate,
        atualizado_em: agora.toISOString(),
      });
      await registrarAuditoria({
        usuarioId: usuario.id,
        acao: 'login_falha',
        recurso: 'Usuario',
        recursoId: usuario.id,
        detalhes: { motivo: 'senha_incorreta', tentativas_login },
        ip,
      });
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }

    // Sucesso: reset de tentativas + emissão de sessão.
    await hubPostgrestRequest(`Usuario?id=eq.${usuario.id}`, 'PATCH', {
      tentativas_login: 0,
      bloqueado_ate: null,
      atualizado_em: agora.toISOString(),
    });

    const accessToken = gerarAccessToken(usuario);
    const refreshTokenBruto = gerarTokenBruto();
    await hubPostgrestRequest('SessaoRefresh', 'POST', {
      usuario_id: usuario.id,
      token_hash: hashToken(refreshTokenBruto),
      expira_em: new Date(agora.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      user_agent: req.headers['user-agent'] || null,
      ip,
    });

    setAuthCookies(res, accessToken, refreshTokenBruto);

    await registrarAuditoria({
      usuarioId: usuario.id,
      acao: 'login_sucesso',
      recurso: 'Usuario',
      recursoId: usuario.id,
      ip,
    });

    return res.status(200).json({ usuario: { id: usuario.id, email: usuario.email, nome: usuario.nome } });
  } catch (e) {
    console.error('[hub-auth] erro em /login:', e.message);
    return res.status(500).json({ erro: 'Erro no servidor.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /refresh (task 3.2)
// ────────────────────────────────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  const ip = req.ip;
  try {
    const refreshTokenBruto = req.cookies && req.cookies.refreshToken;
    if (!refreshTokenBruto) {
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }

    const tokenHash = hashToken(refreshTokenBruto);
    const sessoes = await hubPostgrestRequest(
      `SessaoRefresh?token_hash=eq.${tokenHash}&select=id,usuario_id,expira_em,revogado_em`
    );

    if (!sessoes || sessoes.length === 0) {
      clearAuthCookies(res);
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }

    const sessao = sessoes[0];
    const agora = new Date();

    // Correção pós-review PR #55 (achado #5): distinguir REUSO/replay de
    // EXPIRAÇÃO NATURAL.
    //   - Reuso (sessão com `revogado_em` preenchido): token já rotacionado
    //     sendo reapresentado -> possível roubo. Decision 9: revoga TODA a
    //     família de sessões ativas do usuário (defesa em profundidade).
    //   - Expiração natural (sessão ainda NÃO revogada, apenas `expira_em`
    //     no passado): evento benigno de um único device -> responde 401 e
    //     limpa só os cookies desta requisição, SEM derrubar as sessões
    //     ativas de outros devices do mesmo usuário.
    const estadoSessao = classificarSessaoRefresh(sessao, agora);
    if (estadoSessao === 'reuso') {
      await hubPostgrestRequest(`SessaoRefresh?usuario_id=eq.${sessao.usuario_id}&revogado_em=is.null`, 'PATCH', {
        revogado_em: agora.toISOString(),
      });
      clearAuthCookies(res);
      await registrarAuditoria({
        usuarioId: sessao.usuario_id,
        acao: 'login_falha',
        recurso: 'SessaoRefresh',
        recursoId: sessao.id,
        detalhes: { motivo: 'replay_refresh_token' },
        ip,
      });
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }

    if (estadoSessao === 'expirada') {
      // Expiração benigna: NÃO revoga a família. Marca só esta sessão como
      // encerrada (idempotente) para higiene, limpa cookies e devolve 401.
      await hubPostgrestRequest(`SessaoRefresh?id=eq.${sessao.id}&revogado_em=is.null`, 'PATCH', {
        revogado_em: agora.toISOString(),
      });
      clearAuthCookies(res);
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }

    const usuarios = await hubPostgrestRequest(`Usuario?id=eq.${sessao.usuario_id}&select=id,email,nome,ativo`);
    if (!usuarios || usuarios.length === 0 || !usuarios[0].ativo) {
      clearAuthCookies(res);
      return res.status(401).json({ erro: 'Sessão inválida.' });
    }
    const usuario = usuarios[0];

    // Rotação (Decision 9): revoga o hash antigo, emite um novo.
    await hubPostgrestRequest(`SessaoRefresh?id=eq.${sessao.id}`, 'PATCH', { revogado_em: agora.toISOString() });

    const novoRefreshBruto = gerarTokenBruto();
    await hubPostgrestRequest('SessaoRefresh', 'POST', {
      usuario_id: usuario.id,
      token_hash: hashToken(novoRefreshBruto),
      expira_em: new Date(agora.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      user_agent: req.headers['user-agent'] || null,
      ip,
    });

    const novoAccessToken = gerarAccessToken(usuario);
    setAuthCookies(res, novoAccessToken, novoRefreshBruto);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[hub-auth] erro em /refresh:', e.message);
    return res.status(500).json({ erro: 'Erro no servidor.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /logout (task 3.2)
// ────────────────────────────────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  const ip = req.ip;
  // Logout é resiliente por design: mesmo se a revogação no banco falhar, os
  // cookies do cliente SEMPRE são limpos (FR-018 — o cliente nunca fica "preso"
  // logado por causa de uma falha de infraestrutura).
  try {
    const refreshTokenBruto = req.cookies && req.cookies.refreshToken;
    const accessToken = req.cookies && req.cookies.accessToken;
    const usuarioId = decodificarUsuarioIdDoAccessToken(accessToken);

    if (refreshTokenBruto) {
      const tokenHash = hashToken(refreshTokenBruto);
      await hubPostgrestRequest(`SessaoRefresh?token_hash=eq.${tokenHash}&revogado_em=is.null`, 'PATCH', {
        revogado_em: new Date().toISOString(),
      });
    }

    await registrarAuditoria({ usuarioId, acao: 'logout', recurso: 'SessaoRefresh', ip });
  } catch (e) {
    console.error('[hub-auth] erro em /logout (cookies limpos mesmo assim):', e.message);
  } finally {
    clearAuthCookies(res);
  }
  return res.status(200).json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /recuperar-senha (task 3.3)
// ────────────────────────────────────────────────────────────────────────────

router.post('/recuperar-senha', authRateLimiter, async (req, res) => {
  // FR-020/SC-005: resposta SEMPRE idêntica, qualquer que seja o motivo.
  const RESPOSTA_PADRAO = { ok: true, mensagem: 'Se o e-mail existir, um link de redefinição foi enviado.' };
  const ip = req.ip;

  try {
    const email = normalizarEmail(req.body && req.body.email);
    if (!email || !formatoEmailValido(email)) {
      return res.status(200).json(RESPOSTA_PADRAO);
    }

    const usuarios = await hubPostgrestRequest(`Usuario?email=eq.${encodeURIComponent(email)}&select=id,email,nome,ativo`);

    if (usuarios && usuarios.length > 0 && usuarios[0].ativo) {
      const usuario = usuarios[0];
      const tokenBruto = gerarTokenBruto();
      const expira = new Date(Date.now() + RECUPERACAO_TOKEN_TTL_MS);

      // Edge Case (data-model §token_recuperacao_hash): sobrescreve qualquer
      // pedido anterior pendente — só o mais recente é válido.
      await hubPostgrestRequest(`Usuario?id=eq.${usuario.id}`, 'PATCH', {
        token_recuperacao_hash: hashToken(tokenBruto),
        token_recuperacao_expira: expira.toISOString(),
      });

      // Decision 11: envio via mock — falha de e-mail NUNCA muda a resposta.
      try {
        const mailMockUrl = process.env.MAIL_MOCK_URL;
        if (mailMockUrl) {
          await fetch(`${mailMockUrl}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: usuario.email,
              subject: 'Recuperação de senha — Hub de Frota',
              text: `Use este token para redefinir sua senha: ${tokenBruto} (expira em ${expira.toISOString()})`,
            }),
          });
        }
      } catch (mailErr) {
        console.error('[hub-auth] falha ao enviar e-mail de recuperacao via mock (nao afeta resposta):', mailErr.message);
      }

      await registrarAuditoria({
        usuarioId: usuario.id,
        acao: 'recuperacao_senha_solicitada',
        recurso: 'Usuario',
        recursoId: usuario.id,
        ip,
      });
    }

    return res.status(200).json(RESPOSTA_PADRAO);
  } catch (e) {
    // Falha de infraestrutura NUNCA vaza como resposta distinta (FR-020/SC-005).
    console.error('[hub-auth] erro em /recuperar-senha (resposta padrao mantida):', e.message);
    return res.status(200).json(RESPOSTA_PADRAO);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /redefinir-senha (task 3.3)
// ────────────────────────────────────────────────────────────────────────────

router.post('/redefinir-senha', async (req, res) => {
  const ip = req.ip;
  try {
    const token = req.body && req.body.token;
    const novaSenha = req.body && req.body.nova_senha;

    if (!token || !novaSenha) {
      return res.status(400).json({ erro: 'Token e nova senha são obrigatórios.' });
    }
    if (String(novaSenha).length < 8) {
      return res.status(400).json({ erro: 'Senha muito curta: mínimo 8 caracteres.' });
    }

    const tokenHash = hashToken(token);
    const usuarios = await hubPostgrestRequest(
      `Usuario?token_recuperacao_hash=eq.${tokenHash}&select=id,email,token_recuperacao_expira`
    );

    if (!usuarios || usuarios.length === 0) {
      return res.status(400).json({ erro: 'Token inválido.' });
    }

    const usuario = usuarios[0];
    if (!usuario.token_recuperacao_expira || new Date(usuario.token_recuperacao_expira) < new Date()) {
      return res.status(410).json({ erro: 'Token expirado.' });
    }

    const novoHash = await bcrypt.hash(novaSenha, 10);
    const agora = new Date();

    // Single-use: token invalidado (NULL) neste PATCH — segundo uso do mesmo
    // token bruto não encontrará mais linha (token_recuperacao_hash=NULL).
    // Correção pós-review PR #55 (achado #3): redefinir a senha TAMBÉM
    // desbloqueia a conta (zera tentativas_login e bloqueado_ate, como o login
    // bem-sucedido já faz) — sem isso, uma conta bloqueada continuava 423
    // mesmo após o usuário provar posse do e-mail e trocar a senha.
    await hubPostgrestRequest(`Usuario?id=eq.${usuario.id}`, 'PATCH', {
      senha_hash: novoHash,
      token_recuperacao_hash: null,
      token_recuperacao_expira: null,
      tentativas_login: 0,
      bloqueado_ate: null,
      atualizado_em: agora.toISOString(),
    });

    // FR-022/SC-007: invalidar TODAS as sessões ativas da conta.
    await hubPostgrestRequest(`SessaoRefresh?usuario_id=eq.${usuario.id}&revogado_em=is.null`, 'PATCH', {
      revogado_em: agora.toISOString(),
    });

    await registrarAuditoria({
      usuarioId: usuario.id,
      acao: 'senha_redefinida',
      recurso: 'Usuario',
      recursoId: usuario.id,
      ip,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[hub-auth] erro em /redefinir-senha:', e.message);
    return res.status(500).json({ erro: 'Erro no servidor.' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários puros (tests/hub-auth-unit.test.js)
  normalizarEmail,
  formatoEmailValido,
  entradaLoginValida,
  hashToken,
  gerarTokenBruto,
  calcularBloqueioAposFalha,
  contaEstaBloqueada,
  classificarCredencial,
  classificarSessaoRefresh,
  BCRYPT_DUMMY_HASH,
  BLOQUEIO_FALHAS_LIMITE,
  RECUPERACAO_TOKEN_TTL_MS,
};
