# Phase 0 — Research (hub-performance / S7)

> Sessão de research do `/plan` para o módulo Performance do hub de frota.
> Segue o mesmo método de `docs/specs/hub-faturamento/research.md` (S6) —
> feature-irmã mais próxima (mesmo fato-família, mesmo shell, mesmo gate de
> segurança) — divergindo apenas onde a spec de hub-performance exige
> desenho diferente (ponderação por duração de turno, ausência de bucket
> "agregados/sem entregador", terceira permissão introduzida nesta própria
> fase em vez de follow-up).

## Decision 1 — Duas migrations novas: `0029` (RBAC) e `0030` (RPCs de resumo)

**Decision**: `0029_seed_permissao_performance_listar.sql` insere a
permissão `performance.listar` (módulo `performance` já existe desde
`0007`) e concede aos 4 papéis-seed (`admin_plataforma`, `admin_entidade`,
`operador`, `leitura`) — mesmo padrão *exato* de `0026` (faturamento):
`operador`/`leitura` já têm `performance.consultar` hoje (seed `0007`); sem
`performance.listar` eles veriam o resumo mas não a lista, uma regressão de
capacidade. `performance.exportar` continua fora de `operador`/`leitura`
(mesmo padrão vigente — só os papéis admin exportam).
`0030_hub_performance_rpc_resumo.sql` implementa as 2 funções RPC de
agregação (`hub_performance_totais`, `hub_performance_agrupado`),
`SECURITY INVOKER`, parametrizadas.

**Rationale**: numeração sequencial — `0028` é a última migration existente
(`mv_faturamento_dia`, S6 follow-up). Split em 2 migrations replica
exatamente a divisão de responsabilidade de `0026`/`0027` (RBAC isolado de
lógica de agregação, cada uma idempotente e revertível independentemente).

**Evidence**: `ls infra/hub/migrations/ | sort | tail -1` → `0028_mv_faturamento_dia.sql`;
`0007_seed_papeis_permissoes_modulos.sql` já grants `performance.consultar`
para `operador`/`leitura` mas não `performance.listar` (permissão não
seedada ainda — só `performance.consultar`/`performance.exportar` existem
hoje).

## Decision 2 — Tempo disponível médio: `duracao` (interval já persistido) como peso, não reparse de `periodo` em tempo de consulta

**Decision**: a "duração do turno" da fórmula C (dec-011, resposta do
bloqueio block-001) é lida diretamente da coluna `duracao interval NULL` de
`"PerformanceTurno"` (migration `0014`) — **não** um reparse do texto de
`periodo` (ex. `"ALMOCO 11H30-15H29"`) dentro da RPC/backend. `duracao` já
é o resultado dessa derivação: `hub-import-normalizer.js`
(`normalizarDuracaoHHMMSS(bruto.duracao_do_periodo)`) já converteu o CSV
original (`duracao_do_periodo`, formato `HH:MM:SS`, 10 valores distintos
2h29–3h59) para o `interval` persistido em cada linha, no momento da
importação (S4) — antes de qualquer linha chegar a esta fase.

