# Runbook — migration 0055 + deploy: financeiro por data de lançamento

Aplica a `0055` no `chatmasterveloz` (container `pgadmin_db`, host VPSTodo) e sobe
backend + frontend_v2 da main `65490d7` — o código do financeiro é o do PR #141
(`8ac8a1d`); `65490d7` é o HEAD da main no momento do build, que avançou com o
merge deste próprio runbook. `git diff --stat 8ac8a1d..65490d7` mostra 1 arquivo:
este documento. A tag carrega o sha do que foi BUILDADO, como manda o rito.

**O que muda para o cliente**: o filtro de período do módulo Financeiro passa a
usar `data_lancamento` (o dia em que o lançamento foi emitido) no lugar de
`data_referencia` (a competência — o dia do turno a que o lançamento se refere).

🔴 **Isto muda número que já foi visto.** Todo total diário do financeiro passa a
ser outro, para todo o histórico. Um relatório do "dia 27" tirado antes desta
janela não bate com o mesmo período consultado depois. Medido: 22% das linhas do
arquivo de 28/08 e 27% das de 27/08 têm as duas datas diferentes. Nenhum dado é
perdido — as duas colunas seguem gravadas, a lista mostra as três datas do ciclo e
o CSV passa a trazer as duas.

⚠️ **O container do banco é uma task do Swarm**: o nome real é `pgadmin_db.1.<hash>`
e muda a cada reagendamento — `docker exec pgadmin_db` responde "No such
container". Todos os comandos resolvem o ID com `docker ps -qf name=pgadmin_db`.

⚠️ **Divisão de execução**: o agente **não executa** nada no `pgadmin_db` — o
classificador o bloqueia até em leitura. Os passos marcados 👤 são para o operador
colar com `!`; os marcados 🤖 o agente executa.

⚠️ **A ordem importa.** Entre a migration e o `service update` do backend, a lista
(tabela-base, filtrada pelo backend antigo por competência) e os cards (MV, já
agregada por lançamento) ficam **discordando na mesma tela**. Nada quebra, mas a
janela deve ser curta — tenha as imagens buildadas ANTES de aplicar a migration.

---

## Gate 1 — autorização

Autorização explícita para **esta** mudança. As autorizações das entregas de hoje
(PRs #138/#139/#140) não valem aqui: aquelas não tinham DDL.

## Gate 2 — janela

Impacto na aplicação: a MV é recriada com `DROP` + `CREATE ... WITH DATA`. Durante
a recriação (segundos, o seed real tem ~28k linhas) as RPCs de resumo do
financeiro falham ou retornam vazio — os **cards** do financeiro piscam. A lista
(tabela-base) não é afetada. `CREATE INDEX` sem `CONCURRENTLY` tranca escrita na
`FaturamentoLancamento`, o que só colide com uma importação em curso: **confirme
que nenhuma importação está rodando** antes de aplicar.

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F"|" -c "
SELECT id, tipo, status FROM \"ImportacaoArquivo\" WHERE status IN ('"'"'pending'"'"','"'"'validating'"'"','"'"'processing'"'"');"'
```
👤 Esperado: **nenhuma linha**. Se vier alguma, espere terminar.

O timer do robô dispara 11h/13h/14h — fora dessas janelas o risco é menor.

## Gate 3 — rollback à mão ANTES de aplicar

**3.1 — imagens atuais (anote a saída):**

```
! docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}' | grep -E 'backend|frontend_v2'
```
🤖 Esperado hoje: backend `:hub-mv-alarme-25e0dd1`, frontend_v2 `:hub-reprocessar-f74cde6`.

**3.2 — guarde a definição atual da MV e das 2 funções:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -c "
SELECT '"'"'-- MV --'"'"' UNION ALL SELECT pg_get_viewdef('"'"'mv_faturamento_dia'"'"'::regclass)
UNION ALL SELECT '"'"'-- FUNcoes --'"'"'
UNION ALL SELECT pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.proname IN ('"'"'hub_faturamento_totais'"'"','"'"'hub_faturamento_agrupado'"'"');"' | tee ~/faturamento-antes-0055.sql
```
👤 Confira que o arquivo **não saiu vazio** antes de seguir.

