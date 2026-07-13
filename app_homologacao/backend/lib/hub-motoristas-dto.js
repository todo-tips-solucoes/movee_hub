/**
 * hub-motoristas-dto.js — helpers PUROS (sem I/O) de borda de API para
 * FASE 3 (tasks.md 3.1/3.2): paginação (mesmo padrão de
 * hub-importacoes-dto.js#parsePaginacao), normalização de nome
 * tolerante-a-acento (equivalente funcional de `hub_normaliza_nome()` do
 * banco, mas em JS — usada para filtrar/agrupar já resolvido no lado do
 * Node, ver cabeçalho de routes/hub-motoristas.js), mapeamento
 * snake_case -> camelCase (item de lista e detalhe) e máscara de CNPJ
 * (LGPD, contracts/motoristas-api.md §Mascaramento de CNPJ).
 *
 * Extraído para arquivo próprio (não inline em routes/hub-motoristas.js)
 * para ser testável isoladamente sem PostgREST/DB real (node --test), mesmo
 * padrão de lib/hub-importacoes-dto.js.
 *
 * Ref: contracts/motoristas-api.md, data-model.md.
 */

'use strict';

const { uuidValido } = require('./hub-import-normalizer');

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/**
 * Parseia `page`/`pageSize` da query (mesma semântica de
 * hub-importacoes-dto.js#parsePaginacao — 0-indexed/inclusive `from`/`to`
 * para uso opcional com paginação Range do PostgREST). `page` < 1 ou não
 * numérico -> 1. `pageSize` fora de [1, PAGE_SIZE_MAX] -> clamp/default.
 * @param {object} query - `req.query`
 * @returns {{page:number, pageSize:number, from:number, to:number}}
 */
