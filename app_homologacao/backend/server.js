require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const fs = require('fs');
const { Parser } = require('json2csv');
const fetch = require('node-fetch'); // Para fazer requisições HTTP ao PostgREST
const rateLimit = require('express-rate-limit'); // grupo-unificado-filiais: OWASP MEDIUM-001
const backendUrl = 'https://envmassapihomologacao.todo-tips.com'; // URL do backend
const archiver = require('archiver');
const xml2js = require('xml2js');

// App Motorista — rotas /motorista/*
const motoristaRoutes = require('./routes/motorista');

// config-ui-tenant — rotas /grupo/* + helper resolveScope
const grupoRoutes = require('./routes/grupo');
const { resolveEmpresaAlvo, mesmoGrupoQue } = grupoRoutes; // movimento-por-filial: threading empresa_id; grupo-unificado-filiais: helper de grupo

// config-ui-tenant — rotas /empresa/branding + /motorista/branding-tomador
const brandingRoutes = require('./routes/branding');

// cadastro-motorista-base-validada — CRUD admin de motoristas /admin/motoristas/*
const adminMotoristaRoutes = require('./routes/admin-motorista');

// hub-fundacoes (FASE 3, S2 do hub-frota) — rotas /api/v1/auth/* do hub isolado.
// Router 100% novo e autocontido (própria conexão PostgREST via lib/hub-postgrest.js,
// próprio JWT via lib/hub-postgrest-jwt.js) — NÃO usa postgrestRequest/generatePostgrestJWT
// legados. Ativo em qualquer ambiente que monte este server.js, mas só o hub
// (Dockerfile.hub) provê as env vars que ele exige (PGRST_JWT_SECRET/JWT_SECRET/
// POSTGREST_URL); o backend de produção (Dockerfile, node:14) nunca recebe tráfego
// nestas rotas — nenhum cliente de produção as conhece.
const hubAuthRoutes = require('./routes/hub-auth');

// hub-fundacoes (FASE 4) — rotas /api/v1/me* e /api/v1/auditoria do hub
// isolado. Arquivo 100% novo (routes/hub-me.js); cada rota decide sua própria
// exigência de auth internamente (GET /me e POST /me/entidade exigem só
// accessToken válido; GET /auditoria passa por requirePermission).
const hubMeRoutes = require('./routes/hub-me');

// hub-importacoes (S4 do hub de frota, FASE 3) — POST /api/v1/importacoes
// (upload multipart, dedupe por sha256, requirePermission interno). Arquivo
// 100% novo (routes/hub-importacoes.js).
const hubImportacoesRoutes = require('./routes/hub-importacoes');
// hub-importacoes (pós-review PR #57, F1.3) — recuperarImportacoesOrfas,
// chamada 1x no boot (ver bloco perto de app.listen abaixo).
const hubImportProcessor = require('./lib/hub-import-processor');

// hub-motoristas (S5 do hub de frota, FASE 3) — GET /api/v1/motoristas
// (lista paginada) e GET /api/v1/motoristas/:id (detalhe), requirePermission
// interno. Arquivo 100% novo (routes/hub-motoristas.js).
const hubMotoristasRoutes = require('./routes/hub-motoristas');

// hub-faturamento (S6 do hub de frota, FASE 3) — GET /api/v1/faturamento
// (lista paginada + export CSV) e GET /api/v1/faturamento/resumo (cards/
// agregados), requirePermission interno. Arquivo 100% novo
// (routes/hub-faturamento.js). Somente leitura (FR-011).
const hubFaturamentoRoutes = require('./routes/hub-faturamento');

// hub-performance (S7 do hub de frota, FASE 2) — GET /api/v1/performance
// (lista paginada + export CSV) e GET /api/v1/performance/resumo (cards/
// agregados), requirePermission interno. Arquivo 100% novo
// (routes/hub-performance.js). Somente leitura (FR-010).
const hubPerformanceRoutes = require('./routes/hub-performance');

// hub-envio-massa (S8 do hub de frota, FASE 3) — os 11 endpoints legados de
// envio em massa abaixo ganham 2 middlewares novos na cadeia (claims-bridge +
// gate de permissão RBAC), atuando somente quando a sessão é do hub
// (req.hubContext.viaHub === true); sessão legada passa sempre (Decision 5).
const { hubEnvioMassaClaimsBridge } = require('./middleware/hub-envio-massa-claims');
const { hubEnvioMassaRequirePermission } = require('./middleware/hub-envio-massa-permission');

const app = express();
const upload = multer({ dest: 'uploads/' }); // Usado para upload de arquivos
// validacao-xml-lote (FASE 0, CHK113/CHK022): instância dedicada do multer para
// a rota /validate-xml-batch com limite de tamanho por arquivo (2 MB) e de
// quantidade (100). Separada do `upload` global para NÃO impor 2 MB ao /upload
// (XLSX pode ser maior). XMLs NFS-e nacionais são pequenos (<2 MB); o limite
// rejeita o arquivo no multer ANTES do parsing. dest mantido em 'uploads/'
// (mesmo disco transiente do upload); cada arquivo é removido via fs.unlinkSync
// no finally do loop, então nenhum XML persiste após o processamento (CHK109).
const XML_BATCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB por XML
const uploadXmlBatch = multer({
  dest: 'uploads/',
  limits: { fileSize: XML_BATCH_MAX_FILE_BYTES, files: 100 }
});

// fix login motorista 429 (trust proxy) — o backend roda atrás de Traefik (ingress do
// Swarm) e do proxy Next.js (frontend_*/app/api/[...path]/route.ts). SEM trust proxy o
// Express ignora o X-Forwarded-For e usa o IP do socket (o da rede overlay/proxy), que
// é IDÊNTICO para todos os clientes. Isso fazia o rate limit por IP do /motorista/login
// (keyGenerator: req.ip) virar um BALDE GLOBAL: após 10 logins agregados em 15 min, todo
// motorista recebia 429 → a UI mostrava "Erro ao conectar. Tente novamente.".
// O nº de hops confiáveis depende da topologia (Traefik + Next). Default 1 (Traefik);
// ajustável por env sem rebuild se a contagem precisar mudar após validação no ambiente.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Configurações básicas do servidor
app.use(cookieParser());
const allowedOrigins = [
  'https://envmasshomologacao.todo-tips.com',
  'https://envmassv2.todo-tips.com',
  'https://appmotorista.todo-tips.com', // App Motorista PWA
];
app.use(cors({
  origin: allowedOrigins,
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  credentials: true
}));
app.options('*', cors({
  origin: allowedOrigins,
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  credentials: true
}));
app.use(express.json()); // Para entender JSON no corpo das requisições

// grupo-unificado-filiais — Task 4.1: dummy hash fixo p/ equalizar timing (OWASP HIGH-001 / CWE-208)
// Gerado uma vez: bcrypt.hashSync('dummy-placeholder', 10)
const BCRYPT_DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

// grupo-unificado-filiais — Task 4.3: rate limiter em POST /login (OWASP MEDIUM-001)
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // máximo 10 tentativas por IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' });
  },
});

// URL e chave da API PostgREST
const POSTGREST_URL = process.env.POSTGREST_URL;
const POSTGREST_API_KEY = process.env.POSTGREST_API_KEY;

// Função para gerar um JWT para o PostgREST
function generatePostgrestJWT() {
  const payload = {
    role: 'authenticated' // Depende das permissões configuradas no PostgREST
  };

  try {
    // Tente gerar o JWT com a chave secreta
    const token = jwt.sign(payload, process.env.POSTGREST_API_KEY, { expiresIn: '30m' });
    return token;
  } catch (error) {
    // Capture e exiba o erro
    console.error('Erro ao gerar o JWT:', error);
    throw new Error('Falha ao gerar o JWT para o PostgREST.');
  }
}

// Função para fazer requisições ao PostgREST
async function postgrestRequest(endpoint, method = 'GET', body = null) {
    const token = generatePostgrestJWT(); // Gerar o JWT para autenticação

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Prefer': 'return=representation', // Retorna a representação dos dados após operações
        'Cache-Control': 'no-cache'
    };

    const options = {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
    };

    const url = `${POSTGREST_URL}/${endpoint}`;
    //console.log(`Enviando requisição para: ${url}`, options);

    const response = await fetch(url, options);

    if (!response.ok) {
        // Capturar o corpo do erro UMA vez (o stream so pode ser lido uma vez) e
        // propaga-lo no Error para que os callers possam diferenciar violacoes
        // (ex.: UNIQUE de cnpj/email -> 409/400 em routes/grupo.js). O corpo fica
        // server-side (logado + usado para matching); nunca e enviado ao cliente.
        const errBody = await response.text();
        console.error('Erro ao enviar para o PostgREST:', errBody);
        const pgErr = new Error(`Erro ao enviar dados para o PostgREST: ${response.statusText} — ${errBody}`);
        pgErr.status = response.status;
        pgErr.body = errBody;
        throw pgErr;
    }

    const data = await response.json();
    //console.log(`Resposta do PostgREST para ${endpoint}:`, data);

    return data;
}

// corte-modulo-c (DDL 007): o corte do login único é POR GRUPO e A QUENTE (sem cache).
// A guarda de filial (POST /login e POST /token/refresh) só bloqueia se o grupo da
// filial tiver login_unico_ativo=true. Compartilhada entre os dois pontos para garantir
// paridade (divergir os dois reabriria o bypass via refreshToken — OWASP LOW-004).
// Fail-open: erro de leitura da flag NÃO bloqueia — o 403 de filial é governança/UX
// (redirecionar ao login do grupo), não fronteira de tenant (a filial é membro legítimo
// do grupo e já passou pela senha). Não trancar usuário real por falha transitória de DB.
async function grupoLoginUnicoAtivo(idGrupo) {
  try {
    const rows = await postgrestRequest(`Grupo?id=eq.${idGrupo}&select=login_unico_ativo`);
    return rows && rows.length > 0 && rows[0].login_unico_ativo === true;
  } catch (_e) {
    return false;
  }
}


// Função para gerar o JWT
function generateAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
}

// Função para gerar o Refresh Token
function generateRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

