# Runbook — virada do login do app motorista para a ContaMotorista (08/11)

Contexto e decisões: [`BRIEFING-VIRADA-0811.md`](BRIEFING-VIRADA-0811.md). A chave é
`HUB_MOTORISTA_LOGIN_CONTA_ATIVA` (liga só com o valor exato `true`). Todos os passos escrevem no
ambiente vivo (exceto o 1): valem os 5 gates do `CLAUDE.md` — autorização para esta mudança, janela
combinada, rollback à mão, `service update --image/--env-*` (nunca `stack deploy`) e smoke.

**Pré-requisito:** backend com o refresh que relê o banco (D1) já deployado. Sem ele, ligar a chave
deixa o refresh sem checar `ativo`/`senha` (continua como hoje, mas sem a simetria).

## 1. Prontidão (só leitura — `PRONTO` obrigatório)

```bash
cd /var/lib/envioMassa_homologacao
PGOPTIONS='-c default_transaction_read_only=on' docker exec -i -e PGOPTIONS pgadmin_db \
  psql -U chatmasterveloz -d chatmasterveloz -v ON_ERROR_STOP=1 -At \
  < infra/hub/scripts/prontidao-login-hub.sql
```

A **última linha** é o veredito. `PRONTO` → seguir. `NAO PRONTO: N motoristas perderiam acesso` →
**parar**. Linhas com `motivo=cnpj migrado` (e a linha `AVISAR: N motoristas devem passar a usar o
CNPJ novo`) **não bloqueiam** a virada, e não entram na contagem do `NAO PRONTO`: a conta do hub
foi movida para o CNPJ novo com a mesma senha. Mas esses motoristas precisam ser **avisados ANTES de
08/11**, porque com a chave ligada o CNPJ antigo deixa de entrar (passam a entrar só pelo CNPJ novo,
com a mesma senha).
Em `NAO PRONTO`, as linhas listam id, nome, CNPJ mascarado e motivo (sem conta / senha diferente /
ativo diferente). Não ligar a chave; devolver ao operador.

## 2. Anotar o env atual (rollback)

```bash
docker service inspect envio-massa-homologacao_backend_homologacao \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep '^HUB_MOTORISTA_LOGIN_CONTA_ATIVA=' || echo "(variavel ausente)"
docker service ls --filter name=envio-massa-homologacao_backend --format '{{.Name}}\t{{.Image}}'
```

Esperado: variável ausente (chave desligada). Anotar a imagem também.

## 3. Ligar a chave

```bash
docker service update --with-registry-auth \
  --env-add HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true \
  envio-massa-homologacao_backend_homologacao
```

## 4. Provar no processo vivo

```bash
CID=$(docker ps --filter name=envio-massa-homologacao_backend_homologacao --format '{{.ID}}' | head -1)
docker exec "$CID" printenv HUB_MOTORISTA_LOGIN_CONTA_ATIVA   # deve imprimir: true
```

(`docker service ps` pode listar tarefas antigas; conferir que o container é o novo.)

## 5. Smoke (HTTP, sem expor segredos)

- Login de uma conta **conhecida** pelo app (`https://app.motorista.moveelog.com.br`, o próprio
  operador, com a senha dele): entra e a home carrega.
- Senha errada para o mesmo CNPJ: **401** `Credenciais inválidas.`
- Aguardar o `000` pós-deploy se aparecer (timing do Traefik): conferir `docker logs` do container e repetir
  antes de declarar queda.

## 6. Reversão

```bash
docker service update --with-registry-auth \
  --env-rm HUB_MOTORISTA_LOGIN_CONTA_ATIVA \
  envio-massa-homologacao_backend_homologacao
```

Usar se, após ligar: motoristas legítimos não conseguem entrar (login 401/403 em massa) ou o smoke do
passo 5 falha. O login volta a ler a tabela `Motorista` (os gatilhos mantêm as duas iguais, então a
reversão não perde senha alterada). Repetir o passo 4 (agora `printenv` não imprime nada) e o 5.

## Ensaio no staging (2026-11-01)

A chave foi ligada no `hub-homolog` com o backend desta entrega, e o smoke de refresh rodou nos
dois modos:
- **Chave desligada: 6/6.** Login 200 e refresh 200. Desativar no hub dá refresh 401 com os
  cookies limpos; resetar dá refresh 401.
- **Chave ligada: 5/7.** As mesmas checagens passaram. As 2 falhas são da dívida abaixo.

⚠️ **Dívida conhecida, que não bloqueia a virada:** com a chave ligada, o login **não** coloca
`entregadorUuid` no token. `resolverEntregadorUuid` lê `Entregador` pelo PostgREST do hub **sem
claims**, a RLS por escopo devolve vazio sem erro, e a função retorna `null`. Isso já existia antes
desta frente; o refresh preserva o que o login emitiu. O único efeito é que o carimbo
`EnvioMassa.entregador_uuid` na validação de nota (best-effort, que nunca bloqueia) não acontece. Ele
também nunca aconteceu em produção (0 movimentos com o campo preenchido). Correção: uma função
SECURITY DEFINER que devolva o `id_externo` pelo `conta.id` (migration nova), numa frente própria.

## 7. Depois de OK

Atualizar o `CLAUDE.md` e a memória do projeto registrando que **a chave está ligada em produção**
(data, imagem do backend, resultado da prontidão e do smoke). A aposentadoria da tabela `Motorista` e
do gatilho G4 fica para depois de 08/11.
