# Follow-up S6 — SC-004 sanado com `mv_faturamento_dia` (migration 0028)

Data: 2026-07-08 · Branch `feat/hub-faturamento` (PR draft #59) · Autorizado
pelo operador como follow-up da ressalva formal do review da onda-009
(dec-035 — mitigação pré-aprovada no plano técnico §12.6, condicionada a
evidência, que a onda-008 produziu).

Ambiente: hub-homolog ISOLADO (`https://hub-homolog.todo-tips.com:8443`),
`hub_homolog_db` com o MESMO seed de volume da medição original
(**900.220 linhas** em `FaturamentoLancamento`, ~900k para `id_empresa=9001`,
`2025-07-01..2026-06-30` — o seed NÃO foi apagado, DELETE fica com o
operador). Produção (`envio-massa-homologacao_*`/`chatmasterveloz`) nunca
tocada — smoke `https://app.moveelog.com.br/login` = **200 antes e depois**.

## 1. O que foi implementado

| Artefato | Conteúdo |
|---|---|
| `infra/hub/migrations/0028_mv_faturamento_dia.sql` | MV `mv_faturamento_dia` (grão `id_empresa`+`data_referencia`+`descricao`+`entregador_id`; **27.960 linhas** vs 900.220 do fato ≈ **32x menor**; 4,5 MB vs 320 MB) + índice ÚNICO (pré-requisito do `REFRESH CONCURRENTLY`; `entregador_key = COALESCE(entregador_id,0)` porque o índice único não pode ter expressão nem NULLs ambíguos) + 2 índices de filtro + **REVOKE de SELECT direto** p/ `authenticated`/`hub_web_anon` + reescrita das RPCs `hub_faturamento_totais`/`hub_faturamento_agrupado` (SECURITY DEFINER + guard explícito `p_id_empresa = ANY (hub_jwt_escopo_ids())`) + `hub_faturamento_refresh_mv()` (CONCURRENTLY via dblink) |
| `backend/lib/hub-import-processor.js` | chama `rpc/hub_faturamento_refresh_mv` (best-effort) ao final de importação de **faturamento** bem-sucedida (`completed`/`completed_with_errors`) — único caminho de escrita nos fatos |
| Contrato | **inalterado** (mesmos shapes; valores como `text`); nota de frescor adicionada em `contracts/faturamento-api.md` |

Decisões de desenho (documentadas na própria migration):

- **Grão com `entregador_id`** (mais fino que o "flag com/sem entregador" do
  §12.6): cobre também `groupBy=entregador`, o filtro `entregadorId` e o
  card `entregadores_distintos` (COUNT DISTINCT não decompõe a partir de um
  booleano). Custo medido: 27.960 linhas — irrisório.
- **Fallback tabela-base**: só quando `p_subpraca` é informado (única
  dimensão fora do grão; filtro raro, fora do caminho medido pelo SC-004).
  O guard de escopo vale nos DOIS caminhos.
- **Isolamento multi-tenant sem RLS na MV** (Postgres não aplica RLS a MVs):
  REVOKE de SELECT direto + acesso exclusivo via RPC SECURITY DEFINER com o
  MESMO predicado da policy de 0015 — provado por teste negativo (abaixo).
- **Refresh CONCURRENTLY via dblink**: `REFRESH ... CONCURRENTLY` não roda
  em bloco de transação e o PostgREST envolve toda RPC numa transação; o
  dblink (socket local, `trust` da imagem postgres) executa numa sessão
  própria. Fallback: REFRESH bloqueante. **Staleness aceito**: MV atualiza
  ao final de cada importação de faturamento (1 arquivo/dia/tipo); casos
  residuais entram no próximo refresh/RPC manual; `GET /faturamento`
  (lista) segue sempre fresco (lê a tabela-base).

## 2. Re-medição SC-004 — HTTP end-to-end (mesma metodologia da onda-008)

`qa.importacoes@moveelog.local`, entidade 9001,
`de=2025-07-01&ate=2026-06-30` (TODO o volume, pior caso), 1 aquecimento
descartado, 2 rodadas medidas. Output literal do runner:

```
sem groupBy: 1a 33.6ms | 2a 40.4ms  -> {"totalGeral":"98570700.00","categoriaMaiorValor":"Percentual atingido","entregadoresDistintos":210}
groupBy=categoria: 1a 19.5ms | 2a 20.5ms  -> 5 grupos
groupBy=dia: 1a 30.6ms | 2a 35.4ms  -> 365 grupos
groupBy=entregador: 1a 39.9ms | 2a 64.9ms  -> 211 grupos
```

| Medição (HTTP end-to-end) | onda-008 (antes) | follow-up (depois) | Limite SC-004 |
|---|---|---|---|
| `/resumo` sem `groupBy` | 2600.5ms / 2230.6ms | **33.6ms / 40.4ms** | 1000ms |
| `/resumo?groupBy=categoria` | 1678.0ms / 1625.2ms | **19.5ms / 20.5ms** | 1000ms |
| `/resumo?groupBy=dia` | (não medido) | **30.6ms / 35.4ms** | 1000ms |
| `/resumo?groupBy=entregador` | (não medido) | **39.9ms / 64.9ms** | 1000ms |

**SC-004 PASSA com folga de ~25-50x em todos os agrupamentos** (~65x mais
rápido que a medição original no pior caso). Os valores retornados batem com
a medição original e com o SUM direto na tabela-base
(`98570700.00` / `210` entregadores distintos — paridade exata).

## 3. `EXPLAIN (ANALYZE, BUFFERS)` — caminho MV (corpo literal das RPCs 0028)

**`hub_faturamento_totais`** (antes: 1737.799 ms, Seq Scan 900207 linhas,
`temp read=39172 written=20186`):

```
 Result  (cost=2713.55..2713.57 rows=1 width=68) (actual time=28.111..28.114 rows=1 loops=1)
   Buffers: shared hit=295
   CTE filtro
     ->  Seq Scan on mv_faturamento_dia mv  (cost=0.00..771.30 rows=27696 width=24) (actual time=0.008..4.498 rows=27947 loops=1)
           Filter: ((data_referencia >= '2025-07-01'::date) AND (data_referencia <= '2026-06-30'::date) AND (id_empresa = 9001))
           Rows Removed by Filter: 13
           Buffers: shared hit=282
   InitPlan 2 (returns $1)
     ->  Aggregate  (cost=623.16..623.17 rows=1 width=32) (actual time=13.850..13.850 rows=1 loops=1)
           Buffers: shared hit=282
           ->  CTE Scan on filtro  (cost=0.00..553.92 rows=27696 width=18) (actual time=0.010..10.879 rows=27947 loops=1)
                 Buffers: shared hit=282
   InitPlan 3 (returns $2)
     ->  Limit  (cost=695.90..695.90 rows=1 width=64) (actual time=8.578..8.579 rows=1 loops=1)
           Buffers: shared hit=6
           ->  Sort  (cost=695.90..696.40 rows=200 width=64) (actual time=8.577..8.577 rows=1 loops=1)
                 Sort Key: (sum(filtro_1.f_total)) DESC, filtro_1.f_descricao
                 Sort Method: top-N heapsort  Memory: 25kB
                 Buffers: shared hit=6
                 ->  HashAggregate  (cost=692.40..694.90 rows=200 width=64) (actual time=8.542..8.545 rows=5 loops=1)
                       Group Key: filtro_1.f_descricao
                       Batches: 1  Memory Usage: 40kB
                       ->  CTE Scan on filtro filtro_1  (cost=0.00..553.92 rows=27696 width=50) (actual time=0.000..1.969 rows=27947 loops=1)
   InitPlan 4 (returns $3)
     ->  Aggregate  (cost=623.16..623.17 rows=1 width=8) (actual time=5.675..5.675 rows=1 loops=1)
           Buffers: shared hit=7
           ->  CTE Scan on filtro filtro_2  (cost=0.00..553.92 rows=27696 width=4) (actual time=0.000..1.648 rows=27947 loops=1)
 Planning:
   Buffers: shared hit=160
 Planning Time: 0.556 ms
 Execution Time: 28.530 ms
```

**`hub_faturamento_agrupado`** (`groupBy=dia`, o de maior cardinalidade —
365 grupos):

```
 HashAggregate  (cost=1255.58..1266.67 rows=370 width=68) (actual time=13.936..14.073 rows=365 loops=1)
   Group Key: (mv.data_referencia)::text
   Batches: 1  Memory Usage: 285kB
   Buffers: shared hit=282
   ->  Seq Scan on mv_faturamento_dia mv  (cost=0.00..1048.89 rows=27558 width=45) (actual time=0.011..8.533 rows=27947 loops=1)
         Filter: ((data_referencia >= '2025-07-01'::date) AND (data_referencia <= '2026-06-30'::date) AND (id_empresa = 9001) AND ((data_referencia)::text IS NOT NULL))
         Rows Removed by Filter: 13
         Buffers: shared hit=282
 Planning:
   Buffers: shared hit=20
 Planning Time: 0.211 ms
 Execution Time: 14.112 ms
```

Execution Time: **1737.8ms → 28.5ms** (totais) e **14.1ms** (dia). Zero
`temp read/written` (antes 39172/20186 blocos), tudo `shared hit`
(28.960 linhas da MV residem em memória). O Seq Scan sobre a MV é ótimo —
o filtro cobre ~100% da MV (ano inteiro), mesmo racional da onda-008,
só que sobre 27.960 linhas em vez de 900.220.

## 4. Validação de segurança e testes

- **Migration aplicada** ao `hub_homolog_db` via
  `infra/hub/scripts/migrate.sh` (registrada: `0028_mv_faturamento_dia.sql`
  em `SchemaMigration`, 29ª; MV populada com 27.960 linhas; SIGUSR1 no
  PostgREST). Idempotente (padrão 0002+); dry-run prévio em transação com
  ROLLBACK validou sintaxe/paridade sem persistir nada.
- **`hub-faturamento-integration.sh` (stack hub-test-* efêmero): 73/73
  asserts PASS** — os 61 asserts pré-existentes agora exercem o caminho MV
  (paridade comportamental) + 12 novos:
  - (u) `SUM(mv)` = `SUM(FaturamentoLancamento)` por empresa (2 tenants) e
    `SUM(quantidade)` = `count(*)`;
  - (v) **teste negativo cross-tenant de acesso direto**: `SELECT` na MV
    como `authenticated` → `permission denied`;
  - (w) **teste negativo cross-tenant via RPC**: `hub_faturamento_totais`/
    `_agrupado` com `p_id_empresa` de OUTRA empresa (fora do escopo do JWT)
    → linha zerada / 0 grupos, inclusive no fallback por subpraça; controle
    positivo do próprio tenant OK;
  - (x) staleness documentado: fato inserido por SQL não aparece no resumo
    até `hub_faturamento_refresh_mv()` (**modo=concurrent** via dblink) →
    aparece após; refresh com escopo vazio negado (42501).
- **Unit `hub-import-processor.test.js`: 54/54 PASS** (+2 novos: refresh
  chamado 1x APÓS a transição terminal em importação de faturamento
  bem-sucedida; falha do refresh é best-effort e não reverte a importação;
  assert adicional: refresh NUNCA em importação `failed`).
- **Suíte hub unit completa (`npm run test:hub:unit`): 363/363 PASS.**
- **`hub-import-processor-integration.sh` re-executado: 25/25 asserts PASS**
  (stack efêmero, migrations 0000-0028, importações REAIS via pipeline —
  nenhuma regressão com o novo refresh best-effort).
- **E2E ao vivo no hub-homolog — import real → auto-refresh** (janela
  isolada `2026-11-02`, tenant QA 9001). Output literal:

  ```
  resumo ANTES do import (janela 2026-11-02): {"totalGeral":"0.00","categoriaMaiorValor":null,"entregadoresDistintos":0}
  POST /importacoes -> 201 {"id":30,"status":"pending"}
  importacao terminal: {"status":"completed"}
  resumo janela 2026-11-02 (pos-refresh automatico da pipeline): {"totalGeral":"12.34","categoriaMaiorValor":"Followup MV Refresh","entregadoresDistintos":0}
  ```

  Nota observada ao vivo: consultar o resumo no MESMO segundo em que o
  status vira `completed` ainda pode ver o valor antigo — a transição
  terminal é gravada ANTES do refresh (por desenho, best-effort); segundos
  depois o refresh conclui e o resumo reflete o import. É exatamente a
  janela de staleness documentada no contrato. (O fato do import de teste
  ficou no tenant 9001: `id=900300`, `12.34`, `Followup MV Refresh` —
  mesmo tenant sintético QA das ondas anteriores.)

## 5. Pendências que permanecem

- Seed de ~900k linhas em `id_empresa=9001` **mantido de propósito**
  (fixture desta re-medição) — DELETE continua com o operador (mesma
  pendência da onda-009).
- `swapoff`/limpeza não aplicável (nenhum swap temporário adicionado; build
  do backend com cap `--memory=2g`, padrão RUNBOOK).
