# Contracts: Hub — módulo Avisos

**[PROPOSTA — a validar na implementação]**: os endpoints abaixo são **novos**. O que é
afirmado como já existente cita `arquivo:linha`.

## Convenções

- **Montagem**: `app.use('/api/v1/avisos', hubAvisosRouter)` em `app_homologacao/backend/server.js`,
  no padrão de `/api/v1/usuarios` e `/api/v1/papeis` (`server.js:2870,2875`).
- **Acesso pelo navegador**: `FV2` chama via proxy `/api/v1/...` (`lib/hub/api.ts:18`), com o
  wrapper `criarRequest` (`lib/hub/api.ts:74-96`).
- **Autenticação**: cookie `hub_accessToken` (`lib/hub-access-token.js:26-50`).
- **Cadeia de guarda** (research Decision 7), por rota:
  1. `requireModuloAtivo('avisos')` → `401 NAO_AUTENTICADO` sem sessão
     (`middleware/hub-require-modulo.js:26-28`); `403 MODULO_DESABILITADO` sem entidade
     ativa ou com o módulo desligado (`:30-40`)
  2. `requirePermission('<permissão da rota>')` → `403 PERMISSAO_NEGADA`
  3. permissão reconferida na entidade ativa do token → `403 PERMISSAO_NEGADA`
  4. `await mesmoGrupoQue(entidadeAtiva, 6, {})` → `403 FORA_DO_GRUPO_MOVEE`
- **Claims do PostgREST**: `{ usuarioId, empresaAtiva: entidadeAtiva, escopo: idsDoGrupo(6) }`.
- **Erro**: `{ "erro": "CODIGO" }`, com `motivo` opcional. `FV2/lib/hub/avisos-api.ts` mapeia
  os códigos para português, no padrão de `MENSAGENS_CODIGO` (`lib/hub/usuarios-api.ts:28-39`).
- **Payload**: camelCase. O mapeamento snake → camel fica em `lib/hub-avisos-dto.js`, no molde
  de `lib/hub-motoristas-dto.js:117,209`. A paginação usa `parsePaginacao`
  (`lib/hub-motoristas-dto.js:22-33`).
- **Proteção contra injeção de identidade**: `id_empresa`, `criado_por`, `cnpj` e `escopo` no
  corpo ou na query são ignorados. `destinatariosIds` é **seleção** e é validado contra o
  escopo no servidor.

## GET /api/v1/avisos

**Permissão**: `avisos.consultar`. Query: `page`, `pageSize` (padrão 20, máximo 100).

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| itens[] | array | avisos do escopo, mais recentes primeiro |
| itens[].id | number | |
| itens[].titulo | string | |
| itens[].status | string | `na_fila` \| `em_andamento` \| `concluido` |
| itens[].modoDestinatarios | string | `toda_base` \| `individual` \| `empresa` |
| itens[].criadoEm | string | ISO 8601 |
| itens[].contagens | object | `{ visados, pendentes, aceitos, falhas, mortas }` |
| total, page, pageSize | number | alinhar ao envelope de listagem de `GET /api/v1/motoristas` na implementação |

## GET /api/v1/avisos/:id

**Permissão**: `avisos.consultar`.

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| id, titulo, corpo | number/string | |
| status | string | ver acima |
| modoDestinatarios | string | |
| destinatarios | object | `{ empresas: [{ id, nome }] }` (modo empresa) ou `{ qtdMotoristas: number }` (individual) ou `{}` (toda a base) |
| criadoEm, iniciadoEm, concluidoEm | string \| null | ISO 8601 |
| contagens | object | `{ visados, pendentes, processando, aceitos, falhas, mortas }`; com `concluido`, `aceitos + falhas + mortas = visados` |

A UI rotula `aceitos` como **"Aceitos pelo serviço de push"**, nunca "lidos" ou "entregues"
(FR-022).

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 404 | AVISO_NAO_ENCONTRADO | inexistente, expurgado ou fora do escopo |

## GET /api/v1/avisos/alcance

**Permissão**: `avisos.enviar`. Query: `modo` (`toda_base` \| `individual` \| `empresa`) e
`ids` (CSV de inteiros; obrigatório e não vazio para `individual`/`empresa`; máximo 500).

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| motoristas | number | motoristas distintos que seriam alcançados agora |
| inscricoes | number | inscrições ativas (chave VAPID atual, conta ativa) que seriam visadas |

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | DADOS_INVALIDOS | `modo`/`ids` inválidos |
| 403 | DESTINATARIOS_FORA_DO_ESCOPO | empresa fora do grupo Movee |
| 503 | PUSH_INDISPONIVEL | chave VAPID indisponível |

