/**
 * Rotas do App Motorista (PWA)
 * Prefixo: /motorista/*
 *
 * Feature: app-motorista-nfse
 * Ref: docs/specs/app-motorista-nfse/contracts/motorista-api.md
 *     docs/specs/app-motorista-nfse/spec.md (FR-001..FR-017)
 */

'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { DUMMY_HASH } = require('../lib/senha');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit'); // OWASP A06/A07: limita brute-force de login/cadastro
const multer = require('multer');
const axios = require('axios');
const xml2js = require('xml2js');
// O backend roda em Node 14 (Dockerfile FROM node:14), que NÃO tem FormData
// global (só Node 18+). Usa o pacote `form-data` (compatível e suportado pelo
// axios via getHeaders() para o boundary do multipart/form-data).
const FormData = require('form-data');
// base-motorista-grupo-movee: roteamento da FastAPI por GRUPO Movee (empresa 6 + filiais),
// não por id_empresa===6 estrito — alinha com a validação em massa (server.js). grupo.js é
// inicializado no boot (server.js), então o _postgrestRequest interno já está disponível.
const { mesmoGrupoQue } = require('./grupo');
// hub-motorista-canonico (FASE 5, tasks.md 5.4) — gate de ambiente NOVO,
// aditivo/inerte em produção (ver lib/hub-motorista-app-login.js). Só é
// EXERCITADO quando HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true (nunca definida em
// produção hoje) — o require em si não tem efeito colateral.
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { calcularCorte, CORTE_PADRAO } = require('../lib/notas-pendentes-corte');
const crypto = require('node:crypto');
const { enviarEmail } = require('../lib/resend-email');
const { planejarRecuperacao, montarEmailRecuperacao } = require('../lib/motorista-recuperacao-senha');
const { camposInvalidosDe } = require('../lib/motorista-validacao-campos');
const { hubMotoristaLoginHabilitado } = require('../lib/hub-motorista-app-login');
// hub-motorista-360 (FASE 3) — vínculo automático de credencial (FR-009),
// chamado dentro de POST /register em try/catch isolado (ver o handler).
const { vincularAutomaticamente } = require('../lib/hub-motorista-vinculo-automatico');

const router = express.Router();

// multer em memória (sem salvar em disco — arquivo XML pequeno)
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/xml' || file.mimetype === 'application/xml' ||
        file.originalname.toLowerCase().endsWith('.xml')) {
      cb(null, true);
    } else {
      cb(new Error('Somente arquivos XML são aceitos.'));
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// Rate limiters (OWASP A06/A07) — espelham o padrão já aceito do /login de empresa
// (server.js loginRateLimiter, MEDIUM-001). /login e /register são públicos e
// brute-forceáveis; sem limite, um atacante pode tentar reivindicar pré-cadastros
// (senha NULL) por força-bruta de CNPJ. keyGenerator por IP (mesma escolha do login).
// ──────────────────────────────────────────────────────────────────────────────
// fix login motorista 429 — o limiter original chaveava SÓ por req.ip. Atrás de
// Traefik+Next sem `trust proxy`, req.ip é o IP do proxy (igual p/ todos) → o teto de
// 10 virava um BALDE GLOBAL: depois de 10 logins agregados em 15 min, qualquer motorista
// recebia 429, que a UI mostra como "Erro ao conectar. Tente novamente.". Correção em
// duas camadas (compõem defesa em profundidade):
//   1) por (IP + CNPJ): cada CONTA tem seu próprio balde — um motorista nunca derruba
//      outro. Isola o sintoma mesmo que o req.ip ainda estivesse compartilhado.
//   2) por IP: teto agregado anti-abuso/enumeração, com folga p/ NAT compartilhado
//      (operadora/4G/roteador de pátio: vários motoristas saem pelo mesmo IP público).
// Depende de `app.set('trust proxy', …)` (server.js) p/ req.ip refletir o IP real.
const onlyDigitsLogin = (v) => String(v || '').replace(/\D/g, '');

const loginPerAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // máx. 10 tentativas por (IP, CNPJ)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${onlyDigitsLogin(req.body && req.body.cnpjPrestador)}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' });
  },
});

const loginPerIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 60,                   // teto agregado por IP (folga p/ NAT compartilhado de motoristas)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' });
  },
});

const registerRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,                   // headroom p/ onboarding em lote (drivers compartilham IP atrás de proxy)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Muitas tentativas de cadastro. Tente novamente em 15 minutos.' });
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers injetados pelo server.js na montagem (ver module.exports)
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;
let _generatePostgrestJWT;

/** Inicializa dependências injetadas pelo server.js */
function init({ postgrestRequest, generatePostgrestJWT }) {
  _postgrestRequest = postgrestRequest;
  _generatePostgrestJWT = generatePostgrestJWT;
}

// A EnvioMassa armazena cnpj_prestador em DOIS formatos (só-dígitos e com
// máscara XX.XXX.XXX/XXXX-XX). Buscar por eq.<só-dígitos> não casa os registros
// pontuados → 409 falso no cadastro e "sem movimento" no app. Este helper gera
// um filtro PostgREST in.(...) que casa ambos os formatos.
function cnpjEnvioMassaFilter(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  const valores = [d];
  if (d.length === 14) {
    valores.push(`${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`);
  }
  const lista = valores.map((v) => `"${v}"`).join(',');
  return `cnpj_prestador=in.(${encodeURIComponent(lista)})`;
}

// Movimento SEM nota a emitir nao e mostrado nem aceito para o motorista (decisao do
// operador 28/10, dec-056): ele recebe a gorjeta e nao ve pedido de nota de R$ 0,00 —
// que nao teria como emitir. O caso nasce da geracao do repasse (so-gorjeta por deducao
// do pago por fora, lib/adiantamento-geracao-movimento.js `soGorjetaPorDeducao`), mas o
// filtro tambem cobre valor 0 vindo da planilha (/upload aceita 0: rejeita so nao-numero,
// server.js:1958-1961). Mesmo limiar da geracao, que recusa `valor <= 0` (VALOR_ZERO).
// `EnvioMassa.valor` e double precision NULLABLE (MIG/0033:132): `gt.0` exclui 0, negativo
// e NULL — nenhum dos tres e nota emitivel.
// Vale para listagem E envio, pelo mesmo motivo do corte de notas pendentes: sem o filtro
// no envio, quem tem o id (ou o movimento que o `limit=1` resolve) ainda mandaria nota
// para a linha oculta, e a nota cairia num movimento diferente do que a tela mostra.
const VALOR_EMITIVEL = 'valor=gt.0';

