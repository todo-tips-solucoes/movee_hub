# Diário do projeto Hub de Frota

Handoff entre sessões. Cada sessão apenda ~10 linhas no fechamento: o que fechou, decisões,
pendências, ponteiros (branch/PR/estado feature-00c).

---

## 2026-07-04 — Sessão de orquestração (plano mestre)

- **Fechou:** plano mestre de orquestração em `00-plano-mestre-orquestracao.md`; diretrizes
  (`docs/documentos_apoio/diretrizes_customizacao.txt`) versionadas no repo; reconhecimento
  dos ZIPs no sandbox context-mode (Faturamento: CSV `;` ~4.014 linhas/dia, 20 colunas;
  Performance: CSV `;` ~2.720 linhas/dia, 19 colunas; chave comum `id_da_pessoa_entregadora`).
- **Decisões:** roteiro S0–S10 com gates G1/G2/G3; skills obrigatórias context-mode +
  feature-00c + ui-ux-pro-max; recomendação de VPS separada para o ambiente isolado.
- **Pendências:** operador aprovar este plano (merge do PR) → rodar S0 com o prompt da §7;
  decisão de infra (G1) fica para depois da S0.
- **Ponteiros:** branch `worktree-plano-hub-frota`; ZIPs NÃO commitados (dados pessoais).

---

## 2026-07-05 — Sessão S0 (planejamento técnico profundo)

- **Fechou:** diretrizes executadas integralmente (etapas 1–23, 20 entregáveis):
  `01-plano-tecnico.md` + `prompts/prompt-{A,B,C}.md` + 9 briefings autossuficientes
  (`briefings/s2…s10`). Diagnósticos repo/Docker por subagentes Explore; análise dos 2
  CSVs 100% no sandbox context-mode (só estatísticas/exemplos mascarados no relatório).
- **Achados-chave:** CSVs sem chave natural única → dedupe por hash de arquivo+linha;
  decimal vírgula (fat.) vs ponto (perf.); 4,5% das linhas de faturamento sem UUID (bônus
  agregados); sem CNPJ nos CSVs → vínculo Entregador↔Motorista manual+sugestão (D3);
  backend↔PostgREST provavelmente via URL pública (confirmar na S1); VPSTodo sem folga
  (1,4 GiB RAM livre, disco 85%) → reforça VPS separada.
- **Decisões (a ratificar no G1):** VPS separada (D0); série única de migrations =
  `backend/db/011+`, `docs/sql/` congelada (D1); hub em Node 20 (D2); modelo Usuario/
  UsuarioEntidade/Papel/Permissao + RLS de reforço; fatos append-only.
- **Pendências:** operador revisar/mergear PR desta S0; decidir G1 (infra + subdomínio);
  D3–D7 (§18 do plano); recomendação: adicionar `docs/documentos_apoio/*.zip` ao
  .gitignore (fora do escopo de escrita da S0).
- **Ponteiros:** branch `docs/hub-frota-plano-tecnico` (PR draft); próximo passo após
  G1 = sessão fresca com `prompts/prompt-A.md` (S1).

---

## 2026-07-05 — Gate G1 (decisão do operador) + merge da S0

- **S0 mergeada:** PR #53 (merge `e5c0ee7c`) após code review de 8 ângulos — 19 achados
  corrigidos (`8bce8bf`), 3 refutados.
- **G1 DECIDIDO pelo operador (Paulo):**
  - **D0 = MESMO HOST (VPSTodo)** — Alternativa B do plano (§4.2). Recursos verificados
    após upgrade: 8 vCPU, 15 Gi RAM (8,7 Gi disponíveis), swap 8 Gi; disco 85% (23 GB
    livres) → operador executa `docker builder prune -a -f` antes da S1 (~43 GB recuperáveis).
  - **Subdomínio de homolog:** `hub-homolog.todo-tips.com`. Roteamento TLS é decisão de
    design da S1 (2ª instância Traefik em portas altas vs. rota no Traefik existente —
    esta última mexe em produção e exige o operador).
  - **D1 e D2 ratificadas** (série única `backend/db/011+`, docs/sql congelada; hub em Node 20).
  - **D4 PARCIALMENTE confirmada** (`soma_das_taxas` em centavos; `tempo_disponivel_escalado`
    em % — confirmados pelo operador). **Pendente e ainda BLOQUEANTE da S4:** significado
    exato de `atingido` e `margem_fee` (registrar aqui quando o operador/cliente responder).
  - **Exceção standing auditada à cláusula pétrea (escopada, S1–S10):** o agente pode
    criar/gerir no VPSTodo SOMENTE recursos prefixados `hub-`/`hub_` (projetos compose
    hub-dev/test/homolog, redes/volumes/containers `hub_*`, banco novo do hub). Tudo do
    ambiente vivo (Swarm, stacks `envio-massa-homologacao_*`/`fastapi*`/`pgadmin`,
    banco `chatmasterveloz`, `.env`, Traefik de produção) permanece intocável; na dúvida,
    parar e devolver ao operador.
