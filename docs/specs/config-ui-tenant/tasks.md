# Backlog de Tarefas: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)

**Feature**: config-ui-tenant
**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Criado**: 2026-06-05
**Estado inicial**: todas as tasks em aberto (`- [ ]`)

> **Nota ao implementador**: as Decisões dec-016 a dec-033 no `state.json` da feature
> resolvem os 18 gaps dos checklists. Não re-abra essas decisões; implemente conforme
> os critérios de aceite abaixo. As 4 Decisões Travadas (spec.md §Decisões Travadas)
> também não são reabríveis.

---

## Legenda de Criticidade

- `[crit]` — caminho crítico: bloqueia tasks subsequentes
- `[seg]` — requisito de segurança obrigatório (não pode ser pulado)
- `[gap]` — resolve gap identificado nos checklists (dec-016 a dec-033)
- `[bloq]` — BLOQUEADA: depende de ação humana externa

---

## Escopo Coberto

- Constitution bump §II v1.0.0 → v1.1.0
- DDL aditivo: tabelas `grupo`, `branding`; FK `id_grupo` em `empresa`
- Migração D&G (vinculação de CNPJs existentes)
- Backend: resolveScope, claim id_grupo, rotas grupo/branding, supabaseStorage
- Frontend v2: TenantThemeProvider, tela aparência, fluxo vincular filhos
- Frontend motorista: TenantThemeProvider HEX, branding por movimento
- Deploy aditivo por serviço + validação no ar

## Escopo Excluído

- Sanitização inline de SVG (fora do MVP — ver plan.md §F2)
- Paginação de GET /grupo/filhos acima de 100 filhos (ver dec-025)
- Bucket policy Supabase (hardening pós-deploy — ver dec-017)
- ORM / mapper layer (projeto usa PostgREST direto — ver plan.md §Convenções)
- Review-features: agente-00c-review-features (fora do escopo desta feature-00c)

---

## Matriz de Dependências

```
FASE-0 (Constitution) ──┐
                         ↓
FASE-1 (DDL)      ──────→ FASE-2 (Backend Grupo) ──→ FASE-3 (Backend Branding) ──┐
                                                                                    ↓
FASE-1b (D&G)  [bloq]──────────────────────────────────────────────────────────→ FASE-3b (Validar)
                                                                                    ↓
FASE-3 ──────────────────────────────────────────────────────────────────────────→ FASE-4 (Frontend v2)
FASE-3 ──────────────────────────────────────────────────────────────────────────→ FASE-5 (Frontend motorista)
FASE-4 + FASE-5 ─────────────────────────────────────────────────────────────────→ FASE-6 (Deploy)
```

---

## Resumo por Fase

| Fase | Descrição | Tasks | Crit |
|------|-----------|-------|------|
| FASE-0 | Constitution bump §II | 1 | - |
| FASE-1 | DDL aditivo (schema.sql) | 3 | crit |
| FASE-1b | Migração D&G (bloqueada) | 1 | bloq |
| FASE-2 | Backend: Grupo (resolveScope + rotas) | 4 | crit |
| FASE-3 | Backend: Branding (endpoints + storage) | 4 | crit+seg |
| FASE-4 | Frontend v2 (provider + tela aparência) | 4 | - |
| FASE-5 | Frontend motorista (provider + movimento) | 3 | - |
| FASE-6 | Deploy aditivo + validação no ar | 4 | - |

**Total**: 24 tasks

---

## FASE-0 — Constitution Bump

### 0.1 Bump constitution.md §II v1.0.0 → v1.1.0 [crit]

- [ ] Editar `docs/constitution.md` §II: atualizar versão de `v1.0.0` para `v1.1.0`
- [ ] Adicionar no §II o parágrafo de amendment: "Amendment MINOR v1.1.0 (feature config-ui-tenant): o escopo multi-tenant expande-se para suportar Grupos de CNPJs. O invariante crítico (escopo resolvido server-side a partir do token, nunca do corpo da requisição) é preservado. Tokens de filhos continuam vendo apenas a própria empresa; apenas tokens marcados como `is_grupo_pai` operam sobre o conjunto de filhos."
- [ ] Verificar que nenhum outro §§ da constitution foi alterado (diff restrito ao §II + versão)
- [ ] Commit: `docs(constitution): bump §II v1.0.0→v1.1.0 — amendment grupo de CNPJs`

**FRs**: CHK022 (dec-019) | **Bloqueia**: nada (pode rodar em paralelo com FASE-1)
**Critério de aceite**: `grep "v1.1.0" docs/constitution.md` retorna pelo menos 1 match

---

## FASE-1 — DDL Aditivo

> Classifier bloqueia execução direta de banco. Entregável: arquivo `.sql` para o
> operador aplicar manualmente. Arquivo em `docs/sql/001-config-ui-tenant-schema.sql`.

