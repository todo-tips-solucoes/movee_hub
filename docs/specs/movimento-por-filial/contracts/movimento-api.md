# Contract: Threading de `empresa_id` nos Endpoints de Movimento

**Feature**: `movimento-por-filial` · `app_homologacao/backend/server.js`

Todos os endpoints abaixo já existem e hoje são hard-scoped a
`req.user.empresaId`. A mudança é: substituir
`const empresaId = req.user.empresaId` por
`const idEmp = await resolveEmpresaAlvo(req.user, <fonte>)` (capturando 403) e
usar `idEmp` nas queries PostgREST. **Default sem `empresa_id` = comportamento
idêntico ao atual** (backward-compatible).

Convenção de borda: o parâmetro de cliente é **`empresa_id`** (snake_case) em
query, body e multipart field. Validação centralizada em `resolveEmpresaAlvo`
(ver `grupo-escopo-api.md`).

---

## 1. `GET /envio-massa` (server.js:276)

- **Fonte**: `req.query.empresa_id`.
- **Hoje**: `EnvioMassa?id_empresa=eq.${empresaId}&mov_fechado=eq.false`.
- **Depois**: `EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`.
- **403** se `empresa_id` ∉ escopo.

Request: `GET /api/envio-massa?empresa_id=17`
Response 200: array de registros da filial 17 (movimento aberto).

---

## 2. `GET /export-envio-massa` (server.js:1410)

- **Fonte**: `req.query.empresa_id`.
- **Hoje**: `EnvioMassa?id_empresa=eq.${empresaId}&mov_fechado=eq.false&select=...`.
- **Depois**: idem com `idEmp`.
- 404 mantido se 0 registros. **403** se fora do escopo.

Nota: o dashboard usa `exportCSV` client-side (não chama este endpoint), mas o
endpoint é threadado por consistência (D0.6).

---

## 3. `GET /download-xml-movimento` (server.js:1498)

- **Fonte**: `req.query.empresa_id`.
- **Hoje**: `EnvioMassa?id_empresa=eq.${empresaId}&mov_fechado=eq.false&select=...`.
- **Depois**: idem com `idEmp`. FR-010: download retorna apenas notas da
  empresa-alvo; tentativa de baixar de outra empresa é recusada (403 antes da query).

Request: `GET /api/download-xml-movimento?empresa_id=17`

---

## 4. `POST /upload` (server.js:1165)

- **Fonte**: `req.body.empresa_id` (**campo do multipart FormData**, após multer).
- **Hoje**: linhas inseridas com `id_empresa: empresaId` (server.js:1321).
- **Depois**: `id_empresa: idEmp` em cada linha inserida.
- O sanity check inicial (`if (!req.user || !req.user.empresaId)` → 401)
  permanece. A resolução do alvo ocorre após o check de auth e antes de montar
  as linhas. **403** se `empresa_id` ∉ escopo.

Request: `multipart/form-data` com campos `file` (xlsx) + `empresa_id=17`.
Efeito: registros gravados com `id_empresa=17`.

⚠️ Validação de entrada do arquivo (Princípio IV SHOULD) permanece inalterada —
xlsx inválido continua retornando 400.

---

## 5. `POST /close-movimento` (server.js:1770)

- **Fonte**: `req.body.empresa_id`.
- **Hoje**: `PATCH EnvioMassa?id_empresa=eq.${empresaId}&mov_fechado=eq.false`
  com `{ mov_fechado: true }`.
- **Depois**: idem com `idEmp`. FR-011: fecha apenas o movimento aberto da
  empresa-alvo. **403** se fora do escopo.

Request: `POST /api/close-movimento` body `{ "empresa_id": 17 }`.

---

## 6. `DELETE /envio-massa/:id` (server.js:776)

- **Fonte**: `req.query.empresa_id`.
- **Hoje**: `DELETE EnvioMassa?id=eq.${id}&id_empresa=eq.${empresaId}` (já
  escopa por empresa do token).
- **Depois**: `DELETE EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`.
- FR-012: deleção permitida apenas se o registro pertencer a empresa do escopo.
  A query condicional `id_empresa=eq.${idEmp}` garante que um `id` de outra
  empresa simplesmente não casa (0 linhas deletadas) — e `idEmp` já é validado
  no escopo. **403** se `empresa_id` ∉ escopo.

Request: `DELETE /api/envio-massa/42?empresa_id=17`.

---

## 7. `PATCH /update-envio-massa/:id` (server.js:762)

- **Fonte**: `req.body.empresa_id`.
- **Hoje**: chama `updateEnvioMassa(id, enviado, mensagem, tipo)` **sem filtro
  por `id_empresa`** — gap de segurança pré-existente (qualquer autenticado
  edita qualquer id).
- **Depois (corrige o gap — FR-013, Princípio II)**: validar pertencimento.
  Abordagem recomendada (atômica): o UPDATE deve incluir o filtro de empresa,
  i.e. atualizar via `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}` (PostgREST
  não toca linha que não casa o filtro). Se `updateEnvioMassa` não aceitar
  filtro de empresa, ou (a) refatorar a função para receber `idEmp` e adicioná-lo
  ao filtro PostgREST, ou (b) pré-checar existência
  (`EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}&select=id`) antes do update e
  retornar 404/403 se vazio.
- **403** se `empresa_id` ∉ escopo.

Request: `PATCH /api/update-envio-massa/42` body
`{ "enviado": true, "mensagem": "...", "tipo": "...", "empresa_id": 17 }`.

---

## Contrato dos 403 (centralizado)

Todos os 403 originam do `resolveEmpresaAlvo` (helper único). Shape uniforme:

```json
{ "error": "empresa fora do escopo" }
```

(ou `"empresa_id inválido"` para não-numérico). Status **403**. Sem stack
trace, sem dados da empresa-alvo (edge case "forjar empresa_id"). O cliente que
NÃO envia `empresa_id` nunca vê 403 (default = própria empresa).

## Fora do MVP (FR-EX-001) — NÃO threadar

Estes caminhos continuam derivando de `req.user.empresaId` (envio/validação):

- Loop de envio de mensagens / `processBatchMessages` (server.js ~879+).
- Ramos hardcoded `id_empresa === 6` (server.js:406), `item.id_empresa === 16`
  (server.js:934), `Number(empresaId) === 6` (server.js:1702).
- `validate-xml-batch` (server.js ~1671) e `ProcessControl?user_id=eq.${empresaId}`.

⚠️ Regressão a verificar (quickstart): confirmar que esses ramos seguem
corretos para a empresa do token quando o usuário troca a filial no dashboard
(o envio NÃO deve passar a usar a filial selecionada no MVP).