- **Pendências:** operador rodar o prune e colar a saída; depois sessão fresca com
  `prompts/prompt-A.md` (já preenchido com as decisões do G1).

---

## 2026-07-05 — Review do delta do PR #53 + propagação do G1

- **Review (4 finders + verificação):** 9 achados confirmados no delta não revisado
  (commits 8bce8bf/dc2d99a) — todos corrigidos nesta entrada de commit.
- **Correções aplicadas:** decisão do G1 (mesmo host + exceção `hub-*`) propagada a
  prompt-B, prompt-C e briefings s2–s10 (fim do "VPS Hub"/proibições absolutas);
  **exceção registrada no CLAUDE.md** (fonte canônica, com regra de precedência);
  testes de isolamento 1/2/19 ganharam método de mesmo-host (item 19 testa a rede
  docker, não a porta pública); "registry" removido dos intocáveis do prompt-A (push de
  tags `hub-*` permitido, §4.4); §3.5/§4.2 reconciliadas com o upgrade e a decisão;
  teste #20 preserva dump em falha; #6 fixa builtin do bash; prompt-C traz a exceção
  da S10 (sem /feature-00c) na primeira linha.
- **⚠️ D4 corrigida para PARCIAL:** `atingido` e `margem_fee` seguem pendentes e
  bloqueantes da S4 (o G1 confirmou só centavos e percentual).

---

## 2026-07-06 — S1 executada: ambiente isolado criado (aguardando G2 do operador)

- **Sessão S1 (Prompt A) concluída pelo agente** na branch `feat/hub-ambiente-isolado`;
  infra-as-code em `infra/hub/` (composes dev/test/homolog, `.env.*.example`, mocks
  fastapi/n8n/placeholder em Node stdlib, preflight, gen-secrets, migrate, backup,
  restore, gen-seeds, runbook, testes). Escopo respeitado: **zero mudança funcional**;
  banco novo vazio + `SchemaMigration` (0000) + role do PostgREST (0001 — infra mínima
  do PGRST_DB_ANON_ROLE, registrada como interpretação no PR).
- **Ambiente `hub-homolog` NO AR** (projeto compose próprio, 7/7 containers, todos com
  caps de CPU/RAM): postgres:13 `hub_homolog` (porta não publicada), PostgREST v14.1
  próprio (interno, `PGRST_JWT_SECRET` novo), mocks com registro de payload, Traefik
  do hub em **8880/8443** e daemon de backup diário (03:00 UTC, retenção 14d).
- **Decisão de design (roteamento TLS):** 2ª instância Traefik do hub em portas altas
  com **provider file (sem docker.sock)** e certificado **self-signed** — ACME é
  inviável sem 80/443 (produção). Config de promoção ao Traefik de produção documentada
  no RUNBOOK; execução é exclusiva do operador.
- **Credenciais todas novas** geradas em `/var/lib/hub_secrets/` (0700/0600, fora do
  git); templates sem segredos no repo; `prod-fingerprints.sha256` aguarda o operador.
- **Preflight fail-safe (§4.8):** passa nos 3 ambientes; **teste negativo 6/6**
  combinações perigosas abortadas (códigos 10–15) — evidência 02.
- **Seeds anonimizados (§4.6):** gen-seeds.py (HMAC, salt descartado, fail-closed para
  coluna nova) sobre os ZIPs reais no sandbox: 4.014 fat + 2.720 perf, **asserção
  0-vazamentos** (789 UUIDs/790 nomes observados, 0 na saída); modo síntese de volume
  testado (7 dias); carga provada em compose efêmero `hub-test-<runid>` (down -v);
  homolog permanece sem dados (schema funcional é S3+). Saída gitignored.
