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

PASS: 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20.
PASS-parcial (parte do operador): 6 (comparar fingerprints), 8 (criar DNS),
17 (confirmar inexistência de `SchemaMigration` em produção).
OPERADOR: 1 (estado/contagens de produção antes/depois).

## Ações pendentes do OPERADOR (fecham o G2)

1. **Item 1** — no VPSTodo, conferir produção intocada:
   ```bash
   docker service ps pgadmin_db --format '{{.Name}} {{.CurrentState}}'
   # e no banco chatmasterveloz:  SELECT max(id) FROM "EnvioMassa";
   ```
2. **Item 6/13** — calcular fingerprints dos segredos de produção (mesmo método,
   builtin do bash, sem newline) e registrá-los em
   `/var/lib/hub_secrets/prod-fingerprints.sha256`:
   ```bash
   printf '%s' "$SEGREDO_DE_PRODUCAO" | sha256sum
   # formato do arquivo: <sha256>  <NOME_DA_VAR>
   ```
   Conferir que diferem dos hashes do hub em `testes-isolamento-saida.txt` (item 6).
3. **Item 17** — em produção (somente leitura):
   ```sql
   SELECT to_regclass('public."SchemaMigration"');  -- esperado: NULL
   ```
4. **Item 8 / DNS** — criar `hub-homolog.todo-tips.com` → A/AAAA para o IP do
   VPSTodo. Acesso: `https://hub-homolog.todo-tips.com:8443` (certificado
   self-signed — decisão de design da S1; promoção a TLS válido via rota no
   Traefik de produção é opcional e só o operador executa; ver RUNBOOK).

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
