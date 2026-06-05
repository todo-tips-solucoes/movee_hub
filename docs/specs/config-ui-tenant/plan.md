# Implementation Plan: config-ui-tenant (White-label por Tenant + Grupo de CNPJs)

**Feature**: `config-ui-tenant`
**Spec**: `docs/specs/config-ui-tenant/spec.md`
**Branch**: `feature/config-ui-tenant`
**Status**: Plano técnico (fase plan do pipeline SDD)

---

## Summary

Permitir que tenants (empresas) personalizem a identidade visual (logo, cor
primária, cor de destaque/gradiente, nome de exibição) tanto no painel
administrativo (`frontend_v2`) quanto no AppMotorista (`frontend_motorista`),
escopada por **Grupo de CNPJs** (holding pai→filhos). A branding exibida ao
motorista é a do **tomador** do movimento consultado.

**Abordagem técnica** (decisões já travadas com o usuário, ver §Decisões Travadas
da spec):

1. **Grupo** vira nova entidade; `Empresa` ganha FK `id_grupo` NULLABLE (aditiva).
   1:N — filho pertence a no máximo um grupo.
2. **Branding** é 1:1 com `Grupo` (uma config por holding). Empresa sem grupo →
   fallback Movee. Logo persiste no **Supabase Storage** (URL na tabela Branding);
   `@supabase/supabase-js` já é dependência do backend.
3. **resolveScope(req.user)** server-side resolve o conjunto de `empresaId`s que o
   token pode acessar (própria + filhos do grupo, se for pai). Nunca a partir do
   corpo/query do cliente — preserva o invariante do Princípio II amendado para
   v1.1.0.
4. **Frontend**: provider `TenantTheme` injeta CSS custom properties em `:root` em
   runtime, sobrescrevendo tokens shadcn (v2) e identidade Movee (motorista),
   respeitando dark/light (next-themes no v2). Refactor de `globals.css` dos 2
   fronts para tokens dinâmicos com fallback hardcoded atual. Nova tela
   `/dashboard/configuracoes/aparencia` com form + preview ao vivo.
5. **MVP só branding** — sem layout-switches nem toggles de funcionalidade.

---

## Technical Context

| Campo | Valor |
|-------|-------|
| **Linguagem (backend)** | Node.js 14 (Dockerfile `FROM node:14`) + Express ^4.17 |
| **Linguagem (frontends)** | TypeScript + Next.js 16.2.3 (React 19.2.4) |
| **Persistência** | PostgreSQL via **PostgREST** (helper `postgrestRequest`); JWT PostgREST gerado internamente |
| **Storage de binários** | Supabase Storage (`@supabase/supabase-js` ^2 já instalado no backend) |
| **Auth** | JWT em cookies httpOnly; `authenticateToken` → `req.user.empresaId` (aud empresa); `authenticateMotorista` → `req.motorista.cnpjPrestador` (aud=motorista) |
| **UI tokens** | `frontend_v2`: Tailwind v4 + shadcn, tokens **oklch** em `:root`/`.dark`, next-themes (`attribute="class"`, defaultTheme=dark, enableSystem=false). `frontend_motorista`: Tailwind v4, tokens **HEX** em `:root`/`.dark` + gradiente Movee (`--warm-1/2/3`) |
| **Deploy** | Docker Swarm aditivo (`service update --force`); NUNCA `stack deploy` completo. Registry `registry.todo-tips.com` |
| **Testing** | Backend: `node --test` (`tests/*.test.js`). Frontends: validação manual no ar após `next build` |
| **Constraint Node 14** | Sem `FormData` global; usar pacote `form-data` (já feito em `routes/motorista.js`). Sem optional chaining em alguns contextos — validar transpilação |
| **NEEDS CLARIFICATION** | 0 (todas as ambiguidades resolvidas nas Decisões Travadas + research.md) |

---

## Constitution Check

*GATE: deve passar antes do Phase 0. Re-checado após Phase 1 (ver §Re-check).*

