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

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { requirePermission } = require('../middleware/hub-require-permission');
const {
  HubImportParseError,
  resolverConteudoCsv,
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
} = require('../lib/hub-import-storage');
// FASE 4 — dispara o processamento (máquina de estados + lotes) logo após
// criar o registro `pending` e persistir o arquivo (research.md Decision 10:
// "processamento síncrono em chunks... ou disparado logo após criar o
// registro"). Fire-and-forget: a resposta 201 já está decidida pelo
// contrato: cliente acompanha via GET /importacoes/:id (polling, FASE 5).
const { processarImportacao } = require('../lib/hub-import-processor');

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

function decodificarAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    // Decision 12 (owasp-security) — pinagem de algoritmo obrigatória.
    return jwt.verify(accessToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_e) {
    return null;
  }
}

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
 * Valida que o conteúdo é minimamente um CSV/ZIP legível: resolve o ZIP (se
 * for o caso — reusa 2.1.4, inclusive as defesas de path-traversal/zip-bomb/
 * múltiplas entradas) e confirma que há ao menos 1 linha decodificável.
 * NÃO valida o header aqui (isso é responsabilidade do processamento —
 * FASE 4, contracts/importacoes-api.md "cabeçalho errado -> failed").
 * @returns {Promise<Buffer>} conteúdo CSV resolvido
 * @throws {HubImportParseError}
 */
async function validarConteudo(buffer, nomeArquivo) {
  const conteudo = resolverConteudoCsv(buffer, { nomeArquivo });
  if (!conteudo || conteudo.length === 0) {
    throw new HubImportParseError('Conteúdo vazio após resolução', 'conteudo_vazio');
  }
  const stream = bufferParaStream(conteudo);
  let temLinha = false;
  // eslint-disable-next-line no-unused-vars
  for await (const _linha of iterarLinhas(stream)) {
    temLinha = true;
    break;
  }
  if (!temLinha) {
    throw new HubImportParseError('Nenhuma linha decodificável no conteúdo', 'conteudo_vazio');
  }
  return conteudo;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /importacoes (task 3.1-3.4)
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requirePermission('importacoes.criar'), uploadSingle, async (req, res) => {
  const ip = req.ip;
  const accessToken = req.cookies && req.cookies.accessToken;
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
    try {
      const destino = caminhoArmazenamento(importacaoId, extensao);
      await fs.mkdir(path.dirname(destino), { recursive: true });
      await fs.writeFile(destino, req.file.buffer);
    } catch (errStorage) {
      console.error('[hub-importacoes] falha ao armazenar original, revertendo registro:', errStorage.message);
      // Best-effort: sem o arquivo em disco a importação nunca poderá ser
      // processada/reprocessada — reverte o cabeçalho para não deixar um
      // registro `pending` órfão, sem CSV correspondente.
      await hubPostgrestRequest(
        `ImportacaoArquivo?id=eq.${importacaoId}`,
        'DELETE',
        null,
        claimsEntidade
      ).catch((e) => console.error('[hub-importacoes] rollback do registro também falhou:', e.message));
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

module.exports = {
  router,
  // exportados para testes unitários
  extensaoDe,
  sanitizarNomeArquivo,
  caminhoArmazenamento,
  validarConteudo,
  UPLOADS_DIR,
};