## POST /api/v1/avisos

**Permissão**: `avisos.enviar`. **Limite**: 10 por 15 min por usuário → `429 LIMITE_EXCEDIDO`.

### Request

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| titulo | string | yes | 1 a 60 caracteres depois de `trim`, texto puro, sem caracteres de controle |
| corpo | string | yes | 1 a 180 caracteres depois de `trim`, texto puro, sem caracteres de controle |
| modoDestinatarios | string | yes | `toda_base` \| `individual` \| `empresa` |
| destinatariosIds | number[] | condicional | vazio em `toda_base`; 1 a 500 ids em `individual` (`Entregador.id`) e `empresa` (`Empresa.id`) |
| chaveIdempotencia | string | yes | UUID gerado pelo cliente por formulário aberto |

Validação adicional: o payload do push montado a partir de `titulo` e `corpo` cabe em 1.024
bytes UTF-8.

### Response (201)

Criado e enfileirado. O envio segue em segundo plano (FR-017); resposta em até 3 s (SC-004).

| Field | Type | Description |
|-------|------|-------------|
| id | number | id do aviso |
| status | string | `na_fila` |
| visados | number | inscrições congeladas no disparo |

### Response (200)

Mesmo corpo do 201, devolvido quando `chaveIdempotencia` já foi usada por este usuário. Não
cria novo aviso nem novo envio (FR-018).

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | DADOS_INVALIDOS | `motivo`: `titulo`, `corpo`, `modo`, `ids` ou `chave` |
| 400 | CONTEUDO_EXCEDE_LIMITE | título ou mensagem acima do limite, ou payload acima de 1.024 bytes |
| 403 | DESTINATARIOS_FORA_DO_ESCOPO | empresa ou motorista fora do grupo Movee |
| 422 | SEM_INSCRICOES_ATIVAS | 0 inscrições no momento do disparo; nenhum aviso criado |
| 429 | LIMITE_EXCEDIDO | |
| 503 | PUSH_INDISPONIVEL | chave VAPID ausente ou inválida; nada criado |

Efeito colateral: auditoria `aviso_disparado` (research Decision 18).

## GET /api/v1/avisos/destinatarios/empresas

**Permissão**: `avisos.enviar`.

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| empresas[] | array | `{ id, nome }` das empresas do grupo Movee: ids de `idsDoGrupo(6)`, nomes via `buscarNomesEntidades` (`lib/hub-entidade-nome.js:25-35`) |

## GET /api/v1/avisos/destinatarios/motoristas

**Permissão**: `avisos.enviar`. Query: `busca` (mínimo 3 caracteres, mesmo mínimo de
`components/hub/entregador-combobox.tsx:30-31`).

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| motoristas[] | array | até 20 itens `{ id, nome }`: `Entregador` do escopo do grupo **com** `motorista_id` vinculado |

Motorista sem vínculo com conta não aparece. A UI explica que ele só é alcançado no modo
"toda a base".

## GET /api/v1/avisos/cobertura

**Permissão**: `avisos.consultar`.

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| ativos | object | `{ android, ios, desktopOutros }`: motoristas distintos com aparelho `ativas` na plataforma |
| impedidos | object | `{ iosSemInstalacao, bloqueadas, semSuporte }`: motoristas sem aparelho ativo, pelo estado do aparelho mais recente |
| naoAtivadas | number | motoristas sem aparelho ativo cujo aparelho mais recente está em `nao_ativadas` |

## Telas (`FV2`)

| Rota | Conteúdo |
|---|---|
| `/hub/dashboard/avisos` | cobertura (SC-011); lista com status e contagens; botão "Novo aviso", visível com `avisos.enviar` (gate por `permissoes.includes`, padrão de `app/hub/dashboard/importacoes/page.tsx:241`) |
| diálogo "Novo aviso" | título e mensagem com contador de caracteres; `textarea` nativo estilizado (não existe `components/ui/textarea.tsx`); alerta "o texto passa por serviço de terceiro — não inclua dado pessoal" (FR-021); modo por radio-cards nativos (padrão de `components/hub/import-wizard.tsx:233-261`); multi-seleção de motoristas sobre busca no servidor (base `entregador-combobox.tsx`); lista de empresas; prévia de alcance com disparo desabilitado em zero; validação manual, sem zod ou RHF (padrão do repo) |
| `/hub/dashboard/avisos/[id]` | status + contagens com polling de 4 s até `concluido` (molde de `hooks/use-importacao-polling.ts:36-99`) |
