# Plano de Implementação — Grupo Unificado de Filiais

**Feature**: `grupo-unificado-filiais`
**Data**: 2026-06-10
**Version**: 1.0.0
**Branch**: `feat/grupo-unificado-filiais`

---

## Summary

Unificar o comportamento do grupo Movee em três frentes, sem DDL e sem breaking
change para empresas standalone:

- **A (comportamento por grupo)**: substituir `id_empresa === 6` por
  `mesmoGrupoQue(id_empresa, 6, cache)` em 4 ramos de `server.js`
  (415, 938, 1314, 1762). O ramo 973 (`id_empresa === 16`) fica intocado.
- **B (editar filiais)**: adicionar `PUT /grupo/empresas/:id` em `routes/grupo.js`
  espelhando o `POST` existente; tela de edição inline na página
  `/dashboard/configuracoes/grupo`.
- **C (login único)**: inserir guarda no `POST /login` (`server.js:142`) que rejeita
  filiais (empresa com `id_grupo` setado e que não é pai) com HTTP 403.

Reuso total de: `resolveScope`, `resolveEmpresaAlvo`, `GET /grupo/escopo`,
`EmpresaSelector`, threading de `empresa_id` (feature `movimento-por-filial`).

---

## Constitution Check

*Gate executado antes do Phase 0. Re-checado após Phase 1.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| I. Segurança de Autenticação & Segredos | PASS | JWT httpOnly preservado; bloqueio 403 é server-side; sem tokens em query/localStorage |
| II. Isolamento Multi-Tenant | PASS | `mesmoGrupoQue` usa token como fonte; `id_grupo` nunca do body; cross-group negado no PUT |
| III. Contratos de API & Proxy de Cookies | PASS | Frontend usa `/api/*`; novo `PUT /grupo/empresas/:id` segue mesmo padrão |
| IV. Qualidade e Revisão de Mudanças | PASS | Branch dedicada; auth + envio + XML → owasp-security obrigatório |
| V. Deploy Conteinerizado | PASS | Sem DDL; mudanças são lógica de app; deploy aditivo |

---

## Technical Context

| Item | Valor |
|------|-------|
| Runtime | Node.js (Express) — Node 14 |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind 4, shadcn/ui |
| Banco | PostgreSQL via PostgREST (REST sobre tabelas) |
| Auth | JWT httpOnly (`accessToken` 15 min, `refreshToken` 7 dias) |
| Deploy | Docker + Traefik (homologação: `app_homologacao/docker-compose.yml`) |
| Branch base | `feat/movimento-por-filial` (ou `main` pós-merge) |
| DDL necessário | **Nenhum** (CL-003 — RESOLVIDO) |
| Scripts SQL | Nenhum novo (`001`..`006` já aplicados) |
| Testes existentes | `app_homologacao/backend/tests/` |

---

## Convencoes de Borda

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| DB columns (PostgreSQL via PostgREST) | snake_case | PostgREST schema | Tabelas `Empresa`, `Grupo` |
| Backend JS (Express) | camelCase (`empresaId`, `idGrupo`) / snake_case nos payloads PostgREST | manual | `server.js`, `routes/grupo.js` |
| Frontend TS | camelCase | TypeScript | `types/index.ts`, `components/empresa-selector.tsx` |
| API payload (request/response) | snake_case nos campos de dados (`nome_empresa`, `id_grupo`) | manual no backend | `contracts/grupo-unificado-api.md` |
| URL path params | kebab-case implícito | Express router | `routes/grupo.js` |

**Mapper layer**: não há ORM. O backend lê snake_case do PostgREST e escreve
camelCase no payload JS internamente. `empresaId` no token e `id_empresa` nos
payloads de dados são o mesmo campo em convenções diferentes — manter consistência
com o padrão existente de cada contexto.

---

## Project Structure

### Documentação (feature dir)
```
docs/specs/grupo-unificado-filiais/
├── spec.md              ← ATUALIZADO (clarify finalizado)
├── plan.md              ← ESTE ARQUIVO
├── research.md          ← Decisões técnicas
├── data-model.md        ← Entidades e helpers
├── quickstart.md        ← Cenários de teste E2E
└── contracts/
    └── grupo-unificado-api.md  ← Contrato PUT + helper mesmoGrupoQue
```

