/**
 * adiantamento-dto.js — helpers PUROS (sem I/O) de borda de API do módulo
 * Adiantamento (tasks.md FASE 2, 2.5): mapeia linhas snake_case (PostgREST/
 * data-model.md) para os shapes camelCase de `contracts/hub-api.md` e
 * `contracts/motorista-api.md`. Mesmo padrão de `lib/hub-faturamento-dto.js`
 * (mapper testável isoladamente, sem PostgREST/DB real).
 *
 * Convenção de dinheiro (plan.md §Convenções de Borda): toda quantia sai
 * como string decimal de 2 casas (`^-?\d+\.\d{2}$`). `dinheiro()` reusa
 * `paraCentavos`/`formatarCentavos` de `lib/adiantamento-remanescente.js`
 * (dec-063/2.7) em vez de reimplementar arredondamento — funciona tanto para
 * valores já `numeric::text` do PostgREST quanto para Number vindo de libs
 * puras (ex.: `calcularLinhaRemanescente`).
 *
 * Ref: contracts/hub-api.md, contracts/motorista-api.md, data-model.md,
 * contracts/sql-rpc.md (formato `ADV-NNNNNN`).
 */

'use strict';

const { paraCentavos, formatarCentavos } = require('./adiantamento-remanescente');
const { documentoMascarado, contaMascarada } = require('./adiantamento-conta');

const REGEX_DINHEIRO = /^-?\d+\.\d{2}$/;

/** Dinheiro sempre como string decimal de 2 casas — nunca `null`/`undefined`
 * viram `"0.00"` por engano (ficam `null`, "sem valor" é diferente de zero). */
function dinheiro(valor) {
  if (valor === null || valor === undefined) return null;
  return formatarCentavos(paraCentavos(valor));
}

/** `ADV-NNNNNN` (solicitação) ou `NNNNNN` (lote) a partir do id — mesma regra
 * de `hub_adiantamento_integration_id` (contracts/sql-rpc.md): `lpad` a 6
 * dígitos enquanto `id < 1000000`; acima disso, o id cru (o `lpad` trunca
 * textos maiores). Usado só como FALLBACK — quando a rota já traz o valor
 * pré-computado pelo Postgres (coluna/RPC), o mapper usa esse direto. */
function formatarSequencial(id, prefixo = '') {
  const texto = String(id);
  return `${prefixo}${texto.length <= 6 ? texto.padStart(6, '0') : texto}`;
}

/** `"<código> – <nome>"` — mesmo formato sourced de `contracts/motorista-api.md`
 * (`GET /motorista/adiantamento/disponibilidade`, campo `bankAccount.bank`). */
function formatarBancoCodigoNome(codigo, nome) {
  return `${codigo} – ${nome}`;
}

/** `documentoMascarado` de `GET /motorista/conta-bancaria` (3.2/dec-074): só
 * insere pontuação num valor que o SQL (`hub_adiantamento_mascarar`, 2
 * dígitos visíveis + `*`) JÁ mascarou — nunca recebe dígitos crus (RLS
 * bloqueia `SELECT` direto em `"ContaBancariaMotorista"`). DIFERENTE de
 * `documentoMascarado()` de `lib/adiantamento-conta.js`: aquela recebe o
 * documento CRU e mascara ela mesma; esta só formata o que já veio mascarado
 * — aplicá-las uma sobre a outra corromperia a máscara (o `*` deixaria de
 * ser dígito para `somenteDigitos()`). */
function pontuarDocumentoMascarado(mascarado) {
  if (typeof mascarado !== 'string') return null;
  if (mascarado.length === 11) {
    return `${mascarado.slice(0, 3)}.${mascarado.slice(3, 6)}.${mascarado.slice(6, 9)}-${mascarado.slice(9, 11)}`;
  }
  if (mascarado.length === 14) {
    return `${mascarado.slice(0, 2)}.${mascarado.slice(2, 5)}.${mascarado.slice(5, 8)}/${mascarado.slice(8, 12)}-${mascarado.slice(12, 14)}`;
  }
  return mascarado;
}

const ABREVIACAO_TIPO_CONTA = { CORRENTE: 'CC', POUPANCA: 'CP' };

/** `"Ag. 0001 · CC ••••4521-7"` — mesmo formato sourced de
 * `contracts/motorista-api.md` (`bankAccount.masked`); reusado também para
 * `LinhaPrevia.bancoAgenciaContaMascarados` (`contracts/hub-api.md`). */
