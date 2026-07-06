# RUNBOOK — Ambiente isolado do Hub de Frota (S1)

Infra-as-code do ambiente dev/test/homolog do Hub (plano técnico
`docs/plans/hub-frota/01-plano-tecnico.md` §4–§6). **Alternativa B do G1
(2026-07-05): mesmo host (VPSTodo), isolamento Docker total, exceção standing
escopada a recursos `hub-*`.** Produção (Swarm `envio-massa-homologacao_*`,
banco `chatmasterveloz`, Traefik :80/:443, `*.moveelog.com.br`) é INTOCÁVEL —
CLAUDE.md, cláusula pétrea.

## Mapa do ambiente

| Ambiente | Projeto compose | Banco/usuário | Portas publicadas | APP_ENV |
|---|---|---|---|---|
| dev | `hub-dev` | `hub_dev` | 127.0.0.1:14801–14803 | `development` |
| test | `hub-test-<runid>` (efêmero) | `hub_test` (tmpfs) | nenhuma | `test` |
| homolog | `hub-homolog` | `hub_homolog` | 0.0.0.0:8880/8443 (Traefik do hub) | `homologation` |

Serviços do homolog: `db` (postgres:13, porta **não** publicada), `postgrest`
(v14.1, interno), `fastapi-mock`, `n8n-mock` (integrações reais inexistentes
por construção), `traefik` (2ª instância, portas altas, provider file, **sem
docker.sock**), `placeholder` (banner de ambiente até a S2), `backup`
(pg_dump -Fc diário). Redes: `hub_homolog_net` (**internal**) e
`hub_homolog_edge`. Volumes: `hub_homolog_pg_data`, `hub_homolog_backups`,
`hub_homolog_mocklogs`. Todos os serviços têm caps de CPU/RAM (incidente de
starvation 2026-06-11).

## Segredos (§4.8)

- Reais **somente** em `/var/lib/hub_secrets/` (dir 0700, arquivos 0600), fora
  do git. Templates versionados: `.env.hub.*.example` (placeholders `__GERAR__`).
- Gerar/regenerar: `infra/hub/scripts/gen-secrets.sh [--force]` — cria
  `.env.hub.{dev,test,homolog}`, TLS self-signed e o placeholder de
  fingerprints. Nada é copiado de produção.
- **Fingerprints de produção** (`/var/lib/hub_secrets/prod-fingerprints.sha256`):
  preenchido **pelo operador** com
  `printf '%s' "$TOKEN" | sha256sum` (builtin do bash — nunca `/usr/bin/printf`,
  que expõe o segredo em `ps`; sem newline). Com ele, o preflight garante que
  nenhum segredo do hub coincide com um de produção.
- Rotação: `gen-secrets.sh --force` + `down && up -d` do ambiente afetado.

## Subir um ambiente (up canônico)

Preflight é **obrigatório antes de todo primeiro `up`** (aborta se detectar
qualquer recurso de produção — §4.8):

```bash
cd /var/lib/envioMassa_homologacao

# HOMOLOG
infra/hub/scripts/preflight.sh -f infra/hub/compose.hub.homolog.yml \
  -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  --env-file /var/lib/hub_secrets/.env.hub.homolog up -d
infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml \
  -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog

# DEV
infra/hub/scripts/preflight.sh -f infra/hub/compose.hub.dev.yml \
  -p hub-dev -e /var/lib/hub_secrets/.env.hub.dev
docker compose -f infra/hub/compose.hub.dev.yml -p hub-dev \
  --env-file /var/lib/hub_secrets/.env.hub.dev up -d

# TEST (efêmero, um projeto por execução)
RUNID=$(date +%s)
docker compose -f infra/hub/compose.hub.test.yml -p hub-test-$RUNID \
  --env-file /var/lib/hub_secrets/.env.hub.test up -d
# ... suíte ...
docker compose -f infra/hub/compose.hub.test.yml -p hub-test-$RUNID down -v
```

**Nunca** `docker stack deploy`; **nunca** o projeto default; **nunca** tag
`latest` (preflight bloqueia).

## Migrations (§4.10)

Série única em `infra/hub/migrations/*.sql`, aplicada por
`scripts/migrate.sh` (idempotente; registra em `"SchemaMigration"`; envia
`SIGUSR1` ao PostgREST). Regras: DDL aditiva, rollback documentado por
migration, migration corretiva em vez de editar aplicada. Na S1 o banco é
**vazio + SchemaMigration + role do PostgREST** (0000/0001) — schema funcional
só nas fases S3+.

## Seeds anonimizados (§4.6)

```bash
# Gerar (rodar no sandbox context-mode; CSVs brutos nunca entram em contexto/git)
python3 infra/hub/scripts/gen-seeds.py            # 1 dia real → 1 dia anônimo
python3 infra/hub/scripts/gen-seeds.py --synthesize-days 364   # dataset ~1 ano (S10)

# Provar a carga num ambiente efêmero (homolog fica intocado)
infra/hub/testes/carga-seeds-teste.sh
```

Saída em `infra/hub/seeds/out/` (**gitignored**) + `manifest.json` com a
asserção de 0 vazamentos. O salt HMAC é descartado — processo irreversível.
Coluna nova no CSV → o gerador **falha** (fail-closed) até ser classificada.

