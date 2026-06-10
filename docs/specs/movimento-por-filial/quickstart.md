# Quickstart / Test Scenarios: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial` · **Phase 1** · 2026-06-10

Cenários de validação cobrindo: helper de escopo (backend), endpoint de escopo,
threading por endpoint, frontend (combobox + URL), edge cases e o **roundtrip
E2E** obrigatório (borda backend↔frontend).

Pré-requisitos: backend + frontend_v2 rodando em homologação; um usuário
**admin de grupo** (`is_grupo_pai=true`) com ≥1 filial e um usuário **filho**
(`is_grupo_pai=false`).

---

## Backend — `resolveEmpresaAlvo` / endpoints

### TS-BE-1 — Default sem `empresa_id` (backward-compatible)
1. Como admin do grupo, `GET /api/envio-massa` (sem `empresa_id`).
2. **Expected**: 200; retorna o movimento aberto da **própria empresa** do
   token (idêntico ao comportamento pré-feature). Nenhuma regressão (SC-004).

### TS-BE-2 — `empresa_id` de filial dentro do escopo
1. Como admin, `GET /api/envio-massa?empresa_id=<id_filial_do_grupo>`.
2. **Expected**: 200; retorna apenas registros com `id_empresa = id_filial`.

### TS-BE-3 — `empresa_id` fora do escopo → 403
1. Como admin, `GET /api/envio-massa?empresa_id=<id_de_outro_grupo>`.
2. **Expected**: **403** `{ "error": "empresa fora do escopo" }`. Nenhum dado
   da empresa-alvo exposto (SC-003, edge "forjar empresa_id").

### TS-BE-4 — `empresa_id` não-numérico → 403
1. `GET /api/envio-massa?empresa_id=abc` e `?empresa_id=1 OR 1=1`.
2. **Expected**: **403** `{ "error": "empresa_id inválido" }`. Sem 500, sem
   injeção PostgREST (parseInt + Number.isInteger).

### TS-BE-5 — Filho não expande escopo
1. Como usuário **filho** (`is_grupo_pai=false`), `GET /api/envio-massa?empresa_id=<id_do_pai>`.
2. **Expected**: **403** — `resolveScope` do filho é `[empresaId]`; o id do pai
   não está no escopo.

### TS-BE-6 — Upload grava na filial-alvo
1. Como admin, `POST /api/upload` multipart com `file=<xlsx válido>` +
   `empresa_id=<id_filial>`.
2. **Expected**: 200; registros criados com `id_empresa = id_filial` e
   `mov_fechado=false`. Verificar via `GET /api/envio-massa?empresa_id=<id_filial>`.

### TS-BE-7 — Upload fora do escopo → 403, nada gravado
1. `POST /api/upload` com `empresa_id=<id_de_outro_grupo>`.
2. **Expected**: **403**; **0 registros** criados (SC-003).

### TS-BE-8 — Close-movimento por filial
1. Com movimento aberto na filial X, `POST /api/close-movimento` body
   `{ "empresa_id": X }`.
2. **Expected**: 200; apenas os registros abertos da filial X passam a
   `mov_fechado=true`. Registros de outras empresas inalterados (FR-011).

### TS-BE-9 — Delete por filial (registro de outra empresa não é deletado)
1. `DELETE /api/envio-massa/<id_de_registro_da_filial_Y>?empresa_id=X` (X≠Y, ambos no escopo).
2. **Expected**: o registro de Y **não** é deletado (filtro
   `id=eq.<id>&id_empresa=eq.X` não casa). FR-012.

### TS-BE-10 — PATCH update fecha o gap pré-existente
1. `PATCH /api/update-envio-massa/<id_registro_filial_X>` body
   `{ ..., "empresa_id": X }`.
2. **Expected**: atualiza somente se o registro pertence a X. Tentar atualizar
   um `id` de empresa fora do escopo → **403**; um `id` de outra filial do
   escopo com `empresa_id` divergente → não atualiza (filtro não casa). FR-013.

### TS-BE-11 — `GET /grupo/escopo` (pai)
1. Como admin, `GET /api/grupo/escopo`.
2. **Expected**: 200 `{ empresas: [{id,nome_empresa}...], default: <empresaId> }`
   com o pai primeiro + todas as filiais; `default = própria empresa`.
   Nenhuma empresa de outro grupo (SC-006).

