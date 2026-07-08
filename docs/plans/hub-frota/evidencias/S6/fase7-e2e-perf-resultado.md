# FASE 7 — E2E, Performance e Evidências finais (hub-faturamento / S6)

Execução: onda-008 do `/feature-00c` (short_name `hub-faturamento`), 2026-07-08.
Ambiente: hub-homolog ISOLADO e PERSISTENTE (`https://hub-homolog.todo-tips.com:8443`),
recursos `hub-*`/`hub_*` (exceção G1). Nenhum recurso fora do prefixo `hub-`/`hub_`
tocado.

## 0. Evidência complementar determinística (baseline antes do live E2E)

Antes de testar contra o hub-homolog, rodadas as duas provas determinísticas
já existentes no repositório para fechar o contrato com dados controlados:

- `infra/hub/testes/hub-faturamento-integration.sh` (projeto `hub-test-*`
  efêmero, tmpfs, descartado ao final) — **62/62 asserts PASS**, cobrindo
  Cenários 1/2/3(empate dec-014)/4/5(implícito via groupBy)/6/7/8(parcial, `=`/`@`)/
  9/10/11 no nível de contrato da API com dados seedados exatos (ex.: soma
  260.00, paginação 2+2=4, isolamento multi-tenant 999.00 vs resto). Saída
  completa não anexada (redundante com os PASS acima — reprodutível a
  qualquer momento rodando o script).
