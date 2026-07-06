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
