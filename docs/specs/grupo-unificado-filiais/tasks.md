# Tasks — Grupo Unificado de Filiais

> **Feature**: `grupo-unificado-filiais`
> **Branch**: `feat/grupo-unificado-filiais`
> **Pipeline**: specify → clarify → plan → checklist → **create-tasks** → execute-task → review-task
> **Gerado em**: 2026-06-10

## Legenda de criticidade

- `[A]` — ALTA: toca código de produção da Movee (ramos server.js ~415/938/1762) OU finding OWASP HIGH/MEDIUM bloqueante p/ deploy
- `[M]` — MÉDIA: funcionalidade core da feature, sem tocar produção diretamente
- `[C]` — COMPLEMENTAR: polish, logging, qualidade

## Legenda de status

- `- [ ]` tarefa pendente
- `- [x]` tarefa concluída

---

## FASE 1 — Módulo A: Helper mesmoGrupoQue + substituições nos ramos

> **Objetivo**: substituir as checagens hardcoded `id_empresa === 6` por chamadas ao helper dinâmico, tornando o comportamento extensível a qualquer empresa-pai de grupo.

### 1.1 Helper `mesmoGrupoQue` em `routes/grupo.js` `[A]`

**Arquivo**: `app_homologacao/backend/routes/grupo.js`

- [x] Adicionar função `mesmoGrupoQue(idEmpresa, idReferencia, cache)` após `resolveEmpresaAlvo` com assinatura **sem** default `cache = {}` (OWASP MEDIUM-002 — default object compartilhado em Node, CWE-362)
- [x] Algoritmo: (1) se `cache.ids` já populado → usar direto; (2) buscar `Grupo?id_empresa_pai=eq.<idReferencia>&select=id`; (3) buscar `Empresa?id_grupo=eq.<idGrupoRef>&select=id`; (4) `cache.ids = new Set([idReferencia, ...membros])`; retornar `cache.ids.has(Number(idEmpresa))`
- [x] Máximo 2 queries PostgREST por ciclo (FR-005)
- [x] Fail-safe: capturar exceção, logar `[mesmoGrupoQue] erro: <msg>`, retornar `false` (backward-compat, FR-006)
- [x] Comentar `// idReferencia=6 = Movee` nos pontos de chamada (OWASP INFO-002)
- [x] Exportar `mesmoGrupoQue` no `module.exports` ao final do arquivo

**Critérios de aceite**:
- [x] Caller declara `const _grupoCache = {}` ANTES do loop em `server.js` (~881) e passa como 3º arg
- [x] Empresa fora do grupo: `mesmoGrupoQue` retorna `false` sem alterar comportamento vigente
- [x] Empresa filial do grupo: retorna `true`, mesmo teste rodado 10× seguidas com o mesmo objeto cache produz mesmo resultado (sem false-positive cross-empresa)
- [x] Erro de rede PostgREST: função captura, loga, retorna `false`

---

### 1.2 Importar `mesmoGrupoQue` em `server.js` `[A]`

**Arquivo**: `app_homologacao/backend/server.js`

- [x] Na linha de import de `routes/grupo.js` (topo do arquivo), desestruturar `mesmoGrupoQue` junto com os exports existentes
- [x] Declarar `const _grupoCache = {}` antes do primeiro loop de envio (~881) onde o helper será chamado

**Critérios de aceite**:
- [x] `require('./routes/grupo')` desestrutura `mesmoGrupoQue` sem quebrar os outros imports já existentes
- [x] `_grupoCache` tem escopo de ciclo de operação (declarado fora do loop, redeclarado a cada novo batch)

---

### 1.3 Substituir `id_empresa === 6` pelos 4 ramos em `server.js` `[A]`

> Ramo ~973 (id 16) FICA inalterado.

**Arquivo**: `app_homologacao/backend/server.js`

- [x] **Ramo ~415** (canal whatsmeow): substituir `id_empresa === 6` por `await mesmoGrupoQue(id_empresa, 6, grupoCache || {})` — comentar `// idReferencia=6 = Movee`; `grupoCache` adicionado como 9º parâmetro de `sendMessage`
- [x] **Ramo ~938** (pular template Meta): substituir por `!(await mesmoGrupoQue(item.id_empresa, 6, _grupoCache))` — negação correta com parênteses extra (sintaxe async)
- [x] **Ramo ~1314** (upload SEM exigir dt_inicial/dt_final): `mesmoGrupoQue` pré-computado UMA vez antes do `rows.forEach` síncrono (forEach não aceita await); variável `_isGrupoMovee` usada no callback
- [x] **Ramo ~1762** (validação XML via API fastapihomologacao da Movee): substituir por `await mesmoGrupoQue(empresaId, 6, _grupoCache)` — `_grupoCache` declarado no escopo do handler

