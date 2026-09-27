# Runbook de deploy — repasse-saldo-minimo (F1+F2+F3, PR único, deploy único)

Feature: [`repasse-saldo-minimo`](../../specs/repasse-saldo-minimo/spec.md)
(`docs/specs/repasse-saldo-minimo/tasks.md`, FASES 1–3). **Decisão do operador
(2026-09-27, block-010/dec-093)**: as três fases (identificador do motorista, papel
aprovador + trava, saldo mínimo carregado) vão num **PR único** e um **deploy único**,
numa janela única — não em três branches/PRs/deploys separados como o `plan.md`
original previa. Este runbook **substitui** `RUNBOOK-DEPLOY-F1.md`,
`RUNBOOK-DEPLOY-F2.md` e `RUNBOOK-DEPLOY-F3.md`, que ficam como **histórico** (banner
no topo de cada um, conteúdo técnico preservado — "o que muda" de cada fase, achados de
revisão adversarial, evidências). A execução em produção é **sempre do operador**, ou do
agente só com autorização explícita **por passo** (uma etapa não autoriza a seguinte),
sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge clientes
> reais (`app.moveelog.com.br` e `app.motorista.moveelog.com.br`). As tabelas do hub em
> produção vivem **dentro do `chatmasterveloz`** (container `pgadmin_db`) — as três
> migrations deste runbook rodam no banco de produção, não num ambiente isolado `hub-*`.

## Por que um PR/deploy só (motivação registrada, block-010)

A branch `feat/repasse-saldo-minimo` sempre teve as três fases juntas, sem commits
intermediários, com arquivos compartilhados entre fases (`routes/hub-adiantamentos.js`,
`repasse/page.tsx`, `lib/adiantamento-remanescente.js`). Uma imagem de backend única lê
colunas que só a `0098` cria (`hub-adiantamentos.js:1766`, `POST
/repasse/:periodo/movimentos`; `repasse_valor_minimo` em `PUT /configuracoes`) — subir
essa imagem sem a `0098` (como os runbooks por fase mandavam) quebraria essas rotas. As
três fases já foram testadas juntas (integração 46/46 + 42/42, E2E 139/139, unit
1648/1648 — ver "Gates" abaixo) e o botão "Fechar apuração" já está segurado em
produção até este deploy (pré-condição 6 abaixo). Contra a decisão: a troca de quem
aprova pagamento (F2) e a regra de dinheiro (F3) vão juntas, então qualquer rollback
parcial não é trivial — tratado na seção "Rollback" abaixo.

## O que muda (as três fases, resumo)

- **Identificador do motorista** (F1, sem DDL): `GET /repasse` e `GET /repasse/exportar`
  passam a resolver `Entregador.id_externo` e devolver `idExterno`; tela ganha coluna
  "Identificador"; CSV ganha `Identificador` como **primeira** coluna.
- **Papel aprovador + trava** (F2, migration `0097`): `adiantamentos.pagamento_confirmar`
  sai de `financeiro`/`admin_entidade` e passa a existir só em `admin_plataforma` e no
  papel novo `financeiro_aprovador`; papéis restritos (`admin_plataforma`,
  `financeiro_aprovador`) só podem ser concedidos/alterados/desativados por
  `admin_plataforma` (RLS de `UsuarioEntidade` + checagem Node cross-empresa em
  `PUT /usuarios/:id`, ver `contracts/hub-usuarios-trava.md`); `REVOKE INSERT, UPDATE`
  na matriz RBAC para `authenticated`.
