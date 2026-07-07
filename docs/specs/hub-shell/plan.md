# Implementation Plan: Shell Modular do Hub (hub-shell)

**Feature**: `hub-shell` · **Branch**: `feat/hub-shell` · **Fase**: S3 do hub-frota
**Spec**: [`spec.md`](./spec.md) · **Research**: [`research.md`](./research.md) · **Data model**: [`data-model.md`](./data-model.md)
**Created**: 2026-07-07

> Camada de **shell** (casca de navegação) sobre as fundações da S2. Feature de frontend:
> Next.js 16 App Router / React 19 / Tailwind v4 / Base UI + shadcn, design system EntreGô 2.0,
> em `app_homologacao/frontend_v2`. **Provável sem DDL** (ver §7). Backend só tocado se um
> ajuste TRIVIAL de contrato do `/me` for necessário (spec Q4/dec-010) — do contrário, imutável.

## 1. Contrato de backend — VERIFICADO EMPIRICAMENTE

Fonte da verdade: leitura direta de `app_homologacao/backend/routes/hub-me.js` (S2, já mergeada
no PR #55). **Não supor — o que segue é o que o código realmente emite.**

### 1.1 `GET /api/v1/me`

- **Auth**: cookie `accessToken` (httpOnly, sameSite=strict, secure fora de `dev`), JWT HS256
  pinado. Sem cookie/inválido/usuário inativo → `401 {erro:"NAO_AUTENTICADO"}`.
- **Não** exige `requirePermission` (qualquer autenticado lê o próprio perfil).
- **Corpo de resposta 200** (todos os campos em **snake_case**):

```jsonc
{
  "usuario":        { "id": <int>, "email": <string>, "nome": <string> },
  "entidades":      [ { "empresa_id": <int>, "papel": <string|null>, "ativo": <bool> } ],
  "entidade_ativa": <int|null>,
  "modulos":        [ { "codigo": <string>, "nome": <string>, "icone": <string>,
                        "ordem": <int>, "ativo": <bool> } ],
  "permissoes":     [ "<codigo>.<acao>", ... ]
}
```

- **`entidades[]`**: TODOS os vínculos ativos da pessoa (`UsuarioEntidade.ativo=true`),
  independentemente da entidade ativa. `papel` = nome do papel naquele vínculo.
- **`entidade_ativa`**: claim `entidade_ativa` do JWT; **degrada para `null`** se essa
  entidade não é mais um vínculo ativo (FR-013 do backend / FR-015 desta spec — perda de
  acesso reflete no próximo `/me`, sem novo login).
- **`modulos[]`**: já FILTRADO server-side por `ModuloEntidade.ativo=true` para a entidade
  ativa **cruzado** com "a pessoa possui ≥1 permissão com prefixo `<codigo>`". Ordenado por
  `ordem`. Se `entidade_ativa` é `null`, `modulos = []`.
- **`permissoes[]`**: `Array.from(obterPermissoesEfetivas(sub))` — **união achatada das
  permissões da pessoa em TODOS os vínculos** (NÃO escopada à entidade ativa).

> ⚠️ **Discrepância spec×código a reconciliar (dec a registrar nesta onda)**: a spec Q1
> (dec-007) contratou `modulos[]` com campo **`habilitado`**; o backend real emite **`ativo`**.
> Além disso, o backend inclui um módulo por "≥1 permissão com o prefixo `<codigo>`", não
> especificamente por `<codigo>.view`. Reconciliação adotada (§3.2): o frontend trata a
> **presença** de um item em `modulos[]` como "habilitado E visível" (o backend já fez o
> cruzamento), e reserva a convenção `<codigo>.view`/`<codigo>.<acao>` para o `PermissionGate`
> de ações DENTRO das telas. Isso mantém dec-010 (só usar campos já contratados; sem nova
> lógica de permissão nem endpoint novo) e **não exige tocar o backend**.

### 1.2 `POST /api/v1/me/entidade`

- **Auth**: mesmo cookie. Body: `{ "empresa_id": <int> }`.
- Respostas: `200 {entidade_ativa:<int>}` (reemite cookie `accessToken` com a claim
  atualizada — sem novo login); `400 {erro:"EMPRESA_ID_INVALIDO"}` (não-inteiro/ausente);
  `403 {erro:"SEM_VINCULO"}` (sem `UsuarioEntidade` ativo p/ aquele `empresa_id`);
  `401 {erro:"NAO_AUTENTICADO"}`.
- Registra `Auditoria` `acao:"troca_entidade_ativa"` server-side.

### 1.3 Endpoints de auth (S2 — reusar, NÃO reescrever)

`POST /api/v1/auth/login`, `/api/v1/auth/logout`, recuperação/redefinição de senha e troca de
senha vivem em `routes/hub-auth.js` (S2). O shell os CONSOME. Erros de login conhecidos:
`CREDENCIAIS_INVALIDAS` / `CONTA_BLOQUEADA` / `RATE_LIMIT` (nunca "sem vínculo" — spec Q2/dec-008).
Recuperação de senha responde igual exista ou não a conta (FR-012) e é rate-limited na S2
(5 falhas / 15 min, FR-014). **O contrato exato de cada rota de auth deve ser reverificado por
leitura de `hub-auth.js` na primeira task da fase de execução** (mesma disciplina do §1.1).

## 2. Convenções de borda (feature multi-camada)

| Camada | Convenção | Fonte da verdade | Evidência |
|--------|-----------|------------------|-----------|
| Banco (PostgREST) | `snake_case` | schema hub (`Usuario`, `UsuarioEntidade`, `ModuloEntidade`, `Auditoria`) | `hub-me.js` selects: `empresa_id`, `usuario_id`, `criado_em`, `recurso_id` |
| DTO da API (JSON `/me`, `/me/entidade`) | `snake_case` | resposta real de `hub-me.js` | §1.1/§1.2 |
| URL / rotas de API | `/api/v1/<recurso>` (path snake); body snake | `hub-me.js` monta em `/api/v1/me`, `/api/v1/me/entidade` | montagem dos routers |
| Domínio/UI do shell (React) | `camelCase` | convenção TS do `frontend_v2` | tipos existentes em `types/` |
| **Validação** | **server-side é a autoridade** (`Number.isInteger`, `requirePermission`, RLS FASE 5); cliente valida só p/ UX | backend | `hub-me.js` valida `empresa_id` e vínculo server-side |

**Regra de borda adotada**: existe **um único adaptador** `lib/hub/me-dto.ts` que converte a
resposta snake_case da API para os tipos de domínio camelCase do shell (e o inverso para o body
de `/me/entidade`). Nenhum componente consome o JSON cru: todos consomem o tipo de domínio.
Isso confina a tradução snake↔camel a um só lugar (fonte da verdade da borda) e evita
`empresa_id` vazando para JSX. O adaptador é a superfície testada por paridade (§6/§8).

## 3. Arquitetura do shell

### 3.1 Auth do shell — contexto PRÓPRIO, legado intocado

- **Legado (NÃO tocar)**: `contexts/auth-context.tsx` fala com o backend **envio-massa** via
  `api.get('/verify-auth')` + `api.post('/login')` — verificado por leitura. É o auth do painel
  de envio em massa e permanece funcionando (FR-018/SC-007).
- **Novo (esta fase)**: `contexts/hub-auth-context.tsx` — provider distinto que fala com
  `/api/v1/auth/*` e `/api/v1/me`. Expõe: `usuario`, `entidades`, `entidadeAtiva`, `modulos`,
  `permissoes`, `carregando`, `login()`, `logout()`, `trocarEntidade(empresaId)`,
  `refetchMe()`. **Os dois providers coexistem sem se cruzar**; nenhuma linha do legado é
  editada. O shell do hub monta apenas o `HubAuthProvider`.
- **Proxy reusado**: `app/api/[...path]/route.ts` (encaminha `/api/…` → `${BACKEND_URL}…`) é
  reusado como está; o mapeamento exato do prefixo `/api/v1/*` deve ser confirmado na primeira
  task de execução (defesa: um teste de fumaça do proxy contra `/api/v1/me`).

### 3.2 Componentes

| Componente | Papel | Data source | Notas |
|------------|-------|-------------|-------|
| `ModuleNav` (sidebar) | Navegação principal data-driven | `modulos[]` do `/me` | **Presença no array = item visível.** Ordena por `ordem`. Ícone por `icone`. Responsivo: drawer no mobile (padrão do header responsivo já existente). Rota derivada por convenção `codigo`→`/dashboard/<codigo>` (mapeamento testado — briefing "mapeamento módulo→rota"). Nenhum item hardcoded (FR-001/SC-001). |
| `EntitySwitcher` | Troca de entidade ativa | `entidades[]` + `entidadeAtiva` | Evolui `components/empresa-selector.tsx`. `Select` Base UI **exige `items` no Root** (gotcha). Troca → `POST /me/entidade` → `refetchMe()` recarrega todo o contexto (FR-005/FR-007/SC-003). |
| `EnvBadge` | Aviso de ambiente | `NEXT_PUBLIC_APP_ENV` | Banner fixo + favicon alternativo quando `!= "production"` ("HOMOLOGAÇÃO — dados fictícios"). Presente em TODA tela do shell via layout (FR-008/SC-004). Nova env var pública (não existia — verificado). |
| `PermissionGate` (client) | Esconde ações sem permissão | `permissoes[]` + `<codigo>.<acao>` | **Decorativo** — a autoridade é o backend (FR-002). Consome a convenção `<codigo>.view`/`<codigo>.<acao>` da spec Q1. Ver §3.3 sobre a natureza cross-entidade de `permissoes[]`. |

### 3.3 Nota de segurança sobre `permissoes[]` (cross-entidade)

`permissoes[]` do `/me` é a UNIÃO achatada entre TODOS os vínculos da pessoa, não a da entidade
ativa. Consequências que o plano fixa:
- O `PermissionGate` (client) pode, para uma pessoa multi-entidade, mostrar uma ação com base
  numa permissão que ela só tem em OUTRA entidade. Por isso `PermissionGate` **nunca** é
  barreira de segurança — é conveniência de UI. Toda ação real é reautorizada pelo backend
  por-entidade (RLS FASE 5 + `requirePermission` + verificação por-entidade, como já feito no
  `GET /auditoria`). Isso satisfaz FR-002/SC-002 sem depender do client.
- `modulos[]`, ao contrário, JÁ é escopado à entidade ativa pelo backend → a navegação
  (FR-001) é confiável. Não replicamos essa lógica no client.
- Esta assimetria é herança do contrato S2 e, por dec-010, **não** será "corrigida" nesta fase
  (seria nova lógica de permissão). Fica documentada e mitigada pela reautorização de backend.

### 3.4 Rotas do shell (App Router)

`/login` · `/recuperar-senha` · `/redefinir-senha` · `/selecionar-entidade` · `/dashboard`
(cards por módulo — FR-009) · `/dashboard/perfil` (nome/e-mail + troca de senha — FR-011) ·
logout (ação). Guard de rota: cada navegação entre rotas do shell dispara `refetchMe()`
(spec Q3/dec-009 — sem polling temporizado) para refletir perda de vínculo (FR-015) e expiração
de sessão (redireciona a `/login` limpando estado — Edge Case de sessão expirada).

Fluxo pós-login (FR-003/FR-004): `entidades.length > 1` → `/selecionar-entidade`;
`=== 1` → seleciona automaticamente e segue a `/dashboard`; `=== 0` → tela dedicada "sem
acesso" (FR-016), sem quebrar. `modulos.length === 0` com entidade ativa → dashboard/nav
comunicam "nenhum módulo disponível" (FR-010).

### 3.5 Design das telas

Todas as telas novas desenhadas via **/ui-ux-pro-max** sobre EntreGô 2.0, preservando
dark/light e white-label (`tenant-theme-context.tsx` reusado) — FR-017/SC-006. Gotcha turbopack:
comentário `{/* */}` logo após `return (` quebra o build — usar `//` acima do return.

## 4. Stack e restrições herdadas

- **Sem nova dependência** salvo justificativa (o shell usa Base UI/shadcn/Tailwind já presentes).
- **Build Next SEMPRE sob cap de memória** (`docker build --memory=2g`, swap ativo) ou CI —
  nunca `next build`/`dev` solto no host VPSTodo (rito anti-starvation; memória do projeto).
- Ambiente vivo do cliente É PRODUÇÃO: trabalho só em recursos isolados `hub-*`/`hub_*`.
  Merge/deploy são do operador. Nenhuma escrita em produção por esta feature.

## 5. Fases de execução (ordem do briefing S3)

1. **Contratos `/me` e auth verificados** (reler `hub-me.js` já feito; reler `hub-auth.js`) +
   `lib/hub/me-dto.ts` (adaptador de borda) + tipos de domínio + smoke do proxy.
2. **`ModuleNav` + `EnvBadge`** (nav data-driven + banner de ambiente).
3. **`EntitySwitcher` + `/selecionar-entidade`** (evolui empresa-selector; troca de entidade).
4. **Telas de auth**: `/login`, `/recuperar-senha`, `/redefinir-senha`, perfil + troca de senha,
   logout.
5. **`/dashboard`** (cards por módulo; estados "sem módulo"/"sem acesso").
6. **E2E na homolog isolada** + **evidências** (prints por papel, axe ≥95, troca de entidade).
7. **PR + DIARIO.md**.

Design (/ui-ux-pro-max) aplicado dentro das fases 2–5.

## 6. Paridade de tipos (obrigatório — feature multi-camada)

Se o shell replicar validação/tipos do backend no frontend (ex.: schema Zod do body de
`/me/entidade`, shape do `MeResponse`), CADA replicação exige **subtarefa de paridade** que
compara o tipo do frontend com o contrato real do backend (leitura de `hub-me.js`/`hub-auth.js`)
e falha o build/teste se divergir. O adaptador `lib/hub/me-dto.ts` é o ponto único onde a
paridade é asseverada (teste unitário compara os campos snake do contrato §1.1 com o mapeamento).

## 7. DDL — decisão: NÃO é necessário

Esta é uma fase de frontend sobre um contrato de backend JÁ existente (S2). `GET /me` e
`POST /me/entidade` já entregam tudo que o shell precisa. Nenhum campo novo, tabela nova ou
índice é requerido. **Confirmação**: os 4 requisitos de dados do shell (perfil, vínculos,
entidade ativa, módulos, permissões) são 100% cobertos pela resposta atual do `/me` (§1.1).
→ **Sem migration nesta fase.** SE, durante a execução, um ajuste TRIVIAL de contrato do `/me`
exigir persistência (não previsto), a série é `app_homologacao/backend/db/` **011+**,
expand-only idempotente — mas o default é: não criar. Qualquer necessidade além de "completar
campo já contratado" vira **bloqueio para o operador** (dec-010).

## 8. Testes exigidos (do briefing)

- **Unit**: `PermissionGate` (mostra/esconde por `<codigo>.<acao>`); mapeamento módulo→rota;
  adaptador `me-dto.ts` (paridade snake↔camel + degradação `entidade_ativa=null`).
- **E2E (homolog isolada)**: 2 papéis distintos veem menus diferentes; pessoa sem
  `usuarios.manage` não vê `/usuarios` e recebe 403 do backend ao forçar a URL; troca de
  entidade altera os dados exibidos; banner de ambiente visível; **axe ≥ 95** nas telas novas.

## 9. Gates desta onda

- **doc-quality** (`validate-documentation`) sobre spec+plan — ciente de que o template
  Spec-Kit (FR-/SC-/US-) difere do UC-*/RB-*; a divergência é registrada como decisão
  informativa (mesma postura da onda-001), não como falha.
- **security** (`owasp-security`) sobre a arquitetura proposta — foco: sessão por cookie
  httpOnly, escopo cross-tenant de `permissoes[]` (§3.3), enumeração de conta no fluxo de
  recuperação (FR-012), rate-limit (FR-014), reautorização de backend por-entidade.

## 10. Rastreabilidade FR → plano

FR-001→ModuleNav+§1.1; FR-002→§3.3 (backend); FR-003/004→§3.4; FR-005/006/007→EntitySwitcher+§1.2;
FR-008→EnvBadge; FR-009/010→/dashboard; FR-011→perfil; FR-012/014→auth S2 reusado; FR-013→logout;
FR-015→guard refetch (§3.4); FR-016→tela "sem acesso"; FR-017→§3.5; FR-018→§3.1 (legado intocado).
