# Research: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

Documento produzido no Phase 0 do `/plan`. Resolve os pontos técnicos em aberto após a
spec + clarify, antes do design (Phase 1).

## Decision 1: Localização física das migrations do hub

**Decision**: as migrations desta fundação (`Usuario`, `UsuarioEntidade`, `Papel`,
`Permissao`, `PapelPermissao`, `Modulo`, `ModuloEntidade`, `Auditoria`, `SessaoRefresh` +
seeds + migração de dados) vivem em `infra/hub/migrations/`, numeradas `0002_*` a
`0008_*` — continuando a série já estabelecida por `0000_schema_migration.sql` e
`0001_postgrest_roles.sql` (S1). **Não** vão para `app_homologacao/backend/db/011+`.

**Rationale**: o `infra/hub/scripts/migrate.sh` (já construído, testado e aprovado no
gate G2 da S1, com 20/20 evidências) lê `MIG_DIR="$(dirname "$0")/../migrations"` — ou
seja, aponta hardcoded para `infra/hub/migrations/*.sql`, aplica-as idempotentemente
contra o banco isolado do hub e reinicia o schema cache do PostgREST via `SIGUSR1`. Esse
é o único mecanismo de migração *funcional e testado* disponível hoje para os bancos
`hub_dev`/`hub_test`/`hub_homolog`. Além disso, `app_homologacao/backend/db/` é o
histórico de DDL de **produção** (`chatmasterveloz`), aplicado manualmente pelo operador
via `psql` contra o banco vivo do cliente em cada feature anterior — depositar ali
migrations que nunca devem tocar produção (o cutover de `Usuario` só ocorre em sessão
futura, S10+) criaria ambiguidade sobre o que é seguro rodar contra o cliente.

**Alternatives considered**:
- `app_homologacao/backend/db/011_*.sql` (redação original do briefing/plano mestre,
  anterior à S1 ter concretizado `infra/hub/migrations/`) — rejeitada: nenhum script
  aplica esse diretório contra o banco do hub; exigiria construir um segundo runner de
  migration redundante com `migrate.sh`, violando "série única" na prática (teria duas
  fontes de verdade de schema).
- Nova série em `docs/sql/` — rejeitada explicitamente pela decisão D1 do plano mestre
  (série congelada).

## Decision 2: Registro de rotas novas sem tocar endpoints legados

**Decision**: `server.js` recebe apenas linhas **aditivas** de `app.use()` montando os
novos routers (`hub-auth.js`, `hub-me.js`) — nenhuma linha dentro de handlers/rotas
existentes é tocada. Os módulos novos são arquivos 100% novos
(`routes/hub-*.js`, `middleware/hub-require-permission.js`, `lib/hub-*.js`).

**Rationale**: satisfaz literalmente o critério de aceite #6 ("zero mudanças em
endpoints legados — diff limpo") e a restrição de plano ("PROIBIDO tocar endpoints
legados /login, /upload, /envio-massa, /validate-xml-batch"). `git diff` em `server.js`
mostrará só adições, nunca alteração de linha existente.

**Alternatives considered**: modularizar `/login` legado para delegar a `Usuario` desde
já — rejeitada, é o comportamento do estágio *contract* (pós-cutover, fora do escopo
desta fundação, ver §11.5 do plano técnico).

## Decision 3: Evolução do JWT do PostgREST (claims por request)

**Decision**: criar `lib/hub-postgrest-jwt.js` com uma função nova
(`generateHubPostgrestJWT(usuarioId, empresaAtivaId, escopoEntidadeIds)`) que assina, por
request, um JWT com `role: 'authenticated'`, `sub: usuarioId`, `empresa_ativa:
empresaAtivaId` e `escopo: escopoEntidadeIds` (array), usando o mesmo `PGRST_JWT_SECRET`
já provisionado em `/var/lib/hub_secrets/.env.hub.*`. A função legada
`generatePostgrestJWT()` (`server.js:99-106`, token estático sem claims) **não é
editada** — é código de produção fora do escopo desta fundação.

**Rationale**: RLS (FR-026–028) só consegue decidir por entidade se o PostgREST
propagar claims de escopo nas policies (`current_setting('request.jwt.claims', true)`).
Gerar o token por request (não estático) é pré-requisito técnico já identificado no
plano técnico §11.3.

