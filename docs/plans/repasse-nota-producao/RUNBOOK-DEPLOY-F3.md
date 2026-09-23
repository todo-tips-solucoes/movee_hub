# Runbook — deploy da F3 ("entra na nota"), main `4759960`

Preparado em 2026-09-23. Tag das três imagens: **`nota-categoria-4759960`**.

> O ambiente chamado "homologação" **é produção**. Cada passo abaixo que escreve
> exige os 5 gates do rito. O agente entrega este documento; quem executa é o operador.

## O que este deploy leva (é mais do que a F3)

O backend em produção está **duas entregas atrás** da `main`. Medido interrogando a
imagem no ar (`fix-detalhe-lote-dd09538`):

```
grep -c "repasse/extrato" routes/motorista-adiantamento.js  -> 0
grep -c "categorias_nota"  lib/adiantamento-dto.js          -> 0
```

Ou seja, a rota do extrato da **F2 nunca chegou ao backend**: o app motorista subiu e a
migration 0089 foi aplicada, mas o backend não. Hoje o app pede
`GET /motorista/repasse/extrato` e leva 404 — como o carregamento é best-effort, a tela
não quebra, só não mostra o bloco "Extrato da produção".

| Serviço | No ar (= rollback) | Vai levar |
|---|---|---|
| `backend_homologacao` | `envio-massa-backend:fix-detalhe-lote-dd09538` | **F2 (#212)** + F3 (#213) |
| `frontend_v2_homologacao` | `envio-massa-frontend-v2:repasse-extrato-eefc076` | **#211** + F2 + F3 |
| `frontend_motorista_homologacao` | `app-motorista-frontend:extrato-motorista-3126571` | F3 |

## Por que é seguro quanto a valores

`categorias_nota` nasce **nula**. Enquanto ninguém configurar, `total_nota`,
`total_outros` e o `naNota` de cada item vêm nulos, e o `total` do extrato continua
sendo a soma de tudo. As três funções de repasse não são tocadas. **O deploy sozinho
não muda número nenhum para ninguém** — a divisão só aparece quando alguém marcar
categorias em Configurações e salvar.

---

## Passo 0 — Antes de tudo

```bash
df -h /            # abortar se houver menos de ~20 GB livres
free -h            # swap ativa
DB=$(docker ps -q -f name=pgadmin_db)   # UM id; vazio = parar
echo "$DB"
```

⚠️ Não use `docker exec pgadmin_db` literal — o container é `pgadmin_db.1.<sufixo>`.

## Passo 1 — Retrato ANTES (só leitura)

Guarde a saída: é com ela que se confere, depois, que nada mudou.

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
BEGIN READ ONLY;
SELECT versao, apuracao_dia_inicio, apuracao_dias_ate_repasse, repasse_visivel_app,
       array_length(categorias_extrato, 1) AS cats_extrato
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
ROLLBACK;
SQL
```

## Passo 2 — Aplicar a migration 0090

Idempotente e aditiva (`ADD COLUMN IF NOT EXISTS` + `CREATE OR REPLACE`).

```bash
cd /var/lib/envioMassa_homologacao
docker exec -i $DB sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d chatmasterveloz' \
  < infra/hub/migrations/0090_categoria_entra_na_nota.sql
```

## Passo 3 — SIGUSR1 no PostgREST

**Sem isso a RPC nova não entra no schema cache e o extrato quebra.**

⚠️ Há **dois** PostgREST no host: `pgadmin_postgrest` (produção) e
`hub_homolog_postgrest` (hub isolado). Filtrar por `name=postgrest` devolve os **dois** —
sempre o nome completo.

```bash
docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)
```

## Passo 4 — Provar o banco ANTES de subir imagem

```bash
docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' <<'SQL'
-- a coluna existe e está NULA para todos (nada foi preenchido)
SELECT count(*) FILTER (WHERE categorias_nota IS NOT NULL) AS configuradas,
       count(*) AS total
  FROM "AdiantamentoConfiguracao";
