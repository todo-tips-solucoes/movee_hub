# Contracts: Motorista canônico + busca de entregador

Endpoints **aditivos** ao backend do hub (`app_homologacao/backend/routes/`). Todos
com **Auth por cookie `accessToken`** (padrão do hub) e escopo por `id_empresa` via
`resolverContextoEntidade`. Base path do hub: `/api/v1`. 404-fora-do-escopo é o padrão
(Decision 11 do S5): recurso de outra empresa responde 404, nunca 403 que vaze
existência. Toda ação de escrita chama `registrarAuditoria` (quem + quando — FR-021).

---

## WS-B: Busca de entregador por nome

### GET /api/v1/faturamento/entregadores

**Auth**: cookie `accessToken`. **Permission**: `faturamento.listar`.

#### Request (query params)

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| busca | string | yes | `termoBuscaValido` — mínimo 3 caracteres após trim |

#### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| items | array | até **20** itens `{ id, nome }` da empresa do usuário, `ILIKE hub_normaliza_nome(nome)` |
| items[].id | int | id do `Entregador` (enviado como `entregadorId` no filtro) |
| items[].nome | string | nome exibido no combobox |

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 422/400 | busca_invalida | termo < 3 caracteres (FR-006) — front nem chama (bloqueia <3) |
| 401 | nao_autenticado | sem cookie válido |
| 403 | sem_permissao | sem `faturamento.listar` |

> Front degrada para o input numérico atual em 5xx/indisponibilidade (FR-010, D-B1).

### GET /api/v1/performance/entregadores

Idêntico ao de faturamento, com **Permission** `performance.listar`. Espelho exigido
por FR-006 (comportamento igual nas duas telas).

---

## WS-C: Motorista canônico — cadastro

### POST /api/v1/motoristas

**Auth**: cookie `accessToken`. **Permission**: `motoristas.editar`.

#### Request (JSON body)

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| nome | string | yes | não vazio |
| idExterno | uuid | **yes** | `uuidValido` (formato uuid) — **sempre obrigatório** (FR-012, D-C6) |

#### Response (201)

| Field | Type | Description |
|-------|------|-------------|
| id | int | id do `Entregador` criado |
| idExterno | uuid | o uuid informado (visível/copiável — FR-016) |
| nome | string | |
| ativo | boolean | default true |

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 422/400 | uuid_invalido | `idExterno` em formato inválido (FR-013) |
| 409 | uuid_duplicado | `idExterno` já pertence a outro motorista da mesma empresa — mapeamento amigável da violação de `UNIQUE (id_empresa, id_externo)` (FR-013) |
| 403 | sem_permissao | sem `motoristas.editar` |

### PATCH /api/v1/motoristas/:id (EXISTENTE — inalterado)

Edita `nome`/`ativo` via `validarPatchMotorista` (allowlist estrita). Situação do
motorista independente da credencial (FR-015). Já auditado.

---

## WS-C: Motorista canônico — credencial de acesso

Todas com **Permission**: `motoristas.credencial` (nova — permissão #2 do clarify Q1).
Escopo por empresa; auditadas (FR-021).

### POST /api/v1/motoristas/:id/credencial

Cria a credencial de acesso (conta + senha inicial, ou vincula conta existente).

#### Request (JSON body)

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| cnpj_prestador | string | yes (se criar) | identificação de login do app |
| senha_inicial | string | condicional | bcrypt no servidor; ou emite token de definição de senha (espelha o legado) |

#### Response (201) — `{ id, cnpj_prestador, ativo: true }` (nunca retorna `senha`).

| Status | Code | Description |
|--------|------|-------------|
| 409 | credencial_existente | motorista já tem credencial vinculada |
| 403 | sem_permissao | sem `motoristas.credencial` (FR-020) |

### POST /api/v1/motoristas/:id/credencial/reset-senha

Redefine a senha; **invalida a senha anterior imediatamente** (FR-019).

- Response (200): `{ ok: true }` (ou token de definição). Auditado.

### PATCH /api/v1/motoristas/:id/credencial

Ativa/desativa a credencial (`ContaMotorista.ativo`) — ação **independente** da
situação do motorista (FR-015/FR-018).

| Field | Type | Required |
|-------|------|----------|
| ativo | boolean | yes |

- Response (200): `{ id, ativo }`. Auditado. Motorista com credencial desativada tem
  o acesso ao app negado antes de qualquer atividade (edge case).

---

## WS-C: Detalhe do motorista — histórico de atividades (read-only)

### GET /api/v1/motoristas/:id (EXISTENTE — enriquecido)

**Permission**: `motoristas.consultar` (leitura; NÃO exige as permissões de escrita —
FR-020/FR-022). `mapMotoristaDetalhe` passa a expor `idExterno` (uuid) e uma seção
`atividades` correlacionada por uuid.

#### Response (200) — campos adicionados

| Field | Type | Description |
|-------|------|-------------|
| idExterno | uuid | uuid canônico, visível/copiável (FR-016) |
| atividades | array | itens `{ tipo, data, ... }` ordenados **desc** por data (mais recente primeiro), read-only (FR-022) |
| atividades[].tipo | enum | `faturamento` \| `performance` \| `validacao_nf` |

- Sem limite fixo de período/quantidade; **paginação técnica** por
  cursor/`?offset=&limit=` (clarify Q5) — parâmetros de paginação são de leitura,
  não alteram permissão.
- Motorista sem atividades → `atividades: []` (estado vazio claro, sem erro).

---

## WS-C: App motorista (homolog) — uuid no token (aditivo, inerte em produção)

### POST /login (app motorista, `routes/motorista.js`) — enriquecido, condicional a ambiente

- Ao autenticar (cnpj → `ContaMotorista` → `Entregador` vinculado), o token passa a
  carregar `entregador_uuid` (FR-022A).
- Gravações de atividade registram `entregador_uuid` junto às chaves atuais (coluna
  aditiva `entregador_uuid uuid NULL`).
- **Inércia em produção**: todo o comportamento novo fica atrás de condição de
  ambiente (mesmo espírito do `lib/envio-gate.js`). Sem env nova definida (produção),
  o login e a gravação permanecem **byte-a-byte idênticos** ao atual (FR-023/SC-007).