// Middleware para verificar o token JWT
function authenticateToken(req, res, next) {
    const token = req.cookies.accessToken;
    if (!token) return res.status(401).json({ error: 'Acesso negado, token não encontrado' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            console.error('Erro ao verificar JWT:', err.message);
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

// Rota de Login
// grupo-unificado-filiais — Task 4.3: rate limiter aplicado EXCLUSIVAMENTE nesta rota (OWASP MEDIUM-001)
app.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // grupo-unificado-filiais — Task 4.1: OWASP HIGH-001 (CWE-208 anti-enumeração)
    // Passo 0: validar presença dos campos ANTES de qualquer bcrypt.compare.
    // bcrypt.compare(undefined, hash) lança "data and hash arguments required" → 500.
    // Resposta genérica (não vaza qual campo faltou); não compromete o anti-enumeração
    // porque um atacante sempre envia ambos os campos preenchidos.
    if (!email || !password) {
      return res.status(400).json({ error: 'Email ou senha incorretos' });
    }

    // Passo 1: buscar empresa por email
    const users = await postgrestRequest(`Empresa?email=eq.${email}`);

    // Passo 2: email não encontrado → bcrypt.compare com dummy hash para equalizar timing
    if (users.length === 0) {
      await bcrypt.compare(password, BCRYPT_DUMMY_HASH); // equaliza timing (não retorna nada útil)
      return res.status(400).json({ error: 'Email ou senha incorretos' });
    }

    const user = users[0];

    // Passo 3: bcrypt.compare SEMPRE, mesmo antes de qualquer outra checagem.
    // Filial criada sob FR-B não tem senha gravada (user.pass null/vazio): comparar
    // contra o dummy hash evita o crash bcrypt "data and hash arguments required" e
    // ainda equaliza o timing — resulta em senha inválida (400), sem vazar o motivo.
    const isValidPassword = await bcrypt.compare(password, user.pass || BCRYPT_DUMMY_HASH);

    if (!isValidPassword) {
      return res.status(400).json({ error: 'Email ou senha incorretos' });
    }

    // config-ui-tenant: enriquecer o payload com id_grupo e is_grupo_pai
    // (lidos da tabela Empresa + Grupo — sem alterar campos existentes)
    let idGrupo = user.id_grupo || null;
    let isGrupoPai = false;
    if (user.id_grupo) {
      // Verificar se esta empresa é a administradora (pai) do grupo
      try {
        const grupoCheck = await postgrestRequest(
          `Grupo?id_empresa_pai=eq.${user.id}&select=id`
        );
        if (grupoCheck && grupoCheck.length > 0) {
          isGrupoPai = true;
          idGrupo = grupoCheck[0].id;
        }
      } catch (_e) {
        // Falha ao checar grupo: degradar para sem-grupo (fail-safe)
        idGrupo = null;
        isGrupoPai = false;
      }
    }

    // Passo 4 — grupo-unificado-filiais Task 4.1: SOMENTE após senha válida, checar se é filial
    // Filial = tem id_grupo setado E não é empresa-pai de nenhum grupo
    // corte-modulo-c (DDL 007): bloquear APENAS se o grupo da filial tiver login_unico_ativo=true.
    if (idGrupo !== null && isGrupoPai === false && await grupoLoginUnicoAtivo(idGrupo)) {
      // OWASP LOW-001: logar bloqueio sem credencial
      console.log('[security] login-filial-bloqueado empresaId=%d grupoId=%d ip=%s ts=%s', user.id, idGrupo, req.ip, new Date().toISOString());
      return res.status(403).json({ error: 'Acesse o painel usando o login do grupo' });
    }

    // Passo 5: empresa-pai ou standalone — fluxo normal de geração de token
    const payload = {
      empresaId: user.id,
      nome_empresa: user.nome_empresa,
      workflow_id: user.workflow_id,
      sender: user.sender,
      tk: user.tk,
      connection_id: user.connection_id,
      // config-ui-tenant: claims de grupo (Princípio II v1.1.0)
      id_grupo: idGrupo,
      is_grupo_pai: isGrupoPai,
    };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({ empresaId: user.id, nome_empresa: user.nome_empresa, workflow_id: user.workflow_id, sender: user.sender, tk: user.tk, connection_id: user.connection_id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro no servidor' });
  }
});

app.get('/verify-auth', authenticateToken, (req, res) => {
  if (req.user) {
    // Se o token JWT for válido, retornar as informações do usuário.
    // config-ui-tenant: expor claims de grupo p/ o frontend (gate de admin + nav).
    res.json({
      authenticated: true,
      nome_empresa: req.user.nome_empresa,
      is_grupo_pai: req.user.is_grupo_pai === true,
      id_grupo: req.user.id_grupo ?? null,
    });
  } else {
    res.status(401).json({ authenticated: false, error: 'Usuário não autenticado' });
  }
});

// Rota para renovar o JWT usando o Refresh Token
app.post('/token/refresh', async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Token de atualização ausente' });
  }

  try {
    // Validar o refresh token
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // config-ui-tenant: re-derivar claims de grupo do banco (não confiar no token
    // antigo — refresh tokens emitidos antes da feature não os carregam).
    let idGrupo = null;
    let isGrupoPai = false;
    try {
      const emp = await postgrestRequest(`Empresa?id=eq.${payload.empresaId}&select=id_grupo`);
      if (emp && emp.length > 0 && emp[0].id_grupo) {
        idGrupo = emp[0].id_grupo;
        const grupoCheck = await postgrestRequest(`Grupo?id_empresa_pai=eq.${payload.empresaId}&select=id`);
        if (grupoCheck && grupoCheck.length > 0) {
          isGrupoPai = true;
          idGrupo = grupoCheck[0].id;
        }
      }
    } catch (_e) {
      idGrupo = null;
      isGrupoPai = false;
    }

    // grupo-unificado-filiais — Task 4.2: OWASP LOW-004
    // Após derivar os claims, bloquear refresh de filial para impedir bypass do 403 do login
    // corte-modulo-c (DDL 007): bloquear APENAS se o grupo da filial tiver login_unico_ativo=true
    // (mesma guarda do POST /login — paridade obrigatória, senão refreshToken antigo fura o corte).
    if (idGrupo !== null && isGrupoPai === false && await grupoLoginUnicoAtivo(idGrupo)) {
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      return res.status(403).json({ error: 'Acesse o painel usando o login do grupo' });
    }

    // Gerar um novo JWT (preservando os claims de grupo)
    const newAccessToken = generateAccessToken({ empresaId: payload.empresaId, nome_empresa: payload.nome_empresa, workflow_id: payload.workflow_id, sender: payload.sender, tk: payload.tk, connection_id: payload.connection_id, id_grupo: idGrupo, is_grupo_pai: isGrupoPai });

    // Enviar o novo JWT no cookie
    res.cookie('accessToken', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 15 * 60 * 1000 // Expira em 15 minutos
    });

    return res.json({ message: 'Token renovado' });
  } catch (error) {
    return res.status(403).json({ error: 'Token de atualização inválido' });
  }
});


// Rota de CRUD para EnvioMassa
app.get('/envio-massa', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.consultar'), async (req, res) => {
  let idEmp;
  try {
    // movimento-por-filial: threading empresa_id (FR-009)
    // resolveEmpresaAlvo lança err com err.status 403/503 se fora do escopo
    idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'GET /envio-massa');
  } catch (authErr) {
    const status = authErr.status || 403;
    return res.status(status).json({ error: authErr.message });
  }
  try {
    const data = await postgrestRequest(`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`);

    res.json(data);
  } catch (error) {
    console.error('Erro ao buscar dados:', error);
    res.status(400).json({ error: 'Erro ao buscar dados' });
  }
});

// Função para envio de mensagens
function trataNumero(sender) {
  phone = sender.replace(/[\s()-]/g, "");

  // Remove o caractere '+' se estiver presente no início
  if (phone.startsWith("+")) {
    phone = phone.substring(1);
  }

  // Define variáveis iniciais
  let countryCode = "55"; // Código do país padrão para números nacionais
  let areaCode = "";
  let phoneNumber = "";

  // Verifica se o número já tem o código do país (55) e remove para processar o restante
  if (phone.startsWith("55")) {
    phone = phone.substring(2); // Remove o código do país
  }

  // Remove o zero inicial, se presente
  if (phone.startsWith("0")) {
    phone = phone.substring(1);
  }

  // Extrai o DDD (primeiros dois dígitos) e o número do telefone
  if (phone.length >= 10) {
    areaCode = phone.substring(0, 2); // DDD
    phoneNumber = phone.substring(2); // Número
  } else if (phone.length === 8 || phone.length === 9) {
    areaCode = "00"; // DDD genérico se não houver um especificado
    phoneNumber = phone;
  }

  // Regras específicas para números nacionais
  // Regra: se DDD > 30, remove o '9' inicial do número,
  // exceto quando o número tem exatamente 8 dígitos e começa com '9'
  if (parseInt(areaCode) > 30 && phoneNumber.startsWith("9") && phoneNumber.length !== 8) {
    phoneNumber = phoneNumber.substring(1); // Remove o '9' inicial
  }

  // Regra: se o DDD <= 30 e o número tiver 8 dígitos, adiciona o '9'
  if (parseInt(areaCode) <= 30 && phoneNumber.length === 8) {
    phoneNumber = `9${phoneNumber}`;
  }

  // Combina o número no formato final com o código do país sempre presente
  return `${countryCode}${areaCode}${phoneNumber}`;
}

// Função para envio de mensagens
async function sendMessage(
  sender,
  mensagem,
  tipo,
  id,
  userToken,
  id_empresa,
  payload,
  connection_id, // <- importantíssimo
  grupoCache     // grupo-unificado-filiais: cache de grupo passado pelo caller (OWASP MEDIUM-002)
) {
  if (!sender || !mensagem) {
    throw new Error('Os campos "sender" e "mensagem" são obrigatórios.');
  }

  if (!userToken) {
    throw new Error('Token do usuário não encontrado.');
  }

  // normaliza texto e telefone
  mensagem = mensagem.replace(/\\r\\n/g, '\n');
  sender = trataNumero(sender);

  let alreadyUpdated = false;

  async function markAndSet(status, retornoMsg) {
    if (alreadyUpdated) return;
    alreadyUpdated = true;
    await updateEnvioMassa(id, status, retornoMsg, tipo, id_empresa);
  }

  function isSessaoExpirada(resData) {
    if (!resData) return false;
    const errStr = (
      (typeof resData.error === 'string' && resData.error) ||
      (typeof resData.message === 'string' && resData.message) ||
      ''
    ).toLowerCase();
    return errStr.includes('sessão expirada');
  }

  function pickBestTicket(ticketsArray) {
    if (!Array.isArray(ticketsArray) || ticketsArray.length === 0) {
      return null;
    }

    const abertos = ticketsArray.filter(
      t => String(t.status || '').toLowerCase() !== 'closed'
    );

    function score(t) {
      const tUpdated = t.updatedAt || t.createdAt || 0;
      return new Date(tUpdated).getTime();
    }

    if (abertos.length > 0) {
      abertos.sort((a, b) => score(b) - score(a));
      return abertos[0];
    }

    const copia = [...ticketsArray];
    copia.sort((a, b) => score(b) - score(a));
    return copia[0];
  }

  try {
    // ======================================================
    // EMPRESA 6 (whatsmeow) — grupo-unificado-filiais: grupo da Movee
    // ======================================================
    if (await mesmoGrupoQue(id_empresa, 6, grupoCache || {})) { // idReferencia=6 = Movee
      try {
        const sendWhatsMeowRes = await axios.post(
          'https://api.chatmasterveloz.com/api/messages/whatsmeow/sendTextPRO',
          {
            number: sender,
            body: mensagem,
            openTicket: 0
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': userToken
            }
          }
        );

        //await markAndSet('ok', JSON.stringify({
        //  fluxo: 'whatsmeow',
         // resp: sendWhatsMeowRes.data
        //}));
        await markAndSet('ok', 'Mensagem Enviada');

        return { message: 'Mensagem enviada!' };
      } catch (errAlt) {
        const statusCode   = errAlt?.response?.status;
        const responseData = errAlt?.response?.data;
        const errorMessage = errAlt.message;

        await markAndSet(
          'erro',
          'Erro no envio via whatsmeow: ' + JSON.stringify({
            statusCode,
            errorMessage,
            responseData
          })
        );

        throw new Error('Falha envio empresa 6');
      }
    }

    // ======================================================
    // EMPRESAS != 6
    // 1. Envia template oficial
    // 2. Consulta alltickets (GET com body)
    // 3. Filtra por whatsappId === connection_id
    // 4. Envia internal/send
    // ======================================================

    // Passo 1: enviar template oficial
    let sendOfficialRes;
    try {
      sendOfficialRes = await axios.post(
        'https://api.chatmasterveloz.com/api/messages/sendOfficial',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': userToken
          }
        }
      );
    } catch (errSendOfficial) {
      const statusCode   = errSendOfficial?.response?.status;
      const responseData = errSendOfficial?.response?.data;
      const errorMessage = errSendOfficial.message;

      console.error('[sendMessage][ERRO sendOfficial]', JSON.stringify({
        step: 'sendOfficial',
        statusCode,
        responseData,
        sender,
        payload
      }, null, 2));

      if (isSessaoExpirada(responseData)) {
        await markAndSet(
          'erro',
          'Sessão expirada no provedor oficial durante sendOfficial. Reautenticar integração e reenviar.'
        );
        throw new Error('Sessão expirada no provedor oficial (sendOfficial).');
      }

      await markAndSet(
        'erro',
        'Falha em sendOfficial: ' + JSON.stringify({
          statusCode,
          errorMessage,
          responseData
        })
      );
      throw new Error('Falha em sendOfficial');
    }

    // Passo 2: buscar tickets
    let ticketsRes;
    try {
      ticketsRes = await axios({
        method: 'GET',
        url: 'https://api.chatmasterveloz.com/api/contacts/alltickets',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': userToken
        },
        data: {
          number: sender
        }
      });

      console.error('[sendMessage][alltickets OK]', JSON.stringify({
        status: ticketsRes.status,
        qtdTickets: Array.isArray(ticketsRes.data) ? ticketsRes.data.length : 'not-array',
        // log só IDs e whatsappId pra debug
        ticketsSummary: Array.isArray(ticketsRes.data)
          ? ticketsRes.data.map(t => ({
              id: t.id,
              whatsappId: t.whatsappId,
              status: t.status,
              updatedAt: t.updatedAt
            }))
          : ticketsRes.data,
        connection_id_recebida: connection_id
      }, null, 2));

    } catch (errAllTickets) {
      const statusCode   = errAllTickets?.response?.status;
      const responseData = errAllTickets?.response?.data;
      const errorMessage = errAllTickets.message;

      console.error('[sendMessage][ERRO alltickets]', JSON.stringify({
        step: 'alltickets',
        statusCode,
        responseData,
        sender,
        connection_id,
        errorMessage
      }, null, 2));

      if (isSessaoExpirada(responseData)) {
        await markAndSet('ok', JSON.stringify({
          fluxo: 'oficial_somente_template',
          note: 'Template enviado, mas não foi possível consultar ticket (sessão expirada em alltickets).',
          number: sender,
          connection_id,
          officialResp: sendOfficialRes.data
        }));

        return { message: 'Mensagem enviada (sem interação interna).' };
      }

      await markAndSet(
        'erro',
        'Erro ao consultar tickets após envio oficial: ' + JSON.stringify({
          statusCode,
          errorMessage,
          responseData,
          connection_id
        })
      );
      throw new Error('Falha ao obter ticket (alltickets)');
    }

    // Passo 2.1: filtrar tickets por whatsappId === connection_id
    let filteredTickets = [];
    if (Array.isArray(ticketsRes.data)) {
      filteredTickets = ticketsRes.data.filter(t => {
        // comparação robusta:
        // - se connection_id vier number (108) e t.whatsappId vier number (108), bate
        // - se vier como string, a gente normaliza pra string antes de comparar
        return String(t.whatsappId) === String(connection_id);
      });
    } else if (ticketsRes.data && ticketsRes.data.whatsappId !== undefined) {
      if (String(ticketsRes.data.whatsappId) === String(connection_id)) {
        filteredTickets = [ticketsRes.data];
      }
    }

    console.error('[sendMessage][DEBUG filtro whatsappId]', JSON.stringify({
      connection_id_recebida: connection_id,
      filteredCount: filteredTickets.length,
      filteredPreview: filteredTickets.map(t => ({
        id: t.id,
        whatsappId: t.whatsappId,
        status: t.status,
        updatedAt: t.updatedAt
      }))
    }, null, 2));

    // Se nada bateu com connection_id
    if (!filteredTickets.length) {
      await markAndSet('ok', JSON.stringify({
        fluxo: 'oficial_somente_template',
        note: 'Template enviado, mas nenhum ticket corresponde ao whatsappId informado.',
        number: sender,
        connection_id,
        allTicketsSummary: Array.isArray(ticketsRes.data)
          ? ticketsRes.data.map(t => ({
              id: t.id,
              whatsappId: t.whatsappId,
              status: t.status,
              updatedAt: t.updatedAt
            }))
          : ticketsRes.data,
        officialResp: sendOfficialRes.data
      }));

      return { message: 'Mensagem enviada (sem ticket compatível com connection_id).' };
    }

    // Passo 2.2: escolhe melhor ticket dentro dos filtrados
    const escolhido = pickBestTicket(filteredTickets);

    let ticketId = null;
    let ticketStatus = null;

    if (escolhido && escolhido.id) {
      ticketId = escolhido.id;
      ticketStatus = escolhido.status;
    }

    if (!ticketId) {
      await markAndSet(
        'ok',
        JSON.stringify({
          fluxo: 'oficial_somente_template',
          note: 'Template enviado, mas não foi possível determinar ticketId mesmo após filtrar por whatsappId.',
          number: sender,
          connection_id,
          filteredCount: filteredTickets.length,
          officialResp: sendOfficialRes.data
        })
      );

      return { message: 'Mensagem enviada (ticket filtrado inválido).' };
    }

    // Passo 3: mandar mensagem interna associada ao ticketId selecionado
    try {
      const internalSendRes = await axios.post(
        'https://api.chatmasterveloz.com/api/messages/internal/send',
        {
          ticketId: ticketId,
          body: mensagem
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': userToken
          }
        }
      );

      await markAndSet('ok', JSON.stringify({
        fluxo: 'oficial_com_ticket',
        number: sender,
        connection_id,
        ticketId,
        ticketStatus,
        officialResp: sendOfficialRes.data,
        internalResp: internalSendRes.data
      }));

      return { message: 'Mensagem enviada com interação interna!' };

    } catch (errInternalSend) {
      const statusCode   = errInternalSend?.response?.status;
      const responseData = errInternalSend?.response?.data;
      const errorMessage = errInternalSend.message;

      console.error('[sendMessage][ERRO internal/send]', JSON.stringify({
        step: 'internalSend',
        statusCode,
        responseData,
        sender,
        connection_id,
        ticketId,
        ticketStatus,
        errorMessage
      }, null, 2));

      if (isSessaoExpirada(responseData)) {
        await markAndSet('ok', JSON.stringify({
          fluxo: 'oficial_template_ticket_sem_internal',
          note: 'Template enviado e ticket localizado, mas sessão expirada ao enviar mensagem interna.',
          number: sender,
          connection_id,
          ticketId,
          ticketStatus,
          officialResp: sendOfficialRes.data
        }));

        return { message: 'Mensagem enviada (ticket encontrado, sem internal).' };
      }

      await markAndSet(
        'erro',
        'Erro ao enviar mensagem interna: ' + JSON.stringify({
          statusCode,
          errorMessage,
          responseData,
          connection_id,
          ticketId,
          ticketStatus
        })
      );

      throw new Error('Falha ao enviar mensagem interna');
    }

  } catch (err) {
    if (!alreadyUpdated) {
      await updateEnvioMassa(
        id,
        'erro',
        'Erro no envio (fallback final): ' + err.message,
        tipo,
        id_empresa
      );
      alreadyUpdated = true;
    }

    console.error('[sendMessage][CATCH FINAL]', err.message);
    throw err;
  }
}