function parsePaginacao(query) {
  const pageParsed = parseInt(query && query.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const pageSizeParsed = parseInt(query && query.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

/**
 * Normaliza um texto para comparação tolerante a acento/caixa: remove
 * diacríticos (NFD + strip de marcas combinantes) e lowercase. NÃO precisa
 * ser byte-a-byte idêntico a `hub_normaliza_nome()` (SQL, `lower(unaccent(...))`)
 * — só funcionalmente equivalente para o propósito de filtro em memória
 * (contracts/motoristas-api.md §GET /motoristas, "busca parcial, normalizada").
 * @param {string|null|undefined} texto
 * @returns {string}
 */
function normalizarNome(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * @param {string|null|undefined} termo - termo de busca (query `nome`)
 * @param {string|null|undefined} nomeArmazenado - `Entregador.nome`
 * @returns {boolean} `true` se `nomeArmazenado` contém `termo`, ambos
 *   normalizados (case/acento-insensitive).
 */
function nomeCasa(termo, nomeArmazenado) {
  const termoNorm = normalizarNome(termo);
  if (!termoNorm) return true;
  return normalizarNome(nomeArmazenado).includes(termoNorm);
}

/**
 * @param {string|null|undefined} area - termo de área (query `area`)
 * @param {Array<{subpraca:string}>} areasDoEntregador
 * @returns {boolean} `true` se QUALQUER área do entregador casa com `area`
 *   (comparação normalizada, igualdade — não substring, subpraça é um valor
 *   discreto, FR-002/Clarification Q2).
 */
function areaCasa(area, areasDoEntregador) {
  const areaNorm = normalizarNome(area);
  if (!areaNorm) return true;
  return (areasDoEntregador || []).some((a) => normalizarNome(a.subpraca) === areaNorm);
}

/**
 * Mapeia o mapa de áreas cru (linhas de `hub_areas_por_entregador`) para
 * `Map<entregadorId, Array<{subpraca, dataMaisRecente}>>`, já ordenado por
 * `dataMaisRecente` DESC dentro de cada entregador (contracts/motoristas-api.md
 * "areas ordenado por dataMaisRecente DESC").
 * @param {Array<{entregador_id:number, subpraca:string, data_mais_recente:string}>} linhas
 * @returns {Map<number, Array<{subpraca:string, dataMaisRecente:string}>>}
 */
function agruparAreasPorEntregador(linhas) {
  const mapa = new Map();
  for (const row of linhas || []) {
    const lista = mapa.get(row.entregador_id) || [];
    lista.push({ subpraca: row.subpraca, dataMaisRecente: row.data_mais_recente });
    mapa.set(row.entregador_id, lista);
  }
  for (const lista of mapa.values()) {
    lista.sort((a, b) => (a.dataMaisRecente < b.dataMaisRecente ? 1 : a.dataMaisRecente > b.dataMaisRecente ? -1 : 0));
  }
  return mapa;
}

/**
 * Mapeia 1 linha `Entregador` (snake_case/PostgREST) + suas áreas para o
 * shape de item de listagem do contrato (`GET /motoristas`).
 * @param {{id:number, nome:string, ativo:boolean, motorista_id:number|null, id_externo:string}} row
 * @param {Array<{subpraca:string, dataMaisRecente:string}>} areas
 */
function mapMotoristaListItem(row, areas = []) {
  return {
    id: row.id,
    nome: row.nome,
    idExterno: row.id_externo,
    ativo: row.ativo,
    comVinculo: row.motorista_id !== null && row.motorista_id !== undefined,
    areas: areas.map((a) => a.subpraca),
  };
}

/**
 * Mapeia o detalhe completo (`GET /motoristas/:id`) — combina a linha do
 * `Entregador` (com embed opcional de `ContaMotorista`), a lista de áreas já
 * ordenada e o resumo de indicadores all-time.
 * @param {object} row - linha do Entregador (+ embed `ContaMotorista`)
 * @param {Array<{subpraca:string, dataMaisRecente:string}>} areas
 * @param {{totalFaturamento:number, totalPerformance:number, dataMaisRecente:string|null}} resumo
 */
function mapMotoristaDetalhe(row, areas, resumo, atividades) {
  const contaMotorista = row.ContaMotorista || null;
  return {
    id: row.id,
    nome: row.nome,
    idExterno: row.id_externo,
    ativo: row.ativo,
    nomeEditadoManualmente: !!row.nome_editado_manualmente,
    areas: areas || [],
    resumo: {
      totalFaturamento: (resumo && resumo.totalFaturamento) || 0,
      totalPerformance: (resumo && resumo.totalPerformance) || 0,
      dataMaisRecente: (resumo && resumo.dataMaisRecente) || null,
    },
    vinculo: contaMotorista
      ? {
        contaMotoristaId: contaMotorista.id,
        nome: contaMotorista.nome,
        cnpjPrestadorMascarado: mascararCnpj(contaMotorista.cnpj_prestador),
        // FASE 5 (task 5.5) — estado REAL da credencial de acesso
        // (ContaMotorista.ativo, existente desde 0021_conta_motorista.sql),
        // exposto no detalhe para a UI de "Ativar/Desativar credencial"
        // (PATCH /:id/credencial) refletir o servidor em vez de adivinhar.
        ativo: !!contaMotorista.ativo,
      }
      : null,
    // FASE 6 (task 6.4) — histórico read-only de atividades correlacionadas
    // por uuid (faturamento/performance/validação de NF), paginação técnica
    // offset/limit (dec-046). Sempre presente (mesmo shape) mesmo quando o
    // caller (GET /:id) não pediu atividades — nesse caso `atividades` é
    // `undefined` e cai no default abaixo (motorista sem atividades
    // consultadas -> items:[] sem erro, task 6.4.4).
    atividades: atividades || { items: [], total: 0, offset: 0, limit: 0 },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 6 (task 6.4) — histórico de atividades (GET /motoristas/:id, seção
// "Atividades"): união read-only de 3 fontes já existentes (FaturamentoLancamento,
// PerformanceTurno, EnvioMassa/validação de NF), correlacionadas por
// Entregador.id_externo (uuid) — data-model.md §Entity Atividade. Extraído
// para ser testável isoladamente sem PostgREST/DB real, mesmo padrão do
// resto deste arquivo.
// ────────────────────────────────────────────────────────────────────────────

const ATIVIDADES_LIMIT_DEFAULT = 20;
const ATIVIDADES_LIMIT_MAX = 100;

/**
 * Paginação técnica offset/limit do histórico de atividades (dec-046,
 * Gap CHK018/CHK038 — tasks.md 6.4.1). `offset`/`limit` inválidos ou
 * ausentes caem no default — nunca erro (mesmo espírito de `parsePaginacao`).
 * @param {object} query - `req.query`
 * @returns {{offset:number, limit:number}}
 */
function parsePaginacaoAtividades(query) {
  const offsetParsed = parseInt(query && query.offset, 10);
  const offset = Number.isFinite(offsetParsed) && offsetParsed >= 0 ? offsetParsed : 0;

  const limitParsed = parseInt(query && query.limit, 10);
  const limit = Number.isFinite(limitParsed) && limitParsed >= 1
    ? Math.min(limitParsed, ATIVIDADES_LIMIT_MAX)
    : ATIVIDADES_LIMIT_DEFAULT;

  return { offset, limit };
}

/** @param {{data_referencia:string, descricao:string|null, valor:number|string|null}} row */
function mapFaturamentoAtividade(row) {
  return {
    tipo: 'faturamento',
    data: row.data_referencia,
    descricao: row.descricao || null,
    valor: row.valor != null ? Number(row.valor) : null,
  };
}

/** @param {{data_periodo:string, periodo:string|null, subpraca:string|null}} row */
function mapPerformanceAtividade(row) {
  return {
    tipo: 'performance',
    data: row.data_periodo,
    descricao: row.periodo || row.subpraca || null,
    valor: null,
  };
}

/** @param {{data_emissao:string|null, criado_em:string|null, numnota:string|null, valor:number|string|null}} row */
function mapValidacaoNfAtividade(row) {
  return {
    tipo: 'validacao_nf',
    data: row.data_emissao || row.criado_em || null,
    descricao: row.numnota || null,
    valor: row.valor != null ? Number(row.valor) : null,
  };
}

// hub-motorista-canonico (FASE 7, gap encontrado no code-review de
// fechamento): a EnvioMassa armazena `cnpj_prestador` em DOIS formatos
// (só-dígitos e com máscara `XX.XXX.XXX/XXXX-XX`, dependendo da origem do
// import) — o mesmo problema já resolvido em `routes/motorista.js#L117`
// (`cnpjEnvioMassaFilter`, usado por `/movimento-aberto` e
// `/validar-nota`). A correlação de atividades por uuid (task 6.4,
// `buscarAtividadesMotorista` abaixo) usava um `eq.<só-dígitos>` simples
// contra `cnpj_prestador` — linhas históricas gravadas com o CNPJ mascarado
// (upload legado) ficavam invisíveis no histórico do motorista mesmo tendo
// `entregador_uuid` correto, uma perda silenciosa de FR-022 (completude do
// histórico). Duplicado deliberadamente aqui (função pura, sem estado) em
// vez de importar de `routes/motorista.js` — evita criar um acoplamento
// novo com a rota de PRODUÇÃO legada do app motorista só para reusar uma
// função de 8 linhas; qualquer drift entre as duas cópias é pego por
// `hub-motoristas-dto.test.js`.
function cnpjEnvioMassaFilter(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  const valores = [d];
  if (d.length === 14) {
    valores.push(`${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`);
  }
  const lista = valores.map((v) => `"${v}"`).join(',');
  return `cnpj_prestador=in.(${encodeURIComponent(lista)})`;
}

/**
 * Une as 3 fontes já bounded-fetched (cada uma ordenada desc, com pelo menos
 * `offset+limit` linhas quando existirem — mitigação de performance 6.4.5:
 * evita full scan, cada fonte já chega aqui limitada), ordena o conjunto
 * unificado desc por `data` e fatia a janela [offset, offset+limit) — mesmo
 * princípio de um k-way merge bounded: a página correta é sempre um
 * subconjunto do topo (offset+limit) de cada fonte individual.
 * @param {object[]} faturRows - linhas cruas de FaturamentoLancamento
 * @param {object[]} perfRows - linhas cruas de PerformanceTurno
 * @param {object[]} validRows - linhas cruas de EnvioMassa (correlacionadas por entregador_uuid)
 * @param {number} total - contagem EXATA das 3 fontes (count=exact, sem full scan)
 * @param {number} offset
 * @param {number} limit
 * @returns {{items:object[], total:number, offset:number, limit:number}}
 */
function montarAtividades(faturRows, perfRows, validRows, total, offset, limit) {
  const unificado = [
    ...(faturRows || []).map(mapFaturamentoAtividade),
    ...(perfRows || []).map(mapPerformanceAtividade),
    ...(validRows || []).map(mapValidacaoNfAtividade),
  ];
  unificado.sort((a, b) => {
    if (a.data === b.data) return 0;
    if (a.data == null) return 1;
    if (b.data == null) return -1;
    return a.data < b.data ? 1 : -1;
  });
  const items = unificado.slice(offset, offset + limit);
  return { items, total: total || 0, offset, limit };
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 4 — PATCH /motoristas/:id (task 4.1): allowlist estrita do corpo
// (contracts/motoristas-api.md §PATCH, research.md Decision 12 — guarda
// anti mass-assignment/BOPLA). Extraído para função pura testável sem
// PostgREST/Express real, mesmo padrão do resto deste arquivo.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai SOMENTE `nome`/`ativo` do corpo cru da requisição — qualquer
 * outra chave (`motoristaId`, `id`, `idEmpresa`, `nomeEditadoManualmente`,
 * etc.) é ignorada, nunca repassada ao PostgREST (allowlist estrita,
 * contracts/motoristas-api.md §PATCH).
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, patch:object, camposAlterados:string[]}|{ok:false, erro:'VAZIO'|'INVALIDO'}}
 *   `ok:false, erro:'VAZIO'` — nem `nome` nem `ativo` presentes no corpo (nada a alterar).
 *   `ok:false, erro:'INVALIDO'` — `nome` presente mas vazio/só espaços (422).
 *   `ok:true` — `patch` é o objeto pronto para o PATCH no PostgREST
 *   (snake_case; inclui `nome_editado_manualmente:true` quando `nome` muda) e
 *   `camposAlterados` é a lista (para o detalhe de auditoria).
 */
function validarPatchMotorista(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const temNome = Object.prototype.hasOwnProperty.call(corpo, 'nome');
  const temAtivo = Object.prototype.hasOwnProperty.call(corpo, 'ativo');

  if (!temNome && !temAtivo) {
    return { ok: false, erro: 'VAZIO' };
  }

  const patch = {};
  const camposAlterados = [];

  if (temNome) {
    const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
    if (!nome) {
      return { ok: false, erro: 'INVALIDO' };
    }
    patch.nome = nome;
    patch.nome_editado_manualmente = true;
    camposAlterados.push('nome');
  }

  if (temAtivo) {
    if (typeof corpo.ativo !== 'boolean') {
      return { ok: false, erro: 'INVALIDO' };
    }
    patch.ativo = corpo.ativo;
    camposAlterados.push('ativo');
  }

  return { ok: true, patch, camposAlterados };
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 4 — POST /motoristas (task 4.2.2/4.2.3): allowlist estrita do corpo
// (mandato S2, contracts/api-motorista-canonico.md §POST /motoristas). Mesmo
// padrão de `validarPatchMotorista`/`validarVinculoBody`: função PURA
// testável sem PostgREST/Express real. SOMENTE `nome` + `idExterno`
// influenciam o INSERT — `id_empresa` é resolvido pelo caller a partir do
// contexto do token (`resolverContextoEntidade`), NUNCA lido do corpo aqui;
// qualquer outra chave do corpo (`ativo`, `motoristaId`, `id`, `idEmpresa`
// etc.) é simplesmente ignorada (nunca lida por esta função, nunca chega ao
// PostgREST — D-C6/FR-012).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai `nome`/`idExterno` do corpo cru de `POST /motoristas`.
 * `idExterno` é SEMPRE obrigatório (FR-012, D-C6, sem geração automática de
 * identificador — FR-014) e validado com `uuidValido`
 * (lib/hub-import-normalizer.js:233). Normaliza para minúsculas (mesma
 * convenção de `lib/hub-import-processor.js` no pipeline de importação —
 * garante que um uuid cadastrado manualmente aqui casa com o mesmo uuid
 * vindo depois de uma planilha, independente da caixa usada por quem digitou).
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, nome:string, idExterno:string}|{ok:false, erro:'nome_invalido'|'uuid_invalido'}}
 *   `ok:false, erro:'nome_invalido'` — `nome` ausente/vazio/só espaços.
 *   `ok:false, erro:'uuid_invalido'` — `idExterno` ausente ou fora do formato uuid.
 */
function validarCriacaoMotorista(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};

  const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
  if (!nome) {
    return { ok: false, erro: 'nome_invalido' };
  }

  const idExternoBruto = typeof corpo.idExterno === 'string' ? corpo.idExterno.trim() : '';
  if (!uuidValido(idExternoBruto)) {
    return { ok: false, erro: 'uuid_invalido' };
  }

  return { ok: true, nome, idExterno: idExternoBruto.toLowerCase() };
}

// ────────────────────────────────────────────────────────────────────────────
// Máscara de CNPJ (LGPD, contracts/motoristas-api.md §Mascaramento de CNPJ)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Formato `NN.xxx.xxx/NNNN-xx` (x = asterisco mascarado) — mantém os 2 primeiros dígitos e os 4
 * dígitos do bloco "ordem/filial" (posições 9-12 de um CNPJ de 14 dígitos),
 * mascara o resto. Normaliza a entrada para dígitos puros ANTES de fatiar
 * (a entrada pode vir formatada `12.345.678/0001-95` ou só dígitos
 * `12345678000195` — `ContaMotorista.cnpj_prestador` é gerado por
 * `Anon.fake_cnpj()`, que produz só dígitos, mas a função normaliza de
 * qualquer forma para ser robusta a mudança de formato de origem).
 * Entrada inválida/curta (menos de 14 dígitos) -> `null` (nunca lança, nunca
 * expõe o valor bruto).
 * @param {string|null|undefined} cnpjBruto
 * @returns {string|null}
 */
function mascararCnpj(cnpjBruto) {
  if (cnpjBruto === null || cnpjBruto === undefined) return null;
  const digitos = String(cnpjBruto).replace(/\D/g, '');
  if (digitos.length !== 14) return null;
  const prefixo = digitos.slice(0, 2);
  const ordemFilial = digitos.slice(8, 12);
  return `${prefixo}.***.***/${ordemFilial}-**`;
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 6 — POST /motoristas/:id/vinculo (task 6.1.1): allowlist estrita do
// corpo (contracts/motoristas-api.md §POST vinculo, research.md Decision 12,
// mesmo padrão de `validarPatchMotorista`).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai o corpo de `POST /motoristas/:id/vinculo`. `contaMotoristaId`
 * é o ÚNICO campo que influencia o `UPDATE` (allowlist estrita — qualquer
 * outro campo é ignorado no INSERT/UPDATE real). `origem` é um campo
 * ADITIVO, opcional, lido só para preencher `detalhes.origem` da auditoria
 * `motorista.vinculado` (research.md Decision 9) — NUNCA chega ao PostgREST,
 * nunca influencia a escrita em `Entregador`. Valor fora de
 * `{sugestao, busca_manual}` (ausente/mal-formado) -> `"nao_informado"`,
 * nunca rejeita a requisição por causa dele.
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, contaMotoristaId:number, origem:string}|{ok:false, erro:'INVALIDO'}}
 *   `ok:false` — `contaMotoristaId` ausente/não é inteiro positivo (422).
 */
function validarVinculoBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const bruto = corpo.contaMotoristaId;
  const strBruto = (typeof bruto === 'number' && Number.isFinite(bruto)) || typeof bruto === 'string'
    ? String(bruto)
    : '';
  if (!/^\d+$/.test(strBruto)) {
    return { ok: false, erro: 'INVALIDO' };
  }
  const contaMotoristaId = parseInt(strBruto, 10);
  const origem = corpo.origem === 'sugestao' || corpo.origem === 'busca_manual' ? corpo.origem : 'nao_informado';
  return { ok: true, contaMotoristaId, origem };
}

// ────────────────────────────────────────────────────────────────────────────
// FASE 5 — Credencial de acesso ao app do motorista (tasks.md 5.1/5.2/5.3):
// allowlist estrita do corpo de POST/PATCH .../credencial* (mandato S2,
// mesmo padrão de `validarPatchMotorista`/`validarVinculoBody` acima —
// função PURA testável sem PostgREST/Express real).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida e extrai `cnpjPrestador`/`senhaInicial` do corpo cru de
 * `POST /motoristas/:id/credencial`. Allowlist estrita (5.1.2): qualquer
 * outra chave do corpo (ex.: `ativo`) é ignorada, nunca lida por esta
 * função, nunca chega ao PostgREST.
 *
 * `cnpjPrestador` é SEMPRE obrigatório, normalizado para só-dígitos (mesma
 * convenção de `onlyDigitsLogin` em routes/motorista.js). `senhaInicial` é
 * OPCIONAL — quando ausente/`undefined`/`null`, o caller (rota) gera uma
 * senha temporária de alta entropia; quando presente, precisa ter pelo
 * menos 8 caracteres (mesmo mínimo do `/register` legado e do
 * `/redefinir-senha` do hub).
 *
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, cnpjPrestador:string, senhaInicial?:string}|{ok:false, erro:'cnpj_invalido'|'senha_invalida'}}
 */
function validarCriacaoCredencialBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};

  const cnpjBruto = typeof corpo.cnpjPrestador === 'string' ? corpo.cnpjPrestador : '';
  const cnpjPrestador = cnpjBruto.replace(/\D/g, '');
  if (!cnpjPrestador) {
    return { ok: false, erro: 'cnpj_invalido' };
  }

  const temSenhaInicial = Object.prototype.hasOwnProperty.call(corpo, 'senhaInicial')
    && corpo.senhaInicial !== undefined && corpo.senhaInicial !== null;
  if (!temSenhaInicial) {
    return { ok: true, cnpjPrestador };
  }

  if (typeof corpo.senhaInicial !== 'string' || corpo.senhaInicial.length < 8) {
    return { ok: false, erro: 'senha_invalida' };
  }
  return { ok: true, cnpjPrestador, senhaInicial: corpo.senhaInicial };
}

/**
 * Valida e extrai SOMENTE `ativo` do corpo cru de
 * `PATCH /motoristas/:id/credencial` — allowlist estrita (5.3.1), mesmo
 * padrão de `validarPatchMotorista`.
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, ativo:boolean}|{ok:false, erro:'INVALIDO'}}
 */
function validarPatchCredencialBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  if (typeof corpo.ativo !== 'boolean') {
    return { ok: false, erro: 'INVALIDO' };
  }
  return { ok: true, ativo: corpo.ativo };
}

