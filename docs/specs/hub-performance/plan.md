# Plano de Implementação — Módulo Performance (hub-performance / S7)

## Summary

Módulo de consulta (100% leitura) sobre o fato `PerformanceTurno`
(já populado desde a S4/hub-importacoes, RLS desde a S5): lista paginada e
filtrável por turno, resumo agregado (cards) e agregado por
dia/período/entregador, export CSV protegido contra CSV injection, tela
`/hub/dashboard/performance` no shell. Ponto de maior risco de corretude:
o tempo disponível médio do período MUST ser uma média ponderada pela
duração do turno (`duracao`, já persistida como `interval` desde a
importação), não uma média aritmética simples das linhas — com fallback
documentado (dec-011) quando a duração não é derivável para algum
registro do conjunto/grupo. Toda taxa (aceitação/conclusão) é razão entre
somas, nunca média de percentuais linha a linha (mesmo princípio já
validado em `hub-faturamento`, S6). Terceira permissão (`performance.listar`)
introduzida NESTA fase (não como follow-up, ao contrário do `faturamento.listar`
que só veio na migration corretiva `0026`).

## Technical Context

- **Stack**: Express (`app_homologacao/backend`), PostgREST sobre
  `hub_homolog_db`, Next.js `frontend_v2` (shell `/hub/dashboard/*`,
  design system EntreGô 2.0). Nenhuma dependência nova.
- **Dados de origem**: `"PerformanceTurno"` (migration `0014`, ~2,7 mil
  linhas/dia, append-only), RLS por `id_empresa` (migration `0015`),
  índice de subpraça (`0020`). Nenhuma alteração de schema.
- **Permissões**: módulo `performance` já seedado (`0007`) com
  `performance.consultar`/`performance.exportar`; esta fase adiciona
  `performance.listar` (migration `0029`).
- **Reuso direto** (sem modificação): `lib/hub-postgrest.js`,
  `lib/hub-rbac-cache.js`, `lib/hub-csv.js`, `middleware/hub-require-permission.js`,
  `lib/hub-auditoria.js` — mesmos módulos já usados por
  `routes/hub-faturamento.js`/`routes/hub-motoristas.js`/`routes/hub-importacoes.js`.
- **Feature-irmã de referência**: `hub-faturamento` (S6) — mesmo
  fato-família (import da mesma dupla de ZIPs), mesmo padrão de contrato,
  mesmo gate de segurança. Divergências documentadas em `research.md`
  (ponderação por duração, ausência de bucket "sem entregador", 3ª
  permissão nesta fase em vez de follow-up).

## Constitution Check

*GATE: passou antes do Phase 0 (`feature-00c-preflight.sh check`, exit 0,
`{"ok":true,"findings":[]}` — onda-003, dec-014); re-checado após Phase 1
(§ no fim).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Auth & Segredos (NON-NEGOTIABLE) | PASS | Auth por cookie httpOnly reusada, sem segredo novo; nenhum dado de autenticação exposto pela API de performance |
| II. Isolamento Multi-Tenant por Empresa (NON-NEGOTIABLE) | PASS | `id_empresa` sempre do token; RLS já existente em `"PerformanceTurno"` (`0015`) cobre lista/resumo/export (funções RPC `SECURITY INVOKER` herdam a mesma policy); nenhuma consulta cross-tenant possível por construção |
| III. Contratos de API & Proxy de Cookies | PASS | Endpoints sob `/api/v1/performance*`; contrato camelCase declarado (`contracts/performance-api.md`); roundtrip real a evidenciar no quickstart (Cenário 13, mesmo molde de hub-faturamento) |
| IV. Qualidade e Revisão de Mudanças | PASS | Unit-first previsto (DTO, cálculo ponderado, mapeamento RPC); gates doc/security aplicados a este plano; fechamento só em `review-task` (DIARIO + PR) |
| V. Deploy Conteinerizado e Convivência (NON-NEGOTIABLE) | PASS | Só recursos `hub-*` isolados; migrations via `migrate.sh` do hub; nenhuma integração nova com `chatmasterveloz` (feature 100% leitura sobre dado já importado dentro do hub isolado) |

Nenhuma violação de MUST. Prosseguir.

## Project Structure