### Código (source tree relevante)
```
app_homologacao/
├── backend/
│   ├── server.js          ← MODIFICAR: ramos 415/938/1314/1762 (A) + login (C)
│   └── routes/
│       └── grupo.js       ← MODIFICAR: helper mesmoGrupoQue (A) + PUT /grupo/empresas/:id (B)
└── frontend_v2/
    ├── app/dashboard/configuracoes/grupo/
    │   └── page.tsx       ← MODIFICAR: adicionar edição inline de filial (B)
    └── components/
        └── empresa-selector.tsx  ← NÃO MODIFICAR (reuso)
```

---

## Plano de Implementação por Módulo

### Módulo A — Comportamento por Grupo

#### A.1 Helper `mesmoGrupoQue` em `routes/grupo.js`

Adicionar após `resolveEmpresaAlvo` (exportar junto):

```javascript
// Helper: mesmoGrupoQue(idEmpresa, idReferencia, cache)
//
// Verifica se idEmpresa pertence ao mesmo grupo que idReferencia.
// cache = { ids: Set<number> | null } — compartilhado por ciclo de operação.
// Máximo 2 queries PostgREST por ciclo (FR-005).
// Fail-safe: retorna false em caso de erro (backward-compat, FR-006).
async function mesmoGrupoQue(idEmpresa, idReferencia, cache = {}) {
  // Inicializar cache na primeira chamada do ciclo
  if (!cache.ids) {
    try {
      // 1. Buscar o grupo da empresa de referência
      const grupoRef = await _postgrestRequest(
        `Grupo?id_empresa_pai=eq.${parseInt(idReferencia, 10)}&select=id`,
        'GET'
      );
      if (!grupoRef || grupoRef.length === 0) {
        // idReferencia não é pai de nenhum grupo
        cache.ids = new Set([Number(idReferencia)]);
      } else {
        const idGrupoRef = grupoRef[0].id;
        // 2. Buscar todos os membros do grupo (inclui o pai via id_grupo)
        const membros = await _postgrestRequest(
          `Empresa?id_grupo=eq.${parseInt(idGrupoRef, 10)}&select=id`,
          'GET'
        );
        const idsMembros = (membros || []).map(m => Number(m.id));
        cache.ids = new Set([Number(idReferencia), ...idsMembros]);
      }
    } catch (err) {
      console.error('[mesmoGrupoQue] erro ao buscar grupo:', err.message);
      // Fail-safe: apenas idReferencia no conjunto
      cache.ids = new Set([Number(idReferencia)]);
    }
  }
  return cache.ids.has(Number(idEmpresa));
}
```

Adicionar ao `module.exports` ao final do arquivo:

```javascript
module.exports.router = router;
module.exports.init = init;
module.exports.resolveScope = resolveScope;
module.exports.resolveEmpresaAlvo = resolveEmpresaAlvo;
module.exports.mesmoGrupoQue = mesmoGrupoQue;  // NOVO
```

#### A.2 Importar no `server.js`

```javascript
// Linha ~23 (após a importação existente):
const { resolveEmpresaAlvo, mesmoGrupoQue } = grupoRoutes;
```

#### A.3 Substituições nos ramos

**Ramo 415** (`if (id_empresa === 6)`):

```javascript
// ANTES (server.js:415):
if (id_empresa === 6) {

// DEPOIS:
const _grupoCache415 = {};  // cache de ciclo (declarado no escopo da função de envio)
if (await mesmoGrupoQue(id_empresa, 6, _grupoCache415)) {
```

> **Nota**: `_grupoCache415` deve ser declarado no início da função de envio em lote
> (antes do loop), não dentro do loop. O mesmo objeto `cache` é passado em cada
> iteração para que seja preenchido apenas na 1ª chamada.

**Ramo 938** (`if (item.id_empresa !== 6)` — "NÃO-Movee" usa template Meta):

```javascript
// ANTES (server.js:938):
if (item.id_empresa !== 6) {

// DEPOIS (reusar o mesmo _grupoCache do ciclo):
if (!(await mesmoGrupoQue(item.id_empresa, 6, _grupoCache415))) {
```