-- a função devolve as colunas novas
SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
  FROM pg_proc p, unnest(p.proallargtypes) WITH ORDINALITY t(typ, ord)
  JOIN LATERAL (SELECT p.proargnames[t.ord] AS attname, t.ord AS attnum) a ON true
 WHERE p.proname = 'hub_adiantamento_extrato_motorista';
SQL
```

Esperado: `configuradas = 0`, e a lista de colunas contendo `total_nota` e `total_outros`.

## Passo 5 — Deploy das imagens

Uma de cada vez, conferindo entre elas.

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:nota-categoria-4759960 \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:nota-categoria-4759960 \
  envio-massa-homologacao_frontend_v2_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:nota-categoria-4759960 \
  envio-massa-homologacao_frontend_motorista_homologacao
```

## Passo 6 — Prova de bundle (HTTP 200 não prova nada)

**Backend** — interrogar o processo vivo, não `docker service logs` (que agrega tarefas
antigas):

```bash
CID=$(docker ps -q -f name=envio-massa-homologacao_backend_homologacao)
docker exec $CID sh -c "grep -c 'total_nota' routes/motorista-adiantamento.js"   # > 0
docker exec $CID sh -c "grep -c 'repasse/extrato' routes/motorista-adiantamento.js"  # > 0 (F2)
```

**frontend_v2** — a string nova só existe nesta entrega:

```bash
curl -s https://app.moveelog.com.br/hub/dashboard/adiantamentos/configuracoes \
  | grep -o 'entram na nota' | head -1
```

**app motorista** — ⚠️ a tela `/repasse` é server-rendered e as linhas novas só
renderizam depois de alguém configurar, então **não dá para provar por HTTP** nem por
chunk estático (a string não está em `.next/static`). Prove no container vivo, como no
backend:

```bash
CIDM=$(docker ps -q -f name=envio-massa-homologacao_frontend_motorista_homologacao)
docker exec $CIDM sh -c "grep -c 'Entra na nota' '.next/server/app/(app)/repasse/page.js'"   # > 0
```

Depois, no navegador: abrir `/repasse` e conferir que o bloco "Extrato da produção"
agora aparece (antes deste deploy o backend devolvia 404) e que **não** há linha
"Entra na nota" — ninguém configurou ainda.

## Passo 7 — Conferir que nada mudou de valor

Repita o Passo 1 e compare com o retrato guardado. E na tela do hub, em Repasse, os
valores da semana têm de ser os mesmos de antes do deploy.

---

## Rollback

**Imagens** (imediato, e as três estão no host):

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:fix-detalhe-lote-dd09538 \
  envio-massa-homologacao_backend_homologacao
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:repasse-extrato-eefc076 \
  envio-massa-homologacao_frontend_v2_homologacao
docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:extrato-motorista-3126571 \
  envio-massa-homologacao_frontend_motorista_homologacao
```

**Banco** (`infra/hub/testes/sql/0090-rollback.sql`, testado):

```bash
docker exec -i $DB sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d chatmasterveloz' \
  < infra/hub/testes/sql/0090-rollback.sql
docker kill -s SIGUSR1 $(docker ps -q -f name=pgadmin_postgrest)
```

O rollback restaura as duas funções (0075/0089) e **preserva a coluna** de propósito —
dropar apagaria a configuração de quem já marcou. ⚠️ Depois de reverter, o `salvar`
volta a não carregar `categorias_nota` entre versões: o próximo salvamento zera a
marcação de quem configurou.

## Depois do deploy — ligar a funcionalidade

Nada aparece para o motorista até alguém configurar. Em **Hub → Adiantamentos →
Configurações**, no seletor **"Dessas, quais entram na nota"**, marcar as categorias que
compõem a base da nota e salvar. Só o que já está no extrato é oferecido.

⚠️ Desmarcar tudo depois **não** volta ao estado "não configurado" — o formulário omite
o campo vazio e o banco preserva o valor anterior.