**Rollback completo** (se precisar): reaplicar a `0028` na íntegra — ela é
`CREATE OR REPLACE` nas funções e recria a MV pelo mesmo caminho — e voltar as
imagens do 3.1. Nenhum dado precisa ser restaurado: a `0055` **não escreve em
tabela de fatos**, só recria MV/funções/índices.

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
    < /var/lib/envioMassa_homologacao/infra/hub/migrations/0028_mv_faturamento_dia.sql
```

## Gate 4 — aplicar

**4.0 — 🤖 build das duas imagens ANTES da migration** (encurta a janela de
discordância entre lista e cards). Tag `hub-fin-lancamento-65490d7`, backend via
`Dockerfile.hub`, frontend via `Dockerfile`, ambos com `--memory=2g`.

✅ **Já executado em 2026-08-30 15h05** — as duas imagens estão no registry:

| imagem | digest |
|---|---|
| `envio-massa-backend:hub-fin-lancamento-65490d7` | `sha256:69091f63bcbd…64a` |
| `envio-massa-frontend-v2:hub-fin-lancamento-65490d7` | `sha256:710850940e2e…8f9` |

Conferido em ambas: `node v20.20.2`; no backend, a janela por `data_lancamento` e o
CSV com as duas datas; no frontend, `BACKEND_URL` da API do cliente, o rótulo novo
no bundle e **zero** ocorrências do banner "HOMOLOGAÇÃO".

**4.1 — 👤 a migration:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
    < /var/lib/envioMassa_homologacao/infra/hub/migrations/0055_faturamento_por_data_lancamento.sql
```

Esperado: 2 `CREATE INDEX`, 1 `DROP MATERIALIZED VIEW`, 1 `SELECT <n>` (a MV com
`WITH DATA`), 3 `CREATE INDEX`, 2 `REVOKE`, 2 `CREATE FUNCTION`.

**4.2 — 👤 registrar na série de migrations** (o `migrate.sh` não roda contra
produção; o registro é manual, mesmo padrão da 0051/0054):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0055_faturamento_por_data_lancamento.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
```

**4.3 — 👤 recarregar o schema do PostgREST** (as funções mudaram de corpo, não de
assinatura, mas o cache de schema é barato de recarregar):

```
! docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
```

⚠️ O filtro é `name=pgadmin_postgrest`, **não** `name=postgrest`: há TRÊS PostgREST
neste host (`pgadmin_postgrest` = produção, `hub_homolog_postgrest` = ambiente
isolado, mais o do hub) e `| head -1` pode acertar o errado — o reload iria para o
container errado e ninguém perceberia. Pego na execução de 2026-08-30.

⚠️ **Sonda HTTP em `/rpc/` NÃO prova o reload** (lição da 0051) — a prova é a
contagem de funções no log do PostgREST, ou o passo 5.2 abaixo, que exercita a
função de verdade.

## Gate 5 — provar ANTES de deployar

**5.1 — 👤 a MV nasceu com a coluna certa e populada:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT a.attname FROM pg_attribute a
 WHERE a.attrelid = '"'"'mv_faturamento_dia'"'"'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum;
SELECT count(*) AS linhas_na_mv FROM mv_faturamento_dia;"'
```
Esperado: `data_lancamento` na 2ª coluna (e **nenhuma** `data_referencia`), e
`linhas_na_mv` > 0.