### Documentação (feature dir)
```
docs/specs/hub-performance/
├── spec.md            (existente; clarify integrado — Clarifications Q1/Q2 + FR-003/FR-008)
├── plan.md            (este)
├── research.md        (Phase 0 — 12 decisions)
├── data-model.md       (PerformanceTurno inalterada + Resumo Agregado + Permissao nova)
├── contracts/
│   └── performance-api.md
└── quickstart.md       (cenários E2E)
```

### Código (árvore real do projeto)
```
infra/hub/migrations/
├── 0029_seed_permissao_performance_listar.sql  (novo — Decision 1)
└── 0030_hub_performance_rpc_resumo.sql          (novo — Decisions 2-4)

app_homologacao/backend/
├── routes/hub-performance.js            (novo — endpoints do contracts/performance-api.md)
├── lib/
│   ├── hub-performance-dto.js           (novo — mapper snake_case↔camelCase, parsePaginacao/parseFiltros, export streaming)
│   ├── hub-csv.js                       (existente — reusar, Decision 6)
│   ├── hub-postgrest.js                 (existente — reusar, inclusive `opts.range` para paginação do export)
│   ├── hub-rbac-cache.js                (existente — reusar `obterPermissoesEfetivas` na checagem inline de `performance.exportar`)
│   └── hub-auditoria.js                 (existente — reusar para `performance.csv_exportado`)
├── middleware/hub-require-permission.js  (existente — reusar, sem alteração)
└── tests/
    ├── hub-performance-dto.test.js       (novo — unit, mapper + filtros + paginação + fórmula ponderada)
    └── hub-performance.test.js           (novo — integração, PostgREST hub)

app_homologacao/frontend_v2/
├── app/hub/dashboard/performance/
│   └── page.tsx                         (novo — lista + filtros + cards, padrão de .../faturamento/page.tsx)
└── lib/hub/
    ├── performance-api.ts                (novo — chamadas ao backend)
    └── performance-dto.ts                (novo — tipos + parse defensivo, padrão de faturamento-dto.ts)
```
`server.js` ganha 1 linha nova (mesma altura das demais montagens `hub*`):
`app.use('/api/v1/performance', hubPerformanceRoutes.router);`.

## Convenções de Borda

Idênticas às de `hub-faturamento/plan.md` §Convenções de Borda: JWT
`HS256` pinado; `id_empresa` sempre resolvido de `payload.entidade_ativa`
(nunca query/body); erros no formato curto `{ "erro": "CODIGO" }`; valores
monetários/percentuais como `text` fixo (Decision 7); `camelCase` na borda
da API, `snake_case` no banco; paginação Range 0-indexed inclusive.

## Plano por fases (ordem do briefing)

1. **Migrations** (`0029`–`0030`) — permissão `performance.listar` +
   concessão aos 4 papéis-seed (Decision 1); funções
   `hub_performance_totais`/`hub_performance_agrupado` (`SECURITY
   INVOKER`, ponderação condicional via `FILTER`, Decisions 2/3/4) +
   `GRANT EXECUTE`. Aplicar via `migrate.sh` no hub-homolog; verificar
   reload PostgREST (SIGUSR1). Idempotência: re-rodar = no-op.
2. **Lista (leitura)** — `GET /performance`: filtros server-side
   (`de`/`ate`/`periodo`/`subpraca`/`entregadorId`), paginação
   (`PAGE_SIZE_DEFAULT=20`/`MAX=100`, janela padrão 30 dias — mesmas
   constantes de `importacoes`/`motoristas`/`faturamento`).
3. **Resumo (agregados)** — `GET /performance/resumo`: chama
   `hub_performance_totais` (sem `groupBy`) ou `hub_performance_agrupado`
   (com `groupBy` ∈ {`dia`,`periodo`,`entregador`}); resolve `rotulo` via
   join com `Entregador` quando `groupBy=entregador`; trata período vazio
   como `200` com zeros/nulls (FR-011).
4. **Export CSV** — `?format=csv` no mesmo `GET /performance`; checagem
   inline de `performance.exportar` (Decision 9) ANTES de qualquer query;
   laço de paginação `Range` em lotes de 1.000 + `res.write()` incremental
   (Decision 5); neutralização via `lib/hub-csv.js`; auditoria
   `performance.csv_exportado` só no sucesso.
