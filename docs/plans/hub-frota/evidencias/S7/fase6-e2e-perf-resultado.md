# FASE 6 — E2E, Performance e Evidências finais (hub-performance / S7)

Execução: onda-006 do `/feature-00c` (short_name `hub-performance`), 2026-07-08.
Ambiente: hub-homolog ISOLADO e PERSISTENTE (`https://hub-homolog.todo-tips.com:8443`),
recursos `hub-*`/`hub_*` (exceção G1). Nenhum recurso fora do prefixo `hub-`/`hub_`
tocado; `envio-massa-homologacao_*`/`chatmasterveloz` não tocados nesta onda.

## 0. Deploy prévio (pré-requisito para o quickstart)

A imagem `hub-frontend:homolog` em execução ainda **não** continha o código da
FASE 5 (tela `/hub/dashboard/performance`, commit `7acc0a3`) — container criado
antes do commit. A imagem `hub-backend:homolog` também **não** continha as
FASES 1-4 (`routes/hub-performance.js` ausente do binário em execução, apesar
das migrations `0029`/`0030` já estarem aplicadas no `hub_homolog_db` desde a
onda-004). Rebuild + redeploy de ambos, com cap de memória (lição
2026-06-11):

```
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  --env-file /var/lib/hub_secrets/.env.hub.homolog build backend
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  --env-file /var/lib/hub_secrets/.env.hub.homolog build --memory=2g frontend
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  --env-file /var/lib/hub_secrets/.env.hub.homolog up -d backend frontend
```

Smoke pós-deploy: `/hub/login` 200, `/hub/dashboard/performance` 200, backend
log "Servidor rodando na porta 3000" sem erros. RAM do host monitorada
durante o build (nunca < 950 MiB disponível), sem starvation.

## 1. Seed funcional isolado (Cenários 1-4, 6-9, 11, 13, 14)

Dados de controle inseridos via SQL direto no `hub_homolog_db` (mesmo padrão
de higiene das fases anteriores — inserts idempotentes, `hash_linha` únicos
derivados de `md5('onda006-cenario*')`, preservados como fixture de
regressão futura):

- **Grupo A** (Cenário 1/4, janela padrão últimos 30 dias): 4 registros
  `id_empresa=9001`, `periodo` `ALMOCO 11H30-15H29` (2 datas, somando
  `corridasCompletadas`=60) + `JANTAR 18H-22H` (1 registro, isolando o
  filtro) + `TURNO_CUSTOM_XYZ_ONDA6` (periodo fora dos 16 documentados).
- **Grupo B** (Cenário 2, janela isolada `1900-02-02`/`CENARIO2_RAZAO`): 2
  registros com taxas de aceitação individuais bem diferentes (100% e 60%).
- **Grupo C** (Cenário 3, janela isolada `1900-03-03`/`CENARIO3_PESO` +
  `1900-03-04`/`CENARIO3_FALLBACK`): 2 registros com durações diferentes
  (2h29/3h59) + 2 registros isolados cobrindo o fallback `duracao IS NULL`.
- **Grupo E** (Cenário 8, janela isolada `1900-08-08`): 1 entregador dedicado
  `+Perigoso Nome Onda6` + 3 registros cobrindo `periodo`/`subpraca` com
  `=`/`@`/apóstrofo-já-presente (CHK031)/`#` (neutro, CHK031).
- **Grupo G** (Cenário 11, isolamento multi-tenant): 1 registro
  `id_empresa=9002` com marcador único `corridasCompletadas=777`.
- **Grupo H** (Cenário 14, divisão por zero): 1 registro
  `corridas_ofertadas=0`/`corridas_aceitas=0` (janela isolada `1900-01-14`).

SQL completo em `/tmp/seed-performance-onda006.sql` (não versionado —
reprodutível a partir desta descrição; preservado como fixture permanente no
`hub_homolog_db`, mesmo padrão da S5/S6).

## 2. Live E2E contra hub-homolog (dados reais, usuários QA reais, fetch real)

Usuários QA usados (login real via `POST /auth/login` + `POST /me/entidade`,
cookie de sessão real, sem mock — mesmos 3 usuários já seedados em S5/S6):