async function updateEnvioMassa(id, enviado, mensagem, tipo, idEmp) {
    if (!id) {
        throw new Error('O campo "id" é obrigatório.');
    }
    if (!idEmp) {
        throw new Error('O campo "idEmp" é obrigatório para atualização segura.');
    }

    // Montar o corpo da atualização dinamicamente
    const updateData = {};
    if (tipo === "men1") {
        if (enviado) updateData.enviado = enviado;
        if (mensagem) updateData.retorno_envio_msg_1 = mensagem;
    } else if (tipo === "men2") {
        if (enviado) updateData.enviado = enviado;
        if (mensagem) updateData.retorno_envio_msg_2 = mensagem;
    }

    console.log(`Atualizando o registro ${id} (empresa ${idEmp}) com os dados:`, updateData);

    // FR-013: filtro composto id+id_empresa previne IDOR (OWASP API4:2023).
    // PostgREST não toca linha que não casa ambos os filtros — ownership atômico.
    const response = await postgrestRequest(`EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`, 'PATCH', updateData);

    // Verificar se houve erro na atualização
    if (response.error) {
        console.error('Erro ao atualizar registro no PostgREST:', response.code);
        throw new Error('Erro ao atualizar o registro.');
    }

    return response; // Retorna a resposta do PostgREST
}

// Endpoint para atualizar a tabela EnvioMassa
// FR-013 / movimento-por-filial: empresa_id vem do body; resolveEmpresaAlvo valida escopo (403).
// migrar-cnpj-motorista: estendido com suporte a cnpj_prestador — ordem [A]..[H] do contrato.
// Filtro composto id+id_empresa na query PostgREST fecha o IDOR (OWASP API4:2023 / CWE-862):
// se o registro não pertencer à empresa-alvo, PostgREST retorna [] — respondemos 404.
app.patch('/update-envio-massa/:id', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.criar'), async (req, res) => {
    const { id } = req.params;
    const { enviado, mensagem, tipo } = req.body;

    // [A] Resolver e validar empresa-alvo (403 se fora do escopo)
    let idEmp;
    try {
        idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'PATCH /update-envio-massa/:id');
    } catch (err) {
        return res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    }

    // Verificar se há mudança de CNPJ solicitada
    const cnpjRaw = req.body.cnpj_prestador;
    const hasCnpjChange = cnpjRaw !== undefined && cnpjRaw !== null && cnpjRaw !== '';

    try {
        if (hasCnpjChange) {
            // [B] Validar cnpjNovo
            const cnpjNovo = onlyDigits(cnpjRaw);
            if (!isCNPJ14(cnpjNovo)) {
                return res.status(400).json({ error: 'CNPJ inválido — deve conter 14 dígitos.' });
            }

            // [C] Buscar movimento atual escopado (ownership atômico anti-IDOR)
            const movimentos = await postgrestRequest(
                `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}&select=cnpj_prestador`
            );
            if (!Array.isArray(movimentos) || movimentos.length === 0) {
                return res.status(404).json({ error: 'Movimento não encontrado.' });
            }
            const cnpjAntigo = onlyDigits(movimentos[0].cnpj_prestador);

            // [D] Idempotência: CNPJ não muda → pular lógica de CNPJ
            if (cnpjNovo !== cnpjAntigo) {
                // [E] GATE DE GRUPO (SEC-03, guard-clause OBRIGATÓRIA antes de [E1])
                // Empresa fora do grupo Movee nunca acessa Motorista
                const _cnpjCache = {};
                const isMoveeGroup = await mesmoGrupoQue(idEmp, 6, _cnpjCache);

                if (isMoveeGroup) {
                    // [E1] PRÉ-CHECK 409 + [F-Motorista] — dentro da função migrarCnpjMotorista
                    // [F] PATCH em lote dos movimentos primeiro (FR-010: Motorista SÓ após movimentos OK)
                    const patchLote = await postgrestRequest(
                        `EnvioMassa?id_empresa=eq.${idEmp}&cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
                        'PATCH',
                        { cnpj_prestador: cnpjNovo }
                    );
                    if (patchLote && patchLote.error) {
                        console.error('[PATCH /update-envio-massa] Erro no lote de movimentos:', patchLote.code);
                        return res.status(500).json({ error: 'Erro ao atualizar movimentos em lote.' });
                    }

                    // [F-Motorista] migrar CNPJ na base Motorista (SÓ após movimentos OK — FR-010)
                    const migResult = await migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmp, _cnpjCache);
                    if (migResult.conflict) {
                        return res.status(409).json({ error: 'CNPJ já cadastrado para outro motorista.' });
                    }
                    if (migResult.error) {
                        // FR-011: falha parcial pós-movimentos → 500, sem reverter
                        console.error('[PATCH /update-envio-massa] Falha parcial em migrarCnpjMotorista (movimentos já atualizados):', migResult.error && migResult.error.message ? migResult.error.message : String(migResult.error));
                        return res.status(500).json({ error: 'Movimentos atualizados, mas falha ao migrar base do motorista.' });
                    }
                } else {
                    // Fora do grupo Movee: só atualiza movimentos, não toca Motorista (FR-013)
                    const patchLote = await postgrestRequest(
                        `EnvioMassa?id_empresa=eq.${idEmp}&cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
                        'PATCH',
                        { cnpj_prestador: cnpjNovo }
                    );
                    if (patchLote && patchLote.error) {
                        console.error('[PATCH /update-envio-massa] Erro no lote de movimentos (fora do grupo):', patchLote.code);
                        return res.status(500).json({ error: 'Erro ao atualizar movimentos em lote.' });
                    }
                }
            }
            // CNPJ igual (idempotência) ou já processado: cai para [G]
        }

        // [G] PATCH demais campos do movimento editado (enviado/men1/men2/tipo) — não-regressão
        const result = await updateEnvioMassa(id, enviado, mensagem, tipo, idEmp);

        // PostgREST retorna [] em DOIS casos distintos: (a) nenhuma linha casou o filtro
        // (id/empresa errados — "não encontrado"); (b) o update foi VAZIO porque o body não
        // trazia enviado/men1/men2 — caso típico de edição SÓ de CNPJ. Logo, [] sozinho NÃO
        // significa "não encontrado".
        if (Array.isArray(result) && result.length === 0) {
            // Se houve mudança de CNPJ, o movimento já foi confirmado em [C] e processado em
            // [F]/[F-Motorista]: não é 404, apenas não havia outros campos a gravar → 200.
            if (hasCnpjChange) {
                return res.json({ message: 'Registro atualizado com sucesso!' });
            }
            return res.status(404).json({ error: 'Registro não encontrado ou não pertence à empresa.' });
        }

        // [H] Resposta 200
        res.json({ message: 'Registro atualizado com sucesso!', data: result });
    } catch (error) {
        console.error('Erro ao atualizar o registro:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para deletar registro da tabela EnvioMassa
app.delete('/envio-massa/:id', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.aprovar'), async (req, res) => {
    const { id } = req.params;

    // movimento-por-filial: empresa_id pode vir via query string
    let idEmp;
    try {
      idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'DELETE /envio-massa/:id');
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    }

    try {
        const result = await postgrestRequest(
            `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`,
            'DELETE'
        );
        res.json({ message: 'Registro deletado com sucesso!' });
    } catch (error) {
        console.error('Erro ao deletar o registro:', error.message);
        res.status(500).json({ error: error.message });
    }
});

function toNumberBR(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const raw = String(input ?? '').trim();
  if (!raw) return NaN;

  const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/\s+/g, '');
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;
  if (hasComma && hasDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.'); // ponto = milhar, vírgula = decimal
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.'); // vírgula como decimal
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

// parseGorjeta — converte valor bruto da planilha em número ou null.
// "R$ 22,00" → 22.00 | "R$ -" / vazio / undefined / 0 → null
// Não lança exceção — falha silenciosa retorna null (FR-003 / CL-001 / CL-004).
function parseGorjeta(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === 'R$ -' || s === '-') return null;
  const n = toNumberBR(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return parseFloat(n.toFixed(2));
}

function formatBRL(valueNumber) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valueNumber);
}

