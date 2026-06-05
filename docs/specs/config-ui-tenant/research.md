# Research: config-ui-tenant

Phase 0 — decisões técnicas. Todas as ambiguidades de design foram resolvidas
(0 NEEDS CLARIFICATION restantes). As decisões de produto já vieram travadas
(ver §Decisões Travadas da spec); este documento registra as decisões **técnicas**
e alternativas consideradas.

---

## Decision 1: Modelo do Grupo — FK direta vs tabela de associação

**Decision**: Nova entidade `Grupo` + FK `id_grupo` NULLABLE direto na tabela
`Empresa` (1:N).

**Rationale**: O requisito é estrito — um filho pertence a **no máximo um** grupo
(FR-001). FK direta na Empresa modela isso nativamente (cardinalidade 1:N imposta
pelo schema, sem linha órfã possível). É aditiva (`ADD COLUMN IF NOT EXISTS`,
NULLABLE → empresas existentes ficam sem grupo = comportamento atual preservado).

**Alternatives considered**:
- *Tabela de associação `GrupoEmpresa` (N:N)*: rejeitada — permitiria um filho em
  vários grupos, contradizendo FR-001, e exigiria constraint de unicidade extra
  para emular 1:N. Complexidade sem ganho.
- *Coluna `parent_empresa_id` self-referencing*: rejeitada — acoplaria branding ao
  "pai" como empresa, não como holding; a branding é da **holding**, e o pai é só
  quem a administra. `Grupo` como entidade separada deixa a branding 1:1 com grupo
  limpa e permite trocar o pai sem migrar branding.

---

## Decision 2: resolveScope — onde e como resolver o conjunto de empresas

**Decision**: Helper server-side `resolveScope(user)` em `backend/lib/resolveScope.js`,
chamado nos handlers que precisam de escopo expandido. Resolve a partir do
`req.user` (token), nunca do corpo/query.

**Rationale**: Princípio II (NON-NEGOTIABLE) exige que o escopo venha do token.
O claim `id_grupo` é gravado no JWT **no login** (a partir da coluna
`Empresa.id_grupo`), então `resolveScope` não precisa de round-trip extra para
saber o grupo do próprio usuário; só busca os filhos quando o usuário é pai
(`papel === 'pai'`, derivado de ser o `Grupo.id_empresa_pai`). O conjunto retornado
é `[empresaId própria, ...filhos]` para pai; `[empresaId própria]` para filho ou
empresa sem grupo. Tokens de filhos **nunca** recebem escopo expandido.

**Como o token carrega o grupo**:
- `login` enriquece o payload JWT com `id_grupo` (de `Empresa.id_grupo`) e um flag
  `is_grupo_pai` (true se existe `Grupo` cujo `id_empresa_pai = user.id`).
- `resolveScope(user)`:
  - se `!user.id_grupo` → retorna `[user.empresaId]` (sem grupo).
  - se `user.is_grupo_pai` → `postgrestRequest("Empresa?id_grupo=eq.<id_grupo>&select=id")`
    → retorna `[empresaId própria, ...ids dos filhos]`.
  - se `user.id_grupo` mas `!is_grupo_pai` (é filho) → retorna `[user.empresaId]`.

**Alternatives considered**:
- *Resolver grupo a cada request via query na Empresa*: rejeitado — round-trip extra
  por request; o claim no token elimina isso (o grupo só muda em eventos raros de
  gestão, e o token expira em 15 min, então a defasagem máxima é aceitável).
- *Escopo enviado pelo cliente (lista de empresaIds no body)*: **PROIBIDO** pelo
  Princípio II. Nunca considerado seriamente — é exatamente o anti-padrão que o
  invariante previne.

---

## Decision 3: Persistência do logo — Supabase Storage vs coluna bytea vs base64

**Decision**: Logo persiste no **Supabase Storage**; a tabela `Branding` guarda só
a `logo_url` (text). Upload feito no backend via `@supabase/supabase-js` (já
dependência).

**Rationale**: Binário em coluna (`bytea`/base64) infla o payload de toda leitura
de branding (incluindo o GET leve do PWA, chamado a cada movimento). URL pública
do Storage é cacheável pelo CDN/navegador e mantém o payload de branding pequeno
(só strings). `@supabase/supabase-js` já está no `package.json` do backend.

**Idempotência (FR-INFRA-IDEMP)**: o nome do objeto no Storage é derivado do hash
do conteúdo (`logo/<id_grupo>/<sha256>.<ext>`); re-upload do mesmo arquivo
sobrescreve o mesmo path (upsert) — não cria duplicata.

**Validação (FR-011)**: mimetype ∈ {image/png, image/svg+xml, image/jpeg},
tamanho ≤ 512 KB. Recusa com mensagem em PT-BR antes de tocar o Storage.

