// adiantamento-motorista — lib/hub/adiantamentos-api.ts (tasks.md 7.1.1)
//
// Cliente tipado para TODAS as rotas de `/api/v1/adiantamentos`. Molde
// compartilhado de `lib/hub/api.ts` (`criarRequest`/`query`), mesmo padrão
// de `lib/hub/faturamento-api.ts:100-121` (download de blob via fetch +
// `Content-Disposition`, sem passar por `request<T>()`).
//
// Shapes SOURCED do backend real (Constitution VI — nunca do contrato
// aspiracional): `backend/routes/hub-adiantamentos.js` +
// `backend/lib/adiantamento-dto.js`. `contracts/hub-api.md` está marcado
// `[PROPOSTA — a validar na implementação]` e diverge do código em 1 ponto
// — seguido o código, com nota inline:
//   1. `POST /contas/:id/aprovar|rejeitar` devolvem só `{id, status}`
//      (RPCs `hub_conta_bancaria_aprovar/_rejeitar`,
//      infra/hub/migrations/0067:1328-1385) — não `SolicitacaoDetalhe`.
//
// Resolvidos (converge FASE 11): `banco` em `GET /contas` documentado
// retroativamente no contrato (11.29, dec-105/protótipo H06 — mantido, útil
// com 1.735 contas na carga inicial). `GET /contas/:id` sem `completo=true` devolve
// só `ContaMascarada` — decisão 11.27 convergeu o CONTRATO ao código (sem
// `entregador`/histórico nesse modo; `entregadorVinculado` já sai em
// `ContaCompleta`, `obterContaCompleta()`, único modo usado por tela real).
// Resolvidos (converge FASE 12, 2ª passada): `GET /repasse` não tem objeto
// `descontos{}` separado — `adiantamentos`/`debitos` vêm dentro do próprio
// `totais{}` (routes/hub-adiantamentos.js:1359-1364); contrato convergido (12.6).
// As 6 transições de solicitação (rejeitar/recalcular/encerrar/atualizar-conta/
// reprocessar/encerrar-falha) agora devolvem `SolicitacaoDetalhe` de verdade
// (11.26 convergeu o CÓDIGO ao contrato, `montarSolicitacaoDetalhe` compartilhada
// com `GET /:id`). As assinaturas abaixo continuam anotadas `Promise<SolicitacaoResumo>`
// de propósito — `SolicitacaoDetalhe extends SolicitacaoResumo`, e as telas atuais
// (`adiantamento-acao-dialog.tsx`) já mesclam o resumo no detalhe corrente no
// client; nenhuma tela precisa hoje dos campos extras direto da transição.
//
// Ref: docs/specs/adiantamento-motorista/contracts/hub-api.md §Parte 2.

import { HUB_API_BASE, HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro, query } from './api';

const MENSAGENS_CODIGO: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'O módulo de adiantamentos está desabilitado para esta empresa.',
  FORA_DO_GRUPO_MOVEE: 'Esta empresa não pertence ao grupo Movee.',
  DADOS_INVALIDOS: 'Dados inválidos. Confira os campos e tente novamente.',
  NAO_ENCONTRADO: 'Solicitação não encontrada.',
  TRANSICAO_INVALIDA: 'Essa ação não é permitida no status atual.',
  VERSAO_DESATUALIZADA: 'Os dados foram alterados por outra pessoa. Recarregue e tente novamente.',
  PREVIA_DESATUALIZADA: 'A prévia mudou desde a última consulta. Gere uma nova prévia.',
  SOLICITACOES_EM_OUTRO_LOTE: 'Uma ou mais solicitações já estão em outro lote.',
  LOTE_ACIMA_DO_LIMITE: 'O lote excede o limite de 5.000 solicitações.',
  ARQUIVO_INDISPONIVEL: 'O arquivo deste lote não está disponível.',
  LIMITE_EXCEDIDO: 'Limite de tentativas excedido. Aguarde alguns minutos.',
  APURACAO_JA_FECHADA: 'Este período já foi fechado.',
  APURACAO_NAO_CONFIGURADA: 'A apuração de repasse ainda não foi configurada.',
  APURACAO_COM_PENDENCIAS: 'Há solicitações pendentes neste período.',
  PERIODO_EM_ABERTO: 'O período ainda está em aberto para solicitações.',
  // A1: a gravação recusa janela que não começa no dia configurado. A
  // mensagem tem de dizer o que fazer, porque o fechamento é irreversível e
  // o operador não vai adivinhar qual data o sistema espera.
  PERIODO_DESALINHADO: 'O período escolhido não começa no dia configurado para a apuração. Use a data que a tela sugere ao abrir.',
  CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA: 'Confirme que o lote não foi enviado à Transfeera.',
  FALHA_GERACAO_ARQUIVO: 'Falha ao gerar o arquivo do lote.',
  NO_BANK_ACCOUNT: 'O motorista não tem conta bancária aprovada.',
  PRODUCAO_INDISPONIVEL: 'Produção indisponível para recálculo.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
};

