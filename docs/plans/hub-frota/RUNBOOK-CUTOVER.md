# RUNBOOK — Cutover do Hub de Frota para produção (G3)

**Status:** pronto para agendamento pelo operador (S10).
**Executor de TODOS os comandos deste runbook: o operador.** O agente entrega
este artefato e analisa saídas coladas; nunca executa escrita no ambiente vivo
(`docs/RITO-PRODUCAO.md` — cláusula pétrea; os 5 gates estão no checklist do
§10). O ambiente chamado "homologação" (`envio-massa-homologacao_*`,
`chatmasterveloz`) **é produção**.

Números de ensaio citados: `docs/plans/hub-frota/evidencias/S10/`
(ensaio de migrations, teste de carga e ensaio de rollback da S10).

---

## 1. O que este cutover muda (e o que não muda)

| Componente | Hoje (anotado em 2026-07-10) | Depois do cutover |
|---|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:upload-motorista-paginacao` (node:14, Dockerfile legado) | imagem nova `envio-massa-backend:hub-g3-1` (node:20, **Dockerfile.hub**, mesmo server.js + rotas `/api/v1/*` do hub) |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:motoristas-filtros` | imagem nova `envio-massa-frontend-v2:hub-g3-1` (inclui as telas `/hub/*`) |
| Banco `chatmasterveloz` (container `pgadmin_db`, postgres:13, volume `pgadmin_pg_data`) | schema legado | + tabelas do hub (migrations `infra/hub/migrations/` — série 0000–0046, **expand-only**; ver mapa §5) |
| PostgREST de produção (`pgadmin_postgrest`, postgrest/postgrest:v14.1) | serve o legado | mesmo serviço; recebe SIGUSR1 (reload de schema) após as migrations |
| **Não muda** | `frontend_homologacao` (painel legado), `frontend_motorista_homologacao` (app motorista), FastAPIs, Traefik, n8n | intocados |

- **Tags de imagem SEMPRE fixas** — definidas pelo operador em 2026-07-11:
  `hub-g3-1` (nunca `latest`). Digests no registry:
  backend `sha256:28031a356d36a0dd…` · frontend-v2 `sha256:2bf6d23ec1d49c56…`.
  As tags ATUAIS acima são o alvo do rollback — reconfirmar com
  `docker service ls` no início da janela (§7 P0).
- Deploy **somente** com `docker service update --with-registry-auth --image …`.
  **Nunca** `docker stack deploy` (destruiria env/labels/segredos).
- Nada é excluído no cutover: expand-only; *contract* é fase futura.

## 2. Pré-requisitos go/no-go (antes de agendar a janela)

| # | Pré-requisito | Dono | Status ao escrever |
|---|---|---|---|
| 1 | **Issue #62** (gate `ENVIO_DRY_RUN`/allowlist não lidos por `sendMessage`/`validate-xml-batch` no legado) resolvida e deployada, **ou** aceite de risco formal do operador | operador | **RESOLVIDA** (lib/envio-gate.js + URLs de env com fallback; E2E asserta o bloqueio com linha elegível). ⚠️ Em produção **NÃO** setar `ENVIO_DRY_RUN`/`ENVIO_ALLOWLIST` no serviço — sem env, o gate é inerte e o comportamento é o histórico |
| 2 | **Decisão D5** — retenção/expurgo da trilha de `Auditoria` | operador | **DECIDIDA E IMPLEMENTADA** (2026-07-10): retenção de **12 meses** + expurgo **mensal** — migration 0041 (`hub_auditoria_expurgo()`, imutabilidade preservada, meta-evento global por expurgo); homolog agendado pelo backup-daemon; produção = cron mensal do operador PÓS-cutover (§11) |
| 3 | PR da S10 revisado e mergeado; suíte de regressão 100% verde em execução única | operador | evidência em `evidencias/S10/` |
| 4 | Ensaio de migrations (do zero + sob ~2,5M linhas, sem lock disruptivo) e ensaio de rollback anexados | sessão S10 | evidência em `evidencias/S10/` |
| 5 | Auditoria do **schema real de produção** aprovada (§3) | operador + sessão | **EXECUTADA 2026-07-10** (dump read-only autorizado): `valida-schema-prod.sh` PASS em todos os itens, 0 avisos; fingerprints JWT idênticos; re-rodar na véspera imediata da janela |
| 6 | Segredos do hub para produção definidos (§6): `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PGRST_JWT_SECRET` (= `POSTGREST_API_KEY` de produção), volume de uploads | operador | conferir |
| 7 | Imagens novas buildadas e no registry com tag fixa (§4) | operador | **FEITO 2026-07-11**: `hub-g3-1` no registry (digests no §1), sob rito anti-starvation com produção monitorada |
| 8 | Backup validado (§7 P1) | operador | dentro da janela |
| 9 | Aposentadoria futura das flags `HUB_RBAC_ENVIO`/`HUB_IMPORT_LOG_ENVIO` registrada como pendência pós-cutover (§9) | operador | registrada |

## 3. Pré-checagem: auditoria do schema real de produção

As séries de DDL anteriores ao hub foram aplicadas manualmente em
`chatmasterveloz` ao longo dos anos — podem divergir do baseline do ambiente
isolado. **O operador gera e cola o schema; a sessão valida** (nenhum dado,
só DDL):

```bash
# operador, no VPSTodo (READ-ONLY):
docker exec $(docker ps -qf name=pgadmin_db) \
  pg_dump -U <user> -d chatmasterveloz --schema-only > /tmp/schema-prod.sql
# colar/inspecionar com a sessão — NUNCA commitar (contém nomes de objetos internos)
```

Objetos que a série 0000–0046 **pressupõe** existir (checklist de validação;
a 0046, se aplicada, presupõe a `"EnvioMassa"` legada — já presente por definição):

- [ ] Tabela `"Empresa"` com colunas `id`, `email`, `pass`, `nome_empresa`,
      `cnpj`, `id_grupo` (0008 lê `email`/`pass`/`nome_empresa` para migrar
      logins; o adaptador de claims do envio em massa lê `id`/`id_grupo`).
- [ ] Tabela `"Grupo"` (`id`, `nome`, `id_empresa_pai`, `login_unico_ativo`).
- [ ] Tabela `"EnvioMassa"` com as colunas do SELECT de `/export-envio-massa`
      (server.js:1903) — o hub não a altera, mas o backend novo continua a usá-la.
- [ ] Tabelas `"ProcessControl"` e `"Motorista"` (`cnpj_prestador` UNIQUE).
- [ ] Role `authenticated` existente e usado pelo PostgREST de produção
      (as migrations fazem `GRANT ... TO authenticated`; se o role tiver outro
      nome em produção, PARAR e devolver — exigiria adaptação da série).
- [ ] `PGRST_JWT_SECRET` do `pgadmin_postgrest` = `POSTGREST_API_KEY` do
      backend (achado da S8: em produção os dois carregam o mesmo valor —
      reconfirmar sem expor o valor, por fingerprint sha256).
- [ ] Postgres 13.x e PostgREST v14.1 (paridade com o ambiente do ensaio).
- [ ] Extensões `unaccent` e `pg_trgm`: ou AUSENTES (a 0021 as cria em
      `public`) ou já instaladas NO SCHEMA `public` — se existirem em outro
      schema, a 0040 (`public.unaccent`) falharia em runtime; PARAR e adaptar.
- [ ] **Não** existir nenhuma tabela do hub (`"Usuario"`, `"SchemaMigration"`,
      `"Entregador"`, …) — se existir, investigar antes (aplicação parcial
      anterior?).

Qualquer divergência ⇒ **no-go** até resolvida.

## 4. Build das imagens (fora da janela — não é escrita em produção)

No VPSTodo, **sob rito anti-starvation** (swap 8G ativo; produção 4/4
monitorada; nunca `pkill` amplo):

```bash
cd /var/lib/envioMassa_homologacao   # working tree na main pós-merge da S10
# backend do hub (node:20, Dockerfile.hub)
DOCKER_BUILDKIT=0 docker build --memory=2g \
  -f app_homologacao/backend/Dockerfile.hub \
  -t registry.todo-tips.com/envio-massa-backend:hub-g3-1 \
  app_homologacao/backend
# frontend v2 com o hub — ⚠️ conferir ENV BACKEND_URL do Dockerfile (CLAUDE.md)
DOCKER_BUILDKIT=0 docker build --memory=2g \
  -t registry.todo-tips.com/envio-massa-frontend-v2:hub-g3-1 \
  app_homologacao/frontend_v2
docker push registry.todo-tips.com/envio-massa-backend:hub-g3-1
docker push registry.todo-tips.com/envio-massa-frontend-v2:hub-g3-1
```

A imagem só vira produção no `service update` (§7 P6/P7).

## 5. Mapa de aplicabilidade das migrations em produção

A série canônica é `infra/hub/migrations/0000–0046`, idempotente, expand-only,
validada 3× (banco vazio, homolog com dados, cópia sintética volumosa —
§4.10 do plano técnico; tempos medidos em `evidencias/S10/`). **Duas
migrations são exclusivas do ambiente isolado e NUNCA rodam em produção:**

> **Nota de escopo (2026-07-13):** as migrations **0042–0046** são da feature
> `hub-motorista-canonico` (PR #73, pós-S10 — mergeada na `main`, já aplicada e
> validada no `hub_homolog_db`, `SchemaMigration=47`). O G3 base foi planejado
> para a série 0000–0041; **incluir ou não a feature no MESMO cutover é decisão
> do operador**. Se o G3 for só do hub base, pré-registrar 0042–0046 como
> PULADAS (mesmo mecanismo de 0033/0034, §10) e aplicá-las num incremento
> posterior. Se entrarem no G3, seguir o mapa abaixo.

| Migration | Em produção | Motivo |
|---|---|---|
| 0000–0007, 0009–0032, 0035–0037, 0039–0041 | **aplicar** | schema/seed hub-nativo, não toca tabela legada (0022 cria `EmpresaGrupoMovee` VAZIA — o seed do grupo real é o P4; 0040 é a corretiva do ensaio de rollback: `hub_normaliza_nome` com `public.unaccent`; 0041 é a D5: `hub_auditoria_expurgo()` — a função só roda quando o cron do §11 for agendado) |
| 0008_migracao_empresa_para_usuario | **aplicar + conferir** | lê a `"Empresa"` REAL e cria os logins do hub (`Usuario`/`UsuarioEntidade`, papel `admin_entidade`, hash bcrypt copiado). Conferir contagens (§7 P3). Contas sem `pass` não migram (por design) |
| **0033_schema_legado_envio_massa** | **PULAR (pré-registro)** | recriaria espelho do schema legado: em produção as tabelas REAIS já existem; a migration ainda adicionaria constraints UNIQUE (`email`/`cnpj` em `"Empresa"`) e GRANTs — risco de falha por dados duplicados e mudança de permissão não planejada |
| **0034_seed_legado_envio_massa_teste** | **PULAR (pré-registro)** | inseriria empresas/movimentos QA na `"EnvioMassa"` REAL e motoristas de teste na base `"Motorista"` (exclusiva do grupo Movee — violaria a regra de domínio do CLAUDE.md) |
| 0038_seed_modulos_admin_qa | **aplicar + revisar** | habilita módulos `usuarios`/`auditoria` para toda entidade com vínculo ativo (desejado) **e** módulo `admin` para `empresa_id=9001` (QA do isolado; em produção vira linha órfã inócua — remover depois ou habilitar `admin` para a entidade correta via tela S9) |
| 0042_hub_entregadores_busca_rpc | **aplicar** | hub-nativo: índice trigram em `Entregador(nome)` + função `hub_entregadores_busca()` (`SECURITY INVOKER`, RLS do `Entregador`) para o combobox de entregador. Não toca legado |
| 0043_conta_motorista_senha | **aplicar** | hub-nativo: `ALTER "ContaMotorista" ADD senha text NULL` (aditivo/nullable). Só é lida quando o app motorista autentica contra `ContaMotorista` — em produção o serviço **não** define `HUB_MOTORISTA_LOGIN_CONTA_ATIVA`, então a coluna fica inerte até o cutover do app motorista |
| 0044_seed_permissao_motoristas_credencial | **aplicar** | hub-nativo: cria a permissão `motoristas.credencial` e a concede a `admin_plataforma`/`admin_entidade` (`ON CONFLICT DO NOTHING`, idempotente) |
| 0045_conta_motorista_token_reset | **aplicar** | hub-nativo: `ALTER "ContaMotorista" ADD token_reset_hash / token_reset_expira` (aditivo/nullable) para o reset de senha da credencial |
| **0046_envio_massa_entregador_uuid** | **DECISÃO do operador (toca legado)** | ÚNICA das 0042–0046 que altera a **`"EnvioMassa"` REAL**: `ADD entregador_uuid uuid NULL` + `CREATE INDEX` (não-concorrente) + `NOTIFY pgrst`. É expand-only e a coluna nasce toda NULL (o `CREATE INDEX` é praticamente instantâneo e o lock de escrita é momentâneo), mas por tocar tabela legada é ponto de decisão: **(a) aplicar** (baixo risco) **ou (b) PULAR via pré-registro** (§10) e adiar para o cutover do app motorista, já que a coluna só é gravada com `HUB_MOTORISTA_LOGIN_CONTA_ATIVA` setado (ausente em produção). Se aplicar sob carga alta, trocar por `CREATE INDEX CONCURRENTLY` fora de transação para não bloquear escrita |

Pós-migrations (seed operacional, parte do §7 P4): popular
`"EmpresaGrupoMovee"` com o grupo Movee real (`INSERT ... VALUES (6)` + filiais
futuras) — a 0022 cria a tabela vazia; o seed é por ambiente.

## 6. Configuração dos serviços (env vars novas do backend)

O backend novo (hub) exige env vars que o serviço atual não tem. Aplicar
**antes** do update de imagem (env update reinicia o serviço com a MESMA
imagem atual — inócuo, o legado ignora as vars novas):

```bash
docker service update \
  --env-add JWT_SECRET=<segredo-novo-forte> \
  --env-add JWT_REFRESH_SECRET=<segredo-novo-forte-2> \
  --env-add PGRST_JWT_SECRET=<MESMO valor do POSTGREST_API_KEY atual> \
  --env-add APP_ENV=producao \
  --env-add HUB_UPLOADS_DIR=/data/hub-uploads \
  --mount-add type=volume,source=envio_massa_hub_uploads,target=/data/hub-uploads \
  envio-massa-homologacao_backend_homologacao
```

- `POSTGREST_URL`/`POSTGREST_API_KEY` já existem no serviço (fluxo legado).
- O volume de uploads guarda os CSVs originais importados (dados pessoais —
  LGPD: fica em volume privado, nunca em git/logs).
- Flags da S8: **não setar** `HUB_RBAC_ENVIO`/`HUB_IMPORT_LOG_ENVIO`
  (ausente = comportamento ligado, o desejado). Aposentadoria: §9.
- Gate da issue #62: **não setar** `ENVIO_DRY_RUN`/`ENVIO_ALLOWLIST`/`N8N_URL`/
  `FASTAPI_URL`/`FASTAPI_NEXUS_URL` em produção — sem env, o gate é inerte e as
  URLs caem nos valores históricos (comportamento byte a byte idêntico).

## 7. Sequência da janela (cada passo com go/no-go)

> Interromper e avaliar rollback (§8) em QUALQUER no-go. Nunca improvisar
> passo fora deste runbook dentro da janela.

**P0 — Anotações prévias (READ-ONLY).**
`docker service ls` (colar saída; confirmar tags atuais = §1);
smoke baseline: `curl -s -o /dev/null -w '%{http_code}' https://app.moveelog.com.br/login` → 200;
contagens baseline no banco (colar):
`SELECT count(*) FROM "Empresa"; SELECT count(*) FROM "EnvioMassa";`
✅ go: tudo anotado. ❌ no-go: tag atual diverge do esperado → reavaliar.

**P1 — Backup completo + validação.**
```bash
DUMP=/backups/chatmasterveloz-pre-hub-$(date +%Y%m%dT%H%M).dump   # nome EXPLÍCITO — nunca validar por glob (casaria dump antigo de tentativa anterior)
docker exec $(docker ps -qf name=pgadmin_db) \
  pg_dump -U <user> -Fc chatmasterveloz > "$DUMP" \
  || { echo "pg_dump FALHOU — NO-GO"; }
test -s "$DUMP" || echo "dump vazio — NO-GO"
# valida o formato DENTRO do container (o host pode não ter client tools)
docker exec -i $(docker ps -qf name=pgadmin_db) pg_restore --list < "$DUMP" | head
```
Validação REAL (não só `--list`): restaurar num banco descartável `hub_*`
(mesmo desenho do ensaio de rollback da S10, `infra/hub/scripts/restore.sh`) e
comparar contagens de 3+ tabelas com o P0.
✅ go: restore de teste bate contagens. ❌ no-go: parar (sem backup válido não há cutover).

**P2 — Migrations (banco de produção).**
Pré-registrar as migrations PULADAS e aplicar a série pelo mesmo mecanismo do
`migrate.sh` (arquivo a arquivo, em ordem, `psql -1` + registro):

```bash
DB_CONT=$(docker ps -qf name=pgadmin_db)
docker exec -i $DB_CONT psql -U <user> -d chatmasterveloz -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS "SchemaMigration" (
  id serial PRIMARY KEY, nome text UNIQUE NOT NULL, aplicado_em timestamptz NOT NULL DEFAULT now());
INSERT INTO "SchemaMigration" (nome) VALUES
  ('0033_schema_legado_envio_massa.sql'),
  ('0034_seed_legado_envio_massa_teste.sql')
  -- ,('0046_envio_massa_entregador_uuid.sql')  -- DESCOMENTAR só se optar por ADIAR a 0046 (§5, opção b): pré-registra sem alterar a "EnvioMassa" legada
ON CONFLICT (nome) DO NOTHING;   -- PULADAS por decisão (§5) — nunca executam em produção
SQL

cd /var/lib/envioMassa_homologacao/infra/hub/migrations
ok=1
for f in $(ls *.sql | sort); do
  if docker exec $DB_CONT psql -U <user> -d chatmasterveloz -tAc \
       "SELECT 1 FROM \"SchemaMigration\" WHERE nome='$f'" | grep -q 1; then
    echo "pulada (já registrada): $f"; continue
  fi
  echo "aplicando: $f"
  docker exec -i $DB_CONT psql -U <user> -d chatmasterveloz -v ON_ERROR_STOP=1 -1 -f - < "$f" \
    || { echo "FALHOU em $f — PARAR (colar o erro para a sessão)"; ok=0; break; }
  docker exec $DB_CONT psql -U <user> -d chatmasterveloz -c \
    "INSERT INTO \"SchemaMigration\" (nome) VALUES ('$f') ON CONFLICT DO NOTHING"
done
# reload do PostgREST de produção SÓ com a série completa aplicada — recarregar
# com schema meio-aplicado exporia objetos parciais (sem GRANTs/policies das
# migrations seguintes) pela API viva enquanto o problema é diagnosticado
[ "$ok" = 1 ] && docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest) \
  || echo "SIGUSR1 NÃO enviado (série incompleta) — resolver a falha antes"
```

Tempo esperado: **ver a tabela real do ensaio**
(`evidencias/S10/ensaio-migrations-*/tabela-tempos-locks.md`) — série completa
em banco vazio na ordem de segundos; nenhuma migration segurou lock disruptivo
nem sob ~2,5M linhas. `ON_ERROR_STOP` + `-1` (transação por arquivo): falha em
um arquivo NÃO deixa migration meio-aplicada.
✅ go: série termina com todos os arquivos registrados. ❌ no-go: falha em
arquivo → colar o erro para a sessão; avaliar rollback §8 (o backup P1 cobre).

**P3 — Checagens pós-migration (colar saídas).**
```sql
SELECT count(*) FROM "SchemaMigration";                          -- = 47 se a feature 0042–0046 entrar no G3; = 42 se o G3 for só do hub base (0000–0041). Bater com o nº de arquivos aplicados+pré-registrados
SELECT count(*) FROM "Usuario";                                  -- ≈ nº de "Empresa" com pass definido (0008)
SELECT count(*) FROM "UsuarioEntidade" WHERE ativo;              -- ≥ count acima
SELECT rolname FROM pg_roles WHERE rolname IN ('hub_web_anon');  -- 1 linha
SELECT count(*) FROM "Papel"; SELECT count(*) FROM "Permissao";  -- seeds 0007+ (>0)
```
✅ go: contagens coerentes. ❌ no-go: 0 usuários migrados (nenhum login do hub
funcionaria) → investigar antes de trocar imagem.

**P4 — Seed operacional.**
```sql
INSERT INTO "EmpresaGrupoMovee" (id_empresa) VALUES (6) ON CONFLICT DO NOTHING;  -- grupo Movee real
```
Conferir módulos por entidade (`SELECT m.codigo, me.empresa_id FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id=me.modulo_id ORDER BY 2,1;`).
✅ go: Movee presente; módulos coerentes com o combinado.

**P5 — Env vars + volume no serviço backend** (§6). O serviço reinicia com a
imagem ATUAL (legada) — smoke do painel legado depois: `/login` → 200.
✅ go: serviço 1/1 e smoke 200.

**P6 — Deploy do backend do hub.**
```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-g3-1 \
  envio-massa-homologacao_backend_homologacao
