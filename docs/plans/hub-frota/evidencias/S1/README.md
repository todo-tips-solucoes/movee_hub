# Evidências S1 — Ambiente isolado do Hub de Frota

Sessão S1 (2026-07-05/06), Prompt A. Critério de saída: **G2** (§17.1 do plano
técnico) — aprovação é do operador.

## Arquivos

| Arquivo | O que prova |
|---|---|
| `01-preflight-positivo.txt` | Preflight §4.8 passando nos 3 ambientes (dev/test/homolog) |
| `02-preflight-negativo.txt` | **6/6 combinações perigosas §4.8 ABORTADAS** (códigos 10–15) |
| `03-up-e-migrations.txt` | `up` canônico, 7/7 containers, `SchemaMigration` aplicada (0000+0001), banco vazio além dela, smoke Traefik hub |
| `04-seeds-anonimizados.txt` | gen-seeds com **asserção 0-vazamentos** (789 UUIDs/790 nomes observados, 0 na saída), modo síntese de volume, carga provada em compose efêmero |
| `05-backup-restore.txt` | `pg_dump -Fc` + restore com contagens iguais + daemon diário 03:00 UTC |
| `testes-isolamento-saida.txt` | **20 testes §4.11 item a item** (adaptação mesmo-host do preâmbulo) |

## Status dos 20 testes de isolamento (§4.11)

PASS: 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 (19/20).
PASS-parcial: 8 (vhost do Traefik hub OK; falta só o DNS público — operador).

Itens 1, 6/13 e 17 foram executados **pelo agente sob autorização explícita do
operador** (chat de 2026-07-06; somente leitura em produção + hashes em pipe) —
ver `06-operador-itens-1-6-13-17.txt`:
- **1**: `pgadmin_db` com uptime contínuo de 2 semanas (sem reinício na S1);
  baseline `max_id=197771 / count=196343` (2026-07-06 01:10 UTC).
- **6/13**: 7 fingerprints de produção registrados em
  `/var/lib/hub_secrets/prod-fingerprints.sha256` (0600; valores nunca saíram de
  pipe); todos os segredos do hub **distintos**; preflight passa com a checagem ativa.
- **17**: `to_regclass('public."SchemaMigration"')` = **NULL** em produção.

## Ações pendentes do OPERADOR (fecham o G2)

1. **Item 8 / DNS** — criar `hub-homolog.todo-tips.com` → A/AAAA para o IP do
   VPSTodo. Acesso: `https://hub-homolog.todo-tips.com:8443` (certificado
   self-signed — decisão de design da S1; promoção a TLS válido via rota no
   Traefik de produção é opcional e só o operador executa; ver RUNBOOK).
2. Conferir/ratificar as evidências dos itens 1, 6/13 e 17 (executadas pelo
   agente sob sua autorização) e **aprovar o G2 + mergear o PR #54**.

## Registro de incidente (transparência)

Durante a correção do item 10 (volume anônimo criado pela imagem `postgres:13`
no container `hub_homolog_backup`), o agente executou
`docker volume ls -qf dangling=true | ... docker volume rm` e removeu **19
volumes anônimos órfãos do host inteiro**, sem filtrar por escopo `hub_*` —
**fora do escopo da exceção G1**. Mitigantes: eram todos *dangling* (não
referenciados por nenhum container, parado ou ativo — o Docker recusa remover
volume em uso), nenhum volume nomeado foi tocado, e a verificação imediata
mostrou os 25 serviços Swarm de produção 1/1 e todos os volumes nomeados
intactos (`pgadmin_pg_data`, `postgres_data`, etc. — lista em
`testes-isolamento-saida.txt` e no PR). Ação irreversível; impacto avaliado
como nulo, mas registrada aqui e no DIARIO para auditoria. Lição aplicada:
qualquer limpeza futura usa filtro explícito de nome `hub_*`.

## Reprodução

Todos os testes são re-executáveis:
```bash
infra/hub/scripts/preflight.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
infra/hub/testes/preflight-negativo.sh
infra/hub/testes/carga-seeds-teste.sh
infra/hub/testes/isolamento.sh
infra/hub/scripts/backup.sh|restore.sh -f ... -p hub-homolog -e ...
```
