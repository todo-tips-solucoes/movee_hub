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

---

## 2026-07-07 — S3 (Shell Modular do Hub) CONCLUÍDA — FASES 1–7, evidências e PR draft

Executada via `/feature-00c` (13 ondas, branch `feat/hub-shell`, commits
`e404fed..645a646`) sobre as fundações da S2. Entrega: a **casca de
navegação** do painel do hub — `ModuleNav` data-driven por permissão,
`EntitySwitcher`/seleção de entidade, `EnvBadge`, telas de autenticação
(login, recuperar/redefinir senha, perfil com troca de senha, logout),
`/hub/dashboard` por módulo. **Sem** telas de módulo de negócio (S4–S9, ficam
para as próximas fases), **sem DDL** (o `/me` da S2 já cobre 100% dos dados
do shell — dec-016), **sem tocar** o auth legado do envio em massa
(`contexts/auth-context.tsx` intocado — FR-018/SC-007).

### Fases (pipeline SDD completo)

1. **Contratos, correções de documentação e adaptador de borda** —
   CHK010/CHK015 corrigidos (`usuarios.manage`→`usuarios.gerenciar`,
   `/usuarios`→`/api/v1/auditoria`, "5 falhas/15min"→`max:10`/`windowMs:15min`
   reais do `authRateLimiter`); reverificação direta de `hub-me.js`/
   `hub-auth.js`; `lib/hub/me-dto.ts` (adaptador snake↔camel, 8/8 vitest);
   `HubAuthProvider` novo (dec-017: provider novo, legado intocado).
2. **`ModuleNav` + `EnvBadge`** — navegação data-driven por `modulos[]` do
   `/me` (sem hardcode), banner de ambiente não-produção com fail-safe
   (CHK029).
3. **`EntitySwitcher` e seleção de entidade** — troca de entidade ativa sem
   novo login; `/selecionar-entidade` com 3 ramos por quantidade de vínculos.
4. **Telas de autenticação** — `/hub/login`, `/hub/recuperar-senha`,
   `/hub/redefinir-senha`, `/hub/dashboard/perfil` (troca de senha via reuso
   do fluxo de recuperação — sem endpoint novo, fora da fronteira dec-010),
   logout + guard de rota (FR-015). Namespace `/hub/*` para as rotas que
   colidiriam com o legado (**dec-041**: `app/login` e `app/dashboard` já
   existem como páginas do envio-massa legado; `motoristas` colidiria
   letra-por-letra com `app/dashboard/motoristas` legado → prefixo `/hub`
   para as rotas do shell).
5. **Dashboard** — `/hub/dashboard` com cards por módulo + estado "sem
   módulo disponível".
6. **E2E, evidências e segurança** — ambiente isolado `hub-homolog` (exceção
   standing G1, VPSTodo) com o serviço `frontend` novo (Next standalone,
   `node:20-alpine`, `Dockerfile.hub`); build sob **rito anti-starvation**
   (`--memory=2g`, swap 8G, RAM `available` nunca abaixo de ~6.5Gi) —
   **produção permaneceu 8/8 Up o tempo todo**, confirmado antes/depois.
   Resultados: **73 testes unitários (vitest) verdes** (soma das telas:
   8+5+3+5+4 + suítes anteriores), **11/11 asserts E2E via API/proxy**
   (`hub-shell-e2e-homolog.sh` — 403 por acesso direto sem permissão, troca
   de entidade refletida em `/me`, `EnvBadge` presente, `entidades: []` sem
   vínculo), **10/10 testes E2E browser** (Playwright real dentro de
   `mcr.microsoft.com/playwright:v1.61.1-jammy`, nunca instalado no host —
   menus por papel 8×6 itens, troca de entidade em 162ms, sessão corrompida
   redireciona sem flash de conteúdo protegido), **axe 6/6 telas = 100/100**
   (4 achados reais de `landmark-one-main`/`page-has-heading-one`/`region`
   corrigidos nesta onda — `<main>` + `<h1>` em login/recuperar/redefinir/
   selecionar-entidade). Gate de segurança pós-implementação: cookies
   `httpOnly`+`sameSite=strict`+`secure`, **nenhum** `PermissionGate`/
   `hasPermission` no shell (menu deriva de `me.modulos`, autorização real
   é 100% backend — dec-015: `PermissionGate` é decorativo por design,
   comprovado pelo 403 do cenário 6.2.2), sem PII/segredo novo (grep
   negativo). Dois achados de ambiente corrigidos no driver de teste (não no
   produto): seed de `ModuloEntidade` para as empresas sintéticas do browser
   E2E, e rate limiter de `/auth/login` esgotando com múltiplos logins por
   suíte (fix: 1 login por papel + `storageState` reusado).
7. **PR + DIARIO (esta entrada)** — corpo do PR preparado em
   `docs/specs/hub-shell/PR-BODY.md`; abertura do PR (`gh pr create`) e push
   da branch ficam com o orquestrador PAI (que detém o lock e a
   autorização); merge/deploy seguem com o operador.

### Decisões-chave

- **dec-014**: `/me.modulos[].ativo` (não `.habilitado`) consumido por
  presença no array — sem tocar o backend da S2 (dec-010).
- **dec-015**: `PermissionGate` é decorativo; autorização real é backend
  por-entidade (RLS + `requirePermission` + `obterPermissoesEfetivasPorEntidade`
  da S2/pós-review). Satisfaz FR-002/SC-002 sem depender do client.
- **dec-017**: auth do shell em `contexts/hub-auth-context.tsx` **novo**;
  legado `contexts/auth-context.tsx` (envio-massa) **intocado**.
- **dec-019**: gate `owasp-security` arquitetural — nenhum finding
  critical/high; A01 mitigado por design (backend reautoriza por-entidade),
  A07/CSRF cobertos por TTL curto + `sameSite=strict`.
