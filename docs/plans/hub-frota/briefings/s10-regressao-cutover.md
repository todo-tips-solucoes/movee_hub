# Briefing S10 — Regressão geral + preparação de cutover

**Fase:** S10 · **Branch:** `feat/hub-regressao-cutover` · **Pré-requisito:** S2–S9
mergeadas e verdes na homolog isolada. **Esta fase não deploya nada em produção** — ela
prepara e ensaia; o cutover (G3) é executado **pelo operador** sob o rito dos 5 gates.

## Contexto mínimo (autossuficiente)

- Hub completo rodando no ambiente isolado (VPS Hub): shell + auth/RBAC + importações +
  motoristas + faturamento + performance + envio em massa re-hospedado + auditoria/admin.
- Produção (VPSTodo): serviços `envio-massa-homologacao_*`, banco `chatmasterveloz`
  (postgres:13, volume `pgadmin_pg_data`), imagens atuais anotáveis via
  `docker service ls`. Deploy de produção = `docker service update --with-registry-auth
  --image <tag> <serviço>` (**nunca** `docker stack deploy`). DDL manual + reload do
  PostgREST (`SIGUSR1`).
- Migrations do hub: série única `app_homologacao/backend/db/011+`, expand-only,
  idempotentes, já aplicadas na homolog isolada.
- ⚠️ Cláusula pétrea: o agente não executa nada no VPSTodo; entrega runbook/comandos e
  analisa saídas coladas pelo operador.
- Referências: plano técnico §15 (implantação futura), §16.1 (evidências S10), §17
  (aceite), §4.10 (migrations seguras); `docs/RITO-PRODUCAO.md`.

## Objetivo

Provar que o hub está pronto: suíte de regressão completa, migrations ensaiadas em cópia
anonimizada, teste de carga e **runbook de cutover com rollback ensaiado**.

## Escopo

**Inclui**
1. **Suíte de regressão completa** no ambiente isolado: todos os unit/integração/E2E das
   fases S2–S9 numa execução única e verde (CI ou script agregador), incluindo o E2E do
   envio em massa (S8) e a idempotência de importações (S4).
2. **Ensaio de migrations em cópia anonimizada:** gerar (com o gen-seeds da S1 ou dump
   anonimizado equivalente) um banco com volume realista (≥ 1 ano sintético: ~1,5 M
   lançamentos + ~1 M turnos) → aplicar 011+ do zero → medir tempo/locks por migration →
   registrar no runbook.
3. **Teste de carga básico:** telas/endpoints principais com o dataset acima (p95 das
   listas < 1 s; importação de arquivo diário < 60 s; registrar números reais).
4. **Runbook de cutover (`docs/plans/hub-frota/RUNBOOK-CUTOVER.md`)** com: pré-checagens;
   backup completo (`pg_dump -Fc` de `chatmasterveloz`) + validação do backup; janela;
   sequência exata de comandos (migrations 011+ → reload PostgREST → `service update`
   das imagens do hub com tags fixas → smoke: `/login` 200, login real, fluxo mínimo);
   critérios go/no-go por passo; **rollback encadeado ensaiado** (tags anteriores
   anotadas + restore testado + ordem reversa); checklist dos 5 gates do
   `docs/RITO-PRODUCAO.md`; papéis (tudo executado pelo operador).
5. **Ensaio do rollback em homolog:** executar o rollback de verdade no ambiente isolado
   (voltar imagem + restore) e anexar evidência.
6. Plano de observação pós-cutover (o que monitorar nas primeiras 24 h; como decidir
   rollback).

**Não inclui:** o cutover em si; qualquer comando no VPSTodo; mudanças funcionais (bug
achado na regressão → registrar; se pequeno, corrigir com PR próprio referenciado; se
grande, devolver ao operador).

## Ordem

suíte agregada → cópia anonimizada volumosa → ensaio de migrations (medições) → carga →
runbook → ensaio de rollback → evidências → PR.

## Testes exigidos

A própria fase é o teste: suíte completa + migrations ensaiadas + carga + rollback
ensaiado. Critério duro: **zero testes vermelhos e zero flakies não explicados**.

## Evidências

Saída da suíte completa; tabela tempo/locks por migration; números de carga (p95);
runbook revisado; log do ensaio de rollback (antes/depois).

## Critérios de aceite

1. Suíte 100% verde em execução única; 2. migrations aplicam do zero em banco volumoso
com tempos registrados e sem lock disruptivo; 3. reimportação idempotente re-comprovada
no dataset volumoso; 4. runbook completo com rollback ENSAIADO (não teórico); 5. checklist
dos 5 gates preenchível pelo operador; 6. PR + DIARIO.md; 7. G3 fica pronto para
agendamento pelo operador.

## Gotchas

- O ensaio usa SEMPRE dados anonimizados — nunca dump bruto de produção (LGPD).
- Tags de imagem do cutover são fixas e anotadas no runbook (nunca `latest`); anotar
  também as tags ATUAIS de produção antes (rollback).
- `docker service update` preserva env/labels; `stack deploy` os destruiria — o runbook
  só usa `service update`.
- Backend legado continua node:14 em produção até este cutover; o hub sobe em node:20 —
  o runbook deve listar as DUAS imagens novas (backend hub, frontend hub) e as antigas.
