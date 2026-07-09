# Follow-up S7 — SC-004 sanado com `mv_performance_dia` (migration 0031)

Data: 2026-07-08 · Branch `feat/hub-performance` (PR draft #60) · Autorizado
pelo operador como follow-up da ressalva formal do review da onda de
fechamento da S7 (dec-029/dec-032): "implementa a mv_performance_dia como
follow-up, igual fizemos na S6". Replica EXATAMENTE o padrão do follow-up
da S6 (`mv_faturamento_dia`, migration 0028, commit `d3b5dab`).

Ambiente: hub-homolog ISOLADO (`https://hub-homolog.todo-tips.com:8443`),
`hub_homolog_db`, seed de volume RECRIADO com o mesmo desenho da medição
original (~900k linhas/1 ano, `id_empresa=9001`) e DELETADO ao final
(lição da S6). Produção (`envio-massa-homologacao_*`/`chatmasterveloz`)
nunca tocada — smoke `https://app.moveelog.com.br/login` = **200** e Swarm
`envio-massa-homologacao_*` **1/1** antes e depois.

## 1. O que foi implementado

- **`infra/hub/migrations/0031_mv_performance_dia.sql`** — MV
  `mv_performance_dia`, grão `(id_empresa, data_periodo, periodo,
  entregador_id)` (todas NOT NULL no fato 0014 — índice ÚNICO direto nas
  colunas do grão, pré-requisito do `REFRESH CONCURRENTLY`). Métricas
  DECOMPONÍVEIS: Σ de cada contador de corridas, Σ`taxas_centavos` e, para
  o `tempo_disponivel_medio` ponderado por `duracao` (dec-011), numerador e
  denominador separados (`pct_x_duracao_soma`/`duracao_epoch_soma`) + Σpct
  e count(pct) (`pct_soma`/`pct_n`) para o fallback de média simples + o
  flag `pct_com_duracao_nula` que decide o ramo — as taxas agregadas são
  SEMPRE Σnum/Σden na leitura, nunca média de médias (SC-002). `subpraca`
  fica FORA do grão: quando `p_subpraca` é informado as RPCs caem no
  caminho antigo (tabela-base), mesma semântica de 0030/0028.
- Isolamento multi-tenant idêntico ao da 0028 (MV não tem RLS): **REVOKE
  de SELECT direto** para `authenticated`/`hub_web_anon`; RPCs
  `hub_performance_totais`/`hub_performance_agrupado` reescritas em
  plpgsql `SECURITY DEFINER` com guard explícito
  `p_id_empresa = ANY (hub_jwt_escopo_ids())` (inclusive no fallback) e
  `search_path` fixado. Contrato HTTP **inalterado** (paridade exata de
  resposta MV×base).
- **`hub_performance_refresh_mv()`** — `REFRESH ... CONCURRENTLY` via
  dblink (sessão própria, fora da transação do PostgREST; fallback
  bloqueante), negado para JWT sem escopo (42501).
- **`backend/lib/hub-import-processor.js`** — o bloco de refresh pós-import
  virou um mapa por tipo: importação de **performance** bem-sucedida
  dispara `rpc/hub_performance_refresh_mv` (best-effort, após a transição
  terminal), exatamente como faturamento→0028. Staleness documentado em
  `contracts/performance-api.md`; migration listada em `data-model.md`.

## 2. Aplicação no hub-homolog + paridade com dados reais

- 0031 aplicada via `infra/hub/scripts/migrate.sh` (registrada em
  `SchemaMigration` como 32ª — `0031_mv_performance_dia.sql`; SIGUSR1 no
  PostgREST). **Idempotência provada 2x**: re-run do migrate.sh ("pulada
  (já aplicada)") e re-aplicação do SQL bruto via psql (exit 0, sem erro).
- **Paridade ANTES×DEPOIS byte a byte**: snapshot das duas RPCs com os
  dados reais existentes (tenant 9001: 14 linhas; 9002: 1 linha) capturado
  ANTES da migration (caminho tabela-base/RLS de 0030) e DEPOIS (caminho
  MV/DEFINER de 0031) — `diff` = **vazio** (`PARIDADE_EXATA=OK`), cobrindo:
  totais full, totais com `subpraca` (fallback), agrupado dia/periodo/
  entregador, agrupado com `subpraca`, e o negativo cross-tenant (escopo
  `[9001]` pedindo 9002 → `0||||0.00` / 0 grupos — idêntico à RLS).
- Backend hub-homolog rebuildado (cap `--memory=2g`, padrão RUNBOOK, sem
  swap extra) e no ar (`hub_homolog_backend` Healthy).

## 3. E2E ao vivo — import real de performance → auto-refresh

Janela isolada `2026-11-03`, tenant QA 9001, CSV real de performance com 2
linhas via `POST /api/v1/importacoes` (HTTP, `qa.importacoes@moveelog.local`).
Output literal:

```
resumo ANTES do import (janela 2026-11-03): {"corridasCompletadas":0,"taxaAceitacao":null,"taxaConclusao":null,"tempoDisponivelMedio":null,"taxasReais":"0.00"}
POST /importacoes -> 201 {"id":37,"status":"pending"}
importacao terminal: {"status":"completed"}
resumo janela 2026-11-03 (pos-refresh automatico da pipeline): {"corridasCompletadas":11,"taxaAceitacao":"0.8000","taxaConclusao":"0.9167","tempoDisponivelMedio":"72.00","taxasReais":"20.00"}
```

Todos os 5 valores batem com o cálculo manual das 2 linhas (7+4=11;
12/15=0.8000; 11/12=0.9167; ponderado (80×10800+60×7200)/18000=72.00;
(1234+766)/100=20.00). (Tentativas 35/36 falharam por CSV inválido de
teste — UUID não-hex e taxas com decimal; `failed` sem fato persistido,
comportamento correto do pipeline. O fato do import 37 permanece no tenant
9001, mesmo padrão do E2E da S6.)

## 4. Re-medição SC-004 — HTTP end-to-end (mesma metodologia da dec-029)

Seed de volume recriado com o mesmo desenho da medição original
(`generate_series` direto no `hub_homolog_db`): **900.000 linhas** para
`id_empresa=9001`, `2025-07-01..2026-06-30` (365 dias), 210 entregadores,
16 valores de `periodo` cíclicos, ~9% `duracao IS NULL`, ~7,7%
`tempo_disponivel_pct IS NULL` — `INSERT 0 900000` em 32,8s (total 900.016
no tenant). `REFRESH ... CONCURRENTLY` em **4,9s** → MV com **122.657
linhas (~7,3x menor** que o fato; **26 MB vs 336 MB**; grão
dia×periodo×entregador é mais fino que o do faturamento, por isso a
compressão é menor que os 32x da S6 — ainda assim suficiente, ver abaixo).
Paridade agregada sob volume: `SUM(corridas_completadas)`,
`SUM(quantidade)=count(*)` e `SUM(taxas_centavos)` MV×base = `t|t|t`.

Medição: `qa.importacoes@moveelog.local`, entidade 9001,
`de=2025-07-01&ate=2026-06-30` (TODO o volume, pior caso), 1 aquecimento
descartado, 2 rodadas. Output literal do runner:

```
SEM groupBy: 1a 146.7ms | 2a 139.4ms  -> {"corridasCompletadas":8100000,"taxaAceitacao":"0.8333","taxaConclusao":"0.9000","tempoDisponivelMedio":"69.99","taxasReais":"22932000.00"}
groupBy=dia: 1a 164.7ms | 2a 189.2ms  -> 365 grupos
groupBy=periodo: 1a 134.0ms | 2a 151.2ms  -> 16 grupos
groupBy=entregador: 1a 198.7ms | 2a 197.5ms  -> 210 grupos
Limite SC-004: 1000ms
```

| Medição (HTTP end-to-end) | dec-029 (antes) | follow-up (depois) | Limite |
|---|---|---|---|
| `/resumo` sem `groupBy` | 1983.0 / 1794.0ms | **146.7 / 139.4ms** | 1000ms |
| `groupBy=dia` | 2192.7 / 2198.8ms | **164.7 / 189.2ms** | 1000ms |
| `groupBy=periodo` | 1866.3 / 1629.1ms | **134.0 / 151.2ms** | 1000ms |
| `groupBy=entregador` | 1572.5 / 1618.3ms | **198.7 / 197.5ms** | 1000ms |

**SC-004 PASSA em todos os agrupamentos, com folga de ~5-7x sob o limite
(~8-16x mais rápido que a medição original).** Paridade de valores sob
volume: a fórmula ORIGINAL de 0030 rodada direto na tabela-base sobre as
900k linhas retorna exatamente o que o HTTP (caminho MV) serviu —
`8100000 | 0.8333 | 0.9000 | 69.99 | 22932000.00`.

`EXPLAIN (ANALYZE, BUFFERS)` do corpo literal de `totais` (caminho MV):
Seq Scan na MV de 122.640 linhas em ~31ms + 5 agregações da CTE (~187ms de
agregação total, **zero temp em disco** — na dec-029 a mesma consulta
varria 900k linhas 5x com `temp read=87584 written=21896` e 2198ms).

## 5. Validação de segurança e testes

- **`hub-performance-integration.sh` (stack hub-test-* efêmero): 84/84
  asserts PASS** — 63 pré-existentes agora exercem o caminho MV (paridade
  comportamental: valores esperados calculados da semântica da tabela-base)
  + 21 novos:
  - HTTP: fallback `subpraca` (5 asserts — totais + groupBy=dia, valores
    conhecidos) e multi-tenant do `/resumo` via HTTP (2);
  - (u) paridade `SUM(mv)` = agregados diretos da tabela-base (2 tenants,
    completadas/taxas/quantidade — 5 asserts);
  - (v) **negativo de acesso direto**: `SELECT` na MV como `authenticated`
    → `permission denied`;
  - (w) **negativo cross-tenant via RPC**: `hub_performance_totais`/
    `_agrupado` com `p_id_empresa` fora do escopo do JWT → zerado/0 grupos,
    inclusive no fallback por subpraça; controle positivo do próprio tenant
    → `26|0.8182|35.00`;
  - (x) staleness: fato via SQL só entra no `/resumo` após
    `hub_performance_refresh_mv()` (**modo=concurrent** via dblink);
    refresh com escopo vazio negado (42501).
- **Unit `hub-import-processor.test.js`: 56/56 PASS** (+2 novos: refresh da
  `mv_performance_dia` exatamente 1x APÓS a transição terminal em import de
  performance, NUNCA o RPC de faturamento — e vice-versa; falha do refresh
  é best-effort). **Suíte hub unit completa (`npm run test:hub:unit`):
  365/365 PASS.** `hub-performance-dto.test.js` + `hub-performance.test.js`:
  35/35 PASS.

## 6. Limpeza do seed sintético (EXECUTADA, pós-SC-004 verde)

`DELETE FROM "PerformanceTurno" WHERE id_empresa=9001 AND
importacao_id=<seed dedicado>` → `DELETE 900000` (1,1s); DELETE da
`ImportacaoArquivo` dedicada; `REFRESH ... CONCURRENTLY` (MV consistente em
17 linhas); `VACUUM ANALYZE` + `VACUUM FULL` na tabela e na MV —
**336 MB → 96 kB (fato) e 26 MB → 64 kB (MV)**. Preservados: 16 linhas do
tenant 9001 (14 do seed funcional + 2 do E2E do import 37) + 1 linha da
prova de isolamento (9002). Resumo pós-limpeza na janela do E2E continua
íntegro (`{"corridasCompletadas":11,...,"taxasReais":"20.00"}`).

## 7. Smoke final (não-interferência)

- hub-homolog: `/hub/login` **200** · `/hub/dashboard/performance` **200**.
- Produção: `https://app.moveelog.com.br/login` **200**; Swarm
  `envio-massa-homologacao_*` **4 serviços 1/1** (somente leitura HTTP/`docker service ls`).

## 8. Pendências que permanecem

- Revisão/merge do PR #60 pelo operador (ressalva SC-004 da S7 agora
  RESOLVIDA; permanecem CHK022/CHK024 `{humano}` e o trailer de commit).
- Sem swap temporário adicionado; build do backend com cap `--memory=2g`
  (padrão RUNBOOK) — nada a desfazer.