function formatarContaResumo({ agencia, tipoConta, conta, contaDigito }) {
  const abrev = ABREVIACAO_TIPO_CONTA[tipoConta] || tipoConta;
  return `Ag. ${agencia} · ${abrev} ${contaMascarada(conta, contaDigito)}`;
}

// --- AdiantamentoConfiguracao (2.5.1) ---------------------------------------

const FONTES_FINANCEIRAS = new Set(['financeiro_lancamento', 'financeiro_referencia']);

/** `completa` (FR-025, data-model.md): fonte preenchida, categorias não
 * vazias quando a fonte é financeira, e os 4 campos de apuração (Q-B2)
 * preenchidos. */
function configuracaoCompleta(row) {
  if (!row.fonte_producao) return false;
  if (FONTES_FINANCEIRAS.has(row.fonte_producao) && !(row.categorias_producao || []).length) return false;
  return (
    row.apuracao_dia_inicio !== null &&
    row.apuracao_dia_inicio !== undefined &&
    row.apuracao_dias_ate_repasse !== null &&
    row.apuracao_dias_ate_repasse !== undefined &&
    !!row.apuracao_data_base &&
    !!row.categorias_extrato
  );
}

/** `time` do Postgres (`"09:00:00"`) -> `"HH:MM"` (contracts/motorista-api.md
 * `openingTime`/`cutoffTime`). */
function horaCurta(valor) {
  return typeof valor === 'string' ? valor.slice(0, 5) : valor;
}

/** Mapeia `AdiantamentoConfiguracao` para `Configuracao` (hub-api.md §Configuração:
 * "os mesmos campos [do PUT] em camelCase + versao, vigenteDesde, timezone, completa"). */
function mapConfiguracao(row) {
  return {
    versao: row.versao,
    vigenteDesde: row.vigente_desde,
    timezone: row.timezone,
    diasHabilitados: row.dias_habilitados,
    horarioAbertura: horaCurta(row.horario_abertura),
    horarioCorte: horaCurta(row.horario_corte),
    percentual: row.percentual === null || row.percentual === undefined ? null : Number(row.percentual),
    taxaFixa: dinheiro(row.taxa_fixa),
    fonteProducao: row.fonte_producao,
    categoriasProducao: row.categorias_producao,
    previsaoPagamentoTexto: row.previsao_pagamento_texto,
    descricaoPixModelo: row.descricao_pix_modelo,
    apuracaoDiaInicio: row.apuracao_dia_inicio,
    apuracaoDiasAteRepasse: row.apuracao_dias_ate_repasse,
    apuracaoDataBase: row.apuracao_data_base,
    categoriasExtrato: row.categorias_extrato,
    descontoAdiantamentos: row.desconto_adiantamentos,
    descontoDebitos: row.desconto_debitos,
    repasseVisivelApp: row.repasse_visivel_app,
    completa: configuracaoCompleta(row),
  };
}

// --- ContaBancariaMotorista (2.5.1) ------------------------------------------

/** `ContaMascarada` (hub-api.md §Contas bancárias). */
function mapContaMascarada(row) {
  return {
    id: row.id,
    status: row.status,
    origem: row.origem,
    banco: row.banco_nome,
    agencia: row.agencia,
    contaMascarada: contaMascarada(row.conta, row.conta_digito),
    tipoConta: row.tipo_conta,
    titularNome: row.titular_nome,
    documentoMascarado: documentoMascarado(row.titular_documento),
    alertas: row.alertas || [],
    motivoRejeicao: row.motivo_rejeicao ?? null,
    solicitadaEm: row.solicitada_em,
    revisadaEm: row.revisada_em,
  };
}

/** `ContaCompleta` = `ContaMascarada` + campos sem máscara (hub-api.md:
 * "acrescenta titularDocumento, conta, contaDigito, chavePixTipo, chavePix,
 * emailComprovante"). Resposta com dado completo sai com `Cache-Control:
 * no-store` (responsabilidade da rota, não do DTO). */
function mapContaCompleta(row) {
  return {
    ...mapContaMascarada(row),
    titularDocumento: row.titular_documento,
    conta: row.conta,
    contaDigito: row.conta_digito,
    chavePixTipo: row.chave_pix_tipo,
    chavePix: row.chave_pix,
    emailComprovante: row.email_comprovante,
    // 7.5.2 (spec.md US3/FR-018): "confirmar explicitamente o entregador
    // vinculado" — mesmo formato {entregadorId, nome} de mapSolicitacaoResumo
    // (linha ~207), para o financeiro ver e reenviar como entregadorConfirmadoId.
    entregadorVinculado: { entregadorId: row.entregador_id, nome: row.entregador_nome ?? null },
  };
}

