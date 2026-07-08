## Resumo

- Pipeline de importação de CSVs de **faturamento** e **performance** para
  o Hub de Frota (S4 do plano mestre): upload com dedupe duplo (hash de
  arquivo + hash de linha), parser por dialeto, processamento em lote de
  500 com máquina de estados, `ImportacaoLinhaErro` com valor mascarado
  (LGPD), 7 endpoints (`POST /`, `GET /`, `GET /:id`, `GET /:id/erros`,
  `GET /:id/original`, `POST /:id/reprocessar`, `POST /:id/cancelar`) e 3
  telas novas (histórico, detalhe, wizard de upload) via EntreGô 2.0.
- Migrations 0010-0017 (expand-only): `Entregador`, `ImportacaoArquivo`,
  `ImportacaoLinhaErro`, `FaturamentoLancamento`, `PerformanceTurno`, RLS
  por `id_empresa` nas 5 tabelas, seed de permissão `importacoes.exportar`.
- Pipeline SDD completo executado via `/feature-00c`: specify → clarify →
  plan → checklist → create-tasks → execute-task (FASES 0-7) →
  review-task. Relatório de review em
  `docs/specs/hub-importacoes/review-onda-011.md`. Entrada de fechamento no
  `docs/plans/hub-frota/DIARIO.md`.

## Testes (reexecutados na onda de review, com comando)

- Backend unit hub-importações (6 arquivos): `node --test` → **143/143**,
  39 suítes.
- Backend unit hub completo (`npm run test:hub:unit`): **210/210**, 59
  suítes.
- Frontend vitest (repo completo): **121/121**, 18 arquivos.
- `npx tsc --noEmit`: 0 erros.
- `npx eslint` (escopo importações): 0 erros.
- E2E contra `hub-homolog` persistente (FASE 7, não reexecutado nesta
  onda de review — evidência fresca de 2026-07-07 citada por completo):
  Cenários 1-11 do `quickstart.md` — happy path 20/20 válidas; dedupe =
  0 duplicatas em reimportação; falha estrutural (60% inválidas) →
  `failed` sem intervenção manual; reprocessar/cancelar com os 4 códigos
  HTTP esperados; gate de export 403/200 por papel; isolamento RLS 404
  cross-tenant; concorrência (2 uploads simultâneos, ambos `completed`);
  roundtrip real do contrato; branding dark/light preservado (4
  screenshots); 0 ocorrências de CPF/CNPJ formatado nos logs.

## Evidências

`docs/plans/hub-frota/evidencias/S4/` — migrations idempotentes, RLS (15
asserts PASS), seed de permissão, resultado consolidado dos Cenários 1-10,
prova de 0 vazamento LGPD, payload real de roundtrip, 4 screenshots de
branding dark/light.

## Blast radius

Toda escrita confinada a recursos `hub-*` (`hub-homolog`, containers
`hub_homolog_*`). **Zero escrita** no ambiente vivo do cliente
(`chatmasterveloz`, `envio-massa-homologacao_*`, `pgadmin_db`, Traefik/tags
de produção) — confirmado por `git diff --name-only` sem nenhum arquivo de
infraestrutura viva tocado. Isolamento multi-tenant (Constitution II,
NON-NEGOTIABLE) verificado via RLS real.

## O que este PR NÃO faz

- **Sem merge automático** — aguarda revisão do operador.
- **Sem deploy/cutover** — o gate G3 (cutover para produção) só ocorre no
  fechamento da S10 do plano mestre; até lá o ambiente vivo do cliente
  (produção) não é tocado.

## Test plan

- [ ] Operador revisa o diff (70 arquivos, migrations 0010-0017, 7
      endpoints, 3 telas).
- [ ] Operador confere `docs/specs/hub-importacoes/review-onda-011.md` e
      `docs/plans/hub-frota/DIARIO.md` (entrada S4).
- [ ] Operador decide sobre o follow-up não-bloqueante SC-005 (gravação
      fim-a-fim da jornada só pela UI).
- [ ] Merge fica a critério do operador; deploy/cutover só na S10 (G3).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
