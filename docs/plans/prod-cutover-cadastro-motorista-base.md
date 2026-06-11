# Runbook — Cutover de produção: `cadastro-motorista-base-validada` (+ scroll + paginação)

> **Quem executa:** o **operador**. O agente entrega este artefato; produção é só do
> operador (cláusula pétrea: o agente nunca acessa o servidor de produção). Cole a saída
> de cada passo no chat para análise.

**Código:** `main` @ `3c241b1` (inclui PRs #10 e #11).
**Componentes a atualizar:** backend (`envio-massa-backend`) e frontend_v2 (`envio-massa-frontend-v2`).
**DDLs:** `app_homologacao/backend/db/008_cadastro_motorista_base.sql` e
`app_homologacao/backend/db/008b_seed_motorista_from_envio_massa.sql` (ambas idempotentes).

> **Ordem segura:** DDL **antes** do deploy. A `008` é compatível com o backend antigo
> (só torna `senha` nullable + concede UPDATE — não quebra o INSERT atual). Assim não há
> janela de incompatibilidade entre aplicar a DDL e subir a imagem nova.

---

## 0. Pré-flight (descobrir nomes reais de PROD)

```bash
# nomes de serviço + imagem atuais em produção
docker service ls | grep -iE 'backend|frontend-v2|frontend_v2'
# anote: <SVC_BACKEND_PROD>, <SVC_FRONTEND_V2_PROD> e a imagem/tag atual de cada (rollback)
```

Referência de homologação (NÃO usar em prod):
`envio-massa-homologacao_backend_homologacao` · `envio-massa-homologacao_frontend_v2_homologacao`.

## 1. Backup leve (antes da DDL)

```bash
# dump só da tabela Motorista — rede de segurança para a 008b
pg_dump "<CONN_PROD>" -t '"Motorista"' -Fc -f /root/motorista_pre_008_$(date +%F).dump
```

## 2. Aplicar DDL (nesta ordem: 008 ANTES de 008b)

```bash
# 2.1 — schema: senha nullable + GRANT UPDATE + NOTIFY pgrst 'reload schema'
psql "<CONN_PROD>" -v ON_ERROR_STOP=1 \
  -f app_homologacao/backend/db/008_cadastro_motorista_base.sql

# 2.2 — seed: popular Motorista do histórico de EnvioMassa (idempotente, sem senha)
psql "<CONN_PROD>" -v ON_ERROR_STOP=1 \
  -f app_homologacao/backend/db/008b_seed_motorista_from_envio_massa.sql
#   → imprime NOTICE: "Motorista: N linha(s) no total, M em pré-cadastro (senha NULL)."
```

Confirmação:

```sql
SELECT count(*) total, count(*) FILTER (WHERE senha IS NULL) pre_cadastro FROM "Motorista";
```

## 3. Build + push das imagens (a partir de um checkout de `main`)

```bash
git fetch origin && git checkout main && git pull   # garantir >= 3c241b1
TAG=cadastro-motorista-base    # ou a convenção de tag de prod usada

docker build -t registry.todo-tips.com/envio-massa-backend:$TAG     app_homologacao/backend
docker push       registry.todo-tips.com/envio-massa-backend:$TAG

docker build -t registry.todo-tips.com/envio-massa-frontend-v2:$TAG app_homologacao/frontend_v2
docker push       registry.todo-tips.com/envio-massa-frontend-v2:$TAG
```

> `.dockerignore` exclui `node_modules` → o `bcrypt` recompila para node:14 dentro do
> container. **Não** copie binários do host.
>
> ⚠️ **Atenção crítica frontend_v2:** o `ENV BACKEND_URL` do Dockerfile do frontend_v2 está
> fixado na API de **homologação** (`https://envmassapihomologacao.todo-tips.com`). Antes do
> build de prod, ajuste para a **API de produção** — senão o painel de prod fala com o
> backend de homologação.

## 4. Deploy (sempre `service update --image`, NUNCA `stack deploy`)

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:$TAG     <SVC_BACKEND_PROD>

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:$TAG <SVC_FRONTEND_V2_PROD>
# aguarde "converged" em cada um
```

## 5. Smoke test (HTTP — sem segredos; ajuste a URL de PROD)

```bash
B=https://<API_BACKEND_PROD>
# rota admin protegida → 401 sem auth
curl -s -o /dev/null -w '%{http_code}\n' "$B/admin/motoristas"
# gate do cadastro com CNPJ fora da base → 409 (anti-enum)
curl -s -w '\n%{http_code}\n' -X POST "$B/motorista/register" \
  -H 'Content-Type: application/json' \
  -d '{"cnpjPrestador":"99887766554433","nome":"x","senha":"Senha#Forte123"}'
```

E visual: `https://<PAINEL_PROD>/dashboard/motoristas` (lista + paginação + scroll) e um
login real de motorista que esteja na base.

## 6. Rollback

```bash
# volta à imagem anterior anotada no passo 0
docker service update --with-registry-auth --image <IMG_ANTERIOR_BACKEND>     <SVC_BACKEND_PROD>
docker service update --with-registry-auth --image <IMG_ANTERIOR_FRONTEND_V2> <SVC_FRONTEND_V2_PROD>
```

As DDLs **não precisam de rollback**: `008` é não-destrutiva (afrouxa NOT NULL + GRANT) e
`008b` só **insere** linhas ausentes; o backend antigo convive com elas. Para reverter a
`008b`, apague as linhas com `senha IS NULL` criadas (use o dump do passo 1 como referência).

---

## Pontos de atenção

- **`<CONN_PROD>`** = string de conexão do Postgres de produção; **`<SVC_*_PROD>`** = nomes
  reais de `docker service ls`; **`$TAG`** = convenção de tag de prod; **registry** = de prod.
  Todos preenchidos pelo operador (o agente nunca acessou prod).
- Aplique **008 antes do deploy** (compatível com o backend antigo → sem janela de quebra).
- **`ENV BACKEND_URL`** do Dockerfile do frontend_v2 deve apontar para a API de **produção**
  antes do build de prod (hoje está em homologação).
- **Risco residual de design** (A06, já aceito): auto-cadastro = "primeiro a cadastrar ganha";
  quem souber um CNPJ de pré-cadastro (senha NULL) pode reivindicar a conta. Mitigado por
  anti-enumeração (409 genérico) + rate-limit. Mitigação plena exigiria fator de posse
  (fora de escopo).