function _toDateFromAny(input) {
  if (input == null) return null;

  // Já é Date?
  if (input instanceof Date && !isNaN(input)) return input;

  // Número (segundos ou milissegundos)
  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input; // 10 dígitos => s, 13 => ms
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }

  // String
  const raw = String(input).trim();
  if (!raw) return null;

  // String numérica -> trata como epoch (s/ms)
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }

  // ISO/legível por Date.parse
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return isNaN(d) ? null : d;
  }

  return null;
}

function _formatDateDDMMYYYY(date, tz = 'America/Sao_Paulo') {
  if (!(date instanceof Date) || isNaN(date)) return null;

  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(date);

  const dd = parts.find(p => p.type === 'day')?.value ?? '';
  const mm = parts.find(p => p.type === 'month')?.value ?? '';
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '';
  return dd && mm && yyyy ? `${dd}/${mm}/${yyyy}` : null;
}

/**
 * Converte timestamps (segundos/ms), ISO strings ou Date
 * para "DD/MM/AAAA" no fuso America/Sao_Paulo.
 * Retorna string vazia se não conseguir converter.
 */
function toDDMMYYYY(input, tz = 'America/Sao_Paulo') {
  const d = _toDateFromAny(input);
  const s = _formatDateDDMMYYYY(d, tz);
  return s ?? '';
}


// Função para processar envio de mensagens em lote
async function processBatchMessages(empresaId, userToken, connection_id) {
    try {
        const data = await postgrestRequest(`EnvioMassa?id_empresa=eq.${empresaId}&mov_fechado=eq.false`, 'GET');

        if (!data || data.length === 0) {
            throw new Error('Nenhum registro encontrado para processamento.');
        }

        // grupo-unificado-filiais: cache de grupo por batch — declarado fora do loop,
        // redeclarado a cada invocação de processBatchMessages (escopo de ciclo).
        // Caller passa como 3º arg em mesmoGrupoQue — sem default object (OWASP MEDIUM-002).
        const _grupoCache = {};

        for (const item of data) {
            // Verifica o estado do processo no banco antes de cada iteração
            const processStatus = await postgrestRequest(`ProcessControl?user_id=eq.${empresaId}`, 'GET');
            if (processStatus[0]?.status !== 'active') {
                console.log('Processamento interrompido pelo backend.');
                break; // Interrompe o loop se o status for "inactive"
            }

            try {
                if (item.enviado === 'off') {
                    let waitTime = Math.floor(Math.random() * 5) + 1;

                    if (!(await mesmoGrupoQue(item.id_empresa, 6, _grupoCache))) { // idReferencia=6 = Movee
                        const valorNum = toNumberBR(item.valor);
                        if (!Number.isFinite(valorNum)) {
                            throw new Error(`Valor inválido para item.nome=${item.nome}: "${item.valor}"`);
                        }
                        const valorBRL = formatBRL(valorNum);

                        let payload = {
                                          number: String(trataNumero(item.number)),
                                          name: 'template_emissao_nf_com_button',
                                          language: 'pt_BR',
                                          template: [
                                            { type: 'text', parameter_name: 'variavel 1', text: item.nome },
                                            { type: 'text', parameter_name: 'variavel 2', text: item.cnpj_tomador },
                                            { type: 'text', parameter_name: 'variavel 3', text: valorBRL }
                                          ]
                                        };
                        //console.log(JSON.stringify(payload, null, 2));
                        // Aguarda antes do envio
                        await new Promise(resolve => setTimeout(resolve, 2 * 1000));                    

                        // Primeiro envio
                        await sendMessage(trataNumero(item.number), item.mensagem1, 'men1', item.id, userToken, item.id_empresa, payload, connection_id, _grupoCache);
                    }else{
                        // Aguarda antes do envio
                        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

                        // Primeiro envio
                        await sendMessage(trataNumero(item.number), item.mensagem1, 'men1', item.id, userToken, item.id_empresa, '', '', _grupoCache);
                    }

                    waitTime = Math.floor(Math.random() * 3) + 1;
                    // Segundo envio (se aplicável)
                    
                    // Comentado Para Não Enviar a segunda mensagem para nenhuma empresa alterado o id da empresa para 16
                    if (item.id_empresa === 16) {

                        const dtInicialBR = toDDMMYYYY(item.dt_inicial);
                        const dtFinalBR   = toDDMMYYYY(item.dt_final);

                        payload = {
                                  number: String(trataNumero(item.number)),
                                  name: 'template_modelo_descricao_servico_nf',
                                  language: 'pt_BR',
                                  template: [
                                    { type: 'text', parameter_name: 'variavel 1', text: dtInicialBR },
                                    { type: 'text', parameter_name: 'variavel 2', text: dtFinalBR }
                                  ]
                              };
                        //console.log(JSON.stringify(payload, null, 2));
                        await new Promise(resolve => setTimeout(resolve, 2 * 1000));
                        await sendMessage(trataNumero(item.number), item.mensagem2, 'men2', item.id, userToken, item.id_empresa, payload, connection_id, _grupoCache);
                    }
                }
            } catch (error) {
                console.error('Erro ao processar item:', item.number, error.message, userToken);
            }
        }

        // Atualiza o status para inativo após concluir o processamento
        await updateProcessControl(empresaId, 'inactive');
        console.log('Processamento concluído com sucesso.');
    } catch (error) {
        await updateProcessControl(empresaId, 'inactive');
        console.error('Erro no processamento em lote:', error.message);
        throw new Error('Erro ao processar mensagens em lote.');
    }
}

// Função para gerenciar o status do processo no banco
async function updateProcessControl(userId, status, executionId = null) {
    const existingProcess = await postgrestRequest(`ProcessControl?user_id=eq.${userId}`, 'GET');

    if (existingProcess.length === 0) {
        // Registro não existe, cria um novo
        console.log(`Nenhum registro encontrado para o usuário ${userId}. Criando novo...`);
        const data = {
            user_id: userId,
            status: status,
            execution_id: executionId,
            timestamp: new Date().toISOString()
        };

        const response = await postgrestRequest('ProcessControl', 'POST', data);

        if (response.error) {
            console.error('Erro ao criar novo registro no ProcessControl:', response.error);
            throw new Error('Erro ao criar novo registro no ProcessControl.');
        }

        return response;
    } else {
        // Registro existe, atualiza o status
        console.log(`Registro encontrado para o usuário ${userId}. Atualizando...`);
        const data = {
            status,
            execution_id: executionId
        };

        const response = await postgrestRequest(`ProcessControl?user_id=eq.${userId}`, 'PATCH', data);

        if (response.error) {
            console.error('Erro ao atualizar registro no ProcessControl:', response.error);
            throw new Error('Erro ao atualizar registro no ProcessControl.');
        }

        return response;
    }
}

// Endpoint para iniciar o processo
app.post('/start-process', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.enviar'), async (req, res) => {
    try {
        const userId = req.user.empresaId;

        console.log('Esse é os dados do user:', userId);

        // Atualiza o status do processo para ativo
        await updateProcessControl(userId, 'active');
        console.log(`Processo marcado como ativo para o usuário: ${userId}`);

        // Chama o processamento em lote diretamente
        await processBatchMessages(userId, req.user.tk, req.user.connection_id);

        res.json({ message: 'Processo iniciado com sucesso!' });
    } catch (error) {
        await updateProcessControl(req.user.empresaId, 'inactive');
        console.error('Erro ao iniciar o processo:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para verificar o status do processo
app.get('/process-status', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.consultar'), async (req, res) => {
    try {
        const userId = req.user.empresaId;

        const response = await postgrestRequest(`ProcessControl?user_id=eq.${userId}`, 'GET');
        if (response.length === 0 || response[0].status !== 'active') {
            console.log('Nenhum processo em andamento ou interrompido!');
            return res.json({ active: false });
        }

        res.json({ active: true, execution_id: response[0].execution_id });
    } catch (error) {
        console.error('Erro ao verificar o status do processo:', error.message);
        res.status(500).json({ error: error.message });
    }
});


app.post('/stop-process', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.enviar'), async (req, res) => {
    try {
        const userId = req.user.empresaId;

        // Atualiza o status do processo no banco
        await updateProcessControl(userId, 'inactive');

        console.log(`Processo interrompido para o usuário: ${userId}`);
        res.json({ message: 'Processo parado com sucesso!' });
    } catch (error) {
        console.error('Erro ao parar o processo:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const currencyFormatterBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

const isCNPJ14 = (digits) => /^\d{14}$/.test(digits);

const maskCNPJ = (digits14) =>
  digits14.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

// ──────────────────────────────────────────────────────────────────────────────
// cadastro-motorista-base-validada (frente A): o upload do movimento popula a
// base curada "Motorista" (pré-cadastro: nome+CNPJ, SEM senha). O motorista só
// "ativa" o acesso definindo a senha em /motorista/register.
//
// Contrato:
//   - Para cada cnpj_prestador distinto do lote, garante uma linha em Motorista.
//   - Não existe → INSERT { cnpj_prestador, nome, ativo:true } (senha NULL).
//   - Existe     → NUNCA toca senha; atualiza `nome` só se estiver vazio
//                  (decisão §6.4 — não sobrescrever curadoria do CRUD).
//   - Best-effort: NUNCA lança. O movimento em EnvioMassa é o dado primário;
//     uma falha aqui é logada e ignorada (não derruba o upload).
// ──────────────────────────────────────────────────────────────────────────────
async function upsertMotoristasFromLote(rows) {
  try {
    // cnpj (14 dígitos) -> primeiro nome não-vazio observado no lote
    const porCnpj = new Map();
    for (const r of (rows || [])) {
      const cnpj = onlyDigits(r && r.cnpj_prestador);
      if (!isCNPJ14(cnpj)) continue;
      const nome = String((r && r.nome) || '').trim();
      if (!porCnpj.has(cnpj)) {
        porCnpj.set(cnpj, nome);
      } else if (!porCnpj.get(cnpj) && nome) {
        porCnpj.set(cnpj, nome);
      }
    }
    if (porCnpj.size === 0) return { ok: true, criados: 0 };

    const cnpjs = [...porCnpj.keys()];

    // Quais CNPJs já existem em Motorista (e com que nome).
    // EM LOTES: o filtro `in.(...)` vai inteiro na URL e cada CNPJ ocupa ~23 chars
    // codificados; um upload grande (centenas de CNPJs) estourava o limite de header
    // do PostgREST → "Parse Error: Header overflow" → o GET lançava ANTES do INSERT e
    // nenhum motorista era cadastrado. Paginar em fatias de 100 mantém a URL ~2,3 KB.
    const CHUNK_IN = 100;
    const existentes = new Map();
    for (let i = 0; i < cnpjs.length; i += CHUNK_IN) {
      const fatia = cnpjs.slice(i, i + CHUNK_IN);
      const lista = fatia.map((c) => `"${c}"`).join(',');
      const parte = await postgrestRequest(
        `Motorista?cnpj_prestador=in.(${encodeURIComponent(lista)})&select=cnpj_prestador,nome`
      );
      for (const m of (parte || [])) existentes.set(m.cnpj_prestador, m);
    }

    // Inserir os ausentes — pré-cadastro sem senha
    const novos = cnpjs
      .filter((c) => !existentes.has(c))
      .map((c) => ({ cnpj_prestador: c, nome: porCnpj.get(c) || null, ativo: true }));
    if (novos.length > 0) {
      await postgrestRequest('Motorista', 'POST', novos);
      console.error(`[UPLOAD][MOTORISTA] ${novos.length} pré-cadastro(s) criado(s) na base Motorista.`);
    } else {
      console.error('[UPLOAD][MOTORISTA] Nenhum pré-cadastro novo (todos os CNPJs do lote já existem em Motorista).');
    }

    // Atualizar nome apenas quando o existente está vazio (não sobrescreve CRUD)
    for (const c of cnpjs) {
      const existente = existentes.get(c);
      const nomeNovo = porCnpj.get(c);
      const nomeAtualVazio = !existente || !(existente.nome && String(existente.nome).trim());
      if (existente && nomeNovo && nomeAtualVazio) {
        await postgrestRequest(
          `Motorista?cnpj_prestador=eq.${encodeURIComponent(c)}`,
          'PATCH',
          { nome: nomeNovo }
        );
      }
    }
    return { ok: true, criados: novos.length };
  } catch (err) {
    // err.status / err.body vêm de postgrestRequest (corpo real do PostgREST — ex.:
    // "null value in column \"senha\" violates not-null" quando a migração 008 não
    // foi aplicada/recarregada). Logamos status+body explícitos para diagnóstico, e
    // RETORNAMOS o erro para que o /upload possa avisar (movimento sempre preservado).
    console.error(
      '[UPLOAD][MOTORISTA] Falha no upsert da base Motorista (movimento preservado) —',
      'status=', err && err.status, 'body=', (err && err.body) || (err && err.message)
    );
    return { ok: false, erro: (err && err.body) || (err && err.message) || String(err) };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// migrar-cnpj-motorista: migra o CNPJ de um motorista na base Motorista.
//
// Contrato (contracts/patch-update-envio-massa.md §Função migrarCnpjMotorista):
//
//   Gate de grupo ([E] na rota): SOMENTE chamada quando mesmoGrupoQue já passou.
//   A função NÃO re-verifica o grupo — o gate pertence à rota (SEC-03, FR-013).
//
//   Algoritmo:
//     1. PRÉ-CHECK 409 [E1]: Motorista?cnpj_prestador=eq.{cnpjNovo} existe? → { conflict: true }
//     2. Buscar Motorista?cnpj_prestador=eq.{cnpjAntigo}
//        - Existe  → PATCH preservando id/nome/senha/ativo: { cnpj_prestador: cnpjNovo }
//        - Ausente → POST pré-cadastro { cnpj_prestador: cnpjNovo, nome: '', ativo: true }
//          (senha NULL — motorista define via /motorista/register)
//     3. Violação UNIQUE no POST → { conflict: true }  (SEC-04 — TOCTOU atômico)
//     4. Qualquer outra falha → { error }  (FR-011: log sem objeto Motorista completo — SEC-05)
//
//   Retornos:
//     { ok: true }       — migração concluída
//     { skipped: true }  — (reservado; gate de grupo pertence à rota, não aqui)
//     { conflict: true } — cnpjNovo já existe em Motorista (409 na rota)
//     { error: <Error> } — falha inesperada (500 na rota + log)
// ──────────────────────────────────────────────────────────────────────────────
async function migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmpresa, cache) {
  try {
    // [E1] PRÉ-CHECK 409: cnpjNovo já tem motorista cadastrado?
    const existeNovo = await postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNovo)}&select=cnpj_prestador`
    );
    if (Array.isArray(existeNovo) && existeNovo.length > 0) {
      return { conflict: true };
    }

    // Buscar motorista com o CNPJ antigo
    const existeAntigo = await postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}&select=cnpj_prestador,nome,ativo`
    );

    if (Array.isArray(existeAntigo) && existeAntigo.length > 0) {
      // Motorista antigo existe → PATCH preservando nome/ativo (nunca toca senha)
      await postgrestRequest(
        `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjAntigo)}`,
        'PATCH',
        { cnpj_prestador: cnpjNovo }
      );
      // Observabilidade: log de sucesso (SEC-05: só CNPJs, nunca o objeto Motorista/senha)
      console.log(`[UPDATE][MOTORISTA] migrou ${cnpjAntigo}->${cnpjNovo} (grupo Movee)`);
    } else {
      // Motorista antigo ausente → pré-cadastro sem senha
      try {
        await postgrestRequest(
          'Motorista',
          'POST',
          { cnpj_prestador: cnpjNovo, nome: '', ativo: true }
        );
        // Observabilidade: log de sucesso (SEC-05: só CNPJ, nunca senha)
        console.log(`[UPDATE][MOTORISTA] pré-cadastro criado para ${cnpjNovo} (grupo Movee)`);
      } catch (postErr) {
        // SEC-04: violação UNIQUE (code 23505) no POST → conflict, não 500
        if (
          postErr && (
            (postErr.code === '23505') ||
            (postErr.message && postErr.message.includes('23505')) ||
            (postErr.message && postErr.message.toLowerCase().includes('unique'))
          )
        ) {
          return { conflict: true };
        }
        throw postErr;
      }
    }

    return { ok: true };
  } catch (err) {
    // SEC-05: nunca logar objeto Motorista completo (contém hash de senha)
    console.error('[migrarCnpjMotorista] erro:', err && err.message ? err.message : String(err));
    return { error: err };
  }
}

function pad2(n){ return String(n).padStart(2,'0'); }

// Excel serial -> Date (UTC, evita deslocamento por fuso local do servidor)
function excelSerialToUTCDate(serial) {
  const epoch = Date.UTC(1899, 11, 30); // 1899-12-30
  const ms = Math.round(Number(serial) * 86400000);
  return new Date(epoch + ms);
}

// Epoch -> Date
function epochToDate(n) {
  const ms = n < 1e12 ? n * 1000 : n; // 10 dígitos => s, 13 => ms
  return new Date(ms);
}

// Converte várias entradas para um objeto Date (usado apenas para extrair Y/M/D)
function parseToDate(input) {
  if (input == null) return null;

  if (input instanceof Date && !isNaN(input)) return input;

  const s = String(input).trim();
  if (!s) return null;

  // Numérico puro => pode ser serial Excel OU epoch s/ms
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // serial Excel costuma ser > 20000 e < 1000000
    const d = (n > 20000 && n < 1000000) ? excelSerialToUTCDate(n) : epochToDate(n);
    return isNaN(d) ? null : d;
  }

  // dd/mm/aaaa (ignora hora se houver)
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (m1) {
    const [, dd, mm, yyyy] = m1;
    const y = Number(yyyy), m = Number(mm), d = Number(dd);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      // cria como UTC para extrair Y/M/D estáveis
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    }
    return null;
  }

  // ISO/parsável
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return isNaN(d) ? null : d;
  }

  return null;
}

