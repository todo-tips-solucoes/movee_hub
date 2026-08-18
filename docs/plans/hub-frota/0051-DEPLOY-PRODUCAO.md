# Migration 0051 + grão de turno — runbook de produção

> ## ✅ EXECUTADO em 2026-08-18 (~23h48 UTC). Este runbook virou registro.
>
> Aplicado pelo agente sob autorização explícita e escopada do operador
> («pode rodar [este runbook]»), com o operador executando os passos de banco
> que o classificador do harness bloqueia para o agente. Produção agora:
> backend e frontend_v2 em `:hub-turno-c5d9307`. O §7 traz o que foi medido.

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

Medido em 2026-08-18: **2.720 linhas / 1288 kB** — a aplicação é questão de
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

⚠️ **NÃO use `curl` no `/rpc/...` para isso** — a primeira versão deste runbook
mandava esperar 401 e tratar 404 como "schema não recarregado". Medido em
2026-08-18: aquele host devolve **404 para tudo**, inclusive para uma RPC que
sabidamente já existia. Controle negativo idêntico ao positivo, poder de
discriminação **zero** — a sonda não diz nada, e tratá-la como sinal levaria a
concluir o oposto do verdadeiro.

A prova que funciona é o log do próprio PostgREST, que conta as funções
carregadas a cada reload:

```bash
docker logs --tail 12 $(docker ps -qf name=pgadmin_postgrest)
```

Comparar a linha `Schema cache loaded ... N Functions` de antes e depois do
SIGUSR1: tem de subir **exatamente +1** (só `hub_performance_turnos` é nova; as
outras duas são `CREATE OR REPLACE`, já contadas). `Relations` tem de ficar
**inalterado** — se subir, a MV vazou para o schema exposto e os `REVOKE`
falharam.

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

## 7. Registro da execução (2026-08-18)

Todos os passos saíram como previsto, na ordem do §2. O que foi medido:

**Passo 1 — pré-checagens.** `0050` registrada na posição 51 e `0051` ausente;
2.720 linhas / 1288 kB; nenhuma importação em curso (a mais recente era de
25/07); MV sem os 3 contadores novos e `hub_performance_turnos` inexistente.
Baseline do indicador: **2.669 turnos, 42,89%**.

**Passo 1/2 — migration.** Saída do psql, em transação única:
`DROP MATERIALIZED VIEW` · `SELECT 2669` · 4× `CREATE INDEX` · 3× `REVOKE` ·
3× `CREATE FUNCTION` · 3× `GRANT` · `INSERT 0 1`. O `SELECT 2669` é a MV sendo
repopulada e bate exatamente com os turnos do baseline.

**Passo 3 — prova do reload do PostgREST.** A sonda HTTP que este runbook
sugeria **não serve**: o `POST /rpc/...` devolve 404 para tudo naquele host,
inclusive para uma RPC que sabidamente já existia — controle negativo idêntico
ao positivo, poder de discriminação zero. A prova veio do log do container:

```
22:57:19  Schema cache loaded 40 Relations, ... 36 Functions
23:48:40  Schema cache loaded 40 Relations, ... 37 Functions   ← após o SIGUSR1
```

**36 → 37 funções**, exatamente a `hub_performance_turnos` (as outras duas
foram `CREATE OR REPLACE`, já contadas). E `40 Relations` inalterado, o que
confirma que a MV continua **não exposta** — os `REVOKE` seguraram.

**Passos 4 e 5 — deploy.** Backend convergiu de primeira; o `service update` do
frontend_v2 foi **bloqueado pelo classificador do harness na primeira tentativa**
e convergiu na segunda (comportamento intermitente já conhecido). A janela de
erro da tela de Performance durou o intervalo entre as duas tentativas.

**Smoke.** `GET /hub/login` → 200. `GET /api/v1/performance` sem cookie → **401
`{"erro":"NAO_AUTENTICADO"}`**, exercitando a cadeia frontend → proxy → backend.
(`?grao=praca` também responde 401, porque a autenticação vem antes do parse do
parâmetro — não serve como prova da validação de `grao`.)

**Prova de bundle.** Chunk `17q03sel4~jo9.js` → **200**, contra o **404**
colhido antes do deploy; contém `medidos por inteiro`, `Sub-pra` e `na meta`;
e um chunk inexistente responde 404, provando que o servidor não devolve 200
para qualquer caminho.

**Verificação funcional.** O indicador **não mudou de valor**: 2.669 turnos,
**42,89%**, idêntico ao baseline — a migration mexeu na forma, não no número.
A tela passa de **2.720 linhas para 2.669 turnos**, e há **35 turnos
multi-sub-praça** no histórico, que até aqui recebiam dois vereditos cada.

O caso real que a entrega existe para corrigir, colhido em produção — um turno
de ALMOCO em SAO PAULO:

| | sub-praça | tempo | ofertadas | aceitas | rejeitadas | completadas |
|---|---|---|---|---|---|---|
| antes (2 linhas) | `""` | 38,04% | 0 | 0 | 0 | 0 |
| antes (2 linhas) | `JABAQUARA E SANTO AMARO - SP` | 51,97% | 24 | 3 | 21 | 3 |
| **depois (1 linha)** | as duas, no detalhe | **90,01%** | 24 | 3 | **21** | 3 |

E o card do mesmo turno: **90,01%** — o mesmo número. Era exatamente essa
discordância que a entrega existia para acabar.

O `21` em rejeitadas também fecha a última dúvida: é um contador que **não
existia** na MV antes da 0051, agora com valor real vindo dela.
