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
const jwt = require('jsonwebtoken');
const multer = require('multer');
const axios = require('axios');
const xml2js = require('xml2js');
// O backend roda em Node 14 (Dockerfile FROM node:14), que NÃO tem FormData
// global (só Node 18+). Usa o pacote `form-data` (compatível e suportado pelo
// axios via getHeaders() para o boundary do multipart/form-data).
const FormData = require('form-data');

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
// Helpers injetados pelo server.js na montagem (ver module.exports)
// ──────────────────────────────────────────────────────────────────────────────
let _postgrestRequest;
let _generatePostgrestJWT;

/** Inicializa dependências injetadas pelo server.js */
function init({ postgrestRequest, generatePostgrestJWT }) {
  _postgrestRequest = postgrestRequest;
  _generatePostgrestJWT = generatePostgrestJWT;
}

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
// ROTA: POST /motorista/login  (público)
// Ref: tarefa 2.2.1 / contracts §login / spec FR-001 / quickstart 1, 2
// ──────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { cnpjPrestador, senha } = req.body;

    if (!cnpjPrestador || !senha) {
      return res.status(400).json({ error: 'CNPJ do prestador e senha são obrigatórios.' });
    }

    // Normalizar CNPJ (remover pontuação)
    const cnpjNorm = String(cnpjPrestador).replace(/\D/g, '');

    // Buscar motorista no PostgREST
    const motoristas = await _postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}`
    );

    // Mensagem genérica — não revelar qual campo falhou (anti-enumeração FR-016)
    const INVALID_MSG = 'Credenciais inválidas.';

    if (!motoristas || motoristas.length === 0) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    const motorista = motoristas[0];

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
// ROTA: POST /motorista/register  (público — auto-cadastro com guard FR-017)
// Ref: tarefa 2.3 / contracts §register / spec FR-017 / quickstart 3
// Guard: só cadastra CNPJ que já existe na EnvioMassa e sem conta Motorista.
// ──────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { cnpjPrestador, nome, senha } = req.body;

    if (!cnpjPrestador || !senha || !nome) {
      return res.status(400).json({ error: 'CNPJ do prestador, nome e senha são obrigatórios.' });
    }

    if (senha.length < 8) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
    }

    const cnpjNorm = String(cnpjPrestador).replace(/\D/g, '');

    // Guard 1: verificar se CNPJ existe na EnvioMassa (anti-enumeração)
    const movimentos = await _postgrestRequest(
      `EnvioMassa?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}&limit=1`
    );

    // Resposta anti-enumeração: mesma mensagem se CNPJ não existe ou já tem conta
    const NOT_ELIGIBLE_MSG = 'CNPJ não elegível para cadastro ou já possui conta.';

    if (!movimentos || movimentos.length === 0) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Guard 2: verificar se já existe conta Motorista com este CNPJ
    const existing = await _postgrestRequest(
      `Motorista?cnpj_prestador=eq.${encodeURIComponent(cnpjNorm)}`
    );

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: NOT_ELIGIBLE_MSG });
    }

    // Criar conta
    const senhaHash = await bcrypt.hash(senha, 10);
    await _postgrestRequest('Motorista', 'POST', {
      cnpj_prestador: cnpjNorm,
      senha: senhaHash,
      nome: String(nome).trim(),
      ativo: true,
    });

    return res.status(201).json({ message: 'Conta criada com sucesso. Faça login para continuar.' });
  } catch (err) {
    console.error('[motorista/register] Erro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/token/refresh  (cookie refreshToken)
// Ref: tarefa 2.2.2 / contracts §refresh
// ──────────────────────────────────────────────────────────────────────────────
router.post('/token/refresh', (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Token de atualização ausente.' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Separação de audiência
    if (decoded.aud !== 'motorista') {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const payload = { cnpjPrestador: decoded.cnpjPrestador, nome: decoded.nome || '' };
    const newAccessToken = generateMotoristaAccessToken(payload);

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('accessToken', newAccessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'Strict',
      maxAge: 15 * 60 * 1000,
    });

    return res.json({ message: 'Token renovado.' });
  } catch (err) {
    return res.status(403).json({ error: 'Token de atualização inválido.' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ROTA: POST /motorista/logout  (autenticado)
// Ref: tarefa 2.2.3
// ──────────────────────────────────────────────────────────────────────────────
router.post('/logout', authenticateMotorista, (req, res) => {
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
      `EnvioMassa?cnpj_prestador=eq.${encodeURIComponent(cnpj)}&mov_fechado=eq.false&order=created_at.desc&limit=1`
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
      `EnvioMassa?cnpj_prestador=eq.${encodeURIComponent(cnpj)}&mov_fechado=eq.false&order=created_at.desc&limit=1`
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
    if (Number(movimento.id_empresa) === 6) {
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
      // Falha temporária: não altera nota_ok/erro_validacao (FR-012)
      return res.status(502).json({
        error: 'Serviço de validação indisponível. Tente novamente em instantes.',
      });
    }

    // Mapeamento campo → mensagem pt-BR (data-model.md §ResultadoValidacao / FR-009)
    const FIELD_MESSAGES = {
      valid_cnpj_prestador: 'CNPJ do prestador (você) está incorreto na nota.',
      valid_cnpj: 'CNPJ do tomador está incorreto na nota.',
      valid_descricao_servico: 'Descrição do serviço está incorreta.',
      valid_valor: 'Valor da nota não confere com o valor do movimento.',
      valid_trib_nac: 'Tributação nacional (TribNac) está incorreta.',
      valid_trib_mun: 'Tributação municipal está incorreta.',
      valid_dCompet: 'Data de competência (dCompet) está incorreta.',
    };

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
      const camposInvalidos = erroValidacao
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(campo => ({ campo, mensagem: FIELD_MESSAGES[campo] || 'Campo inválido na nota.' }));

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
// Exportar router + função init (injeção de dependências)
// ──────────────────────────────────────────────────────────────────────────────
module.exports = { router, init, authenticateMotorista };
