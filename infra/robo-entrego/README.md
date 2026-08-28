# robo-entrego

Rotina agendada (Node.js + Playwright) que coleta os relatórios Performance e
Financeiro do portal do franqueado EntreGô e os envia ao hub via
`POST /api/v1/importacoes`. Ver
[docs/specs/robo-entrego/](../../docs/specs/robo-entrego/) para
spec/plan/research/data-model/contracts completos.

## Provisionamento do usuário de serviço (sql/001-usuario-servico-robo-entrego.sql)

⚠️ **Artefato para o operador aplicar manualmente** — esta pipeline (SDD
feature-00c) gera o script SQL mas **nunca o executa** contra o banco vivo
(rito de produção do projeto, `CLAUDE.md`). O script cria:

- um papel dedicado `robo_entrego_servico` (escopo entidade) com **somente**
  as permissões `importacoes.criar` e `importacoes.consultar` (least
  privilege — não usa o papel `operador` existente, que concede muito mais);
- um `Usuario` de serviço (senha com hash bcrypt calculado no próprio banco
  via `pgcrypto`, nunca texto plano);
- o vínculo em `UsuarioEntidade` restrito a `id_empresa = 6`.

Instruções completas de uso (variáveis `-v`, idempotência) estão no cabeçalho
do próprio arquivo SQL. Depois de aplicar, a credencial vai em
`/var/lib/hub_secrets/robo-entrego/.env` (`HUB_SERVICO_EMAIL`/
`HUB_SERVICO_SENHA`), nunca no git.

## Como funciona (visão geral)

`docker-run.sh` (chamado pelo `robo-entrego.service`) roda TUDO — sessão do
portal EntreGô, upload no hub, e-mail de alerta — dentro do container oficial
`mcr.microsoft.com/playwright` (nunca instala browser no host,
research.md Decision 2). O mutex entre execuções sobrepostas
(`robo-entrego.lock`) é o `flock -n` real do kernel, envolvendo o `docker run`
inteiro (research.md Decision 8) — se o lock estiver ocupado, o container
principal nem sobe; um segundo container (rápido, sem Playwright) só registra
`resultado: pulado_lock` no log.

## Instalação do timer

1. Segredos em `/var/lib/hub_secrets/robo-entrego/.env` (copiar de
   `.env.robo-entrego.example`, preencher, `chmod 600`) — ver seção acima
   sobre o usuário de serviço do hub.
2. Horários em `config.json` (`{"horarios": ["06:00"]}`, `HH:MM` em
   **America/Sao_Paulo** — mesmo fuso do portal EntreGô,
   ACHADOS-PORTAL.md §3) — editar e rodar:
   ```bash
   ./scripts/gerar-timer.sh
   ```
   Isso regenera `robo-entrego.timer` localmente (no repo) — **não** toca o
   host. Sempre rodar de novo depois de editar `config.json`; nunca editar
   as linhas `OnCalendar=` de `robo-entrego.timer` à mão (o cabeçalho do
   arquivo já avisa).
3. **Instalação em `/etc/systemd/system` é ato manual do operador** (rito de
   produção — fora do escopo de execução desta pipeline SDD). `gerar-timer.sh`
   imprime os comandos exatos no final; resumo (mesmo padrão de
   `infra/producao/README.md`, `ln -sf` para o link nunca dessincronizar do
   repo):
   ```bash
   sudo ln -sf /var/lib/envioMassa_homologacao/infra/robo-entrego/robo-entrego.service \
               /var/lib/envioMassa_homologacao/infra/robo-entrego/robo-entrego.timer \
               /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now robo-entrego.timer
   ```

## Rodar manualmente (sem esperar o timer)

Executa 1 rodada isolada, exatamente como o timer dispararia (tasks.md 5.2.4
— teste manual documentado; comando abaixo não é executado por esta pipeline,
é para o operador rodar quando o timer já estiver instalado):

```bash
sudo systemctl start robo-entrego.service
# acompanhar:
journalctl -u robo-entrego.service -f
```

Sem instalar a unit (direto pelo wrapper, útil para depurar antes de
instalar o timer):

```bash
./scripts/docker-run.sh
```

## Ler o log de execuções

JSON Lines append-only em
`/var/lib/hub_secrets/robo-entrego/log/execucoes.jsonl` — 1 linha `inicio` +
1 linha `fim` por execução (data-model.md §Entity: Execução Agendada), nunca
reescrito. Exemplos:

```bash
# últimas 5 rodadas (linha "fim" = resumo)
grep '"linha":"fim"' /var/lib/hub_secrets/robo-entrego/log/execucoes.jsonl | tail -5 | jq .

# só falhas
grep '"linha":"fim"' /var/lib/hub_secrets/robo-entrego/log/execucoes.jsonl \
  | jq 'select(.resultado != "sucesso")'
```

Falha (`falha_parcial`/`falha_total`) já dispara e-mail (FR-013) e evento em
`GET /api/v1/auditoria` (`recurso: "RoboEntrego"`) no hub — o log local é para
quando nenhum dos dois chegou a ser tentado (ex.: falha antes do login).

## Trocar horários

Editar `config.json` → rodar `./scripts/gerar-timer.sh` → reaplicar a unit no
host (rito de produção, ato manual do operador):

```bash
sudo systemctl daemon-reload
sudo systemctl restart robo-entrego.timer
```

## Rito de aplicação em produção

Esta pipeline (SDD `feature-00c`) entrega **artefatos** (código, unit files,
SQL) — nunca aplica nada no ambiente vivo (`CLAUDE.md` §Rito de produção). A
instalação do robô em VPSTodo segue os mesmos 5 gates de qualquer mudança de
estado no host:

1. **Autorização explícita** do operador para instalar o timer.
2. **Janela combinada** (a primeira execução real loga no portal do
   franqueado — risco de challenge do anti-bot, ACHADOS-PORTAL.md §6; melhor
   com o operador ciente/disponível).
3. **Rollback**: `sudo systemctl disable --now robo-entrego.timer && sudo rm
   /etc/systemd/system/robo-entrego.{service,timer} && sudo systemctl
   daemon-reload` — remove o agendamento sem afetar nenhum serviço do Swarm
   (o robô não é um serviço, não disputa porta, `infra/robo-entrego/` fora do
   `docker stack`).
4. **Aplicar**: os 3 comandos de "Instalação do timer" acima — nunca
   `docker stack deploy` (não se aplica aqui: não há stack compose para este
   robô, é systemd puro, mesmo padrão de `infra/producao/`).
5. **Smoke test**: `sudo systemctl start robo-entrego.service` (execução
   isolada, tasks.md 5.2.4) + conferir a linha `fim` mais recente no log
   (`resultado: sucesso`) + `GET /api/v1/auditoria` no hub se houve falha.

Pré-requisito de dados, fora do código desta pipeline: aplicar
`sql/001-usuario-servico-robo-entrego.sql` no banco (rito de produção —
DDL/escrita no `chatmasterveloz`, mesmos 5 gates) e provisionar
`/var/lib/hub_secrets/robo-entrego/.env` no host real.