// Obtém o offset para America/Sao_Paulo naquele dia (usa 12:00 UTC para evitar bordas de DST)
function getTZOffsetForDate(y, m, d, tz = 'America/Sao_Paulo') {
  try {
    const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset', // "GMT-03:00" (Node 18+). Fallback abaixo.
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(noonUTC);
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-03:00';
    // Extrai ±HH[:MM]
    const mOff = tzName.match(/([+-]\d{1,2})(?::?(\d{2}))?/);
    if (mOff) {
      const sign = mOff[1].startsWith('-') ? '-' : '+';
      const hh = mOff[1].replace('+','').replace('-','').padStart(2,'0');
      const mm = (mOff[2] || '00').padStart(2,'0');
      return `${sign}${hh}:${mm}`;
    }
  } catch(_) { /* ignore */ }
  return '-03:00'; // fallback seguro p/ Brasil hoje
}

/**
 * Converte entrada (serial Excel, Date, epoch s/ms, dd/mm/aaaa, ISO)
 * para timestamptz "YYYY-MM-DDT00:00:00-03:00" (offset dinâmico do dia em São Paulo).
 */
function toTimestamptzMidnightSP(input) {
  const d = parseToDate(input);
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const offset = getTZOffsetForDate(y, m, day, 'America/Sao_Paulo');
  return `${y}-${pad2(m)}-${pad2(day)}T03:00:00${offset}`;
}

// Rota de Upload de arquivo
app.post('/upload', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.criar'), upload.single('file'), async (req, res) => {
  try {
    console.error('[UPLOAD] >>> Início da rota /upload');

    // ---- Autenticação / sanity check ----
    if (!req.user || !req.user.empresaId) {
      console.error('[UPLOAD] Falha: req.user ou empresaId ausente:', req.user);
      return res.status(401).json({
        success: false,
        message: 'Não autenticado ou empresaId ausente no token.'
      });
    }
    // movimento-por-filial: empresa_id pode vir como campo multipart
    let idEmp;
    try {
      idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'POST /upload');
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
    }
    const empresaId = idEmp; // mantém compatibilidade com ramos que usam empresaId abaixo
    console.error('[UPLOAD] idEmp:', idEmp);

    // ---- Verifica se veio arquivo ----
    if (!req.file) {
      console.error('[UPLOAD] Nenhum arquivo recebido');
      return res.status(400).json({ success: false, message: 'Arquivo não enviado!' });
    }

    // ---- Validação do range de datas (import-range-datas: lida UMA vez, aplicada a TODAS as linhas) ----
    // Fonte única das datas: range informado pelo operador na UI (não mais as colunas da planilha).
    const dtInicialRaw = String(req.body.dt_inicial ?? '').trim();
    const dtFinalRaw   = String(req.body.dt_final   ?? '').trim();

    if (!dtInicialRaw) {
      return res.status(400).json({ success: false, message: 'dt_inicial é obrigatório para o import.' });
    }
    if (!dtFinalRaw) {
      return res.status(400).json({ success: false, message: 'dt_final é obrigatório para o import.' });
    }

    const dtIniTS = toTimestamptzMidnightSP(dtInicialRaw);
    const dtFimTS = toTimestamptzMidnightSP(dtFinalRaw);

    if (!dtIniTS) {
      return res.status(400).json({ success: false, message: 'dt_inicial inválido (formato esperado: DD/MM/YYYY).' });
    }
    if (!dtFimTS) {
      return res.status(400).json({ success: false, message: 'dt_final inválido (formato esperado: DD/MM/YYYY).' });
    }
    if (dtIniTS > dtFimTS) {
      return res.status(400).json({ success: false, message: 'dt_inicial deve ser menor ou igual a dt_final.' });
    }
    // dtIniTS e dtFimTS são os valores a aplicar em TODAS as linhas do lote (semântica meia-noite SP preservada).

    // ---- Lê planilha ----
    const filePath = path.join(__dirname, req.file.path);
    console.error('[UPLOAD] Lendo arquivo XLSX em:', filePath);

    let workbook;
    try {
      workbook = xlsx.readFile(filePath);
    } catch (e) {
      console.error('[UPLOAD] Erro ao ler XLSX:', e);
      return res.status(400).json({
        success: false,
        message: 'Arquivo inválido. Não foi possível ler a planilha.',
        detail: e.message
      });
    }

    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) {
      console.error('[UPLOAD] Planilha sem abas');
      return res.status(400).json({
        success: false,
        message: 'A planilha não possui abas.'
      });
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);
    console.error('[UPLOAD] Linhas lidas da planilha:', rows.length);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[UPLOAD] Planilha vazia');
      return res.status(400).json({
        success: false,
        message: 'A planilha está vazia.'
      });
    }

    // ---- Validação linha a linha ----
    const errors = [];
    const dataToInsert = [];

    rows.forEach((row, idx) => {
      const rowErrors = [];

      // number (telefone)
      let numberRaw = row.number ? row.number.toString().replace(/-/g, '').replace(/\s/g, '') : '';
      let number;
      try {
        number = trataNumero(numberRaw.toString());
      } catch (e) {
        rowErrors.push(`number inválido: ${e.message || e}`);
      }

      // cnpj_tomador — obrigatório COM MÁSCARA ##.###.###/####-##
      const cnpjTomDigits = onlyDigits(row.cnpj_tomador);
      if (!isCNPJ14(cnpjTomDigits)) {
        rowErrors.push('cnpj_tomador inválido (deve conter 14 dígitos).');
      }
      const cnpj_tomador = isCNPJ14(cnpjTomDigits) ? maskCNPJ(cnpjTomDigits) : '';

      // nome — obrigatório
      const nome = String(row.nome ?? '').trim();
      if (!nome) {
        rowErrors.push('nome é obrigatório.');
      }

      // valor — obrigatório e numérico
      const valorNum = toNumberBR(row.valor);
      if (!Number.isFinite(valorNum)) {
        rowErrors.push('valor é obrigatório e deve ser numérico.');
      }
      const valor = Number.isFinite(valorNum) ? valorNum.toFixed(2) : null; // "99.99"

      // enviado — default "off"
      const enviado = String(row.enviado ?? '').trim() || 'off';

      // import-range-datas: datas vêm do range único do handler (dtIniTS/dtFimTS),
      // aplicado a TODAS as linhas. As colunas dt_inicial/dt_final da planilha são ignoradas.

      // cnpj_prestador — obrigatório sem máscara, 14 dígitos
      const cnpjPrestDigits = onlyDigits(row.cnpj_prestador);
      if (!isCNPJ14(cnpjPrestDigits)) {
        rowErrors.push('cnpj_prestador inválido (deve conter 14 dígitos).');
      }
      const cnpj_prestador = cnpjPrestDigits;

      // gorjeta — opcional, não bloqueia upload (FR-003 / CL-004)
      // "R$ 22,00" → 22.00 | "R$ -" / vazio / undefined → null
      const gorjeta = parseGorjeta(row.gorjeta);

      // Se essa linha deu erro, acumula e NÃO adiciona pra inserir
      if (rowErrors.length) {
        errors.push({
          rowIndex: idx + 2, // linha visível no Excel (cabeçalho = 1)
          errors: rowErrors,
          preview: row
        });
        return;
      }

      dataToInsert.push({
        number,
        nome,
        valor,
        gorjeta,
        mensagem1: row.mensagem1,
        mensagem2: row.mensagem2,
        enviado,
        retorno_envio_msg_1: row.retorno_envio_msg_1,
        retorno_envio_msg_2: row.retorno_envio_msg_2,
        tribnac: row.tribnac,
        cnpj_tomador,
        cnpj_prestador,
        dCompet: row.dCompet,
        numnota: row.numnota,
        nota_ok: row.nota_ok,
        data_emissao: row.data_emissao,
        erro_validacao: row.erro_validacao,
        uuid: row.uuid,
        dt_inicial: dtIniTS,
        dt_final: dtFimTS,
        id_empresa: idEmp
      });
    });

    // ---- Se houver qualquer erro de validação, loga no container e retorna 400 ----
    if (errors.length > 0) {
      // log resumo
      console.error('[UPLOAD][VALIDACAO] Falhou validação.');
      console.error('[UPLOAD][VALIDACAO] Total de linhas inválidas:', errors.length);

      // log até as 10 primeiras linhas problemáticas
      const sample = errors.slice(0, 10);
      console.error(
        '[UPLOAD][VALIDACAO] Amostra de erros (máx 10):\n' +
        JSON.stringify(sample, null, 2)
      );

      // Se quiser despejar tudo no log, descomenta:
      // console.error('[UPLOAD][VALIDACAO] TODOS OS ERROS:\n' + JSON.stringify(errors, null, 2));

      return res.status(400).json({
        success: false,
        message: 'Erros de validação encontrados. Nenhum registro foi inserido.',
        errors
      });
    }

    // ---- Se passou validação mas não sobrou dado útil ----
    if (dataToInsert.length === 0) {
      console.error('[UPLOAD] Após validação, 0 linhas válidas.');
      return res.status(400).json({
        success: false,
        message: 'Nenhuma linha válida para inserção após validação.'
      });
    }

    // ---- Insert no PostgREST ----
    console.error(`[UPLOAD] Inserindo ${dataToInsert.length} registro(s) em EnvioMassa…`);
    console.error('[UPLOAD] Primeira linha preparada:', JSON.stringify(dataToInsert[0], null, 2));

    const response = await postgrestRequest('EnvioMassa', 'POST', dataToInsert);

    console.error('[UPLOAD] Resposta postgrestRequest:', JSON.stringify(response, null, 2));

    if (response?.error) {
      console.error('[UPLOAD] PostgREST retornou erro explícito:', response.error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao inserir dados.',
        detail: response.error
      });
    }

    // cadastro-motorista-base-validada (frente A): popular/curar a base "Motorista"
    // a partir deste lote (best-effort — não derruba o upload se falhar).
    // base-motorista-grupo-movee: a base "Motorista" (login + validação do app motorista)
    // é EXCLUSIVA do grupo Movee (empresa 6 + filiais). Só cura a base quando o upload é
    // de uma empresa do grupo — uploads de outras empresas não devem poluir a base.
    const _grupoCacheMotorista = {};
    let motoristaUpsert = null; // null = não é grupo Movee (upsert não se aplica)
    if (await mesmoGrupoQue(empresaId, 6, _grupoCacheMotorista)) {
      motoristaUpsert = await upsertMotoristasFromLote(dataToInsert);
    }
    // Observabilidade: se o pré-cadastro do grupo Movee falhou, NÃO mascarar como
    // sucesso pleno — o movimento foi salvo, mas o motorista não entrou na base
    // (login do app falharia). Aviso aditivo; não altera o contrato existente.
    const motoristaWarning = (motoristaUpsert && motoristaUpsert.ok === false)
      ? 'Movimento salvo, mas o pré-cadastro de motoristas na base Motorista falhou. Os motoristas podem não conseguir acessar o app até a correção.'
      : null;

    // Tenta inferir quantas linhas foram inseridas
    let insertedRows = null;
    if (Array.isArray(response)) {
      insertedRows = response;
    } else if (Array.isArray(response?.data)) {
      insertedRows = response.data;
    }

    if (!insertedRows) {
      console.error('[UPLOAD] Não consegui confirmar linhas inseridas. Response não reconhecido.');
      return res.status(200).json({
        success: true,
        warning: 'Upload processado, mas não consegui confirmar retorno do PostgREST.',
        inserted_attempted: dataToInsert.length,
        ...(motoristaWarning ? { motorista_warning: motoristaWarning } : {})
      });
    }

    console.error(`[UPLOAD] Inseridas ${insertedRows.length} linha(s) pelo PostgREST.`);

    return res.json({
      success: true,
      inserted: insertedRows.length,
      ...(motoristaWarning ? { motorista_warning: motoristaWarning } : {})
    });

  } catch (error) {
    console.error('[UPLOAD] Erro inesperado no try/catch principal:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao processar o arquivo.',
      detail: error.message
    });
  }
});