**Alternatives considered**: reaproveitar/editar `generatePostgrestJWT()` global —
rejeitada, misturaria o token estático de produção com claims específicos do hub e
criaria acoplamento entre os dois ambientes num único ponto de código compartilhado
sem necessidade (o hub já builda por Dockerfile separado; não há ganho em compartilhar
essa função específica).

## Decision 4: Role PostgREST `authenticated` + policies RLS

**Decision**: migration `0006_rls_policies.sql` cria o role `authenticated` (login via
JWT, distinto do `hub_web_anon` criado em `0001`), concede `SELECT`/`INSERT`/`UPDATE` nas
tabelas novas (exceto `Auditoria`, que recebe GRANT só de `SELECT`/`INSERT` — ver Decision
6), habilita `ROW LEVEL SECURITY` em cada tabela com coluna de associação a entidade, e
define policies `USING` que checam a claim `escopo` do JWT — **nega por padrão** (FR-028):
se a claim estiver ausente/nula/vazia, a policy não retorna linha alguma (não existe
policy "permitir se claim ausente").

**Rationale**: implementa literalmente FR-026–028 como reforço independente da
verificação de permissão em `requirePermission` — mesmo que o middleware tenha bug, a
policy do Postgres barra a leitura cross-entidade.

**Alternatives considered**: aplicar RLS também sobre `Empresa`/`Motorista`/`EnvioMassa`
(dados já existentes) — rejeitada explicitamente pelo clarify Q1 (postura expand-only:
esta camada cobre só os dados NOVOS desta fundação, FR-027).

## Decision 5: Precedência RBAC — união de grants