## Backup e restauração (§4.6, teste §4.11 #20)

- **Diário automático**: serviço `backup` (container `hub_homolog_backup`)
  roda `pg_dump -Fc` às 03:00 UTC, retenção 14 dias, no volume
  `hub_homolog_backups`. Mantido como container (não cron do host) para ficar
  100% dentro do escopo da exceção `hub-*`.
- **Manual**: `infra/hub/scripts/backup.sh -f ... -p hub-homolog -e ...`
- **Restore testado**: `infra/hub/scripts/restore.sh -f ... -p hub-homolog -e ...`
  → restaura em `hub_restore`, compara contagens tabela a tabela, falha
  preserva o dump para diagnóstico.

## Reset (homolog)

```bash
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog \
  --env-file /var/lib/hub_secrets/.env.hub.homolog down -v
# up + migrate + (opcional) seeds — ver "Subir um ambiente"
```

## Rollback

- **Serviços do hub**: imagens têm tag imutável (`hub-<fase>-<sha>` a partir da
  S2); rollback = editar a tag no `.env`/compose e `up -d` (recria só o
  serviço). Infra da S1 usa somente imagens oficiais pinadas (postgres:13,
  postgrest v14.1, traefik v3.5.3, node:20-alpine).
- **Banco do hub**: restaurar o último `.dump` (ver restore.sh; para voltar o
  próprio `hub_homolog`, restaurar em `hub_restore`, validar, e então
  `ALTER DATABASE ... RENAME` em janela própria — banco do hub, sem clientes).
- **Produção**: fora de escopo por construção — nada da S1 toca produção;
  não existe rollback de produção associado.

## Roteamento TLS (decisão de design da S1)

**Decisão:** 2ª instância Traefik própria do hub (`hub_homolog_traefik`) em
portas altas **8880/8443**, provider **file** apenas (sem `docker.sock` — não
enxerga nem toca produção) e certificado **self-signed** (ACME é inviável:
80/443 pertencem ao Traefik de produção; DNS-01 exigiria credencial do
provedor). Acesso: `https://hub-homolog.todo-tips.com:8443` (aceitar o
certificado) ou `curl -k`.

**Pendências do OPERADOR:**
1. **DNS**: criar `hub-homolog.todo-tips.com` → IP do VPSTodo (A/AAAA).
2. *(Opcional, TLS válido)* **Promover a rota ao Traefik de produção** — altera
   produção, logo **só o operador executa**, sob o rito: adicionar um router
   `Host(hub-homolog.todo-tips.com)` no Traefik existente apontando para
   `http://<IP-do-host>:8880` (ou conectar o serviço `placeholder` à rede do
   Traefik de produção — NÃO recomendado: fura o isolamento de rede). Enquanto
   isso não acontece, o self-signed nas portas altas atende dev/QA.

## Identificação visual do ambiente (§13.2)

O `placeholder` serve o banner “AMBIENTE DE HOMOLOGAÇÃO …” em `/` (S1). A
partir da S2, o frontend do hub assume o banner e o placeholder sai do compose.

## Mocks (§4.7)

- `fastapi-mock`: cenários (`valida` | `invalida` | `erro_negocio` | `timeout`).
  **Canal canônico = header `X-Mock-Scenario`** (S2+ deve usar só ele;
  `?scenario=`/`mock_scenario` no body existem para curl manual). Registra tudo
  em `/data/fastapi-mock.jsonl` (volume `hub_homolog_mocklogs`); `GET /_log`.
- `n8n-mock`: qualquer POST é registrado (`/data/n8n-mock.jsonl`) e respondido
  com sucesso simulado — **nenhuma mensagem sai**. `GET /_log`.
- Proteções do envio em massa já no env (§4.7 1–10): `ENVIO_DRY_RUN=true`,
  `ENVIO_REAL_HABILITADO=false`, `ENVIO_ALLOWLIST=` (vazia bloqueia tudo),
  `ENVIO_MAX_MENSAGENS=10`; tokens reais ausentes por construção + preflight.

## Testes

- **Preflight negativo (6 combinações §4.8)**: `infra/hub/testes/preflight-negativo.sh`
- **Carga de seeds (efêmero)**: `infra/hub/testes/carga-seeds-teste.sh`
- **Isolamento (20 itens §4.11)**: comandos e evidências em
  `docs/plans/hub-frota/evidencias/S1/` (itens 1, 2 e 19 têm partes executadas
  pelo operador).

## Troubleshooting

- `preflight` abortou → leia o código/mensagem; **não contorne**: se apontar
  recurso de produção, pare e devolva ao operador (CLAUDE.md).
- PostgREST não sobe → conferir `PGRST_JWT_SECRET` (≥32 chars) e se a migration
  0001 (role `hub_web_anon`) foi aplicada; recarregar com
  `docker compose -p hub-homolog kill -s SIGUSR1 postgrest`.
- Porta 8880/8443 ocupada → `ss -tlnp | grep -E '8880|8443'`; escolher outra
  porta alta livre no `.env` (nunca 80/443 — são da produção).
