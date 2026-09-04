# Runbook de deploy — `hub-motorista-360`

**Preparado em 2026-09-04** a partir da `main` já mergeada (PR #149, squash
`3e607aa`). Todos os comandos abaixo foram **montados, não executados** — a
execução é do operador, sob os 5 gates do rito de produção
([`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md)).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge
> clientes reais.

---

## 0. Estado atual — anote antes de começar (este é o rollback)

Levantado em 2026-09-04:

| Serviço | Imagem no ar (= **rollback**) |
|---|---|
| `envio-massa-homologacao_backend_homologacao` | `registry.todo-tips.com/envio-massa-backend:hub-import-range-9ac209b` |
| `envio-massa-homologacao_frontend_v2_homologacao` | `registry.todo-tips.com/envio-massa-frontend-v2:hub-import-range-9ac209b` |

Confirmado: a imagem de backend no ar roda **`node v20.20.2`**, ou seja veio do
`Dockerfile.hub` (o `Dockerfile` antigo é `node:14` e **derrubaria o runtime**).

- **sha7 da main**: `3e607aa` → tag desta entrega: **`hub-motorista-360-3e607aa`**
- `ENV BACKEND_URL` do `frontend_v2/Dockerfile`:
  `https://envmassapihomologacao.todo-tips.com` — **correto para este ambiente**,
  conferido.

Reconferir na hora:

```bash
docker service ls --filter name=envio-massa-homologacao_ \
  --format '{{.Name}}\t{{.Image}}'
docker run --rm registry.todo-tips.com/envio-massa-backend:hub-import-range-9ac209b node --version
```

---

## 1. Pré-flight — abortar se qualquer um falhar

```bash
df -h /                 # ABORTAR se < ~20 GB livres  (em 2026-09-04: 37 GB)
free -h                 # swap ATIVA e com folga
swapon --show
```

🔴 **Bloqueador conhecido em 2026-09-04**: a swap estava em **6,9 GB de 8 GB
(86%)** e a RAM disponível em ~5 GB, com 13 sessões do Claude Code e o
`antigravity-ide-server` consumindo ~6,8 GB juntos. **Dois `docker build`
pesados nessa condição arriscam repetir o incidente de 2026-06-11** (starvation
derrubou o Swarm inteiro).

**Antes de buildar**, libere memória — encerrar as sessões do Claude Code
ociosas há dias resolve (`ps -eo pid,rss,etime,comm --sort=-rss | grep claude`).
Não é opcional: o build compete com a produção do cliente no mesmo hardware.

---

## 2. Banco — migrations no `chatmasterveloz`

⚠️ **As tabelas do hub em produção vivem DENTRO do `chatmasterveloz`.** Estas 3
migrations e o script do robô hoje existem **apenas** no `hub-homolog` isolado.

**Ordem obrigatória** (lição da entrega da 0051): migration → SIGUSR1 no
PostgREST → **provar na API** → só então `service update`.

### 2.1 Backup antes da DDL

```bash
# dentro da task do Swarm do pgadmin_db; $POSTGRES_USER é o usuário interno
pg_dump -U "$POSTGRES_USER" -d chatmasterveloz \
  -t '"Entregador"' -t '"Papel"' -t '"Permissao"' -t '"PapelPermissao"' \
  > /root/backup-pre-0057-0059-$(date +%Y%m%d%H%M).sql
```

### 2.2 Aplicar as migrations, na ordem

Arquivos (todos idempotentes — `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`):

```
infra/hub/migrations/0057_entregador_entrego_enriquecimento.sql
infra/hub/migrations/0058_rpc_motoristas_candidatos_por_conta.sql
infra/hub/migrations/0059_seed_permissao_motoristas_dados_sensiveis.sql
```

> **Heredoc colado no terminal colapsa** (lição da 0051) — copie cada arquivo
> para `/tmp` e aplique por caminho, nunca colando o conteúdo.

### 2.3 Permissões do robô (script avulso)

```
infra/robo-entrego/sql/003-permissoes-enriquecimento-robo-entrego.sql
```

Runbook próprio já escrito:
[`docs/plans/robo-entrego/RUNBOOK-PERMISSOES-ENRIQUECIMENTO.md`](../robo-entrego/RUNBOOK-PERMISSOES-ENRIQUECIMENTO.md).

### 2.4 Recarregar o schema do PostgREST

```bash
docker kill -s SIGUSR1 <container-do-postgrest-de-producao>
```

🔴 **Sonda HTTP em `/rpc/` NÃO prova o reload** (lição da entrega do turno).
A prova é a **contagem de funções no log** do PostgREST após o sinal.

### 2.5 Provar na API antes de tocar nos serviços

```bash
# as 3 colunas novas de Entregador
psql ... -c '\d "Entregador"' | grep dados_entrego

# a RPC nova existe
psql ... -c "SELECT proname FROM pg_proc WHERE proname='hub_motoristas_candidatos_por_conta';"

# a permissão só para admin_entidade/admin_plataforma
psql ... -c "SELECT p.nome FROM \"PapelPermissao\" pp
             JOIN \"Papel\" p ON p.id=pp.papel_id
             JOIN \"Permissao\" pe ON pe.id=pp.permissao_id
             WHERE pe.codigo='motoristas.dados_sensiveis' ORDER BY p.nome;"
```

**Esperado**: 3 colunas; a função presente; exatamente `admin_entidade` e
`admin_plataforma`.

---

## 3. Build — a partir da `main` já mergeada

```bash
cd /var/lib/envioMassa_homologacao
git checkout main && git pull --ff-only
git rev-parse --short HEAD        # tem que dar 3e607aa
```

### 3.1 Backend — **`Dockerfile.hub`**, nunca o `Dockerfile`

```bash
cd app_homologacao/backend
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub \
  -t registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa .

# conferência OBRIGATÓRIA antes de entregar a imagem
docker run --rm registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa node --version
# esperado: v20.x  — se vier v14, foi o Dockerfile errado: NÃO prossiga
```

### 3.2 Frontend v2

```bash
cd ../frontend_v2
grep -n 'ENV BACKEND_URL' Dockerfile     # confirmar envmassapihomologacao
DOCKER_BUILDKIT=0 docker build --memory=2g \
  -t registry.todo-tips.com/envio-massa-frontend-v2:hub-motorista-360-3e607aa .
```

### 3.3 Push

```bash
docker push registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa
docker push registry.todo-tips.com/envio-massa-frontend-v2:hub-motorista-360-3e607aa
```

Anote os **digests** que o push imprime.

---

## 4. Deploy — `service update`, nunca `stack deploy`

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-motorista-360-3e607aa \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-motorista-360-3e607aa \
  envio-massa-homologacao_frontend_v2_homologacao
```

> ⚠️ `docker stack deploy` **destrói** env/labels/segredos do serviço. Nunca.
> ⚠️ O `frontend_v2` é `stop-first` com 1 réplica: **há downtime curto**.

### Rollback (se necessário)

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-import-range-9ac209b \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-import-range-9ac209b \
  envio-massa-homologacao_frontend_v2_homologacao
```

As migrations são **aditivas e idempotentes** — o rollback de imagem não exige
desfazer DDL (colunas novas ficam sem uso; a permissão nova fica sem consumidor).

---

## 5. Smoke + prova do bundle

**HTTP 200 prova que subiu, não que subiu o código certo.** Os dois passos:

```bash
# 5.1 smoke (sem expor segredos)
curl -s -o /dev/null -w '%{http_code}\n' https://app.moveelog.com.br/hub/login
curl -s -o /dev/null -w '%{http_code}\n' https://app.motorista.moveelog.com.br/
```

```bash
# 5.2 PROVA DO BUNDLE — string que só existe nesta entrega
#     "Dados da EntreGô" foi introduzida em 3e607aa (0 ocorrências em cafdfe4)
curl -s https://app.moveelog.com.br/hub/dashboard/motoristas/<id> \
  | grep -c 'Dados da EntreG'
# esperado: >= 1  — se 0, o bundle servido é o ANTIGO
```

Backend — a rota nova deve existir (401/403 já provam que a rota existe; 404
prova que não subiu):

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://envmassapihomologacao.todo-tips.com/motoristas/1/entrego-enriquecimento
# esperado: 401/403 (rota existe, sem auth) — 404 significa código antigo
```

---

## 6. Depois do deploy — opcional e separado

### 6.1 Backfill retroativo do vínculo

Script entregue em `app_homologacao/backend/scripts/backfill-vinculo-motorista.js`,
runbook em [`RUNBOOK-BACKFILL-VINCULO.md`](./RUNBOOK-BACKFILL-VINCULO.md).
Idempotente; reexecutar é no-op; **nunca piora o estado atual** (ambíguo não
vincula). É o que resolve os cadastros antigos sem credencial vinculada.

### 6.2 Timers de enriquecimento

```
infra/robo-entrego/entrego-enriquecimento-sob-demanda.{service,timer}
infra/robo-entrego/entrego-enriquecimento-semestral.{service,timer}
```

Instalar em `/etc/systemd/system/`, `daemon-reload`, `enable --now`.
**Não edite `OnCalendar` à mão** — é gerado por `scripts/gerar-timer.sh` a partir
do `config-enriquecimento.json`.

⚠️ Reusam a **mesma sessão EntreGô** do robô diário, com fila serializada e
prioridade do robô (`dec-039`). Ligar isso muda o comportamento de um sistema em
operação — vale uma janela própria, não junto do deploy.

---

## 7. O que NÃO vai neste deploy

- **Política de retenção** dos dados pessoais: prazo e base legal **não
  definidos** (`dec-038`, `CHK019` aberto). Nenhum expurgo/TTL/anonimização foi
  implementado, e `FR-017` proíbe expurgo automático enquanto a política não
  existir. Deploy **não** cria obrigação de expurgo — mas passa a **gravar** CPF,
  RG, CNH e filiação de terceiros em produção.
- Itens ainda `NÃO VERIFICADO` em
  [`docs/plans/robo-entrego/ACHADOS-PORTAL.md`](../robo-entrego/ACHADOS-PORTAL.md) §9.
