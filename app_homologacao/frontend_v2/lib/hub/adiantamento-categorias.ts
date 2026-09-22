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
  /** Presente quando o valor salvo não é um item da lista atual. */
  ausente?: 'sem_lancamentos' | 'dentro_de_familia';
  rotuloFamilia?: string;
}

export function montarItensCategoria(disponiveis: CategoriaProducao[], selecionadas: string[]): ItemCategoria[] {
  const porChave = new Map<string, ItemCategoria>();
  const familiaDe = new Map<string, string>(); // descrição -> token

  for (const c of disponiveis) {
    const chave = c.familia ?? c.descricao;
    if (c.familia) familiaDe.set(c.descricao, c.familia);
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
    const fam = familiaDe.get(v);
    itens.push({
      chave: v,
      rotulo: ROTULO_FAMILIA[v] ?? v,
      lancamentos: 0,
      membros: 1,
      familia: v in ROTULO_FAMILIA,
      semMotoristaIdentificado: false,
      nomes: [v],
      ausente: fam ? 'dentro_de_familia' : 'sem_lancamentos',
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
