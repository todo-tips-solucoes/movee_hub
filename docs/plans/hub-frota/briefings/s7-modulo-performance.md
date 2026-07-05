# Briefing S7 — Módulo Performance

**Fase:** S7 · **Branch:** `feat/hub-performance` · **Pré-requisito:** S4 mergeada
(fatos `PerformanceTurno` populados); S6 recomendada (padrões de tela reaproveitados).

## Contexto mínimo (autossuficiente)

- Dados: `PerformanceTurno` (fato append-only; §9.2) — 1 linha = entregador×turno×dia
  (×subpraça). ~2,7 mil linhas/dia. Métricas: corridas ofertadas/aceitas/rejeitadas/
  completadas/canceladas (invariantes: aceitas+rejeitadas ≤ ofertadas; completadas ≤
  aceitas), `pedidos_concluidos` (pode exceder corridas — multi-pedido), `taxas_centavos`
  (**centavos**), `tempo_disponivel_pct` (percentual), `tempo_disponivel` (interval),
  `min_entregadores_escala` (atributo do turno, desnormalizado), `periodo` (16 turnos,
  ex. `ALMOCO 11H30-15H29`).
- KPIs derivados **na consulta** (não persistidos): taxa de aceitação (aceitas/ofertadas),
  taxa de conclusão (completadas/aceitas), taxa de rejeição — divisões protegidas de zero.
- ⚠️ O ambiente VIVO do cliente no VPSTodo É PRODUÇÃO — trabalho só nos recursos `hub-*`
  do ambiente isolado (rodam no próprio VPSTodo; exceção escopada do G1 — DIARIO.md).
- Referências: plano técnico §7.3, §9.2, §14, §13.

## Objetivo

Módulo de consulta de performance: lista por turno, agregados por dia/turno/entregador e
exportação.

## Escopo

**Inclui**
1. Backend: `GET /api/v1/performance` (filtros: range de datas — default 30 dias —,
   período/turno, subpraça, entregador) e `GET /api/v1/performance/resumo`
   (`group_by=dia|periodo|entregador` → somas de corridas, médias de taxas ponderadas
   pelo denominador — nunca média de percentuais —, soma de taxas em R$).
   Permissões `performance.list/view/export`.
2. Export CSV filtrado (mesma proteção CSV injection da S6).
3. Frontend `/performance` no shell: cards (corridas completadas, taxa de aceitação,
   taxa de conclusão, tempo disponível médio), tabela paginada, filtros. Gráfico simples
   por dia/turno **apenas se** o design system já tiver padrão de gráfico; caso contrário,
   cards+tabela (não introduzir dependência nova sem aprovação).

**Não inclui:** metas/alertas de performance (futuro); comparativos entre entidades;
persistência de KPIs.

## Ordem

endpoints lista/resumo → export → tela → E2E → evidências.

## Testes exigidos

- Unit: cálculo de KPIs (divisão por zero; ponderação correta: taxa agregada =
  Σaceitas/Σofertadas, não média das taxas).
- Integração: resumo confere com SQL direto; centavos→R$ correto (13254 → 132,54).
- E2E: filtros por turno e range; export; permissões negadas para papel `leitura` sem
  `performance.export`.

## Evidências

KPIs UI × SQL; CSV exportado (mascarado); EXPLAIN dos filtros.

## Critérios de aceite

1. KPIs corretos e ponderados; 2. centavos convertidos uma única vez (na
apresentação/consulta, nunca re-persistidos); 3. filtros server-side; 4. export protegido;
5. permissões no backend; 6. PR + DIARIO.md.

## Gotchas

- `taxas_centavos` é int em **centavos** — não dividir duas vezes nem somar como reais.
- Não fazer média de percentuais linha a linha (ponderar pelo denominador).
- Duplicatas legítimas de (entregador, dia, turno, subpraça) existem — a chave real do
  fato é a linha; agregações devem somar, não assumir unicidade.
- Sem dependência nova de gráficos sem aprovação explícita do operador.
