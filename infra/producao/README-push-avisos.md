# Ferramentas de operação dos avisos por Web Push

Três scripts para operar e conferir o push do app motorista **em produção**
(`chatmasterveloz` + `app.moveelog.com.br`). Nasceram do cenário 21 (SC-003) em
2026-09-16, quando ficou claro que preencher a tela de aviso dez vezes não é
teste, é paciência.

| Script | O que faz | Toca o quê |
|---|---|---|
| `push-avisos-inscricoes.sh [id_entregador]` | panorama das inscrições: totais por plataforma, serviço de push e chave VAPID, últimas registradas e — com o id — as da conta daquele entregador | só leitura no banco |
| `push-avisos-disparar.sh` | `buscar` o id de um motorista, medir `alcance` e criar N avisos de teste | API do hub (cria aviso de verdade) |
| `push-avisos-conferir.sh [N]` | entregas dos últimos N avisos por status e serviço de push + latência no servidor (mediana/p95/máx) | só leitura no banco + contagens no log |

Nenhum deles imprime CNPJ, nome, título, corpo ou endpoint completo — no máximo
o host do serviço de push e a conta em hash. O payload do push trafega por
serviço de terceiro e não carrega PII; o mesmo cuidado vale para estas saídas.

## Credenciais do `push-avisos-disparar.sh`

Arquivo `600` com duas linhas, caminho em `$CRED` (padrão
`/var/lib/hub_secrets/.hub-api-login`):

```
email=voce@empresa.com
senha=suasenha
```

Crie num editor (`umask 077 && nano …`), nunca por linha de comando — argumento
vai para o histórico do shell e para a lista de processos. O arquivo fica fora
do git, como todo segredo em `/var/lib/hub_secrets/`.

## Duas coisas que mudam como se testa

⚠️ **`toda_base` alcança motorista real.** Em 2026-09-16 havia 121 inscrições
ativas de 115 contas distintas. Dez avisos de teste em `toda_base` seriam 1.210
notificações para gente que não pediu. Por isso o `push-avisos-disparar.sh`
**não implementa** esse modo — só `individual` — e ainda aborta acima de 5
aparelhos, a não ser que a frase exata seja repetida em `ALCANCE_GRANDE_OK`.
Para disparo real a gente usa a tela, que tem a confirmação do produto.

⚠️ **Sair do app apaga a inscrição daquele aparelho.** O
`contexts/auth-context.tsx` chama `revogarPush()` antes do `POST
/motorista/logout`, e `hub_push_inscricao_revogar` faz `DELETE FROM
"PushInscricao"` pelo `endpoint_hash` — é o FR-009 funcionando. Decorrência:
motorista deslogado some do alcance e não recebe aviso até entrar de novo (a
permissão do sistema continua concedida, então basta o login, sem reinstalar).
Não há sessão única: o refresh token do motorista é JWT sem registro no
servidor, então a mesma conta fica logada em vários aparelhos, cada um com sua
inscrição. **Antes de concluir que houve falha de entrega, meça o alcance** —
aparelho faltando é quase sempre logout.

## Sequência de um teste de entrega

```bash
bash infra/producao/push-avisos-disparar.sh buscar "parte do nome"   # -> id=NNN
bash infra/producao/push-avisos-inscricoes.sh NNN                    # aparelhos ativos
bash infra/producao/push-avisos-disparar.sh alcance NNN              # confirma o número
bash infra/producao/push-avisos-disparar.sh 10 NNN                   # dispara
bash infra/producao/push-avisos-conferir.sh 10                       # ~1 min depois
```

O resultado medido em 2026-09-16 (2 aparelhos, 20 entregas, 10 FCM + 10 Apple,
p95 de 0,3 s no servidor) está em
[`docs/plans/push-motorista/RUNBOOK-DEPLOY-PRODUCAO.md`](../../docs/plans/push-motorista/RUNBOOK-DEPLOY-PRODUCAO.md).
