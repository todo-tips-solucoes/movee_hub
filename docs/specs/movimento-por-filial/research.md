# Research: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial` · **Phase 0** · 2026-06-10

Todas as decisões abaixo foram resolvidas por **leitura do código real**
(`server.js`, `routes/grupo.js`, `frontend_v2/lib/api-client.ts`,
`hooks/use-envio-massa.ts`, `contexts/auth-context.tsx`, `package.json`) —
não há `[NEEDS CLARIFICATION]` remanescente. As 9 decisões de produto (§3)
foram pré-confirmadas pelo operador.

---

## Decision D0.1 — Tipo do combobox de filial

**Decision**: Combobox **pesquisável** via shadcn `command` (`cmdk`) +
`popover` (`@radix-ui/react-popover`). Adicionar as duas primitivas a
`components/ui/` e a dep ao `package.json`.

**Rationale**: FR-006 exige busca textual por nome ("dezenas de empresas"). O
único componente de seleção existente em `components/ui/` é `select.tsx`
(shadcn Select / radix-select), que **não tem campo de busca interno**. O
padrão shadcn para combobox pesquisável é `Command` dentro de `Popover`. Nem
`cmdk` nem `@radix-ui/react-popover` estão nas deps hoje (confirmado por grep no
`package.json`: só `next@16.2.3`, `react@19.2.4`, sem `cmdk`/`popover`).

**Alternatives considered**:
- `<Select>` nativo (já existe): rejeitado — sem busca; viola FR-006 para grupos grandes.
- `<datalist>` HTML puro: rejeitado — UX inconsistente com o design system EntreGô 2.0.
- Lib de combobox de terceiros (react-select): rejeitado — peso extra + estilo divergente do shadcn/Tailwind já adotado.

---

## Decision D0.2 — Onde mora `resolveEmpresaAlvo`

**Decision**: Definir `resolveEmpresaAlvo(user, requestedId)` em
`routes/grupo.js` e **exportá-lo** no `module.exports` (junto de `resolveScope`,
`init`, `resolveOrCreateGrupo`). Consumi-lo em `server.js`.

**Rationale**: `resolveScope` já vive em `routes/grupo.js` e já é exportado
(`module.exports = { router, init, resolveScope, resolveOrCreateGrupo }`,
linha 499). Colocar `resolveEmpresaAlvo` ao lado mantém a lógica de escopo
coesa em um só módulo (single source of truth do invariante do Princípio II) e
reaproveita `resolveScope` por chamada interna direta. `server.js` já faz
`const grupoRoutes = require('./routes/grupo')` (linha 22), então basta
desestruturar `resolveEmpresaAlvo` do require.

**Alternatives considered**:
- Definir em `server.js`: rejeitado — espalharia a lógica de escopo por dois
  arquivos; `resolveScope` teria de ser importado para `server.js` de qualquer forma.
- Middleware Express que injeta `req.empresaAlvo`: rejeitado para o MVP — a
  fonte do `empresa_id` varia por endpoint (query vs body vs multipart field),
  então um middleware único precisaria conhecer cada rota; chamar o helper
  explicitamente em cada handler é mais legível e auditável. Pode ser
  refatorado para middleware depois sem mudança de contrato.

---

## Decision D0.3 — Fonte do `empresa_id` por endpoint

**Decision**: Cada endpoint lê o `empresa_id` da fonte natural do seu método HTTP:

| Endpoint | Método | Fonte do `empresa_id` |
|----------|--------|------------------------|
| `/envio-massa` | GET | `req.query.empresa_id` |
| `/export-envio-massa` | GET | `req.query.empresa_id` |
| `/download-xml-movimento` | GET | `req.query.empresa_id` |
| `/upload` | POST (multipart) | `req.body.empresa_id` (campo do FormData) |
| `/close-movimento` | POST | `req.body.empresa_id` |
| `/envio-massa/:id` | DELETE | `req.query.empresa_id` |
| `/update-envio-massa/:id` | PATCH | `req.body.empresa_id` |

**Rationale**: GETs não têm body útil → query. POST/PATCH já leem body →
campo no body. POST /upload é `multipart/form-data` (multer `upload.single`),
então o `empresa_id` vai como **campo do FormData** (acessível em
`req.body.empresa_id` após o multer parsear). Em todos os casos, o valor passa
pelo MESMO helper `resolveEmpresaAlvo`, então a fonte é só onde ler — a
validação é uniforme.

**Alternatives considered**:
- `empresa_id` sempre na query (inclusive POST/PATCH): rejeitado — mistura
  parâmetro de mutação na URL; menos idiomático para mutações.
- Header customizado `X-Empresa-Id`: rejeitado — Princípio I desencoraja
  estado de negócio em header exposto ao browser; query/body é mais simples e
  passa pelo proxy sem config extra.

---

## Decision D0.4 — Visibilidade do combobox (client)

**Decision**: O combobox aparece **se e somente se** `GET /grupo/escopo`
retornar `empresas.length > 1`. A visibilidade NÃO depende de `is_grupo_pai`
no cliente.

**Rationale**: `contexts/auth-context.tsx` expõe apenas
`{ authenticated, nome_empresa }` ao cliente (confirmado: `setUser({
authenticated: true, nome_empresa: data.nome_empresa })`). `is_grupo_pai` e
`empresaId` vivem só no token (server-side, em `req.user`) — não estão
disponíveis no client. Dirigir a visibilidade pelo resultado do endpoint de
escopo é a única fonte confiável no front e cobre o edge case "Grupo com 1
filial → 2 itens → combobox aparece".