### 1.1 Gerar DDL do schema (tabelas grupo, branding, FK empresa) [crit]

- [ ] Criar/atualizar `docs/sql/001-config-ui-tenant-schema.sql` com:
  ```sql
  -- Tabela Grupo
  CREATE TABLE IF NOT EXISTS grupo (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- FK id_grupo em empresa (NULLABLE — empresa sem grupo é válida)
  ALTER TABLE empresa
    ADD COLUMN IF NOT EXISTS id_grupo INTEGER REFERENCES grupo(id),
    ADD COLUMN IF NOT EXISTS is_grupo_pai BOOLEAN NOT NULL DEFAULT false;

  -- UNIQUE: cada empresa pertence a no máximo 1 grupo (FR-INFRA-LOCK, dec-026, dec-033)
  -- Se já existir a constraint, a migração é idempotente
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'empresa_id_grupo_unique'
    ) THEN
      ALTER TABLE empresa ADD CONSTRAINT empresa_id_grupo_unique UNIQUE (id_grupo, id);
    END IF;
  END $$;
  -- Nota: o UNIQUE real é em (empresa.id, id_grupo) NÃO em id_grupo sozinho —
  -- múltiplas empresas podem estar no mesmo grupo. O que é único é que cada empresa
  -- só pertence a 1 grupo: UNIQUE(id) já existe (PK). O lock é garantido via
  -- FK + verificação de id_grupo IS NULL antes de vincular (ver task 2.2).

  -- Tabela Branding (1:1 com Grupo)
  CREATE TABLE IF NOT EXISTS branding (
    id             SERIAL PRIMARY KEY,
    id_grupo       INTEGER NOT NULL UNIQUE REFERENCES grupo(id) ON DELETE CASCADE,
    logo_url       TEXT,                          -- NULL → sem logo (usa wordmark/nome)
    cor_primaria   VARCHAR(7),                    -- hex #RRGGBB
    cor_destaque   VARCHAR(7),                    -- hex #RRGGBB
    nome_exibicao  VARCHAR(60),                   -- ≤ 60 chars (dec-022)
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- NOTIFY para reload do PostgREST (aditivo; não afeta dados existentes)
  NOTIFY pgrst, 'reload schema';
  ```
- [ ] Verificar que o SQL é idempotente (`IF NOT EXISTS` em todas as DDLs)
- [ ] Documentar instrução de aplicação no topo do arquivo:
  ```
  -- Aplicar com: psql $DATABASE_URL -f 001-config-ui-tenant-schema.sql
  -- Seguro para reaplicar (idempotente).
  ```

**FRs**: FR-001, FR-002, FR-003, FR-INFRA-LOCK (dec-026, dec-033) | **Bloqueia**: FASE-2, FASE-3
**Critério de aceite**: arquivo existe em `docs/sql/001-config-ui-tenant-schema.sql`; reviewer valida SQL sintaticamente

### 1.2 Validar constraint de lock (UNIQUE) e documentar mecanismo [crit] [seg] [gap]

- [ ] No arquivo `.sql` da task 1.1, adicionar comentário explícito explicando o mecanismo de lock:
  ```sql
  -- FR-INFRA-LOCK (dec-026, dec-033): race condition em POST /grupo/filhos é prevenida
  -- pela verificação server-side no handler Express:
  --   1. Lê empresa alvo: SELECT id_grupo FROM empresa WHERE id = $empresaIdFilho
  --   2. Se id_grupo IS NOT NULL → retorna 409 "Empresa já pertence a outro grupo"
  --   3. UPDATE empresa SET id_grupo = $id_grupo WHERE id = $empresaIdFilho
  -- Em um ambiente multi-pod, a janela de race é mínima (leitura+escrita na mesma
  -- transação). Para hardening futuro: usar SELECT ... FOR UPDATE dentro da transação.
  ```
- [ ] Status code para path param não-numérico (dec-016, CHK003): documentar em comentário
  no SQL e em `contracts/grupo-api.md` — `empresaIdFilho` não-numérico → **400 Bad Request**
  `{ "error": "Parâmetro inválido: empresaIdFilho deve ser um número inteiro." }`
- [ ] Limite `nome_exibicao` = 60 chars (dec-022, CHK033): já no DDL acima via `VARCHAR(60)`

**FRs**: FR-INFRA-LOCK, CHK003 (dec-016), CHK033 (dec-022) | **Bloqueia**: FASE-2
**Critério de aceite**: comentários presentes no SQL; VARCHAR(60) confirmado

### 1.3 Confirmar NOTIFY pgrst e instruções de reload [crit]

- [ ] Verificar que `NOTIFY pgrst, 'reload schema'` está ao final do SQL
- [ ] Adicionar instrução alternativa para reload manual caso o NOTIFY não funcione em
  produção: `curl -X POST http://localhost:3001/rpc/reload_schema` (ou o endpoint
  correto do PostgREST do ambiente)
