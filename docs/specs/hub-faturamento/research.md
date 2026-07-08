# Phase 0 — Research (hub-faturamento / S6)

Todas as `[NEEDS CLARIFICATION]` da spec já foram resolvidas no `/clarify`
(5 perguntas — Q1-Q3 dec-009/010/011/012, Q4 dec-014). Este documento resolve
as decisões TÉCNICAS necessárias para o design (Phase 1), com evidência
empírica onde aplicável.

## Decision 1 — Duas migrations novas: `0026` (RBAC) e `0027` (funções RPC de resumo)

**Decision**: esta fase introduz exatamente 2 migrations, cada uma coesa a
um único assunto (mesma convenção de `0021`-`0023` em `hub-motoristas`, que
também separou tabela de função RPC): `0026_seed_permissao_faturamento_listar.sql`
adiciona a permissão que falta para tornar FR-008 implementável —
`faturamento.listar` — e concede-a aos papéis que hoje já teriam acesso
operacional de leitura (RBAC puro, seed-only); `0027_hub_faturamento_rpc_resumo.sql`
cria as 2 funções SQL de agregação usadas por `GET /faturamento/resumo`
(Decision 2). Nenhuma tabela, coluna ou índice novo em `FaturamentoLancamento`
(ela já existe completa desde a
migration `0013`, com os 3 índices que os filtros desta fase precisam —
`idx_faturamentolancamento_empresa_data`,
`idx_faturamentolancamento_empresa_entregador_data`,
`idx_faturamentolancamento_empresa_descricao` — e o índice de subpraça já
chegou na S5, `idx_faturamento_empresa_subpraca`, `0020`).

**Rationale**: `grep -n "faturamento\." infra/hub/migrations/0007_seed_papeis_permissoes_modulos.sql`
mostra apenas 2 códigos seedados — `faturamento.consultar` e
`faturamento.exportar` — nenhum equivalente a `listar`. Mas FR-008 exige TRÊS
permissões INDEPENDENTES: listagem da lista de lançamentos, visualização dos
resumos/agregados, e exportação. O módulo `motoristas` já estabeleceu esse
exato split (`motoristas.consultar` + `motoristas.listar` convivem desde o
mesmo `0007`) — reaproveitar essa convenção em vez de sobrecarregar
`faturamento.consultar` com dois significados (listar E ver resumo)
preserva FR-007 (`modulo.acao`) e evita uma permissão "faz-tudo" que
violaria a independência exigida pelo FR-008/SC-006.

**Migration `0026` (resumo, sem código ainda — Phase 2/`create-tasks` escreve o SQL real)**:
1. `INSERT INTO "Permissao" ('faturamento.listar', modulo_id=faturamento) ON CONFLICT DO NOTHING`.
2. Concede a `admin_plataforma`/`admin_entidade` (que já têm os demais
   códigos de `faturamento` via `CROSS JOIN` original do `0007` — precisa de
   INSERT explícito porque `PapelPermissao` foi populada por snapshot em
   `0007`, não é uma view; um `Permissao` novo não se propaga sozinho).
3. Concede a `operador` e `leitura` (ambos já têm `faturamento.consultar`
   hoje — sem a concessão de `listar`, esses papéis ficariam capazes de ver
   o resumo mas não a lista, uma regressão de capacidade absurda face ao
   objetivo do papel). `faturamento.exportar` continua FORA de
   `operador`/`leitura` (mesmo padrão já vigente — só os papéis admin têm
   export).

**Alternatives considered**: (a) reaproveitar `faturamento.consultar` para
cobrir tanto lista quanto resumo — rejeitado: viola FR-008 literalmente
("de forma independente entre si") e o teste SC-006 (ocultar/negar controle
de exportação não cobre a independência entre listar e ver resumo cobrada
pela Acceptance Scenario 1 c/ cards+lista simultâneos, mas com papéis que só
tenham UM dos dois — cenário plausível: um papel "só resumo" que não deveria
ver a lista crua de lançamentos, ex. compliance vendo só agregados). (b)
criar uma 4ª permissão fina por sub-agregado — rejeitado, sobre-engenharia
sem requisito que a justifique.

---

## Decision 2 — Agregados via 2 funções RPC no PostgREST (não SQL ad-hoc client-side, não Node)