5. **Tela** — `/hub/dashboard/performance` via `/ui-ux-pro-max` (reusar
   padrões shadcn/hook server-side de `.../faturamento/page.tsx`): cards
   de totais (corridas completadas, taxa de aceitação, taxa de conclusão,
   tempo disponível médio), filtros, tabela paginada, botão de export
   condicionado à permissão; estados "período sem dados"/loading/erro;
   gráfico só se o design system já tiver padrão reutilizável — senão
   cards+tabela (FR-012, sem dependência nova sem aprovação).
6. **E2E + evidências** — quickstart no hub-homolog com seeds sintéticos;
   roundtrip real; permissões independentes (listar/consultar/exportar);
   CSV injection; isolamento multi-tenant; branding claro/escuro;
   verificação da fórmula ponderada (KPIs UI × SQL, incluindo o caso de
   fallback); medição de SC-004 sob volume ampliado (seed dedicado,
   Decision 8) com decisão registrada independente do resultado.

## Complexity Tracking

Nenhuma exceção à Constitution necessária. As 2 migrations novas são o
mínimo para tornar FR-003/FR-004/FR-008 testáveis: `performance.listar`
fecha a 3ª permissão exigida por FR-008; as 2 funções RPC são o único
desenho que satisfaz a ponderação condicional (Decisions 2/3) e FR-006
(export sem buffer total) sem mover a agregação para o backend Node.
Nenhuma tabela nova, nenhum índice novo (FR-002 proíbe explicitamente —
respeitado).

## Re-check de Constitution (pós-Phase 1)

Design não introduziu complexidade não justificada — confirmado acima.

**Gate `owasp-security`** (a rodar sobre este plano antes de
`create-tasks`): superfície de ataque desta fase é estritamente leitura +
export — riscos antecipáveis já endereçados no design: (a) SQL injection
nas funções RPC — mitigado por parametrização nativa (`p_periodo`,
`p_entregador_id` etc. como argumentos tipados, nunca concatenação — mesmo
padrão validado em `hub-faturamento`/`hub-motoristas`); (b) BOLA entre
tenants — estruturalmente impossível, RLS já cobre `"PerformanceTurno"` e
as funções `SECURITY INVOKER` herdam a mesma policy; (c) bypass de
permissão de export via chamada direta — endereçado por checagem inline
explícita ANTES de qualquer I/O (Decision 9), com Acceptance Scenario
dedicado (User Story 3, cenário 4); (d) CSV injection — mitigado por reuso
do mecanismo já testado em produção (`lib/hub-csv.js`).

**Gate `owasp-security` — resultado** (checklist API Security Top
10:2023 + OWASP Top 10:2025, aplicado sobre este `plan.md` +
`contracts/performance-api.md` + `data-model.md`): A01 BOLA PASS (RLS +
`SECURITY INVOKER`); A02 Auth Failures PASS (reusa cookie httpOnly +
`requirePermission`); API3 BOPLA N/A (superfície 100% `GET`, nenhum corpo
de request); A05 Injection PASS (funções RPC parametrizadas, zero SQL
concatenado); API5 BFLA PASS (`performance.listar` introduzida nesta fase
resolve exatamente essa lacuna, sem esperar por uma migration corretiva
posterior como aconteceu no faturamento); A09 Logging PASS (export
auditado; negação de acesso via `requirePermission` já é comportamento
herdado); A10 Exception Handling — seguir o padrão já estabelecido
(`500 { "erro": "ERRO_SERVIDOR" }`, nunca stack trace ao cliente).

1 finding **informativo** (não crítico/alto, não bloqueia — idêntico ao
já aceito em `hub-faturamento`): **API4 Unrestricted Resource
Consumption** — o export CSV não tem teto de linhas/período nem
rate-limiting dedicado por endpoint. Aceito como risco documentado: (a)
mesmo padrão já em produção em 3 módulos (`importacoes`/`faturamento`);
(b) auditoria de export dá rastreabilidade para investigar abuso se
ocorrer; (c) rate-limiting é preocupação transversal a todos os módulos do
hub, fora do escopo desta fase resolver isoladamente.

## Próximos passos

`/checklist` (validação de completude/clareza da spec já ratificada) →
`/create-tasks` (backlog FASE-a-FASE, mesmo template de `hub-faturamento/tasks.md`)
→ `/execute-task` (loop por task, incluindo migrations no hub-homolog e
medição real de SC-004) → `/review-task` (fechamento, DIARIO, PR).