docker service ps envio-massa-homologacao_backend_homologacao   # 1/1 Running
```
✅ go: 1/1, sem restart-loop nos primeiros 2 min.
❌ no-go: rollback imediato do backend (§8, 1 comando).

**P7 — Deploy do frontend v2 do hub.** Mesmo padrão com
`envio-massa-frontend-v2:hub-g3-1` no serviço
`envio-massa-homologacao_frontend_v2_homologacao`.

**P8 — Smoke (HTTP, sem expor segredos; colar saídas).**
1. Painel legado: `https://app.moveelog.com.br/login` → 200; login real de uma
   conta Empresa; tela de envio em massa lista movimentos reais (fluxo do
   cliente intacto — critério nº 1 do G3).
2. Hub: `https://app.moveelog.com.br/hub/login` → 200; login com uma conta
   migrada pela 0008 (mesma senha do painel legado); `GET /api/v1/me` → 200
   com entidades corretas; troca de entidade; dashboard renderiza; telas de
   Importações/Motoristas/Faturamento/Performance abrem **vazias por design**
   (a primeira importação é P9).
3. Auditoria (S9): o login acima aparece na trilha (`/hub/auditoria`).
4. App motorista: `https://app.motorista.moveelog.com.br` → 200 (não muda,
   mas confirma que o roteamento não foi afetado).