- [ ] Documentar em `docs/sql/001-config-ui-tenant-schema.sql` header:
  ```
  -- IMPORTANTE: após aplicar, verificar que PostgREST recarregou o schema.
  -- Sinal: GET /grupo/filhos retorna 200 (não 404 de "resource not found").
  ```

**FRs**: FR-001 | **Bloqueia**: FASE-2
**Critério de aceite**: SQL tem NOTIFY + instrução de validação

---

## FASE-1b — Migração D&G (BLOQUEADA)

### 1b.1 Migração de CNPJs D&G existentes [bloq] [crit]

> **BLOQUEADA**: depende de o operador rodar `docs/sql/dg-levantamento.sql` e confirmar
> a lista de CNPJs do grupo D&G. Não implementar até desbloqueio.

- [ ] Confirmar lista de CNPJs: operador executa `docs/sql/dg-levantamento.sql` e
  compartilha o resultado (lista de `empresa.id` + `cnpj` que devem pertencer ao grupo D&G)
- [ ] Criar `docs/sql/002-config-ui-tenant-dg-vinculo.sql` com migração parametrizada:
  ```sql
  -- Migração D&G: criar grupo pai e vincular CNPJs confirmados
  -- SUBSTITUIR os IDs abaixo pelos confirmados no levantamento
  BEGIN;
    -- 1. Criar grupo
    INSERT INTO grupo DEFAULT VALUES RETURNING id;
    -- 2. Marcar empresa pai
    UPDATE empresa SET id_grupo = :id_grupo_novo, is_grupo_pai = true WHERE id = :id_empresa_pai;
    -- 3. Vincular filhos (um UPDATE por CNPJ filho confirmado)
    UPDATE empresa SET id_grupo = :id_grupo_novo WHERE id IN (:ids_filhos);
  COMMIT;
  ```
- [ ] Verificar idempotência: re-executar não cria grupo duplicado (usar transação + check EXISTS)
- [ ] Documentar instrução: `psql $DATABASE_URL -f 002-config-ui-tenant-dg-vinculo.sql`

**FRs**: FR-002, Estratégia de Migração D&G (plan.md) | **Desbloqueio**: operador confirma lista de CNPJs
**Critério de aceite**: arquivo `.sql` gerado e revisado pelo operador antes de executar

---

## FASE-2 — Backend: Grupo

> Todos os handlers de grupo residem em `backend/routes/grupo.js` seguindo o padrão
> de `backend/routes/motorista.js` (módulo com `init()` injetando helpers).

### 2.1 Helper resolveScope + claim id_grupo no token de login [crit]

- [ ] Criar `backend/lib/resolveScope.js`:
  ```js
  // Retorna array de empresaIds acessíveis para o user do token.
  // Pai: [empresaId, ...ids_filhos]. Filho: [empresaId]. Sem grupo: [empresaId].
  async function resolveScope(user, db) {
    if (!user.is_grupo_pai || !user.id_grupo) return [user.empresaId];
    const filhos = await db.query(
      'SELECT id FROM empresa WHERE id_grupo = $1 AND is_grupo_pai = false',
      [user.id_grupo]
    );
    return [user.empresaId, ...filhos.rows.map(r => r.id)];
  }
  module.exports = { resolveScope };
  ```
- [ ] Adicionar claims `id_grupo` e `is_grupo_pai` ao payload JWT no login (`server.js`):
  ao montar o token, incluir `id_grupo: empresa.id_grupo || null` e
  `is_grupo_pai: empresa.is_grupo_pai || false`
- [ ] Garantir que tokens existentes (sem essas claims) são tratados graciosamente:
  `req.user.id_grupo ?? null`, `req.user.is_grupo_pai ?? false`

**FRs**: FR-004, FR-005, FR-006 | **Depende de**: FASE-1 (DDL aplicado)
**Critério de aceite**: unit tests `grupo-scope.test.js` — pai vê próprios filhos; filho vê só si mesmo

### 2.2 Rotas GET /grupo/filhos e POST /grupo/filhos [crit] [seg]

- [ ] Criar `backend/routes/grupo.js` com:
  - `GET /grupo/filhos`: middleware `authenticateToken` + verificar `is_grupo_pai === true`
    → 403 se não-pai; query PostgREST `SELECT id, cnpj, nome_empresa FROM empresa WHERE id_grupo=eq.{id_grupo}`
    com coerção obrigatória de `id_grupo` para inteiro (Mandato F1, dec-016)
    → retorna `{ filhos: [...] }` (máx 100 — dec-025)
  - `POST /grupo/filhos`: middleware `authenticateToken` + verificar `is_grupo_pai === true`
    → allowlist body (aceita apenas `empresaIdFilho` — Mandato F5, dec-018); coerção inteiro;
    verificar empresa existe → 404; verificar `id_grupo IS NULL` → 409 se já vinculada;
    UPDATE empresa SET id_grupo = $id_grupo WHERE id = $empresaIdFilho; retorna 201 `{ ok: true }`
