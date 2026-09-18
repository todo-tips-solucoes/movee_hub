'use client';

// adiantamento-motorista — hooks/use-selecao-lote.ts (tasks.md 7.6.1, H09)
//
// Seleção em massa CROSS-PÁGINA para montar lote de pagamento. Diferente da
// aprovação em massa de `contas/page.tsx` (que seleciona só a página
// carregada — nenhuma task pediu mais que isso ali), o protótipo H09 pede
// "Selecionar as N do filtro": a listagem de solicitações pagina no máximo
// 100 por vez (`PAGE_SIZE_MAX`, routes/hub-adiantamentos.js:70), então
// selecionar as 152 do filtro exige buscar os ids por todas as páginas —
// não só os objetos já carregados na tela.
//
// Guarda só ids (não os objetos completos): é tudo que `/lotes/previa` e
// `/lotes` precisam (adiantamentos-api.ts `previaLote`/`criarLote`).
import { useCallback, useState } from 'react';
import { listarSolicitacoes, type SolicitacoesFiltros } from '@/lib/hub/adiantamentos-api';

/** Limite de itens por lote do parceiro de pagamento (Transfeera) — FR-032 /
 * edge #25, espelha `LOTE_LIMITE_IDS` em routes/hub-adiantamentos.js:71 e a
 * mesma checagem em `hub_adiantamento_lote_criar` (infra/hub/migrations/0067). */
export const LIMITE_LOTE = 5000;

/** Teto de itens por página da listagem (routes/hub-adiantamentos.js
 * `PAGE_SIZE_MAX`) — usado ao varrer todas as páginas do filtro. */
const PAGE_SIZE_BUSCA = 100;

export function useSelecaoLote() {
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [carregandoTodos, setCarregandoTodos] = useState(false);

  const toggle = useCallback((id: number) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }, []);

  /** Marca/desmarca só os ids da página atual — mesmo padrão de
   * `toggleSelecionarPagina` de `contas/page.tsx`, sem apagar seleção de
   * outras páginas. */
  const toggleTodosDaPagina = useCallback((idsDaPagina: number[]) => {
    setSelecionados((atual) => {
      const todosMarcados = idsDaPagina.length > 0 && idsDaPagina.every((id) => atual.has(id));
      const novo = new Set(atual);
      for (const id of idsDaPagina) {
        if (todosMarcados) novo.delete(id);
        else novo.add(id);
      }
      return novo;
    });
  }, []);

  const limpar = useCallback(() => setSelecionados(new Set()), []);

  /** Busca todos os ids que casam o filtro atual, paginando até `total` ou
   * até `LIMITE_LOTE` (o que vier primeiro — edge #25: nunca selecionar
   * além do que um lote pode conter). Devolve o `total` real do filtro, para
   * a tela avisar quando ele excede o limite. */
  const selecionarTodosDoFiltro = useCallback(async (filtros: SolicitacoesFiltros): Promise<number> => {
    setCarregandoTodos(true);
    try {
      let page = 1;
      const acumulado: number[] = [];
      let total = Infinity;
      while (acumulado.length < total && acumulado.length < LIMITE_LOTE) {
        const resposta = await listarSolicitacoes({ ...filtros, page, pageSize: PAGE_SIZE_BUSCA });
        total = resposta.total;
        if (resposta.itens.length === 0) break;
        acumulado.push(...resposta.itens.map((i) => i.id));
        page += 1;
      }
      setSelecionados(new Set(acumulado.slice(0, LIMITE_LOTE)));
      return total;
    } finally {
      setCarregandoTodos(false);
    }
  }, []);

  return { selecionados, toggle, toggleTodosDaPagina, limpar, selecionarTodosDoFiltro, carregandoTodos };
}