| Email | Empresa | Papel | Permissões relevantes |
|---|---|---|---|
| `qa.importacoes@moveelog.local` | 9001 | `admin_entidade` | listar+consultar+exportar |
| `qa.motoristas.leitura@moveelog.local` | 9001 | `leitura` | listar+consultar, **sem** exportar |
| `qa.motoristas.outraempresa@moveelog.local` | 9002 | `admin_entidade` | listar+consultar+exportar (tenant isolado) |

Script Node (fetch nativo, `NODE_TLS_REJECT_UNAUTHORIZED=0` só para o
certificado self-signed do hub-homolog) contra
`https://hub-homolog.todo-tips.com:8443/api/v1` — **35 PASS / 0 FAIL**,
cobrindo os Cenários 1, 2, 3 (+ fallback), 4, 6, 7, 8 (+ CHK031), 9, 10
(parcial — ver §2.1), 11, 13, 14:

```
PASS: sem auth -> GET /performance 401
PASS: C1: resumo filtrado -> 200
PASS: C1: corridasCompletadas=60 (40+20, bate SQL SUM)
PASS: C2: taxaAceitacao=0.6040 (razão de somas)
PASS: C2: taxaAceitacao != média simples (0.8000)
PASS: C3: tempoDisponivelMedio=65.36 (ponderado)
PASS: C3: != média aritmética simples (70.00)
PASS: C3 fallback: tempoDisponivelMedio=60.00 (média simples 80+40)/2
PASS: C4: soma groupBy=entregador bate com resumo
PASS: C4: soma groupBy=dia bate com resumo
PASS: C4: soma groupBy=periodo bate com resumo
PASS: C4: periodo fora dos 16 documentados aparece normalmente sob o próprio texto
PASS: C6: resumo período vazio -> 200
PASS: C6: corridasCompletadas=0
PASS: C6: taxaAceitacao=null
PASS: C6: lista período vazio -> 200
PASS: C6: lista total=0/items=[]
PASS: C7: CSV -> 200
PASS: C7: CSV linhas de dados bate com total da lista
PASS: C8: periodo "=SOMA..." prefixado com ' único
PASS: C8: subpraca "@Perigosa..." prefixado com ' único
PASS: C8: entregadorNome "+Perigoso..." prefixado com ' único
PASS: C8 (CHK031): periodo já-apóstrofo mantém UM único apóstrofo (sem dupla)
PASS: C8 (CHK031): subpraca "#neutro" sem prefixo espúrio
PASS: C8 (CHK031): confirma ausência de prefixo em "#neutro"
PASS: C9: CSV vazio -> 200
PASS: C9: CSV vazio -> só cabeçalho (1 linha)
PASS: C10: papel leitura (SEM exportar) -> GET ?format=csv 403 mesmo com .listar
PASS: C10: papel leitura -> GET /performance (tem .listar) 200
PASS: C11: 9002 -> corridasCompletadas=777 (isolado, marcador único)
PASS: C11: 9001 na mesma janela -> total=0 (não vê linha da 9002)
PASS: C13: item bate com contrato performance-api.md (camelCase completo)
PASS: C14: divisão por zero -> 200 (nunca erro)
PASS: C14: taxaAceitacao=null (nunca 0/1)
PASS: C14: taxaConclusao=null (nunca 0/1)

___SUMMARY___ fails=0 passes=35
```

### 2.1 Cenário 10 — combinações de permissão não cobertas pelos 4 papéis-seed

Os 4 papéis-seed do hub-homolog (`admin_plataforma`/`admin_entidade`/
`operador`/`leitura`) têm `performance.listar` desde a migration `0029`
(nenhum papel de teste "só consultar sem listar" ou "só listar sem
consultar" disponível no ambiente persistente sem criar um papel sintético
permanente, o que poluiria o RBAC compartilhado entre módulos — mesma
decisão de governança já registrada em `hub-faturamento` §Cenário 10 passo
5). Essas 2 sub-provas específicas (passos 2 e 3 do Cenário 10) são cobertas
pelo teste determinístico `infra/hub/testes/hub-performance-integration.sh`
(60/60 asserts PASS, onda-004 — ambiente `hub-test-*` efêmero com papéis
sintéticos descartáveis), que exercita exatamente o mesmo middleware
`requirePermission('performance.*')` usado pelo backend vivo — mesma
garantia, sem criar um papel espúrio no ambiente compartilhado. O passo 4
(listar+consultar, sem exportar) **foi** coberto ao vivo acima com o papel
`leitura` real.