✅ go: tudo 200 e coerente. ❌ no-go: rollback §8.

**P9 — Primeira importação real de CSVs (passo explícito pós-smoke — LGPD).**
Responsável: **operador** (ou usuário de negócio designado por ele), logado no
hub com a conta da entidade correta. Importar o CSV diário de faturamento e o
de performance pela tela de Importações. É a **primeira entrada de dados
pessoais reais** nas tabelas do hub (`Entregador`/fatos) — até aqui os módulos
ficam vazios por design. Verificar: status `completed`, contagens na tela
batem com o arquivo, `/hub/dashboard/faturamento|performance` mostram números.
Referência de duração sob volume 25× maior: import diário completo em
`evidencias/S10/carga-*/relatorio.md` (< 60 s incluindo refresh das MVs).

**P10 — Janela de observação** (§11; primeiras 24h).

## 8. Rollback encadeado (ENSAIADO — não teórico)

Ensaio real executado no ambiente isolado em `evidencias/S10/rollback-*/`
(imagem revertida + restore validado, com contagens antes/depois). Ordem
REVERSA do deploy; cada nível é independente — usar o menor suficiente:

**Nível 1 — só imagens (config/DDL ficam; app antiga ignora tabelas novas —
compatibilidade N/N+1 garantida por expand-only):**
```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:motoristas-filtros \
  envio-massa-homologacao_frontend_v2_homologacao
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:upload-motorista-paginacao \
  envio-massa-homologacao_backend_homologacao
# smoke: /login → 200 + login real + envio em massa lista movimentos
```
(⚠️ reconfirmar essas tags no P0 — são as vigentes ao escrever este runbook.)