export class AdiantamentosApiError extends HubApiError {
  readonly name = 'AdiantamentosApiError';

  constructor(
    status: number,
    message: string,
    codigo?: string,
    /** Só presente em `APURACAO_COM_PENDENCIAS` (contagem de solicitações
     * por status que ainda impede o fechamento — routes/hub-adiantamentos.js
     * :1213-1216, 7.8.4/D-23). */
    public readonly detalhe?: Record<string, number>
  ) {
    super(status, message, codigo);
  }
}

function detalheDoErro(body: Record<string, unknown>): Record<string, number> | undefined {
  const d = body.detalhe;
  return d && typeof d === 'object' ? (d as Record<string, number>) : undefined;
}

const request = criarRequest(
  (status, body) =>
    new AdiantamentosApiError(status, mensagemPorCodigo(MENSAGENS_CODIGO, body, status), codigoDoErro(body), detalheDoErro(body))
);

async function baixarBlob(path: string, nomePadrao: string): Promise<void> {
  const res = await fetch(`${HUB_API_BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const bodyObj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new AdiantamentosApiError(res.status, mensagemPorCodigo(MENSAGENS_CODIGO, bodyObj, res.status), codigoDoErro(bodyObj));
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition');
  const match = disposition?.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : nomePadrao;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────────────────────────
// Solicitações (hub-api.md §Solicitações; adiantamento-dto.js#mapSolicitacaoResumo/mapSolicitacaoDetalhe)
// ────────────────────────────────────────────────────────────────────────

export interface SolicitacaoResumo {
  id: number;
  integrationId: string;
  motorista: { entregadorId: number | null; nome: string | null };
  dataSolicitacao: string;
  dataProducao: string;
  status: string;
  motivoStatus: string | null;
  /** String decimal — nunca somar/recalcular no cliente. NULO até o corte:
   *  em `AGUARDANDO_CORTE` o cálculo ainda não rodou (incidente 2026-09-22). */
  valorLiquido: string | null;
  pendencias: string[];
  loteId: number | null;
}

export interface SolicitacaoEvento {
  statusDe: string | null;
  statusPara: string;
  ocorridoEm: string;
  atorTipo: string;
  atorUsuarioId: number | null;
  motivo: string | null;
}

export interface SolicitacaoCalculo {
  fonte: string | null;
  categorias: string[] | null;
  producao: string | null;
  porCategoria: Record<string, unknown> | null;
  percentual: number | null;
  bruto: string | null;
  taxa: string | null;
  /** Nulo até o corte, como os demais valores do cálculo. */
  liquido: string | null;
  calculadoEm: string | null;
  versaoConfiguracao: number | null;
}

export interface ContaMascaradaAdiantamento {
  id: number;
  status: string;
  origem: string;
  banco: string;
  agencia: string;
  contaMascarada: string;
  tipoConta: 'CORRENTE' | 'POUPANCA';
  titularNome: string;
  documentoMascarado: string;
  alertas: string[];
  motivoRejeicao: string | null;
  solicitadaEm: string;
  revisadaEm: string | null;
}

export interface ContaCompletaAdiantamento extends ContaMascaradaAdiantamento {
  titularDocumento: string;
  conta: string;
  contaDigito: string;
  chavePixTipo: string | null;
  chavePix: string | null;
  emailComprovante: string | null;
  /** FR-018: revisão dedicada exige confirmar explicitamente o entregador
   * vinculado — `entregadorId` é reenviado como `entregadorConfirmadoId` ao aprovar. */
  entregadorVinculado: { entregadorId: number; nome: string | null };
}

export interface Lote {
  id: number;
  numero: string;
  status: string;
  criadoPor: { id: number; nome: string } | number | null;
  criadoEm: string;
  quantidade: number;
  valorTotal: string;
  arquivoNome: string | null;
  arquivoSha256: string | null;
  downloads: number;
  primeiroDownloadEm: string | null;
  canceladoEm: string | null;
  canceladoMotivo: string | null;
  concluidoEm: string | null;
}

export interface SolicitacaoDetalhe extends SolicitacaoResumo {
  calculo: SolicitacaoCalculo | null;
  contaMascarada: ContaMascaradaAdiantamento | null;
  eventos: SolicitacaoEvento[];
  lotes: Lote[];
}

export interface SolicitacoesFiltros {
  de?: string;
  ate?: string;
  busca?: string;
  /** CSV, ex.: `"LIBERADA,EM_LOTE"` (routes/hub-adiantamentos.js:104-107). */
  status?: string;
  exportado?: boolean;
  pago?: boolean;
  pendencia?: boolean;
  page?: number;
  pageSize?: number;
  ordem?: 'recente' | 'antigo';
}

export interface SolicitacoesListResponse {
  itens: SolicitacaoResumo[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listarSolicitacoes(filtros: SolicitacoesFiltros = {}): Promise<SolicitacoesListResponse> {
  return request<SolicitacoesListResponse>(`/adiantamentos${query(filtros)}`);
}

export async function obterSolicitacao(id: number): Promise<SolicitacaoDetalhe> {
  return request<SolicitacaoDetalhe>(`/adiantamentos/${id}`);
}

export async function rejeitarSolicitacao(id: number, motivo: string): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/rejeitar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export async function recalcularSolicitacao(id: number): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/recalcular`, { method: 'POST' });
}

