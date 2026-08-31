# disco-guard — alarme de espaço em disco

Avisa **antes** de o disco encher. Roda de hora em hora no host VPSTodo.

## Por que existe

Em 2026-08-30 o `/` (150 GB) chegou a 100% e derrubou o Postgres de produção:

```
FATAL: could not write lock file "postmaster.pid": No space left on device
```

O `pgadmin_db` entrou em crash loop e a **primeira notícia do problema foi o banco
caindo**. O rito de build passou a exigir `df -h /` (`CLAUDE.md`), mas isso cobre
só builds — log, dump ou volume crescendo continuariam sem aviso.

## O que ele faz

| Faixa | Livre | O que acontece |
|---|---|---|
| ok | ≥ 20 GB | silêncio, `exit 0` |
| alerta | < 20 GB | e-mail + `exit 1` (unidade fica `failed`) |
| crítico | < 8 GB | e-mail com assunto CRÍTICO + `exit 1` |

`exit 2` = o próprio guard falhou (ex.: `df` não respondeu). Nunca é confundido
com "disco ok" — é o erro que mais importa não engolir.

O e-mail traz os números e **os comandos seguros de limpeza**, além do que nunca
fazer (`system prune -a` apagaria as imagens de rollback; `--volumes` destruiria
`envio_massa_hub_uploads`, com os arquivos originais das importações).

### Anti-ruído

Rodando de hora em hora, um disco baixo geraria 24 e-mails por dia até alguém
agir — e e-mail repetido vira ruído que se aprende a ignorar, que é o oposto de um
alarme. O guard guarda a faixa em `/var/lib/hub_secrets/disco-guard-estado.json` e
só reavisa quando **piora de faixa** ou depois de `REAVISO_HORAS` (6 por padrão).
A unidade continua `failed` enquanto o problema durar, mesmo com o e-mail suprimido.

## Canal de e-mail

Reusa o SMTP do robô (`infra/robo-entrego/src/alerta-email.js` e as chaves
`GMAIL_EMAIL` / `GMAIL_APP_PASSWORD` / `ALERTA_DESTINATARIOS` de
`/var/lib/hub_secrets/robo-entrego/.env`). Um segundo canal seria mais uma coisa
para configurar, quebrar e esquecer.

Sem SMTP configurado, o alerta ainda aparece no journal e a unidade fica `failed`.

## Instalar (operador — escrita no host)

```bash
sudo systemctl link /var/lib/envioMassa_homologacao/infra/producao/disco-guard.service
sudo systemctl link /var/lib/envioMassa_homologacao/infra/producao/disco-guard.timer
sudo systemctl daemon-reload
sudo systemctl enable --now disco-guard.timer
systemctl list-timers disco-guard.timer
```

⚠️ `systemctl link` aponta para o arquivo **dentro do repositório** — o mesmo
padrão do `robo-entrego` e do `backup-producao`. Isso significa que um
`git checkout` de outra branch muda o que roda. É o comportamento já aceito neste
host, mas vale lembrar.

## Conferir sem enviar e-mail

```bash
node /var/lib/envioMassa_homologacao/infra/producao/disco-guard.js --dry-run

# forçar o caminho de alerta (limiar absurdo), ainda sem enviar:
DISCO_LIMIAR_GB=999 node .../disco-guard.js --dry-run
```

## Ajustes (env no `.service`, se precisar)

`DISCO_ALVO` (/) · `DISCO_LIMIAR_GB` (20) · `DISCO_LIMIAR_CRITICO_GB` (8) ·
`REAVISO_HORAS` (6) · `DISCO_ESTADO` (arquivo de estado).

O limiar de 20 GB está alinhado com o piso que o `CLAUDE.md` exige antes de um
build — o objetivo é avisar **antes** de o próximo build ser bloqueado por falta
de espaço, não depois.

## Testes

```bash
node --test /var/lib/envioMassa_homologacao/infra/producao/disco-guard.test.js
```

13 casos, cobrindo as duas formas de um alarme falhar em silêncio: não avisar
quando devia, e avisar tanto que ninguém lê.