**Decision**: `GET /faturamento/resumo` chama, via `POST /rpc/...` interno
do backend (mesmo mecanismo de `lib/hub-postgrest.js`), as duas funções SQL
criadas pela migration `0027` (Decision 1):

- `hub_faturamento_totais(p_id_empresa, p_de, p_ate, p_categoria,
  p_entregador_id, p_subpraca, p_com_entregador)` → `TABLE(total_geral
  numeric, categoria_maior_valor text, entregadores_distintos int)`
  (FR-003). Implementa o desempate alfabético (Decision 3) e o `COUNT(DISTINCT
  entregador_id)` (que já ignora `NULL` nativamente em SQL — nenhum
  tratamento especial necessário para excluir agregados/bônus da contagem
  de entregadores distintos).
- `hub_faturamento_agrupado(p_id_empresa, p_de, p_ate, p_categoria,
  p_entregador_id, p_subpraca, p_com_entregador, p_group_by)` →
  `TABLE(chave text, total numeric, quantidade int)`, `p_group_by IN ('dia',
  'categoria', 'entregador')` (FR-004). Quando `p_group_by = 'entregador'`,
  `chave` é `entregador_id::text` OU o literal `'agregados_bonus'` quando
  `entregador_id IS NULL` (Decision 4).

**Rationale**: mesma decisão já tomada e validada pelo gate `owasp-security`
em `hub-motoristas` (research.md Decision 10) — função RPC parametrizada
elimina by-construction qualquer risco de SQL ad-hoc concatenado (A05
Injection) e centraliza a soma numérica em Postgres (`SUM(valor)` sobre
`numeric(12,2)` nativo — zero ponto flutuante, satisfazendo FR-003
literalmente). Fazer a agregação em Node exigiria carregar todas as linhas
do período na memória do backend (o oposto do que FR-006 já proíbe para o
export, e desnecessário: Postgres agrega melhor que Node). RLS já protege
ambas as funções (`SECURITY INVOKER` — o papel `authenticated` do JWT gerado
por `lib/hub-postgrest-jwt.js` já carrega o escopo de `id_empresa` via
`hub_jwt_escopo_ids()`, mesma policy que `FaturamentoLancamento` já usa —
BOLA por escopo cruzado é estruturalmente impossível, mesmo padrão do
Decision 11 de `hub-motoristas`).

**Alternatives considered**: (a) `?select=descricao,valor.sum()` via feature
experimental de agregação do PostgREST — rejeitado: não confirmado
disponível/habilitado nesta instância (`db-aggregates-enabled`), e mesmo se
estivesse, não resolveria o desempate alfabético determinístico (FR-003)
nem o bucket fixo de agregados/bônus (FR-004) sem lógica adicional client-side
— então o ganho de "não escrever SQL" desaparece. (b) view materializada —
explicitamente fora de escopo pela spec (§Não inclui) até SC-004 medir
degradação real.

---

## Decision 3 — Desempate alfabético embutido na RPC (dec-014)

**Decision**: `hub_faturamento_totais` resolve `categoria_maior_valor` com
uma subquery `SELECT descricao FROM (<mesmo filtro>) GROUP BY descricao
ORDER BY SUM(valor) DESC, descricao ASC LIMIT 1` — o `ORDER BY ..., descricao
ASC` é o desempate determinístico decidido pelo operador (dec-014, spec
Clarifications Session 2026-07-08). Nenhuma lógica de desempate no
frontend nem no backend Node — o banco já entrega uma única linha.

**Rationale**: resolver no SQL evita que dois clientes (app + export CSV,
ou dois usuários simultâneos) precisem reimplementar a mesma regra de
desempate e divirjam por bug — fonte única da verdade.

---

## Decision 4 — Bucket "agregados/bônus" por `entregador_id IS NULL`, rótulo fixo (dec-010)

**Decision**: O agrupamento por entregador (`group_by=entregador`) usa
`CASE WHEN entregador_id IS NULL THEN 'agregados_bonus' ELSE
entregador_id::text END` como chave — nunca o valor de `recebedor_agregado`
(que é só um rótulo textual livre da importação, não uma chave de
agrupamento). A API DTO traduz a chave `'agregados_bonus'` para o rótulo de
exibição `"Agregados/bônus"` no mapeamento camelCase (mesma camada que já
mapeia `entregador_id` → nome via join com `Entregador`).

**Rationale**: já decidido no `/clarify` (dec-010); a decisão técnica aqui é
só ONDE a consolidação acontece (SQL, não Node) — consistente com Decision 2.

