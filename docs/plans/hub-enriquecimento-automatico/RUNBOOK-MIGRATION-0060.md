# Runbook — aplicar a migration 0060 em PRODUÇÃO

> ## ✅ EXECUTADO em 2026-09-09/10 — este documento é REGISTRO, não tarefa pendente
>
> | passo | resultado medido |
> |---|---|
> | dump prévio de `Entregador` | `~/entregador-antes-0060.sql`, 1343 linhas, 828 KB |
> | migration aplicada | sem erro; `SchemaMigration` id **61** |
> | backfill | **1219 `sucesso`** + 83 `nunca-tentado` = 1302 (bate com o controle: 1219 já enriquecidos, 1302 no total); **0 incoerentes** |
> | reload do PostgREST | provado pela contagem: **40 → 41 relações**; API passou de 12 para 14 colunas |
> | backend deployado | `:hub-enriq-auto-3952eb3` (rollback `:hub-sessao-fix-1e281d0`), node v20.20.2, 1/1, bundle provado DENTRO do container servindo |
> | smoke | painel/hub/motorista **200**; rotas do backend **401**; controle de rota inexistente **404** |
>
> **Habilitação da empresa 6 aplicada em 2026-09-10 01:39 UTC** (`ativo=true`,
> `teto=100`, `desde=now()`), com autorização própria do operador. Retroatividade
> provada em **0**: nenhum entregador existente é alcançável pelo gatilho, porque
> todos foram criados antes do `desde`. Volume esperado: ~8 novos/dia, folgado
> abaixo do teto.
>
> ⚠️ Durante o smoke descobriu-se um incidente **alheio a esta entrega**: 7
> certificados TLS expirados no host. Resolvido em sessão separada (PRs #172/#173);
> a causa foi SAN de domínio removido do DNS travando a renovação, não este deploy.

Cria as duas colunas de desfecho/origem em `Entregador`, a tabela
`EnriquecimentoAutomatico` (com RLS) e o gatilho `trg_entregador_enfileira_import`
no `chatmasterveloz` (container `pgadmin_db`, host VPSTodo).

🟢 **Decisão do operador em 2026-09-09**: aplicar a migration **inteira**, e **NÃO
inserir nenhuma linha em `EnriquecimentoAutomatico`**. Sem essa linha o gatilho é
inerte — nenhum motorista novo é enfileirado e o volume de dados pessoais coletados
não muda. O ganho imediato é o desfecho da tentativa passar a ser gravado e o pedido
manual furar a fila.

🔴 **NÃO EXECUTAR** o `INSERT INTO "EnriquecimentoAutomatico"`. Habilitar uma empresa
é ato separado, com autorização própria.

⚠️ **O container do banco é uma task do Swarm**: o nome real é `pgadmin_db.1.<hash>`
e muda a cada reagendamento. Todos os comandos resolvem o ID com
`docker ps -qf name=pgadmin_db` — `docker exec pgadmin_db` responde "No such container".

⚠️ O agente **não executa** nada daqui — o classificador o bloqueia no `pgadmin_db`
até em leitura. Cole cada comando com `!`.

⚠️ **Heredoc colado no terminal colapsa** (incidente de 2026-08-18): os comandos
abaixo leem de arquivo, nunca de heredoc.

## Gate 1 — autorização

Dada em 2026-09-09 para **esta** mudança específica, com o escopo acima (migration
completa, nenhuma empresa habilitada). Não se estende a habilitar tenant.

## Gate 2 — janela

Aplicado às ~21:20 BRT de 09/09. Próximo import do robô: **10/09 às 11:00** — 13 h
de folga. Fila de enriquecimento **vazia** (rodadas retornando `sem_dados`), então
uma rodada perdida não custa nada.

Impacto esperado: **nenhum** para usuários.
- `ADD COLUMN ... NOT NULL DEFAULT` com default não-volátil é **metadata-only** no
  PostgreSQL ≥ 11 — não reescreve a tabela, não tranca de forma relevante.
- O backfill loteado (`UPDATE ... SET dados_entrego_desfecho='sucesso'`) toca só
  quem já tem `dados_entrego_enriquecidos_em` — ~1.2 mil linhas, um lote de 5.000.

## Gate 3 — rollback à mão ANTES de aplicar

**3.1 — a migration ALTERA DADOS (backfill), então tire o dump da tabela primeiro:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"Entregador\"" --data-only' > ~/entregador-antes-0060.sql; wc -l ~/entregador-antes-0060.sql
```

Confira que **não saiu vazio** antes de seguir. O arquivo contém CPF/RG/CNH —
mantenha no host, não circule.

**3.2 — rollback (só se necessário), em ordem inversa:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1 -c "
DROP TRIGGER IF EXISTS trg_entregador_enfileira_import ON \"Entregador\";
DROP FUNCTION IF EXISTS hub_entregador_enfileira_import();
DROP TABLE IF EXISTS \"EnriquecimentoAutomatico\";
ALTER TABLE \"Entregador\" DROP COLUMN IF EXISTS dados_entrego_desfecho;
ALTER TABLE \"Entregador\" DROP COLUMN IF EXISTS dados_entrego_solicitado_manual;
DELETE FROM \"SchemaMigration\" WHERE nome = '"'"'0060_entregador_enfileira_novo_e_desfecho.sql'"'"';"'
```

⚠️ O rollback do **backend** é independente e vem antes deste: se o backend novo já
estiver no ar, derrubar as colunas quebra o PATCH do robô. Ordem de rollback:
backend primeiro (`:hub-sessao-fix-1e281d0`), banco depois.

## Gate 4 — aplicar

A migration é idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`).

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' < /var/lib/envioMassa_homologacao/infra/hub/migrations/0060_entregador_enfileira_novo_e_desfecho.sql
```

**Registrar em `SchemaMigration`** — a tabela tem sequence, então **nunca informe
`id`** (lição do #154: aplicar fora do `migrate.sh` faz a `SchemaMigration` mentir):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0060_entregador_enfileira_novo_e_desfecho.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
```

## Gate 5 — smoke test (antes de o backend subir)

**5.1 — as duas colunas, a tabela e o gatilho existem; e a tabela está VAZIA:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F"|" -c "
SELECT '\''colunas'\'', count(*) FROM information_schema.columns WHERE table_name='\''Entregador'\'' AND column_name IN ('\''dados_entrego_desfecho'\'','\''dados_entrego_solicitado_manual'\'')
UNION ALL SELECT '\''gatilho'\'', count(*) FROM pg_trigger WHERE tgname='\''trg_entregador_enfileira_import'\''
UNION ALL SELECT '\''habilitacoes (DEVE SER 0)'\'', count(*) FROM \"EnriquecimentoAutomatico\";"'
```

Esperado: `colunas|2`, `gatilho|1`, `habilitacoes (DEVE SER 0)|0`.

**5.2 — o backfill acertou (ninguém enriquecido continua 'nunca-tentado'):**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F"|" -c "
SELECT dados_entrego_desfecho, count(*) FROM \"Entregador\" GROUP BY 1 ORDER BY 2 DESC;
SELECT '\''INCOERENTES (deve ser 0)'\'', count(*) FROM \"Entregador\" WHERE dados_entrego_enriquecidos_em IS NOT NULL AND dados_entrego_desfecho <> '\''sucesso'\'';"'
```

**5.3 — recarregar o PostgREST** (sem isso a API não conhece as colunas novas):

```
! docker kill -s SIGUSR1 $(docker ps -qf name=postgrest | head -1)
```

⚠️ **Sonda HTTP em `/rpc/` NÃO prova o reload** (lição de 2026-08-18) — confira a
contagem de funções no log:

```
! docker logs --tail 5 $(docker ps -qf name=postgrest | head -1)
```

Depois disso, **me mande a saída de 5.1, 5.2 e do log do PostgREST**. Eu provo a
coluna pela API e sigo com o `docker service update` do backend.
