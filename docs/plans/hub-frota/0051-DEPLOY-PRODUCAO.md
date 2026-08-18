# Migration 0051 + grão de turno — runbook de produção

Tudo abaixo é para o **OPERADOR** executar; a sessão analisa a saída colada.
As tabelas do hub em produção vivem DENTRO do `chatmasterveloz`, então aplicar
esta migration lá é **rito integral dos 5 gates** — não a exceção `hub-*`.

Entrega: PR #120, squash **`c5d9307`** na `main`. Plano:
[`docs/plans/performance-linha-por-turno.md`](../performance-linha-por-turno.md).

## 0. Artefatos já prontos (buildados a partir da `main` mergeada)

| serviço | imagem nova | digest |
|---|---|---|
| backend | `registry.todo-tips.com/envio-massa-backend:hub-turno-c5d9307` | `sha256:dd390b0578be7fc7d726f6e1eb8d1d98587c80ea76034943ff17b9b456e288c0` |
| frontend_v2 | `registry.todo-tips.com/envio-massa-frontend-v2:hub-turno-c5d9307` | `sha256:5418ca16f9431fc438c2c444197ad8dfcec9bba9845ade50664c6510d230e799` |

**Rollback anotado** (o que está no ar hoje, conferido em 2026-08-18):

| serviço | imagem de rollback |
|---|---|
| backend | `registry.todo-tips.com/envio-massa-backend:hub-tempo-periodo-c510116` |
| frontend_v2 | `registry.todo-tips.com/envio-massa-frontend-v2:hub-metas-4eb7780` |

Conferido nas imagens novas antes do push: backend `node --version` → `v20.20.2`
(veio do `Dockerfile.hub`, não do `Dockerfile` antigo de node:14); frontend_v2
`BACKEND_URL=https://envmassapihomologacao.todo-tips.com` (= produção) e sem o
banner de homologação no bundle.

## 1. Antes de aplicar

### 1.1 Confirmar que a 0050 está aplicada

```sql
SELECT id, nome FROM "SchemaMigration" ORDER BY id DESC LIMIT 3;
```

A 0051 **depende** de `tempo_disponivel_periodo_pct` (coluna gerada da 0050)
para calcular a fatia de tempo de cada praça. Se a 0050 não estiver lá, parar.

### 1.2 Dimensionar o custo

```sql
SELECT count(*) AS linhas,
       pg_size_pretty(pg_total_relation_size('"PerformanceTurno"')) AS tamanho
FROM "PerformanceTurno";
```

Medido em 2026-08-18: **2.720 linhas / 1.408 kB** — a aplicação é questão de
milissegundos. Ainda assim é DDL: aplicar **fora da janela de importação**, que
é o único caminho de escrita nesses fatos.

O que a 0051 faz de bloqueante: `DROP` + `CREATE MATERIALIZED VIEW` (varre a
tabela) e um `CREATE INDEX` em `PerformanceTurno` (trava escrita, não leitura).

### 1.3 Guardar o retrato de antes

Para comparar depois — o número que a tela mostra hoje:

```sql
SELECT count(*) AS turnos,
       round(SUM(online)/NULLIF(SUM(periodo),0)*100, 2) AS tempo_disponivel_pct
FROM (
  SELECT LEAST(SUM(EXTRACT(EPOCH FROM tempo_disponivel))
                 FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL),
               MAX(EXTRACT(EPOCH FROM duracao))
                 FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL)) AS online,
         MAX(EXTRACT(EPOCH FROM duracao))
           FILTER (WHERE tempo_disponivel IS NOT NULL AND duracao IS NOT NULL) AS periodo
  FROM "PerformanceTurno"
  GROUP BY id_empresa, data_periodo, periodo, entregador_id
) t;
```

Esse percentual **não muda** com a 0051 (era 42,89% após a 0050). O que muda é a
quantidade de LINHAS na tela: passa a ser o número de turnos, não de registros.

## 2. ORDEM DE APLICAÇÃO — inverter quebra a tela

Não é preferência, é dependência. A imagem nova do backend chama a RPC
`hub_performance_turnos`, que não existe hoje.

| # | passo | por que nesta posição |
|---|-------|----------------------|
| 1 | aplicar a **0051** no `chatmasterveloz`, **em transação única** | cria a RPC, recria a MV com os 3 contadores novos e troca o filtro de sub-praça para semi-join |
| 2 | `docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest)` | sem o reload, a RPC existe no banco e **não existe para a API** |
| 3 | provar que a API enxerga a RPC (§3) | HTTP 200 do serviço não prova que o schema recarregou |
| 4 | `service update` do **backend** | é o passo que passa a exigir a RPC |
| 5 | `service update` do **frontend_v2**, imediatamente depois | ver a janela conhecida abaixo |

### ⚠️ Janela conhecida entre os passos 4 e 5

O padrão do parâmetro `grao` passou a ser `turno`. Entre o deploy do backend e o
do frontend, o frontend **antigo** pede `GET /performance` sem `grao` e recebe
itens de turno, que ele não sabe ler — a tela de Performance mostra o estado de
erro (**só ela**; o resto do painel não é afetado).

Rodar os passos 4 e 5 **em sequência imediata**. O `frontend_v2` é `stop-first`
com 1 réplica, então ele tem downtime curto de qualquer forma.

### Rollback também tem ordem

1. Voltar a imagem do **frontend_v2** e depois a do **backend**. O backend
   anterior lê a tabela-base direto e funciona com a 0051 aplicada — a migration
   é compatível para trás.
