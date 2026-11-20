# postgrest-guard — alarme do PostgREST de produção

Avisa por e-mail quando o `pgadmin_postgrest` para de conseguir falar com o banco.
Roda a cada 5 minutos no host VPSTodo.

## Por que existe

Em 2026-11-20, das 14:38 às 16:22 UTC, o PostgREST (v14.1) ficou com o pool
"cheio" **sem nenhuma conexão real** e respondeu 503/504 a tudo. Todos os logins
caíram (painel, hub e app motorista). Banco, disco e rede estavam saudáveis. Ele
não se recuperou sozinho, e a primeira notícia veio dos usuários, 1h45 depois.

## O que ele faz

Conta, no `docker logs --since 5m` do container, as linhas com `PGRST000`–`PGRST003`
(erros de conexão, pool e schema cache).

| Situação | Critério | O que acontece |
|---|---|---|
| ok | < 5 erros em 5 min | silêncio, `exit 0` |
| fora | ≥ 5 erros em 5 min | e-mail com contagem, diagnóstico e comando de correção, `exit 1` |
| ausente | nenhum container do serviço rodando | e-mail, `exit 1` |
| normalizou | voltou a `ok` depois de alerta | e-mail "NORMALIZADO" |

`exit 2` significa que o próprio guard falhou. Isso nunca é confundido com "ok".

**Por que esse sinal:** em 6 semanas de log, esses códigos só apareceram na subida
de 08/10 e no incidente. A queda crônica da conexão LISTEN, a cada ~2h, **não** os
gera (reconecta em 1 s). E o sinal não depende de usuário: o `adiantamento-worker`
chama o PostgREST a cada 60 s, então um travamento de madrugada também gera
~4 erros/min.

**O que ele não faz:** não reinicia nada. Restart é escrita em produção e exige o
rito (`CLAUDE.md`). O e-mail traz o comando pronto.

**Anti-ruído:** reavisa a cada `REAVISO_HORAS` (1 h) enquanto durar. O estado
fica em `/var/lib/hub_secrets/postgrest-guard-estado.json`.

## Canal de e-mail

O mesmo do `disco-guard`: SMTP do robô (`infra/robo-entrego/src/alerta-email.js`
+ `GMAIL_*`/`ALERTA_DESTINATARIOS` de `/var/lib/hub_secrets/robo-entrego/.env`).

## Instalar (operador — escrita no host)

```bash
sudo systemctl link /var/lib/envioMassa_homologacao/infra/producao/postgrest-guard.service
sudo systemctl link /var/lib/envioMassa_homologacao/infra/producao/postgrest-guard.timer
sudo systemctl daemon-reload
sudo systemctl enable --now postgrest-guard.timer
systemctl list-timers postgrest-guard.timer
```

Desfazer: `sudo systemctl disable --now postgrest-guard.timer`.

## Conferir sem enviar e-mail

```bash
node /var/lib/envioMassa_homologacao/infra/producao/postgrest-guard.js --dry-run

# reproduzir o incidente de 2026-11-20 contra o container parado (se ainda existir):
POSTGREST_CONTAINER=29e17ab1b386 POSTGREST_JANELA_MIN=180 POSTGREST_ESTADO=/tmp/pg-estado.json \
  node .../postgrest-guard.js --dry-run
```

## Ajustes (env no `.service`)

`POSTGREST_SERVICO` (pgadmin_postgrest) · `POSTGREST_CONTAINER` (id fixo) ·
`POSTGREST_JANELA_MIN` (5) · `POSTGREST_LIMIAR` (5) · `REAVISO_HORAS` (1) ·
`POSTGREST_ESTADO`.

## Testes

```bash
node --test /var/lib/envioMassa_homologacao/infra/producao/postgrest-guard.test.js
```

16 casos, com linhas de log reais do incidente e da queda do LISTEN.