- **dec-041**: namespace `/hub/*` para as rotas que colidem com o legado
  (`app/login`, `app/dashboard`, `app/dashboard/motoristas` já existem no
  envio-massa).

### Evidências (`docs/plans/hub-frota/evidencias/S3/`)

- `fase6-e2e-evidencias.md` — consolidado completo (ambiente, cenários,
  achados, gate de segurança).
- `fase6-browser-run-*.log` — log bruto da execução Playwright + axe.
- `6.5.1-modulenav-admin_entidade.png` / `6.5.1-modulenav-operador.png` —
  prints do `ModuleNav` por papel (8 vs 6 itens).
- Nenhum dado pessoal real: contas sintéticas `e2e-teste-shell-*@example.test`
  criadas/removidas por script em cada execução.

### Blast radius

Toda escrita ficou confinada a recursos `hub-*` (compose `hub-homolog`,
containers `hub_homolog_*`) — **zero escrita** no ambiente vivo do cliente
(`chatmasterveloz`, `envio-massa-homologacao_*`, `pgadmin_db`,
Traefik/tags de produção). Build validado sem impacto em produção (rito
anti-starvation, RAM/swap monitorados antes/depois). Sem DDL nesta fase.

### Estado / pendências para o operador

- **PR draft** a ser aberto pelo orquestrador PAI na branch `feat/hub-shell`
  → `main` (corpo em `docs/specs/hub-shell/PR-BODY.md`); revisão e merge são
  do operador.
- **Deploy/cutover**: fora do escopo desta sessão — exige os 5 gates do rito
  de produção do CLAUDE.md; o **gate G3** (cutover para produção) só ocorre
  no fechamento da **S10** (plano mestre), não nesta fase.
- Ambiente `hub-homolog` permanece NO AR, não foi derrubado.
- Pendência recorrente (desde S1): divergência do trailer de commit
  (CLAUDE.md pede "Claude Opus 4.8"; commits usam o modelo vigente) — segue
  sem decisão do operador.

---

## 2026-07-07 — Gate D4 RESOLVIDO (destrava a S4) — decisão do operador (Paulo)

- **Contexto:** o G1 (2026-07-05) confirmou só `soma_das_taxas_das_corridas_aceitas`
  = centavos (int) e `tempo_disponivel_escalado` = percentual; `atingido` e
  `margem_fee_porcentagem` ficaram **PENDENTES e bloqueantes da S4** (D4 PARCIAL,
  DIARIO 2026-07-05 linhas 82–83; plano técnico §14 "o briefing s4 não inicia sem D4").
- **D4 CONFIRMADO INTEGRALMENTE pelo operador (Paulo), 2026-07-07** — ratificou o
  **default técnico do plano** (ingestão fiel, sem pré-interpretar negócio):
  - **`atingido`** → persistir fielmente como `numeric(8,2) NULL` (transformação
    vírgula→ponto), validação de faixa ampla **0–1000**; presente só em ~2,6% das
    linhas (bônus por meta). O sentido de negócio (% de meta atingida) fica para
    **S6/S7**, não é interpretado na S4.
  - **`margem_fee_porcentagem`** (texto `MIN: x, INTER: y`) → guardar `margem_fee_raw`
    **cru** + derivar `margem_fee_min`/`margem_fee_inter` (`numeric(8,2)`) via regex
    `MIN: (x), INTER: (y)`; parse falho ⇒ só `raw`. **Sem** interpretar o que MIN/INTER
    significam nesta fase (interpretação de comissão/faixa fica para S6).
- **Efeito:** **D4 = RESOLVIDA (100%)**. Pré-condição bloqueante da S4 satisfeita e
  registrada. A S4 pode iniciar. (D6 — mais dias de CSV — segue recomendado, não
  bloqueante.)
- **Decorrência:** matriz §10 e catálogo §9.2 do plano técnico ficam **canônicos e
  vigentes** para os dois campos (nada a alterar no plano — o operador ratificou o que
  já estava lá).

---

## 2026-07-07 — S4 (Pipeline de Importações) CONCLUÍDA — FASES 0–7, evidências e PR draft

Executada via `/feature-00c` (11 ondas, branch `feat/hub-importacoes`,
commits `d584d5a..24e5d28`) sobre o shell da S3. Entrega: pipeline de
ingestão de CSVs de **faturamento** e **performance** — upload com dedupe
duplo (hash de arquivo + hash de linha), parser por dialeto (BOM, `;`,
decimal vírgula no faturamento / ponto na performance, `HH:MM:SS`→interval,
UUID, `margem_fee` via regex), processamento em lote de 500 com máquina de
estados (`pending→validating→processing→completed|completed_with_errors|
failed`), 7 endpoints (`POST /`, `GET /`, `GET /:id`, `GET /:id/erros`,
`GET /:id/original`, `POST /:id/reprocessar`, `POST /:id/cancelar`) e 3
telas novas (histórico, detalhe, wizard de upload) via EntreGô 2.0.

### Fases (pipeline SDD completo)

0. **Resolução de checklist humano pré-execução** — CHK004/007/013/036
   resolvidos via `dec-030..033` (commit `c37a9ba`) antes de iniciar as
   subtarefas dependentes: unit test dedicado do processor; lote 500 como
   teto de responsividade do cancelamento; campo derivado `aguardandoLock`
   sem coluna nova; e a mudança de design mais relevante — `pg_try_
   advisory_lock` não é sustentável com `hub-postgrest.js` HTTP stateless
   (sem pool `pg` direto no backend), substituído por índice único parcial
   em `ImportacaoArquivo(id_empresa, tipo) WHERE status IN ('validating',
   'processing')` com o mesmo contrato funcional.
