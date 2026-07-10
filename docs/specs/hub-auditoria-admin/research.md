# Research — hub-auditoria-admin (S9 Auditoria e Administração da Plataforma)

**Feature**: `hub-auditoria-admin` · **Data**: 2026-07-09 · **Input**: spec.md
(clarificada, dec-008/dec-009), briefing S9
(`docs/plans/hub-frota/briefings/s9-auditoria-administracao.md`), codebase real
(exploração empírica de `infra/hub/migrations/`, `app_homologacao/backend/`,
`app_homologacao/frontend_v2/`).

Todos os unknowns do Technical Context foram resolvidos. Nenhum
`NEEDS CLARIFICATION` restante.

---

## Decision 1 — Permissão da consulta de auditoria: `auditoria.consultar` (não `auditoria.list`)

**Decision**: o endpoint `GET /api/v1/auditoria` continua guardado por
`auditoria.consultar`, o código real seedado na migration 0007 e já usado pelo
handler existente (`routes/hub-me.js`, `requirePermission('auditoria.consultar')`).

**Rationale**: o briefing S9 menciona "permissão `auditoria.list`", mas esse
código NÃO existe no seed 0007 (módulo `auditoria` tem apenas
`auditoria.consultar`). Precedente direto: no hub-shell, o checklist CHK010
corrigiu `usuarios.manage` → `usuarios.gerenciar` para alinhar briefing ao
código real. Criar uma permissão nova duplicaria semântica e quebraria o
handler/E2E existentes (`hub-rbac-integration.sh` já asserta 403 sem
`auditoria.consultar`).

**Alternatives considered**: seedar `auditoria.list` nova (rejeitada:
duplicação sem ganho; E2E e handler já usam `.consultar`).

---

## Decision 2 — Visão global do admin_plataforma: claim dedicado no JWT PostgREST + política RLS estendida

**Decision**: introduzir o claim booleano `admin_plataforma` no JWT interno
gerado por `generateHubPostgrestJWT()` (`lib/hub-postgrest-jwt.js`), setado
pelo backend SOMENTE após verificar que o usuário tem vínculo ativo
(`UsuarioEntidade.ativo=true`) com o papel `admin_plataforma` (escopo
`global`, `is_sistema=true`). No banco, novo helper
`hub_jwt_admin_plataforma() RETURNS boolean` (mesmo molde de
`hub_jwt_escopo_ids()`) e a política SELECT da `"Auditoria"` é substituída
(DROP POLICY IF EXISTS + CREATE POLICY — idempotente) para:

```sql
(hub_jwt_admin_plataforma())                                   -- vê tudo, incl. globais
OR (id_empresa IS NOT NULL AND id_empresa = ANY (hub_jwt_escopo_ids()))
```

**Rationale**:
- FR-002/US2 exigem visão cross-entidade sem trocar sessão (SC-007); o
  mecanismo atual (`escopo` claim = lista de entidades vinculadas) não escala
  para "todas as entidades" sem enumerar IDs a cada request.
- Fecha também o edge case da spec: hoje a política de SELECT permite
  `id_empresa IS NULL` a QUALQUER autenticado (0006); a spec exige que
  eventos globais (auth) apareçam SÓ na visão do admin_plataforma. A nova
  política remove o branch `id_empresa IS NULL` do caminho comum — hardening
  alinhado ao precedente 0009 (que fez o mesmo no INSERT).
- Defesa em profundidade preservada: o backend filtra na query
  (`id_empresa=eq.<entidade>` para admin_entidade) e a RLS é o backstop.

**Alternatives considered**:
1. Backend consulta com `escopo` = lista de todos os IDs de `Empresa`
   (rejeitada: claim ilimitado, custo por request, e não resolve
   `id_empresa IS NULL`).
2. RPC SECURITY DEFINER de leitura para a visão global (rejeitada: perde os
   filtros/paginação nativos do PostgREST; RPC DEFINER fica reservado a
   agregação — precedentes 0028/0031).

---

## Decision 3 — Bloqueio imediato por módulo desabilitado: middleware `requireModuloAtivo` + cache com invalidação síncrona

**Decision**: novo middleware `hub-require-modulo.js` —
`requireModuloAtivo(codigoModulo)` — aplicado aos routers hub de módulo. Ele
resolve `entidade_ativa` do token e consulta
`obterModulosAtivosPorEntidade(empresaId)` (função NOVA em
`lib/hub-rbac-cache.js`, cache key `mod:<empresaId>`, mesmo `TTL_MS=60s` de
fallback), respondendo `403 { "erro": "MODULO_DESABILITADO" }` quando o
módulo não está ativo em `"ModuloEntidade"`. O `PUT` de módulos (Decision 4)
chama `invalidarEntidadeModulos(empresaId)` de forma SÍNCRONA — mesmo padrão
do contrato S2 para papéis (invalidação síncrona; TTL é só fallback).