// --- AdiantamentoSolicitacao (2.5.1, 3.1) ------------------------------------

/** Rótulo pt-BR por `status`/`status_para` — mesma "Etapa exibida" de
 * PLANO.md §11.1 (Timeline no app) para AGUARDANDO_CORTE/AGUARDANDO_PRODUCAO/
 * LIBERADA/EM_LOTE/EXPORTADA/PAGA; ENCERRADA usa o texto da notificação
 * "pagamento não realizado" de contracts/sql-rpc.md (`hub_adiantamento_encerrar_falha`);
 * REJEITADA/INELEGIVEL/FALHOU/CANCELADA derivam do nome do próprio estado
 * (ramos citados em PLANO.md §11.1 "rejeição, inelegível, falha... cancelada").
 * Usado por `statusRotulo` (lista, `GET /motorista/adiantamentos`) e por
 * `etapa` na timeline (`GET /motorista/adiantamentos/:id`) — mesma tabela,
 * aplicada a `status` ou a `status_para` de cada evento. */
const ETAPA_ADIANTAMENTO = {
  AGUARDANDO_CORTE: 'Solicitação recebida',
  AGUARDANDO_PRODUCAO: 'Aguardando produção',
  LIBERADA: 'Adiantamento liberado',
  EM_LOTE: 'Incluído para pagamento',
  EXPORTADA: 'Pagamento em processamento',
  PAGA: 'Pagamento realizado',
  REJEITADA: 'Rejeitado',
  INELEGIVEL: 'Inelegível',
  FALHOU: 'Falha no pagamento',
  ENCERRADA: 'Pagamento não realizado',
  CANCELADA: 'Cancelado',
};

/** Rótulo pt-BR de um `status` — cai no próprio código se for desconhecido
 * (nunca lança; novo status futuro aparece cru até a tabela ser atualizada). */
function rotuloStatusAdiantamento(status) {
  return ETAPA_ADIANTAMENTO[status] || status;
}

// --- AdiantamentoSolicitacao (2.5.1) -----------------------------------------

/** `SolicitacaoResumo` (hub-api.md §Solicitações). `integrationId`/`loteId`/
 * `pendencias` são pré-computados pela rota (RPC/join) quando disponíveis;
 * `integrationId` cai para `formatarSequencial` como fallback determinístico. */
function mapSolicitacaoResumo(row) {
  return {
    id: row.id,
    integrationId: row.integration_id || formatarSequencial(row.id, 'ADV-'),
    motorista: { entregadorId: row.entregador_id, nome: row.entregador ? row.entregador.nome : null },
    dataSolicitacao: row.data_solicitacao,
    dataProducao: row.data_producao,
    status: row.status,
    motivoStatus: row.motivo_status,
    valorLiquido: dinheiro(row.valor_liquido),
    pendencias: row.pendencias || [],
    loteId: row.lote_id ?? null,
  };
}

/** `AdiantamentoEvento` -> item de `SolicitacaoDetalhe.eventos[]`. */
function mapEvento(row) {
  return {
    statusDe: row.status_de,
    statusPara: row.status_para,
    ocorridoEm: row.ocorrido_em,
    atorTipo: row.ator_tipo,
    atorUsuarioId: row.ator_usuario_id,
    motivo: row.motivo,
  };
}

/** `SolicitacaoDetalhe` = resumo + `calculo` + `contaMascarada` + `eventos[]`
 * + `lotes[]` (hub-api.md §Solicitações). `row.conta_bancaria`/`row.eventos`/
 * `row.lotes` são embeds opcionais que a rota junta (mesmo padrão de
 * `row.entregador` em `hub-faturamento-dto.js#mapFaturamentoListItem`). */