## 3. Cenário 5 — data do turno é o único campo de filtro de data

Já coberto por leitura de código + teste unitário
(`hub-performance-dto.test.js`, `parseFiltros`): o filtro `de`/`ate` usa
exclusivamente `data_periodo` — `"PerformanceTurno"` não tem nenhum outro
campo de data. Sem novo teste ao vivo (não há comportamento adicional a
observar além do já garantido pelo contrato/testes unitários).

## 4. Cenário 12 — identidade visual preservada (SC-008)

`playwright.config.cenario12perf.ts` +
`tests/e2e-hub-cenario12-performance/cenario12-branding.spec.ts` (mesmo
molde do Cenário 14 de `hub-faturamento`/S6): login real, tema via
`localStorage`, aguarda "Carregando performance..." sumir, valida heading
"Performance" + card "Taxa de aceitação" visíveis, screenshot full-page.
Rodado dentro da imagem oficial `mcr.microsoft.com/playwright:v1.61.1-jammy`
(zero apt/npx install no host). **2/2 passed**:

```
✓ 1 [chromium] › cenario12-branding.spec.ts:28:7 › Cenário 12 — tela de performance (light) (1.2s)
✓ 2 [chromium] › cenario12-branding.spec.ts:28:7 › Cenário 12 — tela de performance (dark) (933ms)
2 passed (3.2s)
```

Screenshots em `cenario12-performance-{light,dark}.png` (cópia nesta pasta)
— identidade EntreGô 2.0 preservada nos dois temas (mesmo padrão de
cards/tabela/filtros já usado em `.../faturamento`/`.../motoristas`).

## 5. Cenário 15 — Performance sob volume ampliado (SC-004)

### 5.1 Seed de volume

900.000 linhas geradas via `generate_series` direto no `hub_homolog_db`
(mesma técnica de `hub-faturamento`/S6, `01-plano-tecnico.md §7.7`),
exclusivamente para `id_empresa=9001` (tenant sintético isolado, nenhum
outro tenant/produção tocado). Distribuídas ao longo de `2025-07-01` a
`2026-06-30` (~1 ano), 210 entregadores distintos (todos os já existentes
em 9001, exceto o dedicado ao Cenário 8), 16 valores de `periodo` cíclicos,
~9% das linhas com `duracao IS NULL`, ~7,7% com `tempo_disponivel_pct IS
NULL`:

```
INSERT 0 900000  -- Time: 30975 ms (00:30.975)
```

Total pós-seed: **900014 linhas** para `id_empresa=9001` (900000 do seed de
volume + 14 do seed funcional §1).

### 5.2 Medição end-to-end (HTTP real, `qa.importacoes@moveelog.local`)

Intervalo `de=2025-07-01&ate=2026-06-30` (cobre TODO o volume populado —
pior caso). 1 chamada de aquecimento descartada antes da medição, 2 rodadas:

```
SEM groupBy:              1a rodada 1983.0ms | 2a rodada 1794.0ms
groupBy=dia:               1a rodada 2192.7ms | 2a rodada 2198.8ms
groupBy=periodo:           1a rodada 1866.3ms | 2a rodada 1629.1ms
groupBy=entregador:        1a rodada 1572.5ms | 2a rodada 1618.3ms
Limite SC-004: 1000ms
```

**TODAS excedem 1s — SC-004 VIOLADO** sob o volume anual completo (mesmo
achado formal de dec-035 em `hub-faturamento`/S6).

### 5.3 `EXPLAIN (ANALYZE, BUFFERS)` das RPCs subjacentes

**`hub_performance_totais`** (cards, sem groupBy):

```
Result (actual time=2182.832..2182.838 rows=1 loops=1)
  Buffers: shared hit=880501 read=20233 written=6577, temp read=87584 written=21896
  CTE filtro -> Index Scan using idx_performanceturno_empresa_data
    (actual time=0.852..559.351 rows=900000 loops=1)
  InitPlan 2 (SUM completadas)     -> Aggregate (actual time=937.432..937.433)
  InitPlan 3 (taxa_aceitacao)      -> Aggregate (actual time=370.273..370.273)
  InitPlan 4 (taxa_conclusao)      -> Aggregate (actual time=214.301..214.302)
  InitPlan 5 (tempo_disponivel)    -> Aggregate (actual time=449.181..449.182)
  InitPlan 6 (taxas_reais)         -> Aggregate (actual time=211.612..211.613)
Execution Time: 2198.298 ms
```

