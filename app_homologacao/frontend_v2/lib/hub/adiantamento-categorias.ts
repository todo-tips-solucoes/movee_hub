// Categorias da produção do adiantamento, do jeito que a tela mostra.
//
// A família de cada categoria vem PRONTA do RPC (migration 0087,
// `hub_adiantamento_categoria_familia`) — a tela nunca decide sozinha o que é
// "Promoção", senão tela e cálculo poderiam discordar. Aqui só se dobram os
// membros de uma família num item e se guarda o TOKEN como valor salvo: o
// cálculo inclui todo membro da família, inclusive os que surgirem depois.
import type { CategoriaProducao } from './adiantamentos-api';

/** Rótulo de tela de cada token de família da 0087. */
export const ROTULO_FAMILIA: Record<string, string> = {
  'familia:promocao': 'Promoção',
  'familia:missoes': 'Missões',
};

export interface ItemCategoria {
  /** O valor que vai para `categoriasProducao`: token de família ou nome exato. */
  chave: string;
  rotulo: string;
  lancamentos: number;
  membros: number;
  familia: boolean;
  semMotoristaIdentificado: boolean;
  /** Nomes que casam na busca (o próprio rótulo, ou os membros da família). */
  nomes: string[];
  /** Presente quando o valor salvo não é um item da lista atual:
   *  - `sem_lancamentos`: não apareceu nos últimos 90 dias;
   *  - `dentro_de_familia`: nome de um membro, e a família TAMBÉM está marcada (redundante);
   *  - `fora_da_familia`: nome de um membro, com a família DESMARCADA — é este valor
   *    que mantém a categoria no cálculo, não pode parecer redundante. */
  ausente?: 'sem_lancamentos' | 'dentro_de_familia' | 'fora_da_familia';
  rotuloFamilia?: string;
}

export function montarItensCategoria(disponiveis: CategoriaProducao[], selecionadas: string[]): ItemCategoria[] {
  const porChave = new Map<string, ItemCategoria>();
  const porDescricao = new Map(disponiveis.map((c) => [c.descricao, c]));

  for (const c of disponiveis) {
    const chave = c.familia ?? c.descricao;
    const item = porChave.get(chave);
    if (item) {
      item.lancamentos += c.lancamentos;
      item.membros += 1;
      item.semMotoristaIdentificado ||= c.semMotoristaIdentificado;
      item.nomes.push(c.descricao);
    } else {
      porChave.set(chave, {
        chave,
        rotulo: c.familia ? (ROTULO_FAMILIA[c.familia] ?? c.familia) : c.descricao,
        lancamentos: c.lancamentos,
        membros: 1,
        familia: c.familia !== null,
        semMotoristaIdentificado: c.semMotoristaIdentificado,
        nomes: [c.descricao],
      });
    }
  }

  const itens = [...porChave.values()].sort((a, b) => b.lancamentos - a.lancamentos || a.rotulo.localeCompare(b.rotulo));

  // Valor salvo fora da lista: tem que continuar na tela, senão fica marcado
  // e ninguém consegue desmarcar.
  for (const v of selecionadas) {
    if (porChave.has(v)) continue;
    // Só um membro de família chega aqui com dados: descrição avulsa já é chave.
    const membro = porDescricao.get(v);
    const fam = membro?.familia ?? undefined;
    itens.push({
      chave: v,
      rotulo: ROTULO_FAMILIA[v] ?? v,
      lancamentos: membro?.lancamentos ?? 0,
      membros: 1,
      familia: v in ROTULO_FAMILIA,
      semMotoristaIdentificado: membro?.semMotoristaIdentificado ?? false,
      nomes: [v],
      ausente: !fam ? 'sem_lancamentos' : selecionadas.includes(fam) ? 'dentro_de_familia' : 'fora_da_familia',
      rotuloFamilia: fam ? (ROTULO_FAMILIA[fam] ?? fam) : undefined,
    });
  }
  return itens;
}

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function filtrarItensCategoria(itens: ItemCategoria[], busca: string): ItemCategoria[] {
  const q = semAcento(busca.trim());
  if (!q) return itens;
  return itens.filter((i) => [i.rotulo, ...i.nomes].some((n) => semAcento(n).includes(q)));
}

/** F3: o que pode ser marcado como "entra na nota" é sempre um subconjunto do
 *  extrato — oferecer o resto deixaria marcar algo que o cálculo ignora.
 *  Mesma regra do `hub_adiantamento_categoria_casa` no banco: casa pelo nome
 *  exato ou pelo token da família. */
export function restringirAoExtrato(disponiveis: CategoriaProducao[], extrato: string[]): CategoriaProducao[] {
  return disponiveis.filter((c) => extrato.includes(c.descricao) || (c.familia !== null && extrato.includes(c.familia)));
}