1. **Migrations 0010-0016** — `Entregador`, `ImportacaoArquivo`,
   `ImportacaoLinhaErro`, `FaturamentoLancamento`, `PerformanceTurno`, RLS
   por `id_empresa` nas 5 tabelas (incl. `ImportacaoLinhaErro`
   denormalizado), seed de `importacoes.exportar` por papel. Migration
   idempotente confirmada (rodagem dupla, `01-migrate-fase1-run1.txt` /
   `02-migrate-fase1-run2-idempotencia.txt`); RLS confirmado por 15 asserts
   PASS (`03-rls-importacoes-integration.txt`).
2. **Parser + normalizador** — unit-first, dialetos faturamento/performance
   distintos (decimal, timestamp, delimitador), hash estável por linha.
3. **`POST /importacoes`** — upload + validações imediatas (422) + dedupe
   por `id_empresa+tipo+hash` (409 com `importacaoOriginalId`).
4. **Processamento em lote** — máquina de estados, mutex via índice parcial
   (item 0 acima), rollback em falha estrutural (>50% linhas inválidas),
   `ImportacaoLinhaErro` com valor mascarado (LGPD).
5. **6→7 endpoints de consulta/ação** — `GET /`, `GET /:id`, `GET /:id/
   erros`, `GET /:id/original` (gate `importacoes.exportar`), `POST /:id/
   reprocessar`, `POST /:id/cancelar`, todos com `requirePermission`
   escopado por-entidade + RLS.
6. **Telas** — histórico (`page.tsx`), detalhe (`[id]/page.tsx`), wizard de
   upload, implementadas seguindo diretamente os componentes já aprovados
   da S2/S3 (`data-table.tsx`, `filters.tsx`) em vez de gerar do zero;
   auditoria `ui-ux-pro-max` pós-implementação aplicou correções de
   touch-target (44px mínimo mobile) em selects/botões/wizard, zero mudança
   de lógica/shape de API.
7. **E2E, evidências e segurança** (hub-homolog persistente) — Cenários
   1-11 do `quickstart.md`: happy path 20/20 válidas (SC-001); reimportação
   + dedupe de linha = 0 duplicatas (SC-002); dialeto performance 5/6
   válidas; erros+LGPD 8/10 válidas com CSV-injection escapado e 0 UUID
   bruto exposto (SC-004); falha estrutural 60%→`failed` sem intervenção
   manual (SC-003); reprocessar/cancelar com os 4 códigos HTTP esperados;
   gate de export 403/200 por papel (SC-006); isolamento RLS 404
   cross-tenant (Constitution II); concorrência com 2 uploads simultâneos
   ambos `completed` (índice parcial supre o `pg_try_advisory_lock`
   original); roundtrip real do contrato (`GET /:id`) capturado em
   `roundtrip-payload-exemplo.json`; branding dark/light 4 PNGs (SC-007);
   0 ocorrências de CPF/CNPJ formatado nos logs (`lgpd-zero-vazamentos.md`,
   SC-004). Produção confirmada 4/4 antes/depois (zero regressão no envio
   em massa legado, SC-008).

### Review-task (onda de fechamento)

Relatório completo em `docs/specs/hub-importacoes/review-onda-011.md`.
Testes **reexecutados de forma independente** nesta onda (não apenas
citados): backend unit hub-importacoes **143/143** (`node --test`, 39
suítes); backend unit hub completo **210/210**; frontend vitest **121/121**
(18 arquivos); `tsc --noEmit` 0 erros; `eslint` (escopo importações) 0
erros. Achados do review: (a) contagem real de endpoints é **7**, não 6
(divergência textual, não funcional); (b) `CHK036` do checklist tinha
checkbox desatualizado apesar de já resolvido por decisão — corrigido nesta
onda; (c) SC-005 (jornada completa só pela UI) tem cobertura parcial —
endpoints e telas corretos, mas falta uma gravação fim-a-fim só de clique
(não bloqueante, sugerido como follow-up). Nenhum finding crítico/alto,
nenhum gate pulado sem justificativa, veredito **APROVAR**.

### Decisões-chave

- **dec-030..033** (FASE 0): resolução dos 4 itens `{humano}` do checklist
  antes de iniciar as subtarefas dependentes — a mais relevante é a
  substituição do `pg_try_advisory_lock` por índice único parcial
  (`hub-postgrest.js` é stateless, não sustenta sessão Postgres entre
  chamadas).
- **dec-048/049** (FASE 6): telas implementadas diretamente seguindo os
  padrões já aprovados do EntreGô 2.0, com auditoria `ui-ux-pro-max`
  pós-implementação em vez de geração do zero.
- **dec-053** (FASE 7): fechamento da validação E2E — cenários 1-11
  completos, migration 0017 confirmada aplicada, produção 4/4 antes/depois.
- **dec-054**: auto-checagem de fim de turno corrigiu uma promoção
  prematura de `execution.status=concluida` (o mesmo gotcha de S2/S3 —
  review-task confabulando fechamento antes de rodar de fato); revertido
  para `em_andamento` até o review-task real (esta entrada) rodar.

### Evidências (`docs/plans/hub-frota/evidencias/S4/`)

- `01-migrate-fase1-run1.txt` / `02-migrate-fase1-run2-idempotencia.txt` —
  aplicação idempotente das migrations 0010-0016.
- `03-rls-importacoes-integration.txt` — 15 asserts PASS de isolamento RLS
  nas 5 tabelas novas.
- `04-seed-importacoes-exportar.txt` — seed de permissão `importacoes.
  exportar` por papel.
- `cenarios-1-10-resultado.md` — contadores e resultados dos Cenários 1-9.
- `lgpd-zero-vazamentos.md` — grep negativo de CPF/CNPJ nos logs.
- `roundtrip-payload-exemplo.json` — payload real de `GET /:id`.
- `cenario11-{lista,detalhe}-{dark,light}.png` — evidência de branding
  preservado (SC-007).
- Nenhum dado pessoal real: dados sintéticos de faturamento/performance
  gerados para os cenários de teste.

### Blast radius