| Princípio | Status | Notas |
|-----------|--------|-------|
| **I. Segurança de Autenticação & Segredos** (NON-NEGOTIABLE) | PASS | Branding endpoints usam `authenticateToken` (cookies httpOnly existentes). Nenhum segredo novo em log/resposta. Supabase service key vive em `.env` fora do git (`*.env.example` como ref). Upload de logo validado (formato + tamanho). |
| **II. Isolamento Multi-Tenant por Empresa** (NON-NEGOTIABLE) | PASS *com amendment* | A feature **expande intencionalmente** o escopo: de `empresaId` único → conjunto resolvido por `resolveScope(req.user)` (própria + filhos do grupo). O invariante crítico é preservado: o conjunto é resolvido **server-side a partir do token**, nunca do corpo/query. Tokens de filhos veem só a própria empresa. Amendment §II v1.0.0→v1.1.0 documentado na spec; bump aplicado em `docs/constitution.md` na fase de execução (tarefa dedicada). |
| **III. Contratos de API & Proxy de Cookies** | PASS | Novos endpoints sob o mesmo proxy `app/api/[...path]/route.ts` dos dois fronts. Contratos declarados em `contracts/`. GET leve do PWA reusa `authenticateMotorista`. |
| **IV. Qualidade e Revisão de Mudanças** | PASS | Branch `feature/config-ui-tenant` dedicada. Conventional commits. Mudança toca auth (resolveScope) e upload (logo) → revisão OWASP obrigatória (gate `owasp-security` rodado nesta fase + execução). |
| **V. Deploy Conteinerizado e Convivência** (NON-NEGOTIABLE) | PASS | DDL aditivo (`IF NOT EXISTS`), sem downtime. Deploy via `service update --force` por serviço; nunca afeta containers em produção. Migração D&G entregue como `.sql` ao operador. |

**Resultado do gate**: PASS. O único ponto sensível (Princípio II) é uma expansão
**deliberada e documentada** que preserva o invariante de segurança — não é
violação, é amendment MINOR ratificado na spec.

---

## Project Structure

### Documentation (this feature)

```
docs/specs/config-ui-tenant/
├── spec.md           # WHAT/WHY (já existe)
├── plan.md           # Este arquivo
├── research.md       # Phase 0 — decisões técnicas
├── data-model.md     # Phase 1 — entidades Grupo + Branding + FK Empresa
├── quickstart.md     # Phase 1 — cenários de teste E2E
└── contracts/
    ├── branding-api.md   # GET/PUT /empresa/branding + GET leve PWA
    └── grupo-api.md      # gestão de grupo/filhos (pai)
docs/sql/
├── dg-levantamento.sql              # já existe (levantamento de CNPJs — input do usuário)
├── 001-config-ui-tenant-schema.sql  # DDL aditivo (Grupo, FK id_grupo, Branding) — gerado na execução
└── 002-config-ui-tenant-dg-vinculo.sql  # UPDATE de vínculo PARAMETRIZADO (placeholder) — gerado na execução
```

### Source Code (repository root)

```
app_homologacao/
├── backend/                          # Express Node 14
│   ├── server.js                     # + endpoints branding/grupo; + resolveScope; + claim id_grupo no login
│   ├── routes/
│   │   ├── motorista.js              # + GET leve branding-do-tomador (authenticateMotorista)
│   │   └── grupo.js                  # NOVO — gestão de grupo/filhos (authenticateToken + papel pai)
│   ├── lib/
│   │   ├── resolveScope.js           # NOVO — helper de escopo server-side
│   │   └── supabaseStorage.js        # NOVO — upload/URL de logo (reusa @supabase/supabase-js)
│   └── tests/
│       ├── grupo-scope.test.js       # NOVO — unit: resolveScope (pai vê filhos, filho só si)
│       └── branding-integration.test.js  # NOVO — integração: PUT/GET branding + isolamento
├── frontend_v2/                      # Next 16 painel
│   ├── app/
│   │   ├── globals.css               # refactor: tokens oklch dinâmicos c/ fallback atual
│   │   ├── layout.tsx                # + <TenantThemeProvider> envolvendo ThemeProvider
│   │   └── dashboard/configuracoes/aparencia/page.tsx  # NOVA tela form + preview
│   ├── components/
│   │   ├── tenant-theme-provider.tsx # NOVO — injeta CSS vars em :root (runtime)
│   │   └── branding-form.tsx         # NOVO — form de branding + preview ao vivo + vincular filhos
│   └── lib/api-client.ts             # + chamadas branding/grupo
└── frontend_motorista/               # Next 16 PWA
    ├── app/
    │   ├── globals.css               # refactor: tokens HEX dinâmicos c/ fallback Movee atual
    │   ├── (app)/layout.tsx          # + <TenantThemeProvider> (escopo motorista)
    │   └── (app)/movimento/page.tsx  # + fetch branding-do-tomador por movimento + aplica tema
    └── components/
        ├── tenant-theme-provider.tsx # NOVO — injeta CSS vars HEX (runtime) c/ fallback Movee
        └── brand/                    # logo-mark/wordmark passam a aceitar override de logo_url
```