---

## Decision 5 — Export CSV via paginação interna em lotes (streaming sem buffer total)

**Decision**: `GET /faturamento?format=csv` NÃO usa o padrão hoje existente
em `GET /importacoes/:id/erros?format=csv` (que carrega TODAS as linhas
numa única chamada `hubPostgrestRequest` antes de gerar o CSV — aceitável
lá porque erros de importação são limitados ao tamanho de um arquivo
importado, tipicamente < 5% de milhares de linhas). Para faturamento,
FR-006 exige explicitamente "gerada de forma incremental (streaming), sem
carregar o conjunto completo de linhas em memória" — volume potencialmente
ilimitado (sem teto de período, dec-011).

Implementação: laço de paginação Range do PostgREST (mesmo mecanismo já
usado por `parsePaginacao`/`opts.range` em `lib/hub-postgrest.js`), lotes
fixos de 1.000 linhas (`LOTE_EXPORT_CSV = 1000`, dentro da faixa de
lote já validada em produção pelo pipeline de importação — §12.6 do plano
técnico usa 500 para *escrita*; 1.000 para *leitura paginada* é conservador
e não introduz padrão novo, é só um número maior de itens por página do
mesmo mecanismo `Range`). A cada lote: buscar via `hubPostgrestRequest`
(que ainda buferiza aquele lote inteiro — 1.000 linhas de texto é
desprezível), converter para linhas CSV (Decision 6), `res.write(...)` e
descartar o lote da memória antes de buscar o próximo. `res.end()` só após
o último lote (ou lote vazio). O corpo completo do CSV NUNCA existe de uma
vez na memória do processo — satisfaz FR-006 no sentido pretendido (memória
limitada a ~1 lote, não ao total do período).

**Rationale**: reaproveita 100% da infraestrutura de paginação já testada
(`opts.range`/`opts.count`) sem introduzir dependência nova (stream nativo
do PostgreSQL via `pg` driver bruto seria mais "puro" mas contradiz a
decisão arquitetural de todo o hub de falar com o banco EXCLUSIVAMENTE via
PostgREST — nenhuma exceção aberta por esta fase).

**Alternatives considered**: (a) endpoint separado `/faturamento/export` —
rejeitado, quebra o padrão já estabelecido (`?format=csv` no mesmo recurso,
igual a `/importacoes/:id/erros`); menos superfície de contrato para manter
consistência. (b) usar o corpo inteiro como hoje em `erros` — rejeitado,
viola FR-006 explicitamente para volumes grandes.

---

## Decision 6 — Proteção CSV injection: extrair para `lib/hub-csv.js` compartilhado

**Decision**: `escaparCelulaCsvInjection`/`quotarCelulaCsv`, hoje privadas em
`lib/hub-importacoes-dto.js`, são extraídas para um módulo novo
`lib/hub-csv.js` (sem mudança de comportamento) e reusadas por
`lib/hub-faturamento-dto.js`. `lib/hub-importacoes-dto.js` passa a importar
de lá (refactor aditivo, sem mudança de contrato externo — os testes
existentes de `hub-importacoes-dto.test.js` continuam válidos sem
alteração).

**Rationale**: FR-007/SC-005 exigem exatamente a mesma regra
(`= + - @` → prefixo `'`) já implementada e testada para
`/importacoes/:id/erros`. Duplicar o código é o tipo de drift que a spec
deste toolkit já documentou como custoso (dec-172/173 citado pela skill
`/plan`); extrair uma vez é mais barato que manter duas implementações
sincronizadas manualmente.

---

## Decision 7 — Precisão monetária: totais agregados trafegam como `text` na API

**Decision**: os campos monetários agregados (`totalGeral`,
`total` por grupo em `/resumo`) são serializados como **string decimal**
(`numeric::text` na RPC, sem `::float`) no contrato JSON — não como `number`
JS. Linhas individuais da lista (`GET /faturamento`, campo `valor`) seguem
o mesmo padrão por consistência (mesmo shape de valor monetário em toda a
API).