> O nome `_grupoCache415` pode ser renomeado para `_grupoCache` para clareza no
> escopo do ciclo — um único objeto compartilhado pelos ramos 415 e 938.

**Ramo 1314** (`if(empresaId !== 6)`):

```javascript
// ANTES (server.js:1314):
if(empresaId !== 6){

// DEPOIS:
const _grupoCacheUpload = {};
if (!(await mesmoGrupoQue(empresaId, 6, _grupoCacheUpload))) {
```

> Este ramo está no processamento de upload (por request, não loop de itens), então
> um cache por request é suficiente — mas mantemos o mesmo padrão de cache por
> consistência.

**Ramo 1762** (`if (Number(empresaId) === 6)`):

```javascript
// ANTES (server.js:1762):
if (Number(empresaId) === 6) {

// DEPOIS:
const _grupoCacheXml = {};
if (await mesmoGrupoQue(Number(empresaId), 6, _grupoCacheXml)) {
```

**Ramo 973 — NÃO MODIFICAR**:
```javascript
// server.js:973 — FICA COMO ESTÁ (FR-007)
if (item.id_empresa === 16) {
```

---

### Módulo B — Edição de Filiais

#### B.1 `PUT /grupo/empresas/:id` em `routes/grupo.js`

Adicionar após `router.post('/empresas', ...)` (aprox. linha 440):

```
router.put('/empresas/:id', requireGrupoPai, async (req, res) => {
  // 1. Validar :id (inteiro positivo)
  // 2. Verificar que a filial existe
  // 3. Verificar que filial.id_grupo === token.id_grupo (cross-group negado)
  // 4. Verificar que filial.id !== token.empresaId (pai não edita a si mesmo por esta rota)
  // 5. Validar campos obrigatórios (nome_empresa, email, cnpj)
  // 6. Checar unicidade de email excluindo :id → Empresa?email=eq.X&id=neq.:id
  // 7. Checar unicidade de cnpj excluindo :id → Empresa?cnpj=eq.X&id=neq.:id
  // 8. Montar payload SEM pass (FR-B)
  // 9. PATCH via PostgREST: Empresa?id=eq.:id com payload
  //    (PostgREST PATCH atualiza campos fornecidos — comportamento upsert-like)
  //    Usar Header: Prefer: return=representation para obter a linha atualizada
  // 10. Retornar 200 { id, nome_empresa, email, id_grupo }
})
```

> Ver `contracts/grupo-unificado-api.md` para responses exatas.

#### B.2 Tela de edição em `frontend_v2/app/dashboard/configuracoes/grupo/page.tsx`

**Estratégia**: painel inline colapsável por filial (dec-005 — sem nova rota).

- Adicionar campo `cnpj` à interface `EmpresaFilha` (retornado pelo `GET /grupo/filhos`).
- Adicionar estado de edição: `editandoId: number | null`, `editForm: FormFields`.
- Quando admin clica em "Editar" numa filial: preencher `editForm` com dados atuais e expandir o painel.
- Formulário inline com os mesmos campos do cadastro (sem campo `senha` — FR-B).
- `PUT /api/grupo/empresas/:id` ao salvar.
- Ao salvar com sucesso: colapsar painel, atualizar lista via `carregarFilhos()`.
- Tratar erros 400/403/404/409 com mensagens inline.

**Nota de UX**: o botão "Editar" substitui o visual do item na lista por um formulário
expansível (acordeão). Um item de cada vez pode estar em edição (fechar o anterior ao
abrir um novo).

---

### Módulo C — Login Único

#### C.1 Guarda no `POST /login` (`server.js:142`)

Inserir **após** `const user = users[0]` e **antes** de `bcrypt.compare`:

```javascript
// grupo-unificado-filiais (módulo C): negar login de filial
// Bloqueio ANTES do bcrypt.compare (evita timing oracle)
if (user.id_grupo) {
  const ehPaiCheck = await postgrestRequest(
    `Grupo?id_empresa_pai=eq.${user.id}&select=id`
  );
  const ehPai = ehPaiCheck && ehPaiCheck.length > 0;
  if (!ehPai) {
    return res.status(403).json({
      error: 'Acesse o painel usando o login do grupo'
    });
  }
}
```