**Structure Decision**: backend mantém o padrão atual (rotas grandes em `server.js`
+ módulos extraídos em `routes/` com helpers injetados via `init()`). Grupo vira
módulo próprio (`routes/grupo.js`) seguindo o padrão de `routes/motorista.js`.
`resolveScope` e `supabaseStorage` viram helpers em `backend/lib/` para serem
reutilizáveis e testáveis isoladamente. Frontends ganham `TenantThemeProvider` por
app (não compartilhado — tokens divergem: oklch no v2, HEX no motorista).

---

## Convenções de Borda

A feature atravessa 3 camadas (PostgreSQL ↔ backend Express ↔ frontends Next).
Fonte da verdade de cada convenção declarada **upfront** (lição dec-172/173: 40
ondas de retrabalho por divergência snake_case/camelCase não declarada).

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL/PostgREST) | `snake_case` (`id_grupo`, `logo_url`, `cor_primaria`, `cor_destaque`, `nome_exibicao`) | DDL `IF NOT EXISTS` + reload PostgREST | `docs/sql/001-config-ui-tenant-schema.sql` |
| Backend ↔ PostgREST payload | `snake_case` (PostgREST espelha colunas) | n/a (passthrough) | colunas do banco |
| API payload (backend ↔ frontends) | `snake_case` **idêntico ao banco** | validação explícita no handler (hex, tamanho, formato) | `contracts/*.md` |
| Frontend DTO (TS) | `snake_case` (espelha API; sem mapper) | type guards em `lib/api-client.ts` | `contracts/*.md` |
| CSS custom properties (`:root`) | `--kebab-case` (`--primary`, `--accent`, `--warm-1`) | mapeamento explícito no `TenantThemeProvider` | `globals.css` + provider |
| URL path/query | `kebab-case` (`/empresa/branding`, `/grupo/filhos`) | router Express | `contracts/*.md` |

**Decisão de case**: o projeto **não tem mapper layer** hoje — `postgrestRequest`
devolve objetos snake_case direto do PostgREST e os frontends já consomem assim
(ex.: `id_empresa`, `cnpj_tomador`, `nome_empresa`). Para **não introduzir** o
risco de drift que custou 40 ondas na execução-fonte, a feature mantém
`snake_case` ponta-a-ponta (banco → API → DTO frontend). O único ponto de
tradução é DTO snake_case → CSS custom property kebab-case, feito **explicitamente**
no `TenantThemeProvider` (tabela de mapeamento declarada em `contracts/branding-api.md`).

**Mapper layer (DB ↔ DTO)**: NÃO existe / NÃO introduzido. ORM auto-mapping: NÃO
(PostgREST direto). Validação: handler do backend valida `cor_primaria`/`cor_destaque`
como hex `^#[0-9a-fA-F]{6}$`, `nome_exibicao` (string não vazia, limite de chars),
logo (mimetype PNG/SVG/JPEG + tamanho ≤ 512 KB) antes de persistir.

---

## Estratégia de Migração de Dados (D&G)

- **001-config-ui-tenant-schema.sql** (aditivo, idempotente): `CREATE TABLE IF NOT
  EXISTS "Grupo"`, `ALTER TABLE "Empresa" ADD COLUMN IF NOT EXISTS id_grupo`,
  `CREATE TABLE IF NOT EXISTS "Branding"`, FK + índices, e ao final `NOTIFY pgrst,
  'reload schema';`. Entregue ao operador (classifier bloqueia banco). Reload
  alternativo: `docker kill -s SIGUSR1 pgadmin_postgrest`.