A CTE usa Index Scan (`idx_performanceturno_empresa_data`, diferente do
`hub-faturamento` que fazia Seq Scan — aqui o índice cobre `id_empresa` +
`data_periodo`), mas a CTE é **materializada e re-escaneada 5 vezes** (1 por
InitPlan: soma, taxa de aceitação, taxa de conclusão, tempo disponível
ponderado, taxas reais) — cada `CTE Scan on filtro` percorre as 900000 linhas
inteiras, e o resultado intermediário grava/lê `temp` em disco
(`temp read=87584 written=21896` blocos). O custo dominante é a
re-materialização repetida da CTE, não a leitura da tabela base em si.

**`hub_performance_agrupado`** (`groupBy=dia`):

```
HashAggregate (actual time=858.500..859.079 rows=365 loops=1)
  Group Key: (PerformanceTurno.data_periodo)::text
  -> Seq Scan on "PerformanceTurno" (actual time=0.018..407.094 rows=900000 loops=1)
Execution Time: 859.191 ms
```

SQL puro relativamente rápido isolado (859ms, já próximo do limite mesmo
sem overhead de rede) — o tempo HTTP observado (~1.6-2.2s) inclui overhead
adicional de rede/TLS/serialização/PostgREST acima da query em si.

Em ambos os planos, o filtro por `id_empresa`+intervalo cobre praticamente
100% das linhas do tenant no pior caso (ano inteiro populado) — cenário em
que o índice ainda ajuda na CTE de `totais` mas não evita o custo de
agregação sobre quase todas as linhas.

### 5.4 Decisão auditável (dec-029)

Registrada via `state-decisions.sh` (score 3, evidência empírica acima):
violação de SC-004 confirmada; `mv_performance_dia` (research.md Decision 8,
plano técnico §12.6, espelhando `mv_faturamento_dia` da migration 0028) é a
mitigação pré-aprovada, mas implementá-la exige nova migration + estratégia
de refresh + mudança nas 2 RPCs + testes — escopo novo além do backlog de 12
tarefas/74 subtarefas já revisado (gates verdes na onda-005). Escolha
registrada: **`registrar-e-escalar-para-operador`** — mesmo padrão de
governança já usado em `hub-faturamento` (dec-035) e nas decisões de schema
D3/D4 do plano hub-frota. **Não implementado nesta onda.**

### 5.5 Limpeza do seed de volume — EXECUTADA

Ao contrário da 1ª tentativa em `hub-faturamento` (bloqueada pelo
classificador de auto mode), a limpeza foi executada nesta onda sem
bloqueio: `DELETE FROM "PerformanceTurno" WHERE id_empresa=9001 AND
importacao_id=<id do seed de volume> AND id BETWEEN 52 AND 900051` (faixa
exata dos 900000 registros gerados, confirmada por `SELECT count(*)` antes
do delete) — `DELETE 900000`. Removida também a `ImportacaoArquivo` dedicada
do seed de volume. `VACUUM ANALYZE` + `VACUUM FULL` — tamanho de
`"PerformanceTurno"` **337 MB → 96 kB**. Preservados: 14 linhas do seed
funcional §1 (`id_empresa=9001`) + 1 linha da prova de isolamento
(`id_empresa=9002`). Smoke pós-limpeza: hub-homolog `/hub/login` 200,
produção `app.moveelog.com.br/login` 200 e
`app.motorista.moveelog.com.br/login` 200 (ambas intocadas).

## 6. Pendências para o operador (não bloqueiam o fechamento da S7)

1. **`mv_performance_dia`** (dec-029): decidir se implementa a view
   materializada agora (nova FASE/S7.1) ou aceita o risco por enquanto —
   SC-004 está formalmente violado sob volume de ~1 tenant grande/ano
   (mesmo padrão do achado em `hub-faturamento`).
2. Pendência recorrente (desde S1): trailer de commit do CLAUDE.md ("Claude
   Opus 4.8") desatualizado vs. modelo vigente — sem decisão do operador.
3. Gaps `{humano}` do checklist CHK022 (procedimento de medição de SC-003)
   e CHK024 (critério objetivo de SC-008) — ver §7 abaixo, mesmo padrão já
   aceito em `hub-faturamento` (CHK020/CHK023).