**Rationale**: FR-008/SC-005 exigem efeito imediato sem reautenticação. O
menu já é 100% data-driven do `GET /me` (interseção `ModuloEntidade` ativo ×
permissões — `components/hub/module-nav.tsx` + `lib/hub/module-nav.ts`), então
o item some sozinho na próxima renderização; o que falta é o bloqueio do
ACESSO DIRETO ao endpoint, que hoje não existe (nenhuma rota checa
`ModuloEntidade`). Cache com invalidação síncrona espelha o mecanismo já
ratificado para permissões (S2), evitando janela de 60s.

**Alternatives considered**:
1. Checar `ModuloEntidade` inline em cada handler (rejeitada: N duplicações,
   viola diff mínimo).
2. Só RLS/frontend (rejeitada: RLS não bloqueia rotas de negócio que não
   tocam a tabela do módulo; frontend não é fronteira de segurança).
3. Sem cache, query por request (aceitável, mas o cache já existe e o padrão
   S2 pede invalidação síncrona + TTL fallback; manter simetria).

**Escopo de aplicação**: rotas hub novas da S9 (`auditoria`, `usuarios`,
`admin`) desde o início; rotas hub S3–S8 (`importacoes`, `motoristas`,
`faturamento`, `performance`, `envio_massa` hub) recebem o middleware na
varredura FR-006 (mudança de 1 linha por router — diff mínimo).

---

## Decision 4 — Escrita em `ModuloEntidade`: políticas RLS de INSERT/UPDATE restritas ao claim `admin_plataforma`

**Decision**: `"ModuloEntidade"` já existe (0003: `modulo_id`, `empresa_id`,
`ativo`, `UNIQUE(modulo_id, empresa_id)`) com GRANT `SELECT, INSERT, UPDATE`
(sem DELETE) — mas RLS só tem política de SELECT (0006). Nova migration cria
políticas de INSERT e UPDATE com `WITH CHECK (hub_jwt_admin_plataforma())` /
`USING (hub_jwt_admin_plataforma())`. Habilitar/desabilitar = UPSERT
(`INSERT ... ON CONFLICT` via PostgREST `Prefer: resolution=merge-duplicates`
ou `PATCH` por chave) com `ativo=true|false` — nunca DELETE (soft toggle,
consistente com o modelo sem DELETE do RBAC).

**Rationale**: dec-009 (FR-017) — administração de módulos é exclusiva de
`admin.gerenciar` (só admin_plataforma). O GRANT de INSERT/UPDATE já existe
desde 0003; falta apenas a política RLS de escrita, o que mantém a migration
mínima e aditiva. O endpoint (`PUT /api/v1/admin/entidades/:id/modulos`)
também é guardado por `requirePermission('admin.gerenciar')` — RLS é backstop.

**Alternatives considered**: RPC DEFINER para o toggle (rejeitada: UPSERT
simples com RLS + GRANT já cobre; RPC DEFINER só onde RLS não alcança, como
na Decision 5).

---

## Decision 5 — Ajuste da matriz papel×permissão: RPC `SECURITY DEFINER` com guard, sem GRANT DELETE amplo

**Decision**: nova RPC `hub_papel_permissao_set(p_papel_id int,
p_permissao_id int, p_ativo boolean) RETURNS jsonb`, `LANGUAGE plpgsql`,
`SECURITY DEFINER`, `SET search_path = public, pg_temp`, com guard no topo:

```sql
IF NOT hub_jwt_admin_plataforma() THEN RAISE EXCEPTION ... ERRCODE '42501'; END IF;
```

`p_ativo=true` → `INSERT ... ON CONFLICT DO NOTHING`; `p_ativo=false` →
`DELETE` da associação. `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO
authenticated`. A RPC recusa alterar linhas de `Papel` com `is_sistema=true`?
NÃO — os 4 papéis são todos `is_sistema=true` e a matriz DELES é exatamente o
que o admin_plataforma ajusta (dec-008); a RPC recusa apenas `papel_id`/
`permissao_id` inexistentes. Criação/edição/exclusão de PAPÉIS continua
impossível por qualquer via (nenhuma política de escrita em `"Papel"`).

**Rationale**: desmarcar uma célula da matriz exige remover a linha de
`"PapelPermissao"` (PK composta, sem coluna `ativo`), mas o modelo RBAC não
concede DELETE a `authenticated` (0003). Conceder DELETE via GRANT+RLS
abriria a superfície além do necessário; a RPC DEFINER com guard de claim é o
padrão da casa para operações que a RLS não expressa (precedentes
0027/0028/0030/0031: DEFINER + guard explícito + search_path pinado).

