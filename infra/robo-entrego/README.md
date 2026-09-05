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

## Enriquecimento EntreGô — sob demanda + rotina semestral (hub-motorista-360 FASE 5/6)

Segundo worker, módulo NOVO e SEPARADO (`src/enriquecimento.js`) — busca os
dados de cadastro ("Dados da pessoa entregadora") de um motorista no portal
EntreGô por UUID e grava em `Entregador.dados_entrego_json` (hub). Reusa a
MESMA sessão persistida e o MESMO lockfile do robô de importação acima —
nunca roda em paralelo com ele (dec-039, "uma raspagem por vez, robô
prioritário"). Ver
[docs/specs/hub-motorista-360/](../../docs/specs/hub-motorista-360/) para
spec/plan/research/data-model/contracts completos e
[docs/plans/robo-entrego/ACHADOS-PORTAL.md](../../docs/plans/robo-entrego/ACHADOS-PORTAL.md)
§9 para o endpoint do BFF medido.

**2 timers, 1 script, modos diferentes** (research.md Decision 7/8):

| Timer | Cadência | O que processa |
|---|---|---|
| `entrego-enriquecimento-sob-demanda.timer` | a cada 5 min | fila de pedidos manuais (`dados_entrego_solicitado_em`, FR-005 — botão "Buscar dados EntreGô" no hub) |
| (o mesmo timer, com fila vazia) | quando o refresh token vence em ≤ 20 min | **keep-alive** da sessão EntreGô: renova o refresh (rotacionado a cada renovação, ACHADOS-PORTAL.md §10) sem login; nunca faz login completo — refresh já vencido fica para o próximo trabalho real |
| `entrego-enriquecimento-semestral.timer` | 2x/ano (1º jan + 1º jul, 00:00 America/Sao_Paulo) | todo `Entregador` já enriquecido há mais de 6 meses (FR-016) |

⚠️ **Nenhuma credencial nova** — os dois reusam a mesma sessão EntreGô
(`entrego-session.json`) e o mesmo usuário de serviço do hub
(`robo_entrego_servico`) já provisionados acima; a única permissão adicional
é a de `sql/003-permissoes-enriquecimento-robo-entrego.sql` (task 2.4, já
aplicada em `hub-homolog`).

### Instalação dos 2 timers

1. Segredos e usuário de serviço: mesmos pré-requisitos da seção
   "Provisionamento do usuário de serviço" acima — **nada de novo** a
   provisionar para este worker além do grant de
   `sql/003-permissoes-enriquecimento-robo-entrego.sql`.
2. Cadência em `config-enriquecimento.json` (`.timers[]` — unit, description,
   `onCalendar` no formato `systemd.time(7)`, `randomizedDelaySec`) — editar
   e rodar:
   ```bash
   ./scripts/gerar-timer.sh config-enriquecimento.json
   ```
   Regenera `entrego-enriquecimento-sob-demanda.timer` e
   `entrego-enriquecimento-semestral.timer` localmente (no repo) — **não**
   toca o host. Mesma regra do robô diário: nunca editar `OnCalendar=` à
   mão, sempre reeditar o config + re-rodar o script (o cabeçalho gerado nos
   2 arquivos já avisa). Este mesmo `gerar-timer.sh` continua servindo o
   robô diário sem nenhuma mudança de comportamento quando chamado sem
   argumento (schema `.horarios[]`) ou com `config.json` explícito.
3. **Instalação em `/etc/systemd/system` é ato manual do operador** (rito de
   produção — fora do escopo de execução desta pipeline SDD).
   `gerar-timer.sh` já imprime os comandos exatos no final; resumo:
   ```bash
   sudo ln -sf /var/lib/envioMassa_homologacao/infra/robo-entrego/entrego-enriquecimento-sob-demanda.service \
               /var/lib/envioMassa_homologacao/infra/robo-entrego/entrego-enriquecimento-sob-demanda.timer \
               /etc/systemd/system/
   sudo ln -sf /var/lib/envioMassa_homologacao/infra/robo-entrego/entrego-enriquecimento-semestral.service \
               /var/lib/envioMassa_homologacao/infra/robo-entrego/entrego-enriquecimento-semestral.timer \
               /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now entrego-enriquecimento-sob-demanda.timer
   sudo systemctl enable --now entrego-enriquecimento-semestral.timer
   ```

### Rodar manualmente (sem esperar o timer)

```bash
sudo systemctl start entrego-enriquecimento-sob-demanda.service   # ou -semestral
journalctl -u entrego-enriquecimento-sob-demanda.service -f
```

Sem instalar a unit (direto pelo wrapper, útil para depurar antes de
instalar o timer):

```bash
./scripts/docker-run-enriquecimento.sh sob-demanda   # ou: semestral
```

### Observabilidade (diferente do robô diário — sem e-mail, sem log JSON próprio)

Este worker **não** usa `alerta-email.js` nem `log-execucao.js` — cada item
falho já vira evento de auditoria no HUB (`PATCH .../entrego-enriquecimento`,
`sucesso:false` → `motorista.entrego_enriquecimento_falhou`,
`GET /api/v1/auditoria` no hub); a rodada como um todo (contadores
sucessos/falhas, `motivoParada` se parou por anti-bot/sessão) só aparece no
stdout capturado pelo `journalctl` da unit correspondente. Suspeita de
anti-bot ou falha transitória esgotada PARAM a rodada em vez de martelar
(FR-016/FR-011, mesmo comportamento — não retry infinito — do robô diário);
o item corrente fica pendente e é reprocessado no próximo tick do timer
(auto-cura, sem relogin no meio da rodada — ver comentário de cabeçalho de
`src/enriquecimento.js`).

### Rito de aplicação em produção

Mesmos 5 gates da seção "Rito de aplicação em produção" acima, aplicados aos
2 timers novos:

1. **Autorização explícita** do operador para instalar os 2 timers.
2. **Janela combinada** — mesmo risco de anti-bot da primeira execução real.
3. **Rollback**: `sudo systemctl disable --now
   entrego-enriquecimento-sob-demanda.timer
   entrego-enriquecimento-semestral.timer && sudo rm
   /etc/systemd/system/entrego-enriquecimento-{sob-demanda,semestral}.{service,timer}
   && sudo systemctl daemon-reload` — remove o agendamento sem afetar o
   robô diário (lockfile compartilhado, mas units independentes) nem nenhum
   serviço do Swarm.
4. **Aplicar**: os 5 comandos de "Instalação dos 2 timers" acima.
5. **Smoke test**: `sudo systemctl start
   entrego-enriquecimento-sob-demanda.service` (roda com a fila vazia se
   nenhum pedido pendente — resultado `sem_dados`, sem tocar o portal) +
   conferir `journalctl -u entrego-enriquecimento-sob-demanda.service -n 20`.

Pré-requisito de dados, fora do código desta pipeline: aplicar
`sql/003-permissoes-enriquecimento-robo-entrego.sql` no banco (rito de
produção — DDL/escrita no `chatmasterveloz`, mesmos 5 gates), se ainda não
aplicado no ambiente alvo (já aplicado em `hub-homolog`, task 2.4).

### `Failed` seguido de sucesso é ESPERADO — não é incidente

Observado na primeira execução real em produção (2026-09-05):

```
00:05:25  entrego-enriquecimento-sob-demanda.service: Failed with result 'exit-code'
          ErroPortalTransitorio: sonda de sessão falhou
          (page.evaluate: Execution context was destroyed, most likely because
           of a navigation.) at sondarSessaoValida (entrego-portal.js:164)
00:10:20  rodada concluída: {"resultado":"sucesso","total":1,"sucessos":1,"falhas":0}
```

`Execution context was destroyed` é um erro clássico e **transitório** do
Playwright: a página navegou enquanto o `page.evaluate` da sonda de sessão
executava. O código o classifica como `ErroPortalTransitorio` — **não** como
`ErroAntibotSuspeito` —, sai com código 1, e **o próprio timer é o retry**: a
rodada seguinte (5 min) processa o item normalmente. Foi o que aconteceu acima:
o motorista que estava na fila às 00:05 foi enriquecido às 00:10, sem
intervenção.

**Como distinguir ruído de problema de verdade:**

| Padrão no journal | Leitura |
|---|---|
| `Failed` isolado, seguido de `rodada concluída` na próxima janela | **Esperado.** Transitório do portal; o timer já resolveu. Nenhuma ação. |
| `Failed` repetido em 3+ janelas seguidas, sem sucesso no meio | **Investigar.** Sessão inválida, credencial trocada, portal fora do ar. |
| Qualquer menção a `ErroAntibotSuspeito` / `suspeita_antibot` | 🔴 **Parar e investigar antes de reexecutar.** Não é transitório: o código trata como falha definitiva de propósito, para não insistir e queimar a sessão compartilhada com a importação diária. |
| `pulado_lock` | Normal. A rodada de importação estava em curso; o `flock` serializou (dec-039), o robô tem prioridade. |

**Por que não há retry imediato da sonda de sessão** (a busca de dados por
motorista *tem*, via `comRetryTransitorio`): repetir na hora significa mais
tentativas de login em sequência, e é exatamente esse padrão que o PerimeterX
observa (§6 de `docs/plans/robo-entrego/ACHADOS-PORTAL.md`). Falhar rápido e
deixar o timer retentar em 5 min é um backoff mais seguro do que insistir. A
consequência aceita é o `Failed` no status da unidade.

Consulta rápida ao histórico:

```bash
journalctl -u entrego-enriquecimento-sob-demanda.service --since '2 hours ago' \
  | grep -E 'rodada concluída|Failed|antibot'
```
