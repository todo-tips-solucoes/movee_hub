# Runbook — conceder ao robô as permissões de enriquecimento EntreGô em PRODUÇÃO

Aplica `infra/robo-entrego/sql/003-permissoes-enriquecimento-robo-entrego.sql` no
banco `chatmasterveloz` (container `pgadmin_db`, host VPSTodo), feature
`hub-motorista-360` (FASE 2, tasks.md 2.4).

⚠️ **Isto é o banco do cliente.** Rito dos 5 gates do `CLAUDE.md` obrigatório. O
agente **não executa** nenhum passo daqui — o classificador o bloqueia no
`pgadmin_db` até em leitura. Todos os comandos são para o operador colar com `!`.

⚠️ **Pré-requisitos, na ordem**:
1. As migrations `0057_entregador_entrego_enriquecimento.sql`,
   `0058_rpc_motoristas_candidatos_por_conta.sql` e
   `0059_seed_permissao_motoristas_dados_sensiveis.sql` (série do hub,
   `infra/hub/migrations/`) já aplicadas em produção — este script depende do
   módulo `motoristas` (já existente) e falha com `RAISE EXCEPTION` se não achar.
   Aplicação dessas 3 migrations em produção segue o rito integral próprio
   (fora do escopo deste runbook — não confundir com a validação isolada já
   feita em `hub-homolog`).
2. `infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql` (ou o
   `002-corrige-usuario-servico.sql`) já aplicado — este script exige que o
   papel `robo_entrego_servico` já exista e falha com `RAISE EXCEPTION` senão.

## Gate 1 — autorização
Autorização explícita do operador para **esta** mudança específica. Não vale a
autorização do `hub-homolog` (ambiente isolado) nem qualquer autorização anterior
(inclusive a do 001/002).

## Gate 2 — janela
Impacto esperado: **nenhum** para usuários atuais. O script só insere 2 linhas em
`Permissao` e concede-as ao papel `robo_entrego_servico` — não altera dado
existente, não tranca tabela relevante, não faz DDL destrutiva.

## Gate 3 — rollback à mão ANTES de aplicar

Backup das 2 tabelas tocadas:

```
! docker exec pgadmin_db sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz \
    -t "\"Permissao\"" -t "\"PapelPermissao\"" --data-only' \
    > ~/backup-robo-entrego-enriquecimento-$(date +%Y%m%d-%H%M%S).sql
```

Confira que o arquivo não saiu vazio antes de seguir:

```
! ls -la ~/backup-robo-entrego-enriquecimento-*.sql | tail -1
```

**Rollback** (só se necessário): o script é idempotente (`ON CONFLICT DO
NOTHING`), então reaplicar nunca piora nada; para desfazer de fato, remover as 2
linhas de `PapelPermissao` que ligam `robo_entrego_servico` às permissões
`motoristas.enriquecimento.*`, depois as 2 linhas de `Permissao` (só se nenhum
outro papel as usar).

## Gate 4 — aplicar

Nenhum parâmetro (`-v`) é necessário — o script resolve `modulo_id`/`papel_id`
por nome. Heredoc colado no terminal colapsa (registrado na memória do
projeto) — por isso vai por redirecionamento de arquivo, não por heredoc.

```
! docker exec -i pgadmin_db sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz' \
    < /var/lib/envioMassa_homologacao/infra/robo-entrego/sql/003-permissoes-enriquecimento-robo-entrego.sql
```

Esperado no output: `NOTICE: 003: permissoes motoristas.enriquecimento.consultar/.atualizar concedidas ao papel robo_entrego_servico (id=N)`.

## Gate 5 — smoke test

**5.1 — as permissões do papel agora são exatamente 4** (as 2 de `importacoes.*`
do 001/002 + as 2 novas — least-privilege de fato, nada além disso):

```
! docker exec pgadmin_db sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT pe.codigo FROM \"Papel\" p
JOIN \"PapelPermissao\" pp ON pp.papel_id = p.id
JOIN \"Permissao\" pe ON pe.id = pp.permissao_id
WHERE p.nome = '\''robo_entrego_servico'\'' ORDER BY pe.codigo;"'
```

Esperado: exatamente `importacoes.consultar`, `importacoes.criar`,
`motoristas.enriquecimento.atualizar`, `motoristas.enriquecimento.consultar`.
Qualquer permissão a mais (em especial `motoristas.dados_sensiveis`,
`motoristas.credencial` ou `motoristas.editar`) é desvio do least-privilege e
deve ser investigado antes de seguir.

**5.2 — chamada autenticada como o robô às rotas de fila retorna 200/202**
(depende do backend da FASE 4 desta feature já estar deployado — se ainda não
estiver, este passo fica pendente e o Gate 5 só confirma 5.1):

```
! curl -s -o /dev/null -w 'fila: HTTP %{http_code}\n' \
    -H "Authorization: Bearer <token do robô>" \
    https://app.moveelog.com.br/api/v1/hub/motoristas/enriquecimento/fila
```

Esperado: **HTTP 200 ou 202** (nunca 403 — 403 significa que a permissão não
chegou a valer para essa rota).

## Depois

Com as permissões concedidas e o smoke 5.1 confirmado, o robô passa a poder
consultar/atualizar a fila de enriquecimento nas suas janelas normais
(11h/13h/14h) assim que o backend da FASE 4 desta feature estiver deployado —
não antes.