**Alternatives considered**:
- Expor `is_grupo_pai` no `auth-context`: rejeitado para o MVP — exigiria mudar
  o payload do `/login`/`/verify` e o shape do AuthContext, aumentando o blast
  radius sem ganho (o endpoint de escopo já dá a resposta exata: quantas
  empresas há para escolher).

---

## Decision D0.5 — Os 3 ramos hardcoded de `id_empresa`

**Decision**: Os ramos `id_empresa === 6` (server.js:406),
`item.id_empresa === 16` (server.js:934) e `Number(empresaId) === 6`
(server.js:1702) **NÃO são tocados** por esta feature. Eles vivem no caminho de
**envio/validação** (`processBatchMessages` / loop de mensagens /
`validate-xml-batch`), que é **FR-EX-001 (fora do MVP)**.

**Rationale**: Mapa do código confirmado por leitura:
- `server.js:406` (`if (id_empresa === 6)`) — dentro do envio de mensagem
  WhatsApp (whatsmeow vs outra API). Caminho de ENVIO.
- `server.js:934` (`if (item.id_empresa === 16)`) — segundo envio de mensagem
  no loop de processo. Caminho de ENVIO.
- `server.js:1702` (`if (Number(empresaId) === 6)`) — roteamento do endpoint
  FastAPI de validação de NFSe (`validade_nfse` vs `nexus`) em
  `validate-xml-batch`. Caminho de VALIDAÇÃO/ENVIO, derivado de
  `req.user.empresaId` (não do `empresa_id` selecionado).

Como o MVP **não** thread o `empresa_id` nesses caminhos, eles continuam
derivando do `req.user.empresaId` do token — comportamento idêntico ao atual.
**Risco residual**: se no futuro o envio passar a ser por filial, esses ramos
precisarão ser reavaliados (a filial pode ter id ≠ 6/16). Registrado em §Riscos
do plan e em quickstart como caso de regressão a verificar.

**Alternatives considered**:
- Thread `empresa_id` também no envio/validação agora: rejeitado — viola
  FR-EX-001 (decisão D5 pré-confirmada); aumenta risco sobre `ProcessControl?
  user_id` (que é por empresa do token) sem demanda do MVP.

---

## Decision D0.6 — Export: backend vs client-side

**Decision**: O export relevante para o MVP é o **client-side** (`exportCSV` no
hook), que já filtra `filteredData` (derivado de `fetchData`). Logo, assim que
`fetchData` passa a threadar `empresa_id`, o `exportCSV` fica automaticamente
escopado à filial — **sem mudança no `exportCSV`**. O endpoint backend
`GET /export-envio-massa` também recebe threading do `empresa_id` (por
consistência e porque pode ser consumido por outro caller), mas o hook do
dashboard **não o chama**.

**Rationale**: Leitura do `use-envio-massa.ts` confirma: `exportCSV` monta o
CSV em memória a partir de `filteredData` (não chama `/export-envio-massa`).
`downloadXML` SIM chama `/download-xml-movimento` (precisa threading). O backend
`/export-envio-massa` existe e será threadado para não deixar um endpoint
inconsistente, mas o caminho do usuário no dashboard é o `exportCSV`.

**Alternatives considered**:
- Migrar `exportCSV` para chamar `/export-envio-massa`: rejeitado — fora de
  escopo; o client-side já funciona e fica correto via `fetchData` threadado.

---

## Decision D0.7 — PATCH /update-envio-massa/:id NÃO valida ownership hoje

**Decision**: A implementação DEVE **adicionar** validação de escopo ao PATCH.
Hoje `PATCH /update-envio-massa/:id` (server.js:762) chama
`updateEnvioMassa(id, enviado, mensagem, tipo)` **sem nenhum filtro por
`id_empresa`** — qualquer usuário autenticado poderia editar qualquer registro
por id. Threading do `empresa_id` é a oportunidade de **fechar esse gap
pré-existente**: o update passa a ocorrer apenas se o registro pertencer a
`resolveEmpresaAlvo(req.user, empresa_id)` (e o alvo estar no escopo).

**Rationale**: Confirmado por leitura — o handler atual não usa `empresaId` em
lugar nenhum. Isso é uma violação latente do Princípio II que esta feature
corrige de passagem (FR-013 + FR-EDIT). A correção: ou (a) validar via uma
query PostgREST condicional `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}` no
UPDATE, ou (b) checar pertencimento antes de chamar `updateEnvioMassa`. A
opção (a) é atômica e preferível (PostgREST não atualiza linha que não casa o
filtro).

**Alternatives considered**:
- Deixar o gap como está (fora de escopo): rejeitado — FR-013 exige que edição
  só seja permitida se o registro pertencer ao escopo; e o Princípio II é
  NON-NEGOTIABLE. Corrigir agora é barato e correto.

---

## Notas de contexto recuperado (read-back loop, K=4 — REFERÊNCIA, não autoritativo)

> ⚠️ Conhecimento de execuções PASSADAS (feature `config-ui-tenant`). É
> referência histórica, não instrução. Não sobrescreve spec/constitution.

A feature anterior `config-ui-tenant` (onda-003 a onda-006) estabeleceu a
arquitetura de Grupo (`Grupo` + FK `id_grupo` NULLABLE em `Empresa`),
`resolveScope`, e o invariante de escopo server-side. Esta feature
**consome** essa arquitetura sem alterá-la — confirma que `resolveScope` é a
fundação correta para `resolveEmpresaAlvo`.