- **Saldo mínimo carregado** (F3, migrations `0098`+`0099`): colunas novas em
  `ApuracaoRepasseItem`/`AdiantamentoConfiguracao`/`ApuracaoRepasse`; 4 RPCs recriadas
  (`DROP FUNCTION`+`CREATE`: `hub_adiantamento_repasse`,
  `hub_adiantamento_repasse_congelado`, `hub_adiantamento_repasse_motorista`,
  `hub_adiantamento_repasse_motorista_ultimo_fechado`) + 2 reescritas (`CREATE OR
  REPLACE`: `hub_adiantamento_repasse_fechar`, `hub_adiantamento_configuracao_salvar`);
  backend com os campos novos (`saldoAnterior`, `aPagar`, `transportado`, `retido`,
  `previsaoTotal`, `abaixoDoMinimo`, `repasseValorMinimo`); CSV ganha 3 colunas no fim;
  UI hub e app motorista com as colunas/avisos novos; o termo "Retido" sai de toda UI
  visível ("Passou para a próxima semana: R$ X,XX" no card da semana fechada retida,
  sem data — texto aprovado pelo operador, block-007/dec-047).
- **`0099`** (correção de defeito pré-existente da `0092`, não pedida por nenhum FR desta
  spec — ver `tasks.md` 4.6): `ApuracaoRepasseMovimento` tinha `ENABLE RLS` +
  `GRANT INSERT` **sem policy de INSERT** desde a `0092` (já em produção). Sem a policy,
  todo `POST /repasse/:periodo/movimentos` que gera pelo menos uma nota falha no INSERT
  da trilha, deixando a nota **órfã** e abrindo caminho para duplicação numa nova
  tentativa (a dedup lê a trilha que nunca foi gravada). Precisa entrar **antes do
  primeiro "Gerar notas"** em produção — o defeito é da `0092`, então já existe hoje,
  mas só se manifesta quando alguém de fato gera uma nota.
- **CSV final** (F1+F3 combinados): `Identificador,Entregador,Créditos,Adiantamentos,
  Débitos,Remanescente,Saldo anterior,A pagar,Passou para a próxima semana` — 4 colunas
  novas em relação ao CSV anterior a esta feature. Avisar o financeiro (pré-condição 5).

## Gates do rito do ciclo git (antes do PR — CLAUDE.md "Rito do ciclo git")

| Gate | Comando | Resultado | Onda |
|---|---|---|---|
| Unit completo (backend) | `npm test` | **1648 PASS / 0 FAIL** (re-medido nesta onda, pós-4.1/4.2/4.4/4.5) | onda-026 |
| Types (`tsc --noEmit`, frontend_v2 e frontend_motorista) | `npx tsc --noEmit` | 0 erros nos dois | onda-016 |
| `npx vitest run` completo (frontend_v2) | `npm test` | 778/778 pass (86 arquivos) | onda-016 |
| `npm test` completo (frontend_motorista) | `npm test` | 105/105 pass | onda-016 |
| `next build` (frontend_v2 e frontend_motorista) | `npm run build` | sucesso, 0 erros nos dois | onda-016 |
| Lint vs. baseline (frontend_v2) | `npm run lint` | 5 erros/23 warnings pré-existentes (arquivos não tocados) + 1 warning pré-existente (mesma linha da `main`) — **0 novo** | onda-016 |
| Lint (frontend_motorista) | `npm run lint` | sem `eslint.config.js` — gap pré-existente em `main`, fora do escopo | onda-016 |
| Integração `npm run test:hub:integration` (14 arquivos, regressão geral) | `node --test tests/<arquivo>.test.js` um a um | 14/14 arquivos PASS, 0 fail | onda-019 |
| Integração RBAC (`financeiro_aprovador`, trava cross-tenant) | `hub-financeiro-aprovador-rbac-integration.sh` | **42 PASS / 0 FAIL** (reproduzido, ephemeral fresh do zero até `0099`) | onda-026 |
| Integração roundtrip (F1+F3, GET/fechar/movimentos/motorista) | `hub-repasse-saldo-minimo-roundtrip-integration.sh` | **46 PASS / 0 FAIL** (reproduzido, ephemeral fresh do zero até `0099`) | onda-026 |
| Controle negativo (furo, antes/depois 0097) | `hub-financeiro-aprovador-furo.sh` | furo demonstrado ANTES da 0097 (HTTP 201/409 "passa"), bloqueado DEPOIS (HTTP 4xx) | onda-020 |
| E2E hub (`npm run test:e2e:hub`, regressão geral + F3.12) | `hub-shell-e2e-browser.sh` | 139/139 | onda-024 |
| Revisão adversarial (F2, 3 pontos de escrita + REVOKE + USING) | subagente independente | `clean` após correção (ver `RUNBOOK-DEPLOY-F2.md` histórico) | onda-021/022 |