- **Backup/restore (§4.11 #20):** pg_dump -Fc + restore em `hub_restore` com contagens
  iguais; re-executável.
- **20 testes de isolamento (§4.11):** 16 PASS diretos; 6/8/17 PASS-parcial e 1 =
  **operador** (comandos prontos em `evidencias/S1/README.md`). Destaque item 19
  (mesmo-host): containers hub em rede `internal` — não resolvem `pgadmin_db`, TCP ao
  IP do banco de produção falha, sem saída à internet.
- **⚠️ Incidente registrado (transparência):** ao limpar o volume anônimo do container
  de backup, o agente removeu 19 volumes anônimos **dangling** do host inteiro sem
  filtro `hub_*` — fora do escopo da exceção G1. Todos órfãos (Docker recusa remover
  volume em uso); verificação imediata: 25 serviços Swarm 1/1 e volumes nomeados de
  produção intactos. Impacto avaliado nulo; lição: limpeza sempre com filtro `hub_*`.
  Detalhe em `evidencias/S1/README.md`.
- **Pendências para o G2 (operador):** item 1 (estado/contagens de produção),
  fingerprints (item 6/13), item 17 (SchemaMigration inexistente em produção), DNS
  `hub-homolog.todo-tips.com` (item 8); revisar/mergear o PR draft da S1.

---

## 2026-07-06 — Itens do operador executados, review de 8 ângulos, correções e MERGE do PR #54

- **Itens 1, 6/13, 17 e 8 dos testes de isolamento FECHADOS** sob autorização
  explícita do operador (chat): item 1 = pgadmin_db uptime 2 semanas + baseline
  max_id=197771/count=196343; itens 6/13 = 7 fingerprints de produção em
  `/var/lib/hub_secrets/prod-fingerprints.sha256` (hashes via pipe dentro dos
  containers; valores jamais em stdout/ps/contexto; todos os segredos do hub
  distintos); item 17 = `to_regclass('public."SchemaMigration"')` NULL em
  produção; item 8 = DNS `hub-homolog.todo-tips.com` ativo →
  https://hub-homolog.todo-tips.com:8443 HTTP/2 200. **20/20 com evidência.**
  (Corrige a entrada anterior, que listava esses itens como pendentes.)
- **Review /code-review high (8 finders + verificação) sobre o diff da S1** —
  ~30 candidatos, principais corrigidos: preflight ganhou **allowlist hub_***
  (volumes/redes/binds) além da blocklist, checagem de banco/PostgREST de
  produção no env INTEIRO + compose renderizado, check de imagens fail-closed,
  `get_var` normalizando aspas/CRLF (senão o fingerprint hasheava valor errado)
  e proteção inversa simétrica; **lib.sh** única para parsing e listas de
  produção (4 cópias divergentes eliminadas); isolamento.sh com conjunto EXATO
  de redes, item 6 exigindo fingerprints reais, item 8 exigindo HTTP 200, as 4
  redes de produção no item 19 e exit code fiel; **Traefik parametrizado por
  env (Go templating)** — HUB_DOMAIN/HUB_HTTPS_PORT deixaram de ser letra
  morta; mocks do compose test ganharam /data (tmpfs); gen-seeds com parse
  único por arquivo, colisão de dias fail-closed, asserção de identidade real
  e verificação streaming (S10-safe); retenção do backup corrigida (-mtime
  off-by-one); guard claro em backup/restore fora do homolog; \copy único por
  dataset na carga. Refutados (registrados): extends entre composes (conflita
  com §4.5 item 2 — arquivos autocontidos por ambiente, decisão consciente).
- **Divergência de governança anotada:** CLAUDE.md pede trailer
  "Claude Opus 4.8" nos commits; os commits da S1 usam "Claude Fable 5"
  (modelo vigente) + linha Claude-Session — proposta: atualizar a regra do
  CLAUDE.md para o modelo vigente (decisão do operador).
- Revalidação completa pós-correções: preflight 3/3, negativo 6/6, isolamento
  exit 0 sem FAIL, seeds 0-vazamentos (1 e 7 dias), carga efêmera OK,
  backup/restore contagens iguais, smoke 200 pelo domínio. Evidências
  regeneradas. **PR #54 mergeado pelo agente com autorização do operador
  ("se tudo certo faça o merge"). G2 = ratificação formal do operador.**

---

## 2026-07-06 — Gate G2 RATIFICADO pelo operador

- **G2 APROVADO** (Paulo, chat da sessão S1): ambiente isolado aceito com os 7
  critérios da §17.1 satisfeitos — 20/20 testes de isolamento com evidência
  (`docs/plans/hub-frota/evidencias/S1/`), produção intocada (baseline
  max_id=197771/count=196343, uptime pgadmin_db 2 semanas), up canônico por
  ambiente, preflight com teste negativo 6/6, backup/restore executados, seeds
  anonimizados com asserção 0-vazamentos, mocks respondendo e registrando.
- PR #54 mergeado na main (47bfebcb) com as correções do review de 8 ângulos.
- **S2 LIBERADA**: rodar em sessão fresca com
  `docs/plans/hub-frota/prompts/prompt-B.md` (fundações). Handoff completo via
  este DIARIO + evidências S1 + RUNBOOK (`infra/hub/RUNBOOK.md`).

---

## 2026-07-06 — S2 (Fundações do Hub) CONCLUÍDA — FASES 1–7, evidências e PR draft

- **S2 completa via `/feature-00c` (feature `hub-fundacoes`, branch `feat/hub-fundacoes`,
  13 commits)**: banco (migrations 0000–0008 idempotentes: `Usuario`, `UsuarioEntidade`,
  `Papel`/`Permissao`/`PapelPermissao`, `Modulo`/`ModuloEntidade`, `Auditoria`,
  `SessaoRefresh` + GRANTs explícitos + registro em `SchemaMigration`), migração
  expand-only `Empresa.pass → Usuario` (hash bcrypt preservado, sem recálculo),
  autenticação `/api/v1/auth/*` (login/refresh/logout/recuperar-redefinir senha,
  anti-enumeração, rate-limit, bloqueio 5/15min, revogação de sessões), RBAC
  (`requirePermission` fail-closed, cache TTL 60s) + `/api/v1/me*`, RLS de reforço
  nega-por-padrão (JWT PostgREST por claims de escopo/sub).
- **Decisões-chave da S2**:
  - **dec-008**: postura nega-por-padrão quando claim de entidade está ausente/não
    verificável (FR-028) — reforça RLS mesmo sem contornar a camada de aplicação.
  - **block-001**: Auditoria imutável no banco — trigger incondicional
    `hub_bloqueia_alteracao_auditoria` (`0004_auditoria.sql`, FR-023/024/025) bloqueia
    UPDATE/DELETE mesmo para o dono/superuser; único bypass é
    `session_replication_role=replica` (escopado à sessão, usado só em cleanup de
    dados sintéticos de teste).
  - **block-002/dec-033**: matriz de 4 papéis-seed e permissões default **aprovada
    pelo operador sem ajustes** (Paulo, 2026-07-06T03:18:25Z).
  - **dec-039**: TTL de `token_recuperacao_expira` fixado em 1h (FR-021 não
    especificava valor concreto).
  - **dec-055**: suíte completa (106 testes) mostra 8 falhas **pré-existentes** em
    `motorista-integration.test.js` (gorjeta/"movimento deve existir"), confirmadas
    idênticas no commit-baseline anterior a `hub-fundacoes` (05ef220, worktree
    isolado) — **não é regressão** desta feature; fix fora de escopo.
  - **dec-060/dec-061**: 1ª rodada de `hub-e2e-homolog.sh` achou 2 bugs no próprio
    teste (não no código): reuso do token de redefinição retorna 400 (não 410 como
    o quickstart sugeria) e cleanup de dados `e2e-teste-*` exige
    `session_replication_role=replica` por causa do trigger de imutabilidade da
    Auditoria; corrigidos, 32/32 verde na 3ª rodada, 0 linhas residuais.
  - **dec-063**: evidências formais da FASE 7 geradas frescas (não reaproveitadas
    cegamente) — ver lista abaixo.
  - **dec-064**: cleanup pós-evidência de auditoria de login tentou remover o
    usuário sintético + 2 linhas de `Auditoria` via `session_replication_role=replica`;
    **negado pelo classificador de auto-mode** (Logging/Audit Tampering). Aceito
    sem contornar a negação: as 2 linhas (`login_sucesso`/`login_falha`) são
    eventos reais, sem segredos (`detalhes={}` e
    `{motivo:"senha_incorreta",tentativas_login:1}`), e o próprio design de
    imutabilidade (FK `Auditoria_usuario_id_fkey`) impede remover o `Usuario`
    referenciado — reforça, na prática, a garantia de block-001. Dados
    permanecem no ambiente isolado `hub-homolog` (não-produção).
- **Testes e evidências (`docs/plans/hub-frota/evidencias/S2/`)**:
  - `01-e2e-homolog.txt` — E2E persistente: 32/32 (login→me→troca de entidade,
    recuperar/redefinir senha revoga sessões, bloqueio 5 falhas→423, RLS
    cross-entidade via PostgREST direto).
  - `02-npm-test.txt` — suíte completa: **106 testes, 98 pass, 8 fail** (as 8 são
    100% de `motorista-integration.test.js`, pré-existentes/dec-055; todos os
    `hub-*` verdes).
  - `03-schema-migration.txt` — `SELECT * FROM "SchemaMigration"` (9 migrations
    0000–0008) + `migrate.sh` rodado 2× consecutivas contra `hub-homolog`:
    "0 aplicadas agora" nas duas, timestamps inalterados (idempotência real).
  - `04-auditoria-login.txt` — login com usuário sintético descartável contra
    `hub-homolog`: `login_sucesso` (200) e `login_falha` (401,
    motivo=senha_incorreta) registrados na trilha, sem segredos.
  - `05-migracao-login-legado.txt` — `migracao-login-integration.sh` (ambiente
    efêmero): 7/7 PASS — hash bcrypt copiado sem recálculo, `bcrypt.compare`
    confirma login legado funcional, reexecução direta de `0008` não duplica
    linhas.
  - `06-rls-cross-entidade.txt` — `hub-rls-integration.sh` (ambiente efêmero):
    17/17 PASS — RLS nega cross-entidade em `Auditoria`/`ModuloEntidade`/
    `UsuarioEntidade`, preserva uso legítimo, nega-por-padrão mesmo sem claims.
  - Nenhum segredo (senha/hash/token) presente em qualquer evidência salva.
- **Blast radius confirmado**: toda escrita ficou confinada a recursos `hub-*`
  (banco `hub_homolog`, containers `hub_homolog_*`, projetos `hub-test-*`
  efêmeros) — **zero escrita** no ambiente vivo do cliente (`chatmasterveloz`,
  `envio-massa-homologacao_*`, `pgadmin_db`, Traefik/tags de produção).
  `docker compose ls` confirma apenas `hub-homolog` e `metanoia-prod` (intocado)
  ativos ao final; nenhum projeto `hub-test-*` remanescente.
- **PR draft aberto** na branch `feat/hub-fundacoes` referenciando os 7 critérios
  de aceite do briefing + as 6 evidências acima.
- **Pendências para o operador (gate G3)**: (1) revisar e aprovar o PR draft;
  (2) decidir sobre o fix da gorjeta pré-existente (fora de escopo desta feature,
  dec-055) — abrir issue/feature separada se desejado; (3) autorizar cutover para
  produção (deploy real do backend com as rotas `/api/v1/auth`, `/me`, `/auditoria`
  e as migrations 0000–0008) — **não realizado nesta sessão**, exige os 5 gates do
  rito de produção do CLAUDE.md; (4) revisar a divergência de trailer de commit
  ainda pendente desde a S1 (CLAUDE.md pede "Claude Opus 4.8", commits usam o
  modelo vigente).
- Ambiente `hub-homolog` permanece NO AR (9 containers saudáveis), não foi
  derrubado.

---

## 2026-07-06 — Correções pós-review do PR #55 (hub-fundacoes / S2)

Aplicadas na branch `feat/hub-fundacoes` (sem merge — reverificação do pai).
Todo runtime em projetos compose EFÊMEROS `hub-test-*`; zero escrita no
`hub-homolog` persistente e em produção. Migrations expand-only/idempotentes
(0000–0008 intocadas; correções em `0009_rls_hardening_indices.sql` novo).

### Corrigido (7 achados)

1. **[ALTA — segurança] Leitura cross-tenant da trilha de auditoria.** O gate
   `requirePermission('auditoria.consultar')` validava contra a UNIÃO FLAT dos
   vínculos; a query escopava pela entidade ATIVA → quem tinha o grant só na
   empresa B lia a trilha de A ao ativá-la. Fix: nova
   `obterPermissoesEfetivasPorEntidade(usuarioId, empresaId)` em
   `lib/hub-rbac-cache.js` (restringe os vínculos à entidade ANTES de unir;
   cache próprio `usuarioId:empresaId`; invalidação coerente flat + `id:*`), e
   `GET /auditoria` passou a exigir `auditoria.consultar` NA entidade ativa
   (segunda verificação após o gate flat). União flat mantida onde é correta
   (módulos do /me). Cenário provado em `hub-rbac-integration.sh` (admin em B +
   leitura em A → ativa A = 403 sem vazar; ativa B = 200 com a trilha de B).

2. **[MÉDIA — segurança] INSERT de auditoria "global" forjável.** A policy de
   INSERT de 0006 tinha ramo `id_empresa IS NULL` incondicional → qualquer token
   `authenticated` forjava eventos globais. `0009` recria a policy (DROP+CREATE,
   idempotente) limitando o ramo global a um CONJUNTO FECHADO de `acao` de
   autenticação (login_sucesso/login_falha/logout/recuperacao_senha_solicitada/
   senha_redefinida). Decisão documentada no SQL: os inserts globais legítimos
   vêm do backend com `claims={}` (JWT sem `sub` no login), logo NÃO dá para
   exigir `sub`; a restrição por `acao` na própria WITH CHECK é a idempotente
   viável. Provado em `hub-rls-integration.sh` (forja rejeitada e não persistida;
   login_falha global aceito; in-scope aceito; out-of-scope rejeitado).

3. **[MÉDIA] Reset de senha não desbloqueava a conta.** `/redefinir-senha` agora
   zera `tentativas_login` e `bloqueado_ate` no PATCH de sucesso. Provado
   (conta bloqueada → redefinir → login nova senha = 200, não 423).

4. **[MÉDIA] Conta inativa acumulava bloqueio.** Ramo `!ativo` separado do de
   senha incorreta (via `classificarCredencial`): conta inativa NÃO incrementa
   `tentativas_login`/`bloqueado_ate`, resposta uniforme 401 (anti-enumeração).
   Provado (inativa + senha correta 5× → bloqueado_ate NULL, tentativas 0).

5. **[MÉDIA] Refresh expirado revogava todas as sessões.** `classificarSessaoRefresh`
   distingue REUSO (revogado_em preenchido → revoga a família, defesa contra
   roubo) de EXPIRAÇÃO natural (só 401, limpa cookies desta req, NÃO derruba
   outros devices). Provado (device 1 expirado → 401; device 2 segue ativo → 200).

6. **[MÉDIA] Senha não-string virava 500.** Guard `entradaLoginValida` checa
   `typeof` de email/senha antes de qualquer `bcrypt.compare` → 401 uniforme.
   Provado unit (`{senha: 12345}` → false).

7. **[MÉDIA — perf] Índices RLS ausentes.** `0009` adiciona
   `idx_auditoria_id_empresa` e `idx_moduloentidade_empresa_id`
   (CREATE INDEX IF NOT EXISTS). UsuarioEntidade(empresa_id) já existia (0003).

### Resultados observados (ambiente efêmero)

- Unit (`node --test tests/hub-*-unit.test.js`): **67 pass / 0 fail** (20 suites).
- `hub-rls-integration.sh`: **OK (24/24)** — inclui idempotência de 0009 (2ª
  corrida pula) e os 5 asserts do #2.
- `hub-rbac-integration.sh`: **OK** — inclui os 6 asserts do #1 cross-tenant e
  todos os asserts legados (sem entidade → 200 []; sem grant → 403).
- `hub-auth-integration.sh`: **OK** — inclui os asserts de #3/#4/#5 + todos os
  legados (bloqueio, rotação/replay, single-use, imutabilidade 0004).
- Cleanup: nenhum `hub-test-*` órfão (container/volume); `hub_homolog_*` e
  produção intactos. Evidência em `evidencias/S2/07-fix-review-testes.txt`.

### Follow-up (NÃO corrigido — pendências conhecidas)

- **Auditor não vê eventos globais (id_empresa NULL) no GET /auditoria** — a
  query filtra `id_empresa=eq.<entidade>`, deixando os eventos globais de auth
  fora. Decisão de produto (avaliar em S3+).
- **Lost update no contador de tentativas** (read-modify-write não atômico) —
  exige incremento atômico (mudança estrutural), avaliar depois.
- **Arquitetura**: claim `empresa_ativa` morta nas policies; `claims` como 4º
  parâmetro opcional de `hubPostgrestRequest` (risco de 0-linhas silencioso →
  considerar cliente PostgREST req-scoped); incoerência GRANT×policy em
  UsuarioEntidade/ModuloEntidade; dedup dos helpers de JWT (verify/sign/cookies)
  num `lib/hub-token.js`. Todos para S3+.
