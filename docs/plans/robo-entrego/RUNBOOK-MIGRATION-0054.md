# Runbook — aplicar a migration 0054 em PRODUÇÃO

Remove 7 CHECK constraints do `chatmasterveloz` (container `pgadmin_db`, host VPSTodo).

🔴 **Corrige uma regressão que está ativa agora**: a aplicação aceita `-1` e
texto-como-`0` (PRs #132/#134, já deployados), mas o banco recusa. Uma importação
com qualquer valor negativo termina em `failed` e perde **todas** as linhas.

⚠️ **O container do banco é uma task do Swarm**: o nome real é
`pgadmin_db.1.<hash>` e o hash muda a cada reagendamento. Por isso todos os
comandos resolvem o ID com `docker ps -qf name=pgadmin_db` em vez de usar o nome
puro — `docker exec pgadmin_db` responde "No such container".

⚠️ O agente **não executa** nada daqui — o classificador o bloqueia no `pgadmin_db`
até em leitura. Todos os comandos são para o operador colar com `!`.

## Gate 1 — autorização
Autorização explícita para **esta** mudança. Não vale a do deploy do backend.

## Gate 2 — janela
Impacto esperado: **nenhum** para usuários. `DROP CONSTRAINT` não reescreve dados e
não tranca a tabela de forma relevante. O hub ainda não tem usuários ativos.

## Gate 3 — rollback à mão ANTES de aplicar

A migration é `DROP`, então o rollback é recriar as constraints. Guarde as
definições atuais **antes**:

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F"|" -c "
SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
WHERE con.contype = '\''c'\''
  AND rel.relname IN ('\''PerformanceTurno'\'',''\''FaturamentoLancamento'\'')
ORDER BY rel.relname, con.conname;"' | tee ~/constraints-antes-0054.txt
```

Confira que o arquivo não saiu vazio antes de seguir. **Rollback** = recriar cada
uma com `ALTER TABLE … ADD CONSTRAINT <nome> CHECK (<definição>);` usando esse
arquivo. ⚠️ Só funciona se nenhum dado violando já tiver entrado — depois de a
rotina importar um `-1`, recriar a constraint exigirá limpar esses registros antes.

## Gate 4 — aplicar

A migration está versionada na série do hub e o `migrate.sh` a registra em
`SchemaMigration` (idempotente). Mas ela é `DROP … IF EXISTS`, então aplicar
direto também é seguro:

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
    < /var/lib/envioMassa_homologacao/infra/hub/migrations/0054_importa_valores_como_recebidos.sql
```

Esperado: 7 linhas `ALTER TABLE`.

## Gate 5 — smoke test

**5.1 — as 7 constraints sumiram, e as 2 que deviam ficar permanecem:**

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -c "
SELECT con.conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
WHERE con.contype = '\''c'\''
  AND rel.relname IN ('\''PerformanceTurno'\'',''\''FaturamentoLancamento'\'')
ORDER BY con.conname;"'
```

Esperado: **apenas** `FaturamentoLancamento_atingido_check` e
`PerformanceTurno_tempo_disponivel_pct_check`. Qualquer `corridas_*_check`,
`min_entregadores_escala_check` ou `valor_check` sobrando significa que o `DROP`
não pegou.

**5.2 — o banco aceita negativo agora** (INSERT descartado por `ROLLBACK`, não
deixa dado de teste):

```
! CID=$(docker ps -qf name=pgadmin_db | head -1); docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
BEGIN;
INSERT INTO \"PerformanceTurno\" (id_empresa, entregador_id, data_periodo, periodo, praca, sub_praca, origem, corridas_rejeitadas)
VALUES (6, (SELECT entregador_id FROM \"PerformanceTurno\" LIMIT 1), '\''2099-01-01'\'', '\''TESTE'\'', '\''X'\'', '\''X'\'', '\''X'\'', -1);
ROLLBACK;"'
```

Esperado: `INSERT 0 1` seguido de `ROLLBACK` — sem erro de constraint. Se aparecer
`violates check constraint`, o gate 4 não surtiu efeito.

## Depois

Com a 0054 aplicada, o ciclo está completo em produção: aplicação e banco
concordam. Avise o agente — ele confirma por HTTP e, aí sim, faz sentido religar
o timer (`sudo systemctl enable --now robo-entrego.timer`).

A validação equivalente já foi feita no `hub-homolog`: importação `id=80`,
`status=completed`, 4/4 linhas, com `-1` preservado e texto/vazio gravados como `0`.
