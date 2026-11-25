// campanhas do motorista (W3a) — chamadas HTTP para `/api/v1/hub/campanhas*`
// (CONTRATOS.md §7). Molde de `avisos-api.ts`: `criarRequest` compartilhado,
// erro tipado com mensagem acionável em português (nunca o token cru).

import { HUB_API_BASE, HubApiError, codigoDoErro, criarRequest, query } from './api';
import {
  parseCampanhaDetalhe,
  parseCategorias,
  parseCampanhaLista,
  parseIdCriado,
  parseOpcoes,
  parseRanking,
  parseVencedores,
  type CampanhaDetalhe,
  type CampanhaItem,
  type OpcoesCampanha,
  type RankingResposta,
  type SituacaoCampanha,
  type SituacaoRanking,
  type Vencedor,
} from './campanhas-dto';
import type { CategoriaProducao } from './adiantamentos-api';
import { formularioParaCorpo, type FormularioCampanha } from './campanhas-form';

const BASE = '/hub/campanhas';

/** Tokens do CONTRATOS §5 + os comuns do hub → mensagem que diz o que fazer. */
export const MENSAGENS_CAMPANHA: Record<string, string> = {
  NAO_AUTENTICADO: 'Sua sessão expirou. Faça login novamente.',
  ENTIDADE_NAO_SELECIONADA: 'Selecione uma entidade antes de continuar.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  MODULO_DESABILITADO: 'O módulo de campanhas está desabilitado para esta empresa.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente em instantes.',
  CAMPANHA_NAO_ENCONTRADA: 'Campanha não encontrada. Ela pode ter sido removida: volte à lista e atualize.',
  CAMPANHA_IMUTAVEL:
    'Esta campanha já foi lançada e não pode mais ser alterada. Se algo está errado, cancele (com motivo) e crie outra.',
  CAMPANHA_SITUACAO_INVALIDA:
    'A situação da campanha mudou e esta ação não vale mais. Atualize a página para ver a situação atual.',
  TETO_CAMPANHAS_ATIVAS:
    'Esta entidade já tem 10 campanhas lançadas e não encerradas. Cancele ou aguarde o fim de uma delas para lançar outra.',
  PEDIDOS_SEM_COBERTURA:
    'Menos de 95% dos turnos deste público têm pedidos concluídos. Volte ao formulário e use peso 0 em Pedidos concluídos (ou amplie o público).',
  INICIO_NO_PASSADO: 'O início já passou. Volte ao formulário e escolha como início hoje ou uma data futura.',
  FAIXAS_SOBREPOSTAS: 'Há faixas de prêmio sobrepostas. Ajuste para que cada posição tenha um só prêmio.',
  PESOS_INVALIDOS: 'Os pesos precisam ser inteiros de 0 a 100, somar 100 e ter ao menos um indicador acima de 0.',
  CORTE_SEM_PESO: 'Há corte mínimo em um indicador com peso 0. Tire o corte ou dê peso ao indicador.',
  OPCAO_DESCONHECIDA:
    'Alguma praça, turno, modal ou categoria escolhido não existe mais nos dados recentes. Recarregue as opções e escolha de novo.',
  FECHAMENTO_ANTECIPADO:
    'Ainda não dá para fechar com os dados que existem: isso só é liberado 3 dias depois do fim da campanha. Antes disso o fechamento é automático quando a importação do último dia chegar.',
  ARQUIVO_INVALIDO: 'A foto não serve: use JPEG, PNG ou WebP de até 500 KB.',
  FOTO_INVALIDA: 'A foto não serve: use JPEG, PNG ou WebP de até 500 KB.',
  CONFIRMACAO_AUSENTE: 'Marque a caixa de confirmação para lançar.',
  VALIDACAO: 'Há campos inválidos. Confira o formulário e tente novamente.',
  LIMITE_EXCEDIDO: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.',
};

export class CampanhaApiError extends HubApiError {
  constructor(
    status: number,
    message: string,
    codigo?: string,
    /** Campo inválido, quando o token é `VALIDACAO`. */
    public readonly campo?: string
  ) {
    super(status, message, codigo);
    this.name = 'CampanhaApiError';
  }
}

/** Campos do extrato que o backend recusa com VALIDACAO (E2/E3). */
const CAMPO_EXTRATO: Record<string, string> = {
  cortes: 'Marque ao menos 1 critério do turno e informe o mínimo.',
  categorias: 'Marque ao menos 1 categoria para compor o valor do turno.',
  visivel: 'Valor de visibilidade inválido. Atualize a página e tente de novo.',
};

/** Mensagem acionável para o corpo de erro `{ erro, campo? }`. */
export function mensagemCampanha(body: Record<string, unknown>, status: number): string {
  const codigo = codigoDoErro(body);
  const campo = typeof body.campo === 'string' ? body.campo : undefined;
  if (codigo === 'VALIDACAO' && campo && CAMPO_EXTRATO[campo]) return CAMPO_EXTRATO[campo];
  if (codigo === 'VALIDACAO' && campo) return `${MENSAGENS_CAMPANHA.VALIDACAO} (campo: ${campo})`;
  if (codigo && MENSAGENS_CAMPANHA[codigo]) return MENSAGENS_CAMPANHA[codigo];
  return `Erro ${status}. Tente novamente.`;
}

const falha = (status: number, body: Record<string, unknown>) =>
  new CampanhaApiError(
    status,
    mensagemCampanha(body, status),
    codigoDoErro(body),
    typeof body.campo === 'string' ? body.campo : undefined
  );

const request = criarRequest(falha);

// ── leitura ─────────────────────────────────────────────────────────────────