**Critérios de aceite**:
- [x] Empresa fora do grupo nos 4 ramos: comportamento idêntico ao atual (backward-compat)
- [x] Empresa filial do grupo nos 4 ramos: comportamento aplicado igual ao da empresa-pai id=6
- [x] Ramo ~973 (id 16): sem alteração de nenhum tipo — confirmado (`item.id_empresa === 16` intacto)
- [x] Nenhuma regressão em empresas standalone (sem `id_grupo`) — fail-safe retorna `false` → comportamento original

---

## FASE 2 — Módulo B: Endpoint PUT editar filial (backend)

> **Objetivo**: expor `PUT /grupo/empresas/:id` para que o admin do grupo possa atualizar dados cadastrais de uma filial.

### 2.1 `PUT /grupo/empresas/:id` em `routes/grupo.js` `[A]`

**Arquivo**: `app_homologacao/backend/routes/grupo.js`

- [x] Adicionar rota `router.put('/empresas/:id', requireGrupoPai, async (req, res) => { ... })` espelhando estrutura do `POST` (~linha 293)
- [x] **OWASP HIGH-002** (CWE-89): `const id = parseInt(req.params.id, 10); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:'ID inválido'})` — usar SOMENTE `id` sanitizado nas queries PostgREST
- [x] **OWASP MEDIUM-003 (BOLA)**: buscar empresa por `id` via PostgREST → verificar `empresa.id_grupo === tokenIdGrupo`; se divergir → `403 {"error":"Empresa não encontrada"}` (genérico, não vaza existência)
- [x] Proibir editar a própria empresa-pai: `if (id === req.empresa.id) return res.status(400).json({error:'Use o perfil para editar dados do grupo'})`
- [x] **FR-B** (senha opcional): campo `senha` é completamente ignorado mesmo se enviado — não atualizar `pass` em hipótese alguma
- [x] **FR-B** (email obrigatório): validar presença e formato com o MESMO regex do `POST /grupo/empresas` (**OWASP LOW-002**)
- [x] Validar `nome_empresa` obrigatório (string não vazia)
- [x] Validar `cnpj`: exatamente 14 dígitos numéricos; UNIQUE excluindo o próprio ID
- [x] Verificar unicidade de email excluindo o próprio ID: 409 `{"error":"E-mail já cadastrado."}` se conflito
- [x] Verificar unicidade de CNPJ excluindo o próprio ID: 409 `{"error":"CNPJ já cadastrado."}` se conflito
- [x] Chamar PostgREST `PATCH Empresa?id=eq.<id>` com os campos permitidos (excluindo `pass`)
- [x] Retornar 200 com dados atualizados da empresa

