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
