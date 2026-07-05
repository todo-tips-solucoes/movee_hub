# Briefing S6 — Módulo Faturamento

**Fase:** S6 · **Branch:** `feat/hub-faturamento` · **Pré-requisito:** S4 mergeada
(fatos `FaturamentoLancamento` populados na homolog isolada); S5 recomendada (link para
detalhe do motorista).

## Contexto mínimo (autossuficiente)

- Dados: `FaturamentoLancamento` (fato append-only; §9.2 do plano técnico) — 1 linha =
  1 lançamento (Credito) por entregador OU agregado (linhas de bônus sem `entregador_id`,
  com `recebedor_agregado`). ~4 mil linhas/dia. Categorias reais (`descricao`):
  Corridas concluidas, Valor por Hora Online, Promocao entregador, Tempo de espera na
  origem, Gorjeta, ROUTE_WITH_OCCURRENCE, Percentual atingido de {rotas completas, hora
  online, garantido}, Garantido Entregador. Campos de meta/bônus (`atingido`, `pct_*`,
  `criterio_*`, `margem_fee_*`) só nas linhas de bônus.
- Índices existentes: `(id_empresa, data_referencia)`, `(id_empresa, entregador_id,
  data_referencia)`, `(id_empresa, descricao)` — filtros devem se apoiar neles.
- ⚠️ Ambiente do VPSTodo É PRODUÇÃO — trabalho só no ambiente isolado.
- Referências: plano técnico §7.2/§7.4 (semântica), §9.2, §14 (contratos), §12.6
  (performance), §13 (telas).

## Objetivo

Módulo de consulta de faturamento: lista filtrável, agregados e exportação.

## Escopo

**Inclui**
1. Backend: `GET /api/v1/faturamento` (paginação server-side; filtros: range de datas —
  default 30 dias —, categoria, entregador, subpraça, com/sem vínculo) e
  `GET /api/v1/faturamento/resumo` (`?de&ate&group_by=dia|categoria|entregador` →
  somatórios/contagens). Permissões `faturamento.list/view/export`.
2. Export CSV da lista filtrada (**proteção CSV injection**: prefixar `'` em células
  iniciadas por `= + - @`).
3. Frontend `/faturamento` no shell: cards de totais do período (total, por categoria
  top, nº entregadores), tabela paginada, filtros, link para o detalhe do
  motorista/entregadora (S5), estados vazio/período-sem-dados. Design /ui-ux-pro-max.

**Não inclui:** edição/estorno manual de lançamentos (correção entra por reimportação —
regra do pipeline); dashboards executivos além dos cards; view materializada (só se
`resumo` > 1 s com 1 ano de dados sintéticos — medir e registrar).

## Ordem

endpoints lista/resumo (com EXPLAIN dos filtros) → export → tela → E2E → evidências.

## Testes exigidos

- Unit: montagem de filtros; sanitização CSV.
- Integração: totais do `resumo` conferem com SQL direto nos seeds; paginação estável.
- E2E: filtrar por categoria e range → totais corretos; exportar CSV e conferir
  conteúdo; usuário sem `faturamento.export` não vê/consegue exportar.

## Evidências

Totais UI × SQL lado a lado; CSV exportado (mascarado); EXPLAIN dos filtros usando índice;
tempo do `resumo` com dataset de 1 ano sintético (se disponível da S10 antecipar amostra).

## Critérios de aceite

1. Totais batem com o banco; 2. filtros server-side paginados; 3. export protegido contra
CSV injection; 4. linhas agregadas (sem entregador) exibidas corretamente; 5. permissões
no backend; 6. PR + DIARIO.md.

## Gotchas

- `valor` é `numeric(12,2)` — nunca float no agregado (usar SUM no banco, não em JS).
- Linhas de bônus sem `entregador_id`: filtro "por entregador" não pode escondê-las dos
  totais gerais (mostrar rubrica "agregados/bônus").
- Datas: `data_referencia` (competência) ≠ `data_lancamento` ≠ `data_repasse` — o filtro
  default é por `data_referencia`; deixar explícito na UI.