#### C.2 `POST /grupo/empresas` — senha opcional (FR-B)

Em `routes/grupo.js:293`, remover a validação obrigatória de senha e não incluir
`pass` no payload quando `senha` não for fornecida:

```javascript
// ANTES (linhas ~320-328):
if (!senha || typeof senha !== 'string') {
  return res.status(400).json({ error: 'Campo obrigatório ausente: senha.' });
}
if (senha.length < 6 || !/[A-Z]/.test(senha) || !/\d/.test(senha)) {
  return res.status(400).json({ ... });
}
// ...
const hashedPass = await _bcrypt.hash(senha, 10);
payload.pass = hashedPass;

// DEPOIS:
// senha é OPCIONAL para filiais — se fornecida e válida, hashear; se ausente, não gravar
if (senha && typeof senha === 'string') {
  if (senha.length < 6 || !/[A-Z]/.test(senha) || !/\d/.test(senha)) {
    return res.status(400).json({
      error: 'Senha fraca: mínimo 6 caracteres, 1 letra maiúscula e 1 dígito.',
    });
  }
  const hashedPass = await _bcrypt.hash(senha, 10);
  payload.pass = hashedPass;
  // Se senha não fornecida: pass não incluído no payload (null no banco)
}
```

Frontend (`page.tsx`): remover campo `senha` e validações associadas do formulário
de cadastro de filial (campo `senha`, `showSenha`, `isPasswordValid`, `PasswordStrength`,
`refSenha` e mensagens de erro de senha).

---

## Test Scenarios

| ID | Módulo | Cenário | Expected |
|----|--------|---------|---------|
| TA-1 | A | Filial do grupo envia via whatsmeow | Ramo 415: canal whatsmeow |
| TA-2 | A | Filial do grupo pula template Meta | Ramo 938: template Meta não enviado |
| TA-3 | A | Filial do grupo faz upload sem data | Ramo 1314: datas auto-preenchidas |
| TA-4 | A | Filial do grupo valida XML via Movee | Ramo 1762: fastapihomologacao usado |
| TA-5 | A | Empresa standalone preservada | Todos os ramos: comportamento atual |
| TA-6 | A | Empresa id=16 preservada | Ramo 973: inalterado |
| TB-1 | B | Editar nome de filial | 200 OK, nome atualizado |
| TB-2 | B | Email duplicado na edição | 400 "E-mail já cadastrado." |
| TB-3 | B | CNPJ duplicado na edição | 409 "CNPJ já cadastrado." |
| TB-4 | B | Cross-group negado | 403 "Empresa não pertence ao grupo..." |
| TB-5 | B | Senha ignorada no PUT | pass não alterado no banco |
| TB-6 | B | Formulário pré-preenchido | Dados atuais exibidos ao abrir edição |
| TC-1 | C | Login de filial negado | 403 + mensagem em PT |
| TC-2 | C | Login da empresa-pai OK | 200, is_grupo_pai=true no token |
| TC-3 | C | Empresa standalone inalterada | 200, comportamento atual |
| TC-4 | C | Seletor lista pai + filiais | GET /grupo/escopo → array correto |
| TE-1 | E2E | Filial envia whatsmeow end-to-end | Fluxo completo (quickstart E2E-01) |
| TE-2 | E2E | Editar filial end-to-end | Fluxo completo (quickstart E2E-02) |

---

## Complexity Tracking

Nenhuma violação de constitution detectada. Nenhuma justificativa de exceção necessária.

**Pontos de atenção operacional**:
1. **Breaking change (módulo C)**: filiais com login existente terão seu login bloqueado
   após o deploy. O operador confirma que é intencional (CL-002=A) e coordena a
   comunicação com usuários de filiais antes do deploy.
2. **Timing do deploy**: A, B e C podem ser deployados juntos (sem dependência de DDL).
   Recomendado: deploy único para evitar estado inconsistente (filial com login ainda
   aberto enquanto A já está ativo).
3. **Ramo 973**: verificado e confirmado que NÃO deve ser alterado (FR-007).
4. **Cache `mesmoGrupoQue`**: o objeto de cache deve ser criado no escopo da função de
   processamento em lote (fora do loop), não dentro. Criar dentro do loop invalida o
   cache a cada item — bug de performance.