export async function encerrarSolicitacao(id: number, motivo: string): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/encerrar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export async function atualizarContaSolicitacao(id: number, motivo: string): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/atualizar-conta`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export async function reprocessarSolicitacao(id: number, motivo: string): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/reprocessar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

/** D-23 (operador, 2026-09-17): só `FALHOU` → `ENCERRADA`, motivo obrigatório. */
export async function encerrarSemPagamento(id: number, motivo: string): Promise<SolicitacaoResumo> {
  return request<SolicitacaoResumo>(`/adiantamentos/${id}/encerrar-falha`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

// ────────────────────────────────────────────────────────────────────────
// Configuração (hub-api.md §Configuração; adiantamento-dto.js#mapConfiguracao)
// ────────────────────────────────────────────────────────────────────────

export interface Configuracao {
  versao: number;
  vigenteDesde: string;
  timezone: string;
  diasHabilitados: number[];
  horarioAbertura: string;
  horarioCorte: string;
  percentual: number | null;
  taxaFixa: string;
  fonteProducao: string;
  categoriasProducao: string[] | null;
  previsaoPagamentoTexto: string | null;
  descricaoPixModelo: string | null;
  apuracaoDiaInicio: number | null;
  apuracaoDiasAteRepasse: number | null;
  apuracaoDataBase: string | null;
  categoriasExtrato: string[] | null;
  /** F3: subconjunto do extrato que compõe a base da nota. `null` = não configurado. */
  categoriasNota: string[] | null;
  mensagem1Modelo: string | null;
  mensagem2Modelo: string | null;
  descontoAdiantamentos: boolean;
  descontoDebitos: boolean;
  repasseVisivelApp: boolean;
  completa: boolean;
}

/** F4: marcadores aceitos nos moldes de mensagem do movimento.
 *  ⚠️ A fonte de verdade é a whitelist do backend
 *  (`lib/adiantamento-mensagem.js#PLACEHOLDERS_PERMITIDOS`), que RECUSA o
 *  salvamento com qualquer outro. Esta cópia existe só para a tela explicar o
 *  que vale; `adiantamentos-api.test.ts` lê o arquivo do backend e falha se as
 *  duas listas divergirem. */
export const MARCADORES_MENSAGEM = [
  'nome', 'valor', 'gorjeta', 'total', 'periodo_inicio', 'periodo_fim',
] as const;

export interface ConfiguracaoHistoricoItem {
  versao: number;
  vigenteDesde: string;
  criadoPor: { id: number; nome: string } | number | null;
  criadoEm: string;
  motivo: string | null;
}

export interface ConfiguracaoResponse {
  vigente: Configuracao | null;
  historico: ConfiguracaoHistoricoItem[];
}

export interface CategoriaProducao {
  descricao: string;
  lancamentos: number;
  semMotoristaIdentificado: boolean;
  /** Token de família (migration 0087, ex.: 'familia:promocao'), ou null se avulsa. */
  familia: string | null;
}

