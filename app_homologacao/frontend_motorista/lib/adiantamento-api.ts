/**
 * adiantamento-motorista — lib/adiantamento-api.ts (tasks.md 6.1.1)
 *
 * Cliente tipado para as rotas de disponibilidade/regras/solicitar/cancelar/
 * histórico/conta-bancária/bancos/notificações/repasse do app do motorista.
 *
 * Ref: contracts/motorista-api.md §Parte 2; routes/motorista-adiantamento.js
 * (FASE 3/5 — fonte dos shapes de resposta abaixo).
 *
 * NOTA (gap identificado onda-019): `GET /motorista/repasse` está documentado
 * no contrato e a RPC `hub_adiantamento_repasse_motorista` já existe (task
 * 1.2.3), mas nenhuma rota Node a expõe ainda (FASE 3 não tem subtarefa para
 * isso — ver tasks.md FASE 3, nova 3.9). `buscarRepasse()` abaixo já está
 * tipado pelo contrato; falhará com 404 até a rota nascer (bloqueante só
 * para 6.6, não para 6.1).
 */

import { api } from './api-client.ts';

// ── Disponibilidade ─────────────────────────────────────────────────────

export type MotivoIndisponivel =
  | 'DAY_NOT_ALLOWED'
  | 'BEFORE_OPENING'
  | 'AFTER_CUTOFF'
  | 'ALREADY_REQUESTED'
  | 'NO_BANK_ACCOUNT'
  | 'BANK_ACCOUNT_PENDING'
  | 'NOT_LINKED'
  | 'NOT_CONFIGURED'
  | 'MODULE_DISABLED'
  | 'OUTSIDE_GROUP';

export interface EstimativaAdiantamento {
  available: boolean;
  production: string;
  gross: string;
  fee: string;
  /** `null` quando `eligible:false` (produção zero ou líquido não positivo,
   * 3.8.1/dec-076) — nunca um valor negativo. */
  net: string | null;
  eligible: boolean | null;
  final: false;
}

export interface ContaBancariaResumoCurto {
  status: string;
  bank: string;
  masked: string;
}

export interface SolicitacaoResumoDia {
  id: number;
  status: string;
  integrationId: string;
}

export interface Disponibilidade {
  canRequest: boolean;
  reason: MotivoIndisponivel | null;
  requestDate: string;
  productionDate: string;
  timezone: string;
  openingTime: string;
  cutoffTime: string;
  enabledDays: number[];
  percentage: number | null;
  fee: string;
  paymentForecast: string;
  nextAvailableAt: string | null;
  estimate: EstimativaAdiantamento | null;
  bankAccount: ContaBancariaResumoCurto | null;
  todayRequest: SolicitacaoResumoDia | null;
  /** Versão de EXIBIÇÃO da configuração vigente (protótipo M06/M15 mostra
   * "versão 3") — NUNCA enviar de volta em `POST /adiantamentos`. */
  configVersion: number;
  /** Identificador (PK) a devolver em `POST /adiantamentos.configuracaoId`. */
  configuracaoId: number;
}

export function buscarDisponibilidade(): Promise<Disponibilidade> {
  return api.get<Disponibilidade>('/motorista/adiantamento/disponibilidade');
}

// ── Regras ───────────────────────────────────────────────────────────────

export interface RegraItem {
  titulo: string;
  descricao: string;
}

export interface Regras {
  configVersion: number;
  configuracaoId: number;
  texto: string;
  itens: RegraItem[];
  aceiteSha256: string;
}

export function buscarRegras(): Promise<Regras> {
  return api.get<Regras>('/motorista/adiantamento/regras');
}

// ── Solicitação / detalhe / histórico ───────────────────────────────────

export interface CalculoAdiantamento {
  producao: string;
  percentual: number | null;
  bruto: string;
  taxa: string;
  liquido: string;
  fonte: string;
  calculadoEm: string;
}

export interface TimelineEvento {
  etapa: string;
  status: string;
  ocorridoEm: string;
  motivo: string | null;
}

export interface SolicitacaoDetalhe {
  id: number;
  integrationId: string;
  status: string;
  motivoStatus: string | null;
  dataSolicitacao: string;
  dataProducao: string;
  solicitadaEm: string;
  configVersion: number;
  calculo: CalculoAdiantamento | null;
  contaMascarada: ContaBancariaResumoCurto | null;
  previsaoPagamento: string | null;
  timeline: TimelineEvento[];
}

export interface SolicitacaoResumoLista {
  id: number;
  integrationId: string;
  dataSolicitacao: string;
  dataProducao: string;
  status: string;
  statusRotulo: string;
  valorLiquido: string;
}

export interface ListaPaginada<T> {
  itens: T[];
  total: number;
  pagina: number;
  porPagina: number;
}

export interface DadosSolicitarAdiantamento {
  aceite: true;
  chaveIdempotencia: string;
  /** SEMPRE `configuracaoId` (PK) — nunca `configVersion` (R-05/R-06). */
  configuracaoId: number;
}

export function solicitarAdiantamento(dados: DadosSolicitarAdiantamento): Promise<SolicitacaoDetalhe> {
  return api.post<SolicitacaoDetalhe>('/motorista/adiantamentos', dados as unknown as Record<string, unknown>);
}

export function buscarHistoricoAdiantamentos(pagina = 1): Promise<ListaPaginada<SolicitacaoResumoLista>> {
  return api.get<ListaPaginada<SolicitacaoResumoLista>>(`/motorista/adiantamentos?pagina=${pagina}`);
}

