# Runbook — migration 0056 + deploy: intervalo de datas da importação

Aplica a `0056` no `chatmasterveloz` (container `pgadmin_db`, host VPSTodo) e sobe
backend + frontend_v2 da main `1ef63c3` (PR #144).

**O que muda**: `ImportacaoArquivo` ganha `data_referencia_fim`, e o rótulo da
importação passa a ser o INTERVALO real de datas do arquivo em vez da data da
primeira linha. Os REGISTROS não mudam — sempre gravaram a data da própria linha.

## 🔴 Duas diferenças em relação ao runbook da 0055 — leia antes

**1. Esta migration ESCREVE EM DADOS.** O backfill (`UPDATE`) reescreve
`data_referencia` de importações existentes. O rollback exige `pg_dump` da tabela
**antes de aplicar** — a definição do objeto não desfaz um UPDATE.

**2. O `SIGUSR1` é OBRIGATÓRIO e vem ANTES do deploy, não depois.** A coluna é
nova: enquanto o PostgREST não recarregar o schema, qualquer `select` que peça
`data_referencia_fim` responde **400**. Se o backend novo subir antes do reload,
`GET /importacoes` quebra na tela. Ordem: migration → SIGUSR1 → **provar a coluna
pela API** → só então `service update`.

⚠️ **O container do banco é uma task do Swarm** (`pgadmin_db.1.<hash>`, muda a cada
reagendamento): resolver sempre com `docker ps -qf name=pgadmin_db`.

⚠️ **Divisão**: 👤 operador executa no `pgadmin_db` (o classificador bloqueia o
agente até em leitura); 🤖 agente executa build, `service update` e provas HTTP.

---

## Gate 1 — autorização

Explícita para **esta** mudança. A da `0055` não vale.

## Gate 2 — janela

`ALTER TABLE ... ADD COLUMN` com default nulo é instantâneo no Postgres (não
reescreve a tabela). O `UPDATE` do backfill toca poucas dezenas de linhas
(`ImportacaoArquivo` tem 11 registros hoje em produção). Nenhuma MV é recriada,
então **nada pisca na tela** — diferente da `0055`.

Confirme que nenhuma importação está em curso (o backfill e o processor escreveriam
na mesma linha):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT id, tipo, status, criado_em FROM \"ImportacaoArquivo\"
 WHERE status IN ('"'"'pending'"'"','"'"'validating'"'"','"'"'processing'"'"');"'
```
👤 Esperado: **nenhuma linha**. O timer do robô dispara 11h/13h/14h.

## Gate 3 — rollback à mão ANTES de aplicar

**3.1 — 🤖 imagens atuais** (esperado: backend e frontend_v2 em
`:hub-fin-lancamento-65490d7`).

**3.2 — 👤 dump da tabela inteira** — é o que desfaz o `UPDATE`:

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"ImportacaoArquivo\"" --data-only --column-inserts' > ~/importacaoarquivo-antes-0056.sql; wc -l ~/importacaoarquivo-antes-0056.sql
```

👤 Confira que **não saiu vazio**. Sem este arquivo, não aplique.

**Rollback**: `TRUNCATE` não serve (há FKs de `PerformanceTurno`/
`FaturamentoLancamento`/`ImportacaoLinhaErro`). Para desfazer, restaure os valores
das duas colunas a partir do dump com `UPDATE ... FROM (VALUES ...)`, ou
simplesmente rode de novo o backfill invertido — na prática, **o backfill é
derivado dos fatos e reexecutável**, então o cenário realista de rollback é só
`ALTER TABLE "ImportacaoArquivo" DROP COLUMN data_referencia_fim;` e voltar as
imagens. O dump cobre o caso em que se queira o `data_referencia` antigo (o da
primeira linha) de volta — que era, afinal, o valor errado.

## Gate 4 — aplicar

**4.0 — 🤖 build das duas imagens** com tag `hub-import-range-1ef63c3`
(`df -h /` antes, ≥20 GB livres — regra do `CLAUDE.md`).

**4.1 — 👤 a migration:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' < /var/lib/envioMassa_homologacao/infra/hub/migrations/0056_importacao_range_datas.sql
```

Esperado: `ALTER TABLE`, 2 × `COMMENT`, e 2 × `UPDATE <n>` (o backfill de
faturamento e o de performance).

**4.2 — 👤 registrar na série:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0056_importacao_range_datas.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
```

**4.3 — 👤 recarregar o schema do PostgREST — OBRIGATÓRIO ANTES DO DEPLOY:**

```
! docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
```

⚠️ Filtro `name=pgadmin_postgrest`, **não** `name=postgrest`: há três PostgREST
neste host e `| head -1` pode acertar o errado.

## Gate 5 — provar ANTES de deployar

**5.1 — 👤 o backfill fez o que devia:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT id, tipo, data_referencia AS inicio, data_referencia_fim AS fim,
       (data_referencia_fim > data_referencia) AS eh_intervalo
  FROM \"ImportacaoArquivo\" ORDER BY id;"'
```

Esperado: a importação **7** (faturamento do dia 28) deixa de dizer `2026-08-27` e
passa a `2026-08-25 → 2026-08-28`. As de performance ficam com início = fim (o
arquivo cobre um dia só). Nenhuma linha com `fim < inicio`.

**5.2 — 🔴 a coluna nova está VISÍVEL PARA A API** (é isto que o `SIGUSR1` garante,
e sem isto o deploy quebra a tela):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -c "
SELECT count(*) FROM information_schema.columns
 WHERE table_name = '"'"'ImportacaoArquivo'"'"' AND column_name = '"'"'data_referencia_fim'"'"';"'
```
Esperado: `1`. Se vier `0`, **pare** — a migration não aplicou a coluna.

🤖 Complemento pelo agente: `GET /api/v1/importacoes` continua 200 com o backend
ATUAL (que ainda não pede a coluna nova) — confirma que nada quebrou no meio.

## Gate 6 — deploy

🤖 Backend primeiro, frontend em seguida:

```
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-import-range-1ef63c3 \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-import-range-1ef63c3 \
  envio-massa-homologacao_frontend_v2_homologacao
```

## Gate 7 — prova depois do deploy

🤖 **7.1** — smoke: `/hub/login` e `/login` → 200.

🤖 **7.2** — backend no container em execução: o `select` pede a coluna nova
(`grep -c "data_referencia_fim" routes/hub-importacoes.js` → `1`).

🤖 **7.3** — bundle servido: `sha256` do chunk que contém
`rotuloIntervaloImportacao` conferido contra o mesmo arquivo dentro da imagem.

👤 **7.4 — na tela**: abrir Importações. A do dia 28 (id 7) deve mostrar
**25/08/2026 – 28/08/2026**; as de um dia só, uma data apenas.

---

## Depois

- Atualizar a memória do projeto com as imagens novas e o rollback.
- ⚠️ Nada a avisar a terceiros aqui: este deploy **não muda número de relatório**,
  só o rótulo de datas na tela de Importações.
