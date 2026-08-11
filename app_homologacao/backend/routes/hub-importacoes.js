// hub-importacoes (S4 do hub de frota) — routes/hub-importacoes.js
//
// POST /api/v1/importacoes — upload multipart (FASE 3, tasks.md 3.1-3.4).
// Ref: docs/specs/hub-importacoes/contracts/importacoes-api.md,
// data-model.md Entity ImportacaoArquivo (migration 0011), research.md
// Decision 5/6/8.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-me.js/hub-auth.js). id_empresa SEMPRE resolvido da
// claim `entidade_ativa` do accessToken (Princípio II) — nunca do corpo/query
// do multipart.
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const express = require('express');
const multer = require('multer');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { requirePermission } = require('../middleware/hub-require-permission');
const { parseOrdenacao, ordenacaoParaPostgrest } = require('../lib/hub-ordenacao');

/**
 * Colunas que o histórico aceita ordenar (impeccable rodada 16, h7). Só campos
 * já expostos no `select` da própria listagem — ordenar por coluna que a tela
 * não mostra produz uma ordem inexplicável para quem olha.
 */
const ORDENAVEIS_IMPORTACOES = [
  'criado_em',
  'tipo',
  'status',
  'nome_arquivo',
  'total_linhas',
  'data_referencia',
];
const {
  HubImportParseError,
  validarZipLeve,
  iterarLinhas,
  bufferParaStream,
  validarTipo,
  ehZip,
  TIPOS_SUPORTADOS,
} = require('../lib/hub-import-parser');
// FASE 4 (tasks.md 4.1+) — path/sanitização extraídos para lib compartilhada
// (reusada por lib/hub-import-processor.js sem dependência circular rota↔
// processor; ver cabeçalho de hub-import-storage.js). Reexportados abaixo
// com os MESMOS nomes para não quebrar tests/hub-importacoes-unit.test.js.
const {
  UPLOADS_DIR,
  extensaoDe,
  sanitizarNomeArquivo,
  caminhoArmazenamento,
  armazenarOriginal,
} = require('../lib/hub-import-storage');
// FASE 4 — dispara o processamento (máquina de estados + lotes) logo após
// criar o registro `pending` e persistir o arquivo (research.md Decision 10:
// "processamento síncrono em chunks... ou disparado logo após criar o
// registro"). Fire-and-forget: a resposta 201 já está decidida pelo
// contrato: cliente acompanha via GET /importacoes/:id (polling, FASE 5).
const { processarImportacao } = require('../lib/hub-import-processor');
// FASE 5 (tasks.md 5.1-5.8) — helpers puros de paginação/mapeamento/CSV
// injection, testáveis isoladamente (tests/hub-importacoes-dto.test.js).
const {
  parsePaginacao,
  parseJanelaPadrao,
  mapImportacaoListItem,
  mapImportacaoDetalhe,
  mapErroItem,
  gerarCsvErros,
} = require('../lib/hub-importacoes-dto');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Constantes
// ────────────────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB (contract §POST /importacoes)

// MIME allowlist — client-reported, nunca confiável isoladamente (por isso a
// validação de CONTEÚDO abaixo — resolverConteudoCsv/iterarLinhas — é quem de
// fato decide); serve só para rejeitar cedo tipos obviamente errados
// (ex.: image/png) sem gastar CPU tentando parsear.
const MIME_CSV_PERMITIDOS = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream', // muitos clientes/OS não sabem inferir CSV
]);
const MIME_ZIP_PERMITIDOS = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Wrapper de multer.single('file') que traduz erros do multer (fileSize/
 * fileCount) para o formato de erro padrão do hub (422 INVALIDO) — contract
 * §POST /importacoes não usa 413, unifica tudo em 422 com `motivo`. */
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(422).json({ error: 'INVALIDO', motivo: 'tamanho_excedido' });
      }
      return res.status(422).json({ error: 'INVALIDO', motivo: 'upload_invalido' });
    }
    if (err) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'upload_invalido' });
    }
    return next();
  });
}

