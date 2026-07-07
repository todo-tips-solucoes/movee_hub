# Research: hub-shell (S3)

Decisões técnicas com evidência empírica. Cada decisão registrada também em `state.json`
(dec-013+). Fonte primária: leitura direta do código S2 (`hub-me.js`), do frontend_v2 e do
briefing S3.

## D1 — Contrato do `/me`: verificar por leitura, não supor

**Decisão**: adotar como fonte da verdade o que `app_homologacao/backend/routes/hub-me.js`
realmente emite, não a paráfrase do briefing.

**Evidência** (select real, linha ~122 de `hub-me.js`):
`ModuloEntidade?empresa_id=eq.<ativa>&ativo=eq.true&select=modulo:Modulo(codigo,nome,icone,ordem,ativo)`
e o `.map(m => m.modulo).filter(m => m && m.ativo && prefixosComPermissao.has(m.codigo))`.
→ campo emitido é **`ativo`**, e a inclusão é por "≥1 permissão com prefixo `codigo`", não por
`<codigo>.view`.

## D2 — Reconciliação `habilitado` (spec Q1) × `ativo` (código)

**Decisão**: o frontend NÃO depende de um campo `habilitado`. A **presença** do módulo em
`modulos[]` já significa "habilitado para a entidade E a pessoa tem acesso" (o backend fez o
cruzamento). A convenção `<codigo>.view`/`<codigo>.<acao>` da spec Q1 é usada só pelo
`PermissionGate` para ações dentro das telas.

**Alternativas descartadas**:
- Ajustar o backend para renomear/adicionar `habilitado`: seria mexer no contrato S2; e como
  `modulos[]` já vem pré-filtrado, `habilitado` seria sempre `true` — campo redundante.
  dec-010 restringe backend a completar campo já contratado; renomear não agrega e adiciona
  risco aos testes S2. **Rejeitado.**
- Filtrar de novo no client por `<codigo>.view`: duplicaria a lógica do backend e divergiria
  do critério real ("≥1 permissão com prefixo"). **Rejeitado** (viola SC-001 "zero hardcode" e
  dec-010).

**Consequência**: sem tocar backend; frontend consome a presença no array.

## D3 — `permissoes[]` é união cross-entidade (segurança)

**Evidência**: `permissoes: Array.from(permissoesEfetivas)` onde
`permissoesEfetivas = await obterPermissoesEfetivas(payload.sub)` (só `sub`, sem escopo de
entidade). O comentário do próprio `GET /auditoria` confirma: o gate por-permissão do `/me`/nav
é a "UNIÃO achatada dos vínculos".

**Decisão**: `PermissionGate` é decorativo; toda autorização real é do backend por-entidade
(`obterPermissoesEfetivasPorEntidade` + RLS FASE 5), como já implementado no `GET /auditoria`
(verificação `permsEntidade.has('auditoria.consultar')` após o gate grosso). Documentado no
plano §3.3. **Não corrigimos** o contrato (dec-010).

## D4 — Auth do shell: provider novo, legado intocado

**Evidência**: `contexts/auth-context.tsx` chama `api.get('/verify-auth')` e
`api.post('/login')` (backend envio-massa legado). O hub usa `/api/v1/auth` + `/api/v1/me`
(distintos).

**Decisão**: criar `contexts/hub-auth-context.tsx` NOVO; não editar o legado (FR-018/SC-007).
Os dois providers coexistem. **Alternativa rejeitada**: estender o auth-context legado — mistura
dois domínios de auth e arrisca regressão no envio em massa.

## D5 — Borda snake↔camel: adaptador único

**Decisão**: `lib/hub/me-dto.ts` converte a resposta snake_case da API para tipos camelCase de
domínio (e o inverso no body de `/me/entidade`). Nenhum componente vê `empresa_id`.
**Justificativa**: confina a tradução a um só arquivo testável (fonte da verdade da borda);
paridade asseverada por teste unitário contra o contrato §1.1 do plano.

## D6 — EnvBadge por `NEXT_PUBLIC_APP_ENV`

**Evidência**: `grep NEXT_PUBLIC_APP_ENV / APP_ENV` no frontend_v2 → **nenhum uso atual**.
**Decisão**: introduzir a env var pública `NEXT_PUBLIC_APP_ENV`; banner + favicon alternativo
quando `!= "production"`. Env var pública é a única forma de o client saber o ambiente em build
estático Next. FR-008/SC-004.

## D7 — Reverificação de sessão: refetch no guard de rota (sem polling)

**Decisão** (spec Q3/dec-009): perda de vínculo (FR-015) e expiração de sessão detectadas por
`refetchMe()` acoplado à navegação entre rotas, não por timer. **Justificativa**: nenhuma fonte
pede polling; o backend já degrada `entidade_ativa` para `null` no próximo `/me` (evidência:
bloco "Edge Case (FR-013)" em `hub-me.js`). Menos complexidade, menos requisições.

## D8 — Sem DDL

**Decisão**: nenhuma migration. Os dados do shell (perfil, vínculos, entidade ativa, módulos,
permissões) são 100% cobertos pela resposta atual do `/me`. Série 011+ expand-only só se um
ajuste trivial de `/me` inesperadamente exigir persistência — do contrário vira bloqueio ao
operador (dec-010).

## D9 — Reuso vs. criação de componentes

`EntitySwitcher` evolui `components/empresa-selector.tsx` (existente). `tenant-theme-context.tsx`
e o proxy `app/api/[...path]/route.ts` reusados como estão. Gotchas herdados aplicados: `Select`
Base UI precisa de `items` no Root; breadcrumb deriva de NAV_ITEMS; comentário `{/* */}` após
`return (` quebra turbopack.

## D10 — Gotchas de build/preview (do read-back loop, K=21)

Aprendizado de execuções passadas: `next dev` inviável na VPS (~4min/rota, disco lento) — usar
`next build`+`next start`; backend faz hairpin (~28s no fetch loopback); build sempre sob cap de
memória. Reforça a restrição de build do briefing e informa a estratégia de evidência E2E
(preferir CI/build cap; login real via mock quando aplicável).