**Rationale**: FR-003 exige "nenhuma soma de valores monetários MUST ser
realizada com aritmética de ponto flutuante" — a soma em si já acontece
100% em Postgres (Decision 2), então o requisito literal já está satisfeito
independente do transporte. Mas trafegar como `number` JSON deixa a porta
aberta para um engenheiro futuro somar/formatar com `+`/`toFixed` no
frontend (ex.: somar `totalGeral` de duas chamadas para exibir um total
combinado) e reintroduzir imprecisão de ponto flutuante bem no limite da
fase seguinte. Transportar como string é mais barato hoje (~zero custo, só
um `::text` na função) do que remediar um bug de centavos depois. Formatação
de exibição usa `Intl.NumberFormat('pt-BR', {style:'currency',...})` sobre
o `Number(valor)` só no MOMENTO de renderizar, nunca antes de operações
aritméticas adicionais (que não existem nesta fase read-only).

**Evidence**: `docker exec` no `hub_homolog_db` (recurso `hub_-`, dentro da
exceção G1) — `\d "FaturamentoLancamento"` confirma `valor numeric(12,2) NOT
NULL CHECK (valor > 0)`; `numeric(12,2)` serializado por `json_agg`/`row_to_json`
do Postgres já vem como JSON number por padrão — o cast `::text` explícito é
necessário justamente para forçar string.

---

## Decision 8 — Medição de SC-004 fica para a fase de implementação (dataset atual insuficiente)

**Decision**: a decisão sobre view materializada (`mv_faturamento_dia`,
mencionada como gatilho condicional em §12.6 do plano técnico) permanece
EXPLICITAMENTE não tomada nesta fase — conforme a spec já instrui — e a
medição empírica de SC-004 (resumo de "um ano de operação" em < 1s) é
tarefa da fase `execute-task`/quickstart (precisa de um seed de volume
ampliado, o hub-homolog hoje tem só uma fração ínfima do volume-alvo).

**Evidence** (medição feita agora, para confirmar que o desenho dos índices
está correto mesmo sem o volume final):
```
$ docker exec hub_homolog_db psql -U hub_homolog -d hub_homolog -c \
  'SELECT count(*) FROM "FaturamentoLancamento";'
 count
-------
   212
(1 row)

$ ... EXPLAIN (COSTS OFF) SELECT descricao, SUM(valor) ...
      WHERE id_empresa = 9001 AND data_referencia BETWEEN CURRENT_DATE-30 AND CURRENT_DATE
      GROUP BY descricao ORDER BY total DESC, descricao ASC LIMIT 1;
 Limit
   ->  Sort (Sort Key: (sum(valor)) DESC, descricao)
         ->  HashAggregate (Group Key: descricao)
               ->  Seq Scan on "FaturamentoLancamento"
                     Filter: (id_empresa = 9001 AND data_referencia <= CURRENT_DATE
                              AND data_referencia >= (CURRENT_DATE - 30))
```
O planner escolheu `Seq Scan` — comportamento ESPERADO e correto do
otimizador para uma tabela de 212 linhas (varrer tudo é mais barato que usar
índice). `\d "FaturamentoLancamento"` confirma que
`idx_faturamentolancamento_empresa_data (id_empresa, data_referencia)`
existe e cobre exatamente as colunas do `WHERE` — quando o volume crescer
(seed ampliado ou dados reais), o planner troca automaticamente para
`Index Scan`/`Bitmap Index Scan` sem qualquer mudança de código. A tarefa de
`execute-task` que roda o quickstart de performance MUST gerar (ou
solicitar) um seed com volume equivalente a ~1 ano (~900 mil linhas de
faturamento, conforme §7.7 do plano técnico) antes de medir SC-004 com
significância.