// Rota para exportar dados da tabela EnvioMassa em CSV
app.get('/export-envio-massa', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.consultar'), async (req, res) => {
  let idEmp;
  try {
    // movimento-por-filial: threading empresa_id (FR-010)
    // resolveEmpresaAlvo lança err com err.status 403/503 se fora do escopo
    idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'GET /export-envio-massa');
  } catch (authErr) {
    const status = authErr.status || 403;
    return res.status(status).json({ error: authErr.message });
  }
  try {
    // Solicitar os campos específicos da tabela EnvioMassa
    const data = await postgrestRequest(`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false&select=id,created_at,number,nome,cnpj_prestador,valor,mensagem1,mensagem2,enviado,retorno_envio_msg_1,retorno_envio_msg_2,tribnac,cnpj_tomador,dCompet,numnota,nota_ok,data_emissao,erro_validacao,dataEnvio,id_empresa,uuid,mov_fechado,dt_inicial,dt_final`);

    if (data.length === 0) {
      return res.status(404).json({ error: 'Nenhum dado encontrado' });
    }

    // Formatando o campo dataEnvio no formato yyyy-mm-dd hh:mm:ss
    const formattedData = data.map(item => {
      const formattedDataEnvio = item.dataEnvio 
        ? new Date(item.dataEnvio).toISOString().slice(0, 19).replace('T', ' ') // Formato yyyy-mm-dd hh:mm:ss
        : '';
      
      return {
        id: item.id,
        created_at: item.created_at,
        number: item.number,
        nome: item.nome,
        valor: item.valor,
        mensagem1: item.mensagem1,
        mensagem2: item.mensagem2,
        enviado: item.enviado,
        retorno_envio_msg_1: item.retorno_envio_msg_1,
        retorno_envio_msg_2: item.retorno_envio_msg_2,
        tribnac: item.tribnac,
        cnpj_tomador: item.cnpj_tomador,
        dCompet: item.dCompet,
        numnota: item.numnota,
        nota_ok: item.nota_ok,
        data_emissao: item.data_emissao,
        erro_validacao: item.erro_validacao,
        dataEnvio: formattedDataEnvio, // Data formatada
        id_empresa: item.id_empresa,
        uuid: item.uuid,
        mov_fechado: item.mov_fechado
      };
    });

    // Converter para CSV usando json2csv
    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(formattedData);

    // Definir o nome do arquivo
    const fileName = `envio_massa_${idEmp}.csv`;

    // Definir os cabeçalhos para download de CSV
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Type', 'text/csv');
    
    // Enviar o arquivo CSV
    res.send(csv);
  } catch (err) {
    console.error('Erro ao exportar CSV:', err);
    res.status(500).json({ error: 'Erro ao exportar CSV' });
  }
});

function getNFeKeyFromNotaOk(notaOkRaw) {
  try {
    if (!notaOkRaw) return null;

    const raw = String(notaOkRaw).trim();
    if (!raw) return null;

    // Se for URL (http/https), extrai do pathname
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const urlObj = new URL(raw);
      const pathname = urlObj.pathname; // ex: /static/5/3548...971.xml
      const fileName = path.basename(pathname); // ex: 3548...971.xml
      const key = path.basename(fileName, path.extname(fileName)); // ex: 3548...971
      return key || null;
    }

    // Se for caminho local (X:\...\3548...971.xml ou /caminho/.../3548...971.xml)
    const fileName = path.basename(raw); // ex: 3548...971.xml
    const key = path.basename(fileName, path.extname(fileName)); // ex: 3548...971
    return key || null;
  } catch (err) {
    console.error('Erro ao extrair chave NFe de nota_ok:', notaOkRaw, err);
    return null;
  }
}

// Rota para baixar XMLs do movimento em aberto em um arquivo ZIP
app.get('/download-xml-movimento', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.consultar'), async (req, res) => {
  let idEmp;
  try {
    // movimento-por-filial: threading empresa_id (FR-011)
    // resolveEmpresaAlvo lança err com err.status 403/503 se fora do escopo
    idEmp = await resolveEmpresaAlvo(req.user, req.query.empresa_id, 'GET /download-xml-movimento');
  } catch (authErr) {
    const status = authErr.status || 403;
    return res.status(status).json({ error: authErr.message });
  }
  try {
    const data = await postgrestRequest(
      `EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false&select=id,nome,numnota,nota_ok,erro_validacao`
    );

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Nenhum registro de movimento em aberto encontrado.' });
    }

    // Filtro 1: numnota NÃO vazio
    // Filtro 2: erro_validacao vazio/nulo
    const filteredByNotaAndErro = data.filter(item => {
      const temNumeroNota = item.numnota && String(item.numnota).trim() !== '';

      const erroValidacaoVazio =
        item.erro_validacao === null ||
        item.erro_validacao === undefined ||
        String(item.erro_validacao).trim() === '';

      return temNumeroNota && erroValidacaoVazio;
    });

    if (filteredByNotaAndErro.length === 0) {
      return res.status(404).json({
        error: 'Nenhum registro com número de nota e sem erro de validação disponível para download.'
      });
    }

    // Agora filtra quem realmente tem info de XML em nota_ok
    const rowsWithXmlInfo = filteredByNotaAndErro.filter(
      item => item.nota_ok && String(item.nota_ok).trim() !== ''
    );

    if (rowsWithXmlInfo.length === 0) {
      return res.status(404).json({
        error: 'Nenhum XML disponível (nota_ok vazio) após aplicar os filtros de número de nota e erro de validação.'
      });
    }

    const zipName = `xml_movimento_aberto_${idEmp}.zip`;
    res.setHeader('Content-Disposition', `attachment; filename=${zipName}`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('Erro no archiver (ZIP):', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao gerar o arquivo ZIP.' });
      }
    });

    archive.pipe(res);

    for (const item of rowsWithXmlInfo) {
      const raw = String(item.nota_ok || '').trim();
      if (!raw) continue;

      try {
        let buffer;
        let fileNameInsideZip;

        // Sempre tentamos extrair a chave a partir de nota_ok
        const chaveNFe = getNFeKeyFromNotaOk(raw);

        // Se não conseguir extrair, cai em um fallback (id ou numnota)
        const baseNameFallback =
          (item.numnota && String(item.numnota).trim() !== '')
            ? `NF_${item.numnota}`
            : (item.nome
                ? `NF_${item.nome.replace(/\s+/g, '_')}`
                : `id_${item.id}`);

        const baseName = chaveNFe || baseNameFallback;

        // 1) nota_ok contém o próprio XML (string iniciando em "<")
        if (raw.startsWith('<')) {
          buffer = Buffer.from(raw, 'utf-8');
          fileNameInsideZip = `${baseName}.xml`;
          archive.append(buffer, { name: fileNameInsideZip });
          continue;
        }

        // 2) nota_ok é URL
        if (raw.startsWith('http://') || raw.startsWith('https://')) {
          const response = await axios.get(raw, { responseType: 'arraybuffer' });
          buffer = Buffer.from(response.data);

          const ext = path.extname(raw) || '.xml';
          fileNameInsideZip = `${baseName}${ext}`;
          archive.append(buffer, { name: fileNameInsideZip });
          continue;
        }

        // 3) nota_ok é caminho de arquivo local
        const filePath = raw;
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath) || '.xml';
          fileNameInsideZip = `${baseName}${ext}`;
          archive.file(filePath, { name: fileNameInsideZip });
          continue;
        }

        console.warn(
          '[download-xml-movimento] nota_ok ignorado (formato não reconhecido):',
          raw
        );
      } catch (downloadErr) {
        console.error(
          '[download-xml-movimento] Erro ao adicionar XML ao ZIP para item id=',
          item.id,
          downloadErr.message
        );
      }
    }

    archive.finalize();
  } catch (err) {
    console.error('Erro ao gerar ZIP de XMLs:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao gerar ZIP de XMLs.' });
    }
  }
});