Toda escrita ficou confinada a recursos `hub-*` (`hub-homolog`, containers
`hub_homolog_*`) — **zero escrita** no ambiente vivo do cliente
(`chatmasterveloz`, `envio-massa-homologacao_*`, `pgadmin_db`, Traefik/tags
de produção). `git diff --name-only main...feat/hub-importacoes` confirma
nenhum arquivo de infraestrutura viva (`docker-compose.yml`/`.env`/swarm)
tocado. Isolamento multi-tenant (Constitution II, NON-NEGOTIABLE) verificado
via RLS real (Cenário 8 + evidência §RLS acima).

### Estado / pendências para o operador

- **PR draft** aberto pelo orquestrador desta onda na branch
  `feat/hub-importacoes` → `main` (corpo em
  `docs/specs/hub-importacoes/PR-BODY.md`); revisão e merge são do
  operador.
- **Deploy/cutover**: fora do escopo desta sessão — exige os 5 gates do
  rito de produção do CLAUDE.md; o **gate G3** (cutover para produção) só
  ocorre no fechamento da **S10** (plano mestre), não nesta fase.
- Ambiente `hub-homolog` permanece NO AR, não foi derrubado.
- Follow-up não-bloqueante: SC-005 sem gravação fim-a-fim da jornada só
  pela UI (endpoints/telas corretos, falta só a captura visual sequencial).
- Pendência recorrente (desde S1): divergência do trailer de commit
  (CLAUDE.md pede "Claude Opus 4.8"; commits usam o modelo vigente) — segue
  sem decisão do operador.

---

## 2026-07-07 — Code review do PR #57 (S4) + correções pós-review

- **Code review** (a pedido do operador) do diff de código da S4 (28 arquivos-fonte,
  ~5k linhas) via 8 ângulos de finder + 2 verificadores independentes. Base sólida
  (RLS multi-tenant correto, mutex serializado, sem regressão no backend de produção —
  legado usa `postgrestRequest` separado, convenções OK). **13 achados reais confirmados**
  (1 refutado: hash `toFixed(2)` é correto pois colunas de fato são `numeric(_,2)`).
- **Correções F1–F13 aplicadas** na branch (3 commits `95f9905`/`5ee2845`/`6912a66`):
  **F1** deadlock de importação (o mais grave — restart/deploy deixava registro preso
  em `processing` e o índice parcial bloqueava todo o tenant+tipo): try/catch de topo →
  `failed`, timeout real via AbortController, e **recuperação de órfã no boot**
  (`recuperarImportacoesOrfas` em `server.js`, aditivo/try-catch, claim JWT estreito
  `hub_boot_recovery` + policy RLS que só permite `validating/processing→failed` — não
  fura RLS); **F2** inflate async + inspeção barata (não bloqueia o event loop, sem inflar 2×);
  **F3** cap `MAX_LINHAS_IMPORTACAO=300000` (anti-OOM); **F4** regex de zona linear + cap
  (anti-ReDoS); **F5** PATCH terminal guardado por status (cancel não é sobrescrito);
  **F7** rollback de upload por `UPDATE→failed` (não DELETE sem grant); **F8** polling
  robusto (reinício após reprocessar, refetch de erros ao concluir, tolera 3 falhas,
  guarda in-flight); **F9** fallback do `Content-Range` (paginação não some); **F10** original
  com PII em `0600`/dir `0700`; **F11** id só numérico (404 p/ lixo); **F12** `errorTransiente`
  só 5xx/429; **F13** dedupe de linha de erro (`on_conflict` + índice único, migration 0018).
- **Migration 0018** (idempotente) aplicada no hub-homolog; **produção 4/4 Up** antes/depois.
- **Validação (números reais auditados pelo PAI):** backend unit **250/250**, vitest
  frontend **124/124** (43/43 no escopo importações reexecutado pelo PAI), `tsc` 0, integração
  hub-homolog `processor` 25/25 + `fase5` 43/43 (1 falha pré-existente não-relacionada no
  `hub-importacoes-integration.sh`, header de fixture, idêntica no baseline via `git stash`).
- **PR #57 atualizado** (push da branch; **sem merge/deploy** — decisão do operador; cutover
  do hub para produção é G3/S10). Deploy de S4 nos serviços do cliente NÃO se aplica: a S4
  roda só no `hub-homolog` isolado.

---

## 2026-07-08 — S5 (Módulo Motoristas) CONCLUÍDA — branch feat/hub-motoristas + PR draft

- **Pipeline /feature-00c completa** (13 ondas, `status=concluida`, review-task veredito
  **APROVAR**): specify → clarify (2 respostas automáticas + 3 bloqueios de produto
  respondidos pelo operador) → plan (OWASP: 3 gaps corrigidos nos artefatos) → checklist
  (34 itens) + create-tasks (8 fases / 17 tarefas / 75 subtarefas) → execute-task
  (FASES 1–8, 100% `[x]`) → review-task (métricas determinísticas via `metrics.sh`).
- **Decisões do operador integradas**: D3 já estava decidida no plano (§18, a+b);
  block-001 subpraça = **todas as áreas distintas** no filtro; block-002 sugestões =
  **top 10 por similaridade com limiar mínimo**; block-003 **edição manual de nome
  prevalece** sobre reimportação; block-004 **reeditar sempre** (trigger protege só
  contra o caminho de importação — claim JWT `origem_importacao`, migration 0025).
- **Entregue**: migrations **0019–0025** em `infra/hub/migrations/` (coluna+trigger de
  edição manual; índices de subpraça; `ContaMotorista` espelho local + `pg_trgm`/`unaccent`
  + FK `Entregador.motorista_id`; allowlist `EmpresaGrupoMovee`; RPCs parametrizadas
  `hub_motoristas_candidatos`/`hub_motoristas_busca` SECURITY INVOKER; view de áreas
  anti-N+1; 0025 = proteção só-import); **7 endpoints** `/api/v1/motoristas*`
  (lista paginada server-side com filtros, detalhe all-time, PATCH com allowlist,
  sugestões/busca/contas-elegíveis, vínculo POST com 409/422/404-RLS e DELETE
  idempotente 204); **telas** `/hub/dashboard/motoristas` e `/[id]` + diálogo de vínculo
  em 2 passos (confirmação humana obrigatória — nunca auto-vincular).