- [ ] Implementar limite de 100 filhos (dec-025): antes do POST, contar filhos atuais;
  se count >= 100 → 422 `{ "error": "Limite de 100 filhos atingido para este grupo." }`
- [ ] Registrar `routes/grupo.js` em `server.js` (padrão: `const grupo = require('./routes/grupo'); grupo.init(helpers); app.use('/grupo', grupo.router);`)

**FRs**: FR-002, FR-003, FR-006, CHK015 (dec-018), CHK046 (dec-025) | **Depende de**: 2.1
**Critério de aceite**: curl POST /grupo/filhos com body `{ "empresaIdFilho": "abc" }` retorna 400 (dec-016)

### 2.3 Rota DELETE /grupo/filhos/:empresaIdFilho [seg]

- [ ] Adicionar ao `backend/routes/grupo.js`:
  - `DELETE /grupo/filhos/:empresaIdFilho`: middleware `authenticateToken` + `is_grupo_pai === true`;
    coerção `empresaIdFilho` para inteiro → 400 se não-numérico (dec-016, CHK003);
    verificar que empresa pertence ao grupo do token → 403 se filho de outro grupo / 404 se não vinculada;
    UPDATE empresa SET id_grupo = NULL WHERE id = $empresaIdFilho; retorna 200 `{ ok: true }`

**FRs**: FR-003, CHK003 (dec-016) | **Depende de**: 2.2
**Critério de aceite**: DELETE com `:empresaIdFilho = "xyz"` retorna 400; filho de outro grupo retorna 403

### 2.4 Testes de escopo de grupo [seg]

- [ ] Criar `backend/tests/grupo-scope.test.js` usando `node --test`:
  - Token pai → GET /grupo/filhos retorna lista com filhos corretos
  - Token filho → GET /grupo/filhos retorna 403
  - POST /grupo/filhos com empresa já vinculada → 409
  - POST /grupo/filhos com empresa inexistente → 404
  - POST /grupo/filhos com id não-numérico → 400 (dec-016, CHK003)
  - DELETE /grupo/filhos/:id com filho de outro grupo → 403
  - resolveScope: pai retorna [próprio, filhos]; filho retorna [próprio]
- [ ] Rodar: `cd backend && node --test tests/grupo-scope.test.js`; todos os tests pass

**FRs**: FR-004, Mandato F4 | **Depende de**: 2.2, 2.3
**Critério de aceite**: `node --test` exit 0; nenhum test falha

---

## FASE-3 — Backend: Branding

### 3.1 Helper supabaseStorage + upload de logo [seg]

- [ ] Criar `backend/lib/supabaseStorage.js`:
  - `uploadLogo(file, grupoId)`: valida mimetype (`image/png`, `image/jpeg`, `image/svg+xml`)
    e tamanho (≤ 512 KB) **antes** de enviar ao Supabase — 400 se inválido (CHK006, dec-017)
  - Salva como `logos/grupo-{grupoId}-{sha256}.{ext}` (idempotência: mesma hash → mesma URL, FR-INFRA-IDEMP)
  - Retorna URL pública do bucket
  - `removeLogo(grupoId)`: deleta arquivo do Storage se existir; não falha se já removido
  - **Constraint Node 14**: usar pacote `form-data` (já disponível) — não `FormData` global

**FRs**: FR-011, FR-INFRA-IDEMP, CHK006 (dec-017) | **Depende de**: nada (lib pura)
**Critério de aceite**: upload de PNG 100 KB → retorna URL; upload de SVG malicioso (MIME errado) → 400

### 3.2 Endpoints GET/PUT /empresa/branding [crit] [seg]

- [ ] Adicionar ao `server.js` (ou `routes/branding.js`):
  - `GET /empresa/branding`: `authenticateToken`; resolver `id_grupo` do token;
    se sem grupo → `{ id_grupo: null, fallback: "movee" }` (200);
    se com grupo mas sem branding → `{ id_grupo: N, fallback: "movee" }` (200);
    se com branding → payload completo `{ id_grupo, logo_url, cor_primaria, cor_destaque, nome_exibicao }` (200)
  - **Comportamento para token de filho** (dec-021, CHK029): filho tem `id_grupo` no token;
    backend busca branding pelo `id_grupo` do filho → retorna branding do grupo se existir
  - `PUT /empresa/branding`: `authenticateToken` + `is_grupo_pai === true` → 403 se não-pai;
    allowlist campos aceitos: `{ cor_primaria, cor_destaque, nome_exibicao, logo, remove_logo }` (Mandato F5, dec-018);
    validações obrigatórias:
    - `cor_primaria`/`cor_destaque`: regex `^#[0-9a-fA-F]{6}$` → 400 se inválido
    - `nome_exibicao`: string ≤ 60 chars → 400 se exceder (dec-022, CHK033)
    - `logo` (multipart): delegar para `supabaseStorage.uploadLogo` → 400 se inválido
    - `remove_logo: true`: setar `logo_url = NULL` + `supabaseStorage.removeLogo` (dec-020, CHK025)
    - Upsert: INSERT INTO branding ... ON CONFLICT (id_grupo) DO UPDATE; sempre retorna 200 (dec-023, CHK034)

