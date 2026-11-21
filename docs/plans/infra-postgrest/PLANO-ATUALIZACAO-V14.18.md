# Plano — atualizar o PostgREST de produção de v14.1 para v14.18

> Preparado em 2026-11-20, depois do incidente do pool travado (14:38–16:22 UTC).
> Status: **plano, nada executado.** A fase B é escrita em produção (rito integral, 5 gates).

## 1. Por quê

- **Incidente:** em 2026-11-20 o `pgadmin_postgrest` v14.1 ficou com o pool "cheio" sem
  nenhuma conexão real e derrubou todos os logins por 1h45. Voltou com restart.
- **Defasagem:** a série v14 está em **v14.18** (2026-09-10). São 17 versões de correção atrás.
- **Política do projeto:** versões PATCH são "fix/security release only; no features, no
  behavior changes" (docs PostgREST, *Releases*).

⚠️ **Expectativa honesta:** nenhuma entrada do CHANGELOG diz "corrige vazamento do pool". A
atualização **reduz o risco** (correções no listener, no pool sob rede instável, nas
exceções escondidas) e **melhora o diagnóstico**, mas **não está provado** que impede a
repetição. O `postgrest-guard` (PR #315) continua sendo a rede de proteção.

## 2. O que muda entre v14.1 e v14.18 (CHANGELOG oficial)

| Versão | Correção | Relevância para nós |
|---|---|---|
| 14.2 | `hasSingleUnnamedParam` não casa mais função com 1 parâmetro **nomeado**: devolve `PGRST202` em vez de `42883` | Só troca **um erro por outro**. Chamada que funciona hoje não quebra. É a única mudança de comportamento |
| 14.3 | Desempenho/memória do cálculo de *hint* de relação | baixa |
| **14.4** | **Garante que as conexões do Listener sejam liberadas**; **listener rodando com exceção mascarada depois da 1ª falha** | **alta**: nosso LISTEN cai a cada 2h02 (509× em 6 semanas) |
| **14.5** | **Não esconde exceções assíncronas nos logs** | **alta**: o incidente de hoje não deixou nenhuma causa no log |
| 14.6 | **Segurança**: vazamento de nomes de tabela/função no *hint* de erro | média (o PostgREST de produção é exposto publicamente via Traefik) |
| 14.7 | Loga SIGTERM/SIGINT | baixa |
| 14.8 / 14.9 | Loga `HINT` quando o LISTEN para por bug do Postgres; loga host/porta do listener | diagnóstico |
| 14.10 | Evita flush desnecessário do pool no reload do schema cache | média (usamos SIGUSR1 depois de migrations) |
| **14.11** | **O canal LISTEN se recupera sozinho quando para de funcionar**; consulta do listener volta a ser identificável no `pg_stat_activity` | **alta** |
| **14.12** | **Condição de corrida na métrica `pool_available` (valores negativos) durante instabilidade de rede** | **alta**: é a família do sintoma (pool contando errado) |
| 14.13 | Mensagem do `PGRST000`; falha quando a role tem `work_mem` | baixa |
| 14.14–14.16 | Admin server (não usamos) | nenhuma |
| **14.17 / 14.18** | **Validação de JWT usando hora errada**; `PGRST303 JWT issued at future` esporádico; hora errada nos logs após ociosidade longa | **alta**: o backend assina JWT por requisição (`lib/hub-postgrest-jwt.js`) |

Nenhuma mudança de configuração é exigida. As 6 variáveis atuais (`PGRST_DB_URI`,
`PGRST_DB_SCHEMA`, `PGRST_DB_ANON_ROLE`, `PGRST_DB_AUTH_ROLE`, `PGRST_JWT_SECRET`,
`PGRST_SERVER_PORT`) seguem válidas.

## 3. Estado atual (medido em 2026-11-20)

| Item | Valor |
|---|---|
| Serviço | `pgadmin_postgrest` (stack `pgadmin`), 1 réplica, rede `pgadmin`, rota Traefik pública |
| Imagem | `postgrest/postgrest:v14.1@sha256:e9490aa503a5fb07d8e8c80da46e5c0c193894e583b59ed9077e74c4101ffae2` ← **ROLLBACK** |
| UpdateConfig | `stop-first`, `FailureAction: pause`, monitor 5 s (≈10 s de indisponibilidade na troca) |
| Clientes | backend de produção (legado + hub: login, RPCs do hub, adiantamento-worker a cada 60 s) |
| Outros PostgREST v14.1 | `hub_homolog_postgrest` e os composes `infra/hub/compose.hub.{homolog,test,dev,s10}.yml` |
| Disco | 27 GB livres (a imagem do PostgREST tem dezenas de MB) |

⚠️ **O arquivo da stack `pgadmin` não está no repositório.** Depois do `service update`, o rótulo
`com.docker.stack.image` continua dizendo v14.1, o que é só cosmético. Mas um `docker stack deploy`
dessa stack **voltaria para v14.1**. O rito já proíbe `stack deploy`; registre a versão nova no
diário de produção.

## 4. Fase A — ensaio no ambiente isolado do hub (exceção standing `hub-*`)

Objetivo: provar a v14.18 com as **mesmas suítes** que já usamos, antes de tocar produção.

1. Branch `chore/infra-postgrest-v14.18`: trocar `postgrest/postgrest:v14.1` por `v14.18` nos
   4 composes de `infra/hub/`.
2. Puxar a imagem e **anotar o digest** (`docker image inspect postgrest/postgrest:v14.18 --format '{{index .RepoDigests 0}}'`).
3. Rodar os drivers que sobem PostgREST real (`infra/hub/testes/*.sh`):
   - `npm run test:hub:integration` (baseline **zerada**: admin 25/0, faturamento 85/0;
     qualquer vermelho é regressão);
   - driver `rls-importacoes` (baseline 19/0): exercita JWT + RLS por requisição;
   - E2E do hub via driver (baseline 142/0/0 flaky).
4. Conferir no log do container de teste: `Schema cache loaded`, nenhum `PGRST3xx` (JWT).
5. Subir o `hub-homolog` em v14.18 e deixar rodando **≥ 24 h**. Passar pelo menos uma queda
   de LISTEN (a cada ~2h) e conferir se reconecta e se o pool segue sadio.
6. Gate para seguir: todas as suítes com o mesmo placar da baseline e nenhum erro novo no log.

Fase A pode ser feita pelo agente (escopo `hub-*`). O commit e o PR dos composes seguem o rito do ciclo git.

### Resultado da fase A (2026-11-21)

| Etapa | Resultado |
|---|---|
| Imagem | `postgrest/postgrest:v14.18@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf` (`postgrest --version` → `PostgREST 14.18`) ← **usar este digest na fase B** |
| Composes `infra/hub/compose.hub.{homolog,test,dev,s10}.yml` | v14.1 → v14.18 |
| Drivers com PostgREST real (`compose.hub.test.yml`, container efêmero conferido em `v14.18`) | **419 PASS / 0 FAIL, 0 `PGRST3xx`**: rls 26/0 · rls-importacoes 19/0 · auth 44/0 · admin 25/0 · faturamento 85/0 · repasse-lote 91/0 · motoristas 129/0. Os 3 com baseline registrada repetiram o placar exato (admin 25/0, faturamento 85/0, rls-importacoes 19/0) |
| `hub-homolog` | preflight PASSOU; `hub_homolog_postgrest` recriado em v14.18 às 02:33 UTC; LISTEN ativo (`pg_stat_activity`: `PostgREST 14.18 / LISTEN "pgrst"`); 0 `PGRST` no backend |
| Observação de 24 h | ⏳ em curso até 2026-11-22 02:33 UTC |

⚠️ **Limite do ensaio:** o `hub-homolog` roda em **compose**, não em Swarm, e por isso **não passa
pelo IPVS** que derruba a conexão LISTEN de produção a cada 2h02. As 24 h provam
estabilidade e compatibilidade, **não** o comportamento diante da queda de rede. Esse
comportamento só será visto em produção, sob a vigília do `postgrest-guard`.

Fora do conjunto: o E2E do shell e o driver de adiantamentos não sobem PostgREST real
(usam stub) e, por isso, não exercitariam a troca.

## 5. Fase B — produção (rito integral, os 5 gates)

**G1 — Autorização** explícita do operador para *esta* troca.
**G2 — Janela:** fora do horário comercial e **fora da janela do robô EntreGô (11h/13h/14h)**.
Sugestão: dia útil depois das 20h. A troca derruba o PostgREST por ~10 s (`stop-first`): o
`adiantamento-worker` já retenta, e um usuário pode ver um "erro no servidor" pontual.

**G3 — Rollback à mão (anotar ANTES):**
```bash
docker service ls --filter name=pgadmin_postgrest --format '{{.Name}}\t{{.Image}}'
# esperado: postgrest/postgrest:v14.1@sha256:e9490aa5...
# ROLLBACK (pronto para colar):
docker service update --with-registry-auth \
  --image postgrest/postgrest:v14.1@sha256:e9490aa503a5fb07d8e8c80da46e5c0c193894e583b59ed9077e74c4101ffae2 \
  pgadmin_postgrest
```
A imagem v14.1 está local (`docker images postgrest/postgrest`). Não há DDL nem dado envolvido:
o rollback é só trocar a imagem.

**Pré-voo (mesmo dia):**
```bash
df -h /                                   # > 20 GB
docker pull postgrest/postgrest:v14.18    # digest igual ao anotado na fase A
systemctl is-active postgrest-guard.timer # alarme ligado
```

**G4 — Aplicar** (fixando o digest da fase A, nunca a tag solta):
```bash
docker service update --with-registry-auth \
  --image postgrest/postgrest:v14.18@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf \
  pgadmin_postgrest
```
Nunca `docker stack deploy`. Se o classificador bloquear, o operador cola.

**G5 — Smoke** (todos locais, sem expor segredo):
1. `docker service ps pgadmin_postgrest` mostra a tarefa nova `Running` com a imagem v14.18.
2. Log do container novo: `Starting PostgREST 14.18...`, `Successfully connected to PostgreSQL 13.23`,
   `Listener connected to PostgreSQL …` (na v14.18 o texto mudou; a v14.1 dizia
   `Listening for database notifications`), `Schema cache loaded … RPCs …` e **nenhum**
   `PGRST00x` nem `PGRST3xx`.
3. `pg_stat_activity` mostra conexões `PostgREST 14.18` (o `application_name` identifica a versão).
4. Backend: nenhum `PGRST` nos logs nos 2 min seguintes; o `adiantamento-worker` roda o tick sem erro.
5. `node infra/producao/postgrest-guard.js --dry-run` → `ok`, exit 0.
6. **Operador:** login válido no painel, no hub e no app motorista. Login inválido responde
   "credenciais inválidas" (prova que a consulta chegou ao banco), não "erro no servidor".
7. Prova de versão (procedência): `docker inspect <cid> -f '{{.Config.Image}}'` = digest aplicado.

**Critério de rollback imediato:** qualquer `PGRST3xx` (JWT) ou `PGRST00x` repetido depois de
1 min, login falhando, ou o `postgrest-guard` alertando.

## 6. Depois

- Observar 48 h. O `postgrest-guard` vigia a cada 5 min. Conferir no log se a queda do LISTEN
  a cada 2h02 continua: ela vem da rede (IPVS do Swarm + `tcp_keepalive_time=7200`), e a v14.18
  deve **recuperar melhor**, mas não **evitar** a queda.
- Registrar a imagem nova + rollback em `memory`/diário de produção, como nos deploys anteriores.
- Frente separada (também com rito): a queda do LISTEN a cada 2h02. Opções: endpoint `dnsrr`
  no serviço `db`, ou keepalive TCP menor no `PGRST_DB_URI` (`keepalives_idle`).

## 7. Fora do escopo

- Pular para outra série (v15+/v16). Não há necessidade, e mudança de MAJOR pode trazer
  mudança de comportamento.
- Admin server / `/metrics`. Seria útil para enxergar o pool, mas é configuração nova; vira frente própria.

Fontes: CHANGELOG oficial do PostgREST v14.18 (`CHANGELOG.md` no tag `v14.18`); docs
PostgREST v14 — *Releases*, *Connection Pool*, *Listener*.
