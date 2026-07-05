# Briefing S2 — Fundações: banco, autenticação, RBAC, auditoria

**Fase:** S2 (Prompt B) · **Branch:** `feat/hub-fundacoes` · **Pré-requisito:** G2 aprovado
(evidências 20/20 de isolamento da S1 mergeadas). **Sem G2 confirmado, não começar.**

## Contexto mínimo (autossuficiente)

- Plataforma "Hub de Gestão de Frota" evolui a app de envio em massa. Backend Express
  sobre **PostgREST** (sem ORM; `postgrestRequest()` em `app_homologacao/backend/server.js:116`),
  frontends Next 16. Hoje **login = tabela `Empresa`** (`pass` bcrypt); multi-tenant por
  `Empresa`/`Grupo`/`id_grupo` com helpers `resolveScope`/`mesmoGrupoQue`/`resolveEmpresaAlvo`
  (`routes/grupo.js`) — critério canônico de escopo, preservar.
- ⚠️ O ambiente "homologação" no VPSTodo (serviços `envio-massa-homologacao_*`, banco
  `chatmasterveloz`, `*.moveelog.com.br`) **É PRODUÇÃO** — nenhuma escrita lá. Trabalho
  100% no **ambiente isolado** da S1 (VPS Hub, compose `hub-homolog`, banco `hub_homolog`,
  PostgREST próprio, mocks).
- Referências: plano técnico `docs/plans/hub-frota/01-plano-tecnico.md` §9 (modelo de
  dados), §11 (auth/RBAC/segurança), §14 (APIs), §15 (fase S2).

## Objetivo

Fundações do hub no ambiente isolado: schema novo (migrations 011+), autenticação por
`Usuario`, RBAC por entidade, RLS de reforço, auditoria base e migração do login legado.

## Escopo

**Inclui**
1. **Migrations `011_`–`016_` (aprox.)** na série única `app_homologacao/backend/db/`
   (a série `docs/sql/` está **congelada** — decisão D1): `Usuario`, `UsuarioEntidade`,
   `Papel`, `Permissao`, `PapelPermissao`, `Modulo`, `ModuloEntidade`, `Auditoria`,
   `SessaoRefresh`, `SchemaMigration`; seeds de papéis (`admin_plataforma`,
   `admin_entidade`, `operador`, `leitura`), permissões `modulo.acao` e módulos
   (`dashboard, motoristas, faturamento, performance, importacoes, envio_massa, usuarios,
   auditoria, admin`); GRANTs para o role do PostgREST (**lição do 42501**: toda tabela
   nova precisa de GRANT explícito — precedente `docs/sql/003-...-grants.sql`).
2. **Migração de dados** `Empresa.pass → Usuario` (expand-only): 1 usuário por empresa com
   login ativo, **mesmo hash bcrypt copiado**, vínculo `UsuarioEntidade` papel
   `admin_entidade`. Login legado continua funcionando (convivência §11.5).
3. **Auth `/api/v1/auth/*`**: login (rate-limit IP+conta, dummy-hash anti-enumeração —
   reusar padrão de `server.js:79/218`), refresh (rotação + hash em `SessaoRefresh`),
   logout (revoga), recuperar/redefinir senha (token único hash-only expirável; e-mail via
   mock/mailpit), tentativas + `bloqueado_ate` (5 falhas → 15 min), auditoria de
   login sucesso/falha.
4. **RBAC**: middleware `requirePermission('modulo.acao')`; `GET /api/v1/me`
   (usuario, entidades, entidade ativa, módulos+permissões); `POST /api/v1/me/entidade`
   (troca de entidade ativa, re-emite token com claim `empresa_ativa`); cache de
   permissões in-memory TTL 60 s com invalidação em update de papel.
5. **RLS** nas tabelas novas com `id_empresa` (policies via claims do JWT do PostgREST)
   como defesa em profundidade — backend continua a autoridade.