**FRs**: FR-007, FR-008, FR-011, CHK015 (dec-018), CHK025 (dec-020), CHK029 (dec-021),
CHK033 (dec-022), CHK034 (dec-023) | **Depende de**: 3.1, 2.1
**Critério de aceite**: PUT com `remove_logo: true` → logo_url = NULL; PUT com nome_exibicao de 61 chars → 400

### 3.3 Endpoint GET /motorista/branding-tomador [seg]

- [ ] Adicionar em `backend/routes/motorista.js`:
  - `GET /motorista/branding-tomador`: `authenticateMotorista`; parâmetro `?cnpj_tomador`;
    coerção/validação CNPJ → 400 se inválido;
    query PostgREST: `SELECT id_grupo FROM empresa WHERE cnpj = eq.{cnpj_tomador}`;
    se empresa não encontrada → `{ fallback: "movee" }` (200);
    se encontrada mas sem grupo/branding → `{ fallback: "movee" }` (200);
    se com branding → `{ logo_url, cor_primaria, cor_destaque, nome_exibicao }` (200) — sem `id_grupo` (Mandato F6)
  - Timeout client-side: documentar em `contracts/branding-api.md` que o frontend deve
    aplicar timeout de 3000ms (dec-024, CHK038); o endpoint em si não tem timeout interno

**FRs**: FR-010, Mandato F6 | **Depende de**: 3.2
**Critério de aceite**: curl com cnpj_tomador de empresa sem branding → `{ fallback: "movee" }`; sem `id_grupo` na resposta

### 3.4 Testes de integração de branding [seg]

- [ ] Criar `backend/tests/branding-integration.test.js` usando `node --test`:
  - PUT /empresa/branding com hex inválido → 400
  - PUT /empresa/branding com nome_exibicao de 61 chars → 400 (dec-022)
  - PUT /empresa/branding com `remove_logo: true` → logo_url NULL (dec-020)
  - PUT por token de filho → 403 (non-pai)
  - GET /empresa/branding por token de filho → retorna branding do grupo (dec-021)
  - GET /empresa/branding por empresa sem grupo → `{ fallback: "movee" }`
  - GET /motorista/branding-tomador por cnpj sem branding → `{ fallback: "movee" }`
  - PUT upsert inicial → 200 (não 201) (dec-023)
- [ ] Rodar: `cd backend && node --test tests/branding-integration.test.js`; todos pass

**FRs**: FR-007, FR-008, FR-010 | **Depende de**: 3.2, 3.3
**Critério de aceite**: `node --test` exit 0

---

## FASE-4 — Frontend v2 (Painel)

### 4.1 TenantThemeProvider para frontend_v2 (oklch) [crit]

- [ ] Criar `frontend_v2/components/tenant-theme-provider.tsx`:
  - Constante `MOVEE_DEFAULTS = { cor_primaria: '#E97316', cor_destaque: '#F59E0B', nome_exibicao: 'Movee', logo_url: null }` (dec-028, CHK057)
  - Ao montar: fetch `GET /empresa/branding` com timeout de 5000ms (fallback silencioso em erro)
  - Mapeamento snake_case → CSS custom properties (oklch, conforme `contracts/branding-api.md §Mapeamento`):
    `cor_primaria` → `--primary`; `cor_destaque` → `--accent`; `nome_exibicao` → data-attr `data-tenant-name`
  - Injetar via `document.documentElement.style.setProperty(...)` — não manipula classes next-themes
  - Fallback: se `response.fallback === "movee"` ou erro → aplicar MOVEE_DEFAULTS
  - Warning de contraste (dec-029, CHK058/059): calcular luminância relativa; se contraste estimado
    em dark < 3.0, emitir `console.warn` (MVP não bloqueia; aviso visual na tela de aparência — ver task 4.2)
- [ ] Integrar em `frontend_v2/app/layout.tsx`: `<TenantThemeProvider>` envolve `<ThemeProvider>` e `{children}`

**FRs**: FR-009, FR-013, CHK057 (dec-028), CHK058/059 (dec-029) | **Depende de**: FASE-3
**Critério de aceite**: empresa sem branding → tokens Movee ativos; empresa com branding → tokens customizados em :root