**Alternatives considered**:
- *bytea no PostgreSQL*: rejeitado — payload pesado no GET leve do PWA; PostgREST
  serializaria base64 a cada leitura.
- *Storage local no container backend*: rejeitado — efêmero no Swarm (`service
  update` recria container); perderia logos. Supabase Storage é durável e já
  configurado.

---

## Decision 4: Injeção de tema em runtime — CSS custom properties vs re-render de classes

**Decision**: Provider `TenantThemeProvider` que escreve CSS custom properties
(`--primary`, `--accent`, etc.) diretamente no `:root` (`document.documentElement.style`)
quando a branding carrega. `globals.css` refatorado para que os tokens leiam as
custom properties com **fallback hardcoded** = valor atual.

**Rationale**: Ambos os fronts já usam CSS custom properties como tokens
(`var(--primary)` etc.). Sobrescrever a property no `:root` em runtime propaga para
toda a árvore sem re-render React e sem rebuild — exatamente FR-009 ("sem
reinicialização ou recarregamento"). Fallback hardcoded garante que, sem branding
(ou durante o fetch), o app renderiza idêntico ao atual.

**Dark/light (v2)**: next-themes alterna a classe `.dark`/`:root`. O provider
escreve as properties no escopo correto respeitando o tema ativo — a branding
define a cor "marca" (primária/accent), e os tons neutros de fundo/texto continuam
vindo do dark/light. No motorista, o gradiente Movee (`--warm-1/2/3`) é
sobrescrito pela cor de destaque/gradiente do tomador quando presente.

**Mapeamento snake_case → CSS var** (declarado em `contracts/branding-api.md`):
`cor_primaria → --primary` (+ derivar `--ring`, `--sidebar-primary` no v2);
`cor_destaque → --accent`/gradiente (`--warm-*` no motorista); `nome_exibicao →`
texto do wordmark; `logo_url → src` do logo-mark.

**Alternatives considered**:
- *Gerar `globals.css` por tenant no build*: rejeitado — exige rebuild/redeploy por
  tenant; impossível para white-label dinâmico.
- *Inline style por componente*: rejeitado — não propaga para shadcn/Tailwind que
  leem `var(--token)`; quebraria a consistência do design system.
- *styled-components/CSS-in-JS*: rejeitado — dependência nova, fora do padrão
  Tailwind v4 do projeto.

---

## Decision 5: GET leve do PWA — autenticação e resolução por movimento

**Decision**: Endpoint `GET /motorista/branding-tomador?movimento=<id>` (ou
`?id_empresa=<id>`) sob `routes/motorista.js`, protegido por `authenticateMotorista`
(o motorista já está autenticado por `cnpj_prestador`, aud=motorista). Backend
resolve: movimento → `id_empresa` do tomador → `id_grupo` → `Branding` do grupo
→ retorna branding ou fallback Movee.

**Rationale**: O motorista não tem token de empresa; reusar `authenticateMotorista`
mantém o Princípio I (cookies httpOnly, separação de audiência). O backend faz a
resolução server-side (FR-007/FR-010) — o PWA só passa a referência do movimento,
nunca escolhe a branding. Timeout definido no fetch do PWA; falha/ausência →
fallback Movee (FR-010, degradação graciosa).

**Isolamento (FR-012)**: a branding é resolvida pelo `id_empresa` do **movimento**
(dado do backend), não por input arbitrário do cliente — respeita o mesmo escopo
de isolamento dos dados de negócio. O GET é read-only e só expõe campos de marca
pública (logo/cores/nome), nunca dados sensíveis do tomador.

**Alternatives considered**:
- *Branding embutida no payload do movimento*: considerada; rejeitada para o MVP
  porque acoplaria o contrato existente de `/motorista/*` e infla todo movimento.
  Endpoint dedicado e cacheável é mais limpo (pode virar otimização futura).

---

## Decision 6: Bump da Constitution (Princípio II → v1.1.0)

**Decision**: Aplicar o amendment §II (v1.0.0→v1.1.0) descrito na spec a
`docs/constitution.md` como tarefa dedicada na fase de execução (não nesta fase de
plano).

**Rationale**: A spec já contém o texto proposto e o Sync Impact Report. O bump é
MINOR (expansão governada, sem quebrar interface de rotas existentes — filhos
continuam vendo só a própria empresa). Aplicar na execução mantém o plano puro
(documentação) e o bump auditável como mudança versionada.

**Alternatives considered**:
- *Não amendar e tratar grupo como exceção pontual*: rejeitado — deixaria o
  Princípio II em contradição silenciosa com o código (`resolveScope` retornando
  múltiplos ids). Governança exige o texto refletir a realidade.