/**
 * F2 (pós-review PR #57) — validação BARATA do conteúdo, pensada para
 * devolver 201 rápido: para `.zip`, confirma SÓ a estrutura (EOCD, 1
 * entrada, nome seguro, tamanho DECLARADO dentro do limite) via
 * `validarZipLeve` — NUNCA infla o conteúdo aqui (o inflate de até 100MB é
 * síncrono/pesado e bloquearia a thread de request; fica reservado para o
 * processor, fire-and-forget, `lib/hub-import-processor.js`). Para CSV
 * puro (sem custo de descompressão), mantém a checagem original de "ao
 * menos 1 linha decodificável" — é barata (não envolve zlib) e dá feedback
 * de erro imediato ao usuário em vez de um 201 seguido de `failed`
 * silencioso. NÃO valida o header aqui (isso é responsabilidade do
 * processamento — FASE 4, contracts/importacoes-api.md "cabeçalho errado
 * -> failed"); e, para `.zip`, também não confirma "tem linha
 * decodificável" (exigiria inflar) — um ZIP estruturalmente válido mas com
 * conteúdo vazio só é pego no processor (`arquivo vazio`, 4.1).
 * @returns {Promise<Buffer>} o buffer recebido (sem transformação)
 * @throws {HubImportParseError}
 */
async function validarConteudo(buffer, nomeArquivo) {
  if (ehZip(nomeArquivo)) {
    validarZipLeve(buffer, { nomeArquivo });
    return buffer;
  }
  if (!buffer || buffer.length === 0) {
    throw new HubImportParseError('Conteúdo vazio após resolução', 'conteudo_vazio');
  }
  const stream = bufferParaStream(buffer);
  let temLinha = false;
  // eslint-disable-next-line no-unused-vars
  for await (const _linha of iterarLinhas(stream)) {
    temLinha = true;
    break;
  }
  if (!temLinha) {
    throw new HubImportParseError('Nenhuma linha decodificável no conteúdo', 'conteudo_vazio');
  }
  return buffer;
}

/** F11 (pós-review PR #57) — `parseInt('123abc', 10)` retorna `123`
 * (ignora lixo à direita) e `Number.isFinite(123)` é `true` — um path
 * `/importacoes/123abc-DROP-TABLE` ou similar era tratado como id=123 em
 * vez de rejeitado. Valida o formato ANTES de converter: só dígitos, do
 * início ao fim. */
function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

/**
 * FASE 5 (5.8) — resolve payload+entidadeAtiva+claims do accessToken e
 * confirma que a ENTIDADE ATIVA concede `permissao` (não só a união flat já
 * barrada pelo `requirePermission` de nível de rota — correção pós-review
 * PR #55 achado #1, mesmo padrão de POST / acima e `GET /auditoria` em
 * routes/hub-me.js: alguém com o grant só na empresa B não pode agir "como"
 * a empresa A ativa). Envia a resposta de erro e retorna `null` em caso de
 * falha (401/400/403); retorna o contexto em caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} permissao - ex.: `importacoes.consultar`
 * @returns {Promise<{payload:object, entidadeAtiva:number, claims:object}|null>}
 */