**Rationale**: medir agora com 212 linhas produziria uma "evidência" de
`< 1ms` completamente não-representativa — pior que não medir, porque cria
falsa confiança. A spec já antecipa isso explicitamente
("a decisão e a medição ficam registradas como parte desta fase, não
presumidas antes dela") — registrar a decisão de ADIAR a medição para
quando o dado existir é, em si, o cumprimento correto dessa cláusula.

---

## Decision 9 — Permissão de export verificada de forma independente e explícita (FR-008, User Story 2 cenário 4)

**Decision**: `GET /faturamento` usa `requirePermission('faturamento.listar')`
no nível de rota (Express middleware, igual a todos os outros endpoints).
Quando `req.query.format === 'csv'`, ANTES de iniciar qualquer consulta ao
PostgREST, o handler chama explicitamente
`obterPermissoesEfetivas(req.hubUsuarioId)` e verifica
`.has('faturamento.exportar')` — devolvendo `403 { erro: 'PERMISSAO_NEGADA' }`
se ausente, mesmo que a pessoa tenha `faturamento.listar` (que só autoriza
ver a lista na tela, não extrair um arquivo). Nenhum lote é buscado do
PostgREST antes dessa checagem (evita gastar I/O num pedido que será
recusado).

**Rationale**: o padrão hoje em `GET /importacoes/:id/erros?format=csv`
reusa a MESMA permissão de rota (`importacoes.consultar`) tanto para JSON
quanto para CSV — aceitável lá porque a spec de `hub-importacoes` nunca
exigiu export como permissão independente. Mas a spec desta fase é categórica: User
Story 2 inteira (P2) e FR-008/SC-006 tratam "ver a lista" e "exportar" como
autorizações DIFERENTES, com um Acceptance Scenario dedicado a testar o
bypass direto (cenário 4: "contornando a interface"). Reusar `.listar` para
o CSV violaria isso silenciosamente (alguém com `listar` mas sem `exportar`
conseguiria baixar o arquivo). A checagem explícita e antecipada (antes de
tocar o banco) é o único desenho que satisfaz FR-008 literalmente.

---

## Decision 10 — Rota frontend `/hub/dashboard/faturamento` (não `/faturamento` do rascunho técnico)

**Decision**: segue a mesma convenção já em produção desde a S4
(`/hub/dashboard/importacoes`) e S5 (`/hub/dashboard/motoristas`) — não o
path abreviado `/faturamento` do §13.1 do plano técnico (que é só um
rascunho pré-implementação, já divergente da realidade desde a S4).

**Evidence**: `find app/hub/dashboard -maxdepth 1 -type d` no
`frontend_v2` mostra `importacoes/`, `motoristas/`, `perfil/` sob
`app/hub/dashboard/` — nenhuma rota de módulo funcional fora desse prefixo.

---

## Decision 11 — Navegação para detalhe do entregador: link condicional client-side + backend como autoridade (FR-010, dec-012)

**Decision**: a resposta de `GET /faturamento` já inclui `entregadorId`
(quando presente) mapeado pela mesma camada DTO; o frontend decide mostrar o
link `/hub/dashboard/motoristas/:id` checando se `motoristas.consultar` está
no array `permissoes` já carregado por `GET /me` no shell (mesmo padrão de
`PermissionGate` citado no plano técnico §13.1) — nenhuma chamada de rede
extra por linha da tabela. O backend do módulo de destino
(`GET /motoristas/:id`, já protegido por `requirePermission('motoristas.consultar')`
desde a S5) continua sendo a autoridade final — um link mostrado por engano
(ex.: cache de permissões desatualizado no frontend) resultaria em 403 no
destino, nunca em vazamento de dado.

**Rationale**: reaproveita 100% de infraestrutura já entregue (S3 `GET /me`,
S5 `requirePermission`); nenhuma rota nova, nenhuma decisão de design nova
além de "onde" a checagem client-side acontece.

---

## Constraints herdados (não-decisões — invariantes já estabelecidas)

- Paginação: `PAGE_SIZE_DEFAULT=20`/`PAGE_SIZE_MAX=100`/janela padrão de 30
  dias — reusar as constantes já existentes em
  `lib/hub-importacoes-dto.js`/`lib/hub-motoristas-dto.js` (extrair para
  `lib/hub-pagina cao.js`? **Não** — manter cada DTO com sua própria cópia
  dos 3 literais é o padrão já em uso entre `importacoes`/`motoristas`
  (nenhum dos dois importa do outro); seguir a mesma convenção em
  `hub-faturamento-dto.js` evita introduzir uma dependência cruzada nova
  entre módulos que o plano técnico §8.1 proíbe explicitamente ("módulos
  funcionais não se importam entre si diretamente").
- Auth/RLS: `FaturamentoLancamento` já tem RLS `SELECT`/`INSERT` por escopo
  desde `0015`; esta fase só lê (nenhuma policy nova).
- Auditoria: export bem-sucedido é auditado (`acao:
  'faturamento.csv_exportado'`, best-effort mas aguardado — mesmo padrão de
  `importacao.original_baixado`, linha 587 de `routes/hub-importacoes.js`).
  Consulta de lista/resumo NÃO é auditada (mesmo padrão — nenhum `GET` de
  listagem/detalhe é auditado hoje em `hub-importacoes.js`/`hub-motoristas.js`,
  só mutações e downloads).
