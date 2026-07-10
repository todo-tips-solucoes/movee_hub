# Evidências S10 — Regressão geral + preparação de cutover

Fase S10 do hub de frota (briefing `briefings/s10-regressao-cutover.md`),
branch `feat/hub-regressao-cutover`. Produção nunca tocada — tudo executado
em recursos `hub-*` (exceção standing G1) e stacks efêmeros `hub-test-*`/
`hub-s10*-*`.

## 1. Suíte de regressão completa — 19/19 verde em execução única

- **`regressao-run3/`** — execução única VERDE: 19 suítes (unit 515 testes,
  integração node 10 wrappers, 11 suítes .sh das fases S1–S9, E2E do envio em
  massa 62/62, Playwright browser+a11y, scan de dados sensíveis self-test +
  varredura real). `resumo.md` traz a tabela com duração por suíte.
  Driver: `infra/hub/testes/regressao-s10.sh`.
- **`regressao-run1/`** — primeira execução, mantida como evidência dos
  problemas ENCONTRADOS pela S10 (todos de infra/expectativa de teste, zero
  bugs de produto), corrigidos entre run1 e run3:
  1. `test:hub:integration` rodava os 10 wrappers em paralelo (node 22) e os
     `RUNID=$(date +%s)` colidiam → `--test-concurrency=1` (package.json).
  2. E2E S8 assertava baseline fixa `pass=458` da suíte legada; a S9
     acrescentou testes (531) → baseline dinâmica `>=458` + `fail=8` exatos.
  3. `hub-rls-integration.sh` (S2) assertava "evento global sempre visível",
     contrato revogado pela 0035 (S9) → atualizado à spec vigente
     (admin_plataforma) com asserts positivos novos.
  4. `hub-importacoes-integration.sh` (S4) assertava `status=pending` no
     banco (era pré-processador) → aceita a máquina de estados real.
  Também corrigido: `hub-performance{,-dto}.test.js` (S7) não estavam
  registrados nos scripts npm `test:hub:*`.

## 2. Ensaio de migrations — série 0000–0040 do zero e sob volume

- **`ensaio-migrations/`** — driver `infra/hub/testes/ensaio-migrations-s10.sh`
  sobre `compose.hub.s10.yml` (banco em DISCO, não tmpfs).
  - RUN A (cenário do cutover, banco VAZIO): série completa (41) pelo
    `migrate.sh` real, ~0,3s/migration (overhead de `docker exec` dominante),
    total ≈ 13s; re-run = no-op (idempotência).
  - RUN B (robustez sob volume): 0000→0019, carga bulk do dataset sintético
    (1.501.236 FaturamentoLancamento / 639 MB + 1.017.280 PerformanceTurno /
    439 MB + 789 Entregadores; 0 linhas excluídas), 0020→0040 cronometradas
    SOBRE o volume com sampler de `pg_locks` + `log_lock_waits=on`:
    piores casos 0031 (MV performance) 5,7s, 0028 (MV faturamento) 4,4s,
    0020 (índices) 3,0s — **0 locks bloqueados, 0 'still waiting'**;
    idempotência re-comprovada; 0 FKs órfãs.
  - `tabela-tempos-locks.md` é o insumo citado pelo RUNBOOK-CUTOVER.md.
- Dataset: `gen-seeds.py --synthesize-days 374` (375 dias, ≥1 ano; asserção
  de 0 vazamentos; gitignored em `infra/hub/seeds/out-s10/`). LGPD: nenhum
  dump de produção.

## 3. Teste de carga — `carga/`

Driver `infra/hub/testes/carga-s10.sh` no stack volumoso do RUN B
(2,5M linhas), usuário `admin_entidade` @ 9001, 100 reqs/endpoint:

- **Asserts (<1s) todos verdes**: resumos na janela padrão das telas (30d)
  p95 82–137ms; listas paginadas 138–178ms; /importacoes e /auditoria 6–7ms.
- **Import diário via pipeline real** (inclui auto-refresh das MVs):
  faturamento 4014 linhas em 1,7s; performance 2720 linhas em 1,0s
  (limite: 60s). 68 linhas de erro no faturamento = artefato de síntese
  (`atingido` perturbado além da faixa 0–1000; motivo único assertado).
- **Idempotência re-comprovada sob volume**: reenvio idêntico → 409
  CONFLITO (dedupe por hash de arquivo); arquivo com 1 linha nova →
  exatamente +1 fato (dedupe por hash de linha).
- **Achado (informativo, sem assert — decisão do operador)**: com 1 ano
  cheio de dados, resumos full-window 0,75–1,57s e `/motoristas` p95 2,3s
  (paginação/filtro em JS + `hub_areas_por_entregador` varrendo as 2 tabelas
  de fato). Follow-up funcional registrado no RUNBOOK §11 — não bloqueia
  cutover (módulos nascem vazios).

## 4. Ensaio de rollback — `rollback/`

Driver `infra/hub/testes/ensaio-rollback-s10.sh` no hub-homolog:
backup real (`backup.sh`, pg_dump -Fc) → **restore TESTADO** (`restore.sh`,
banco `hub_restore`, contagens iguais tabela a tabela) → deploy simulado de
imagem nova → **rollback com image-id idêntico ao baseline** → smoke 200 em
todas as etapas, contagens intactas.

**Achado que gerou a migration 0040**: na primeira execução o `pg_restore`
falhou (`function unaccent(text) does not exist` no índice
`idx_conta_motorista_nome_trgm`) — `hub_normaliza_nome` (0021) chamava
`unaccent()` sem qualificar o schema e o restore roda com `search_path`
vazio. Ou seja: **o backup não restaurava limpo** — exatamente o caminho de
rollback do cutover. A corretiva `0040_fix_normaliza_nome_search_path.sql`
(qualifica `public.unaccent`) foi aplicada no hub-homolog e validada: o
re-ensaio fechou 100% verde.

## 5. Runbook e pendências

- `../RUNBOOK-CUTOVER.md` — completo (pré-checagens com auditoria do schema
  real, mapa de aplicabilidade por migration com **0033/0034 NUNCA em
  produção**, backup+restore validado, sequência P0–P10 com go/no-go,
  rollback encadeado ENSAIADO, aposentadoria das flags S8, checklist dos 5
  gates, plano de observação 24h).
- Pendências pré-G3 (donos no runbook §2): issue #62 (`ENVIO_DRY_RUN`),
  decisão D5 (retenção da auditoria).