6. **Runtime**: backend do hub em **Node 20 LTS** (`Dockerfile.hub`; o Dockerfile legado
   node:14 não muda).

**Não inclui:** telas (S3+); pipeline de importação (S4); alterações em endpoints legados
(`/login`, `/upload`, `/envio-massa`, `/validate-xml-batch`); qualquer DDL destrutiva em
`Empresa`/`Motorista`/`EnvioMassa`/`Grupo`/`Branding` (expand-only); MFA/SSO.

## Ordem das tarefas

migrations+GRANTs → migração de login → auth → RBAC/`/me` → RLS → testes → evidências → PR.

## Modelo de dados (resumo operacional — detalhe no plano §9.2)

- `Usuario(id, email citext UNIQUE, senha_hash, nome, ativo, tentativas_login,
  bloqueado_ate, token_recuperacao_hash, token_recuperacao_expira, criado_em, atualizado_em)`
- `UsuarioEntidade(usuario_id, empresa_id, papel_id, ativo, UNIQUE(usuario_id, empresa_id))`
- `Papel(nome UNIQUE, escopo global|entidade, is_sistema)` ·
  `Permissao(codigo UNIQUE 'modulo.acao', modulo_id)` · `PapelPermissao(UNIQUE par)`
- `Modulo(codigo UNIQUE, nome, icone, ordem, ativo)` · `ModuloEntidade(UNIQUE par, ativo)`
- `Auditoria(id_empresa NULL, usuario_id NULL, acao, recurso, recurso_id, detalhes jsonb
  SEM dados sensíveis, ip, criado_em)` — append-only
- `SessaoRefresh(usuario_id, token_hash UNIQUE, expira_em, revogado_em, user_agent, ip)`
- `SchemaMigration(nome UNIQUE, aplicado_em)`
- Precedência RBAC: **união de grants** (sem herança, sem negação). Claims fora do JWT;
  cache TTL 60 s.

## Testes exigidos

- **Unit:** hash/verificação, geração/validação de tokens, requirePermission (com/sem
  grant, papel global vs entidade), cache e invalidação, dummy-hash timing.
- **Integração (banco do compose test):** migrations em banco **vazio** e **com seeds**,
  2× (idempotência = no-op); GRANTs (query via PostgREST com role authenticated);
  migração de login (hash preservado).
- **E2E (homolog isolada):** login→me→troca de entidade; troca de senha revoga todas as
  sessões; 5 falhas bloqueiam 15 min; RLS: token com claim da entidade A lendo dados da
  entidade B → 0 linhas.
- Incluir **todos** os arquivos de teste no script `npm test` (hoje só 2 de 8 rodam — corrigir).

## Evidências para o PR

Suíte completa verde (saída); `SELECT * FROM "SchemaMigration"`; demonstração RLS
(0 linhas cruzadas); auditoria de login (linhas reais); login legado funcionando no
ambiente isolado com o mesmo hash; migrations rodadas 2× sem efeito.

## Critérios de aceite

1. Migrations idempotentes e registradas em `SchemaMigration`; 2. nenhum endpoint novo sem
`requirePermission`; 3. usuário migrado autentica sem trocar senha; 4. revogação de sessão
real (refresh revogado não renova); 5. RLS ativa e testada; 6. zero mudanças em endpoints
legados (diff limpo); 7. PR + DIARIO.md.

## Gotchas herdados (memória do projeto)

- PostgREST: toda tabela nova exige GRANT + `SIGUSR1`/`NOTIFY` para recarregar schema.
- Comentário `{/* */}` logo após `return (` quebra build turbopack — grepar antes de buildar.
- `Select` do painel é **Base UI** (não Radix): `items` no Root para exibir rótulo.
- Colunas de CNPJ diferem por tabela (`Empresa.cnpj` vs `cnpj_prestador`/`cnpj_tomador`).
- Nunca `docker stack deploy`; imagens sempre com tag explícita (nunca `latest`).