**Decision**: quando uma pessoa acumula mais de um papel aplicável (FR-009), o cálculo de
permissões efetivas é a **união** de todas as permissões de todos os papéis aplicáveis —
sem herança entre papéis e sem negação explícita (não existe "papel que revoga
permissão de outro papel").

**Rationale**: já definido no briefing S2 (`Precedência RBAC: união de grants, sem
herança, sem negação`) e reafirmado pela spec FR-009. Simplicidade de implementação
(cache = `SELECT DISTINCT permissao FROM ... WHERE usuario tem papel X`) e ausência de
qualquer requisito na spec pedindo negação explícita.

**Alternatives considered**: modelo com precedência/prioridade entre papéis — rejeitado,
nenhuma fonte (spec, briefing, constitution) exige isso e adicionaria complexidade não
justificada (violaria a regra de Complexity Tracking).

## Decision 6: Imutabilidade da Auditoria — reforço em duas camadas

**Decision**: (a) nenhum endpoint do hub expõe edição/remoção de `Auditoria` (nem
`PUT`/`PATCH`/`DELETE` nunca são registrados para esse recurso em `hub-me.js` ou em
qualquer router novo); (b) migration `0004_auditoria.sql` faz `REVOKE UPDATE, DELETE ON
"Auditoria" FROM authenticated` (e de qualquer role de aplicação) e cria um trigger
`BEFORE UPDATE OR DELETE ON "Auditoria" EXECUTE FUNCTION hub_bloqueia_alteracao_auditoria()`
que faz `RAISE EXCEPTION` incondicionalmente.

**Rationale**: decisão do operador (clarify Q2/block-001), integrada na spec (FR-024),
coerente com a postura nega-por-padrão de FR-028 — defesa em profundidade mesmo que a
camada de aplicação seja contornada ou tenha bug.

**Alternatives considered**: apenas garantia na camada de aplicação (nenhum endpoint de
edição) — era a opção B, rejeitada pelo operador em favor do reforço adicional no banco.

## Decision 7: Cache de permissões — TTL 60s com invalidação ativa

**Decision**: `lib/hub-rbac-cache.js` mantém um `Map` in-memory `usuarioId →
{permissoes: Set, expiraEm}` com TTL de 60 s. Além da expiração natural, toda operação
administrativa que altera papel/vínculo de um usuário (`UsuarioEntidade` ou
`PapelPermissao`) **invalida explicitamente** a entrada do usuário afetado no cache,
garantindo SC-004 (≤60s) mesmo no pior caso (mudança ocorre 1ms depois do cache ter sido
populado).

**Rationale**: cumprir SC-004 apenas com TTL natural teria pior caso de 60s + latência de
próxima ação — invalidação ativa faz o pior caso real ser bem menor, e o TTL natural
funciona como rede de segurança para o caso em que a invalidação ativa falhar (ex.: dois
processos do hub rodando — spec já declara N/A explícito para múltiplas instâncias nesta
fase, mas a invalidação ativa é barata e não custa manter).

**Alternatives considered**: sem cache (checar permissão no banco a cada request) —
rejeitada, adicionaria uma query PostgREST extra em toda ação protegida sem necessidade,
dado que o próprio briefing já definiu TTL 60s como padrão.

## Decision 8: Rate limiting behind Traefik — `trust proxy` obrigatório desde o commit inicial

**Decision**: o app Express do hub chama `app.set('trust proxy', 1)` (ou lista explícita
de proxies confiáveis) **antes** de registrar `express-rate-limit` na rota de login/
recuperação, e a chave do rate-limit é composta por **IP + conta** (e-mail normalizado),
não apenas IP.

**Rationale**: lição já registrada em produção (memória `fix-login-motorista-429-
trust-proxy`) — sem `trust proxy` atrás de um proxy reverso (Traefik), `req.ip` fica
constante para todas as requisições e o rate-limit vira um balde global que bloqueia
todo mundo com uma única origem aparente. O hub roda atrás do Traefik próprio
(`infra/hub/traefik/`), logo o mesmo bug de infraestrutura se replicaria se não for
corrigido preventivamente aqui.

**Alternatives considered**: copiar o rate-limiter legado (`server.js:83`) sem revisão —
rejeitada, o legado tinha exatamente esse bug até ser corrigido numa branch separada
(`fix/motorista-login-429-trust-proxy`, ainda não deployada); reproduzi-lo no hub seria
regressão conhecida evitável.

## Decision 9: Sessão de refresh e token de recuperação — hash-only, single-use

**Decision**: `SessaoRefresh.token_hash` armazena hash (não o token em texto plano); a
cada renovação bem-sucedida, o hash antigo é marcado `revogado_em` e um novo hash é
gravado (rotação — reuso do token antigo após rotação é tratado como possível replay e
revoga toda a família de sessão). O token de recuperação de senha
(`Usuario.token_recuperacao_hash`) segue o mesmo padrão: hash-only, expiração
(`token_recuperacao_expira`), e é invalidado (`NULL`) no primeiro uso bem-sucedido ou ao
ser sobrescrito por um novo pedido (FR-021, Edge Case "apenas o pedido mais recente é
válido").

**Rationale**: FR-021/FR-022/SC-007 exigem invalidação total no reset de senha e uso
único do token de recuperação; armazenar hash (não o valor bruto) evita que um vazamento
do banco (via `Auditoria.detalhes` ou dump) exponha tokens utilizáveis (FR-025).

**Alternatives considered**: TTL apenas sem hashing (guardar o token em claro) —
rejeitada, viola FR-025 (nunca em texto aberto) e o precedente de segurança já adotado
para outros tokens no projeto.

**Remediação do gate `owasp-security` (ASVS L1 — session tokens ≥128 bits de
entropia)**: o valor bruto do refresh token e do token de recuperação MUST ser gerado
com `crypto.randomBytes(32)` (256 bits), nunca `Math.random()` nem UUID v4 (122 bits
efetivos e não pensado para segredo criptográfico). O hash armazenado (`token_hash`,
`token_recuperacao_hash`) é `sha256` do valor bruto.

## Decision 10: `Dockerfile.hub` — Node 20 LTS, mesma árvore de código

**Decision**: `app_homologacao/backend/Dockerfile.hub` é um Dockerfile multi-stage
baseado em `node:20-alpine`, espelhando a estrutura do `Dockerfile` de produção (que usa
`node:14`), mas com o `.dockerignore` existente (que já exclui `node_modules`) garantindo
que módulos nativos (`bcrypt`) recompilem para a ABI do Node 20 durante o build — não
copiar binários pré-compilados do host.

**Rationale**: já é constraint explícita do prompt operacional da sessão ("Backend do hub
em Node 20 LTS; legado node:14 não muda") e gotcha conhecido do projeto (`bcrypt`
recompila no build, `.dockerignore` já cobre isso — ver CLAUDE.md "Convenções de
deploy").

**Alternatives considered**: rodar o hub também em Node 14 (reusar o `Dockerfile` de
produção tal qual) — rejeitada, contradiz a decisão já tomada na sessão de modernizar o
runtime do hub sem arriscar o legado (o `Dockerfile` de produção é propositalmente
congelado).

## Decision 11: Mock de e-mail para recuperação de senha

**Decision**: reaproveitar/estender `infra/hub/mocks/placeholder/` (ou criar
`infra/hub/mocks/mailpit-like/`) como um servidor HTTP mínimo (Node stdlib, sem deps) que
recebe o "envio" de e-mail de recuperação e o expõe para inspeção em teste (não envia
e-mail real). O código do hub chama esse mock via variável de ambiente
(`MAIL_MOCK_URL` ou similar, seguindo o padrão de `FASTAPI_URL`/`N8N_URL` já usado).

**Rationale**: a spec exige "e-mail via mock/mailpit" (briefing S2) e o ambiente é
isolado por design (S1) — nenhum e-mail real deve sair do ambiente `hub-*`.

**Alternatives considered**: usar um provedor de e-mail real de teste (ex.: Mailtrap
externo) — rejeitado, violaria o Princípio III (blast radius confinado — nenhuma
comunicação externa exceto `gh issue create` no toolkit) e a promessa de isolamento total
da S1.

## Decision 12: Pinagem de algoritmo JWT (remediação `owasp-security` — confusão de algoritmo)

**Decision**: toda chamada `jwt.verify()` no código do hub (validação de
`accessToken`/`refreshToken` de sessão E do JWT gerado para o PostgREST) MUST passar
`{ algorithms: ['HS256'] }` explicitamente — nunca deixar a lib inferir o algoritmo do
header do token recebido.

**Rationale**: achado do gate `owasp-security` (A04/A08 — Cryptographic/Integrity
Failures, "confusão de algoritmo"). Sem pinagem explícita, `jsonwebtoken` aceitaria
qualquer algoritmo declarado no header do token (inclusive `none` em bibliotecas mal
configuradas), permitindo a um atacante forjar um token sem conhecer o segredo. Já é o
padrão correto assumido implicitamente pelo código legado (`jwt.sign` com secret HS256),
mas nunca foi declarado explicitamente nas chamadas de verificação — esta fundação
corrige isso desde o primeiro commit.

**Alternatives considered**: confiar no default da lib — rejeitado pelo gate de
segurança; custo de declarar o array de algoritmos é zero.

## Decision 13: Fail-closed explícito em `requirePermission` e no cálculo de RBAC

**Decision**: `middleware/hub-require-permission.js` MUST negar (retornar `403`) sempre
que a resolução de permissões falhar por qualquer motivo de infraestrutura (PostgREST
indisponível, erro de rede, exceção não tratada) — nunca `next()` em um bloco
`catch`/`else` de erro. O mesmo vale para `hub-rbac-cache.js`: cache-miss seguido de erro
na consulta ao PostgREST resulta em "sem permissões" (conjunto vazio), nunca em
"permitir tudo" ou "reusar a última entrada conhecida como válida indefinidamente".

**Rationale**: achado do gate `owasp-security` — "fail-closed em checagem de permissão é
mandatório; `return True`/`next()` no `except` é o padrão de vulnerabilidade mais crítico
do checklist". Reforça, no nível de implementação, a mesma postura nega-por-padrão já
adotada em FR-028 para a camada RLS — agora também explícita na camada de aplicação.

**Alternatives considered**: nenhuma — este é um requisito de segurança não-negociável,
sem trade-off razoável a considerar.

## Decision 14: Rate limiting também em `recuperar-senha` (não só em `login`)

**Decision**: `POST /api/v1/auth/recuperar-senha` recebe o MESMO rate-limiter (IP+conta/
e-mail normalizado) usado em `/auth/login` (Decision 8) — não apenas o endpoint de login.

**Rationale**: achado do gate `owasp-security` (A06 Insecure Design / LLM10-like
"Unbounded Consumption" aplicado a recursos não-LLM) — sem rate-limit, o endpoint de
recuperação de senha vira vetor de: (a) flood do mock de e-mail (e, após cutover, do
serviço de e-mail real); (b) enumeração por timing caso o dummy-hash de FR-020 não seja
perfeitamente uniforme sob alta concorrência. O plano original (Decision 8) só cobria
login explicitamente; esta decisão estende a mesma proteção ao endpoint de recuperação.

**Alternatives considered**: rate-limit só por IP (sem componente de conta/e-mail) —
insuficiente, pois um atacante rotacionando IPs ainda conseguiria floodar um único
e-mail-alvo; mantém-se a chave composta IP+conta também aqui, espelhando Decision 8.