**Nível 2 — env vars adicionadas no P5** (opcional; inócuas para o legado):
`docker service update --env-rm JWT_SECRET --env-rm JWT_REFRESH_SECRET ... envio-massa-homologacao_backend_homologacao`

**Nível 3 — banco (só se corrupção comprovada; expand-only ⇒ quase nunca):**
restore do dump do P1 num banco de VALIDAÇÃO primeiro; só sobrescrever
`chatmasterveloz` com autorização explícita renovada do operador e o legado
parado. Alternativa preferível (dado que as tabelas do hub não interferem no
legado): deixar as tabelas novas dormentes e remover em fase futura.

**Critérios de decisão** (qualquer um ⇒ rollback do nível 1 imediato):
- smoke P8.1 falha (fluxo do cliente): rollback SEM debate;
- backend em restart-loop ou 5xx em série no painel legado;
- login legado quebrado para conta real.

## 9. Pendência pós-cutover — aposentadoria das flags da S8

**Dono: operador.** `HUB_RBAC_ENVIO` e `HUB_IMPORT_LOG_ENVIO` (flags
reversíveis da S8 para o RBAC do envio em massa e o histórico de importação)
ficam **não-setadas** no cutover (= ligadas). Após a janela de observação sem
regressão, aposentá-las = remover a leitura no código (feature pequena de
*contract*) e riscar dos `.env.example`. Registrado aqui como pendência de
contract pós-cutover; nenhuma ação na janela.