- **Validação (números reais, reexecutados na onda de review)**: backend hub-motoristas
  **133/133** unit, frontend **165/165** vitest, integração **122/122** em stacks
  `hub-test-*` efêmeros, `tsc --noEmit` 0, eslint 0; `npm test` geral 372/380 (8 falhas
  pré-existentes em `motorista-integration.test.js`, confirmadas via `git stash` baseline).
  **E2E real** contra `https://hub-homolog.todo-tips.com:8443`: 11 cenários do quickstart
  + 4 screenshots (Cenário 12/branding) em `docs/plans/hub-frota/evidencias/S5/`;
  209 Entregador reais seedados via import; auditoria `motorista.*` 1-para-1.
- **Migration 0025 APLICADA no `hub_homolog_db` persistente** sob autorização explícita
  do operador (exceção G1, recurso `hub_*`): `SchemaMigration` registro 26/26; validação
  em transação+rollback provou 2ª edição manual passando e sobrescrita por import
  bloqueada; SIGUSR1 no PostgREST.
- **Critérios de aceite do briefing**: 1) lista/filtros/edição/vínculo sobre dados
  importados ✔; 2) tela funciona com Entregador sem vínculo ✔; 3) **zero mudanças** na
  tabela `Motorista` e no app motorista ✔; 4) permissões `motoristas.*` no backend
  (403 fail-closed p/ papel leitura) ✔; 5) PR + DIARIO ✔ (esta entrada).
- **Produção intocada**: serviços `envio-massa-homologacao_*` 4/4 Up durante toda a fase
  (deploys/builds só nos recursos `hub-*` sob rito anti-starvation). Merge do PR e
  cutover (G3/S10) seguem com o operador.
- Relatório terminal: `docs/specs/hub-motoristas/review-onda-013.md`. Próxima fase da
  ordem S3→S10 = **S6 (módulo faturamento, briefings/s6-modulo-faturamento.md)**.

---

## 2026-07-08 — S6 (Módulo Faturamento) — FASES 1–7 concluídas, branch feat/hub-faturamento

- **Pipeline `/feature-00c` em andamento** (short_name `hub-faturamento`, onda-008,
  `execute-task` → transição para `review-task`): specify → clarify → plan (gate OWASP
  A05 Injection PASS) → checklist (39 itens) → create-tasks (7 fases / 13 tarefas /
  73 subtarefas, gates verdes) → execute-task (**FASES 1–7, 13/13 tarefas `[x]`**).
- **Entregue**: migrations **0026/0027** (`faturamento.listar` corretivo + RPCs
  parametrizadas `hub_faturamento_totais`/`hub_faturamento_agrupado`, `SECURITY INVOKER`,
  sem SQL montado por concatenação — OWASP A05 PASS); `lib/hub-csv.js` compartilhada
  (neutralização de CSV injection `= + - @`, com gap CHK029 fechado: célula já iniciada
  por apóstrofo/caractere neutro nunca sofre dupla neutralização); **2 endpoints**
  `GET /api/v1/faturamento` (lista paginada + `?format=csv` streaming em lotes de 1.000)
  e `GET /api/v1/faturamento/resumo` (cards + `groupBy=dia|categoria|entregador`);
  DTO/API client (`lib/hub/faturamento-dto.ts`/`faturamento-api.ts`, `valor` sempre
  `string`); tela `/hub/dashboard/faturamento` (cards, filtros server-side rotulados
  explicitamente "data de competência", tabela paginada, export CSV condicionado a
  `faturamento.exportar`, link condicional para `/hub/dashboard/motoristas/{id}` quando
  `motoristas.consultar`, estados vazio/loading/erro).
- **Validação determinística**: backend unit `node --test tests/hub-csv.test.js`
  **9/9 PASS** (inclui CHK029); `infra/hub/testes/hub-faturamento-integration.sh`
  (projeto `hub-test-*` efêmero) **62/62 asserts PASS** (contrato completo de
  `GET /faturamento`/`GET /faturamento/resumo`, isolamento multi-tenant, CSV injection,
  permissões independentes listar/consultar/exportar); frontend `npx vitest run
  lib/hub/faturamento-dto.test.ts` **11/11 PASS**; `tsc --noEmit`/`eslint` limpos;
  `npm run build` OK.
- **E2E real contra `https://hub-homolog.todo-tips.com:8443`** (persistente, usuários QA
  reais `qa.importacoes@moveelog.local`/`qa.motoristas.leitura@moveelog.local`/
  `qa.motoristas.outraempresa@moveelog.local`, login real via cookie de sessão): **42
  PASS / 0 FAIL** cobrindo os 14 cenários do `quickstart.md` — totais batendo com `SUM`
  SQL direto no `hub_homolog_db`, empate alfabético determinístico (dec-014), filtro por
  `data_referencia` (nunca `data_repasse`), período vazio sem erro, export CSV com
  contagem/soma batendo com a tela, CSV injection neutralizada (`=`/`@` + os 2 casos
  CHK029: apóstrofo pré-existente sem dupla neutralização e caractere neutro sem prefixo
  espúrio), bypass de permissão via `curl` direto (`403 PERMISSAO_NEGADA`), isolamento
  multi-tenant real (empresa 9002 sintética inserida só para a prova, zero vazamento nos
  dois sentidos), navegação condicional ao detalhe do entregador (código +
  re-execução do backstop 403 de `hub-motoristas-integration.sh`), roundtrip/identidade
  visual (herdados da FASE 6, sem regressão).
