# Runbook — provisionar o usuário de serviço do robô em PRODUÇÃO

Aplica `infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql` no banco
`chatmasterveloz` (container `pgadmin_db`, host VPSTodo).

⚠️ **Isto é o banco do cliente.** Rito dos 5 gates do `CLAUDE.md` obrigatório.
O agente **não executa** nenhum passo daqui — o classificador o bloqueia no
`pgadmin_db` até em leitura. Todos os comandos são para o operador colar com `!`.

## Gate 1 — autorização
Autorização explícita do operador para **esta** mudança específica. Não vale a
autorização do `hub-homolog` (dec-045, ambiente isolado) nem qualquer outra anterior.

## Gate 2 — janela
Combinar com o operador. Impacto esperado: **nenhum** para usuários atuais — o script
só insere um papel, um usuário e um vínculo novos. Não altera dado existente, não
tranca tabela relevante, não faz DDL destrutiva.

## Gate 3 — rollback à mão ANTES de aplicar

Backup das 4 tabelas tocadas (a memória do projeto registra: `psql` em produção é
`docker exec` no container + `$POSTGRES_USER` interno):

```
! docker exec pgadmin_db sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz \
    -t "\"Papel\"" -t "\"PapelPermissao\"" -t "\"Usuario\"" -t "\"UsuarioEntidade\"" \
    --data-only' > ~/backup-robo-entrego-$(date +%Y%m%d-%H%M%S).sql
```

Confira que o arquivo não saiu vazio antes de seguir:

```
! ls -la ~/backup-robo-entrego-*.sql | tail -1
```

**Rollback** (só se necessário): remover na ordem inversa das FKs —
`UsuarioEntidade` → `Usuario` → `PapelPermissao` → `Papel`, filtrando pelo e-mail do
serviço e pelo nome do papel criado. O script é idempotente, então reaplicar é seguro;
o rollback só é necessário se você quiser desfazer de fato.

## Gate 4 — aplicar

O `senha_servico` deve ser **exatamente** o `HUB_SERVICO_SENHA` que já está em
`/var/lib/hub_secrets/robo-entrego/.env`, e o `email_servico` o `HUB_SERVICO_EMAIL`.
Se divergirem, o robô autentica com uma credencial que não existe.

⚠️ A senha aparece na linha de comando e vai para o histórico do shell. Prefixe o
comando com um espaço (com `HISTCONTROL=ignorespace`) ou limpe o histórico depois.

```
! docker exec -i pgadmin_db sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz \
    -v email_servico='"'"'<HUB_SERVICO_EMAIL>'"'"' \
    -v senha_servico='"'"'<HUB_SERVICO_SENHA>'"'"'' \
    < /var/lib/envioMassa_homologacao/infra/robo-entrego/sql/001-usuario-servico-robo-entrego.sql
```

Heredoc colado no terminal colapsa (registrado na memória do projeto) — por isso o
script vai por redirecionamento de arquivo, não por heredoc.

## Gate 5 — smoke test

**5.1 — o usuário existe, está ativo e tem o vínculo certo** (não imprime senha):

```
! docker exec pgadmin_db sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT u.id, u.email, u.ativo, ue.empresa_id, p.nome AS papel
FROM \"Usuario\" u
JOIN \"UsuarioEntidade\" ue ON ue.usuario_id = u.id
JOIN \"Papel\" p ON p.id = ue.papel_id
WHERE u.email = '\''<HUB_SERVICO_EMAIL>'\'';"'
```

Esperado: 1 linha, `ativo = t`, `empresa_id = 6`.

**5.2 — as permissões do papel são só as duas** (least-privilege de fato):

```
! docker exec pgadmin_db sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "
SELECT pe.nome FROM \"Papel\" p
JOIN \"PapelPermissao\" pp ON pp.papel_id = p.id
JOIN \"Permissao\" pe ON pe.id = pp.permissao_id
WHERE p.nome LIKE '\''%robo%entrego%'\'' ORDER BY pe.nome;"'
```

Esperado: exatamente `importacoes.consultar` e `importacoes.criar`. Qualquer permissão
a mais é desvio do least-privilege e deve ser investigada antes de seguir.

**5.3 — login real pela API** (a prova que importa; sem expor a senha no output):

```
! curl -s -o /dev/null -w 'login: HTTP %{http_code}\n' -X POST \
    https://app.moveelog.com.br/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d @<(jq -n --arg e '<HUB_SERVICO_EMAIL>' --arg s '<HUB_SERVICO_SENHA>' \
          '{email:$e, senha:$s}')
```

Esperado: **HTTP 200**. Um 401 significa senha divergente entre o banco e o `.env`.

## Depois

Com o usuário provisionado e o login em 200, o passo seguinte é o **deploy do backend**
(leva `POST /api/v1/robo-entrego/eventos`), que tem o seu próprio rito de 5 gates — e
depois a **primeira execução assistida** do robô, antes de ligar o timer.