// ──────────────────────────────────────────────────────────────────────────────
// Geração de tokens JWT (audiência: motorista)
// Separação de audiência: claim `aud: 'motorista'` impede que tokens de Empresa
// sejam aceitos em rotas de motorista e vice-versa (tarefa 2.1.3 / FR-015).
// ──────────────────────────────────────────────────────────────────────────────
function generateMotoristaAccessToken(payload) {
  return jwt.sign(
    { ...payload, aud: 'motorista' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function generateMotoristaRefreshToken(payload) {
  return jwt.sign(
    { ...payload, aud: 'motorista' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware: authenticateMotorista
// Ref: tarefa 2.1 / FR-001 / FR-002 / FR-015
// ──────────────────────────────────────────────────────────────────────────────
function authenticateMotorista(req, res, next) {
  const token = req.cookies.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'Acesso negado, token não encontrado.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Separação de audiência: rejeitar token de Empresa em rotas de motorista
    if (decoded.aud !== 'motorista') {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Garantir que o payload não carrega senha (defesa em profundidade)
    const { senha, password, pass, ...safeDecoded } = decoded;
    req.motorista = safeDecoded; // { cnpjPrestador, nome, aud, iat, exp }
    next();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: cookies httpOnly
// ──────────────────────────────────────────────────────────────────────────────
function setAuthCookies(res, accessToken, refreshToken) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Strict',
    maxAge: 15 * 60 * 1000, // 15 minutos
  });
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
  });
}

function clearAuthCookies(res) {
  // OWASP: especificar path para garantir limpeza correta do cookie
  res.clearCookie('accessToken', { path: '/' });
  res.clearCookie('refreshToken', { path: '/' });
}

// ──────────────────────────────────────────────────────────────────────────────
// hub-motorista-canonico (FASE 5, tasks.md 5.4) — login via ContaMotorista
// canônica do hub, só EXERCITADO quando HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true
// (lib/hub-motorista-app-login.js — inerte em produção sem a env var). NÃO
// reescreve o login legado (abaixo) — reproduz A MESMA sequência de
// checagens (conta não encontrada -> 401 genérico; senha NULL -> 401;
// bcrypt.compare falha -> 401), com UMA checagem adicional
// (`ativo === false` -> 403) ANTES de emitir qualquer token/cookie — critério
// de aceite central da task 5.4 (negar credencial desativada ANTES de
// qualquer efeito colateral/registro de atividade). Gera os tokens com as
// MESMAS funções já usadas pelo login legado
// (`generateMotoristaAccessToken`/`generateMotoristaRefreshToken`/
// `setAuthCookies`) — nenhuma lógica de JWT duplicada.
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// hub-motorista-canonico (FASE 6, tasks.md 6.2) — resolve o entregador_uuid
// vinculado a uma ContaMotorista (Entregador.motorista_id -> Entregador
// .id_externo), SÓ chamado dentro de loginViaContaMotorista — já atrás do
// gate HUB_MOTORISTA_LOGIN_CONTA_ATIVA (dec-046/tasks.md nota: reusa o gate
// existente, nenhum env novo — inerte em produção do mesmo jeito que o
// resto do fluxo ContaMotorista, FR-023/SC-007). `motorista_id` é
// GLOBALMENTE único (índice único parcial, migration 0021) — no máximo 1
// Entregador vinculado por conta. Best-effort: falha aqui NUNCA bloqueia o
// login (clarify Q4 — motorista sem cadastro no hub ainda consegue logar,
// só sem uuid no token).
// ──────────────────────────────────────────────────────────────────────────────
async function resolverEntregadorUuid(contaMotoristaId) {
  try {
    const entregadores = await hubPostgrestRequest(
      `Entregador?motorista_id=eq.${encodeURIComponent(contaMotoristaId)}&select=id_externo`
    );
    if (entregadores && entregadores[0] && entregadores[0].id_externo) {
      return entregadores[0].id_externo;
    }
  } catch (err) {
    console.error('[motorista/login] Falha ao resolver entregador_uuid (não bloqueia o login):', err.message);
  }
  return null;
}

// Payload do token de sessão do app com a chave ligada — usado pelo login E pelo refresh, para que nenhuma claim
// de estado de sessão se perca na renovação. `entregadorUuid` é recalculado do banco (o vínculo pode ter mudado);
// best-effort como no login: falha em resolver = sem a claim (clarify Q4), nunca bloqueia.
async function payloadContaMotorista(conta) {
  const payload = { cnpjPrestador: conta.cnpj_prestador, nome: conta.nome || '' };
  const entregadorUuid = await resolverEntregadorUuid(conta.id);
  if (entregadorUuid) {
    payload.entregadorUuid = entregadorUuid;
  }
  return payload;
}

async function loginViaContaMotorista(cnpjNorm, senha, res) {
  // Mesma mensagem anti-enumeração do login legado (FR-016) — não revela
  // qual campo falhou.
  const INVALID_MSG = 'Credenciais inválidas.';

  const contas = await hubPostgrestRequest(
    `ContaMotorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}`
  );

  const conta = contas && contas[0];

  // Sem conta, ou conta sem senha (credencial ainda não criada, ou em meio a um
  // reset — routes/hub-motoristas.js#POST /credencial/reset-senha zera a senha
  // imediatamente): compara contra o DUMMY_HASH para REDUZIR a
  // diferença de tempo em relação à de uma senha errada (anti-enumeração por tempo) e não crashar o
  // bcrypt.compare(_, null).
  if (!conta || !conta.senha) {
    await bcrypt.compare(typeof senha === 'string' ? senha : '', DUMMY_HASH);
    return res.status(401).json({ error: INVALID_MSG });
  }

  const senhaOk = await bcrypt.compare(senha, conta.senha);
  if (!senhaOk) {
    return res.status(401).json({ error: INVALID_MSG });
  }

  // Credencial desativada -> 403, ANTES de qualquer token/cookie/atividade
  // (task 5.4 — critério de aceite central). Mesma mensagem do login legado.
  if (conta.ativo === false) {
    return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
  }

  const payload = await payloadContaMotorista(conta);
  const accessToken = generateMotoristaAccessToken(payload);
  const refreshToken = generateMotoristaRefreshToken(payload);

  setAuthCookies(res, accessToken, refreshToken);

  return res.json({
    cnpjPrestador: conta.cnpj_prestador,
    nome: conta.nome || '',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/login  (público)
// Ref: tarefa 2.2.1 / contracts §login / spec FR-001 / quickstart 1, 2
// ──────────────────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
// "Esqueci minha senha" (2026-09-25)
//
// Até aqui não existia recuperação nenhuma: quem esquecia a senha dependia de
// alguém do hub acionar o reset e informar a nova por fora. O e-mail virou
// cadastro do hub na 0096, e é isso que torna o auto-atendimento possível.
//
// Reusa o MESMO mecanismo de token do reset do hub (`token_reset_hash` +
// `token_reset_expira`, 60 min, uso único) — nada de segredo novo.
// ════════════════════════════════════════════════════════════════════════

const TOKEN_RECUPERACAO_TTL_MS = 60 * 60 * 1000;

// Mais apertado que o login: cada pedido dispara um e-mail, então o abuso aqui
// custa reputação de domínio, não só CPU.
const recuperacaoPerIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

router.post('/recuperar-senha', recuperacaoPerIpLimiter, async (req, res) => {
  try {
    const { cnpjPrestador } = req.body || {};
    const cnpjNorm = String(cnpjPrestador || '').replace(/\D/g, '');
    if (cnpjNorm.length !== 14) {
      return res.status(400).json({ error: 'Informe o CNPJ do prestador.' });
    }

    let conta = null;
    try {
      const contas = await hubPostgrestRequest(
        `ContaMotorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}&select=id,nome,email,ativo`,
        'GET'
      );
      conta = Array.isArray(contas) ? contas[0] || null : null;
    } catch (e) {
      console.error('[motorista] recuperar-senha: falha ao buscar conta:', e.message);
      return res.status(502).json({ error: 'Serviço indisponível. Tente novamente.' });
    }

    const plano = planejarRecuperacao(conta);

    if (!plano.enviar) {
      // Resposta IGUAL à do sucesso quando não há e-mail, para não transformar
      // esta rota num detector de cadastro. O motivo fica só no log do
      // servidor — é ele que permite ao hub procurar a pessoa e cadastrar o
      // e-mail (242 das 1.456 contas estavam sem, em 2026-09-24).
      console.error('[motorista] recuperar-senha sem envio:', plano.motivo, 'cnpj=', cnpjNorm.slice(0, 5) + '…');
      return res.status(200).json({ ok: true, emailMascarado: null });
    }

    const tokenBruto = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBruto).digest('hex');
    const expira = new Date(Date.now() + TOKEN_RECUPERACAO_TTL_MS).toISOString();

    // ⚠️ O token é gravado ANTES do envio, mas a senha atual NÃO é invalidada:
    // se o e-mail não chegar, o motorista continua entrando com a senha que
    // tem. Zerar aqui repetiria o erro do reset do hub, que deixava a pessoa
    // trancada para fora quando o segundo passo não acontecia.
    try {
      await hubPostgrestRequest(
        `ContaMotorista?id=eq.${conta.id}`, 'PATCH',
        { token_reset_hash: tokenHash, token_reset_expira: expira },
        {}, { returnMinimal: true }
      );
    } catch (e) {
      console.error('[motorista] recuperar-senha: falha ao gravar token:', e.message);
      return res.status(502).json({ error: 'Serviço indisponível. Tente novamente.' });
    }

    const base = process.env.APP_MOTORISTA_URL || 'https://app.motorista.moveelog.com.br';
    const link = `${base}/definir-senha?token=${tokenBruto}`;
    // Corpo (texto + HTML com o botão) em lib/motorista-recuperacao-senha.js.
    const { assunto, texto, html } = montarEmailRecuperacao({ nome: conta.nome, link });
    const envio = await enviarEmail({ para: conta.email, assunto, texto, html });

    if (!envio.ok) {
      console.error('[motorista] recuperar-senha: e-mail não enviado:', envio.erro);
      return res.status(502).json({ error: 'Não foi possível enviar o e-mail agora. Tente novamente.' });
    }

    return res.status(200).json({ ok: true, emailMascarado: plano.emailMascarado });
  } catch (e) {
    console.error('[motorista] erro inesperado em POST /recuperar-senha:', e.message);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

router.post('/definir-senha', recuperacaoPerIpLimiter, async (req, res) => {
  try {
    const { token, novaSenha } = req.body || {};
    if (typeof token !== 'string' || token.length < 32) {
      return res.status(400).json({ error: 'Link inválido ou expirado.' });
    }
    if (typeof novaSenha !== 'string' || novaSenha.length < 8) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let conta = null;
    try {
      const contas = await hubPostgrestRequest(
        `ContaMotorista?token_reset_hash=eq.${encodeURIComponent(tokenHash)}&select=id,cnpj_prestador,token_reset_expira,ativo`,
        'GET'
      );
      conta = Array.isArray(contas) ? contas[0] || null : null;
    } catch (e) {
      console.error('[motorista] definir-senha: falha ao buscar token:', e.message);
      return res.status(502).json({ error: 'Serviço indisponível. Tente novamente.' });
    }

    // Mesma mensagem para token inexistente, expirado e conta inativa: não
    // revelar QUAL parte falhou (mesmo espírito anti-enumeração do login).
    if (!conta || conta.ativo === false) return res.status(400).json({ error: 'Link inválido ou expirado.' });
    if (!conta.token_reset_expira || new Date(conta.token_reset_expira).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Link inválido ou expirado.' });
    }

    const hash = await bcrypt.hash(novaSenha, 12);
    try {
      // Uso único: o token é zerado no MESMO update que grava a senha.
      await hubPostgrestRequest(
        `ContaMotorista?id=eq.${conta.id}`, 'PATCH',
        { senha: hash, token_reset_hash: null, token_reset_expira: null },
        {}, { returnMinimal: true }
      );
      // A senha chega à tabela `Motorista` (a que o login usa hoje) pelo gatilho da
      // migration 0123, na mesma transação — não há mais segundo PATCH aqui.
    } catch (e) {
      console.error('[motorista] definir-senha: falha ao gravar:', e.message);
      return res.status(502).json({ error: 'Não foi possível salvar a senha. Tente novamente.' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[motorista] erro inesperado em POST /definir-senha:', e.message);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

router.post('/login', loginPerIpLimiter, loginPerAccountLimiter, async (req, res) => {
  try {
    const { cnpjPrestador, senha } = req.body;

    if (!cnpjPrestador || !senha) {
      return res.status(400).json({ error: 'CNPJ do prestador e senha são obrigatórios.' });
    }

    // Normalizar CNPJ (remover pontuação)
    const cnpjNorm = String(cnpjPrestador).replace(/\D/g, '');

    // hub-motorista-canonico (FASE 5, tasks.md 5.4) — ADITIVO: só desvia para
    // o fluxo novo quando a env var está ligada (inerte em produção — ver
    // lib/hub-motorista-app-login.js). Nenhuma linha do fluxo legado abaixo é
    // alterada/removida.
    if (hubMotoristaLoginHabilitado()) {
      return await loginViaContaMotorista(cnpjNorm, senha, res);
    }

    // Buscar motorista no PostgREST
    const motoristas = await _postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}`
    );

    // Mensagem genérica — não revelar qual campo falhou (anti-enumeração FR-016)
    const INVALID_MSG = 'Credenciais inválidas.';

    const motorista = motoristas && motoristas[0];

    // Sem linha, ou pré-cadastro do upload (cadastro-motorista-base-validada: senha
    // NULL, o motorista ainda não definiu acesso): credencial inválida, com a mesma
    // mensagem anti-enumeração. Compara contra o DUMMY_HASH para reduzir (não igualar) a diferença de tempo de
    // uma senha errada e não crashar o bcrypt.compare(_, null).
    if (!motorista || !motorista.senha) {
      await bcrypt.compare(typeof senha === 'string' ? senha : '', DUMMY_HASH);
      return res.status(401).json({ error: INVALID_MSG });
    }

    // Verificar senha
    const senhaOk = await bcrypt.compare(senha, motorista.senha);
    if (!senhaOk) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    // Verificar conta ativa
    if (!motorista.ativo) {
      return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
    }

    const payload = { cnpjPrestador: motorista.cnpj_prestador, nome: motorista.nome || '' };
    const accessToken = generateMotoristaAccessToken(payload);
    const refreshToken = generateMotoristaRefreshToken(payload);

    setAuthCookies(res, accessToken, refreshToken);

    return res.json({
      cnpjPrestador: motorista.cnpj_prestador,
      nome: motorista.nome || '',
    });
  } catch (err) {
    console.error('[motorista/login] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/register  (público — ativação de cadastro com guard FR-017)
// Ref: tarefa 2.3 / contracts §register / spec FR-017 / quickstart 3
// Feature: cadastro-motorista-base-validada (frente B)
//   A base curada é a tabela "Motorista" (populada pelo upload do movimento como
//   pré-cadastro SEM senha), não mais a EnvioMassa. /register não CRIA a linha:
//   ele ATIVA o pré-cadastro definindo a senha (UPDATE), se o CNPJ estiver na base.
//   Mantém anti-enumeração (FR-017): mesma 409 para "fora da base" e "já tem conta".
// ──────────────────────────────────────────────────────────────────────────────
router.post('/register', registerRateLimiter, async (req, res) => {
  try {
    const { cnpjPrestador, nome, senha } = req.body;

    if (!cnpjPrestador || !senha || !nome) {
      return res.status(400).json({ error: 'CNPJ do prestador, nome e senha são obrigatórios.' });
    }

    if (senha.length < 8) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
    }

    const cnpjNorm = String(cnpjPrestador).replace(/\D/g, '');

    // Resposta anti-enumeração (FR-017): mesma mensagem para "CNPJ fora da base"
    // E para "já possui conta" — não revela presença/ausência na base curada.
    const NOT_ELIGIBLE_MSG = 'CNPJ não elegível para cadastro ou já possui conta.';

    // Gate: o CNPJ tem de existir na base curada "Motorista" (pré-cadastro do upload).
    const encontrados = await _postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}&select=id,senha,ativo`
    );
    const registro = encontrados && encontrados[0];

    // Não está na base curada → não elegível.
    if (!registro) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Já tem senha → conta já criada (anti-enum: mesma msg).
    if (registro.senha) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Pré-cadastro desativado pelo admin (CRUD) → não elegível (decisão §6.9).
    if (!registro.ativo) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Reset do hub em curso ou expirado (ContaMotorista.token_reset_hash preenchido): o reset zera
    // Motorista.senha de verdade (gatilho G2, 0123); sem esta recusa, quem soubesse o CNPJ definiria a
    // senha aqui. Mesma resposta anti-enumeração, nada escrito.
    // Sem POSTGREST_URL não há hub neste deployment (convenção do server.js) e logo não há reset; com hub
    // configurado, falha da consulta propaga (500) — fail-closed.
    const resets = process.env.POSTGREST_URL
      ? await hubPostgrestRequest(
        `ContaMotorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}&token_reset_hash=not.is.null&select=id&limit=1`
      )
      : [];
    if (resets && resets.length > 0) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Pré-cadastro válido (senha NULL, ativo): ATIVAR o acesso definindo a senha.
    // UPDATE (não INSERT): a linha já existe, vinda do upload do movimento.
    const senhaHash = await bcrypt.hash(senha, 10);
    await _postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}`,
      'PATCH',
      {
        senha: senhaHash,
        nome: String(nome).trim(),
        ativo: true,
      }
    );

    // hub-motorista-360 (FASE 3, tasks.md 3.1, contracts/vinculo-automatico.md,
    // FR-009..FR-011) — efeito colateral best-effort, EM TRY/CATCH ISOLADO:
    // uma falha aqui (rede, PostgREST do hub fora do ar, RLS, timeout) NUNCA
    // pode impedir o motorista de se cadastrar — a resposta 201 abaixo é
    // enviada de qualquer forma. Nunca é pré-requisito do cadastro.
    try {
      await vincularAutomaticamente({ cnpjPrestador: cnpjNorm, nome: String(nome).trim() });
    } catch (errVinculo) {
      console.error('[motorista/register] vínculo automático ao hub falhou (best-effort, não bloqueia o cadastro):', errVinculo.message);
    }

    return res.status(201).json({ message: 'Conta criada com sucesso. Faça login para continuar.' });
  } catch (err) {
    console.error('[motorista/register] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: GET /motorista/empresas-proprietarias  (público — usado na tela de login)
// Retorna os nomes das empresas do grupo PROPRIETÁRIO deste app/container,
// definido pela env GRUPO_PROPRIETARIO. Cada tenant tem seu container/app, então
// a identidade do proprietário é fixada por deploy (não depende de login).
// Sem env válida → lista vazia (a UI degrada para o texto padrão).
// ──────────────────────────────────────────────────────────────────────────────
router.get('/empresas-proprietarias', async (req, res) => {
  try {
    const grupoId = parseInt(process.env.GRUPO_PROPRIETARIO || '', 10);
    if (!Number.isInteger(grupoId) || grupoId <= 0) {
      return res.json({ grupo: null, empresas: [] });
    }
    const rows = await _postgrestRequest(
      `Empresa?id_grupo=eq.${grupoId}&select=nome_empresa&order=id.asc`
    );
    const empresas = (rows || [])
      .map((e) => (e && e.nome_empresa ? String(e.nome_empresa).trim() : ''))
      .filter(Boolean);
    return res.json({ grupo: grupoId, empresas });
  } catch (err) {
    console.error('[motorista/empresas-proprietarias] Erro:', err.message);
    return res.json({ grupo: null, empresas: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/token/refresh  (cookie refreshToken)
// Ref: tarefa 2.2.2 / contracts §refresh
// ──────────────────────────────────────────────────────────────────────────────
router.post('/token/refresh', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Token de atualização ausente.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Token de atualização inválido.' });
  }

  // Separação de audiência
  if (decoded.aud !== 'motorista') {
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  // Relê a conta no banco (mesma tabela que o /login usa conforme a chave): motorista desativado,
  // CNPJ trocado ou com reset em curso (senha nula) perde a sessão em vez de renovar por até 7 dias.
  let linhas;
  try {
    const q = `cnpj_prestador=eq.${encodeURIComponent(decoded.cnpjPrestador)}`;
    linhas = hubMotoristaLoginHabilitado()
      ? await hubPostgrestRequest(`ContaMotorista?${q}`)
      : await _postgrestRequest(`Motorista?${q}`);
  } catch (err) {
    // fail-closed sem deslogar: instabilidade do banco não pode derrubar a sessão
    return res.status(503).json({ error: 'Serviço indisponível. Tente novamente.' });
  }

  const conta = linhas && linhas[0];
  if (!conta || conta.ativo !== true || !conta.senha) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  // chave ligada: mesmo payload do login (inclui entregadorUuid); desligada: como o login legado (sem a claim)
  const novoPayload = hubMotoristaLoginHabilitado()
    ? await payloadContaMotorista(conta)
    : { cnpjPrestador: decoded.cnpjPrestador, nome: conta.nome || '' };
  const newAccessToken = generateMotoristaAccessToken(novoPayload);

  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('accessToken', newAccessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Strict',
    maxAge: 15 * 60 * 1000,
  });

  return res.json({ message: 'Token renovado.' });
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/logout  (NÃO exige access token válido — Q-N16, tasks.md 3.5.1)
// Ref: tarefa 2.2.3 / adiantamento-motorista 3.5
//
// Antes exigia `authenticateMotorista`, que devolve 401 se o accessToken
// estiver expirado/ausente — impedindo exatamente o caso mais comum de
// querer sair (sessão já vencida por inatividade). Este app não mantém um
// store server-side de refresh tokens (JWT stateless, sem tabela de sessão —
// diferente do hub, que tem família de refresh com teto de 24h): a única
// invalidação possível no servidor é limpar os cookies httpOnly via
// `Set-Cookie` na resposta, o que `clearAuthCookies` já faz — e passa a
// rodar SEMPRE, sem depender de o access token ainda ser válido.
// ──────────────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  clearAuthCookies(res);
  return res.json({ message: 'Logout bem-sucedido.' });
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: GET /motorista/verify-auth  (autenticado)
// Ref: tarefa 2.2.3 / contracts §verify-auth
// ──────────────────────────────────────────────────────────────────────────────
router.get('/verify-auth', authenticateMotorista, (req, res) => {
  return res.json({
    authenticated: true,
    nome: req.motorista.nome || '',
    cnpjPrestador: req.motorista.cnpjPrestador,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: GET /motorista/movimento-aberto  (autenticado)
// Ref: tarefa 3.1 / contracts §movimento-aberto / spec FR-003/FR-004
// ──────────────────────────────────────────────────────────────────────────────
router.get('/movimento-aberto', authenticateMotorista, async (req, res) => {
  try {
    const cnpj = req.motorista.cnpjPrestador;

    // Escopo sempre por token — nunca por parâmetro externo (Constituição II)
    const movimentos = await _postgrestRequest(
      `EnvioMassa?${cnpjEnvioMassaFilter(cnpj)}&${VALOR_EMITIVEL}&mov_fechado=eq.false&order=created_at.desc&limit=1`
    );

    if (!movimentos || movimentos.length === 0) {
      // Estado vazio: sem movimento aberto (FR-004)
      return res.json({ movimento: null });
    }

    const m = movimentos[0];

    // Dados do tomador (Empresa dona do movimento, via id_empresa) para auxiliar
    // o motorista na emissão da NFS-e: razão social, endereço e observações.
    // Tolerante a falha/colunas ausentes — nunca bloqueia o movimento.
    let tomador = null;
    try {
      if (m.id_empresa != null) {
        const empresas = await _postgrestRequest(
          `Empresa?id=eq.${encodeURIComponent(m.id_empresa)}&limit=1`
        );
        if (empresas && empresas.length > 0) {
          const e = empresas[0];
          tomador = {
            razaoSocial: e.nome_empresa || null,
            endereco: e.endereco || null,
            numero: e.numero || null,
            cep: e.cep || null,
            email: e.email_nota || null,
            observacao: e.observacao || null,
          };
        }
      }
    } catch (e) {
      console.error('[motorista/movimento-aberto] busca do tomador falhou:', e.message);
    }

    // Mapper snake_case → camelCase (tarefa 3.1.2)
    const movimento = {
      id: m.id,
      valor: m.valor,
      gorjeta: m.gorjeta ?? null,    // FR-004: null quando ausente/zero (CL-002)
      dtInicial: m.dt_inicial,
      dtFinal: m.dt_final,
      nome: m.nome,
      cnpjTomador: m.cnpj_tomador,
      cnpjPrestador: m.cnpj_prestador,
      tribnac: m.tribnac,
      notaOk: m.nota_ok,
      erroValidacao: m.erro_validacao,
      tomador,
    };

    return res.json({ movimento });
  } catch (err) {
    console.error('[motorista/movimento-aberto] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/validar-nota  (autenticado, multipart/form-data)
// Ref: tarefa 3.2 + 3.3 / contracts §validar-nota / spec FR-006..FR-012/FR-015
// OWASP: usar wrapper que captura erros de multer (fileSize/fileFilter) antes do handler
// para evitar que o express default error handler exponha stack trace.
// ──────────────────────────────────────────────────────────────────────────────
function uploadSingle(req, res, next) {
  uploadMemory.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Erro de upload do multer (ex: limite de tamanho excedido)
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Arquivo muito grande. Limite: 2 MB.' });
      }
      return res.status(400).json({ error: `Erro no upload: ${err.message}` });
    } else if (err) {
      // fileFilter rejeitou (tipo inválido)
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

router.post('/validar-nota', authenticateMotorista, uploadSingle, async (req, res) => {
  try {
    const cnpj = req.motorista.cnpjPrestador;

    // Pré-condição 1: arquivo presente
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo XML não enviado.' });
    }

    // Pré-condição 3: XML bem-formado (FR-011)
    // Segurança XXE: xml2js ^0.4.x NÃO resolve entidades externas (DOCTYPE/ENTITY)
    // por design — não usa libxml2 nem expat com resolução de rede.
    // Referência: https://github.com/Leonidas-from-XIV/node-xml2js/issues/159
    // strict:true rejeita XML malformado; explicitCharkey:false é o default seguro.
    const xmlContent = req.file.buffer.toString('utf-8');
    try {
      await xml2js.parseStringPromise(xmlContent, { strict: true, explicitCharkey: false });
    } catch (_parseErr) {
      return res.status(400).json({ error: 'Arquivo inválido: envie um XML de NFS-e válido.' });
    }

    // Pré-condição: o XML tem que ser do CNPJ do motorista logado.
    // O serviço de validação localiza o movimento pelo <prest><CNPJ> de DENTRO
    // do XML (não pelo login). Se o XML for de outro prestador, ele gravaria o
    // resultado no movimento alheio e o app não acharia o do motorista. Por isso
    // recusamos aqui, com mensagem clara, antes de chamar o serviço.
    const cnpjMotorista = String(cnpj).replace(/\D/g, '');
    const prestBloco = xmlContent.match(/<prest\b[^>]*>([\s\S]*?)<\/prest>/i);
    const cnpjXmlMatch = prestBloco && prestBloco[1].match(/<CNPJ\b[^>]*>\s*([\d./-]+)\s*<\/CNPJ>/i);
    const cnpjXml = cnpjXmlMatch ? cnpjXmlMatch[1].replace(/\D/g, '') : '';
    if (cnpjXml && cnpjXml !== cnpjMotorista) {
      return res.status(400).json({
        error: 'Este XML não pertence ao seu CNPJ. Envie a nota fiscal emitida com o seu CNPJ de prestador.',
      });
    }

    // Pré-condição 1: existe movimento aberto para este CNPJ
    const movimentos = await _postgrestRequest(
      `EnvioMassa?${cnpjEnvioMassaFilter(cnpj)}&${VALOR_EMITIVEL}&mov_fechado=eq.false&order=created_at.desc&limit=1`
    );

    if (!movimentos || movimentos.length === 0) {
      return res.status(409).json({ error: 'Nenhum movimento em aberto para validar.' });
    }

    const movimento = movimentos[0];

    // Pré-condição 2: bloqueio de reenvio — só se já APROVADA de verdade.
    // O serviço de validação grava nota_ok = URL do XML mesmo quando a nota é
    // REPROVADA; portanto "aprovada" = ter nota_ok preenchido E erro_validacao
    // vazio. Assim uma nota reprovada pode ser reenviada após correção.
    const notaOkFlag = movimento.nota_ok;
    const temNotaOk = notaOkFlag != null && String(notaOkFlag).trim() !== '';
    const jaAprovada = temNotaOk && !((movimento.erro_validacao || '').trim());

    if (jaAprovada) {
      return res.status(409).json({
        error: 'Nota já aprovada. Reenvio bloqueado.',
        notaOk: true,
      });
    }

    // hub-motorista-canonico (FASE 6, tasks.md 6.3) — ADITIVO: grava
    // entregador_uuid no movimento quando resolvido no login (task 6.2). Só
    // roda quando o gate HUB_MOTORISTA_LOGIN_CONTA_ATIVA populou o token com
    // entregadorUuid — produção sem a env nunca chega aqui (inerte,
    // FR-023/SC-007). Não reescreve nenhuma chave existente (cnpj_prestador
    // continua a fonte de verdade); best-effort — falha aqui NUNCA bloqueia
    // a validação da nota (clarify Q4/6.3.2: atividade cujo uuid ainda não
    // tem motorista cadastrado é gravada normalmente, sem bloqueio nem
    // sinalização de erro — aqui simplesmente não há uuid a gravar).
    if (req.motorista.entregadorUuid) {
      try {
        await _postgrestRequest(
          `EnvioMassa?id=eq.${movimento.id}`,
          'PATCH',
          { entregador_uuid: req.motorista.entregadorUuid }
        );
      } catch (gravaErr) {
        console.error('[motorista/validar-nota] Falha ao gravar entregador_uuid (não bloqueia):', gravaErr.message);
      }
    }

    // Chamar serviço de validação externo (server-side — FR-015)
    // Ref: research.md Decision 5 / contracts §validar-nota
    // OWASP fix: API FastAPI espera multipart/form-data (schema OpenAPI confirmado).
    // URLSearchParams (x-www-form-urlencoded) causava falha silenciosa — corrigido
    // para multipart via pacote `form-data` (Node 14 não tem FormData global).
    // Espelha a validação em massa (server.js) que funciona em produção:
    // - xml_input é um OBJETO único (não array) — senão o FastAPI faz
    //   payload.get() sobre uma lista e estoura 500 (main.py:499).
    // - empresa 6 usa o endpoint NÃO-nexus com id_empresa; as demais usam o
    //   endpoint nexus com nexus=true. Body como x-www-form-urlencoded.
    const xmlInput = JSON.stringify({ filename: req.file.originalname, data: xmlContent });

    let url, payload;
    // base-motorista-grupo-movee: todo o grupo Movee (empresa 6 + filiais) usa a MESMA
    // FastAPI (não-nexus, id_empresa=6). Antes era `=== 6` estrito, que mandaria uma
    // filial Movee para a FastAPI nexus errada.
    const _grupoCache = {};
    if (await mesmoGrupoQue(Number(movimento.id_empresa), 6, _grupoCache)) {
      url = 'https://fastapihomologacao.todo-tips.com/validade_nfse';
      payload = new URLSearchParams({
        xml_input: xmlInput,
        id_empresa: '6',
        validar_descricao_servico: 'false',
      });
    } else {
      url = 'https://fastapihomologacaonexus.todo-tips.com/validade_nfse';
      payload = new URLSearchParams({
        xml_input: xmlInput,
        nexus: 'true',
        validar_descricao_servico: 'false',
      });
    }

    let apiData;
    try {
      const apiResponse = await axios.post(url, payload.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: process.env.FASTAPI_VALIDATION_TOKEN,
        },
        timeout: 30000,
      });
      apiData = Array.isArray(apiResponse.data) ? apiResponse.data[0] : apiResponse.data;
    } catch (apiErr) {
      // Diagnóstico: além da mensagem, logar status e corpo da resposta do
      // serviço de validação (NÃO loga o header Authorization — só a resposta).
      let respBody;
      try {
        respBody = typeof apiErr.response?.data === 'object'
          ? JSON.stringify(apiErr.response.data)
          : String(apiErr.response?.data);
      } catch {
        respBody = '<não serializável>';
      }
      console.error(
        '[motorista/validar-nota] Serviço externo falhou:',
        apiErr.message,
        '| status:', apiErr.response?.status,
        '| body:', respBody
      );
      // Distinção infra vs. negócio (não altera nota_ok/erro_validacao — FR-012):
      // - Erro de NEGÓCIO: o serviço de validação RESPONDEU com uma regra (4xx +
      //   `detail`), ex.: "Nenhum motorista ativo encontrado para o CNPJ do
      //   prestador informado." -> propagar a mensagem real ao app (422), em vez
      //   de mascará-la como "serviço indisponível".
      // - Falha de INFRA: timeout, conexão recusada, sem `response`, ou 5xx -> o
      //   serviço está de fato indisponível -> 502 genérico.
      const extStatus = apiErr.response?.status;
      const extDetail = apiErr.response?.data?.detail;
      const detailMsg = typeof extDetail === 'string' ? extDetail.trim() : '';
      if (extStatus >= 400 && extStatus < 500 && detailMsg) {
        return res.status(422).json({ error: detailMsg });
      }
      return res.status(502).json({
        error: 'Serviço de validação indisponível. Tente novamente em instantes.',
      });
    }

    // Fonte de verdade: o serviço de validação grava o resultado DIRETO na
    // EnvioMassa (nota_ok = URL do XML salvo; erro_validacao = campos reprovados,
    // ex.: "valid_valor,valid_cnpj"). Relemos o registro do movimento e
    // decidimos por erro_validacao — não pelo status HTTP nem pelo JSON imediato.
    // O backend NÃO regrava nota_ok/erro_validacao (evita sobrescrever a URL).
    let registro;
    try {
      const refreshed = await _postgrestRequest(
        `EnvioMassa?id=eq.${movimento.id}&select=nota_ok,erro_validacao`
      );
      registro = refreshed && refreshed[0];
    } catch (_e) {
      registro = null;
    }

    const notaOkGravado =
      registro && registro.nota_ok != null && String(registro.nota_ok).trim() !== '';
    const erroValidacao = ((registro && registro.erro_validacao) || '').trim();

    if (notaOkGravado && !erroValidacao) {
      // Aprovada — resultado já persistido pelo serviço de validação
      return res.json({
        valid: true,
        notaOk: true,
        mensagem: 'Nota ok! Validação aprovada.',
      });
    }

    if (erroValidacao) {
      // Reprovada — campos vêm de erro_validacao gravado na EnvioMassa
      const camposInvalidos = camposInvalidosDe(erroValidacao);

      return res.json({
        valid: false,
        notaOk: false,
        camposInvalidos,
        instrucao: 'Cancele esta nota e emita uma nova com os campos corrigidos.',
      });
    }

    // Sem resultado gravado: o serviço respondeu mas não persistiu o resultado.
    console.error(
      '[motorista/validar-nota] Sem resultado gravado na EnvioMassa pós-validação. apiData:',
      JSON.stringify(apiData)
    );
    return res.status(503).json({
      error: 'Serviço de validação indisponível. Tente novamente em instantes.',
    });
  } catch (err) {
    console.error('[motorista/validar-nota] Erro inesperado:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// nota-pendente-motorista (F2) — o motorista regulariza notas de movimentos
// ANTERIORES ao aberto. Via NOVA e paralela: `/movimento-aberto` e `/validar-nota`
// (acima) seguem intocadas até o operador validar esta. Ver
// docs/plans/nota-pendente-motorista/BRIEFING.md.
// ──────────────────────────────────────────────────────────────────────────────

// Recorte da lista (decisão do operador) e teto de itens. O teto é GUARDA, não
// paginação: o máximo medido em 90 dias é 11 por motorista. Ele também mantém
// seguro o `id=in.(...)` abaixo — lista grande estoura o header do PostgREST
// (incidente do upload de motorista, PR #50).
const NOTAS_PENDENTES_TETO = 50;
// Corte configurável no hub (AdiantamentoConfiguracao, card "Notas pendentes do
// motorista"): movimento com semana (dt_inicial) anterior ao corte está fora da
// regularização — nem aparece, nem aceita envio. Vale para listagem E envio (sem ele
// no envio, quem tem o id ainda mandaria). dt_inicial nulo ou de data inválida (1982)
// também fica de fora: `gte` não casa nulo. Falha ao ler a config → padrão 2026-07-20,
// sem bloquear o motorista.
// ⚠️ Tabela do hub com RLS: o cliente legado voltaria vazio sem erro — vai pelo hubPostgrestRequest.
async function corteNotasPendentes() {
  try {
    const linhas = await hubPostgrestRequest(
      `AdiantamentoConfiguracao?id_empresa=eq.6&vigente_desde=lte.${encodeURIComponent(new Date().toISOString())}` +
      '&order=versao.desc&limit=1&select=notas_pendentes_corte_modo,notas_pendentes_corte_dias,notas_pendentes_corte_data',
      'GET', null, { escopo: [6] }
    );
    if (Array.isArray(linhas) && linhas[0]) return calcularCorte(linhas[0]);
    console.error('[motorista/notas-pendentes] config do corte não encontrada; usando', CORTE_PADRAO);
  } catch (e) {
    console.error('[motorista/notas-pendentes] leitura da config do corte falhou; usando', CORTE_PADRAO, '-', e.message);
  }
  return CORTE_PADRAO;
}

// Chave de liga/desliga da funcionalidade (listagem E envio). Default LIGADO: só o
// valor explícito false/off/0 desliga. Lida a CADA requisição (não no boot) para o
// operador alternar só reiniciando o serviço, sem deploy de imagem.
function notasPendentesAtivo() {
  return !['false', 'off', '0'].includes(String(process.env.MOTORISTA_NOTAS_PENDENTES || '').trim().toLowerCase());
}
const NOTAS_PENDENTES_DESLIGADO = 'O envio de notas pendentes está temporariamente indisponível.';

// "Não aprovada" = nota_ok vazio OU erro_validacao preenchido — negação de
// notaAprovada() (routes/hub-validacao-xml.js). Em PostgREST: `and(...)` aninhado
// dentro do `or`; o `neq.` exclui o erro_validacao '' (que não é erro).
const NOTAS_PENDENTES_OR = '(nota_ok.is.null,nota_ok.eq.,and(erro_validacao.not.is.null,erro_validacao.neq.))';

// ROTA: GET /motorista/notas-pendentes  (autenticado)
// Pendência = EnvioMassa com nota NÃO aprovada, ABERTA ou FECHADA (para o motorista
// a distinção é interna). `nota_ok` guarda a URL do XML mesmo de nota reprovada, então
// reprovada (nota_ok E erro_validacao preenchidos) TAMBÉM é pendente: precisa de reenvio.
router.get('/notas-pendentes', authenticateMotorista, async (req, res) => {
  try {
    if (!notasPendentesAtivo()) return res.json({ notas: [] });
    // Escopo sempre pela SESSÃO — query/body são ignorados (Constituição II)
    const cnpj = req.motorista.cnpjPrestador;
    const corte = await corteNotasPendentes();
    const linhas = (await _postgrestRequest(
      `EnvioMassa?${cnpjEnvioMassaFilter(cnpj)}` +
      `&${VALOR_EMITIVEL}` +
      `&dt_inicial=gte.${corte}` +
      `&or=${encodeURIComponent(NOTAS_PENDENTES_OR)}` +
      '&select=id,created_at,valor,dt_inicial,dt_final,cnpj_tomador,id_empresa,erro_validacao' +
      `&order=created_at.desc&limit=${NOTAS_PENDENTES_TETO}`
    )) || [];

    // Tomador (razão social) numa consulta só, como /movimento-aberto faz por item.
    // Tolerante a falha: nunca bloqueia a lista.
    const nomes = new Map();
    const idsEmpresa = [...new Set(linhas.map((m) => m.id_empresa).filter((v) => v != null))];
    if (idsEmpresa.length > 0) {
      try {
        const empresas = await _postgrestRequest(
          `Empresa?id=in.(${idsEmpresa.map(encodeURIComponent).join(',')})&select=id,nome_empresa`
        );
        for (const e of empresas || []) nomes.set(String(e.id), e.nome_empresa || null);
      } catch (e) {
        console.error('[motorista/notas-pendentes] busca do tomador falhou:', e.message);
      }
    }

    // Origem INFERIDA, sem coluna nova (a EnvioMassa não tem): id presente em
    // ApuracaoRepasseMovimento = 'REPASSE', senão 'MOVIMENTO'.
    // ⚠️ Hoje essa tabela está VAZIA (o "Gerar notas" nunca gerou movimento), então
    // TODO item sai 'MOVIMENTO'. É o esperado — não é inferência quebrada.
    // Tabela do hub tem RLS por `escopo` (empresas): o JWT legado não tem essa claim
    // e enxergaria 0 linhas, mascarando todo REPASSE. Por isso vai pelo cliente do
    // hub, com escopo = só as empresas dos movimentos DESTE motorista (derivadas do
    // banco, nunca do cliente). Uma consulta só, no máximo 50 ids.
    const idsRepasse = new Set();
    if (linhas.length > 0) {
      try {
        const trilha = await hubPostgrestRequest(
          `ApuracaoRepasseMovimento?select=envio_massa_id&envio_massa_id=in.(${linhas.map((m) => encodeURIComponent(m.id)).join(',')})`,
          'GET', null, { escopo: idsEmpresa.map(Number).filter(Number.isFinite) }
        );
        for (const t of trilha || []) idsRepasse.add(String(t.envio_massa_id));
      } catch (e) {
        console.error('[motorista/notas-pendentes] busca da origem falhou:', e.message);
      }
    }

    return res.json({
      notas: linhas.map((m) => {
        // Nota já recusada: devolve os campos reprovados para o motorista corrigir.
        // Item nunca enviado não ganha a chave.
        const camposInvalidos = camposInvalidosDe(m.erro_validacao);
        return {
        id: m.id,
        criadoEm: m.created_at,
        valor: m.valor,
        dtInicial: m.dt_inicial,
        dtFinal: m.dt_final,
        cnpjTomador: m.cnpj_tomador,
        tomador: nomes.get(String(m.id_empresa)) || null,
        origem: idsRepasse.has(String(m.id)) ? 'REPASSE' : 'MOVIMENTO',
        ...(camposInvalidos.length > 0 && { camposInvalidos }),
        };
      }),
    });
  } catch (err) {
    console.error('[motorista/notas-pendentes] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ROTA: POST /motorista/notas-pendentes/:id/validar  (autenticado, multipart)
// Mesmo comportamento de POST /validar-nota, com duas diferenças: (1) o movimento
// vem da URL e é conferido contra o CNPJ da sessão; (2) `id_movimento` vai à
// FastAPI, que então grava NAQUELE registro (F1) em vez de achar pelo CNPJ do XML.
router.post('/notas-pendentes/:id/validar', authenticateMotorista, uploadSingle, async (req, res) => {
  try {
    if (!notasPendentesAtivo()) return res.status(503).json({ error: NOTAS_PENDENTES_DESLIGADO });
    const cnpj = req.motorista.cnpjPrestador;

    // Trava central, ANTES de qualquer outra coisa: a pendência tem que ser do CNPJ
    // da sessão. 404 (não 403) para não revelar que o movimento de outro existe.
    const idMov = String(req.params.id);
    const movimentos = /^\d+$/.test(idMov)
      ? await _postgrestRequest(`EnvioMassa?id=eq.${idMov}&${cnpjEnvioMassaFilter(cnpj)}&${VALOR_EMITIVEL}&dt_inicial=gte.${await corteNotasPendentes()}&limit=1`)
      : [];
    if (!movimentos || movimentos.length === 0) {
      return res.status(404).json({ error: 'Pendência não encontrada.' });
    }
    const movimento = movimentos[0];

    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo XML não enviado.' });
    }

    // XML bem-formado (FR-011). xml2js não resolve entidades externas (XXE).
    const xmlContent = req.file.buffer.toString('utf-8');
    try {
      await xml2js.parseStringPromise(xmlContent, { strict: true, explicitCharkey: false });
    } catch (_parseErr) {
      return res.status(400).json({ error: 'Arquivo inválido: envie um XML de NFS-e válido.' });
    }

    // Mesmo com o destino explícito (id_movimento), XML de outro prestador não é a
    // nota desta pendência — a recusa continua sendo a defesa certa.
    const cnpjMotorista = String(cnpj).replace(/\D/g, '');
    const prestBloco = xmlContent.match(/<prest\b[^>]*>([\s\S]*?)<\/prest>/i);
    const cnpjXmlMatch = prestBloco && prestBloco[1].match(/<CNPJ\b[^>]*>\s*([\d./-]+)\s*<\/CNPJ>/i);
    const cnpjXml = cnpjXmlMatch ? cnpjXmlMatch[1].replace(/\D/g, '') : '';
    if (cnpjXml && cnpjXml !== cnpjMotorista) {
      return res.status(400).json({
        error: 'Este XML não pertence ao seu CNPJ. Envie a nota fiscal emitida com o seu CNPJ de prestador.',
      });
    }

    // "Aprovada" = nota_ok preenchido E erro_validacao vazio (nota reprovada pode reenviar).
    const temNotaOk = movimento.nota_ok != null && String(movimento.nota_ok).trim() !== '';
    if (temNotaOk && !((movimento.erro_validacao || '').trim())) {
      return res.status(409).json({ error: 'Nota já aprovada. Reenvio bloqueado.', notaOk: true });
    }

    // Aditivo e best-effort, igual à rota antiga (hub-motorista-canonico 6.3).
    if (req.motorista.entregadorUuid) {
      try {
        await _postgrestRequest(
          `EnvioMassa?id=eq.${movimento.id}`,
          'PATCH',
          { entregador_uuid: req.motorista.entregadorUuid }
        );
      } catch (gravaErr) {
        console.error('[motorista/notas-pendentes] Falha ao gravar entregador_uuid (não bloqueia):', gravaErr.message);
      }
    }

    const xmlInput = JSON.stringify({ filename: req.file.originalname, data: xmlContent });

    // Grupo Movee (empresa 6 + filiais) → FastAPI não-nexus; demais → nexus.
    // Nunca `=== 6` estrito (a Movee terá filiais).
    let url, payload;
    const _grupoCache = {};
    if (await mesmoGrupoQue(Number(movimento.id_empresa), 6, _grupoCache)) {
      url = 'https://fastapihomologacao.todo-tips.com/validade_nfse';
      payload = new URLSearchParams({
        xml_input: xmlInput,
        id_empresa: '6',
        validar_descricao_servico: 'false',
        id_movimento: String(movimento.id),
      });
    } else {
      url = 'https://fastapihomologacaonexus.todo-tips.com/validade_nfse';
      payload = new URLSearchParams({
        xml_input: xmlInput,
        nexus: 'true',
        validar_descricao_servico: 'false',
        id_movimento: String(movimento.id),
      });
    }

    try {
      await axios.post(url, payload.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: process.env.FASTAPI_VALIDATION_TOKEN,
        },
        timeout: 30000,
      });
    } catch (apiErr) {
      let respBody;
      try {
        respBody = typeof apiErr.response?.data === 'object'
          ? JSON.stringify(apiErr.response.data)
          : String(apiErr.response?.data);
      } catch {
        respBody = '<não serializável>';
      }
      console.error(
        '[motorista/notas-pendentes] Serviço externo falhou:',
        apiErr.message, '| status:', apiErr.response?.status, '| body:', respBody
      );
      // Negócio (4xx com `detail`) propaga a mensagem real; infra (timeout/5xx) vira 502.
      const extStatus = apiErr.response?.status;
      const extDetail = apiErr.response?.data?.detail;
      const detailMsg = typeof extDetail === 'string' ? extDetail.trim() : '';
      if (extStatus >= 400 && extStatus < 500 && detailMsg) {
        return res.status(422).json({ error: detailMsg });
      }
      return res.status(502).json({
        error: 'Serviço de validação indisponível. Tente novamente em instantes.',
      });
    }

    // Fonte de verdade: a FastAPI grava direto na EnvioMassa; relemos e decidimos
    // por erro_validacao (o backend não regrava nota_ok/erro_validacao).
    let registro;
    try {
      const refreshed = await _postgrestRequest(
        `EnvioMassa?id=eq.${movimento.id}&select=nota_ok,erro_validacao`
      );
      registro = refreshed && refreshed[0];
    } catch (_e) {
      registro = null;
    }

    const notaOkGravado =
      registro && registro.nota_ok != null && String(registro.nota_ok).trim() !== '';
    const erroValidacao = ((registro && registro.erro_validacao) || '').trim();

    if (notaOkGravado && !erroValidacao) {
      // Marca "regularizada após o fechamento" para o operador liberar o pagamento
      // retido. Só quando o movimento JÁ estava fechado (aberto é o fluxo normal).
      // `regularizada_em=is.null` no filtro: não sobrescreve a marca do primeiro
      // envio pós-fechamento (nota reprovada pode ser reenviada).
      // Best-effort, como o entregador_uuid: a nota já foi validada e gravada, então
      // falhar aqui só loga — responder erro a um envio que deu certo é pior que
      // perder o aviso.
      if (movimento.mov_fechado === true) {
        try {
          await _postgrestRequest(
            `EnvioMassa?id=eq.${movimento.id}&regularizada_em=is.null`,
            'PATCH',
            { regularizada_em: new Date().toISOString() }
          );
        } catch (marcaErr) {
          console.error('[motorista/notas-pendentes] Falha ao gravar regularizada_em (não bloqueia):', marcaErr.message);
        }
      }
      return res.json({ valid: true, notaOk: true, mensagem: 'Nota ok! Validação aprovada.' });
    }

    if (erroValidacao) {
      const camposInvalidos = camposInvalidosDe(erroValidacao);
      return res.json({
        valid: false,
        notaOk: false,
        camposInvalidos,
        instrucao: 'Cancele esta nota e emita uma nova com os campos corrigidos.',
      });
    }

    console.error('[motorista/notas-pendentes] Sem resultado gravado na EnvioMassa pós-validação. id:', movimento.id);
    return res.status(503).json({
      error: 'Serviço de validação indisponível. Tente novamente em instantes.',
    });
  } catch (err) {
    console.error('[motorista/notas-pendentes] Erro inesperado:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Exportar router + função init (injeção de dependências)
// ──────────────────────────────────────────────────────────────────────────────
module.exports = { router, init, authenticateMotorista, corteNotasPendentes };