- **Cenário 15 (performance, SC-004) — ACHADO REAL, dec-035**: seed de ~900 mil linhas
  (~1 ano, `id_empresa=9001`, gerado via `generate_series` direto no `hub_homolog_db`,
  32,5s de INSERT) — `GET /faturamento/resumo` sobre o ano inteiro populado mediu
  **2,2–2,6s sem `groupBy`** e **1,6–1,7s com `groupBy=categoria`**, **ambos excedendo o
  limite de 1s de SC-004**. `EXPLAIN (ANALYZE, BUFFERS)` confirma Seq Scan sobre ~900k
  linhas (esperado — o filtro cobre ~100% da tabela no pior caso) e overhead adicional de
  `temp`/ordenação na RPC de cards. **Decisão dec-035 registrada (score 3, evidência
  empírica)**: `mv_faturamento_dia` (§12.6 do plano técnico) é a mitigação pré-aprovada,
  mas implementá-la é escopo novo (nova migration + refresh + mudança nas 2 RPCs) além do
  backlog de 13 tarefas já revisado — **não implementada nesta onda**, escalada para
  decisão do operador (mesmo padrão de governança de D3/D4). Detalhe completo em
  `docs/plans/hub-frota/evidencias/S6/fase7-e2e-perf-resultado.md`.
- **Gate `validate-docs-rendered`** sobre `tasks.md`/`quickstart.md` — **0 ERRO / 0
  AVISO** em ambos.
- **Produção intocada**: toda escrita confinada a recursos `hub-*`/`hub_*` (exceção G1);
  serviços `envio-massa-homologacao_*` não tocados nesta sessão.

### Pendências para o operador

1. **`mv_faturamento_dia`** (dec-035): SC-004 formalmente violado sob volume anual de um
   tenant grande — decidir se implementa a view materializada (nova fase) ou aceita o
   risco por enquanto.
2. **Limpeza do seed de performance** (~900 mil linhas, `id_empresa=9001`, ids
   300–900299, em `hub_homolog_db`): tentativa de `DELETE` foi **bloqueada pelo
   classificador de auto mode** ("mass delete... run outside auto mode") — requer ação
   humana direta (dentro do escopo `hub-*` já autorizado por G1) ou decisão de manter
   como fixture de regressão de performance.
3. Pendência recorrente (desde S1): divergência do trailer de commit (CLAUDE.md pede
   "Claude Opus 4.8"; commits usam o modelo vigente) — segue sem decisão do operador.
4. PR ainda não aberto para `feat/hub-faturamento` — previsto para o fechamento de
   `review-task` (próxima onda), mesmo padrão das fases anteriores.

Relatório de `review-task` (próxima onda) fará a síntese final e decidirá sobre a
abertura do PR. Próxima fase da ordem S3→S10 (após S6) = **S7**.

---

## 2026-07-08 — S6 (Módulo Faturamento) CONCLUÍDA — review-task (onda-009), veredito APROVAR com ressalva, PR draft

- **Pipeline `/feature-00c` completa** (short_name `hub-faturamento`, 9 ondas,
  `status=concluida`): specify → clarify → plan (gate OWASP A05 PASS) → checklist
  (39 itens) → create-tasks (7 fases/13 tarefas/73 subtarefas) → execute-task
  (FASES 1–7, 100% `[x]`) → **review-task (onda-009, veredito APROVAR com ressalva
  formal de SC-004)**.
- **Retry de onda registrado**: a 1ª tentativa da onda-009 (roteada `haiku` pelo
  mapa de model-routing) retornou em ~64s com só 3 tool-uses e nenhuma escrita de
  estado — bug recorrente de parada precoce, agravado em haiku. O comando PAI
  registrou override para `sonnet` (**dec-038**) e a onda foi reaberta do zero
  (**dec-039**) — sem perda: `waves=8` antes do retry, nada havia sido persistido.
- **Reconciliação `.tasks[]`↔`tasks.md`**: 0 divergências pré-reconcile — as 13
  tasks já tinham sido gravadas ao vivo pelo `execute-task` nas ondas 005–007
  (nenhum back-fill necessário).
- **Re-execução ao vivo da validação determinística** (dec-040, não só confiar em
  evidência gravada): `npm test` backend (`hub-faturamento-dto.test.js` +
  `hub-faturamento.test.js`, inclui a suíte `hub-faturamento-integration.sh`
  embutida em projeto `hub-test-*` efêmero) **32/32 PASS**; `hub-csv.test.js`
  **9/9 PASS**; `vitest lib/hub/faturamento-dto.test.ts` **11/11 PASS**;
  `tsc --noEmit` e `eslint` (4 arquivos novos) limpos. Containers `hub-test-*`
  auto-limpos após o run (confirmado via `docker ps -a`).
- **Model-routing**: 0 half-records (`state-decisions-reconcile.sh check` exit 0);
  agregado por-subagente e por-onda colados verbatim no relatório (§ dedicada).
- **ACHADO FORMAL não mascarado — Cenário 15/SC-004 (dec-035)**: sob volume
  ampliado (~900.219 linhas/1 ano, `id_empresa=9001`), `GET /faturamento/resumo`
  mediu 2,2–2,6s sem `groupBy` e 1,6–1,7s com `groupBy=categoria` — **ambos
  excedem o limite de 1s de SC-004**. `mv_faturamento_dia` (mitigação
  pré-aprovada em research.md/plan.md §12.6) **não implementada nesta onda**
  (escopo novo além do backlog de 13 tarefas já revisado) — escalada para
  decisão do operador, mesmo padrão de governança de D3/D4.
- **Veredito (dec-041, score 3): APROVAR — com ressalva formal de SC-004**,
  pendente de decisão do operador sobre `mv_faturamento_dia`. Toda a superfície
  funcional (US1/US2/US3, FR-001..FR-012) está implementada, testada e
  evidenciada; o único achado é um NFR de performance sob pior-caso de volume
  anual de 1 tenant grande, não um bug funcional nem falha de segurança/
  isolamento.
