# Quickstart — hub-faturamento (S6)

Executado no ambiente isolado `hub-homolog` (recursos `hub-*`, exceção G1),
NUNCA em produção. Pré-condição: seeds sintéticos de `FaturamentoLancamento`
já existentes (herdados da S4/S5, tenant sintético `id_empresa=9001`).

## Cenário 1 — Totais e filtros combinados batem com o banco (US1 / SC-001)

1. Autenticar como `qa.importacoes@moveelog.local` (papel `admin_entidade`,
   já tem `faturamento.consultar`/`faturamento.listar` via migration `0026`).
2. Abrir `/hub/dashboard/faturamento` sem filtro.
3. **Expected**: cards mostram total geral, categoria de maior valor e
   contagem de entregadores distintos dos últimos 30 dias (default,
   `data_referencia`); lista paginada abaixo.
4. Aplicar filtro `categoria=Gorjeta` + intervalo de datas específico.
5. **Expected**: cards E lista refletem só esse filtro; rodar
   `SELECT SUM(valor) FROM "FaturamentoLancamento" WHERE id_empresa=9001 AND
   descricao='Gorjeta' AND data_referencia BETWEEN ... ` direto no
   `hub_homolog_db` e confirmar que bate exatamente com `totalGeral`.

## Cenário 2 — Agregados/bônus nunca somem dos totais (US1 / SC-002)

1. Sem filtro de entregador, conferir que `totalGeral` inclui os
   lançamentos com `entregador_id IS NULL`.
2. Aplicar `comEntregador=false`.
3. **Expected**: lista mostra só os agregados/bônus, todos rotulados
   "Agregados/bônus"; `entregadoresDistintos=0` (nenhum `entregador_id` não
   nulo no filtro).
4. Aplicar `entregadorId=<um id específico>`.
5. **Expected**: nenhum agregado/bônus aparece; total do cenário 1 (sem
   filtro) permanece inalterado ao remover o filtro por entregador.

## Cenário 3 — Empate no card de categoria (Clarification Q4 / dec-014 / FR-003)

1. Via seed/insert controlado no `hub_homolog_db`, criar 2 categorias com
   `SUM(valor)` EXATAMENTE iguais no mesmo período filtrado (ex.: "Zebra" e
   "Alfa", ambas somando 100.00).
2. Consultar `GET /faturamento/resumo` para esse período.
3. **Expected**: `categoriaMaiorValor` = `"Alfa"` (primeira em ordem
   alfabética entre as empatadas) — nunca as duas, nunca aleatório entre
   execuções repetidas da mesma consulta.

## Cenário 4 — Agrupamentos por dia/categoria/entregador (US1 / FR-004)

1. `GET /faturamento/resumo?groupBy=entregador` no período padrão.
2. **Expected**: um grupo com `chave: "agregados_bonus"`, `rotulo:
   "Agregados/bônus"`, consolidando TODOS os lançamentos sem entregador do
   período — nenhum grupo separado por `recebedor_agregado`.
3. Repetir com `groupBy=categoria` e `groupBy=dia`; conferir que a soma dos
   `total` de todos os grupos bate com `totalGeral` do cenário 1 (sem
   filtro adicional).

## Cenário 5 — Data de competência é a única usada no filtro (US1 cenário 6)

1. Localizar (via seed ou consulta direta) um lançamento cuja
   `data_repasse` caia FORA do intervalo `de`/`ate` filtrado mas cuja
   `data_referencia` caia DENTRO.
2. Filtrar por esse intervalo.
3. **Expected**: o lançamento aparece na lista (o filtro usa
   `data_referencia`, `data_repasse` é ignorada); a UI rotula
   explicitamente o filtro como "data de competência".

## Cenário 6 — Período sem dados (US1 cenário 5 / FR-012)

1. Filtrar um intervalo de datas sem nenhum lançamento (ex.: ano 2000).
2. **Expected**: `GET /faturamento` retorna `{ items: [], total: 0, ... }`
   (200, não erro); `GET /faturamento/resumo` retorna `{ totalGeral: "0.00",
   categoriaMaiorValor: null, entregadoresDistintos: 0 }`; a tela mostra
   estado "período sem dados" (nunca tela em branco ou erro).

## Cenário 7 — Export CSV: conteúdo e contagem batem com a tela (US2 / SC-001)

1. Aplicar um filtro (ex.: categoria + intervalo) na tela.
2. Acionar exportação.
3. **Expected**: arquivo CSV baixado tem exatamente `total` linhas (mesma
   contagem do cenário 1) + 1 linha de cabeçalho; abrir em planilha e somar
   a coluna `valor` manualmente — bate com `totalGeral` do mesmo filtro.

## Cenário 8 — CSV injection neutralizada (US2 / FR-007 / SC-005)

1. Via seed controlado, criar um lançamento cujo `descricao` (categoria)
   comece com `=` (ex.: `=SOMA(A1:A10)`) e outro cujo `entregador.nome`
   comece com `@`.
2. Exportar CSV incluindo esses lançamentos.
3. **Expected**: as células correspondentes aparecem no arquivo prefixadas
   com `'` (ex.: `'=SOMA(A1:A10)`); abrir em LibreOffice Calc/Excel e
   confirmar que a célula é exibida como TEXTO, nenhuma fórmula executada.
4. Via seed controlado, criar um lançamento cujo `descricao` (categoria) já
   comece com apóstrofo (ex.: `'já protegida`) e outro que comece com um
   caractere neutro fora do conjunto perigoso (ex.: `#tag-interna`) — caso
   CHK029 (gap fechado por `lib/hub-csv.js`, tasks.md 2.2).