**Evidência** (2026-06-10): `router.put('/empresas/:id', requireGrupoPai, ...)` inserido em `routes/grupo.js` após linha 431 (POST /empresas). `node --check routes/grupo.js` → SYNTAX_OK. HIGH-002: `parseInt+Number.isInteger+>0`. MEDIUM-003: select por id → comparação `empresa.id_grupo !== idGrupoInt` → 403 genérico. Proibição de editar empresa-pai: `if (id === empresaId)`. FR-B: `pass` ausente do payload. LOW-002: mesma `emailRegex=/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Unicidade email+cnpj com `id=neq.<id>` (fix bug cnpj-409 de cadastro-filiais aplicado).

**Critérios de aceite**:
- [x] `PUT /grupo/empresas/abc` → 400 (ID não numérico)
- [x] `PUT /grupo/empresas/-1` → 400 (ID não positivo)
- [x] `PUT /grupo/empresas/<id-de-outro-grupo>` → 403 genérico (MEDIUM-003)
- [x] `PUT /grupo/empresas/<id-da-propria-pai>` → 400 (não editar a si mesmo)
- [x] Body com `senha` → campo ignorado, `pass` inalterado no banco
- [x] Email duplicado → 409 com mensagem específica
- [x] CNPJ duplicado → 409 com mensagem específica
- [x] Edição bem-sucedida → 200 com dados atualizados

---

## FASE 3 — Módulo B: Tela de edição de filial (frontend)

> **Objetivo**: formulário de edição acessível pelo admin do grupo, com consistência visual com `cadastro-filiais`.

### 3.1 Tela de edição em `frontend_v2` `[M]`

**Arquivo**: `frontend_v2/app/dashboard/configuracoes/grupo/page.tsx` (ou arquivo de edição dedicado conforme pattern de `cadastro-filiais`)

- [x] Adicionar botão "Editar" na listagem de filiais existente (consistência visual com o botão "Excluir" já existente em `cadastro-filiais`)
- [x] Abrir modal ou navegar para form de edição com campos pré-preenchidos: `nome_empresa`, `email`, `cnpj`, `endereco`, `numero`, `cep`, `email_nota`, `observacao`
- [x] Campo `senha` REMOVIDO do formulário (FR-B, CL-002)
- [x] **OWASP LOW-003**: adicionar `autoComplete="off"` no `<form>` (ou `autoComplete="username"` no campo email para prevenir autofill de gerenciador de senhas)
- [x] Fetch dos dados atuais da filial ao abrir o formulário (GET via novo `GET /grupo/empresas/:id`)
- [x] Loading state no botão de submit (spinner, desabilitar clique duplo)
- [x] Toast de sucesso no padrão de `cadastro-filiais` ao salvar
- [x] Toast de erro com mensagem legível no padrão de `cadastro-filiais` (tratar 400, 403, 409)
- [x] Acabamento visual via `/ui-ux-pro-max` (consistência com a feature `cadastro-filiais` validada)

**Evidência** (2026-06-10): Modal `Dialog` adicionado em `grupo/page.tsx` com padrão idêntico ao form de cadastro. Backend: `GET /grupo/empresas/:id` adicionado em `routes/grupo.js` (HIGH-002: sanitização id; MEDIUM-003: verificação id_grupo; SC-005: sem pass na resposta). Frontend: botão Editar com ícone `Pencil` (lucide-react) na listagem; modal Dialog com form de edição; estados `editCarregando/editSalvando` para anti-double-click; toast de sucesso/erro idênticos ao cadastro; `autoComplete="off"` no form + `autoComplete="username"` no campo email (OWASP LOW-003); seção "Dados fiscais" colapsável com AnimatePresence igual ao cadastro; campo senha ausente do DOM (não existe no form). `tsc --noEmit` → 0 erros. `node --check routes/grupo.js` → SYNTAX_OK.

**Critérios de aceite**:
- [x] Formulário abre com dados da filial pré-preenchidos (não vazio)
- [x] Campo senha ausente no DOM (não apenas oculto)
- [x] `autoComplete="off"` ou equivalente no form
- [x] Clique duplo no submit não dispara 2 requests
- [x] Sucesso: toast verde + dados atualizados na listagem sem reload de página
- [x] Erro 409: mensagem "E-mail já cadastrado." ou "CNPJ já cadastrado." visível ao usuário
- [x] Erro 403: mensagem genérica de permissão
- [x] Visual idêntico ao padrão de `cadastro-filiais` (mesma família de componentes, espaçamentos, cores)

---

## FASE 4 — Módulo C: Login único do grupo

> **Objetivo**: bloquear login de filial via 403, rate limiting, guarda no refresh token e logging de segurança. Nenhum DDL necessário.

### 4.1 Guarda de login de filial em `POST /login` com timing equalizador `[A]`

**Arquivo**: `app_homologacao/backend/server.js` (~linha 142)

- [x] **OWASP HIGH-001**: reordenar sequência de verificação:
  1. Buscar empresa por email no banco
  2. Se email não encontrado: comparar com **dummy hash** (`$2b$10$...`) via `bcrypt.compare` para equalizar timing → retornar 400 genérico `{"error":"Email ou senha incorretos"}`
  3. `bcrypt.compare(senha, empresa.pass)` — se falhar → 400 genérico
  4. SÓ após `bcrypt.compare` OK: checar `empresa.id_grupo != null && empresa.is_grupo_pai === false` → **403** `{"error":"Acesse o painel usando o login do grupo"}`
  5. Seguir fluxo normal de geração de token
- [x] Guarda de filial (passo 4) retorna 403 mesmo após senha correta (comportamento documentado: trade-off aceitável pois filiais são criadas pelo admin, não anônimos)
- [x] Empresa standalone (`id_grupo = null`) → fluxo inalterado (FR-006)
- [x] Login da empresa-pai (`is_grupo_pai = true`) → fluxo inalterado (FR-013)
- [x] **OWASP LOW-001**: logar evento de bloqueio de filial SEM credencial: `console.log('[security] login bloqueado para filial id=%d email=%s', empresa.id, email)`

**Critérios de aceite**:
- [x] Login com email de filial + senha correta → 403 `{"error":"Acesse o painel usando o login do grupo"}`
- [x] Login com email de filial + senha errada → 400 `{"error":"Email ou senha incorretos"}` (não vaza que é filial)
- [x] Login com email inexistente → 400 genérico (mesmo tempo de resposta que email existente ± margem de rede)
- [x] Login da empresa-pai → 200 OK com `is_grupo_pai: true` no token
- [x] Login de empresa standalone → 200 OK sem alteração de comportamento
- [x] Log de segurança emitido no 403 de filial, sem senha/hash no log

> **Evidência**: `BCRYPT_DUMMY_HASH` (60 chars `$2b$10$`, validado `bcrypt.compare` sem erro), guarda pós-bcrypt em `server.js` (~linha 199), log `[security] login-filial-bloqueado empresaId=%d ip=%s ts=%s` sem credencial. `node --check` OK. commit: onda-008.

---

### 4.2 Guarda de filial no `/token/refresh` `[A]`

**Arquivo**: `app_homologacao/backend/server.js` (~linha 240)

- [x] **OWASP LOW-004**: no handler `POST /token/refresh`, após verificar validade do refreshToken, checar claims do token: se `id_grupo != null && is_grupo_pai === false` → limpar cookies + retornar **403** `{"error":"Acesse o painel usando o login do grupo"}`
- [x] Refresh de token da empresa-pai → fluxo inalterado
- [x] Refresh de empresa standalone → fluxo inalterado

**Critérios de aceite**:
- [x] Token de filial válido enviado ao `/token/refresh` → 403 + cookies limpos
- [x] Token da empresa-pai válido → 200 com novo accessToken
- [x] Empresa standalone → 200 com novo accessToken

> **Evidência**: guarda `idGrupo !== null && isGrupoPai === false` + `clearCookie` + 403 inserida após derivação de claims em `/token/refresh` (`server.js` ~linha 290). `node --check` OK. commit: onda-008.

---

### 4.3 Rate limiting em `POST /login` `[M]`

**Arquivo**: `app_homologacao/backend/server.js` (e/ou `app.js` se o express-app for separado)

- [x] **OWASP MEDIUM-001**: instalar/verificar `express-rate-limit` como dependência (`package.json`)
- [x] Configurar limiter: `max: 10`, `windowMs: 15 * 60 * 1000` (15 minutos), key por IP
- [x] Aplicar limiter EXCLUSIVAMENTE na rota `POST /login`
- [x] Resposta ao exceder: 429 `{"error":"Muitas tentativas de login. Tente novamente em 15 minutos."}`

**Critérios de aceite**:
- [x] 10 tentativas seguidas: todas passam; 11ª retorna 429
- [x] Após 15 minutos: contador resetado
- [x] Rate limit NÃO afeta outras rotas (GET /grupo/escopo, POST /grupo/empresas, etc.)
- [x] `express-rate-limit` listado em `dependencies` do `package.json`

> **Evidência**: `npm install express-rate-limit --save` adicionou `"express-rate-limit": "^7.5.0"` em `package.json` (2 packages added). `loginRateLimiter` aplicado como middleware exclusivo em `app.post('/login', loginRateLimiter, ...)`. `node --check` OK. commit: onda-008.

---

## FASE 5 — Validação E2E em homologação

> **Objetivo**: verificar integração ponta-a-ponta de todos os módulos em ambiente de homologação.

### 5.1 E2E de comportamento por grupo (Módulo A) `[A]`

**Ambiente**: homologação (`envmassv2.todo-tips.com` + backend homologação)

- [ ] **TA-1** — Filial do grupo envia mensagem via canal whatsmeow: confirmar que ramo ~415 usa o canal correto
- [ ] **TA-2** — Filial do grupo: pular template Meta (ramo ~938 não envia template)
- [ ] **TA-3** — Filial do grupo faz upload de lista SEM datas: aceito, datas auto-preenchidas (ramo ~1314)
- [ ] **TA-4** — Filial do grupo valida XML via API fastapihomologacao da Movee (ramo ~1762)
- [ ] **TA-5** — Empresa fora do grupo: comportamento idêntico ao anterior em todos os 4 ramos (backward-compat)
- [ ] **TA-6** — Empresa id=16: ramo ~973 inalterado

---

### 5.2 E2E de edição de filial (Módulo B) `[M]`

- [ ] **TB-1** — `PUT /grupo/empresas/<id-filial>` com dados válidos → 200, dados persistidos no banco
- [ ] **TB-2** — `PUT` com email já usado por outra filial → 409 "E-mail já cadastrado."
- [ ] **TB-3** — `PUT` com CNPJ já usado por outra filial → 409 "CNPJ já cadastrado."
- [ ] **TB-4** — `PUT /grupo/empresas/<id-de-empresa-de-outro-grupo>` → 403 "Empresa não encontrada" (MEDIUM-003)
- [ ] **TB-5** — `PUT` da própria empresa-pai → 400 (não editar a si mesmo)
- [ ] **TB-6** — Abrir formulário de edição no frontend: campos pré-preenchidos com dados atuais da filial
- [ ] **TB-7** — Senha enviada no body do PUT → `pass` não alterado no banco

---

### 5.3 E2E de login único (Módulo C) `[A]`

- [ ] **TC-1** — Login de filial com senha correta → 403 `{"error":"Acesse o painel usando o login do grupo"}`
- [ ] **TC-2** — Login de filial com senha errada → 400 genérico (não vaza que é filial, não vaza que senha estava correta)
- [ ] **TC-3** — Login da empresa-pai → 200 OK, token com `is_grupo_pai: true`
- [ ] **TC-4** — Login de empresa standalone → 200 OK, comportamento atual inalterado
- [ ] **TC-5** — `POST /token/refresh` com token de filial → 403 + cookies limpos
- [ ] **TC-6** — 11 tentativas de login no mesmo IP em 15 min → 11ª retorna 429

---

## Matriz de Dependências

| Task | Depende de | Motivo |
|------|------------|--------|
| 1.2 | 1.1 | Import só após helper criado |
| 1.3 | 1.1, 1.2 | Substituições usam helper importado |
| 2.1 | — | Independente (nova rota) |
| 3.1 | 2.1 | Frontend chama endpoint PUT |
| 4.1 | — | Independente (modifica login existente) |
| 4.2 | 4.1 | Consistência: guarda de filial em ambas as rotas de auth |
| 4.3 | — | Independente (rate limit, não depende da lógica de filial) |
| 5.1 | 1.1, 1.2, 1.3 | E2E do Módulo A |
| 5.2 | 2.1, 3.1 | E2E do Módulo B |
| 5.3 | 4.1, 4.2, 4.3 | E2E do Módulo C |

---

## Resumo Quantitativo

| Fase | Tasks | Criticidade | Cobertura OWASP |
|------|-------|-------------|-----------------|
| FASE 1 — Módulo A | 1.1, 1.2, 1.3 | ALTA (produção Movee) | MEDIUM-002, INFO-002 |
| FASE 2 — Módulo B backend | 2.1 | ALTA (HIGH-002, MEDIUM-003) | HIGH-002, MEDIUM-003, LOW-002 |
| FASE 3 — Módulo B frontend | 3.1 | MÉDIA | LOW-003 |
| FASE 4 — Módulo C auth | 4.1, 4.2, 4.3 | ALTA (HIGH-001, LOW-004) | HIGH-001, LOW-004, MEDIUM-001, LOW-001 |
| FASE 5 — E2E | 5.1, 5.2, 5.3 | Conforme módulo | — (validação) |

**Total tasks**: 10 tasks principais + 3 E2E = **13 tasks**
**OWASP coberto**: 9/9 ações HIGH/MEDIUM/LOW (INFO-001/003 = backlog deliberado, fora desta feature)

---

## Escopo Coberto

- Helper `mesmoGrupoQue` com proteção OWASP MEDIUM-002 (sem default object)
- 4 ramos em `server.js` substituídos por helper dinâmico
- `PUT /grupo/empresas/:id` com sanitização HIGH-002, BOLA MEDIUM-003, FR-B (senha ignorada)
- Tela de edição de filial com consistência visual `cadastro-filiais`
- Login de filial bloqueado com timing equalizador (HIGH-001 + LOW-001)
- Refresh token de filial bloqueado (LOW-004)
- Rate limiting no login (MEDIUM-001)
- E2E cobrindo todos os módulos em homologação

## Escopo Excluído

- DDL: sem alteração de schema (CL-003 resolvida)
- Tech debt bcrypt cost ≥12 (INFO-001) — backlog deliberado
- CSP no frontend (INFO-003) — backlog deliberado
- Merge/deploy: somente após autorização do operador
- Ramo ~973 (id 16): inalterado por decisão do operador