- **002-config-ui-tenant-dg-vinculo.sql** (PARAMETRIZADO): depende de
  `docs/sql/dg-levantamento.sql` (lista de CNPJs da D&G **ainda a confirmar pelo
  usuário** — bloqueio humano documentado). O script de vínculo usa **placeholders**
  (`:cnpj_pai`, `:cnpjs_filhos`) ou um bloco `DO $$ ... $$` com array parametrizado —
  **nunca** hardcode de ids. Enquanto o levantamento não for respondido, a migração
  de vínculo fica bloqueada; o schema (001) pode ser aplicado independentemente.

---

## Sequência de Implementação (ordem de dependência)

1. **DDL + schema** (Parte B antes de A — modelar grupo antes da branding): gerar
   `001-*.sql`, aplicar (operador), reload PostgREST.
2. **Backend Grupo**: `resolveScope` + claim `id_grupo`/papel pai no login +
   `routes/grupo.js` (listar/vincular/desvincular). Testes de escopo.
3. **Backend Branding**: `GET/PUT /empresa/branding` (escopo grupo) +
   `supabaseStorage` (upload logo) + GET leve PWA (`branding-do-tomador`).
4. **Frontend v2**: `TenantThemeProvider` + refactor `globals.css` + tela
   `/dashboard/configuracoes/aparencia` + fluxo pai vincular filhos.
5. **Frontend motorista**: `TenantThemeProvider` (HEX) + refactor `globals.css` +
   fetch branding-do-tomador no movimento + fallback Movee.
6. **Deploy aditivo** por serviço + validação no ar.

---

## Security Hardening (gate owasp-security — fase plan)

Gate `owasp-security` rodado sobre a arquitetura: **0 findings critical/high**.
O invariante crítico (Princípio II — escopo server-side a partir do token, nunca
do corpo) é preservado por design. Findings medium/low viram **mandatos de
implementação** carregados para as tasks:

| ID | Sev | OWASP | Mandato para a implementação |
|----|-----|-------|------------------------------|
| F1 | medium | A05 Injection | `postgrestRequest` constrói query por template string (sem parametrização nativa). TODO id que entra em `eq.`/`in.(...)`/path param (`empresaIdFilho`, `?id_empresa`, `?movimento`) DEVE ser coagido a inteiro (`Number.isInteger`) e rejeitado se não-numérico, ANTES de interpolar. Único defense contra SQLi no PostgREST. |
| F2 | medium | Upload / Stored XSS | SVG pode conter `<script>`/handlers. Logo é servido por URL pública do Storage e exibido via `<img src>` (não inline) — mitiga. Reforço: enforce `Content-Type` no Storage; se algum front inlinar SVG no futuro, sanitizar (strip script/on*) no upload OU restringir MVP a PNG/JPEG. |
| F3 | low | A07 SSRF (guard) | MVP faz upload de arquivo (multipart), sem fetch de URL remota → sem SSRF. Guard: se "logo via URL" for adicionado depois, vira superfície SSRF. |
| F4 | low | A01/IDOR | Endpoints de grupo validam server-side ownership + `is_grupo_pai` (já no contrato). Risco residual = drift de implementação → coberto por `grupo-scope.test.js` (filho-de-outro-grupo → 403). |
| F5 | low | API3 BOPLA | Handlers de `PUT /empresa/branding` e `POST /grupo/filhos` DEVEM allowlistar campos aceitos; nunca espalhar `req.body` no insert PostgREST. `id_grupo` sempre do token. |
| F6 | low | A09 Exposição | GET leve do PWA usa `select=` explícito (logo/cores/nome) — nunca retorna a linha completa da Empresa/tomador. |

## Complexity Tracking

| Violação potencial | Por que necessária | Mitigação |
|--------------------|--------------------|-----------|
| Expansão do escopo do Princípio II (empresaId único → conjunto) | Requisito de negócio: holdings com CNPJ pai + filhos operacionais | Invariante preservado: escopo server-side a partir do token via `resolveScope`; filhos veem só a si; amendment MINOR ratificado na spec. NÃO é violação — é evolução governada. |
| Nova dependência de runtime no frontend (injeção de CSS vars) | White-label exige tema dinâmico sem rebuild | Zero deps novas: usa CSS custom properties nativas + `style` no `:root`. Fallback hardcoded = comportamento atual idêntico se branding ausente. |

Nenhuma violação de MUST não-mitigada. Plano aprovado para Phase create-tasks.