**5.2 — 👤 as RPCs respondem e a MV bate com a tabela:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SET request.jwt.claims = '"'"'{\"escopo\":[6],\"empresa_ativa\":6}'"'"';
SELECT * FROM hub_faturamento_totais(6, '"'"'2026-08-28'"'"', '"'"'2026-08-28'"'"', NULL, NULL, NULL, NULL);
SELECT * FROM hub_faturamento_agrupado(6, '"'"'2026-08-25'"'"', '"'"'2026-08-30'"'"', NULL, NULL, NULL, NULL, '"'"'dia'"'"') ORDER BY chave;
SELECT t.dia, t.total AS tabela, m.total AS mv, (t.total = m.total) AS bate FROM
  (SELECT data_lancamento AS dia, sum(valor)::numeric(14,2) total FROM \"FaturamentoLancamento\" WHERE id_empresa=6 GROUP BY 1) t
  FULL JOIN (SELECT data_lancamento AS dia, sum(total)::numeric(14,2) total FROM mv_faturamento_dia WHERE id_empresa=6 GROUP BY 1) m
  ON m.dia = t.dia ORDER BY 1;"'
```

Esperado: `bate = t` em **todas** as linhas. O total do dia 28 será **maior** que
o de antes (R$ 108.398,05 era por competência; por lançamento inclui as 1.058
linhas que estavam no dia 27).

🔴 **Se `bate` vier `f` em qualquer linha, PARE** e rode o refresh antes de seguir:
`SELECT hub_faturamento_refresh_mv();`

## Gate 6 — deploy

🤖 Backend primeiro (é ele que passa a filtrar por lançamento), frontend em
seguida (rótulos e ordem das datas):

```
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-fin-lancamento-65490d7 \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-fin-lancamento-65490d7 \
  envio-massa-homologacao_frontend_v2_homologacao
```

## Gate 7 — prova depois do deploy

🤖 **7.1 — smoke**: `/hub/login` e `/login` em `app.moveelog.com.br` → 200.

🤖 **7.2 — backend, no container em execução** (a tag não prova o código):

```
CID=$(docker ps -qf name=envio-massa-homologacao_backend_homologacao | head -1)
docker exec "$CID" sh -c 'grep -c "data_lancamento=gte" routes/hub-faturamento.js'
```
Esperado: `1`.

🤖 **7.3 — bundle servido**: baixar de `app.moveelog.com.br` o chunk que contém
`De (data de lançamento)` e conferir o `sha256` contra o mesmo arquivo dentro da
imagem. HTTP 200 não prova nada aqui.

👤 **7.4 — na tela**: filtrar o financeiro por 28/08–28/08. O total deve ser
**maior** que os R$ 108.398,05 de antes, e cada linha deve mostrar as três datas
do ciclo com **Lançamento** em primeiro.

---

## Depois

- Avisar quem recebeu relatórios diários do financeiro: os números do mesmo
  período mudaram, e a razão é a troca de coluna, não erro de dado.
- Atualizar a memória do projeto com as imagens novas e o rollback.

---

## Execução — 2026-08-30, ~18h30 UTC ✅

Executado integralmente. Desfecho:

| Gate | Resultado |
|---|---|
| 2 · importação em curso | nenhuma (última janela do robô às 14h, dia 29 importado OK) |
| 3 · rollback | 151 linhas em `~/faturamento-antes-0055.sql` |
| 4.1 · migration | aplicou na ordem esperada; MV nasceu com **8.975 linhas** |
| 4.2 · SchemaMigration | `INSERT 0 1` |
| 4.3 · SIGUSR1 | entregue ao `pgadmin_postgrest` (`9b75ffe3e509`) |
| 5.1 · colunas da MV | `data_lancamento` presente, `data_referencia` ausente |
| 5.2 · RPCs | dia 28 = R$ 133.462,99 · 767 entregadores |
| 5.3 · MV × tabela | **bate em 4 de 4 dias** |
| 5.4 · fallback sub-praça | R$ 10.813,18 · 89 entregadores |
| 6 · deploy | backend e frontend_v2 → `:hub-fin-lancamento-65490d7`, 1/1 |
| 7 · prova | smoke 200; código conferido no container; **sha256 do bundle servido == o da imagem** |

**Totais que mudaram** (o efeito esperado da troca de coluna):

| Dia | Antes (competência) | Depois (lançamento) |
|---|---|---|
| 27/08 | R$ 110.913,63 | R$ 148.912,63 |
| 28/08 | R$ 108.398,05 | R$ 133.462,99 |
| 29/08 | — | R$ 141.392,49 |

🟢 **Achado que só a execução revelou**: por data de LANÇAMENTO, cada arquivo do
portal cobre exatamente **um** dia — as quantidades por dia (4.354 / 4.786 / 4.173)
são o total de linhas de cada arquivo importado. Por competência, um arquivo se
espalhava por 3–4 dias. É um mérito operacional da decisão que o levantamento
prévio não tinha capturado.

⚠️ **Incidente NÃO relacionado, no meio da janela**: o disco do host chegou a 100% e
derrubou o `pgadmin_db` (crash loop, `No space left on device`). Causa: acúmulo de
imagens + 5 builds no mesmo dia. Recuperado com `docker builder prune -f` +
`docker image prune -f` (18 GB); nenhum dado perdido. O rito de build no
`CLAUDE.md` passou a exigir `df -h /` por causa disso.
