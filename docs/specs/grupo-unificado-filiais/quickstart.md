# Quickstart & Cenários de Teste — Grupo Unificado de Filiais

**Feature**: `grupo-unificado-filiais`
**Data**: 2026-06-10

> Cenários de teste para E2E e validação manual. Todos os cenários com
> `empresa-pai` usam as credenciais da empresa Movee (id=6) já existentes.

---

## Módulo A — Comportamento por Grupo

### Cenário A1: Filial envia pelo canal whatsmeow

**Pré-condição**: Filial do grupo Movee cadastrada (ex: id=41, id_grupo=1).
Admin logado como empresa-pai (id=6). EmpresaSelector com filial selecionada.

1. Selecionar a filial no `EmpresaSelector`.
2. Disparar envio em massa (POST /start-process com `empresa_id=41`).
3. **Observar** no log do backend: `[mesmoGrupoQue] id=41 → true`.
4. **Expected**: envio roteado para `api.chatmasterveloz.com/…/sendTextPRO`
   (ramo 415 — whatsmeow), NÃO para template Meta.

**Regressão**: empresa standalone (ex: id=99, id_grupo=null) continua usando
template Meta. Checar que `mesmoGrupoQue(99, 6)` retorna `false`.

---

### Cenário A2: Upload sem data obrigatória para filial do grupo

**Pré-condição**: Filial do grupo Movee, planilha `.xlsx` sem colunas
`dt_inicial` / `dt_final`.

1. Upload da planilha com `empresa_id=<filial>`.
2. **Expected**: processamento sem erros de validação de data; campos
   `dt_inicial` / `dt_final` preenchidos automaticamente com `01/01/1982`.

**Regressão**: empresa standalone com planilha sem data → erro 400
"dt_inicial é obrigatório." (comportamento atual preservado).

---

### Cenário A3: Validação XML via API da Movee para filial do grupo

**Pré-condição**: Filial do grupo Movee, arquivo XML válido.

1. Upload de XML com `empresa_id=<filial>` (POST /validade-nfse).
2. **Expected**: backend chama `https://fastapihomologacao.todo-tips.com/validade_nfse`
   com `id_empresa=6` (API da Movee), NÃO `fastapihomologacaonexus…`.

---

## Módulo B — Edição de Filiais

### Cenário B1: Editar nome de filial (happy path)

**Pré-condição**: Admin logado (is_grupo_pai=true), filial id=41 existente.

1. Acessar `/dashboard/configuracoes/grupo`.
2. Clicar em "Editar" na filial `Filial SP`.
3. Alterar `nome_empresa` para `Filial SP Centro`.
4. Salvar.
5. **Expected**: 200 OK; nome atualizado na lista; sem re-criação de linha.

---

### Cenário B2: Email duplicado na edição

1. Tentar salvar filial com email já pertencente a outra empresa.
2. **Expected**: 400 "E-mail já cadastrado." — campo email destacado com erro.

---

### Cenário B3: Edição cross-grupo negada

**Pré-condição**: Token com id_grupo=1 (grupo Movee). Tentar editar empresa
id=99 que tem id_grupo=2 (outro grupo).

1. `PUT /grupo/empresas/99` com token do grupo 1.
2. **Expected**: 403 "Empresa não pertence ao grupo deste administrador."

---

### Cenário B4: Senha ignorada na edição

1. Enviar `PUT /grupo/empresas/:id` com campo `senha` no body.
2. **Expected**: 200 OK; campo `pass` da empresa NÃO alterado no banco.
   Verificar que o hash anterior permanece via query direta ao PostgREST.

---

## Módulo C — Login Único

### Cenário C1: Login de filial negado com 403

**Pré-condição**: Filial id=41 (id_grupo=1, não é pai).

1. `POST /login` com email/senha da filial.
2. **Expected**: HTTP 403, body `{"error":"Acesse o painel usando o login do grupo"}`.
3. Verificar: nenhum cookie `accessToken`/`refreshToken` setado.

---

### Cenário C2: Login da empresa-pai OK

**Pré-condição**: Empresa-pai id=6 (id_empresa_pai no Grupo).

1. `POST /login` com email/senha da empresa-pai.
2. **Expected**: HTTP 200, cookies httpOnly setados, token com
   `is_grupo_pai=true`, `id_grupo=1`.

---

### Cenário C3: Login de empresa standalone inalterado

**Pré-condição**: Empresa id=99 com `id_grupo=null`.

1. `POST /login` com credenciais da standalone.
2. **Expected**: 200 OK; token com `id_grupo=null`, `is_grupo_pai=false`.
   Comportamento idêntico ao atual.

---

### Cenário C4: Seletor lista empresa-pai + filiais após login do grupo

**Pré-condição**: Login da empresa-pai efetuado (token com is_grupo_pai=true).

1. `GET /grupo/escopo` (usado pelo EmpresaSelector).
2. **Expected**: `{ "empresas": [{ "id": 6, "nome_empresa": "Movee" }, { "id": 41, ... }], "default": 6 }`.

---

## Roundtrip End-to-End

### E2E-01: Fluxo completo filial → envio whatsmeow

1. `POST /login` com email/senha da empresa-pai (id=6) → 200, cookies setados.
2. `GET /grupo/escopo` → `{ empresas: [{id:6,...},{id:41,...}], default:6 }`.
3. Selecionar filial `id=41` no EmpresaSelector (frontend) → `empresa_id=41`
   threaded em todas as chamadas.
4. `POST /start-process` com `empresa_id=41` → 200.
5. Verificar log backend: ramo 415 com `id_empresa=41` → `mesmoGrupoQue(41,6)=true`
   → canal whatsmeow usado.
6. **Validação de shape**: a resposta de `GET /grupo/escopo` deve conter
   `empresas[].id` (inteiro) e `empresas[].nome_empresa` (string). Comparar
   contra contrato em `contracts/grupo-unificado-api.md`.

### E2E-02: Fluxo editar filial → persistência confirmada

1. Login empresa-pai → token.
2. `GET /grupo/filhos` → lista filiais.
3. `PUT /grupo/empresas/41` com `nome_empresa="Filial SP Editada"` → 200.
4. `GET /grupo/filhos` → verificar que `nome_empresa` da filial 41 é `"Filial SP Editada"`.
5. Comparar shape da resposta do `PUT` contra contrato declarado.