// Helper: extrai campos da NFSe parseada pelo xml2js
function extractNfseFields(parsed, filename) {
  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[key] !== undefined) {
      var val = obj[key];
      if (typeof val === 'object' && val._ !== undefined) return val._;
      return val;
    }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var found = findKey(obj[keys[i]], key);
      if (found !== null) return found;
    }
    return null;
  }

  // validacao-xml-lote (FASE 1, task 1.1): localiza o NÓ (objeto) cujo nome casa
  // com `key` (não o valor), para acessar atributos via `.$`. Defensivo: retorna
  // null sem lançar.
  function findNode(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[key] !== undefined && typeof obj[key] === 'object') return obj[key];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var found = findNode(obj[keys[i]], key);
      if (found !== null) return found;
    }
    return null;
  }

  var emit = findKey(parsed, 'emit');
  var prest = findKey(parsed, 'prest');
  var source = emit || prest;
  var cnpj_prestador = source ? (findKey(source, 'CNPJ') || '') : '';
  var razao_social = source ? (findKey(source, 'xNome') || '') : '';
  var data_emissao = findKey(parsed, 'dhEmi') || findKey(parsed, 'dhProc') || '';
  var valores = findKey(parsed, 'valores');
  var valor_nota = valores ? (findKey(valores, 'vLiq') || findKey(valores, 'vServ') || '') : '';

  // validacao-xml-lote (FASE 1, task 1.1.2): chave de acesso (50 dígitos).
  // Padrão NACIONAL NFS-e: atributo `Id` de <infNFSe> com prefixo `NFS`
  // (ex.: Id="NFS3550...50" → chave "3550...50"). Extração defensiva: qualquer
  // ausência → null (cai no fallback cnpj+numnota+data no casamento). NÃO há
  // fallback para o filename aqui (decisão D1 do plan.md) — o handler resolve.
  var chave = null;
  try {
    var infNFSe = findNode(parsed, 'infNFSe');
    var rawId = (infNFSe && infNFSe.$ && infNFSe.$.Id) ? String(infNFSe.$.Id) : null;
    if (rawId) {
      var stripped = rawId.replace(/^NFS/, '');
      chave = /^\d{50}$/.test(stripped) ? stripped : (stripped || null);
    }
  } catch (e) { chave = null; }

  // validacao-xml-lote (FASE 1, task 1.1.3): numnota = <nNFSe> (NUNCA nDPS/nDFSe).
  var numnota = null;
  try {
    var n = findKey(parsed, 'nNFSe');
    numnota = (n !== null && n !== undefined && String(n).trim() !== '') ? String(n).trim() : null;
  } catch (e) { numnota = null; }

  return {
    cnpj_prestador: cnpj_prestador,
    data_emissao: data_emissao,
    razao_social: razao_social,
    valor_nota: valor_nota,
    chave: chave,
    numnota: numnota,
    filename: filename
  };
}

// validacao-xml-lote (FASE 1, task 1.2): normaliza data_emissao (ISO) para
// "YYYY-MM-DD" (por dia, sem hora) — usado na chave composta de fallback.
function normalizeDataDia(v) {
  if (!v) return '';
  var s = String(v).trim();
  // ISO 8601 já começa com YYYY-MM-DD; pega os 10 primeiros chars se válidos.
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// validacao-xml-lote (FASE 1, task 1.2): casa o XML extraído com um movimento
// aberto da empresa-alvo. Primário por chave (índice movsByChave, p/ reenvio),
// fallback por cnpj_prestador no movimento aberto mais recente (índice
// movsByCnpj) — replicando o fluxo de 1-nota. Ambos os índices são construídos
// UMA vez por lote APENAS sobre movimentos da empresa-alvo (isolamento
// multi-tenant — Princ. II). Retorna { movimento, criterio }.
function findMovimentoParaXml(extracted, movsByChave, movsByCnpj) {
  // Primário: chave de acesso (reenvio — movimento já validado tem nota_ok, do
  // qual getNFeKeyFromNotaOk deriva a mesma chave). Confirma identidade exata.
  if (extracted && extracted.chave) {
    var byChave = movsByChave[extracted.chave];
    if (byChave) return { movimento: byChave, criterio: 'chave' };
  }
  // Fallback (1ª validação): cnpj_prestador no movimento ABERTO mais recente da
  // empresa-alvo. Replica o fluxo de 1-nota (routes/motorista.js validar-nota:
  // `cnpj_prestador=...&mov_fechado=eq.false&order=created_at.desc&limit=1`).
  // Um movimento aberto ainda-não-validado só tem cnpj_prestador (numnota/
  // data_emissao/nota_ok são preenchidos NA validação), então casar por
  // cnpj é o único critério viável aqui. Modelo: 1 nota por prestador.
  var cnpj = onlyDigits(extracted && extracted.cnpj_prestador);
  if (cnpj) {
    var byCnpj = movsByCnpj[cnpj];
    if (byCnpj) return { movimento: byCnpj, criterio: 'cnpj' };
  }
  return { movimento: null, criterio: 'none' };
}

// Rota para validacao em lote de XMLs NFSe
// validacao-xml-lote (FASE 0, CHK113): middleware que aplica uploadXmlBatch e
// traduz erros do multer (ex.: LIMIT_FILE_SIZE > 2 MB, LIMIT_FILE_COUNT > 100)
// numa resposta JSON limpa (413), em vez do 500 HTML padrão do Express.
function xmlBatchUpload(req, res, next) {
  uploadXmlBatch.array('xmlFiles', 100)(req, res, function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Arquivo XML excede o limite de 2 MB.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(413).json({ error: 'Limite de 100 arquivos por lote excedido.' });
      }
      return res.status(400).json({ error: 'Falha no upload dos XMLs: ' + err.message });
    }
    next();
  });
}

// validacao-xml-lote (FASE 1, task 1.3): reescrita idempotente.
// Casa cada XML com um movimento ABERTO da empresa-alvo e persiste o resultado
// no registro EXISTENTE via PATCH por id — NUNCA sobrescreve nota APROVADA (gate
// central). Usa uploadXmlBatch (limite 2 MB/arquivo, 100 arquivos — FASE 0).
app.post('/validate-xml-batch', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.enviar'), xmlBatchUpload, async (req, res) => {
  var files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo XML enviado.' });
  }

  var validarDescricao = req.body.validar_descricao_servico === 'true';
  const _grupoCache = {}; // grupo-unificado-filiais: cache de grupo por request (OWASP MEDIUM-002)

  // task 1.3.1: resolver empresa-alvo (gate de escopo/tenant). Lança 403/503.
  // NUNCA expandir o casamento para o grupo — só esta empresa (Princ. II).
  var idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'POST /validate-xml-batch');
  } catch (authErr) {
    // Limpar arquivos transientes do disco antes de retornar (CHK109).
    files.forEach(function (f) { try { fs.unlinkSync(f.path); } catch (e) {} });
    var status = authErr.status || 403;
    return res.status(status).json({ error: authErr.message });
  }

  console.log('[validate-xml-batch] empresaAlvo:', idEmp, 'files:', files.length, 'validarDescricao:', validarDescricao, 'FASTAPI_TOKEN presente:', !!process.env.FASTAPI_VALIDATION_TOKEN);

  // task 1.3.2: carregar UMA vez os movimentos abertos da empresa-alvo.
  // Falha de PostgREST para o lote inteiro → cada linha vira `erro` (0.2.3).
  var movimentosAbertos = null;
  var loadMovsError = null;
  try {
    movimentosAbertos = await postgrestRequest(
      'EnvioMassa?mov_fechado=eq.false&id_empresa=eq.' + encodeURIComponent(idEmp) +
      '&select=id,nota_ok,erro_validacao,cnpj_prestador,numnota,data_emissao,valor,created_at' +
      '&order=created_at.desc'
    );
    if (!Array.isArray(movimentosAbertos)) movimentosAbertos = [];
  } catch (e) {
    loadMovsError = e;
    console.error('[validate-xml-batch] Falha ao carregar movimentos abertos (lote inteiro vira erro):', e.message);
  }

  // task 1.3.3: índices em memória (só sobre a empresa-alvo — isolamento tenant).
  var movsByChave = {};
  var movsByCnpj = {};
  if (movimentosAbertos) {
    for (var mi = 0; mi < movimentosAbertos.length; mi++) {
      var mv = movimentosAbertos[mi];
      var chaveMov = getNFeKeyFromNotaOk(mv.nota_ok);
      if (chaveMov && movsByChave[chaveMov] === undefined) movsByChave[chaveMov] = mv;
      // Movimento aberto MAIS RECENTE por cnpj_prestador (só-dígitos): a query
      // ordena por created_at.desc, então o 1º visto de cada cnpj é o mais
      // recente — replica `order=created_at.desc&limit=1` do fluxo de 1-nota.
      var cnpjMov = onlyDigits(mv.cnpj_prestador);
      if (cnpjMov && movsByCnpj[cnpjMov] === undefined) movsByCnpj[cnpjMov] = mv;
    }
  }

  // Estado para árvore de decisão + dedup intra-lote.
  var results = [];
  var movimentosProcessados = {}; // task 1.3.4: dedup intra-lote por movimento.id (cobre XMLs sem chave)
  var stats = {
    total: 0, ja_validada: 0, validada: 0, revalidada: 0,
    duplicada_no_lote: 0, sem_movimento: 0, erro: 0
  };

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var chamouFastApi = false; // controla rate-limit (1.3.9) e PATCH (1.3.5)
    var row = {
      arquivo: file.originalname,
      status: 'erro',
      match_criterio: 'none',
      movimento_id: null,
      cnpj_prestador: null,
      numnota: null,
      erro_validacao: null
    };

    try {
      // task 1.3.12: try/catch por iteração — falha de uma linha não para o lote.
      var xmlContent = fs.readFileSync(file.path, 'utf-8');

      var parsed = await xml2js.parseStringPromise(xmlContent, {
        explicitArray: false,
        tagNameProcessors: [xml2js.processors.stripPrefix]
      });
      var fields = extractNfseFields(parsed, file.originalname);
      row.cnpj_prestador = fields.cnpj_prestador || null;
      row.numnota = fields.numnota || null;

      // Se o lote inteiro falhou ao carregar movimentos → erro por linha (0.2.3).
      if (loadMovsError) {
        row.status = 'erro';
        row.erro_validacao = 'serviço de validação indisponível';
        throw { _handled: true };
      }

      // task 1.3.5 (c): casamento.
      var match = findMovimentoParaXml(fields, movsByChave, movsByCnpj);
      row.match_criterio = match.criterio;

      if (match.criterio === 'none' || !match.movimento) {
        // sem_movimento → NUNCA insere (P3).
        row.status = 'sem_movimento';
        throw { _handled: true };
      }

      var movimento = match.movimento;
      row.movimento_id = movimento.id;

      // task 1.3.4 (dedup intra-lote por MOVIMENTO): deduplica pelo movimento
      // casado — cobre "mesma chave 2x" E XMLs SEM chave que casam o mesmo
      // movimento via fallback (cnpj+numnota+data). Evita validar/revalidar o
      // mesmo registro 2x no lote. 1º processa; repetições → duplicada_no_lote.
      if (movimentosProcessados[movimento.id]) {
        row.status = 'duplicada_no_lote';
        row.match_criterio = movimentosProcessados[movimento.id].criterio || match.criterio;
        throw { _handled: true };
      }
      movimentosProcessados[movimento.id] = { criterio: match.criterio };

      // GATE CENTRAL [C] (snapshot rápido): nota APROVADA no snapshot do lote →
      // ja_validada, sem FastAPI e sem PATCH (replica jaAprovada de
      // routes/motorista.js). Confirmação FRESCA logo abaixo (anti-race).
      var temNotaOk = movimento.nota_ok != null && String(movimento.nota_ok).trim() !== '';
      var jaAprovada = temNotaOk && !((movimento.erro_validacao || '').trim());
      if (jaAprovada) {
        row.status = 'ja_validada';
        throw { _handled: true };
      }

      // Reprovada (nota_ok cheio + erro cheio) → revalidada; Sem validação
      // (nota_ok vazio) → validada. Ambas chamam FastAPI + PATCH.
      var statusAlvo = temNotaOk ? 'revalidada' : 'validada';

      // GATE CENTRAL [C] reforçado — read-back FRESCO antes de chamar a FastAPI.
      // A FastAPI grava nota_ok/erro_validacao DIRETO na EnvioMassa, então o
      // snapshot inicial do lote pode estar defasado se este movimento foi
      // aprovado nesse meio-tempo (concorrência externa, ou um XML anterior do
      // mesmo lote). Se já está APROVADA AGORA, não chama a FastAPI e não grava —
      // fecha o furo de sobrescrita da nota aprovada.
      try {
        var freshPre = await postgrestRequest(
          'EnvioMassa?id=eq.' + encodeURIComponent(movimento.id) + '&select=nota_ok,erro_validacao'
        );
        var pre = (Array.isArray(freshPre) && freshPre[0]) || null;
        if (pre) {
          var temNotaOkFresh = pre.nota_ok != null && String(pre.nota_ok).trim() !== '';
          var jaAprovadaFresh = temNotaOkFresh && !((pre.erro_validacao || '').trim());
          if (jaAprovadaFresh) {
            row.status = 'ja_validada';
            throw { _handled: true };
          }
          // Estado fresco manda no statusAlvo (snapshot pode estar defasado).
          statusAlvo = temNotaOkFresh ? 'revalidada' : 'validada';
        }
      } catch (preErr) {
        if (preErr && preErr._handled) throw preErr;
        // Leitura instável: prossegue com o snapshot (gate snapshot já passou).
        console.error('[validate-xml-batch] read-back pré-FastAPI falhou id=' + movimento.id + ': ' + (preErr && preErr.message));
      }

      // task 1.3.7: roteamento FastAPI por grupo Movee (PRESERVAR exatamente).
      // mesmoGrupoQue afeta SÓ o roteamento — não o escopo do casamento.
      var xmlInput = JSON.stringify({ filename: file.originalname, data: xmlContent });
      var url, payload;
      if (await mesmoGrupoQue(idEmp, 6, _grupoCache)) { // idReferencia=6 = Movee
        url = 'https://fastapihomologacao.todo-tips.com/validade_nfse';
        payload = new URLSearchParams({
          xml_input: xmlInput,
          id_empresa: '6',
          validar_descricao_servico: String(validarDescricao)
        });
      } else {
        url = 'https://fastapihomologacaonexus.todo-tips.com/validade_nfse';
        payload = new URLSearchParams({
          xml_input: xmlInput,
          nexus: 'true',
          validar_descricao_servico: String(validarDescricao)
        });
      }

      // task 1.3.8: classificar negócio × infra na chamada à FastAPI.
      chamouFastApi = true;
      console.log('[validate-xml-batch][FASTAPI] id=' + movimento.id + ' url=' + url + ' empresa=' + idEmp);
      try {
        await axios.post(url, payload.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': process.env.FASTAPI_VALIDATION_TOKEN
          }
        });
      } catch (apiErr) {
        var extStatus = (apiErr.response && apiErr.response.status) || 0;
        var extDetail = apiErr.response && apiErr.response.data && apiErr.response.data.detail;
        var detailMsg = typeof extDetail === 'string' ? extDetail.trim() : '';
        if (extStatus >= 400 && extStatus < 500 && detailMsg) {
          // NEGÓCIO: 4xx com detail → propaga o detail (será gravado abaixo via
          // read-back; mesmo se a FastAPI gravou erro_validacao, refletimos).
          console.error('[validate-xml-batch][FASTAPI] negócio id=' + movimento.id + ' detail=' + detailMsg);
          // segue para o read-back/PATCH abaixo (a FastAPI grava erro_validacao).
        } else {
          // INFRA: timeout/5xx/sem resposta → erro, NÃO grava resultado falso.
          console.error('[validate-xml-batch][FASTAPI] infra id=' + movimento.id + ' status=' + extStatus + ' msg=' + apiErr.message);
          row.status = 'erro';
          row.erro_validacao = 'serviço de validação indisponível';
          throw { _handled: true };
        }
      }

      // Fonte de verdade: a FastAPI grava nota_ok/erro_validacao DIRETO na
      // EnvioMassa. Relemos o registro (padrão validar-nota) e then PATCH
      // idempotente por id com esses {nota_ok, erro_validacao} (FR-012).
      var registro = null;
      try {
        var refreshed = await postgrestRequest(
          'EnvioMassa?id=eq.' + encodeURIComponent(movimento.id) + '&select=nota_ok,erro_validacao'
        );
        registro = (Array.isArray(refreshed) && refreshed[0]) || null;
      } catch (e) {
        registro = null;
      }

      if (!registro) {
        // FastAPI respondeu mas não persistiu → tratar como infra (não grava falso).
        row.status = 'erro';
        row.erro_validacao = 'serviço de validação indisponível';
        throw { _handled: true };
      }

      var novoNotaOk = registro.nota_ok;
      var novoErro = (registro.erro_validacao || '').trim();

      // task 1.3.6: PATCH idempotente — body SÓ { nota_ok, erro_validacao },
      // NUNCA `valor` (INV-4). A defesa anti-overwrite é o read-back FRESCO feito
      // ANTES da chamada à FastAPI (acima): uma nota já aprovada nunca chega
      // aqui. Aqui apenas refletimos o resultado que a FastAPI persistiu.
      try {
        await postgrestRequest(
          'EnvioMassa?id=eq.' + encodeURIComponent(movimento.id),
          'PATCH',
          { nota_ok: novoNotaOk, erro_validacao: registro.erro_validacao }
        );
        // task 1.3.11 / 0.1.3: log estruturado por PATCH (sem PII/sem XML).
        console.log('[PATCH] id=' + movimento.id + ' status=' + statusAlvo + ' empresa=' + idEmp);
      } catch (patchErr) {
        console.error('[validate-xml-batch][PATCH] falha id=' + movimento.id + ': ' + patchErr.message);
        row.status = 'erro';
        row.erro_validacao = 'serviço de validação indisponível';
        throw { _handled: true };
      }

      row.status = statusAlvo;
      row.erro_validacao = novoErro ? registro.erro_validacao : null;
    } catch (err) {
      if (!(err && err._handled)) {
        // Parse/erro inesperado → status=erro, continua o lote (FR-015).
        console.error('[validate-xml-batch] Erro ao processar XML ' + file.originalname + ': ' + (err && err.message));
        row.status = 'erro';
        if (!row.erro_validacao) row.erro_validacao = 'falha ao processar XML';
      }
    } finally {
      // CHK109: remover o arquivo transiente do disco após o processamento.
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    }

    results.push(row);
    if (stats[row.status] !== undefined) stats[row.status] += 1;
    stats.total += 1;

    // task 1.3.9: rate-limit de 2s SOMENTE quando houve chamada à FastAPI.
    if (chamouFastApi && i < files.length - 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 2000); });
    }
  }

  // task 1.3.11: log de aggregates ao final (sem PII).
  console.log('[validate-xml-batch][stats] ' + JSON.stringify(stats));

  // task 1.3.10: resposta enriquecida { stats, results } em snake_case.
  res.json({ stats: stats, results: results });
});