- **PR draft aberto**: `feat/hub-faturamento` → `main` (não mergeável sem decisão
  do operador sobre a ressalva SC-004).
- **Produção intocada**: toda escrita confinada a recursos `hub-*`/`hub_*`
  (exceção G1); `envio-massa-homologacao_*` não tocado nesta onda.

### Pendências para o operador (reafirmadas, sem mudança)

1. **`mv_faturamento_dia`** (dec-035) — decidir se implementa a view materializada
   (nova FASE/S6.1 ou S7 antecipada) ou aceita o risco por enquanto.
2. **Limpeza do seed de ~900k linhas** em `hub_homolog_db` (`id_empresa=9001`,
   ids 300–900299) — bloqueada pelo classificador de auto mode; requer ação
   humana direta (escopo `hub-*` já autorizado por G1) ou manter como fixture de
   regressão de performance.
3. Pendência recorrente (desde S1): trailer de commit do CLAUDE.md ("Claude Opus
   4.8") desatualizado vs modelo vigente — sem decisão do operador.
4. Revisar e mergear o PR draft quando a ressalva SC-004 estiver resolvida/aceita.

Relatório terminal: `docs/specs/hub-faturamento/review-onda-009.md`. Próxima
fase da ordem S3→S10 = **S7**.

## 2026-07-08 — Follow-up S6: SC-004 sanado com `mv_faturamento_dia` (migration 0028)

Follow-up autorizado pelo operador para resolver a ressalva formal do
review da onda-009 (SC-004 violado sob ~900k linhas — dec-035). Mesma
branch `feat/hub-faturamento` (PR draft #59). Mitigação pré-aprovada no
plano técnico §12.6, acionada pela evidência da onda-008.

**O que mudou**

- `infra/hub/migrations/0028_mv_faturamento_dia.sql` — MV
  `mv_faturamento_dia` (grão `id_empresa`+`data_referencia`+`descricao`+
  `entregador_id`; 27.960 linhas ≈ 32x menor que o fato; 4,5 MB vs 320 MB),
  índice ÚNICO (pré-requisito do `REFRESH CONCURRENTLY`), índices de
  filtro, **REVOKE de SELECT direto** para `authenticated`/`hub_web_anon`
  (MV não tem RLS — acesso só via RPC), RPCs `hub_faturamento_totais`/
  `hub_faturamento_agrupado` reescritas (`SECURITY DEFINER` + guard
  explícito `p_id_empresa = ANY (hub_jwt_escopo_ids())`, lendo da MV;
  fallback tabela-base só para filtro `subpraca`) e
  `hub_faturamento_refresh_mv()` (CONCURRENTLY via dblink — PostgREST
  envolve RPC em transação e CONCURRENTLY não roda em transação; fallback
  bloqueante). Contrato da API **inalterado**.
- `backend/lib/hub-import-processor.js` — refresh best-effort da MV ao
  final de toda importação de faturamento bem-sucedida (único caminho de
  escrita nos fatos). Staleness documentado em
  `contracts/faturamento-api.md`.

**Resultado (mesma metodologia/volume da onda-008, HTTP end-to-end)**

| Medição | antes | depois |
|---|---|---|
| `/resumo` sem `groupBy` | 2600.5/2230.6ms | **33.6/40.4ms** |
| `groupBy=categoria` | 1678.0/1625.2ms | **19.5/20.5ms** |
| `groupBy=dia` | — | **30.6/35.4ms** |
| `groupBy=entregador` | — | **39.9/64.9ms** |

**SC-004 PASSA com folga (~25-50x)**. EXPLAIN: 1737.8ms → 28.5ms, zero temp.

**Validação**: 73/73 integração faturamento (12 novos asserts: paridade
MV×base, negativo cross-tenant direto na MV e via RPC — inclusive no
fallback —, staleness/refresh, refresh negado sem escopo); 54/54 unit
processor (+2); 363/363 hub unit; 25/25 integração processor; E2E ao vivo
no hub-homolog (import real `id=30` → auto-refresh → resumo atualizado).
0028 aplicada no `hub_homolog_db` via migrate.sh e backend hub-homolog
redeployado (build com cap `--memory=2g`). Produção nunca tocada — smoke
`app.moveelog.com.br/login` = 200 antes/depois. Evidência literal:
`docs/plans/hub-frota/evidencias/S6/followup-sc004-mv.md`; adendo no
`review-onda-009.md`.

**Pendências**: seed de ~900k linhas (`id_empresa=9001`) mantido de
propósito (fixture da re-medição) — DELETE segue com o operador; PR #59
segue draft aguardando revisão/merge do operador.

### 2026-07-08 — S6 follow-up (parte 2): limpeza do seed de performance EXECUTADA

Com o SC-004 verde (re-medição acima), o operador autorizou explicitamente
o DELETE na sessão ("manter, depois de resolvido o item 1 pode realizar o
delete"). Executado no `hub_homolog_db` (recurso `hub-*`, exceção G1):
`DELETE 900000` (faixa ids 300–900299, `id_empresa=9001`), `VACUUM ANALYZE`
+ `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_faturamento_dia` (tabela e MV
consistentes em 221 linhas) e `VACUUM FULL` (320 MB → 192 kB devolvidos ao
disco). Preservados: 220 linhas legítimas de teste do tenant 9001 (incl. o
fato `id=900300` do E2E do refresh) + 1 linha da prova de isolamento do
tenant 9002. Smoke pós-limpeza: hub-homolog 200, produção 200 (intocada).
Outputs literais na §5 de `evidencias/S6/followup-sc004-mv.md`. **Única
pendência restante da S6: revisão/merge do PR #59.** (Nota: PR #59 foi
mergeado em seguida — squash `b499d8c`, branch deletada, S6 100% fechada.)

### 2026-07-08 — S7 (módulo Performance): specify concluída via /feature-00c

Onda 1 de `/feature-00c hub-performance` (branch alvo `feat/hub-performance`).
Fase `specify` gerou `docs/specs/hub-performance/spec.md` a partir do
briefing `docs/plans/hub-frota/briefings/s7-modulo-performance.md`, com o
schema real do fato `PerformanceTurno` inspecionado no repo antes de
escrever os FRs (migration 0014: `entregador_id` NOT NULL — diferente do
faturamento, aqui **não existe** registro "agregado/sem entregador";
`taxas_centavos`/`tempo_disponivel_pct` nullable; RLS já escopada por
`id_empresa` desde a migration 0015; índice de subpraça já entregue na
0020; nenhuma biblioteca de gráfico no `frontend_v2/package.json` — logo a
tela fica só cards+tabela, sem gráfico novo, conforme o briefing previa).

3 user stories (P1 consultar/filtrar + resumo ponderado; P2 agregado por
dimensão dia/turno/entregador; P3 exportar CSV com a mesma proteção
CSV-injection da S6). 2 marcadores `[NEEDS CLARIFICATION]` deixados para a
fase `clarify`: (1) se a média de `tempo_disponivel_pct` do período é
aritmética simples (default assumido) ou ponderada por outro campo; (2) se
esta fase introduz a permissão `performance.listar` (paridade com a
migration corretiva 0026 que a S6 precisou fazer para `faturamento.listar`)
ou reaproveita as duas permissões já seedadas (`performance.consultar`,
`performance.exportar`) — default assumido: introduzir a terceira
permissão. Gate `validate-documentation` aplicado no espírito (perfil
UC/RB não se aplica a `spec.md` SDD) — sem findings críticos. Onda fechada,
`current_stage=clarify`. Próxima onda: mediação clarify (asker/answerer).

### 2026-07-08 — S7 (módulo Performance): FASE 1-4 (backend) via /feature-00c

Onda 5 de `/feature-00c hub-performance` (branch `feat/hub-performance`,
criada a partir da main; commit dos artefatos SDD specify→create-tasks das
ondas 1-4 + backend das FASES 1-4 nesta onda). clarify/plan/checklist/
create-tasks já haviam concluído (12 tarefas/74 subtarefas em 6 fases,
gates template-fidelity + docs-render sem findings).

**FASE 1 — Migrations e RBAC**: `0029_seed_permissao_performance_listar.sql`
(permissão `performance.listar`, mesmo padrão de `0026`/faturamento — os 4
papéis-seed ganham `listar`, só `admin_plataforma`/`admin_entidade` mantêm
`exportar`) e `0030_hub_performance_rpc_resumo.sql`
(`hub_performance_totais`/`hub_performance_agrupado`, `SECURITY INVOKER`,
fórmula ponderada Σ(pct×duração)/Σduração com fallback para média simples
quando `duracao IS NULL` no conjunto — research.md Decision 2/3). Aplicadas
no `hub_homolog_db` via `migrate.sh`; idempotência confirmada por
re-execução direta via `psql` (não só skip do registro em
`SchemaMigration`). RLS/`SECURITY INVOKER` provados com dados sintéticos
inseridos e removidos no `hub_homolog_db` (escopo `[9001]` chamando
`p_id_empresa=9002` retornou zerado; fórmula ponderada bateu com cálculo
manual: `78.42` = `2682000/34200`; fallback bateu com média simples
`80.00`).

**FASE 2 — Lista `GET /performance`**: `lib/hub-performance-dto.js` +
`routes/hub-performance.js` (arquivo novo, registrado em `server.js`),
mirror do padrão `hub-faturamento` (S6). `entregadorId`/`entregadorNome`
sempre presentes (Decision 4, sem bucket "sem entregador"). 34/34 testes
unit (`hub-performance-dto.test.js`).

**FASE 3 — Resumo `GET /performance/resumo`**: implementado no mesmo
arquivo de rota da FASE 2 (cards + agrupado por `dia`/`periodo`/
`entregador`, Decision 12 — literal `periodo`, não `turno`).

**FASE 4 — Export CSV**: streaming em lotes de 1.000 (Decision 5), reuso
de `lib/hub-csv.js` (Decision 6), checagem inline de `performance.exportar`
independente de `.listar` (Decision 9), auditoria só no sucesso. Gap
CHK031 (célula já-neutra por apóstrofo) fechado também no consumidor
`performance` (não só em `hub-csv.js`).

**Verificação E2E real**: `infra/hub/testes/hub-performance-integration.sh`
(ambiente `hub-test-<runid>` efêmero, build do backend com o código novo,
migrations 0002-0030 aplicadas, seeds sintéticos) — **60/60 asserts PASS**
cobrindo lista/paginação/filtros/isolamento multi-tenant/401/403 (FASE 2),
cards/agrupado/SC-002 (taxa=razão de somas, nunca média)/SC-009 (divisão
por zero=null)/período vazio (FASE 3), export completo/CSV
injection/gap CHK031/auditoria (FASE 4). Ambiente efêmero limpo
automaticamente ao final (`docker compose down -v`, confirmado sem
resíduo). `node --test` local: 34 (dto) + 9 (hub-csv, sem regressão) +
2 wrappers de integração, todos verdes.

7 tasks concluídas nesta onda (1.1, 1.2, 2.1, 2.2, 3.1, 4.1, 4.2) via
`state-ondas.sh record-task`. Onda fechada por corte natural na Matriz de
Dependências: FASE 5 (tela `/hub/dashboard/performance`, frontend
Next.js) é domínio distinto (UI/UX) das FASES 1-4 (backend), e depende de
F2+F3+F4 — todas prontas. Próxima onda: FASE 5 (DTO/API client
frontend + página com cards/filtros/tabela/export, seguindo
`/ui-ux-pro-max` e o padrão de `.../faturamento/page.tsx`), depois FASE 6
(E2E completo no `hub-homolog` + evidências + DIÁRIO final).