2. Só se for mesmo necessário desfazer o banco: reaplicar o corpo da **0050**
   (recria a MV na forma antiga e as duas RPCs de resumo com o ramo de
   sub-praça), `DROP FUNCTION IF EXISTS hub_performance_turnos(int,date,date,text,text,int,int,int)`,
   `DROP INDEX IF EXISTS idx_performance_empresa_subpraca_data`, e **SIGUSR1**.
   Nenhum dado é perdido em nenhum dos caminhos: a 0051 não escreve em
   `PerformanceTurno`.

## 3. Comandos

### Passo 1 — migration (transação única)

```bash
# do host, com o arquivo do repo na main c5d9307
docker exec -i pgadmin_db psql -v ON_ERROR_STOP=1 -1 -U <usuario> -d chatmasterveloz \
  < infra/hub/migrations/0051_performance_turnos_rpc.sql
```

`-1` é obrigatório: com ele o `DROP`/`CREATE` da MV é atômico e nenhuma sessão
enxerga a view ausente. Registrar na tabela de controle:

```sql
INSERT INTO "SchemaMigration" (nome)
VALUES ('0051_performance_turnos_rpc.sql') ON CONFLICT (nome) DO NOTHING;
```

### Passo 2 — reload do PostgREST

```bash
docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest)
```

### Passo 3 — provar que a API enxerga a RPC

No banco, provando a forma nova (a MV precisa ter os 3 contadores):

```sql
SELECT count(*) FILTER (WHERE attname = 'corridas_rejeitadas') AS tem_rejeitadas,
       count(*) FILTER (WHERE attname = 'corridas_canceladas') AS tem_canceladas,
       count(*) FILTER (WHERE attname = 'pedidos_concluidos')  AS tem_pedidos
FROM pg_attribute
WHERE attrelid = 'mv_performance_dia'::regclass AND attnum > 0 AND NOT attisdropped;
```

Esperado: `1 | 1 | 1`. (`information_schema` **não lista materialized views** —
conferir por lá "passa" medindo nada.)

E que a função existe com a assinatura certa:

```sql
SELECT proname, pg_get_function_identity_arguments(oid)
FROM pg_proc WHERE proname = 'hub_performance_turnos';
```

Pela API, o teste que só passa se o cache de schema recarregou — 404 significa
que o SIGUSR1 não pegou:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://envmassapihomologacao.todo-tips.com/rpc/hub_performance_turnos
```

Esperado: **401** (sem JWT) — e **não** 404. 404 = schema não recarregado.

### Passos 4 e 5 — deploy, em sequência imediata

```bash
docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:hub-turno-c5d9307 \
  envio-massa-homologacao_backend_homologacao

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-frontend-v2:hub-turno-c5d9307 \
  envio-massa-homologacao_frontend_v2_homologacao
```

**Nunca** `docker stack deploy` — ele descarta env/labels/segredos do serviço.

## 4. Smoke e prova de bundle

HTTP 200 prova que o serviço subiu, **não** que subiu o código certo.

```bash
curl -s -o /dev/null -w 'painel %{http_code}\n' https://app.moveelog.com.br/hub/login
curl -s -o /dev/null -w 'api    %{http_code}\n' https://envmassapihomologacao.todo-tips.com/
```

A prova de que o bundle servido é o desta entrega — o chunk saiu da imagem
buildada e leva uma frase que só existe nesta entrega (o aviso do filtro de
sub-praça):

```bash
# 1. o chunk desta entrega tem de EXISTIR
curl -s -o /dev/null -w 'chunk %{http_code}\n' \
  https://app.moveelog.com.br/_next/static/chunks/17q03sel4~jo9.js

# 2. e conter a string exclusiva
curl -s https://app.moveelog.com.br/_next/static/chunks/17q03sel4~jo9.js \
  | grep -c 'medidos por inteiro'
```

Esperado: `chunk 200` e contagem `1`.

**Controle negativo já colhido**: esse mesmo chunk respondia **404** em produção
em 2026-08-18, antes do deploy — então um 200 aqui só pode vir da imagem nova.

## 5. Conferência funcional (o que o cliente vai ver)

1. Abrir `/hub/dashboard/performance`. **Cada linha é um turno**, com a coluna
   "Sub-praças" listando as sub-praças daquele turno.
2. Filtrar por um entregador que tenha rodado em duas praças no mesmo dia: a
   tabela mostra **uma** linha, e o percentual de tempo disponível dela é
   **igual** ao do card "Tempo disponível médio" acima. Antes eram três números
   diferentes na mesma tela.
3. Aplicar um filtro de sub-praça: a tela passa a exibir a frase explicando que
   os turnos são medidos por inteiro, e os chips continuam mostrando **todas**
   as sub-praças do turno.
4. Exportar o CSV: o cabeçalho traz `subpracas` (plural) e o arquivo tem uma
   linha por turno — o mesmo que a tela.

## 6. Critérios de abortar

- Passo 3 devolvendo **404** na RPC → SIGUSR1 não pegou. Repetir o passo 2 antes
  de qualquer `service update`.
- `GET /performance` respondendo **500** depois do passo 4 → rollback do
  backend imediatamente (a imagem anterior funciona com a 0051 aplicada).
- Chunk respondendo 404 ou `grep -c` devolvendo `0` → o serviço subiu com bundle
  antigo; refazer o `service update` do frontend_v2 antes de declarar OK.