// Rota para fechar o movimento
app.post('/close-movimento', authenticateToken, hubEnvioMassaClaimsBridge, hubEnvioMassaRequirePermission('envio_massa.aprovar'), async (req, res) => {
  // movimento-por-filial: empresa_id pode vir via body JSON
  let idEmp;
  try {
    idEmp = await resolveEmpresaAlvo(req.user, req.body.empresa_id, 'POST /close-movimento');
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.error || 'empresa fora do escopo' });
  }

  try {
    // CHK009-API: Prefer:return=representation → PostgREST retorna array dos registros
    // atualizados; length = quantidade efetivamente fechada (0 se nenhum aberto).
    const updated = await postgrestRequest(`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`, 'PATCH', { mov_fechado: true });
    const fechados = Array.isArray(updated) ? updated.length : 0;

    res.json({ message: 'Movimento fechado com sucesso', fechados });
  } catch (err) {
    console.error('Erro no servidor ao fechar o movimento:', err);
    res.status(500).json({ error: 'Erro no servidor ao fechar o movimento' });
  }
});

// Rota de registro
app.post('/register', async (req, res) => {
  try {
    const { nomeEmpresa, email, senha } = req.body;

    // Verificar se o email já está registrado
    const existingUsers = await postgrestRequest(`Empresa?email=eq.${email}`);

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado.' });
    }

    // Criptografar a senha antes de salvar
    const hashedPassword = await bcrypt.hash(senha, 10);

    // Criar o objeto com os dados no formato JSON
    const dataToInsert = {
      nome_empresa: nomeEmpresa,
      email: email,
      pass: hashedPassword
    };

    // Fazer a requisição para inserir os dados no PostgREST
    const response = await postgrestRequest('Empresa', 'POST', dataToInsert);

    // Verifique se houve sucesso na resposta
    if (response.error) {
      return res.status(400).json({ error: response.error.message });
    }

    // Retornar a mensagem de sucesso
    res.status(201).json({ message: 'Empresa cadastrada com sucesso!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});


// Rota de logout
app.post('/logout', (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.json({ message: 'Logout bem-sucedido' });
});

// App Motorista — injetar dependências e montar rotas /motorista/*
motoristaRoutes.init({ postgrestRequest, generatePostgrestJWT });
app.use('/motorista', motoristaRoutes.router);

// config-ui-tenant + cadastro-filiais — injetar dependências e montar rotas /grupo/*
grupoRoutes.init({ postgrestRequest, bcrypt });
app.use('/grupo', authenticateToken, grupoRoutes.router);

// cadastro-motorista-base-validada — CRUD admin de motoristas (auth de EMPRESA).
// Escopo multi-tenant derivado de EnvioMassa via resolveScope (Princípio II).
adminMotoristaRoutes.init({ postgrestRequest, resolveScope: grupoRoutes.resolveScope });
app.use('/admin/motoristas', authenticateToken, adminMotoristaRoutes.router);

// config-ui-tenant — injetar dependências e montar rotas de branding
brandingRoutes.init({ postgrestRequest });
// GET/PUT /empresa/branding (auth empresa — token empresa)
app.use('/empresa/branding', authenticateToken, brandingRoutes.router);
// GET /motorista/branding-tomador (auth motorista — já montado no motoristaRoutes,
// mas o handler está em brandingRoutes.brandingTomadorRouter para separação de módulo)
// Injetamos no router do motorista via uso direto do sub-router, COM o middleware
// authenticateMotorista — senão req.motorista nunca é setado e o handler retorna
// 401 mesmo com sessão válida (fix: branding-tomador 401 no app motorista).
motoristaRoutes.router.use('/', motoristaRoutes.authenticateMotorista, brandingRoutes.brandingTomadorRouter);

// hub-fundacoes (FASE 3) — /api/v1/auth/* (login/refresh/logout/recuperar-senha/
// redefinir-senha). Sem authenticateToken aqui — o próprio router aplica
// rate-limit (Decision 8) e cada rota decide sua própria exigência de auth
// (login/recuperar-senha/redefinir-senha são públicos por design; refresh e
// logout leem o cookie diretamente). Auditoria e RBAC completos chegam nas
// próximas ondas (FASE 4/5).
app.use('/api/v1/auth', hubAuthRoutes.router);

// hub-fundacoes (FASE 4) — /api/v1/me (perfil + troca de entidade ativa) e
// /api/v1/auditoria (consulta da trilha, protegida por requirePermission
// dentro do próprio router). Sem authenticateToken aqui — mesmo padrão do
// bloco /api/v1/auth acima: cada rota do hub-me.js decide sua própria
// exigência de auth (accessToken do hub, não o token do backend legado).
app.use('/api/v1/me', hubMeRoutes.router);
app.use('/api/v1/auditoria', hubMeRoutes.auditoriaRouter);

// hub-importacoes (S4, FASE 3) — /api/v1/importacoes (upload multipart +
// dedupe). requirePermission('importacoes.criar') é aplicado dentro do
// próprio router (mesmo padrão do bloco /api/v1/me acima).
app.use('/api/v1/importacoes', hubImportacoesRoutes.router);

// hub-motoristas (S5, FASE 3) — /api/v1/motoristas (lista/detalhe, leitura).
// requirePermission('motoristas.listar'|'motoristas.consultar') é aplicado
// dentro do próprio router (mesmo padrão do bloco /api/v1/importacoes acima).
app.use('/api/v1/motoristas', hubMotoristasRoutes.router);

// hub-faturamento (S6, FASE 3) — /api/v1/faturamento (lista/resumo/export,
// leitura). requirePermission('faturamento.listar'|'faturamento.consultar')
// é aplicado dentro do próprio router (mesmo padrão do bloco
// /api/v1/motoristas acima).
app.use('/api/v1/faturamento', hubFaturamentoRoutes.router);

// hub-performance (S7, FASE 2) — /api/v1/performance (lista/resumo/export,
// leitura). requirePermission('performance.listar'|'performance.consultar')
// é aplicado dentro do próprio router (mesmo padrão do bloco
// /api/v1/faturamento acima).
app.use('/api/v1/performance', hubPerformanceRoutes.router);

// hub-importacoes (pós-review PR #57, F1.3) — recuperação de lock órfão no
// boot: um restart no meio de uma importação (deploy) deixa o registro
// preso em validating/processing, e o índice único parcial (migration
// 0011) bloqueia todo upload futuro do mesmo (id_empresa,tipo) até alguém
// destravar manualmente. ADITIVA, best-effort, fire-and-forget — NUNCA
// gateia o boot (`app.listen` abaixo roda de qualquer forma; `.catch`
// cobre até a rejeição da própria função, embora ela já seja best-effort
// internamente). Guardada por POSTGREST_URL: este mesmo server.js também
// serve o backend LEGADO (envio-massa, sem hub configurado) — sem
// POSTGREST_URL não há hub neste deployment, então nem tenta.
if (process.env.POSTGREST_URL) {
  hubImportProcessor.recuperarImportacoesOrfas().then((resultado) => {
    if (resultado && resultado.totalRecuperadas > 0) {
      console.log(`[boot] hub-importacoes: ${resultado.totalRecuperadas} importação(ões) órfã(s) recuperada(s) após reinício.`);
    }
  }).catch((err) => {
    console.error('[boot] hub-importacoes: falha ao recuperar importações órfãs (não bloqueia o boot):', err && err.message);
  });
}

// Iniciar o servidor
app.listen(3000, () => {
  console.log('Servidor rodando na porta 3000');
});
