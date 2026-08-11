import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { EnvioMassa, FilterState, StatsData } from "@/types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBRL(valor: number | string): string {
  const num = typeof valor === 'string' ? parseFloat(valor) : valor;
  if (isNaN(num)) return 'R$ 0,00';
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatDateBR(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const formatted = date.toLocaleDateString('pt-BR');
  if (formatted === '31/12/1969') return '';
  return formatted;
}

export function computeStats(data: EnvioMassa[]): StatsData {
  let msgEnviada = 0;
  let msgErro = 0;
  let xmlEnviado = 0;
  let xmlErro = 0;

  for (const item of data) {
    if (item.enviado === 'ok') msgEnviada++;
    if (item.enviado === 'erro') msgErro++;
    if (item.numnota && item.nota_ok && item.data_emissao && !item.erro_validacao) {
      xmlEnviado++;
    }
    if (item.numnota && item.nota_ok && item.data_emissao && item.erro_validacao) {
      xmlErro++;
    }
  }

  return {
    total: data.length,
    msgEnviada,
    msgErro,
    xmlEnviado,
    xmlErro,
  };
}

export function applyFilters(data: EnvioMassa[], filters: FilterState): EnvioMassa[] {
  return data.filter((item) => {
    if (filters.numero && !item.number?.toLowerCase().includes(filters.numero.toLowerCase())) return false;
    if (filters.nome && !item.nome?.toLowerCase().includes(filters.nome.toLowerCase())) return false;
    if (filters.valor && !String(item.valor).includes(filters.valor)) return false;
    if (filters.numNota && !(item.numnota || '').toLowerCase().includes(filters.numNota.toLowerCase())) return false;

    if (filters.dataEmissao) {
      if (!item.data_emissao) return false;
      const itemDate = new Date(item.data_emissao);
      const filterDate = new Date(filters.dataEmissao + 'T00:00:00');
      if (isNaN(itemDate.getTime()) || isNaN(filterDate.getTime())) return false;
      if (itemDate.toDateString() !== filterDate.toDateString()) return false;
    }

    if (filters.enviado === 'yes' && item.enviado !== 'ok') return false;
    if (filters.enviado === 'no' && item.enviado === 'ok') return false;

    if (filters.sucesso === 'yes' && item.enviado !== 'erro') return false;
    if (filters.sucesso === 'no' && item.enviado === 'erro') return false;

    if (filters.validacao === 'yes' && !item.erro_validacao) return false;
    if (filters.validacao === 'no' && item.erro_validacao) return false;

    if (filters.enviouNota === 'yes' && !item.numnota) return false;
    if (filters.enviouNota === 'no' && item.numnota) return false;

    return true;
  });
}

/**
 * Ordenação da tabela de envio em massa (impeccable rodada 15, h7=2).
 *
 * Só existe porque esta tela tem TODAS as linhas no cliente (`applyFilters` +
 * `slice` no `use-envio-massa`): ordenar aqui reordena o conjunto inteiro. Nas
 * listas do hub a paginação é server-side e a ordem vem fixa do backend
 * (`order=nome.asc` em `hub-motoristas.js`, `order=criado_em.desc` em
 * `hub-importacoes.js`) — ordenar só a página carregada mostraria "o maior
 * valor" que é apenas o maior dos 20 visíveis. Aquilo é mudança de contrato,
 * não de tela.
 */
export type ColunaOrdenavel = 'number' | 'nome' | 'valor' | 'data_emissao';

export interface Ordenacao {
  coluna: ColunaOrdenavel;
  direcao: 'asc' | 'desc';
}

/** Número quando os dois lados são numéricos; texto pt-BR caso contrário. */
function compararTexto(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, 'pt-BR');
}

export function ordenarDados(data: EnvioMassa[], ordem: Ordenacao | null): EnvioMassa[] {
  if (!ordem) return data;
  const fator = ordem.direcao === 'asc' ? 1 : -1;

  // `slice` antes de ordenar: `sort` muda o array no lugar, e este array é o
  // `filteredData` memoizado — ordenar nele corromperia a fonte.
  return data.slice().sort((a, b) => {
    switch (ordem.coluna) {
      case 'valor': {
        // `valor` chega `number | string` do backend legado.
        const va = Number(a.valor) || 0;
        const vb = Number(b.valor) || 0;
        return (va - vb) * fator;
      }
      case 'data_emissao': {
        // Linha sem data vai SEMPRE para o fim, nos dois sentidos: nulo não é
        // "a data mais antiga", é ausência — colocá-lo no meio da ordem
        // decrescente faria parecer que existe uma data ali.
        if (!a.data_emissao && !b.data_emissao) return 0;
        if (!a.data_emissao) return 1;
        if (!b.data_emissao) return -1;
        return a.data_emissao.localeCompare(b.data_emissao) * fator;
      }
      case 'nome':
        return compararTexto(a.nome || '', b.nome || '') * fator;
      case 'number':
      default:
        return compararTexto(a.number || '', b.number || '') * fator;
    }
  });
}

/**
 * Ciclo do clique no cabeçalho: asc → desc → sem ordenação. O terceiro estado
 * existe para dar caminho de volta à ordem original (a de chegada dos dados),
 * que é a única em que "a última linha importada" está no fim.
 */
export function proximaOrdenacao<C extends string>(
  atual: { coluna: C; direcao: 'asc' | 'desc' } | null,
  coluna: C
): { coluna: C; direcao: 'asc' | 'desc' } | null {
  if (!atual || atual.coluna !== coluna) return { coluna, direcao: 'asc' };
  if (atual.direcao === 'asc') return { coluna, direcao: 'desc' };
  return null;
}

/**
 * Há algum filtro fora do padrão? (impeccable rodada 14, h3)
 *
 * Serve para decidir se uma ação que SUBSTITUI os filtros precisa avisar: sem
 * nada ativo, não há trabalho a perder e o aviso seria ruído. Compara contra
 * `initialFilters` chave a chave em vez de listar os campos "que contam" —
 * assim um filtro novo entra na conta sozinho, sem ninguém lembrar de vir
 * aqui.
 */
export function temFiltroAtivo(filters: FilterState): boolean {
  return (Object.keys(initialFilters) as (keyof FilterState)[]).some(
    (chave) => filters[chave] !== initialFilters[chave]
  );
}

export const initialFilters: FilterState = {
  numero: '',
  nome: '',
  valor: '',
  numNota: '',
  dataEmissao: '',
  enviado: 'all',
  sucesso: 'all',
  validacao: 'all',
  enviouNota: 'all',
};