async function resolverContextoEntidade(req, res, permissao) {
  const accessToken = lerAccessTokenDoRequest(req);
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    return null;
  }
  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
  return { payload, entidadeAtiva, claims };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /importacoes (task 3.1-3.4)
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requirePermission('importacoes.criar'), uploadSingle, async (req, res) => {
  const ip = req.ip;
  const accessToken = lerAccessTokenDoRequest(req);
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
  }

  // id_empresa SEMPRE da claim de entidade ativa (Princípio II) — nunca do
  // corpo do multipart. Sem entidade ativa selecionada não há como escopar
  // o INSERT com segurança (mesma postura nega-por-padrão de GET /auditoria).
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    return res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
  }

  try {
    // Correção de padrão pós-review PR #55 (achado #1): o `requirePermission`
    // acima só valida a UNIÃO achatada de grants (barreira grossa). Como o
    // registro é escopado pela entidade ATIVA, é ESSA entidade que precisa
    // conceder `importacoes.criar` — senão alguém com o grant só na empresa B
    // poderia criar importações "como" a empresa A ativa.
    const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
    if (!permsEntidade.has('importacoes.criar')) {
      return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    }

    // 3.1.1/3.1.2 — tipo (multer parseia multipart/form-data ANTES do body
    // estar disponível; req.body.tipo já vem populado pelo multer.single()).
    const tipoBruto = req.body && req.body.tipo;
    if (!TIPOS_SUPORTADOS.includes(tipoBruto)) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'tipo_invalido' });
    }
    const tipo = validarTipo(tipoBruto);

    if (!req.file) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'arquivo_ausente' });
    }

    const nomeOriginal = req.file.originalname || '';
    const extensao = extensaoDe(nomeOriginal);

    // 3.1.1 — extensão
    if (extensao !== '.csv' && extensao !== '.zip') {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'extensao_invalida' });
    }

    // 3.1.2 — MIME (allowlist; client-reported, reforçado pela validação de
    // conteúdo logo abaixo — nunca é a única defesa).
    const mimePermitidos = extensao === '.zip' ? MIME_ZIP_PERMITIDOS : MIME_CSV_PERMITIDOS;
    if (req.file.mimetype && !mimePermitidos.has(req.file.mimetype)) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'mime_invalido' });
    }

    // 3.1.3 — tamanho (defesa em profundidade; multer.limits.fileSize já
    // rejeita antes do handler, mas confirmamos o buffer recebido).
    if (req.file.buffer.length === 0) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'arquivo_vazio' });
    }
    if (req.file.buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(422).json({ error: 'INVALIDO', motivo: 'tamanho_excedido' });
    }

    // 3.1.4 — conteúdo (é CSV válido? ZIP com exatamente 1 entrada — reusa
    // 2.1.4). Delega toda a defesa de zip-bomb/path-traversal/múltiplas
    // entradas para hub-import-zip.js via resolverConteudoCsv.
    try {
      await validarConteudo(req.file.buffer, nomeOriginal);
    } catch (err) {
      if (err instanceof HubImportParseError) {
        return res.status(422).json({ error: 'INVALIDO', motivo: err.motivo || 'conteudo_invalido' });
      }
      throw err;
    }

    // 3.2.1 — sha256 do ARQUIVO recebido (bytes originais do upload — zip ou
    // csv —, não do conteúdo já extraído; é o que identifica "o mesmo envio"
    // no sentido do usuário, contracts/importacoes-api.md Cenário 2).
    const hashSha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    const claimsEntidade = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };

    // 3.2.2 — dedupe: UNIQUE(id_empresa, tipo, hash_sha256).
    const existentes = await hubPostgrestRequest(
      `ImportacaoArquivo?id_empresa=eq.${entidadeAtiva}&tipo=eq.${tipo}&hash_sha256=eq.${hashSha256}&select=id`,
      'GET',
      null,
      claimsEntidade
    );
    if (existentes && existentes.length > 0) {
      return res.status(409).json({ error: 'CONFLITO', importacaoOriginalId: existentes[0].id });
    }

    const nomeArquivoSanitizado = sanitizarNomeArquivo(nomeOriginal);

    // 3.3.2 — cria o cabeçalho ANTES de gravar em disco: o `id` gerado vira o
    // nome do diretório de armazenamento (nunca o nome do usuário).
    const inseridos = await hubPostgrestRequest(
      'ImportacaoArquivo',
      'POST',
      {
        id_empresa: entidadeAtiva,
        tipo,
        nome_arquivo: nomeArquivoSanitizado,
        hash_sha256: hashSha256,
        tamanho_bytes: req.file.buffer.length,
        status: 'pending',
        criado_por: payload.sub,
      },
      claimsEntidade
    );
    if (!inseridos || inseridos.length === 0) {
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    const importacaoId = inseridos[0].id;

    // 3.3.1 — armazenamento do original (fora de git/log, volume privado).
    // F10 (pós-review PR #57, LGPD) — grava com permissões restritas
    // (diretório 0700 / arquivo 0600) via helper compartilhado
    // (lib/hub-import-storage.js#armazenarOriginal).
    try {
      await armazenarOriginal(importacaoId, extensao, req.file.buffer);
    } catch (errStorage) {
      console.error('[hub-importacoes] falha ao armazenar original, marcando registro como failed:', errStorage.message);
      // F7 (pós-review PR #57) — ANTES fazia `DELETE`, mas `authenticated`
      // NÃO tem GRANT DELETE em `ImportacaoArquivo` (histórico é
      // append-only por desenho, migration 0011) — o DELETE sempre falhava
      // silenciosamente (capturado só pelo `.catch` de log abaixo) e o
      // registro ficava `pending` ÓRFÃO, sem arquivo em disco: o dedupe por
      // `hash_sha256` rejeitaria um novo upload do MESMO arquivo (409), e
      // nada reprocessa um `pending` sozinho — bloqueado até intervenção
      // manual. `UPDATE status='failed'` usa o GRANT UPDATE já concedido e
      // deixa um estado TERMINAL visível ao usuário, com `erro_resumo`
      // explicando o motivo; reprocessar um `failed` sem arquivo em disco
      // falha cedo com erro claro (`executarPipeline` -> `lerArquivo` ->
      // ENOENT -> "arquivo original inacessível" -> `failed` de novo, sem
      // loop).
      await hubPostgrestRequest(
        `ImportacaoArquivo?id=eq.${importacaoId}`,
        'PATCH',
        { status: 'failed', erro_resumo: 'falha ao armazenar o arquivo', concluido_em: new Date().toISOString() },
        claimsEntidade
      ).catch((e) => console.error('[hub-importacoes] marcação de failed após falha de armazenamento também falhou:', e.message));
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    // 3.4.1 — Auditoria (best-effort, nunca derruba a resposta de sucesso).
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao: 'importacao.criada',
      recurso: 'ImportacaoArquivo',
      recursoId: importacaoId,
      detalhes: { tipo, nomeArquivo: nomeArquivoSanitizado, tamanhoBytes: req.file.buffer.length },
      ip,
      claims: claimsEntidade,
    });

    // FASE 4 (tasks.md 4.1-4.6) — dispara o processamento (máquina de
    // estados pending->validating->processing->completed*/failed/
    // cancelled). Fire-and-forget deliberado: o contrato (201) já define o
    // efeito como "processamento inicia (ou aguarda lock)"; o processor
    // trata TODAS as falhas de negócio internamente (marca failed/
    // cancelled). Um erro aqui só pode ser bug do próprio processor — nunca
    // deve derrubar a resposta HTTP já decidida.
    processarImportacao({
      importacaoId,
      idEmpresa: entidadeAtiva,
      tipo,
      claims: claimsEntidade,
    }).catch((errProcessor) => {
      console.error('[hub-importacoes] falha inesperada no processamento assíncrono:', errProcessor.message);
    });

    return res.status(201).json({ id: importacaoId, status: 'pending' });
  } catch (e) {
    console.error('[hub-importacoes] erro em POST /importacoes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes — histórico paginado (task 5.1)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('importacoes.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    const { tipo, status, responsavel } = req.query;
    const { de, ate } = parseJanelaPadrao(req.query);
    const { page, pageSize, from, to } = parsePaginacao(req.query);

    const filtros = [`id_empresa=eq.${entidadeAtiva}`];
    if (tipo) filtros.push(`tipo=eq.${encodeURIComponent(tipo)}`);
    if (status) filtros.push(`status=eq.${encodeURIComponent(status)}`);
    if (responsavel) filtros.push(`criado_por=eq.${encodeURIComponent(responsavel)}`);
    if (de) filtros.push(`criado_em=gte.${encodeURIComponent(de)}`);
    if (ate) filtros.push(`criado_em=lte.${encodeURIComponent(ate)}`);
    // impeccable rodada 16 (h7): a ordem deixa de ser fixa. A allowlist vive
    // em `hub-ordenacao.js` — este valor é interpolado na URL do PostgREST.
    filtros.push(ordenacaoParaPostgrest(
      parseOrdenacao(req.query, ORDENAVEIS_IMPORTACOES, { coluna: 'criado_em', direcao: 'desc' })
    ));
    filtros.push(
      'select=id,tipo,status,nome_arquivo,total_linhas,linhas_validas,linhas_invalidas,'
      + 'data_referencia,criado_por,iniciado_em,concluido_em'
    );

    const { data: linhas, total } = await hubPostgrestRequest(
      `ImportacaoArquivo?${filtros.join('&')}`,
      'GET', null, claims,
      { count: true, range: { from, to } }
    );
    const itens = linhas || [];

    // aguardandoLock (dec-032/CHK013) — derivado: existe alguma importação
    // ATIVA (validating/processing) do MESMO (id_empresa,tipo)? Só consulta
    // se houver algum item `pending` na página (evita query extra à toa).
    const tiposPendentes = [...new Set(itens.filter((r) => r.status === 'pending').map((r) => r.tipo))];
    let tiposAtivos = new Set();
    if (tiposPendentes.length > 0) {
      const ativos = await hubPostgrestRequest(
        `ImportacaoArquivo?id_empresa=eq.${entidadeAtiva}&tipo=in.(${tiposPendentes.join(',')})`
        + '&status=in.(validating,processing)&select=tipo',
        'GET', null, claims
      );
      tiposAtivos = new Set((ativos || []).map((r) => r.tipo));
    }

    return res.status(200).json({
      items: itens.map((row) => mapImportacaoListItem(row, tiposAtivos)),
      total,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('[hub-importacoes] erro em GET /importacoes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes/:id — detalhe + progresso, polling (task 5.2)
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id', requirePermission('importacoes.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    // F11 (pós-review PR #57) — valida o FORMATO antes de converter:
    // `parseInt('123abc', 10)` retorna 123 (ignora lixo à direita) e
    // passaria pela checagem antiga de `Number.isFinite`.
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 5.2.2 — 404 se fora do escopo do token: filtro explícito por
    // id_empresa (defesa em profundidade — RLS já nega a linha via escopo).
    const linhas = await hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
      + '&select=id,tipo,status,total_linhas,linhas_validas,linhas_invalidas,'
      + 'data_referencia,iniciado_em,concluido_em,erro_resumo',
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    return res.status(200).json(mapImportacaoDetalhe(linhas[0]));
  } catch (e) {
    console.error('[hub-importacoes] erro em GET /importacoes/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes/:id/erros — erros paginados (+ ?format=csv) (task 5.3)
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id/erros', requirePermission('importacoes.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    // F11 (pós-review PR #57) — valida o FORMATO antes de converter:
    // `parseInt('123abc', 10)` retorna 123 (ignora lixo à direita) e
    // passaria pela checagem antiga de `Number.isFinite`.
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Confirma existência + escopo ANTES de listar erros — código correto é
    // 404 (não lista vazia silenciosa) para um id de outro tenant.
    const cabecalho = await hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
      'GET', null, claims
    );
    if (!cabecalho || cabecalho.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    const querySelect = 'importacao_id=eq.' + id
      + `&id_empresa=eq.${entidadeAtiva}&order=numero_linha.asc`
      + '&select=numero_linha,campo,motivo,valor_mascarado';

    // 5.3.2 — format=csv: relatório completo (sem paginação), mesmo padrão
    // de um export/download. valorMascarado já é mascarado pelo processor
    // (LGPD, 4.5); a proteção de CSV injection (5.3.2/5.3.3) é aplicada por
    // `gerarCsvErros` em CIMA do valor mascarado (defesa em profundidade —
    // `mascararValor` preserva o 1º/último char, então ainda pode começar
    // com `=`/`+`/`-`/`@`).
    if (req.query.format === 'csv') {
      const todos = await hubPostgrestRequest(`ImportacaoLinhaErro?${querySelect}`, 'GET', null, claims);
      const csv = gerarCsvErros((todos || []).map(mapErroItem));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="importacao-${id}-erros.csv"`);
      return res.status(200).send(csv);
    }

    const { page, pageSize, from, to } = parsePaginacao(req.query);
    const { data: linhas, total } = await hubPostgrestRequest(
      `ImportacaoLinhaErro?${querySelect}`,
      'GET', null, claims,
      { count: true, range: { from, to } }
    );
    return res.status(200).json({ items: (linhas || []).map(mapErroItem), total, page, pageSize });
  } catch (e) {
    console.error('[hub-importacoes] erro em GET /importacoes/:id/erros:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /importacoes/:id/original — download do arquivo original (task 5.4)
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id/original', requirePermission('importacoes.exportar'), async (req, res) => {
  try {
    // 5.4.2 — permissão DISTINTA de `consultar`: papel só-leitura (sem
    // `exportar`) recebe 403 já no `requirePermission` de nível de rota
    // acima; a checagem por-entidade abaixo cobre o caso de grant só em
    // OUTRA empresa (achado #1).
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.exportar');
    if (!ctx) return;
    const { payload, entidadeAtiva, claims } = ctx;

    // F11 (pós-review PR #57) — valida o FORMATO antes de converter:
    // `parseInt('123abc', 10)` retorna 123 (ignora lixo à direita) e
    // passaria pela checagem antiga de `Number.isFinite`.
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    const linhas = await hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,nome_arquivo`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    const nomeArquivo = linhas[0].nome_arquivo || '';
    const extensao = extensaoDe(nomeArquivo);
    const caminho = caminhoArmazenamento(id, extensao);

    let buffer;
    try {
      buffer = await fs.readFile(caminho);
    } catch (errLeitura) {
      // 5.4.3 — CHK021 (resolvido): código de erro EXPLÍCITO (410, não 500
      // genérico) quando o arquivo físico originalmente retido não está mais
      // disponível. Ver atualização de contracts/importacoes-api.md.
      if (errLeitura.code === 'ENOENT') {
        return res.status(410).json({
          erro: 'ARQUIVO_INDISPONIVEL',
          motivo: 'arquivo_original_nao_encontrado_no_armazenamento',
        });
      }
      throw errLeitura;
    }

    // 5.7.3 — Auditoria só no download BEM-SUCEDIDO (200); best-effort, mas
    // aguardado (evita perder o registro se o processo encerrar logo após o
    // send da resposta).
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao: 'importacao.original_baixado',
      recurso: 'ImportacaoArquivo',
      recursoId: id,
      detalhes: { nomeArquivo },
      ip: req.ip,
      claims,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo || `original${extensao}`}"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[hub-importacoes] erro em GET /importacoes/:id/original:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /importacoes/:id/reprocessar (task 5.5)
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/reprocessar', requirePermission('importacoes.criar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.criar');
    if (!ctx) return;
    const { payload, entidadeAtiva, claims } = ctx;

    // F11 (pós-review PR #57) — valida o FORMATO antes de converter:
    // `parseInt('123abc', 10)` retorna 123 (ignora lixo à direita) e
    // passaria pela checagem antiga de `Number.isFinite`.
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 5.5.1/5.5.2 — reset atômico GUARDADO por status (mesmo espírito do
    // mutex de 4.2: um UPDATE condicional via PostgREST; `status=in.(...)`
    // só casa se AINDA está failed/cancelled — corrida entre 2 cliques
    // resolve para exatamente 1 vencedor). Reusa o MESMO
    // `ImportacaoArquivo.id` (dec-010/research.md Decision 6 — criar novo
    // colidiria com UNIQUE(id_empresa,tipo,hash_sha256)).
    const patched = await hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&status=in.(failed,cancelled)`,
      'PATCH',
      {
        status: 'pending',
        total_linhas: null,
        linhas_validas: null,
        linhas_invalidas: null,
        erro_resumo: null,
        iniciado_em: null,
        concluido_em: null,
        data_referencia: null,
      },
      claims
    );

    if (!patched || patched.length === 0) {
      const existe = await hubPostgrestRequest(
        `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
        'GET', null, claims
      );
      if (!existe || existe.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      // 5.5.1 — existe, mas não estava em failed/cancelled (ex.: completed*
      // -> "correção entra como arquivo novo", contrato).
      return res.status(409).json({ error: 'CONFLITO' });
    }

    const { tipo } = patched[0];

    // 5.5.2 — limpa os erros da tentativa anterior (migration 0017 — GRANT
    // DELETE escopado, dec-045). Best-effort NÃO se aplica aqui: se a
    // limpeza falhar, o reprocessamento seguiria com erros obsoletos
    // misturados aos novos — propaga o erro (500) em vez de mascarar.
    await hubPostgrestRequest(
      `ImportacaoLinhaErro?importacao_id=eq.${id}&id_empresa=eq.${entidadeAtiva}`,
      'DELETE', null, claims, { returnMinimal: true }
    );

    // 5.7.1
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao: 'importacao.reprocessada',
      recurso: 'ImportacaoArquivo',
      recursoId: id,
      detalhes: { tipo },
      ip: req.ip,
      claims,
    });

    // Fire-and-forget — mesmo padrão de POST / (contrato já define o efeito
    // como "processamento inicia"; falhas de negócio são tratadas
    // internamente pelo processor, marcando failed/cancelled de novo).
    processarImportacao({ importacaoId: id, idEmpresa: entidadeAtiva, tipo, claims }).catch((errProcessor) => {
      console.error('[hub-importacoes] falha inesperada no reprocessamento assíncrono:', errProcessor.message);
    });

    return res.status(202).json({ id, status: 'pending' });
  } catch (e) {
    console.error('[hub-importacoes] erro em POST /importacoes/:id/reprocessar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /importacoes/:id/cancelar (task 5.6)
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/cancelar', requirePermission('importacoes.criar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'importacoes.criar');
    if (!ctx) return;
    const { payload, entidadeAtiva, claims } = ctx;

    // F11 (pós-review PR #57) — valida o FORMATO antes de converter:
    // `parseInt('123abc', 10)` retorna 123 (ignora lixo à direita) e
    // passaria pela checagem antiga de `Number.isFinite`.
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 5.6.1/CHK023 — MESMO mecanismo de detecção já testado em 4.6: um
    // UPDATE atômico guardado por status. Se `status ∈
    // {pending,validating,processing}`, vira `cancelled` aqui mesmo; se já
    // estava `validating`/`processing`, o loop do processor (foiCancelado,
    // entre lotes) vai notar essa mudança e finalizar com os contadores
    // corretos (marcarCancelled) — sem conflito, o UPDATE dele é
    // incondicional por id e roda DEPOIS.
    const patched = await hubPostgrestRequest(
      `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&status=in.(pending,validating,processing)`,
      'PATCH',
      { status: 'cancelled', concluido_em: new Date().toISOString() },
      claims
    );

    if (!patched || patched.length === 0) {
      const existe = await hubPostgrestRequest(
        `ImportacaoArquivo?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
        'GET', null, claims
      );
      if (!existe || existe.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      return res.status(409).json({ error: 'CONFLITO' });
    }

    // 5.7.2
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao: 'importacao.cancelada',
      recurso: 'ImportacaoArquivo',
      recursoId: id,
      detalhes: {},
      ip: req.ip,
      claims,
    });

    return res.status(202).json({ id, status: 'cancelled' });
  } catch (e) {
    console.error('[hub-importacoes] erro em POST /importacoes/:id/cancelar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  extensaoDe,
  sanitizarNomeArquivo,
  caminhoArmazenamento,
  validarConteudo,
  resolverContextoEntidade,
  idValido,
  UPLOADS_DIR,
  ORDENAVEIS_IMPORTACOES,
};