export function buscarDetalheAdiantamento(id: number): Promise<SolicitacaoDetalhe> {
  return api.get<SolicitacaoDetalhe>(`/motorista/adiantamentos/${id}`);
}

/** Só habilitado em `AGUARDANDO_CORTE` e antes do corte (6.3.5, edge #22) —
 * a tela decide quando mostrar o botão; o servidor recusa com
 * `409 TRANSICAO_INVALIDA` fora dessa janela. */
export function cancelarAdiantamento(id: number): Promise<SolicitacaoDetalhe> {
  return api.post<SolicitacaoDetalhe>(`/motorista/adiantamentos/${id}/cancelar`);
}

// ── Conta bancária / bancos ──────────────────────────────────────────────

export interface ContaBancariaItem {
  id: number;
  status: string;
  banco: string;
  agencia: string;
  contaMascarada: string;
  tipoConta: 'CORRENTE' | 'POUPANCA';
  titularNome: string;
  documentoMascarado: string;
  chavePixTipo: string | null;
  emailComprovante: string | null;
  solicitadaEm: string;
  motivoRejeicao: string | null;
}

export interface ContaBancariaResumo {
  aprovada: ContaBancariaItem | null;
  pendente: ContaBancariaItem | null;
  ultimaRejeicao: ContaBancariaItem | null;
}

export function buscarContaBancaria(): Promise<ContaBancariaResumo> {
  return api.get<ContaBancariaResumo>('/motorista/conta-bancaria');
}

export interface DadosSolicitarContaBancaria {
  titularNome: string;
  titularDocumento: string;
  bancoCodigo: string;
  agencia: string;
  conta: string;
  contaDigito: string;
  tipoConta: 'CORRENTE' | 'POUPANCA';
  chavePixTipo?: 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'ALEATORIA';
  chavePix?: string;
  emailComprovante?: string;
}

export function solicitarContaBancaria(dados: DadosSolicitarContaBancaria): Promise<ContaBancariaItem> {
  return api.post<ContaBancariaItem>('/motorista/conta-bancaria/solicitacoes', dados as unknown as Record<string, unknown>);
}

export interface Banco {
  codigo: string;
  nome: string;
}

export function buscarBancos(q = ''): Promise<{ itens: Banco[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return api.get<{ itens: Banco[] }>(`/motorista/bancos${query}`);
}

// ── Notificações ─────────────────────────────────────────────────────────

export type CategoriaNotificacao = 'adiantamento' | 'pagamento' | 'conta_bancaria' | 'sistema' | 'aviso';

export interface Notificacao {
  id: number;
  categoria: CategoriaNotificacao;
  titulo: string;
  corpo: string;
  link: string | null;
  criadaEm: string;
  lida: boolean;
}

export interface FiltroNotificacoes {
  pagina?: number;
  categoria?: CategoriaNotificacao;
  naoLidas?: boolean;
}

export function buscarNotificacoes(filtro: FiltroNotificacoes = {}): Promise<ListaPaginada<Notificacao>> {
  const sp = new URLSearchParams();
  if (filtro.pagina) sp.set('pagina', String(filtro.pagina));
  if (filtro.categoria) sp.set('categoria', filtro.categoria);
  if (filtro.naoLidas) sp.set('naoLidas', 'true');
  const qs = sp.toString();
  return api.get<ListaPaginada<Notificacao>>(`/motorista/notificacoes${qs ? `?${qs}` : ''}`);
}

export function buscarNotificacoesNaoLidas(): Promise<{ total: number }> {
  return api.get<{ total: number }>('/motorista/notificacoes/nao-lidas');
}

export function marcarNotificacaoLida(id: number): Promise<void> {
  return api.post<void>(`/motorista/notificacoes/${id}/lida`);
}

export function marcarTodasNotificacoesLidas(): Promise<void> {
  return api.post<void>('/motorista/notificacoes/lidas');
}

// ── Repasse (M16, 6.6) ───────────────────────────────────────────────────

export interface RepasseAdiantamentoItem {
  id: number;
  integrationId: string;
  dataProducao: string;
  valorBruto: string;
  emProcessamento: boolean;
}

/** A semana JÁ FECHADA mais recente do motorista, com o valor CONGELADO no
 * fechamento — é o que ele de fato vai receber, e a data em que recebe.
 * `null` enquanto ele não tiver nenhuma. Não confundir com o bloco principal
 * desta tela, que é a semana CORRENTE, ainda em apuração e sujeita a mudar. */
export interface RepasseFechado {
  periodoInicio: string;
  periodoFim: string;
  dataRepasse: string;
  fechadoEm: string;
  creditos: string;
  adiantamentos: string;
  debitos: string;
  remanescente: string;
  negativo: boolean;
}

export interface Repasse {
  periodoInicio: string;
  periodoFim: string;
  dataRepasse: string;
  situacao: 'EM_APURACAO' | 'FECHADA';
  creditos: string;
  adiantamentos: RepasseAdiantamentoItem[];
  debitos: string;
  remanescente: string;
  negativo: boolean;
  ultimoFechado: RepasseFechado | null;
}

/** 404 `{erro:'NAO_DISPONIVEL'}` quando `repasseVisivelApp=false` ou a
 * apuração não está configurada (D-13) — a tela (6.6.3) trata isso como
 * "não renderizar", não como erro. */
export function buscarRepasse(): Promise<Repasse> {
  return api.get<Repasse>('/motorista/repasse');
}