/** Campos aceitos pelo `PUT /configuracoes` (routes/hub-adiantamentos.js:404-409, `CAMPOS`). */
export interface SalvarConfiguracaoInput {
  versaoEsperada: number;
  vigenteDesde?: string;
  motivo?: string;
  diasHabilitados?: number[];
  horarioAbertura?: string;
  horarioCorte?: string;
  percentual?: number;
  taxaFixa?: string;
  fonteProducao?: string;
  categoriasProducao?: string[];
  previsaoPagamentoTexto?: string;
  descricaoPixModelo?: string;
  apuracaoDiaInicio?: number;
  apuracaoDiasAteRepasse?: number;
  apuracaoDataBase?: string;
  categoriasExtrato?: string[];
  categoriasNota?: string[];
  mensagem1Modelo?: string;
  mensagem2Modelo?: string;
  descontoAdiantamentos?: boolean;
  descontoDebitos?: boolean;
  repasseVisivelApp?: boolean;
}

export async function obterConfiguracoes(): Promise<ConfiguracaoResponse> {
  return request<ConfiguracaoResponse>('/adiantamentos/configuracoes');
}

export async function listarCategoriasProducao(fonte?: string): Promise<{ itens: CategoriaProducao[] }> {
  return request<{ itens: CategoriaProducao[] }>(`/adiantamentos/configuracoes/categorias${query({ fonte })}`);
}

export async function salvarConfiguracao(dados: SalvarConfiguracaoInput): Promise<Configuracao> {
  const { versaoEsperada, ...resto } = dados;
  return request<Configuracao>('/adiantamentos/configuracoes', {
    method: 'PUT',
    body: JSON.stringify({ versaoEsperada, ...resto }),
  });
}

// ────────────────────────────────────────────────────────────────────────
// Contas bancárias (hub-api.md §Contas bancárias — ver notas de divergência
// no cabeçalho do arquivo: sem `entregador{}`)
// ────────────────────────────────────────────────────────────────────────

export interface ContasFiltros {
  status?: string;
  origem?: string;
  semAlertas?: boolean;
  busca?: string;
  banco?: string;
  page?: number;
  pageSize?: number;
}