### TS-BE-12 — `GET /grupo/escopo` (filho ou empresa sem filial)
1. Como filho OU empresa sem grupo, `GET /api/grupo/escopo`.
2. **Expected**: 200 com **1 item** (a própria empresa). O front oculta o
   combobox (SC-004).

### TS-BE-13 — `GET /grupo/escopo` sem auth
1. `GET /api/grupo/escopo` sem cookie.
2. **Expected**: 401.

---

## Frontend — combobox + URL

### TS-FE-1 — Combobox visível para grupo (≥2 empresas)
1. Logar como admin de grupo; abrir `/dashboard`.
2. **Expected**: combobox "Filial" no header; pré-seleciona a própria empresa
   (FR-003). Lista pai + filiais.

### TS-FE-2 — Combobox oculto para empresa única
1. Logar como empresa sem filiais; abrir `/dashboard`.
2. **Expected**: nenhum combobox; interface idêntica à anterior (SC-004, FR-002).

### TS-FE-3 — Trocar filial recarrega + persiste na URL
1. No combobox, escolher uma filial.
2. **Expected**: URL vira `?empresa_id=<id>`; a listagem recarrega
   automaticamente (<3s, SC-002) sem confirmação (FR-005); o movimento exibido
   é o da filial.

### TS-FE-4 — Busca dentro do combobox
1. Abrir o combobox; digitar parte de um nome.
2. **Expected**: filtra por nome (FR-006), viável com dezenas de empresas.

### TS-FE-5 — Link compartilhado com `?empresa_id=N`
1. Outro usuário do mesmo grupo abre o link `/dashboard?empresa_id=N`.
2. **Expected**: exibe os dados da filial N sem reselecionar (SC-005, FR-004).

### TS-FE-6 — `empresa_id` inválido na URL
1. Abrir `/dashboard?empresa_id=<id_fora_do_grupo>`.
2. **Expected**: o backend recusa (403) e o front degrada para a empresa-pai
   (default), **sem expor erro técnico** (edge "filial que saiu do grupo").

---

## Roundtrip End-to-End (OBRIGATÓRIO — borda backend↔frontend)

### TS-RT-1 — Roundtrip real de `GET /grupo/escopo` e `GET /envio-massa`
1. Com o stack de homologação no ar, autenticar como admin de grupo (cookie real).
2. Fazer uma chamada **real** (não mock) a `GET /api/grupo/escopo`; capturar o
   payload JSON de resposta.
3. **Expected (shape)**: `{ empresas: Array<{ id: number, nome_empresa: string }>,
   default: number }` — campos em **snake_case** (`nome_empresa`), exatamente
   como declarado em `contracts/grupo-escopo-api.md`. Confirmar que o front
   consome `empresa.id` e `empresa.nome_empresa` sem mapper camelCase.
4. Selecionar uma filial; fazer chamada **real** a
   `GET /api/envio-massa?empresa_id=<id>`; capturar o payload.
5. **Expected (shape)**: array de registros cujo `id_empresa` (snake_case) ===
   `<id>` selecionado. Validar que o front lê `id_empresa`/`mov_fechado`
   diretamente do JSON do backend (sem renomear).

**Razão (lição das 40 ondas)**: testar contra o **payload real do backend**
(não fixture/mock) expõe qualquer drift snake_case↔camelCase antes de acumular.
A convenção desta feature é snake_case em ambos os lados do parâmetro
(`empresa_id`/`id_empresa`/`nome_empresa`) — o roundtrip confirma empiricamente.

---

## Regressão — caminhos fora do MVP (FR-EX-001)

### TS-REG-1 — Envio continua na empresa do token
1. Com uma filial selecionada no dashboard, exercer um fluxo de
   envio/validação (se aplicável no ambiente).
2. **Expected**: o envio/`validate-xml-batch`/`ProcessControl` opera sobre
   `req.user.empresaId` (empresa do token), **não** sobre a filial selecionada.
   Os ramos `id_empresa===6/16` e `Number(empresaId)===6` continuam corretos
   para a empresa do token (D0.5).

### TS-REG-2 — Build do frontend limpo
1. `cd app_homologacao/frontend_v2 && npm run build`.
2. **Expected**: build/tsc limpo após adicionar `cmdk`, `@radix-ui/react-popover`,
   `command.tsx`, `popover.tsx`, `empresa-selector.tsx` e o threading.