function mapSolicitacaoDetalhe(row) {
  return {
    ...mapSolicitacaoResumo(row),
    calculo: {
      fonte: row.fonte_producao,
      categorias: row.categorias_producao,
      producao: dinheiro(row.producao_valor),
      porCategoria: row.producao_por_categoria,
      percentual: row.percentual === null || row.percentual === undefined ? null : Number(row.percentual),
      bruto: dinheiro(row.valor_bruto),
      taxa: dinheiro(row.taxa),
      liquido: dinheiro(row.valor_liquido),
      calculadoEm: row.calculado_em,
      versaoConfiguracao: row.versao_configuracao ?? null,
    },
    contaMascarada: row.conta_bancaria ? mapContaMascarada(row.conta_bancaria) : null,
    eventos: (row.eventos || []).map(mapEvento),
    lotes: (row.lotes || []).map(mapLote),
  };
}

// --- AdiantamentoLote / AdiantamentoLoteItem (2.5.1) -------------------------

/** `Lote` (hub-api.md §Pagamentos e lotes). `numero` cai para
 * `formatarSequencial(id)` (sem prefixo) quando a rota não pré-computa. */
function mapLote(row) {
  return {
    id: row.id,
    numero: row.numero || formatarSequencial(row.id),
    status: row.status,
    criadoPor: row.criado_por_nome ? { id: row.criado_por, nome: row.criado_por_nome } : row.criado_por,
    criadoEm: row.criado_em,
    quantidade: row.quantidade,
    valorTotal: dinheiro(row.valor_total),
    arquivoNome: row.arquivo_nome,
    arquivoSha256: row.arquivo_sha256,
    downloads: row.downloads,
    primeiroDownloadEm: row.primeiro_download_em,
    canceladoEm: row.cancelado_em,
    canceladoMotivo: row.cancelado_motivo,
    concluidoEm: row.concluido_em,
  };
}

/** Item do snapshot de um lote (`GET /lotes/:id` → `itens[]`, "documento e
 * conta mascarados" — hub-api.md). `col_documento` já sai mascarado do banco
 * (data-model.md: "B — com máscara"); `col_conta`/`col_digito` são os valores
 * crus usados no arquivo Transfeera e precisam de máscara AQUI, na leitura
 * para o hub. */
function mapLoteItem(row) {
  return {
    id: row.id,
    nome: row.col_nome,
    // FASE 11 (converge onda-037, 11.7/11.14, migration 0074): `col_documento`
    // gravado no `AdiantamentoLoteItem` deixou de ser redigido pelo SQL — hoje
    // é o documento FORMATADO (999.999.999-99/99.999.999/9999-99, exigido pelo
    // arquivo Transfeera, contracts/transfeera-xlsx.md coluna B). A máscara
    // para ESTA listagem (apresentação) é responsabilidade do Node — nunca
    // devolver `col_documento` cru.
    documentoMascarado: documentoMascarado(row.col_documento),
    banco: row.col_banco,
    agencia: row.col_agencia,
    contaMascarada: contaMascarada(row.col_conta, row.col_digito),
    tipoConta: row.col_tipo_conta,
    valor: dinheiro(row.valor),
    integrationId: row.col_id_integracao,
    descricaoPix: row.col_descricao_pix,
    situacao: row.situacao,
    situacaoMotivo: row.situacao_motivo,
    situacaoEm: row.situacao_em,
  };
}

/** `LinhaPrevia` (hub-api.md §Pagamentos e lotes, `POST /lotes/previa` →
 * `aptas[]`): `id, integrationId, motorista, valor, bancoAgenciaContaMascarados`.
 * Calculado a partir da solicitação + conta aprovada, ANTES de o lote/item
 * existirem — por isso não reusa `mapLoteItem` (não há `AdiantamentoLoteItem`
 * ainda nesse ponto do fluxo). */
function mapLinhaPrevia(row) {
  return {
    id: row.id,
    integrationId: row.integration_id || formatarSequencial(row.id, 'ADV-'),
    motorista: row.entregador ? row.entregador.nome : null,
    valor: dinheiro(row.valor_liquido),
    bancoAgenciaContaMascarados: formatarContaResumo({
      agencia: row.agencia,
      tipoConta: row.tipo_conta,
      conta: row.conta,
      contaDigito: row.conta_digito,
    }),
  };
}

module.exports = {
  REGEX_DINHEIRO,
  dinheiro,
  formatarSequencial,
  formatarBancoCodigoNome,
  formatarContaResumo,
  pontuarDocumentoMascarado,
  rotuloStatusAdiantamento,
  mapConfiguracao,
  mapContaMascarada,
  mapContaCompleta,
  mapSolicitacaoResumo,
  mapEvento,
  mapSolicitacaoDetalhe,
  mapLote,
  mapLoteItem,
  mapLinhaPrevia,
};
