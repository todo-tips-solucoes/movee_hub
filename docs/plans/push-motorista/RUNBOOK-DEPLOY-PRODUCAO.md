# Runbook de deploy — `push-motorista` (avisos por Web Push)

Preparado em 2026-09-13 (onda-031), revisado pela sessão pai no mesmo dia
(backup de `Auditoria` só do esquema, prova de bundle por chunk estático, chave
em arquivo próprio de produção, janela do robô EntreGô, plano de disco) e
**executado em produção em 2026-09-13** — ver "Execução" logo abaixo. Base: a
`main` já mergeada (PR #178, squash `f10f5d4`). A execução é do operador, ou do
agente só com autorização explícita **por passo** (uma etapa não autoriza a
seguinte), sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge
> clientes reais (`app.moveelog.com.br`, `app.motorista.moveelog.com.br`).

## Execução — 2026-09-13 (domingo, ~15h10–15h55)

Autorizada pelo operador em etapas, com janela imediata, depois do import das
14h do robô EntreGô. Os comandos usados são os desta página, empacotados em
scripts com as mesmas conferências.

| Passo | Quem | Resultado medido |
|---|---|---|
| Limpeza de disco | agente (autorizada) | 20,08 → 23,6 GB livres; só containers parados e tags antigas sem uso; imagens de rollback intactas |
| Builds | agente | backend `2b33a8d275dd` (node v20.20.2), frontend_v2 `0b2b48c1a4a6`, app motorista `0063dde7e168`; estágios sem tag removidos depois de cada build |
| Chave VAPID | operador | `vapid.producao.json` 0600, keyId `7a7b92da080faa40`; 0 ocorrências da chave privada fora do arquivo |
| Backup | operador | dados de RBAC (4 tabelas) e só o esquema da `Auditoria`, em `/root/backup-pre-006*-202609131512.sql` |
| Migrations | operador | 0061–0065 com `psql -1` e `lock_timeout 5s`; `SchemaMigration` 61 → 66 |
| PostgREST | operador | 41 → 46 Relations, 44 → 57 Functions; prova no banco: 5 tabelas, 11 funções, módulo e policy ok |
| Push das imagens | operador | digests `sha256:2b33a8d2…`, `sha256:0b2b48c1…`, `sha256:0063dde7…` |
| Backend | operador | convergiu; boot com 0 `PUSH_INDISPONIVEL` e 0 `AUDITORIA_PERDIDA`; chave ativa registrada e auditada |
| frontend_v2 e app motorista | operador | convergiram; `BACKEND_URL` de produção preservado |
| Smoke e prova do bundle | operador | hub 200, app 200, rotas novas 401 sem login; chunks com `avisos/cobertura` e `push/chave-publica`; `/sw.js` com `notificationclick` |
| Aviso de teste (11.4.4) | operador | 1 entrega `aceito`; notificação recebida com o app fechado e o toque abriu o aviso |

Molde reusado de
[`docs/plans/hub-motorista-360/RUNBOOK-DEPLOY.md`](../hub-motorista-360/RUNBOOK-DEPLOY.md)
(estrutura de seções) e
[`docs/plans/hub-enriquecimento-automatico/RUNBOOK-MIGRATION-0060.md`](../hub-enriquecimento-automatico/RUNBOOK-MIGRATION-0060.md)
(padrão de aplicar migration em produção via `docker exec` + registro manual em
`SchemaMigration`, já que `infra/hub/scripts/migrate.sh` só orquestra os
ambientes isolados do hub, não o Swarm de produção).

---

## Execução — 2026-09-16 (madrugada, ~01h e ~11h30): limites + Scenario 21

Segunda entrega da frente, autorizada em etapas como a primeira. Base: `main`
`45059b9` (PR #179), longe das janelas do robô EntreGô (11h/13h/14h).

**Por que existiu**: com o push no ar desde 13/09, o operador tomou
"Limite de disparos atingido" sem ter chegado a 10 envios. O culpado não era o
balde de disparo e sim o de **consulta** — a prévia de alcance recalcula a cada
troca de destinatário e a busca de motorista consulta enquanto se digita, ~2 a 4
consultas por aviso; com teto 10, o bloqueio chegava no 3º/4º aviso. Os dois
baldes devolviam o mesmo `LIMITE_EXCEDIDO` e a tela mostrava uma única mensagem,
que falava só em disparo. Correção: disparo 10 → **30/15 min**, consulta
10 → **120/15 min**, mensagem da tela citando as duas causas.

| Passo | Quem | Resultado medido |
|---|---|---|
| Gates | agente | backend 1106/1106, vitest 598/598 em 70 arquivos, `tsc` 0 erros, eslint rc=0, 66 arquivos de teste registrados |
| Build | agente | backend `6c9b94a2e9bf` (node v20.20.2) com `max: 30`/`max: 120` dentro da imagem; frontend_v2 `737b916f1f23`; disco 23 GB antes, 22,5 GB depois |
| Push das imagens | agente | `sha256:6c9b94a2e9bf…`, `sha256:737b916f1f23…` |
| Backend | operador | convergiu 1/1; 0 `PUSH_INDISPONIVEL`, 0 `AUDITORIA_PERDIDA`; as 5 linhas "error" do boot eram o SIGTERM do container substituído |
| frontend_v2 | operador | convergiu 1/1 |
| Smoke + prova | operador | hub 200, app 200, `/api/v1/avisos` 401; chunk `0g-fen9m6a0e9.js` servido por produção com a frase nova; `grep` na imagem no ar: `max: 120` (l.194), `max: 30` (l.211) |

Imagens no ar: `limites-avisos-45059b9` no backend e no frontend_v2; **o app
motorista continua em `avisos-push-f10f5d4`** (a mudança não o toca). Rollback
dos dois: `avisos-push-f10f5d4`, só `--image` — o mount da chave VAPID e o
`VAPID_KEYS_FILE` seguem no serviço desde 13/09 e não devem ser removidos.

### Scenario 21 (SC-003) — executado às 11h39 de 2026-09-16

⚠️ **A adoção mudou a natureza do teste.** Medição antes de disparar: **121
inscrições ativas de 115 contas distintas** (111 Android, 6 iOS, 4 desktop; 115
FCM, 6 Apple; 5 contas com 2–3 aparelhos), todas na chave `7a7b92da080faa40`.
Um aviso `toda_base` alcançaria 121 aparelhos de motoristas reais — 10 avisos de
teste seriam 1.210 notificações para gente que não pediu. **Teste em produção é
sempre `individual`**, visando só a conta instalada no aparelho do operador.

Como foi feito: a tela cria um aviso por vez, então os 10 saíram por script
contra as mesmas rotas que ela usa (`POST /auth/login` → `POST /me/entidade` →
`GET /avisos/destinatarios/motoristas?busca=` para achar o id → 10 × `POST
/avisos` com `chaveIdempotencia` própria e 2 s de intervalo).

| Medida | Resultado |
|---|---|
| Avisos criados | 10/10 HTTP 201, `visados=1` cada, 0 falhas, 0 respostas 429 |
| Entregas | 10/10 `aceito`, todas `fcm.googleapis.com`, nenhum `motivo` de erro |
| Latência no servidor (criação → aceite) | mediana **0,1 s**, p95 **0,2 s**, máx **0,2 s** |
| Finalização do aviso | 10/10 `concluido` — nenhum preso em `em_andamento` (prova em produção da trava da `0065`) |
| Backend | 0 `PUSH_INDISPONIVEL`, 0 `AUDITORIA_PERDIDA`, 0 429 |
| Aparelho (Android, app fechado) | as 10 notificações chegaram na hora, cada uma com o próprio texto; o toque abriu o aviso certo |

Desvio declarado em relação ao roteiro do Scenario 21: **1 aparelho Android, 10
entregas**, não 2 aparelhos e 20 entregas — o iPhone não entrou nesta rodada. O
critério (≥95% das entregas aceitas em ≤1 min) fecha com 10/10; a validação em
iOS continua pendente, e com ela a observação de host de endpoint Apple em campo
(hoje só se sabe que 6 inscrições existem, não que uma entrega Apple foi aceita).

---

## 0. Quem executa cada passo

| Passo | Quem | Observação |
|---|---|---|
| §1 Pré-flight (disco/swap) | agente (leitura) | só leitura, sem gate |
| §2 Chave VAPID de produção | **operador** | gera o segredo; agente nunca gera nem lê a chave privada |
| §3 Migrations no `chatmasterveloz` | **operador** (ou agente com autorização explícita deste passo) | escrita no banco do cliente |
| §4 Build + push de imagem | **operador** (ou agente com autorização explícita deste passo) | gera artefato, ainda não é produção até o `service update` |
| §5 `docker service update` (mount/env/imagem) | **operador** | é o passo que efetivamente muda produção |
| §6 Smoke + prova de bundle | operador ou agente (leitura) | sem gate — não muda estado |
| §7 Aviso de teste (11.4.4) | **operador** | dispara notificação real para o aparelho dele |

Quando este roteiro foi escrito (onda-031), nenhum destes passos tinha sido
executado — o texto abaixo é o **plano**, no tempo verbal do plano. O que de fato
aconteceu está nas duas seções "Execução" no topo: 2026-09-13 (deploy inicial,
chave VAPID, migrations 0061–0065) e 2026-09-16 (limites + Scenario 21). Ao
reusar este runbook, confira contra aquelas seções o que já está feito — a
divisão de quem executa cada passo continua valendo.

---

## 1. Estado atual — rollback (levantado por leitura em 2026-09-13)

```
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}\t{{.Replicas}}'
```

| Serviço Swarm | Imagem no ar (= **rollback**) | Réplicas |
|---|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:hub-enriq-auto-3952eb3` | 1/1 |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:hub-sessao-0d1e7bc` | 1/1 |
| `envio-massa-homologacao_frontend_motorista_homologacao` | `registry.todo-tips.com/app-motorista-frontend:login-429-trustproxy` | 1/1 |

Confirmado por leitura: a imagem de backend no ar roda `node v20.20.2`
(`Dockerfile.hub`). **sha7 desta entrega**: `f10f5d4` → tags: `avisos-push-f10f5d4`.

⚠️ **Risco conferido por leitura (2026-09-13, `docker service ls` + `git show
eceab62`)**: o build do `frontend_motorista` a partir da `main` leva junto o
commit `eceab62` (PR #77, cortes de dependências mortas, 2 arquivos do app
motorista), posterior ao que está hoje em produção (`login-429-trustproxy`,
commit `0535325`) — **não é código desta feature**, mas entra no mesmo build
por vir da mesma `main`. Está declarado no corpo do PR #178.

Reconferir na hora (idêntico ao levantado acima):

```bash
cd /var/lib/envioMassa_homologacao
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'
docker run --rm registry.todo-tips.com/envio-massa-backend:hub-enriq-auto-3952eb3 node --version
```

---

## 2. Pré-flight — abortar se qualquer um falhar

Medido nesta onda (2026-09-13):

```
df -h /     → 150G total, 125G usado, 20G livres (87%)
free -h     → 15Gi RAM, 729Mi livre, 5.7Gi disponível (buff/cache)
swapon --show → /swapfile, 8G, 4.6G usado (58%), 3.4G livre
```

🔴 **20 GB livres é exatamente o piso do CLAUDE.md** ("abortar se houver
menos de ~20 GB livres") — não há folga. Cada build de frontend deixa
~1,8 GB de estágio sem tag e o backend ~0,7 GB (CLAUDE.md §Comandos); com 3
imagens para buildar (backend + frontend_v2 + frontend_motorista) o
consumo transiente pode chegar a **~4,3 GB**, o que projeta o disco para
**~15,7 GB livres durante o build** — abaixo do piso.

**Ação obrigatória antes de buildar**: com 20 GB, o primeiro build já leva o
disco abaixo do piso — **liberar espaço ANTES do primeiro build** e conferir
`df -h /` de novo imediatamente antes de cada build individual. As duas
opções abaixo exigem autorização do operador (limpeza nunca por impulso):

```bash
# Opção A (mínima): só imagens SEM TAG, uma a uma, conferindo a config de cada
# — inclui o estágio de build (~1,8 GB) que cada build de frontend deixa.
docker images -f dangling=true --format '{{.ID}} {{.Size}} {{.CreatedSince}}'
docker image inspect -f '{{.Config.WorkingDir}} {{json .Config.Cmd}} {{.Created}}' <id>
docker rmi <id>              # sem -f: recusa imagem em uso
# remover uma imagem sem tag pode expor a imagem-mãe da cadeia do builder
# legado (DOCKER_BUILDKIT=0) — repetir a listagem até a cadeia acabar

# Opção B (CLAUDE.md, emergência de disco): tudo que não tem tag + cache
docker builder prune -f      # só cache de build — seguro e reversível
docker image prune -f        # SEM -a — só imagens sem tag
```

Nunca `docker system prune -a` (apagaria as imagens de rollback) nem
`--volumes` (destruiria `envio_massa_hub_uploads`).

RAM: 729 Mi livre é pouco, mas 5,7 GB "disponível" (buff/cache reclamável)
dá folga — ainda assim, **seguir a lição de 2026-06-11**: não rodar os 3
builds em paralelo, e usar `--memory=2g` em cada `docker build` (nunca
builds concorrentes disputando RAM com o Swarm de produção).

---

## 3. Chave VAPID de produção (operador — NÃO executado nesta onda)

```bash
infra/hub/scripts/gen-vapid.sh --subject https://app.moveelog.com.br \
  --gerado-por "<nome do operador>" \
  --dest /var/lib/hub_secrets/vapid.producao.json
# 0600, nome explícito no mesmo padrão de vapid.dev/test/homolog.json —
# NUNCA reaproveitar a chave de teste ou de homolog
ls -l /var/lib/hub_secrets/vapid.producao.json   # conferir -rw------- root
```

A saída não pode trazer a chave privada — só metadados.

Mesmo padrão de mount do `compose.hub.homolog.yml` (`VAPID_KEYS_FILE` +
bind read-only mesmo path host/container) — em produção, sem
`docker-compose`, o mount é adicionado ao serviço Swarm via
`--mount-add` no `service update` do backend (§5.1).

---

## 4. Migrations no `chatmasterveloz` (0061–0065)

⚠️ Nota: `tasks.md` 11.4.1 lista "0061/0062/0063/0064" — o backlog está
desatualizado; **0065** (`push_registrar_resultado_lock_aviso.sql`, fix de
corrida na finalização do Aviso) foi mergeado no mesmo commit `f10f5d4` e
faz parte desta entrega. As 5 migrations abaixo são as que existem em
`infra/hub/migrations/` para esta feature.

Container do banco é uma task do Swarm (nome muda a cada reagendamento) —
resolver sempre por `docker ps -qf name=pgadmin_db`. Idem para o PostgREST
(`name=pgadmin_postgrest` — **não** usar só `name=postgrest`: o
`hub_homolog_postgrest` do ambiente isolado do hub casaria também).

⚠️ Heredoc colado no terminal colapsa (lição de 2026-08-18) — os comandos
abaixo aplicam por caminho de arquivo, nunca por heredoc colado.

⚠️ O agente **não executa** nada neste banco — o classificador bloqueia
`pgadmin_db` até em leitura. Cole cada comando com `!`.

### 4.1 Backup antes da DDL (tabelas pré-existentes tocadas)

- `0061`/`0064`/`0065`: só criam tabelas/funções novas — **nenhuma tabela
  pré-existente é tocada**, sem dump necessário.
- `0062` (seed de RBAC): insere em `Modulo`, `Permissao`, `PapelPermissao`,
  `ModuloEntidade` — todas pré-existentes.
- `0063` (policy de `Auditoria`): troca só a definição da policy
  `auditoria_insert_por_escopo` — DDL puro, **sem escrita de dados**. NÃO
  fazer dump dos DADOS de `Auditoria`: a tabela guarda 12 meses de trilha e
  pode ter muitos GB, com o disco já no piso. Basta o dump do **esquema**
  (inclui a policy atual); o SQL de rollback da policy também está em §4.5.

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"Modulo\"" -t "\"Permissao\"" -t "\"PapelPermissao\"" -t "\"ModuloEntidade\"" --data-only' > ~/backup-pre-0062-$(date +%Y%m%d%H%M).sql; wc -l ~/backup-pre-0062-*.sql
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"Auditoria\"" --schema-only' > ~/backup-pre-0063-schema-$(date +%Y%m%d%H%M).sql; grep -c 'auditoria_insert_por_escopo' ~/backup-pre-0063-schema-*.sql
```

Confira `df -h /` antes, que o dump dos dados **não saiu vazio** e que o do
esquema contém a policy (contagem ≥ 1) antes de seguir.

### 4.2 Aplicar as 5 migrations, nesta ordem

Idempotentes (`CREATE TABLE/POLICY/FUNCTION IF NOT EXISTS`/`OR REPLACE`,
`INSERT ... ON CONFLICT DO NOTHING`, `DROP POLICY IF EXISTS` seguido de
`CREATE POLICY`). Não têm `BEGIN`/`COMMIT` nem `CONCURRENTLY`, então cada uma
roda numa **transação única** (`psql -1`, como o `migrate.sh`). O
`lock_timeout 5s` faz a migration falhar rápido, com a transação desfeita, se
alguma transação longa segurar uma tabela tocada (a `0063` recria a policy da
`Auditoria`) — em vez de enfileirar e travar os logins. Para no primeiro erro:

```
! cd /var/lib/envioMassa_homologacao && CID=$(docker ps -qf name=pgadmin_db | head -1) && for f in infra/hub/migrations/006[1-5]_*.sql; do echo "== $f"; { echo "SET lock_timeout = '5s';"; cat "$f"; } | docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1 -1 -q' || break; done
```

**Registrar em `SchemaMigration`** — a tabela tem sequence, **nunca informe
`id`** (lição do #154: aplicar fora do `migrate.sh` faz a `SchemaMigration`
mentir):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
INSERT INTO \"SchemaMigration\" (nome) VALUES
  ('"'"'0061_push_avisos.sql'"'"'),
  ('"'"'0062_modulo_avisos.sql'"'"'),
  ('"'"'0063_auditoria_push_worker.sql'"'"'),
  ('"'"'0064_push_registrar_resultado_finaliza_aviso.sql'"'"'),
  ('"'"'0065_push_registrar_resultado_lock_aviso.sql'"'"')
ON CONFLICT (nome) DO NOTHING;"'
```

### 4.3 Recarregar o PostgREST e provar pela contagem de funções

```
! docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
```

🔴 **Sonda HTTP em `/rpc/` NÃO prova o reload** — a prova é a contagem de
funções no log:

```
! docker logs --tail 5 $(docker ps -qf name=pgadmin_postgrest | head -1)
```

### 4.4 Provar no banco antes de tocar nos serviços

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F"|" -c "
SELECT '\''tabelas'\'', count(*) FROM information_schema.tables WHERE table_name IN ('\''Aviso'\'', '\''AvisoEntrega'\'', '\''PushInscricao'\'', '\''PushEstadoAtivacao'\'', '\''PushChaveVapid'\'');
SELECT '\''funcoes hub_push_*/hub_aviso_*'\'', count(*) FROM pg_proc WHERE proname LIKE '\''hub_push_%'\'' OR proname LIKE '\''hub_aviso_%'\'';
SELECT '\''modulo avisos'\'', count(*) FROM \"Modulo\" WHERE codigo='\''avisos'\'';
SELECT '\''modulo avisos habilitado p/ empresa 6'\'', count(*) FROM \"ModuloEntidade\" me JOIN \"Modulo\" m ON m.id=me.modulo_id WHERE m.codigo='\''avisos'\'' AND me.empresa_id=6 AND me.ativo;"'
```

Esperado: `tabelas|5`, `funcoes|11`, `modulo avisos|1`,
`modulo avisos habilitado p/ empresa 6|1`.

### 4.5 Rollback (só se necessário, ordem inversa 0065→0061)

```sql
-- 0065/0064 → repor hub_push_registrar_resultado como estava em 0061 (SEM
-- a checagem de finalização nem o PERFORM ... FOR UPDATE):
CREATE OR REPLACE FUNCTION hub_push_registrar_resultado(
    p_entrega_id bigint, p_lease_token uuid, p_status text,
    p_motivo text, p_tentativas smallint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_aplicado boolean := false; v_inscricao_id int;
BEGIN
    IF NOT hub_jwt_push_worker() THEN RAISE EXCEPTION 'CLAIM_HUB_PUSH_WORKER_AUSENTE'; END IF;
    UPDATE "AvisoEntrega" SET status=p_status, motivo=p_motivo, tentativas=p_tentativas, atualizado_em=now()
    WHERE id=p_entrega_id AND status='processando' AND lease_token=p_lease_token
    RETURNING inscricao_id INTO v_inscricao_id;
    IF FOUND THEN
        v_aplicado := true;
        IF p_status='morta' AND v_inscricao_id IS NOT NULL THEN DELETE FROM "PushInscricao" WHERE id=v_inscricao_id; END IF;
    END IF;
    RETURN v_aplicado;
END; $$;

-- 0063 → repor a policy original de 0009 (sem o 3º ramo do push-worker):
DROP POLICY IF EXISTS auditoria_insert_por_escopo ON "Auditoria";
CREATE POLICY auditoria_insert_por_escopo ON "Auditoria"
    FOR INSERT
    WITH CHECK (
        (id_empresa IS NULL AND acao IN ('login_sucesso','login_falha','logout','recuperacao_senha_solicitada','senha_redefinida'))
        OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
    );

-- 0062 → desfazer o seed (idempotente, sem afetar outros módulos):
DELETE FROM "ModuloEntidade" WHERE modulo_id = (SELECT id FROM "Modulo" WHERE codigo='avisos');
DELETE FROM "PapelPermissao" WHERE permissao_id IN (SELECT id FROM "Permissao" WHERE codigo IN ('avisos.consultar','avisos.enviar'));
DELETE FROM "Permissao" WHERE codigo IN ('avisos.consultar','avisos.enviar');
DELETE FROM "Modulo" WHERE codigo='avisos';

-- 0061 → apagar tudo que criou (CASCADE cobre policies/índices dependentes):
DROP TABLE IF EXISTS "AvisoEntrega" CASCADE;
DROP TABLE IF EXISTS "Aviso" CASCADE;
DROP TABLE IF EXISTS "PushInscricao" CASCADE;
DROP TABLE IF EXISTS "PushEstadoAtivacao" CASCADE;
DROP TABLE IF EXISTS "PushChaveVapid" CASCADE;
DROP FUNCTION IF EXISTS hub_push_inscricao_registrar, hub_push_inscricao_revogar,
    hub_push_estado_reportar, hub_aviso_para_motorista, hub_aviso_alcance,
    hub_aviso_criar, hub_aviso_resumo, hub_push_cobertura, hub_push_reivindicar,
    hub_push_registrar_resultado, hub_push_expurgo CASCADE;
DROP FUNCTION IF EXISTS hub_jwt_push_worker, hub_jwt_motorista_cnpj CASCADE;

DELETE FROM "SchemaMigration" WHERE nome IN (
  '0061_push_avisos.sql','0062_modulo_avisos.sql','0063_auditoria_push_worker.sql',
  '0064_push_registrar_resultado_finaliza_aviso.sql','0065_push_registrar_resultado_lock_aviso.sql'
);
```

⚠️ Rollback do **backend** (mount/env da chave) vem **antes** do rollback do
banco, se o backend novo já estiver no ar — senão o worker perde as tabelas
no meio da operação.

---

## 5. Variáveis de ambiente novas do backend (só NOMES — sem valores)

Comparação: nomes hoje no serviço de produção vs. nomes que o código lê
(`process.env.VAPID_KEYS_FILE`, `lib/hub-push-worker.js:227`;
`process.env.PUSH_HOSTS_PERMITIDOS`, `lib/hub-push-endpoint.js`):

```bash
docker service inspect envio-massa-homologacao_backend_homologacao \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  | awk -F'=' '{print $1}' | sort
```

Nomes atuais (2026-09-13, leitura): `APP_ENV`, `FASTAPI_VALIDATION_TOKEN`,
`GRUPO_PROPRIETARIO`, `HUB_UPLOADS_DIR`, `JWT_REFRESH_SECRET`, `JWT_SECRET`,
`N8N_API_TOKEN`, `NODE_ENV`, `PGRST_JWT_SECRET`, `POSTGREST_API_KEY`,
`POSTGREST_URL`.

| Nome novo | Obrigatório em produção? |
|---|---|
| `VAPID_KEYS_FILE` | **Sim** — sem ela a rota responde 503 `PUSH_INDISPONIVEL` (fail-closed, não derruba o boot) |
| `PUSH_HOSTS_PERMITIDOS` | **Não** — só tem efeito quando `ENVIO_ALLOWLIST` também está definida (`lib/hub-push-endpoint.js`), e produção nunca define `ENVIO_ALLOWLIST`/`ENVIO_DRY_RUN` (CLAUDE.md/compose: "produção NUNCA define estas vars"). O default embutido (`ALLOWLIST_PADRAO`: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) já cobre Android/iOS/desktop |

`frontend_motorista`: **nenhuma env nova precisa ser adicionada** — o
`ARG BACKEND_URL` do Dockerfile (default
`http://backend_homologacao:3000`) é sobreposto em runtime pela `ENV
BACKEND_URL` já configurada no serviço Swarm
(`https://envmassapihomologacao.todo-tips.com`, confirmado por leitura) —
o próprio comentário do Dockerfile documenta essa precedência. A chave
pública VAPID **não** é inlinada em build: o app busca em runtime via
`GET /motorista/push/chave-publica` (`lib/push.ts:192/220`), autenticado.

---

## 6. Build — a partir da `main` já mergeada, tag `avisos-push-f10f5d4`

```bash
cd /var/lib/envioMassa_homologacao
git rev-parse --abbrev-ref HEAD   # tem que dar main
git rev-parse --short HEAD        # tem que dar f10f5d4 (se a main andou, parar e reavaliar)
df -h /                           # reconferir ANTES de cada build (§2)
```

### 6.1 Backend — `Dockerfile.hub`, nunca o `Dockerfile` (node:14, derruba o runtime)

```bash
cd app_homologacao/backend
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub \
  -t registry.todo-tips.com/envio-massa-backend:avisos-push-f10f5d4 .
docker run --rm registry.todo-tips.com/envio-massa-backend:avisos-push-f10f5d4 node --version
# esperado: v20.x — se vier v14, Dockerfile errado, NÃO prossiga
df -h /
```

### 6.2 Frontend v2

```bash
cd ../frontend_v2
grep -n 'ENV BACKEND_URL' Dockerfile     # confirmar envmassapihomologacao (já hardcoded)
DOCKER_BUILDKIT=0 docker build --memory=2g \
  -t registry.todo-tips.com/envio-massa-frontend-v2:avisos-push-f10f5d4 .
df -h /
```

### 6.3 Frontend motorista

```bash
cd ../frontend_motorista
DOCKER_BUILDKIT=0 docker build --memory=2g \
  -t registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4 .
df -h /
```

⚠️ Item de risco (tasks.md 11.3.3): esta imagem inclui o commit `eceab62`
(PR #77), ainda não deployado — registrar isso no PR/relatório do deploy;
não é código desta feature, mas vem junto por vir da mesma `main`.

### 6.4 Push (anotar os digests)

```bash
docker push registry.todo-tips.com/envio-massa-backend:avisos-push-f10f5d4
docker push registry.todo-tips.com/envio-massa-frontend-v2:avisos-push-f10f5d4
docker push registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4
```

---

## 7. Deploy — `service update`, nunca `stack deploy`

Ordem: **banco (§4) → backend com mount+env da chave → frontend_v2 →
frontend_motorista**. O backend precisa subir primeiro porque é ele quem
registra a chave VAPID em `PushChaveVapid` no boot.

⚠️ **Janela**: combinar com o operador (gate 2) e **não reiniciar o backend
perto das janelas de importação do robô EntreGô (11h, 13h e 14h,
America/Sao_Paulo)** — o robô chama o backend nesses horários.

### 7.1 Backend — adiciona o bind mount da chave + a env, no MESMO comando da imagem

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:avisos-push-f10f5d4 \
  --mount-add type=bind,source=/var/lib/hub_secrets/vapid.producao.json,target=/var/lib/hub_secrets/vapid.producao.json,readonly \
  --env-add VAPID_KEYS_FILE=/var/lib/hub_secrets/vapid.producao.json \
  envio-massa-homologacao_backend_homologacao
```

`--mount-add`/`--env-add` são aditivos — preservam o mount de volume
existente (`envio_massa_hub_uploads` → `/data/hub-uploads`) e as demais
envs já configuradas.

### 7.2 Frontend v2 e frontend motorista

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:avisos-push-f10f5d4 \
  envio-massa-homologacao_frontend_v2_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4 \
  envio-massa-homologacao_frontend_motorista_homologacao
```

⚠️ `frontend_v2` é `stop-first` com 1 réplica: há downtime curto.

### Rollback (por serviço, imagens de §1)

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-enriq-auto-3952eb3 \
  --mount-rm /var/lib/hub_secrets/vapid.producao.json \
  --env-rm VAPID_KEYS_FILE \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-sessao-0d1e7bc \
  envio-massa-homologacao_frontend_v2_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:login-429-trustproxy \
  envio-massa-homologacao_frontend_motorista_homologacao
```

O rollback de imagem **não** exige desfazer as migrations (aditivas e
idempotentes) — as tabelas/colunas novas simplesmente ficam sem consumidor.

---

## 8. Smoke + prova de bundle

```bash
# 8.1 smoke HTTP (sem expor segredo)
curl -s -o /dev/null -w '%{http_code}\n' https://app.moveelog.com.br/hub/login
curl -s -o /dev/null -w '%{http_code}\n' https://app.motorista.moveelog.com.br/
# rota nova do backend: SEM auth prova só que a rota EXISTE (esta rota exige
# authenticateMotorista — 401 é o esperado, não 200; ver §9)
curl -s -o /dev/null -w '%{http_code}\n' https://envmassapihomologacao.todo-tips.com/motorista/push/chave-publica
# esperado: 401 — 404 significa código antigo
```

```bash
# 8.2 PROVA DO BUNDLE — strings ASCII que só existem a partir de f10f5d4
# (conferido: 0 ocorrências em 649a44b). HTTP 200 não prova o código certo, e
# texto com acento pode sair escapado no chunk minificado — por isso ASCII.
#
# frontend_v2: /hub/dashboard/avisos exige login, então a prova é pelo chunk
# estático. Achar o chunk DENTRO da imagem nova e buscá-lo servido por produção
# (o nome do chunk tem hash: só é servido se o build novo estiver no ar).
F=$(docker run --rm --entrypoint sh registry.todo-tips.com/envio-massa-frontend-v2:avisos-push-f10f5d4 \
  -c "grep -rlF 'avisos/cobertura' /app/.next/static/chunks | head -1 | sed 's#^/app/.next/static#/_next/static#'")
echo "$F"
curl -s "https://app.moveelog.com.br$F" | grep -cF 'avisos/cobertura'
# esperado: >= 1

# frontend_motorista: service worker gerado em public/sw.js (serwist swDest)
curl -s https://app.motorista.moveelog.com.br/sw.js | grep -c 'notificationclick'
# esperado: >= 1 (0 no sw.ts anterior)
F=$(docker run --rm --entrypoint sh registry.todo-tips.com/app-motorista-frontend:avisos-push-f10f5d4 \
  -c "grep -rlF 'push/chave-publica' /app/.next/static/chunks | head -1 | sed 's#^/app/.next/static#/_next/static#'")
echo "$F"
curl -s "https://app.motorista.moveelog.com.br$F" | grep -cF 'push/chave-publica'
# esperado: >= 1
```

```bash
# 8.3 chave VAPID mostrando no banco — prova ponta a ponta do mount + boot
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -c "SELECT key_id, ativada_em FROM \"PushChaveVapid\" ORDER BY ativada_em DESC LIMIT 1;"'
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -c "SELECT acao, criado_em FROM \"Auditoria\" WHERE acao='"'"'push_chave_registrada'"'"' ORDER BY criado_em DESC LIMIT 1;"'
```

Esperado: 1 linha em cada — confirma que o backend carregou o arquivo
(`hub-push-worker.js#registrarChaveVapid`, disparado automaticamente no
boot por `POSTGREST_URL` já estar setada) e que a policy 0063 aceitou o
INSERT de auditoria global do worker.

---

## 9. Pós-deploy (11.4.4) — 1 aviso de teste para o aparelho do operador

Segue [`RUNBOOK-VALIDACAO-APARELHO-REAL.md`](./RUNBOOK-VALIDACAO-APARELHO-REAL.md)
passos 1–4 (instalar PWA, login, ativar notificações, fechar o app), mas
**com N=1** em vez dos 20 avisos do Scenario 21 completo, e usando
diretamente `https://app.motorista.moveelog.com.br` (já em produção — não
há decisão de origem HTTPS a tomar aqui, essa parte do runbook citado não
se aplica): o operador dispara **1 aviso `individual`** pelo hub visando
sua própria conta de motorista de teste e confirma o recebimento no
próprio aparelho — nunca `toda_base`.

---

## 10. O que NÃO vai neste deploy

- A validação completa do Scenario 21 (SC-003, 20 avisos em 2 aparelhos
  reais) — segue runbook próprio, execução separada do operador.
- Qualquer ajuste de `ALLOWLIST_PADRAO`/`PUSH_HOSTS_PERMITIDOS` a partir dos
  hosts de endpoint observados em campo — decisão pós-validação real.
- Retenção/expurgo além do já implementado (`hub_push_expurgo`, 90 dias,
  FR-030) — nenhuma política nova.