**Alternatives considered**:
1. `GRANT DELETE ON "PapelPermissao"` + política RLS DELETE (viável, mas
   quebra a regra "sem DELETE no RBAC" estabelecida na S2; a RPC preserva o
   invariante e centraliza o ponto de auditoria).
2. Adicionar coluna `ativo` a `PapelPermissao` (rejeitada: muda semântica de
   leitura em TODOS os consumidores — `carregarPermissoesDoBanco`, RLS — para
   ganho nulo).

---

## Decision 6 — Invalidação de cache de permissões: `invalidarUsuario()` síncrono nos writes; `limparCache()` no ajuste de matriz

**Decision**:
- Toda mutação de vínculo/papel de um usuário (criar vínculo, trocar papel,
  desativar vínculo — endpoints de usuários) chama
  `invalidarUsuario(usuarioId)` (já exportado por `lib/hub-rbac-cache.js`,
  hoje sem nenhum chamador) IMEDIATAMENTE após o write bem-sucedido, antes de
  responder.
- Ajuste de célula da matriz (Decision 5) chama `limparCache()` global: uma
  permissão de papel afeta um conjunto não-indexado de usuários; enumerar
  seria nova query + código, e a operação é rara/administrativa.

**Rationale**: FR-011/SC-004 (<2s, sem depender do TTL). O contrato S2 já
previa exatamente isso: "nesta fundação nenhuma rota ainda chama
invalidarUsuario" — S9 é a fase que fecha esse gap. `limparCache()` global no
ajuste de matriz troca precisão por simplicidade em operação de frequência
baixíssima (custo: um reload de cache por usuário ativo no request seguinte).

**Alternatives considered**: invalidação seletiva por papel (rejeitada:
exige índice reverso papel→usuários em memória ou query extra; sem ganho
mensurável para operação rara).

---

## Decision 7 — Criação de usuário: senha inicial definida pelo administrador (sem dependência de e-mail)

**Decision**: `POST /api/v1/usuarios` recebe `{ nome, email, senha,
vinculo: { entidadeId, papelId } }`; a senha inicial é definida pelo
administrador, validada com a política de força já usada no hub
(`isStrongPassword` — padrão do painel), armazenada com hash bcrypt
(constitution I). O evento de auditoria correspondente NUNCA inclui a senha
(scrub por construção — `scrubDetalhes` em `lib/hub-auditoria.js` já remove a
chave `senha`). A troca posterior de senha usa os fluxos existentes
(`/hub/recuperar-senha`, perfil).

**Rationale**: o fluxo alternativo (criar usuário + disparar e-mail de
redefinição) acopla a criação de usuário à infraestrutura SMTP, que no
hub-homolog é um mock (mailpit-like) e não tem configuração produtiva
ratificada. SC-008 pede fluxo completo NAS TELAS sem operação de banco — a
senha inicial pelo admin cumpre isso hoje, e o provisionamento QA atual já
segue esse modelo (reset via psql, que a S9 justamente elimina).

**Alternatives considered**: convite por e-mail com token de definição de
senha (rejeitada NESTA fase: dependência SMTP não ratificada; pode evoluir
depois sem quebrar o contrato — o campo `senha` vira opcional).

---

## Decision 8 — Sem `mv_*`/agregação nesta feature

**Decision**: a consulta de auditoria é listagem paginada com filtros por
igualdade/range sobre índices já existentes (`idx_auditoria_id_empresa`,
`idx_auditoria_criado_em`, `idx_auditoria_usuario_id`) — sem endpoint de
resumo/agregação. O padrão `mv_* + RPC DEFINER` (precedentes 0028/0031) fica
documentado como caminho caso um resumo surja em fase futura.

**Rationale**: o contexto vinculante manda usar `mv_*` para "agregação
lenta" — a S9 não tem agregação. Criar MV especulativa viola simplicidade
(Complexity Tracking vazio por design). Se a listagem degradar em volume
real, o primeiro remédio é índice composto `(id_empresa, criado_em DESC)`,
não MV.

**Alternatives considered**: índice composto `(id_empresa, criado_em)` já
nesta fase (adiada: os dois índices simples atendem o volume atual do
hub-homolog; adicionar depois é migration aditiva trivial).

---

## Decision 9 — Detalhe do evento: client-side, sem `GET /auditoria/:id`

**Decision**: o payload da listagem já contém todos os campos do evento
(`id, id_empresa, usuario_id, acao, recurso, recurso_id, detalhes, ip,
criado_em` — `detalhes` já scrubbed na ESCRITA). O "detalhe" (US1.3) é um
drawer/dialog client-side alimentado pela linha da lista. Nenhum endpoint
novo.