/**
 * Valida e extrai `token`/`novaSenha` do corpo cru de
 * `POST /motoristas/:id/credencial/reset-senha/definir` (gap-fill CHK011 —
 * ver cabeçalho de routes/hub-motoristas.js §credencial). Allowlist
 * estrita: só estas duas chaves influenciam a rota. Validação PURA de
 * FORMATO apenas (tipo/tamanho) — a validação de NEGÓCIO (hash bate?
 * expirou?) é responsabilidade da rota, nunca desta função.
 * @param {object} corpoCru - `req.body`
 * @returns {{ok:true, token:string, novaSenha:string}|{ok:false, erro:'token_ausente'|'senha_invalida'}}
 */
function validarDefinirSenhaCredencialBody(corpoCru) {
  const corpo = corpoCru && typeof corpoCru === 'object' ? corpoCru : {};
  const token = typeof corpo.token === 'string' ? corpo.token.trim() : '';
  if (!token) {
    return { ok: false, erro: 'token_ausente' };
  }
  const novaSenha = typeof corpo.novaSenha === 'string' ? corpo.novaSenha : '';
  if (novaSenha.length < 8) {
    return { ok: false, erro: 'senha_invalida' };
  }
  return { ok: true, token, novaSenha };
}

module.exports = {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  parsePaginacao,
  normalizarNome,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
  validarPatchMotorista,
  validarCriacaoMotorista,
  mascararCnpj,
  validarVinculoBody,
  validarCriacaoCredencialBody,
  validarPatchCredencialBody,
  validarDefinirSenhaCredencialBody,
  parsePaginacaoAtividades,
  mapFaturamentoAtividade,
  mapPerformanceAtividade,
  mapValidacaoNfAtividade,
  montarAtividades,
  cnpjEnvioMassaFilter,
};