A fórmula C (Σ(pct×duração)/Σduração) usa `EXTRACT(EPOCH FROM duracao)`
(segundos) como peso. O **fallback** de FR-003 ("quando a duração do turno
não puder ser derivada de forma confiável para um ou mais registros do
conjunto") corresponde, na implementação real, a `duracao IS NULL` para
algum registro elegível (`tempo_disponivel_pct IS NOT NULL`) dentro do
conjunto/grupo filtrado — caso em que TODO o cálculo daquele
conjunto/grupo cai para média aritmética simples dos `tempo_disponivel_pct`
informados (não apenas o registro sem duração é descartado do peso: o
próprio Edge Case da spec descreve a queda como sendo "do cálculo", não
"do registro").

**Rationale**: reparsear `periodo` (texto livre, 16 turnos documentados +
qualquer valor fora do domínio conhecido, Edge Case final da spec) dentro
de SQL ou Node duplicaria uma lógica de parsing que já existe, testada e
validada, em `hub-import-normalizer.js` — e é exatamente essa lógica
(`normalizarDuracaoHHMMSS`) que decide se um `periodo`/`duracao_do_periodo`
é ou não "derivável de forma confiável": quando não é, a linha é rejeitada
na importação (nunca chega a `PerformanceTurno` com `duracao` inconsistente
— o `NULL` só ocorre pela nulidade natural da coluna, defensiva por schema,
nunca por uma falha de parse que passou). Usar a coluna já persistida é
mais simples, mais barato (nenhum parsing em tempo de consulta) e
tecnicamente equivalente ao que a spec pede.

**Evidence**: `infra/hub/migrations/0014_performance_turno.sql`:
`duracao interval NULL` (comentário: "Decimal com PONTO no CSV original...
conversão é responsabilidade do parser, não desta migration"); briefing S7
§Contexto: `duracao_do_periodo (HH:MM:SS, 10 valores, 2h29–3h59)`;
`hub-import-normalizer.js:364-366`: `normalizarDuracaoHHMMSS(bruto.duracao_do_periodo)`
+ rejeição de linha (`erros.push`) quando `!duracaoInfo.valido`.

## Decision 3 — Ponderação condicional via `FILTER` clause dentro de `GROUP BY`, sem subquery aninhada por grupo

**Decision**: tanto `hub_performance_totais` (sem agrupamento — 1 linha)
quanto `hub_performance_agrupado` (`GROUP BY chave_calc`) calculam a
condição de fallback (Decision 2) **por grupo** usando agregados com
cláusula `FILTER (WHERE tempo_disponivel_pct IS NOT NULL)`:

```sql
CASE
  WHEN COUNT(*) FILTER (WHERE tempo_disponivel_pct IS NOT NULL) = 0
    THEN NULL  -- nenhum registro elegível -> indicador indisponível
  WHEN bool_or(duracao IS NULL) FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
    THEN (AVG(tempo_disponivel_pct) FILTER (WHERE tempo_disponivel_pct IS NOT NULL))::numeric(6,2)::text
  ELSE (
    SUM(tempo_disponivel_pct * EXTRACT(EPOCH FROM duracao))
      FILTER (WHERE tempo_disponivel_pct IS NOT NULL)
    / NULLIF(SUM(EXTRACT(EPOCH FROM duracao)) FILTER (WHERE tempo_disponivel_pct IS NOT NULL), 0)
  )::numeric(6,2)::text
END
```

`bool_or(...) FILTER (...)` é um agregado Postgres válido (qualquer função
de agregação aceita `FILTER`) — retorna `true` se **qualquer** linha
elegível do grupo tem `duracao IS NULL`, disparando o fallback só para
aquele grupo, nunca globalmente. `NULLIF(..., 0)` protege contra divisão
por zero residual (defesa em profundidade — `bool_or` já garante que só
entramos no ramo ponderado quando toda `duracao` elegível é não-nula, logo
a soma só seria zero se toda `duracao` fosse `'0 seconds'::interval`,
tecnicamente possível mas sem sentido de negócio; o `NULLIF` cobre esse
canto sem custo).

**Rationale**: evita subquery correlacionada por grupo (mais cara e mais
difícil de auditar) e evita mover a agregação para o backend Node — que
exigiria carregar todas as linhas do período em memória, o oposto do que
FR-003/FR-004 pedem (cálculo "no sistema", nunca no cliente, e a spec do
plano técnico já rejeitou pré-cálculo antecipado). O mesmo padrão de
`SECURITY INVOKER` + parâmetros tipados de `hub_faturamento_totais`/
`hub_faturamento_agrupado` (0027) é reaproveitado — RLS de
`"PerformanceTurno"` (`0015`) se aplica normalmente dentro da função,
nenhum bypass de isolamento multi-tenant.

## Decision 4 — Sem bucket "agregados/sem entregador" — `entregador_id NOT NULL` desde a origem

**Decision**: ao contrário de `hub_faturamento_agrupado` (que trata
`entregador_id IS NULL` como bucket `agregados_bonus`), `hub_performance_agrupado`
com `p_group_by = 'entregador'` nunca produz uma chave de "sem entregador":
`"PerformanceTurno".entregador_id` é `NOT NULL` desde a migration `0014`
(o CSV de origem exige UUID de entregador em toda linha — diferente do
faturamento, onde 4,5% das linhas de bônus não têm UUID). Nenhuma lógica de
bucket especial é necessária; `chave_calc = entregador_id::text` sempre
resolve a um entregador real.

**Rationale**: reflete literalmente a intro da spec ("Diferente do
faturamento (S6), aqui todo registro pertence a uma pessoa entregadora
específica... não existe... um conceito de registro agregado/sem
entregador"). Simplifica o mapper Node (`mapResumoAgrupado` equivalente não
precisa de `CHAVE_AGREGADOS_BONUS`/`ROTULO_AGREGADOS_BONUS`).

**Evidence**: `0014_performance_turno.sql`: `entregador_id int NOT NULL
REFERENCES "Entregador"(id)` (comentário: "UUID é OBRIGATÓRIO neste CSV, ao
contrário do faturamento onde ausência de UUID vira `recebedor_agregado`").

## Decision 5 — Export CSV via paginação interna em lotes (streaming sem buffer total)

**Decision**: reaproveita 100% o mecanismo de `exportarCsv` de
`routes/hub-faturamento.js` (Decision 5 de `hub-faturamento/research.md`):
laço de paginação `Range` do PostgREST em lotes de 1.000 linhas,
`res.write()` incremental, corpo completo do CSV nunca existe de uma vez no
processo. Filtro vazio → arquivo só com cabeçalho, `200` (Edge Case da
spec, nunca erro).

**Rationale**: FR-006/SC-005 de hub-performance são literalmente idênticos
aos de hub-faturamento (mesma garantia de streaming, mesma neutralização
CSV injection). Nenhuma decisão nova — reuso direto.

## Decision 6 — Proteção CSV injection: reusar `lib/hub-csv.js` (não duplicar)

**Decision**: `routes/hub-performance.js` importa
`escaparCelulaCsvInjection`/`quotarCelulaCsv` de `lib/hub-csv.js`
(já extraído na S6, Decision 6 de `hub-faturamento`) — nenhuma cópia nova
do mecanismo.

**Rationale**: `lib/hub-csv.js` já é o módulo compartilhado (usado por
`hub-importacoes-dto.js` e `hub-faturamento-dto.js`); adicionar um terceiro
consumidor é o objetivo declarado da extração original (FR-016/CHK017 de
hub-faturamento). Nenhuma duplicação de lógica de segurança entre módulos.

## Decision 7 — Valores monetários e taxas percentuais trafegam como `text`

**Decision**: `taxasReais` (conversão de `taxas_centavos` para R$) segue o
mesmo padrão de Decision 7 de `hub-faturamento` (`::numeric(12,2)::text`
dentro da função SQL, nunca `number` JSON de ponto flutuante). Estende-se a
mesma regra às 3 taxas percentuais novas desta fase (`taxaAceitacao`,
`taxaConclusao`, `tempoDisponivelMedio`): `::numeric(6,4)::text` para as
razões (0–1, podendo passar de 1 no caso do Edge Case de dado
inconsistente, ex. aceitas+rejeitadas > ofertadas) e `::numeric(6,2)::text`
para o tempo disponível médio (percentual, mesma casa decimal de
`tempo_disponivel_pct` na tabela-base). `NULL` SQL vira `null` JSON
diretamente (estado "indicador indisponível" de FR-003/SC-009) — nunca uma
string `"NaN"`/`"Infinity"` nem um placeholder textual.

**Rationale**: consistência com o precedente já estabelecido; evita
qualquer divergência de arredondamento entre o cálculo em Postgres e a
serialização em Node (`JSON.stringify` de `number` pode alterar a
representação de casas decimais). O frontend formata o texto para exibição
(percentual/moeda) sem re-calcular.

## Decision 8 — Medição de SC-004 fica para a fase de implementação (execute-task)

**Decision**: assim como Decision 8 de `hub-faturamento` (S6), a medição
real de SC-004 (resumo agregado sob volume equivalente a 1 ano de operação,
< 1s) **não é antecipada** nesta fase de `/plan` — é executada e registrada
como evidência durante `execute-task`, com um seed sintético dedicado
(reaproveitando `infra/hub/scripts/gen-seeds.py --perf ... --synthesize-days N`,
já preparado para volume sintético "S10-safe", ou `generate_series` direto
no `hub_homolog_db` restrito a `id_empresa` de teste — mesma técnica usada
na medição original de `hub-faturamento`, onda-008/dec-035). O plano
técnico §12.6 já pré-aprova a mesma mitigação condicional
(view materializada `mv_performance_dia`, espelhando `mv_faturamento_dia`
de `0028`) **caso** a medição real viole o limite — decisão e evidência
ficam registradas como parte desta fase (FR-003 nota de infraestrutura),
nunca implementadas preventivamente.

**Rationale**: literal do FR-003 ("nota de infraestrutura") e do Edge Case
correspondente da spec: "se a medição mostrar degradação relevante... a
decisão fica registrada... não implementada por antecipação". O precedente
real de `hub-faturamento` (dec-035: SC-004 violado sob ~900k linhas/1 ano,
resolvido depois com `mv_faturamento_dia`, `0028`) mostra que essa
mitigação condicional é um padrão já validado neste projeto — não uma
suposição teórica.

**Evidence**: `docs/specs/hub-faturamento/review-onda-009.md` §"ACHADO
FORMAL — Cenário 15/SC-004" + §"ADENDO... SC-004 SANADO"; plano técnico
§12.6 ("se o dashboard pesar (>1s), criar view materializada diária").

## Decision 9 — Permissão de export verificada de forma independente e explícita (FR-008)

**Decision**: idêntico à Decision 9 de `hub-faturamento` — `GET /performance`
usa `requirePermission('performance.listar')` no nível de rota; quando
`req.query.format === 'csv'`, o handler chama
`obterPermissoesEfetivas(req.hubUsuarioId)` e verifica
`.has('performance.exportar')` explicitamente ANTES de qualquer consulta ao
PostgREST, devolvendo `403 { erro: 'PERMISSAO_NEGADA' }` se ausente.

**Rationale**: FR-008/SC-006 de hub-performance são categóricos sobre as 3
permissões serem independentes, com Acceptance Scenario dedicado ao bypass
direto (User Story 3, cenário 4) — o mesmo motivo que levou à Decision 9
original.

## Decision 10 — Rota frontend `/hub/dashboard/performance`

**Decision**: segue a convenção já em produção desde a S4
(`/hub/dashboard/importacoes`), S5 (`/hub/dashboard/motoristas`) e S6
(`/hub/dashboard/faturamento`) — não o path abreviado `/performance` do
§13.1 do plano técnico (rascunho pré-implementação, já divergente da
realidade desde a S4, mesma constatação de Decision 10 de
`hub-faturamento`).

**Evidence**: `find app/hub/dashboard -maxdepth 1 -type d` mostra
`importacoes/`, `motoristas/`, `faturamento/`, `perfil/` sob
`app/hub/dashboard/` — nenhuma rota de módulo funcional fora desse prefixo.

## Decision 11 — Sem navegação para detalhe do entregador nesta fase

**Decision**: ao contrário de `hub-faturamento` (Decision 11, FR-010: link
condicional para `/hub/dashboard/motoristas/:id`), a spec de
`hub-performance` **não** tem um FR/User Story equivalente pedindo
navegação para o detalhe do entregador a partir da lista/agregado de
performance. Esta fase não introduz esse link — o nome do entregador na
lista/agregado por entregador é texto simples (mesmo padrão de exibição de
nome mascarado por LGPD já usado em `Entregador`/`Motorista`), sem
`<Link>`.

**Rationale**: nenhum requisito da spec pede essa capacidade; adicioná-la
seria escopo não solicitado (a spec é explícita sobre o que "Não inclui").
Se o operador quiser essa navegação depois, é uma mudança de escopo
pequena e isolada (mesmo padrão de Decision 11 já validado), não uma
decisão bloqueante agora.

## Decision 12 — `groupBy` aceita `dia` | `periodo` | `entregador` (não `turno`)

**Decision**: o parâmetro de agrupamento de `GET /performance/resumo` usa
o literal `periodo` (não `turno`) como um dos 3 valores do enum, espelhando
o nome real da coluna (`"PerformanceTurno".periodo`) e evitando um segundo
vocabulário para o mesmo conceito (a spec usa "turno (período)" de forma
intercambiável, mas o código-fonte, os índices e o CSV original usam
sempre `periodo`).

**Rationale**: consistência de nomenclatura ponta-a-ponta (banco → RPC →
DTO → contrato) evita um mapeamento adicional só para tradução de
vocabulário; `groupByValido` (equivalente a `groupByValido` de
`hub-faturamento-dto.js`) valida o enum `['dia', 'periodo', 'entregador']`.

## Constraints herdados (não-decisões — invariantes já estabelecidas)

- Paginação: `PAGE_SIZE_DEFAULT=20`/`PAGE_SIZE_MAX=100`/janela padrão de 30
  dias — cópia própria em `lib/hub-performance-dto.js` (mesmo padrão de
  `importacoes`/`motoristas`/`faturamento`, sem import cross-domain — o
  plano técnico §8.1 proíbe módulos funcionais se importarem entre si).
- Auth/RLS: `"PerformanceTurno"` já tem RLS `SELECT`/`INSERT` por escopo
  desde `0015`; esta fase só lê (nenhuma policy nova).
- Índice de subpraça: `idx_performance_empresa_subpraca` já existe desde
  `0020` — nenhuma estrutura nova de índice é introduzida (FR-002 proíbe
  explicitamente).
- Auditoria: export bem-sucedido é auditado (`acao:
  'performance.csv_exportado'`, best-effort mas aguardado — mesmo padrão de
  `faturamento.csv_exportado`/`importacao.original_baixado`). Consulta de
  lista/resumo NÃO é auditada (mesmo padrão dos demais módulos — só
  mutações e downloads são auditados hoje).
- `taxas_centavos` é `int` em centavos — conversão para R$ acontece
  exatamente uma vez, na consulta/apresentação (FR-005), nunca re-persistida.