5. Exportar CSV incluindo esses lançamentos.
6. **Expected**: a célula com apóstrofo aparece com um ÚNICO apóstrofo no
   arquivo (`'já protegida`, nunca `''já protegida` — sem dupla
   neutralização); a célula com `#tag-interna` aparece EXATAMENTE como veio,
   sem qualquer prefixo adicionado. Abrir em LibreOffice Calc/Excel e
   confirmar ausência de duplo prefixo/corrupção visual em ambas.

## Cenário 9 — Export vazio gera só cabeçalho (edge case explícito)

1. Filtrar um período sem dados (cenário 6) e acionar exportação.
2. **Expected**: arquivo CSV gerado com sucesso (200), contendo apenas a
   linha de cabeçalho — não é tratado como erro.

## Cenário 10 — Permissões independentes: listar/consultar/exportar (US1+US2 / FR-008 / SC-006)

1. Criar um usuário de teste com papel que tenha `faturamento.listar` mas
   NÃO `faturamento.exportar` (ex.: `operador`, conforme migration `0026`).
2. **Expected**: a tela mostra a lista e os cards normalmente; o botão de
   exportar NÃO aparece na interface.
3. Acionar `GET /faturamento?format=csv` diretamente (bypass da UI, ex.
   via `curl` com o cookie de sessão desse usuário).
4. **Expected**: `403 { erro: 'PERMISSAO_NEGADA' }`, nenhum arquivo gerado
   (User Story 2 cenário 4 — bypass da interface continua recusado).
5. Repetir com um usuário SEM `faturamento.listar`: nenhum controle da tela
   (lista, cards, exportar) aparece; `GET /faturamento` direto retorna `403`.

## Cenário 11 — Isolamento multi-tenant (Constitution II / FR-009 / SC-007)

1. Criar/usar 2 entidades de teste distintas (`id_empresa` diferentes) com
   lançamentos próprios.
2. Autenticado na entidade A, consultar `GET /faturamento` e `GET
   /faturamento/resumo` com filtros amplos (sem `de`/`ate` restritivos).
3. **Expected**: zero lançamentos da entidade B aparecem em qualquer
   resposta — nem na lista, nem nos totais, nem no export CSV.

## Cenário 12 — Navegação para o detalhe do entregador (US3 / FR-010)

1. Na lista, localizar um lançamento com `entregadorId` não-nulo; acionar
   o link.
2. **Expected**: navega para `/hub/dashboard/motoristas/{entregadorId}`
   correto (S5), sem ambiguidade.
3. Localizar um lançamento agregado/bônus (`entregadorId: null`).
4. **Expected**: nenhum link de navegação aparece nessa linha.
5. Repetir o passo 1 autenticado como usuário SEM `motoristas.consultar`.
6. **Expected**: o link não aparece (frontend oculta); se acionado
   diretamente via URL, `GET /motoristas/{id}` no backend do módulo de
   destino recusa com `403` (autoridade final continua lá, não aqui).

## Cenário 13 — Roundtrip End-to-End (contrato real, não mock)

1. Fazer login real no `hub-homolog`, obter cookie de sessão.
2. Chamar `GET /api/v1/faturamento?pageSize=5` via `curl`/script real
   (nunca fixture) contra o backend vivo.
3. **Expected**: payload de resposta bate EXATAMENTE o shape declarado em
   `contracts/faturamento-api.md` (campos, camelCase, `valor` como string)
   — parseado pelo mesmo `lib/hub/faturamento-dto.ts` que o frontend usa
   (nenhum mock no meio). Mesmo procedimento para `GET
   /faturamento/resumo` (com e sem `groupBy`) e para `?format=csv` (validar
   `Content-Type`/`Content-Disposition` reais). Evita o drift
   snake_case↔camelCase que já custou 40 ondas em execuções anteriores
   (dec-172/173, citado pela skill `/plan`).

## Cenário 14 — Identidade visual preservada (SC-008)

1. Alternar tema claro/escuro e branding de tenant (se aplicável ao tenant
   de teste) na tela `/hub/dashboard/faturamento`.
2. **Expected**: sem regressão perceptível em relação ao restante do
   painel (mesmos tokens de cor/tipografia do design system EntreGô 2.0).

## Cenário 15 — Performance de agregados sob volume ampliado (SC-004)

**Pré-condição**: seed de volume ampliado (~900 mil linhas de
`FaturamentoLancamento` para `id_empresa=9001`, equivalente a ~1 ano —
`docs/plans/hub-frota/01-plano-tecnico.md §7.7`), gerado especificamente
para este cenário (o seed padrão do hub-homolog tem só 212 linhas —
research.md Decision 8). Este cenário roda uma única vez na fase
`execute-task`, não é regressão de todo `/feature-00c-resume`.

1. Popular o volume ampliado.
2. Medir o tempo de resposta de `GET /faturamento/resumo` (sem `groupBy` e
   com `groupBy=categoria`) para o intervalo `de`/`ate` cobrindo todo o
   ano populado.
3. **Expected**: resposta em menos de 1 segundo (SC-004). Se exceder,
   registrar a evidência (tempo medido, `EXPLAIN ANALYZE` da query) como
   Decisão auditável e SÓ ENTÃO avaliar a view materializada
   `mv_faturamento_dia` mencionada em §12.6 do plano técnico — nunca
   implementá-la preventivamente sem essa evidência.