### 4.2 Tela /dashboard/configuracoes/aparencia (form + preview) [crit] [gap]

- [ ] Criar `frontend_v2/app/dashboard/configuracoes/aparencia/page.tsx`:
  - Form com campos: `cor_primaria` (color picker + hex input), `cor_destaque` (idem),
    `nome_exibicao` (text input, maxLength=60 — dec-022), upload de logo (PNG/SVG/JPEG ≤ 512 KB)
  - Botão "Remover logo" → envia `{ remove_logo: true }` no PUT (dec-020, CHK025)
  - Preview ao vivo client-only: ao alterar qualquer campo, aplicar CSS vars no `:root` via
    style tag temporário (state React) — NÃO persiste até clicar Salvar (dec-027, CHK052)
  - Warning de contraste: se contraste estimado em dark mode < 3.0 → exibir badge laranja
    "Cor pode ter baixo contraste em modo escuro" (dec-029, dec-032, CHK058/059, CHK068)
  - Ao clicar Salvar: PUT /empresa/branding; on success → toast "Aparência atualizada"; reload branding
  - Logo: dimensões de exibição no preview `h-8 max-w-32 object-contain` (dec-030, CHK062)
  - Comportamento dark/light: preview respeita classe `dark` do next-themes — tokens são aplicados
    sobre o tema atual, não substituem o mecanismo dark/light (dec-029)
- [ ] Criar `frontend_v2/components/branding-form.tsx`: componente do form (importado pela page)

**FRs**: FR-008, FR-009, FR-011, CHK052 (dec-027) | **Depende de**: 4.1
**Critério de aceite**: preview muda ao vivo ao alterar cor; Salvar envia PUT; "Remover logo" seta remove_logo=true

### 4.3 Fluxo pai vincular/desvincular filhos no painel

- [ ] Adicionar seção "Grupo de CNPJs" na tela `/dashboard/configuracoes/aparencia` (ou nova sub-rota):
  - GET /grupo/filhos: lista CNPJs vinculados ao grupo
  - Campo de busca/input para adicionar filho: `{ empresaIdFilho: N }` → POST /grupo/filhos
  - Botão desvincular por filho: DELETE /grupo/filhos/:id
  - Feedback de erros: 409 "Empresa já pertence a outro grupo"; 404 "Empresa não encontrada";
    422 "Limite de 100 filhos atingido" (dec-025)
  - Exibir nota: "Esta seção só é visível para o CNPJ pai do grupo"
- [ ] Visibilidade condicional: renderizar seção somente se `is_grupo_pai === true` no token decodificado

**FRs**: FR-005, FR-006, FR-007 | **Depende de**: 4.1, FASE-2
**Critério de aceite**: usuário pai consegue vincular novo CNPJ e vê lista atualizada; usuário filho não vê a seção

### 4.4 Refactor globals.css → tokens dinâmicos com fallback (frontend_v2)

- [ ] Atualizar `frontend_v2/app/globals.css`: manter tokens oklch atuais como fallback (`:root { --primary: oklch(...) }`)
  mas garantir que `TenantThemeProvider` sobrescreve com `style.setProperty` sem conflito
- [ ] Adicionar comentário no arquivo: `/* Tokens base Movee. TenantThemeProvider sobrescreve --primary e --accent em runtime. */`
- [ ] Verificar que `next build` não gera erros de lint CSS (tokens oklch válidos)

**FRs**: FR-009, FR-013 | **Depende de**: 4.1
**Critério de aceite**: `cd frontend_v2 && npx next build` exit 0; sem erros de CSS

---

## FASE-5 — Frontend Motorista (PWA)

### 5.1 TenantThemeProvider para frontend_motorista (HEX) [crit]

- [ ] Criar `frontend_motorista/components/tenant-theme-provider.tsx`:
  - Constante `MOVEE_DEFAULTS = { cor_primaria: '#E97316', cor_destaque: '#F59E0B', nome_exibicao: 'Movee', logo_url: null }` (dec-028)
  - Props: `cnpjTomador?: string` (passado pelo contexto do movimento)
  - Cache em memória: `Map<cnpj_tomador, BrandingPayload>` com TTL=sessão (dec-031, CHK066)
  - Ao montar/trocar cnpjTomador:
    - Se no cache → apply imediato (sem fetch)
    - Se não no cache → fetch `GET /motorista/branding-tomador?cnpj_tomador={cnpj}` com timeout 3000ms (dec-024)
    - Em erro/timeout → fallback Movee silencioso
  - Mapeamento HEX → CSS custom properties (conforme `contracts/branding-api.md §Mapeamento frontend_motorista`)
  - Logo: dimensões `h-6 max-w-24 object-contain` (dec-030, CHK062 — header menor no PWA)
- [ ] Integrar em `frontend_motorista/app/(app)/layout.tsx`