Frontends não mudaram desde a onda-016 (confirmado em `tasks.md` 4.3: só
`routes/hub-usuarios.js`, `lib/hub-rbac-cache.js` (onda-022) e `package.json`
(onda-023) mudaram depois — todos backend), por isso só o `npm test` do backend foi
re-medido nesta onda; os demais números seguem válidos.

## Validação da ordem de deploy em `hub-test-*` efêmero (obrigatória antes do PR)

Medida nesta onda (onda-026, 2026-09-27) — os dois drivers de integração acima já
recriam um projeto `hub-test-*` **do zero** (`docker compose up` + `migrate.sh` roda a
série completa de migrations em ordem, ou seja: estado equivalente a `main` migrada até
`0096`, depois `0097` → `0098` → `0099` em sequência) e sobem o **backend real da
branch** (`docker build -f Dockerfile.hub`, mesmo Dockerfile de produção). Isso já
valida a pergunta "a ordem 0097→0098→0099 aplicada do zero, com o backend novo, deixa
alguma rota quebrada no meio do caminho?" — resposta: não, nos dois drivers rodados
frescos:

- `hub-financeiro-aprovador-rbac-integration.sh`: **42 PASS / 0 FAIL** — cobre
  `PUT /usuarios/:id` (a trava, inclusive cross-tenant) e as 4 rotas de aprovação.
- `hub-repasse-saldo-minimo-roundtrip-integration.sh`: **46 PASS / 0 FAIL** — cobre
  `GET /repasse`, `POST /repasse/:periodo/fechar`, `POST /repasse/:periodo/movimentos`
  ("gerar notas"), `GET /motorista/repasse`, CSV com `Identificador`.

Não há indisponibilidade parcial observável entre os passos: como os dois drivers
constroem o ambiente do zero e só então testam contra o estado final (`0099` aplicada),
eles não distinguem "durante" de "depois" da migration — a garantia real de que a
janela de manutenção evita indisponibilidade parcial vem de rodar as 3 migrations em
sequência **antes** de trocar qualquer imagem (ordem abaixo), nunca intercalando.

## Pré-condições operacionais (confirmar com o operador ANTES do deploy)

1. **CHK021 — `JWT_SECRET` ≠ `PGRST_JWT_SECRET` em produção**, sem expor os valores:
   ```
   docker exec <container-backend> sh -c 'echo -n "$JWT_SECRET" | sha256sum'
   docker exec <container-postgrest-ou-pgadmin_db> sh -c 'echo -n "$PGRST_JWT_SECRET" | sha256sum'
   ```
   Os dois hashes devem ser **diferentes** — se iguais, a defesa RLS de
   `UsuarioEntidade` está comprometida; parar e escalar antes de aplicar `0097`.
2. **CHK022 — o único `admin_plataforma` atual é quem deveria ser**:
   ```sql
   SELECT u.email FROM "UsuarioEntidade" ue JOIN "Usuario" u ON u.id=ue.usuario_id
   JOIN "Papel" p ON p.id=ue.papel_id WHERE p.nome='admin_plataforma' AND ue.ativo;
   ```
   Se houver mais de uma pessoa ou alguém inesperado, resolver ANTES do deploy — essa
   pessoa passa a ser a ÚNICA que pode conceder papel restrito.