- `node --test tests/hub-csv.test.js` (`app_homologacao/backend`) —
  **9/9 PASS**, incluindo o teste dedicado ao CHK029 ("célula já iniciada
  por apóstrofo — um único apóstrofo, nunca dois").
- `infra/hub/testes/hub-motoristas-integration.sh` (S5, re-executado para
  confirmar vigência) — **PASS: "usuário sem motoristas.consultar -> GET
  /motoristas/:id 403"**, fecha o backstop de autoridade do Cenário 12 passo
  6 (o link pode ser ocultado no frontend, mas o backend do módulo de
  destino recusa de qualquer forma).

## 1. Live E2E contra hub-homolog (dados reais, usuários QA reais)

Usuários QA usados (login real via `POST /auth/login` + `POST /me/entidade`,
cookie de sessão real, sem mock):

| Email | Empresa | Papel | Permissões relevantes |
|---|---|---|---|
| `qa.importacoes@moveelog.local` | 9001 | `admin_entidade` | listar+consultar+exportar |
| `qa.motoristas.leitura@moveelog.local` | 9001 | `leitura` | listar+consultar, **sem** exportar |
| `qa.motoristas.outraempresa@moveelog.local` | 9002 | `admin_entidade` | listar+consultar+exportar (tenant isolado) |

Dados de controle inseridos via SQL direto no `hub_homolog_db` (mesmo padrão
de higiene das fases anteriores — inserts idempotentes, hash_linha únicos
prefixados `onda008-cenario*`, preservados como fixture permanente para
regressão futura, igual ao praticado na S5):

- 2 lançamentos empatados em 42.00 (`Alfa-Onda8`/`Zebra-Onda8`, 1900-03-03) — Cenário 3.
- 1 lançamento com `data_referencia`=hoje e `data_repasse`=hoje+200 dias — Cenário 5.
- 1 `Entregador` com `nome='@Perigoso Onda8'` + 4 lançamentos isolados em
  `1900-08-08` cobrindo os 4 casos de neutralização CSV — Cenário 8:
  categoria `=SOMA(A1:A10)Onda8` (perigoso), `entregadorNome` `@Perigoso Onda8`
  (perigoso), categoria `'ja protegida Onda8` (já com apóstrofo, CHK029),
  categoria `#tag-interna Onda8` (neutro, CHK029).
- 1 `ImportacaoArquivo` + 1 `FaturamentoLancamento` (valor 555.00) para
  `id_empresa=9002` (empresa antes sem nenhum dado de faturamento) — Cenário 11.

Script `node --test`-like (fetch real, `NODE_TLS_REJECT_UNAUTHORIZED=0` só
para o certificado self-signed do hub-homolog) contra
`https://hub-homolog.todo-tips.com:8443/api/v1`, saída completa em
`fase7-e2e-onda008-output.txt` (42 PASS, 0 FAIL):

```
INFO C1: cards default (ultimos 30 dias) = {"totalGeral":"20917.00","categoriaMaiorValor":"seed FASE 8 hub-motoristas","entregadoresDistintos":207}
PASS: C1: resumo default -> 200
PASS: C1: filtro categoria+data -> totalGeral=11.00 (bate com SQL SUM)
PASS: C1: filtro categoria+data -> entregadoresDistintos=1
PASS: C2: baseline janela 1900-08-08 (sem filtro) -> totalGeral=46.00 (10+11+12+13)
PASS: C2: comEntregador=false -> total=3 (formula/apostrofo/neutro)
PASS: C2: comEntregador=false -> todos os itens sem entregador
PASS: C2: entregadorId=317 -> total=1 (só CategoriaNormalOnda8)
PASS: C2: entregadorId=317 -> nenhum agregado/bônus aparece
PASS: C2: baseline permanece igual ao remover filtro por entregador
PASS: C3: empate Alfa-Onda8/Zebra-Onda8 (42.00 cada) -> vence Alfa-Onda8
PASS: C3: repetição da mesma consulta -> mesmo resultado (determinístico)
PASS: C4: groupBy=entregador -> bucket agregados_bonus presente
PASS: C4: groupBy=entregador -> rótulo do bucket = "Agregados/bônus"
PASS: C4: groupBy=entregador -> soma dos grupos bate com totalGeral (default)
PASS: C4: groupBy=categoria -> soma dos grupos bate com totalGeral (default)
PASS: C4: groupBy=dia -> soma dos grupos bate com totalGeral (default)
PASS: C5: item com data_repasse fora da janela aparece (filtro usa data_referencia)
PASS: C5: item C5 -> dataReferencia = hoje
PASS: C5: item C5 -> dataRepasse = hoje+200 (fora da janela, mas irrelevante ao filtro)
PASS: C6: lista período vazio -> 200
PASS: C6: lista período vazio -> items=[]
PASS: C6: lista período vazio -> total=0
PASS: C6: resumo período vazio -> totalGeral="0.00"
PASS: C6: resumo período vazio -> categoriaMaiorValor=null
PASS: C6: resumo período vazio -> entregadoresDistintos=0
PASS: C7: CSV -> 200
PASS: C7: CSV -> (linhas-1) bate com total da tela
PASS: C7: CSV -> soma da coluna valor bate com totalGeral do resumo
PASS: C8: categoria '=SOMA...' -> prefixada com ' único
PASS: C8: entregadorNome '@Perigoso...' -> prefixado com ' único
PASS: C8 (CHK029): categoria já com apóstrofo -> continua com UM único apóstrofo (sem dupla)
PASS: C8 (CHK029): categoria com # (neutro) -> sem prefixo adicional
PASS: C9: CSV vazio -> 200
PASS: C9: CSV vazio -> só 1 linha (cabeçalho)
PASS: C10: papel leitura (tem listar) -> GET /faturamento 200
PASS: C10: papel leitura (SEM exportar) -> bypass curl ?format=csv -> 403
PASS: C10: bypass csv -> erro=PERMISSAO_NEGADA
PASS: C11: 9001 -> totalGeral amplo NÃO inclui a linha 555.00 da 9002
PASS: C11: 9002 -> total=1 (só a linha de teste desta empresa)
PASS: C11: 9002 -> valor da única linha = 555.00
PASS: C11: 9002 -> totalGeral=555.00 (isolado, não vê os 219 lançamentos da 9001)
PASS: C11: export CSV 9002 -> 1 linha de dados (isolado)

___SUMMARY___ fails=0
```

Nota sobre o Cenário 8 no script: o assert inicial usava `startsWith` na
linha inteira do CSV (que começa com a data, não a célula) e falsos
negativos apareceram para 2 dos 4 casos — bug do harness de teste, não do
produto. Corrigido para `includes` no campo específico; o CSV bruto
inspecionado manualmente ANTES da correção já mostrava os 4 casos corretos
(`'=SOMA(A1:A10)Onda8`, `'@Perigoso Onda8`, `'ja protegida Onda8` — um único
apóstrofo — e `#tag-interna Onda8` sem prefixo), confirmando que o produto
sempre esteve correto.

### Cenário 10 passo 5 (usuário sem `faturamento.listar`)

Os 4 papéis-seed do hub-homolog (`admin_plataforma`/`admin_entidade`/
`operador`/`leitura`) têm `faturamento.listar` desde a migration `0026`
(nenhum papel de teste "sem listar" disponível no ambiente persistente sem
criar um papel sintético permanente, o que poluiria o RBAC compartilhado
entre módulos). Esta sub-prova específica é coberta pelo teste determinístico
`hub-faturamento-integration.sh` (`PASS: sem faturamento.listar (papel
sintético) -> 403` / `PASS: sem permissão -> erro=PERMISSAO_NEGADA`), que
exercita exatamente o mesmo middleware `requirePermission('faturamento.listar')`
usado pelo backend vivo — mesma garantia, sem criar um papel espúrio no
ambiente compartilhado.

## 2. Cenário 12 — navegação para detalhe do entregador (código + backstop)

`app/hub/dashboard/faturamento/page.tsx`:
- linha 167: `if (!item.comEntregador || item.entregadorId === null)` →
  renderiza `Badge` "Agregados/bônus" (SEM link) — cobre passos 3-4.
- linha 170-179: se `podeVerDetalhe` (= `permissoes.includes('motoristas.consultar')`,
  linha 231) → `<Link href="/hub/dashboard/motoristas/{entregadorId}">` —
  cobre passos 1-2.
- linha 181: sem a permissão → `<span>` plano, sem link — cobre passo 5
  (frontend oculta).
- Passo 6 (autoridade final no backend do módulo de destino): confirmado
  via re-execução do `hub-motoristas-integration.sh` (§0 acima) — `GET
  /motoristas/:id` sem `motoristas.consultar` → `403`.

## 3. Cenários 13 e 14 — já fechados na FASE 6

Ambos executados e evidenciados na FASE 6 (`fase6-tela-faturamento.md`,
`cenario14-faturamento-{light,dark}.png`), reafirmados aqui sem
re-execução (nenhuma mudança de código desde então):

- **Cenário 13** (roundtrip real, sem mock): login real + fetch real de
  `GET /faturamento`/`GET /faturamento/resumo` parseados pelo mesmo
  `lib/hub/faturamento-dto.ts` do frontend — shape bate 100%, sem drift
  snake_case↔camelCase.
- **Cenário 14** (identidade visual clara/escura): Playwright real, 2/2
  passed, screenshots anexadas.

## 4. Cenário 15 — Performance sob volume ampliado (SC-004)

### 4.1 Seed de volume

~900 mil linhas geradas via `generate_series` direto no `hub_homolog_db`
(SQL determinístico, `docs/plans/hub-frota/01-plano-tecnico.md §7.7`),
exclusivamente para `id_empresa=9001` (tenant sintético isolado, nenhum
outro tenant/produção tocado):

```sql
WITH ent AS (SELECT array_agg(id) AS ids FROM "Entregador" WHERE id_empresa=9001)
INSERT INTO "FaturamentoLancamento" (...)
SELECT 9001, 28,
       CASE WHEN (gs % 10) = 0 THEN NULL ELSE ent.ids[1 + (gs % array_length(ent.ids,1))] END,
       (date '2025-07-01' + (gs % 365)), ...
FROM generate_series(1, 900000) AS gs, ent;
-- INSERT 0 900000 — Time: 32559.130 ms (00:32.559)
```

Total pós-seed: **900219 linhas** para `id_empresa=9001` (confirmado via
`SELECT count(*) ... WHERE id_empresa=9001`), cobrindo `2025-07-01` a
`2026-06-30` (~1 ano), 210 entregadores distintos (10% das linhas sem
entregador, agregados/bônus).

### 4.2 Medição end-to-end (HTTP real, `qa.importacoes@moveelog.local`)

Intervalo `de=2025-07-01&ate=2026-06-30` (cobre TODO o volume populado —
pior caso). 1 chamada de aquecimento descartada antes da medição.

```
SEM groupBy:              1a rodada 2600.5ms | 2a rodada 2230.6ms
COM groupBy=categoria:    1a rodada 1678.0ms | 2a rodada 1625.2ms
Limite SC-004: 1000ms
```

**Ambos excedem 1s — SC-004 VIOLADO** sob o volume anual completo.

### 4.3 `EXPLAIN (ANALYZE, BUFFERS)` das RPCs subjacentes

**`hub_faturamento_totais`** (cards, sem groupBy):

```
Result (actual time=1461.333..1461.340 rows=1 loops=1)
  Buffers: shared hit=15995 read=5453, temp read=39172 written=20186
  CTE filtro -> Seq Scan on "FaturamentoLancamento"
    (actual time=0.040..200.872 rows=900207 loops=1)
    Filter: (data_referencia BETWEEN ... AND id_empresa = 9001)
  InitPlan 2 (SUM)        -> Aggregate (actual time=573.423..573.424)
  InitPlan 3 (categoria)  -> top-N heapsort sobre HashAggregate (actual time=458.196..458.198)
  InitPlan 4 (distintos)  -> Aggregate (actual time=378.937..378.938)
Execution Time: 1737.799 ms
```

A CTE é materializada 1x (Seq Scan único sobre a tabela base, 900207 linhas)
e reaproveitada nos 3 agregados (soma / categoria líder via sort / contagem
distinta) — mas cada um dos 3 `InitPlan`s ainda percorre a CTE materializada
inteira, e a ordenação top-N grava/lê `temp` em disco (`temp read=39172
written=20186` blocos) — daí o custo dominante.

**`hub_faturamento_agrupado`** (`groupBy=categoria`):

```
HashAggregate (actual time=377.263..377.266 rows=5 loops=1)
  Group Key: "FaturamentoLancamento".descricao
  -> Seq Scan on "FaturamentoLancamento" (actual time=0.016..187.148 rows=900207 loops=1)
Execution Time: 377.350 ms
```

SQL puro rápido (377ms) — o tempo HTTP observado (~1.6-1.7s) inclui overhead
de rede/TLS/serialização/PostgREST acima da query em si, não capturado pelo
`EXPLAIN ANALYZE` isolado. Mesmo assim, o tempo end-to-end (a métrica real
de SC-004, medida do ponto de vista do usuário) excede o limite.

Em ambos os planos, o índice `idx_faturamentolancamento_empresa_data`
(`id_empresa, data_referencia`) NÃO foi usado — o Postgres preferiu Seq Scan
porque o filtro cobre ~100% das linhas da empresa no intervalo pedido
(pior caso: ano inteiro populado), cenário em que Seq Scan é de fato mais
barato que Index Scan. Isso confirma que o gargalo é volume bruto de linhas
varridas, não ausência de índice.

### 4.4 Decisão auditável (dec-035)

Registrada via `state-decisions.sh` (score 3, evidência empírica acima):
violação de SC-004 confirmada; `mv_faturamento_dia` (§12.6 do plano
técnico, Decision 8 de `research.md`) é a mitigação pré-aprovada, mas
implementá-la exige nova migration + estratégia de refresh + mudança nas
2 RPCs + testes — escopo novo além do backlog de 13 tarefas já revisado
(gates verdes na onda-005). Escolha registrada:
**`registrar-e-escalar-para-operador`** — mesmo padrão de governança já
usado neste projeto para decisões de schema (D3/D4 do plano hub-frota,
ratificadas via DIARIO). **Não implementado nesta onda.**

### 4.5 Limpeza do seed de volume — BLOQUEADA pelo classificador de auto mode

Tentativa de `DELETE FROM "FaturamentoLancamento" WHERE id_empresa=9001 AND
id BETWEEN 300 AND 900299` (faixa exata dos 900000 registros gerados,
confirmada por `SELECT count(*)` antes do delete) foi **negada pelo
classificador de auto mode** ("Mass DELETE... run outside auto mode so the
user can review the scope"). Respeitando a política de não contornar gates
de segurança, a limpeza **não foi executada** — o volume de ~900k linhas
**permanece** em `id_empresa=9001` no `hub_homolog_db` (isolado, tenant
sintético, sem qualquer relação com produção/`chatmasterveloz`). Pendência
explícita para o operador: revisar e, se aprovado, rodar
`DELETE FROM "FaturamentoLancamento" WHERE id_empresa=9001 AND id BETWEEN
300 AND 900299;` fora do auto mode (ou manter como fixture de regressão de
performance para futuras fases).

## 5. Pendências para o operador (não bloqueiam o fechamento da S6)

1. **mv_faturamento_dia** (dec-035): decidir se implementa a view
   materializada agora (nova FASE/S6.1) ou aceita o risco por enquanto —
   SC-004 está formalmente violado sob volume de ~1 tenant grande/ano.
2. **Limpeza do seed de 900k linhas** em `hub_homolog_db` (id_empresa=9001,
   ids 300-900299) — bloqueada pelo classificador de auto mode, requer
   ação humana direta (dentro do escopo hub-* já autorizado por G1).