**FRs**: FR-010, FR-013, CHK066 (dec-031) | **Depende de**: FASE-3
**Critério de aceite**: movimento com cnpj_tomador com branding → tokens customizados; segundo movimento mesmo cnpj → sem novo fetch (cache)

### 5.2 Branding por movimento em (app)/movimento/page.tsx

- [ ] Em `frontend_motorista/app/(app)/movimento/page.tsx`:
  - Extrair `cnpj_tomador` dos dados do movimento
  - Passar `cnpjTomador={cnpj_tomador}` para `<TenantThemeProvider>`
  - `brand/logo-mark` e `brand/wordmark`: aceitar prop `logoUrl` e `nomeExibicao` vindos do TenantThemeProvider;
    se logoUrl → exibir `<img src={logoUrl} ... />` (não inline SVG — Mandato F2); senão → nome/wordmark

**FRs**: FR-010, FR-012, Mandato F2 | **Depende de**: 5.1
**Critério de aceite**: movimento de tomador com branding → logo/cores do tomador aplicados; tomador sem branding → marca Movee

### 5.3 Refactor globals.css → tokens dinâmicos com fallback (frontend_motorista)

- [ ] Atualizar `frontend_motorista/app/globals.css`: tokens HEX actuais como fallback;
  `TenantThemeProvider` sobrescreve `--primary`, `--accent` em runtime via `style.setProperty`
- [ ] Manter gradiente Movee (`--warm-1`, `--warm-2`, `--warm-3`) como tokens fixos (não sobrescritos pelo branding)
- [ ] Adicionar comentário: `/* Tokens base Movee. TenantThemeProvider sobrescreve --primary e --accent por movimento. */`
- [ ] Verificar que `next build` do motorista exit 0

**FRs**: FR-010, FR-013 | **Depende de**: 5.1
**Critério de aceite**: `cd frontend_motorista && npx next build` exit 0

---

## FASE-6 — Deploy Aditivo + Validação

> Classifier bloqueia acesso ao registry e ao swarm. Todas as tasks desta fase
> produzem **comandos para o operador executar**, não executam diretamente.

### 6.1 Deploy backend (service update aditivo)

- [ ] Gerar instruções de deploy em `docs/specs/config-ui-tenant/deploy-checklist.md`:
  ```bash
  # 1. Build e push da imagem backend
  docker build -t registry.todo-tips.com/backend:config-ui-tenant ./app_homologacao/backend
  docker push registry.todo-tips.com/backend:config-ui-tenant

  # 2. Update do serviço (aditivo — NUNCA stack deploy completo)
  docker service update --image registry.todo-tips.com/backend:config-ui-tenant \
    --force envio_backend

  # 3. Validar: GET /empresa/branding deve retornar 200 (não 404)
  curl -s -o /dev/null -w "%{http_code}" https://api.todo-tips.com/empresa/branding \
    -H "Cookie: accessToken=<token-de-teste>"
  # Esperado: 200 ou 401 (não 404/500)
  ```
- [ ] Validação de digest: confirmar que `docker service ps envio_backend` mostra a nova imagem

**FRs**: Princípio V (Constitution) | **Depende de**: FASE-3
**Critério de aceite**: arquivo `deploy-checklist.md` existe; operador confirma deploy OK

### 6.2 Deploy frontend_v2 (service update aditivo)

- [ ] Adicionar ao `docs/specs/config-ui-tenant/deploy-checklist.md`:
  ```bash
  # Build next.js (verificar antes localmente)
  cd app_homologacao/frontend_v2 && npx next build

  # Build e push imagem
  docker build -t registry.todo-tips.com/frontend_v2:config-ui-tenant ./app_homologacao/frontend_v2
  docker push registry.todo-tips.com/frontend_v2:config-ui-tenant

  # Update aditivo
  docker service update --image registry.todo-tips.com/frontend_v2:config-ui-tenant \
    --force envio_frontend_v2

  # Validar: página de aparência acessível
  curl -s -o /dev/null -w "%{http_code}" https://painel.todo-tips.com/dashboard/configuracoes/aparencia
  # Esperado: 200 (autenticado) ou 302 (redirect login — não 404/500)
  ```

**FRs**: Princípio V | **Depende de**: FASE-4
**Critério de aceite**: `next build` exit 0 localmente; operador confirma deploy OK

### 6.3 Deploy frontend_motorista (service update aditivo)

- [ ] Adicionar ao `deploy-checklist.md`:
  ```bash
  cd app_homologacao/frontend_motorista && npx next build

  docker build -t registry.todo-tips.com/frontend_motorista:config-ui-tenant \
    ./app_homologacao/frontend_motorista
  docker push registry.todo-tips.com/frontend_motorista:config-ui-tenant

  docker service update \
    --image registry.todo-tips.com/frontend_motorista:config-ui-tenant \
    --force envio_frontend_motorista

  # Validar: PWA responde 200
  curl -s -o /dev/null -w "%{http_code}" https://appmotorista.todo-tips.com/
  # Esperado: 200
  ```