## 10. Checklist dos 5 gates (docs/RITO-PRODUCAO.md)

- [ ] **G1 Autorização explícita** do operador para ESTE cutover (data, escopo,
      tags nominais) — não vale autorização genérica/antiga.
- [ ] **G2 Janela combinada** (data/hora, duração, quem participa).
- [ ] **G3 Rollback à mão**: tags anteriores reconfirmadas no P0; dump P1
      validado por restore; comandos do §8 revisados.
- [ ] **G4 Aplicação por `docker service update --with-registry-auth --image`**
      (nunca `stack deploy`); DDL idempotente/aditiva com backup prévio.
- [ ] **G5 Smoke test** (§7 P8) antes de declarar OK.

**Papéis:** operador executa tudo; sessão (agente) analisa cada saída colada e
dá parecer go/no-go por passo; usuário de negócio (se designado) faz o P9.

## 11. Plano de observação pós-cutover (primeiras 24h)

O que monitorar (tudo READ-ONLY; operador executa e cola quando quiser parecer):

| Quando | O quê | Comando/onde | Limiar de alerta |
|---|---|---|---|
| a cada ~1h nas 4 primeiras horas; depois 3×/dia | Serviços 1/1 e sem restarts | `docker service ls` + `docker service ps <svc>` | qualquer réplica reiniciando em loop |
| idem | Erros no backend | `docker service logs --since 1h envio-massa-homologacao_backend_homologacao 2>&1 \| grep -ciE 'error\|unhandled'` | crescimento súbito vs. hora anterior |
| idem | Smoke dos 3 domínios | `curl -s -o /dev/null -w '%{http_code}' https://app.moveelog.com.br/login` (e `/hub/login`, app motorista) | ≠ 200 |
| 2×/dia | p95 percebido nas telas do hub | abrir dashboard faturamento/performance com janela de 30d | > 2–3 s percebidos (ensaio: p95 < 1 s sob 2,5M linhas) |
| 1×/dia | Crescimento da auditoria e do banco | `SELECT count(*) FROM "Auditoria"; SELECT pg_size_pretty(pg_database_size('chatmasterveloz'));` | crescimento fora da curva (ver D5) |
| 1×/dia | RAM/CPU do host (lição starvation) | `free -h`, `docker stats --no-stream` | swap esgotando ou host > 90% RAM |
| contínuo (usuários) | Fluxo de envio em massa do cliente | operação normal do cliente | QUALQUER reclamação de upload/validação/envio |