3. **Quem recebe `financeiro_aprovador` no go-live**: o operador decide quem, hoje
   `financeiro`/`admin_entidade`, deve continuar aprovando pagamento/fechamento — essa
   pessoa precisa de um vínculo com `financeiro_aprovador` concedido pelo
   `admin_plataforma` **logo após** o deploy (a concessão só funciona depois que `0097`
   cria o papel — ver passo 5 da ordem de deploy).
4. **CHK023 — as pessoas que perdem `adiantamentos.pagamento_confirmar` foram
   avisadas.** Quem hoje é `financeiro`/`admin_entidade` e usa essa permissão recebe 403
   nas 4 rotas de aprovação a partir do deploy, até ganhar `financeiro_aprovador` (passo
   3 acima). Avisar antes — não depois de alguém tentar fechar a apuração e falhar.
5. **Avisar o financeiro da mudança de cabeçalho do CSV** — 4 colunas novas de uma vez
   (`Identificador` no início, 3 no fim). Quem consome por posição precisa ajustar antes
   do deploy.
6. **"Fechar apuração" segurado em produção até este deploy** — nenhuma apuração pode
   ser fechada com o código antigo enquanto a regra do saldo mínimo não estiver no ar
   (medido: 0 apurações fechadas em produção desde que a regra existe).
7. **Nenhum "Gerar notas" (`POST /repasse/:periodo/movimentos`) antes da `0099` estar
   aplicada** — como as três migrations rodam na mesma janela, isso é automático desde
   que a ordem abaixo seja seguida à risca (nunca aplicar `0097`+`0098` numa janela e
   `0099` depois).
8. **0 lote pendente e fora da janela de fechamento**: nenhuma apuração sendo fechada
   nem lote de pagamento em processamento no momento do deploy —
   `SELECT * FROM "AdiantamentoLote" WHERE status IN ('EXPORTADO');` vazio.
9. Texto do aviso no app do motorista já aprovado (block-007/dec-047, 2026-09-26) — sem
   pendência.

## Estado medido em produção (2026-09-27, leitura só, pelo operador)

| Item | Resultado |
|---|---|
| Pré-condição 2 — `admin_plataforma` | 1 pessoa, empresa 6, confirmada pelo operador ✔ |
| Pré-condição 3 — quem recebe `financeiro_aprovador` | a conta `financeiro` da empresa 6 (decisão do operador) |
| Pré-condição 4 — quem perde `pagamento_confirmar` | 9 vínculos (`admin_entidade` das empresas 1–8 + `financeiro` da 6); **na prática só os 2 da empresa 6**, único escopo com o módulo `adiantamentos` ativo |
| Pré-condição 6 — apurações fechadas | 0 ✔ |
| Pré-condição 7 — `ApuracaoRepasseMovimento` | 0 linhas — o defeito da `0092` ainda não produziu nota órfã ✔ |
| Pré-condição 8 — lotes `GERANDO`/`GERADO`/`EXPORTADO` | nenhum ✔ |
| Objetos de 0090–0096 | todos presentes (incl. `hub_adiantamento_repasse_fechar` na versão da `0092` e `salvar` na da `0091`) ✔ |
| Objetos de 0097–0099 | nenhum ainda ✔ |
| Pré-condição 1 — hashes dos segredos JWT | **pendente** |

⚠️ **`SchemaMigration` para em `0089`** (23/09): as migrations 0090–0096 foram aplicadas
fora do `migrate.sh`, mas os objetos estão lá (tabela acima). Consequência: **NUNCA
rodar `infra/hub/scripts/migrate.sh` em produção** nesta janela — ele tentaria reaplicar
0090–0096. Aplicar `0097`, `0098` e `0099` **arquivo a arquivo**, como abaixo.

## Ordem de deploy