export async function listarCampanhas(situacao?: SituacaoCampanha): Promise<CampanhaItem[]> {
  return parseCampanhaLista(await request<unknown>(`${BASE}${query({ situacao })}`));
}

export async function obterCampanha(id: number): Promise<CampanhaDetalhe> {
  return parseCampanhaDetalhe(await request<unknown>(`${BASE}/${id}`));
}

export async function obterOpcoes(f: {
  pracas: string[] | null;
  turnos: string[] | null;
  modais: string[] | null;
}): Promise<OpcoesCampanha> {
  const juntar = (v: string[] | null) => (v && v.length ? v.join(',') : undefined);
  const raw = await request<unknown>(
    `${BASE}/opcoes${query({ pracas: juntar(f.pracas), turnos: juntar(f.turnos), modais: juntar(f.modais) })}`
  );
  return parseOpcoes(raw);
}

/** Categorias do faturamento com turno (extrato). Sem Gorjeta: ela não tem turno. */
export async function listarCategoriasCampanha(): Promise<CategoriaProducao[]> {
  return parseCategorias(await request<unknown>(`${BASE}/categorias`));
}

export async function obterRanking(
  id: number,
  situacao: SituacaoRanking,
  pagina: number
): Promise<RankingResposta> {
  return parseRanking(await request<unknown>(`${BASE}/${id}/ranking${query({ situacao, pagina })}`));
}

export async function obterVencedores(id: number): Promise<Vencedor[]> {
  return parseVencedores(await request<unknown>(`${BASE}/${id}/vencedores`));
}

// ── escrita ─────────────────────────────────────────────────────────────────

export async function criarCampanha(f: FormularioCampanha): Promise<number> {
  return parseIdCriado(await request<unknown>(BASE, { method: 'POST', body: JSON.stringify(formularioParaCorpo(f)) }));
}

export async function atualizarCampanha(id: number, f: FormularioCampanha): Promise<number> {
  return parseIdCriado(
    await request<unknown>(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(formularioParaCorpo(f)) })
  );
}

/** Liga/desliga a campanha no app do motorista (auditado no banco). */
export async function atualizarVisibilidadeCampanha(id: number, visivel: boolean): Promise<{ id: number; visivelApp: boolean }> {
  const r = await request<{ id?: unknown; visivelApp?: unknown }>(`${BASE}/${id}/visibilidade`, {
    method: 'PATCH',
    body: JSON.stringify({ visivel }),
  });
  return { id: typeof r?.id === 'number' ? r.id : id, visivelApp: r?.visivelApp === true };
}

export async function lancarCampanha(id: number): Promise<void> {
  await request<void>(`${BASE}/${id}/lancar`, { method: 'POST', body: JSON.stringify({ confirmo: true }) });
}

export async function cancelarCampanha(id: number, motivo: string): Promise<void> {
  await request<void>(`${BASE}/${id}/cancelar`, { method: 'POST', body: JSON.stringify({ motivo }) });
}

export async function excluirCampanha(id: number): Promise<void> {
  await request<void>(`${BASE}/${id}`, { method: 'DELETE' });
}

export async function fecharCampanha(id: number): Promise<void> {
  await request<void>(`${BASE}/${id}/fechar`, { method: 'POST' });
}

export async function registrarEntrega(id: number, posicao: number, observacao?: string): Promise<void> {
  await request<void>(`${BASE}/${id}/vencedores/${posicao}/entrega`, {
    method: 'POST',
    body: JSON.stringify(observacao ? { observacao } : {}),
  });
}

/** Foto do prêmio: corpo binário (a rota usa `express.raw`), `Content-Type` = o do arquivo. */
export async function enviarFotoPremio(id: number, premioId: number, arquivo: File): Promise<void> {
  await request<void>(`${BASE}/${id}/premios/${premioId}/foto`, {
    method: 'PUT',
    body: arquivo,
    headers: { 'Content-Type': arquivo.type },
  });
}

/** URL para `<img src>` (mesma origem: os cookies httpOnly vão junto). */
export const urlFotoPremio = (id: number, premioId: number) => `${HUB_API_BASE}${BASE}/${id}/premios/${premioId}/foto`;

// ── downloads ───────────────────────────────────────────────────────────────

/** Devolve o cabeçalho `X-Premios-Adiados` (0 se ausente) — só a planilha o envia. */
async function baixar(caminho: string, nomePadrao: string, metodo: 'GET' | 'POST' = 'GET'): Promise<number> {
  const res = await fetch(`${HUB_API_BASE}${caminho}`, { method: metodo, credentials: 'include' });
  if (!res.ok) {
    const corpo: unknown = await res.json().catch(() => ({}));
    throw falha(res.status, (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>);
  }
  const blob = await res.blob();
  const nome = res.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1] ?? nomePadrao;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
  const adiados = Number(res.headers.get('X-Premios-Adiados'));
  return Number.isFinite(adiados) && adiados > 0 ? adiados : 0;
}

export const baixarRankingCsv = async (id: number): Promise<void> => {
  await baixar(`${BASE}/${id}/ranking.csv`, `campanha-${id}-ranking.csv`);
};

/** POST: gerar a planilha carimba `exportado_em` no banco. Devolve quantos prêmios ficaram para amanhã. */
export const baixarPlanilhaPremios = (id: number): Promise<number> =>
  baixar(`${BASE}/${id}/premios-dinheiro.xlsx`, `campanha-${id}-premios-dinheiro.xlsx`, 'POST');

export const mensagemAdiados = (n: number): string =>
  `${n} prêmio(s) ficam para amanhã: o Lançamento externo aceita um prêmio por motorista por dia`;