export interface ContasListResponse {
  itens: ContaMascaradaAdiantamento[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listarContas(filtros: ContasFiltros = {}): Promise<ContasListResponse> {
  return request<ContasListResponse>(`/adiantamentos/contas${query(filtros)}`);
}

export async function obterConta(id: number): Promise<ContaMascaradaAdiantamento> {
  return request<ContaMascaradaAdiantamento>(`/adiantamentos/contas/${id}`);
}

/** `completo=true` — permissão `contas_revisar`; audita `conta_bancaria.visualizada` (FR-019). */
export async function obterContaCompleta(id: number): Promise<ContaCompletaAdiantamento> {
  return request<ContaCompletaAdiantamento>(`/adiantamentos/contas/${id}${query({ completo: true })}`);
}

export async function aprovarConta(id: number, entregadorConfirmadoId: number): Promise<{ id: number; status: string }> {
  return request(`/adiantamentos/contas/${id}/aprovar`, {
    method: 'POST',
    body: JSON.stringify({ entregadorConfirmadoId }),
  });
}

export async function rejeitarConta(id: number, motivo: string): Promise<{ id: number; status: string }> {
  return request(`/adiantamentos/contas/${id}/rejeitar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export interface AprovarLoteContasResponse {
  aprovadas: number;
  ignoradas: { id: number; motivo: string }[];
}

export async function aprovarContasEmLote(ids: number[]): Promise<AprovarLoteContasResponse> {
  return request<AprovarLoteContasResponse>('/adiantamentos/contas/aprovar-lote', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

// ────────────────────────────────────────────────────────────────────────
// Pagamentos e lotes (hub-api.md §Pagamentos e lotes)
// ────────────────────────────────────────────────────────────────────────

export interface LinhaPrevia {
  id: number;
  integrationId: string;
  motorista: string | null;
  valor: string;
  bancoAgenciaContaMascarados: string | null;
}

export interface PendenciaPrevia {
  id: number;
  pendencias: string[];
}

export interface PreviaLoteResponse {
  selecionadas: number;
  aptas: LinhaPrevia[];
  pendentes: PendenciaPrevia[];
  quantidadeApta: number;
  totalApto: string;
}

export async function previaLote(ids: number[]): Promise<PreviaLoteResponse> {
  return request<PreviaLoteResponse>('/adiantamentos/lotes/previa', { method: 'POST', body: JSON.stringify({ ids }) });
}

export interface CriarLoteInput {
  ids: number[];
  quantidadeEsperada: number;
  totalEsperado: string;
  chaveIdempotencia: string;
}

export async function criarLote(dados: CriarLoteInput): Promise<Lote> {
  return request<Lote>('/adiantamentos/lotes', { method: 'POST', body: JSON.stringify(dados) });
}

export interface LotesFiltros {
  de?: string;
  ate?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface LotesListResponse {
  itens: Lote[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listarLotes(filtros: LotesFiltros = {}): Promise<LotesListResponse> {
  return request<LotesListResponse>(`/adiantamentos/lotes${query(filtros)}`);
}

/** Item do snapshot de um lote (`GET /lotes/:id` → `itens[]`; `id` aqui é o
 * id da SOLICITAÇÃO, não do item — routes/hub-adiantamentos.js:868-882). */
export interface LoteItemDetalhe {
  id: number;
  nome: string;
  documentoMascarado: string;
  banco: string;
  agencia: string;
  contaMascarada: string;
  tipoConta: string;
  valor: string;
  integrationId: string;
  descricaoPix: string | null;
  situacao: string;
  situacaoMotivo: string | null;
  situacaoEm: string | null;
}

export interface LoteDetalhe extends Lote {
  itens: LoteItemDetalhe[];
  historico: SolicitacaoEvento[];
}

export async function obterLote(id: number): Promise<LoteDetalhe> {
  return request<LoteDetalhe>(`/adiantamentos/lotes/${id}`);
}

/** Bytes do xlsx da Transfeera — mesmo padrão de `baixarFaturamentoCsv`. */
export async function baixarArquivoLote(id: number, numero: string): Promise<void> {
  return baixarBlob(`/adiantamentos/lotes/${id}/arquivo`, `transfeera_adiantamentos_lote-${numero}.xlsx`);
}

export async function cancelarLote(id: number, motivo: string, naoEnviadoATransfeera = false): Promise<Lote> {
  return request<Lote>(`/adiantamentos/lotes/${id}/cancelar`, {
    method: 'POST',
    body: JSON.stringify({ motivo, naoEnviadoATransfeera }),
  });
}

export interface ConfirmarLoteInput {
  falhas: { id: number; motivo: string }[];
}

export async function confirmarLote(id: number, dados: ConfirmarLoteInput = { falhas: [] }): Promise<Lote> {
  return request<Lote>(`/adiantamentos/lotes/${id}/confirmacao`, { method: 'POST', body: JSON.stringify(dados) });
}

// ────────────────────────────────────────────────────────────────────────
// Repasse (hub-api.md §Repasse — sem `descontos{}` separado, ver cabeçalho)
// ────────────────────────────────────────────────────────────────────────

export interface RepasseItem {
  entregadorId: number;
  nome: string;
  creditos: string;
  adiantamentos: string;
  debitos: string;
  remanescente: string;
  negativo: boolean;
  emProcessamento: boolean;
}

export interface RepasseResponse {
  // `fechadoEm`: instante do fechamento. Quando presente, os valores desta
  // resposta são os CONGELADOS na apuração (`ApuracaoRepasseItem`), não um
  // recálculo ao vivo — a tela precisa dizer isso, senão o usuário não tem
  // como saber que um lançamento retroativo não está refletido ali.
  periodo: {
    inicio: string; fim: string; dataRepasse: string | null;
    situacao: 'aberto' | 'fechado'; fechadoEm: string | null;
  };
  totais: { creditos: string; adiantamentos: string; debitos: string; remanescente: string; motoristas: number };
  itens: RepasseItem[];
  naoPagosNoPeriodo: number;
  total: number;
  page: number;
  pageSize: number;
}

export interface RepasseFiltros {
  periodo: string; // data de início (YYYY-MM-DD)
  busca?: string;
  somenteNegativos?: boolean;
  page?: number;
  pageSize?: number;
}

export async function obterRepasse(filtros: RepasseFiltros): Promise<RepasseResponse> {
  return request<RepasseResponse>(`/adiantamentos/repasse${query(filtros)}`);
}

export async function exportarRepasseCsv(periodo: string): Promise<void> {
  return baixarBlob(`/adiantamentos/repasse/exportar${query({ periodo })}`, `repasse-${periodo}.csv`);
}

export interface FecharRepasseResponse {
  apuracaoId: number;
  motoristas: number;
  total: string;
  naoPagosNoPeriodo: number;
}

export async function fecharRepasse(periodo: string): Promise<FecharRepasseResponse> {
  return request<FecharRepasseResponse>(`/adiantamentos/repasse/${periodo}/fechar`, {
    method: 'POST',
    body: JSON.stringify({ confirmacao: true }),
  });
}