**FRs**: Princípio V | **Depende de**: FASE-5
**Critério de aceite**: `next build` exit 0 localmente; operador confirma 200 no ar

### 6.4 Validação E2E no ar

- [ ] Operador executa checklist de validação pós-deploy:
  1. Login como empresa pai do grupo D&G no painel → verificar que seção "Grupo de CNPJs" aparece
  2. Configurar cor_primaria e nome_exibicao → Salvar → recarregar página → branding persistida
  3. Login como empresa filha → branding do grupo aplicada; seção "Grupo de CNPJs" oculta
  4. PWA motorista: abrir movimento de tomador D&G → confirmar que cores do grupo aparecem
  5. Empresa sem grupo: branding Movee (fallback)
  6. Verificar que `next-themes` dark/light ainda funciona (toggle) com branding customizada ativa
- [ ] Documentar resultado (pass/fail) em `docs/specs/config-ui-tenant/deploy-checklist.md`

**FRs**: US1, US2, FR-009, FR-010, FR-013 | **Depende de**: 6.1, 6.2, 6.3
**Critério de aceite**: todos os 6 cenários pass; nenhum 404/500 nas chamadas de branding

---

## Notas ao Implementador

### Gaps dos Checklists — Decisões Tomadas (não re-abrir)

| CHK | Gap | Decisão | dec-ID |
|-----|-----|---------|--------|
| CHK003 | Status code para path param não-numérico | **400 Bad Request** | dec-016 |
| CHK006 | Enforce Content-Type: bucket policy vs handler | Handler Express (obrigatório); bucket policy = hardening futuro | dec-017 |
| CHK015 | Campos extras no body: ignored ou 400 | Allowlist + ignore silencioso (Mandato F5) | dec-018 |
| CHK022 | Constitution bump como tarefa obrigatória | FASE-0, task dedicada | dec-019 |
| CHK025 | Semântica remoção de logo | Campo `remove_logo: true` no PUT | dec-020 |
| CHK029 | Token de filho: recebe branding do grupo | Sim — filho herda branding do grupo via id_grupo do token | dec-021 |
| CHK033 | Limite concreto nome_exibicao | **60 chars** (VARCHAR(60) no DDL + 400 no handler) | dec-022 |
| CHK034 | Upsert inicial retorna 200 ou 201 | Sempre **200** | dec-023 |
| CHK038 | Timeout concreto branding-tomador | **3000ms** (client-side; documentado no contrato) | dec-024 |
| CHK046 | Paginação GET /grupo/filhos | Limite implícito **100 filhos** (422 se atingido) | dec-025 |
| CHK049 | Mecanismo de lock POST /grupo/filhos | **UNIQUE constraint** em empresa + verificação condicional no handler | dec-026 |
| CHK052 | Preview live-as-you-type vs save-triggered | Preview = client-only (state React); persistência = ao Salvar | dec-027 |
| CHK057 | Valores padrão Movee hardcoded | `MOVEE_DEFAULTS` no TenantThemeProvider (`#E97316`, `#F59E0B`, `Movee`) | dec-028 |
| CHK058/059 | Cores do tenant em dark mode | Aplicar direto + warning se contraste < 3.0 (não bloqueia) | dec-029 |
| CHK062 | Dimensões do logo no header | `h-8 max-w-32` (v2); `h-6 max-w-24` (motorista) | dec-030 |
| CHK066 | Ciclo de vida TenantThemeProvider ao trocar movimento | Cache `Map<cnpj_tomador, payload>` com TTL=sessão | dec-031 |
| CHK068 | Contraste em dark mode: critério mínimo | Warning se contraste < 3.0; não bloqueia (MVP) | dec-032 |
| FR-INFRA-LOCK | Mecanismo concreto de lock | **UNIQUE constraint** DDL + captura 409 no handler | dec-033 |

### Mandatos de Segurança (não pular)

| ID | Mandato | Task |
|----|---------|------|
| F1 | Coerção inteiro de todos os ids antes de interpolar em query PostgREST | 2.2, 2.3, 3.2 |
| F2 | SVG servido via `<img src>`, nunca inline | 3.1, 5.2 |
| F4 | Validação server-side de is_grupo_pai + ownership | 2.2, 2.3, 3.2 |
| F5 | Allowlist de campos em PUT/POST antes de persistir | 2.2, 3.2 |
| F6 | select= explícito no GET leve do PWA | 3.3 |

### Constraint Node 14 (backend)

- Não usar `FormData` global → usar pacote `form-data`
- Validar transpilação de optional chaining em Node 14 se usado
- Supabase JS `@supabase/supabase-js` ^2 já instalado: importar diretamente