**Critérios de rollback na observação** (§8 nível 1):
1. Fluxo de envio em massa do cliente com erro reproduzível causado pela
   imagem nova (não por dado) — rollback imediato.
2. Login legado ou do hub indisponível > 15 min sem causa externa.
3. Backend reiniciando em loop ou consumo de RAM crescente sem estabilizar
   (> 2 GB e subindo) — rollback e análise fora de janela.
4. Perda/corrupção de dado em tabela LEGADA (nunca esperado — expand-only):
   rollback nível 1 + investigação com backup P1 intocado.

Passadas 24h sem gatilho: declarar cutover estável, registrar no DIARIO.md e
agendar as pendências:

- **Cron mensal do expurgo da auditoria (D5)** — no host, dia 1, DEPOIS do
  horário do backup de produção:
  ```
  10 4 1 * * docker exec $(docker ps -qf name=pgadmin_db) psql -U <user> -d chatmasterveloz -c "SELECT hub_auditoria_expurgo(interval '12 months')" >> /var/log/hub-auditoria-expurgo.log 2>&1
  ```
  (a função registra meta-evento `auditoria_expurgo` na própria trilha com a
  contagem removida; nunca rodar sem backup válido do período).
- §9 (aposentadoria das flags S8), remoção da linha QA
9001 do 0038, e o **achado de performance da S10**: com ~1 ano de dados
importados (~2,5M linhas), `/motoristas` fica em ~2s (paginação/filtro em JS +
`hub_areas_por_entregador` varrendo as 2 tabelas de fato) e os resumos na
janela de 1 ano cheio em 1,1–1,5s — a janela padrão de 30d das telas fica
folgada abaixo de 1s; números em `evidencias/S10/carga/relatorio.md`; a
melhoria exige mudança funcional e é follow-up a agendar, não bloqueio de
cutover, já que os módulos nascem vazios e o efeito só aparece com ~1 ano de
histórico).