**Rationale**: os dados já trafegam na lista; um endpoint por-id duplicaria
autorização e superfície sem ganho. O scrub na escrita (S2) garante FR-004 em
qualquer leitura, por construção.

**Alternatives considered**: `GET /auditoria/:id` (rejeitada: superfície
extra; nada no detalhe excede o que a lista carrega).

---

## Decision 10 — Rotas de tela derivadas do código do módulo; matriz de papéis sob o módulo `usuarios`

**Decision**: o nav resolve rota por `moduloParaRota(codigo)` →
`/hub/dashboard/<codigo>`. Logo:
- Módulo `auditoria` (seed 0007, ordem 80) → página
  `app/hub/dashboard/auditoria/page.tsx` (FR-012).
- Módulo `usuarios` (ordem 70) → `app/hub/dashboard/usuarios/page.tsx`
  (gestão de usuários, FR-009) com sub-rota
  `app/hub/dashboard/usuarios/papeis/page.tsx` (matriz papel×permissão,
  FR-010) — leitura para quem tem `usuarios.gerenciar` (admin_entidade
  incluso, read-only), edição de célula habilitada apenas com
  `admin.gerenciar` (dec-008).
- Módulo `admin` (ordem 90) → `app/hub/dashboard/admin/page.tsx`
  (módulos por entidade, FR-013) — módulo visível apenas onde habilitado e
  com `admin.gerenciar` (dec-009).

**Rationale**: a matriz precisa ser visível read-only ao admin_entidade
(FR-010), que NÃO tem `admin.gerenciar` — se morasse sob o módulo `admin`,
o admin_entidade não a veria. Sob `usuarios` (cujas permissões o
admin_entidade tem todas), a visibilidade sai de graça e o gating de edição
fica por permissão, não por rota. O briefing cita `/papeis` e
`/configuracoes/modulos` como nomes lógicos; as rotas físicas seguem a
convenção `moduloParaRota` do shell (nenhum item de nav hardcoded).

**Alternatives considered**: página `/hub/dashboard/papeis` própria
(rejeitada: não existe módulo `papeis` no seed; criar módulo novo só para a
matriz infla o catálogo e o nav).

---

## Decision 11 — Varredura FR-006 (cobertura de auditoria S2–S8): inventário por grep + `registrarAuditoria` com diff mínimo

**Decision**: inventariar todos os handlers de escrita hub
(`router.(post|put|patch|delete)` em `routes/hub-*.js` + processador
`lib/hub-import-processor.js`) e, nos que ainda não chamam
`registrarAuditoria(...)` (`lib/hub-auditoria.js`), adicionar UMA chamada
pós-sucesso com `acao`/`recurso`/`recurso_id`/`detalhes` scrubbed. O PR
inclui checklist endpoint-a-endpoint (critério de aceite 1 do briefing).
Rotas legadas do envio em massa (S8) mantêm o mecanismo de flag
`HUB_IMPORT_LOG_ENVIO` já entregue — a S9 não reabre `server.js` legado além
do estritamente necessário (issue #62 fora de escopo).

**Rationale**: SC-002 (100% das escritas auditadas) com o menor diff
possível: a primitiva de escrita (`registrarAuditoria` + `scrubDetalhes` +
RLS de INSERT hardened em 0009) já existe e é testada
(`hub-auditoria-integration.sh`). O trabalho é de COBERTURA, não de
mecanismo.

**Alternatives considered**: middleware genérico de auditoria por
interceptação de resposta (rejeitada: acao/recurso/detalhes exigem semântica
por endpoint; interceptação genérica produz trilha pobre e viola diff
mínimo em rotas legadas).

---

## Decision 12 — Seeds de habilitação dos módulos novos: QA/E2E por migration; produção pela própria tela

**Decision**: migration de seed habilita (`ativo=true`, `ON CONFLICT DO
NOTHING`) os módulos `usuarios` e `auditoria` para as entidades que já
possuem qualquer vínculo em `"ModuloEntidade"`, e o módulo `admin` APENAS
para a entidade QA 9001 (usada pelos E2E). Habilitação de `admin` para
outras entidades em produção é feita pela própria tela da S9 (dogfooding),
sob decisão do operador.

**Rationale**: sem seed, os módulos novos não aparecem em nenhum nav e os
E2E não conseguem exercitar as telas. Seed idempotente e aditivo, restrito
ao `hub_homolog_db` (contexto vinculante #2). Não pré-habilitar `admin` em
entidades de clientes evita expor tela administrativa por acidente.

**Alternatives considered**: habilitar tudo para todos (rejeitada: `admin`
para entidades de cliente é superfície desnecessária); nenhum seed
(rejeitada: E2E ficariam bloqueados).