0. **Backup antes de qualquer escrita** (a `0097` apaga linhas de `PapelPermissao`; a
   `0098` altera `AdiantamentoConfiguracao`):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"Papel\"" -t "\"PapelPermissao\"" -t "\"UsuarioEntidade\"" -t "\"AdiantamentoConfiguracao\"" -t "\"ApuracaoRepasse\"" -t "\"ApuracaoRepasseItem\"" -t "\"ApuracaoRepasseMovimento\"" --data-only' \
     > ~/repasse-saldo-minimo-antes-deploy.sql && ls -l ~/repasse-saldo-minimo-antes-deploy.sql
   ```
   Anotar as imagens em produção (rollback): backend e `frontend_motorista`
   `esqueci-senha-3244051`, `frontend_v2` `email-editavel-ecab730` — reconferir com
   `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'`.

1. **Migration `0097_papel_financeiro_aprovador.sql`** (papel + trava de banco):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
     < infra/hub/migrations/0097_papel_financeiro_aprovador.sql
   docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0097_papel_financeiro_aprovador.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
   ```
2. **Migration `0098_repasse_saldo_minimo.sql`** (colunas + 4 RPCs recriadas + 2
   reescritas):
   ```
   docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
     < infra/hub/migrations/0098_repasse_saldo_minimo.sql
   docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0098_repasse_saldo_minimo.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
   ```
3. **Migration `0099_apuracaorepassemovimento_insert_policy.sql`** (policy de INSERT
   que faltava desde a `0092`):
   ```
   docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
     < infra/hub/migrations/0099_apuracaorepassemovimento_insert_policy.sql
   docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0099_apuracaorepassemovimento_insert_policy.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
   ```
4. **`SIGUSR1` no PostgREST de produção** (⚠️ há DOIS PostgREST no host — o de produção
   é o `pgadmin_postgrest`, nunca o do hub isolado):
   ```
   docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
   ```
5. **Provar colunas/permissões/policy** (`SchemaMigration` pode mentir se algum comando
   acima não passou por aqui — nunca confiar só no registro):
   ```sql
   -- 0097: papel + permissão movida
   SELECT nome, escopo FROM "Papel" WHERE nome = 'financeiro_aprovador';
   SELECT p.nome FROM "PapelPermissao" pp
     JOIN "Papel" p ON p.id = pp.papel_id
     JOIN "Permissao" perm ON perm.id = pp.permissao_id
    WHERE perm.codigo = 'adiantamentos.pagamento_confirmar';
   -- esperado: só admin_plataforma e financeiro_aprovador na lista acima

   -- 0098: colunas novas + RPCs recriadas
   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ApuracaoRepasseItem' AND column_name IN
    ('saldo_anterior','valor_pago','valor_transportado');
   SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'AdiantamentoConfiguracao' AND column_name = 'repasse_valor_minimo';
   SELECT proname FROM pg_proc WHERE proname IN
    ('hub_adiantamento_repasse','hub_adiantamento_repasse_congelado',
     'hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_motorista_ultimo_fechado');

   -- 0099: policy de INSERT existe
   SELECT polname, polcmd FROM pg_policy
    WHERE polrelid = '"ApuracaoRepasseMovimento"'::regclass
      AND polname = 'apuracaorepassemovimento_insert_por_escopo';
   ```
6. **Backend** (imagem única com as três fases):
   ```
   docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:saldo-minimo-9ccfa96 envio-massa-homologacao_backend_homologacao
   ```
7. **`frontend_v2`**:
   ```
   docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:saldo-minimo-9ccfa96 envio-massa-homologacao_frontend_v2_homologacao
   ```
8. **`frontend_motorista`**:
   ```
   docker service update --with-registry-auth --image registry.todo-tips.com/app-motorista-frontend:saldo-minimo-9ccfa96 envio-massa-homologacao_frontend_motorista_homologacao
   ```
9. **Imediatamente após** — conceder `financeiro_aprovador` à pessoa decidida na
   pré-condição 3 (pela tela de Usuários, logado como o `admin_plataforma` único).

Nenhuma migration/imagem sobe fora dessa ordem — em particular, nunca subir o backend
ANTES das três migrations (ele lê colunas/RPCs que só existem depois da `0098`, e o
INSERT de trilha só funciona depois da `0099`).

## Plano de rollback (ordem inversa)

1. **Antes de aplicar qualquer coisa**: `pg_dump -t` das tabelas afetadas (dado
   financeiro + RBAC, para poder auditar o que mudou se algo der errado):
   ```
   (feito no passo 0 da ordem de deploy — `~/repasse-saldo-minimo-antes-deploy.sql`)
   ```
2. **Rollback de imagem** (se o problema for só numa imagem): anotar a imagem anterior
   ANTES de atualizar — `docker service ls --filter name=envio-massa-homologacao_
   --format '{{.Name}}\t{{.Image}}'` — e `docker service update --with-registry-auth
   --image <anterior> <serviço>` para o(s) serviço(s) afetado(s), na ordem inversa do
   deploy: `frontend_motorista` → `frontend_v2` → `backend`.
3. **Rollback de banco** (só se o problema exigir reverter schema — ordem SEMPRE
   inversa da aplicação, `0099` → `0098` → `0097`):
   - **`0099`**: não há `0099-rollback.sql` dedicado (correção pequena, sem teste de
     rollback próprio) — reverter com:
     ```sql
     DROP POLICY IF EXISTS apuracaorepassemovimento_insert_por_escopo ON "ApuracaoRepasseMovimento";
     ```
     ⚠️ Remover a policy **volta a quebrar a geração de notas** (o defeito original da
     `0092`) — só reverter isto isoladamente se a causa do incidente for comprovadamente
     esta policy, nunca por precaução.
   - **`0098`**: `infra/hub/testes/sql/0098-rollback.sql` — volta os 4 corpos de função
     vigentes antes da `0098` e remove as colunas novas. ⚠️ **Recusa** (mensagem clara)
     se existir apuração pós-`0098` com `valor_transportado > 0` — não dá para reverter
     sem perder o saldo devido ao motorista; decisão humana, não automática.
   - **`0097`**: `infra/hub/testes/sql/0097-rollback.sql` — remove o papel
     `financeiro_aprovador`, devolve as policies ao corpo `0039`, devolve `GRANT INSERT,
     UPDATE` de `0003:58`. ⚠️ **Recusa** se existir vínculo ATIVO com
     `financeiro_aprovador` — desativar/trocar esses vínculos antes (decisão humana).
   - Se reverter `0098`, avaliar se `0099` deve ser revertida junto (a policy de INSERT
     não depende de nenhuma coluna da `0098` — pode ficar mesmo revertendo `0098`,
     recomendado manter para não reabrir o defeito da `0092`).
4. Depois de qualquer rollback de SQL, repetir o `SIGUSR1` no `pgadmin_postgrest`.
5. **Se o rollback de imagem for feito SEM rollback de banco**: a RLS/REVOKE de `0097` e
   a policy de `0099` continuam valendo (defesa em profundidade não quebra um backend
   antigo); mas um backend antigo lendo RPCs já recriadas pela `0098` pode quebrar —
   nesse caso, reverter banco e imagem juntos.

## Smoke test pós-deploy

1. **F1** — `GET /api/v1/adiantamentos/repasse?periodo=<semana atual>` autenticado:
   confirmar `idExterno` presente em cada item; coluna "Identificador" na tela; exportar
   o CSV e confirmar a primeira coluna.
2. **F2** — ⚠️ **NUNCA fechar uma semana real no smoke**: fechar é irreversível (a
   apuração congela) e a semana só pode ser fechada quando o operador decidir. Use
   **sempre a semana corrente, ainda em aberto**, que a regra de negócio recusa sem
   gravar nada:
   - `financeiro`/`admin_entidade` puro: `POST /repasse/<semana-corrente>/fechar
     {"confirmacao":true}` → esperado **403 PERMISSAO_NEGADA** (a permissão é checada
     antes da regra de negócio);
   - a pessoa com `financeiro_aprovador`: mesma chamada → esperado **409
     PERIODO_EM_ABERTO** (passou pela autorização e parou na regra — nunca 403, nunca
     2xx). Se vier 2xx, a semana foi fechada: parar e avisar o operador.
   Tela de Usuários: `admin_entidade` não vê `admin_plataforma`/`financeiro_aprovador` no
   seletor; `admin_plataforma` vê os dois. Auditoria: linha `usuario_vinculo_negado` se
   algum teste acima disparar a trava.
3. **F3** — `GET /repasse` confere `saldoAnterior`/`aPagar`; `GET /configuracoes`
   confere `repasseValorMinimo`; colunas "Saldo anterior"/"A pagar" na tela; badge
   "Passou para a próxima semana" em item retido (ou conferir no bundle servido);
   `GET /motorista/repasse` confere `abaixoDoMinimo`/`previsaoTotal`, sem a palavra
   "Retido" em nenhum texto visível.
4. **0099** — **não** testar "Gerar notas" em produção (exige apuração fechada, que não
   existe e não deve ser criada no smoke). A prova da `0099` é a do passo 5 da ordem de
   deploy (a policy de INSERT existe em `pg_policy`); o fluxo completo já foi provado em
   `hub-test-*` (roundtrip 46/0). O primeiro "Gerar notas" real acontece depois do
   primeiro fechamento decidido pelo operador — conferir então 1 linha em
   `ApuracaoRepasseMovimento` por motorista gerado.
5. Exportar o CSV e confirmar o cabeçalho final (4 colunas novas — ver "O que muda").
6. **Prova de bundle** (CLAUDE.md "Prova" — HTTP 200 não prova nada): buscar no bundle
   servido do `frontend_v2` a string "Identificador" (coluna nova de F1) e "Passou para
   a próxima semana" (rótulo de F3); no `frontend_motorista`, a mesma string — ⚠️ no bundle do app o
   acento vem escapado: procurar `Passou para a pr` (ou `pr\xf3xima`), não a forma
   acentuada, senão o grep dá falso negativo.

## Os 5 gates de produção

1. **Autorização explícita** do operador para este deploy específico.
2. **Janela combinada** — fora de qualquer fechamento de apuração em andamento
   (pré-condição 8) e depois de as pessoas afetadas (CHK023) terem sido avisadas.
3. **Plano de rollback** — seção acima, com `pg_dump -t` feito ANTES de aplicar.
4. **Aplicar**: `docker service update --with-registry-auth --image ...`. **Nunca**
   `docker stack deploy`.
5. **Smoke test** — seção acima, antes de declarar OK.

## Referências

- [spec.md](../../specs/repasse-saldo-minimo/spec.md)
- [plan.md](../../specs/repasse-saldo-minimo/plan.md)
- [contracts/hub-repasse-api.md](../../specs/repasse-saldo-minimo/contracts/hub-repasse-api.md)
- [contracts/hub-usuarios-trava.md](../../specs/repasse-saldo-minimo/contracts/hub-usuarios-trava.md)
- [quickstart.md](../../specs/repasse-saldo-minimo/quickstart.md)
- [checklists/security.md](../../specs/repasse-saldo-minimo/checklists/security.md) — CHK021/CHK022/CHK023
- [checklists/integridade-financeira.md](../../specs/repasse-saldo-minimo/checklists/integridade-financeira.md)
- [tasks.md](../../specs/repasse-saldo-minimo/tasks.md) FASES 1–4
- Histórico (não seguir como runbook): [RUNBOOK-DEPLOY-F1.md](RUNBOOK-DEPLOY-F1.md),
  [RUNBOOK-DEPLOY-F2.md](RUNBOOK-DEPLOY-F2.md), [RUNBOOK-DEPLOY-F3.md](RUNBOOK-DEPLOY-F3.md)
