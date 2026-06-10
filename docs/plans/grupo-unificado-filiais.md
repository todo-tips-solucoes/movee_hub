# Plano — Grupo Unificado: empresas como filiais, login por grupo, edição de filiais, comportamento por grupo

> **Como usar:** briefing para **rodar numa sessão fresca** do Claude Code via skill
> `feature-00c`. Abra a sessão na raiz do projeto, cole o "Prompt de retomada" (final)
> e siga o pipeline SDD. Acompanhe o progresso pelo painel (knowledge.db / cstk).
>
> **Pré-requisito:** a feature [[movimento-por-filial]] (seletor de filial + escopo por
> `empresa_id` + helper `resolveEmpresaAlvo` + `GET /grupo/escopo`) — branch
> `feat/movimento-por-filial`, deployada em homologação e validada E2E. ESTA feature
> deve ramificar a partir de `feat/movimento-por-filial` (ou de `main` após o merge dela),
> pois reusa o seletor, o escopo e o threading de `empresa_id`.

---

## 1. Objetivo

Três mudanças confirmadas com o operador (sem deduzir além do registrado):

- **A) Comportamento por grupo.** Hoje há ramos hardcoded `id_empresa === 6` (Movee) que
  dão à Movee um comportamento diferente das demais empresas. O operador quer que **todas
  as empresas vinculadas ao grupo da Movee** (Movee + filiais) compartilhem o **mesmo
  comportamento** nesses ramos — i.e., trocar `id_empresa === 6` por *"a empresa pertence
  ao grupo da Movee"*.
- **B) Editar filiais.** O cadastro-filiais hoje só **cria** (`POST /grupo/empresas`).
  Falta **editar** os dados de uma filial.
- **C) Login único do grupo.** Um único login (do grupo) opera **todas** as filiais via o
  seletor; **filiais não têm login próprio**. "Empresas devem ser consideradas filiais"
  (mesmo a empresa-pai é uma filial do grupo). Isso **muda o modelo de autenticação atual**
  (hoje cada `Empresa` loga com email/senha próprios).

---

## 2. Decisões JÁ confirmadas pelo operador (fold na spec; NÃO re-perguntar)

### A — comportamento por grupo
- Trocar `id_empresa === 6` por *"pertence ao grupo da Movee"* nos ramos:
  - **`server.js:415`** `if (id_empresa === 6)` — **canal de envio**: Movee usa
    **whatsmeow** (`api.chatmasterveloz.com/.../sendTextPRO`, texto puro). Grupo todo
    passa a usar whatsmeow.
  - **`server.js:938`** `if (item.id_empresa !== 6)` — para NÃO-Movee envia o **template
    Meta** `template_emissao_nf_com_button`; Movee pula. Grupo todo pula o template Meta
    (usa whatsmeow do 415).
  - **`server.js:1314`** `if (empresaId !== 6)` — **upload**: NÃO-Movee exige
    `dt_inicial/dt_final`; Movee auto-preenche `01/01/1982`. **Decisão: o grupo HERDA a
    Movee → SEM exigir datas** (auto-preenche para todas as empresas do grupo).
  - **`server.js:1762`** `if (Number(empresaId) === 6)` — **validação XML**: Movee usa
    `fastapihomologacao.todo-tips.com/validade_nfse` (id_empresa=6); outras usam
    `fastapihomologacaonexus...` (nexus=true). Grupo todo passa a usar a API da Movee.
- **`server.js:973`** `if (item.id_empresa === 16)` (sentinela que desativa a 2ª mensagem)
  **FICA COMO ESTÁ** — fora do escopo.
- ⚠️ **Atenção:** A e validação XML (1762) tocam **entrega de mensagens e validação fiscal
  da Movee em produção**. Quebrar = quebrar a Movee. Exige teste + revisão OWASP.

### B — editar filiais
- Novo endpoint `PUT /grupo/empresas/:id` (ou `PATCH`) espelhando o `POST /grupo/empresas`
  (`routes/grupo.js:293`), protegido por `requireGrupoPai` + validação de que a filial
  pertence ao grupo do token (Princípio II). Tela de edição no frontend.
- **A CONFIRMAR na clarify:** quais campos editáveis (nome_empresa, email, cnpj, campos
  fiscais) e o tratamento da senha — ver §C (login único pode tornar a senha de filial
  irrelevante).

### C — login único do grupo (modelo confirmado: "Login único do grupo")
- Um login do grupo acessa/opera todas as filiais via seletor; **filiais não têm login
  próprio**. A empresa-pai também é tratada como filial do grupo.
- **AMBIGUIDADES PARA A CLARIFY (NÃO deduzir):**
  1. O "login do grupo" = credenciais da empresa-pai atual, ou uma credencial nova de grupo?
  2. O que acontece com **filiais que já têm email/senha** (criadas pelo cadastro-filiais)?
     Bloquear login delas? Manter como identificação sem permitir login?
  3. No cadastro de filial (`POST /grupo/empresas`), a senha passa a ser
     opcional/ignorada? E o email continua obrigatório (unique) como identificador?
  4. Como o backend passa a **negar login** de uma empresa-filial (id_grupo setado e não
     é pai)? Impacto no `POST /login` (`server.js:142`).
  5. Sessão/token: o token já carrega `id_grupo`/`is_grupo_pai`; o seletor já usa
     `resolveScope`. Confirmar que "login único" = só o pai loga e o escopo já cobre as
     filiais (grande parte já existe via [[movimento-por-filial]]).

---

## 3. Estado atual relevante (reuso)

### Backend (`app_homologacao/backend`)
- **`server.js:142`** `POST /login` — valida email/senha (bcrypt), monta payload com
  `empresaId, id_grupo, is_grupo_pai` (deriva `is_grupo_pai` via
  `Grupo?id_empresa_pai=eq.<id>`), seta cookies httpOnly `accessToken`/`refreshToken`.
  É o ponto central da mudança C.
- **5 ramos hardcoded** (§2A): 415, 938, 973, 1314, 1762.
- **`routes/grupo.js`** — `resolveScope` (50), `resolveOrCreateGrupo` (96),
  `requireGrupoPai` (139), `GET /grupo/filhos` (154), `POST /grupo/filhos` (195),
  `POST /grupo/empresas` (293, criar filial — espelhar p/ editar), `GET /grupo/escopo`
  (movimento-por-filial), helper `resolveEmpresaAlvo` (movimento-por-filial).
- Helper a criar (A): `pertenceAoGrupoMovee(idEmpresa)` ou, mais geral,
  `mesmoGrupoQue(idEmpresa, idReferencia=6)` — resolve o grupo da Movee uma vez e checa
  membresia. Cuidar de cache/perf no loop de envio (~881+).

### Frontend (`frontend_v2`)
- `components/empresa-selector.tsx`, `hooks/use-envio-massa.ts`, `lib/api-client.ts`,
  `app/dashboard/page.tsx` — já threadam `empresa_id` (movimento-por-filial).
- Cadastro de filiais (tela) — localizar e espelhar para edição (B).

### Banco
- `Grupo(id, nome, id_empresa_pai UNIQUE)`, `Empresa.id_grupo` (nullable), `Empresa.cnpj`
  UNIQUE, `Empresa.email` UNIQUE. Mudança C pode exigir DDL (ex.: flag de "login
  habilitado"? a definir na clarify) → gerar `docs/sql/007-*` aplicado pelo operador.

---

## 4. Riscos / atenção
- **A (415/938/1762):** entrega de mensagens (whatsmeow vs template Meta) e validação
  fiscal da Movee em produção. Testar; cobrir com OWASP; validar E2E com a Movee real.
- **C (auth):** mudança de modelo de login é security-sensitive (constitution §II).
  Resolver TODAS as ambiguidades da §2C na clarify ANTES do plan. Migrar/again sem
  trancar usuários existentes.
- **Membresia de grupo no loop de envio:** resolver o grupo da Movee uma vez por ciclo
  (não por item) para não martelar o PostgREST.
- **Backward-compat:** empresas SEM grupo continuam como hoje.

---

## 5. Pipeline e governança
- Via **`/feature-00c`**, short-name **`grupo-unificado-filiais`**, branch
  **`feat/grupo-unificado-filiais`** a partir de `feat/movimento-por-filial` (ou `main`
  pós-merge). Confirmar §2C (ambiguidades de auth) na clarify ANTES de gerar a spec/plan.
- Quality Gates: **owasp-security** (obrigatório — toca auth + envio + validação fiscal),
  ui-ux-pro-max (telas de editar filial). 
- Deploy aditivo Swarm (homologação) só com autorização; commit/push/merge/deploy só com
  autorização explícita. Mensagem de commit termina com
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Prompt de retomada (colar na sessão fresca)

```
Implemente, via skill feature-00c (/feature-00c, short-name grupo-unificado-filiais,
branch feat/grupo-unificado-filiais a partir de feat/movimento-por-filial), três mudanças
no painel envmass2 (frontend_v2) + backend:

A) COMPORTAMENTO POR GRUPO: trocar os ramos hardcoded id_empresa===6 por "a empresa
   pertence ao grupo da Movee (id 6)" em server.js:415 e 938 (canal de envio whatsmeow vs
   template Meta), 1314 (upload — grupo HERDA a Movee: SEM exigir dt_inicial/dt_final) e
   1762 (validação XML — grupo usa a API fastapihomologacao da Movee). O ramo 973
   (id_empresa===16) FICA COMO ESTÁ.
B) EDITAR FILIAIS: novo endpoint PUT /grupo/empresas/:id espelhando o POST
   /grupo/empresas (routes/grupo.js:293), com requireGrupoPai + checagem de que a filial
   pertence ao grupo do token; + tela de edição no frontend.
C) LOGIN ÚNICO DO GRUPO: um login do grupo opera todas as filiais via o seletor; filiais
   NÃO têm login próprio; a empresa-pai também é tratada como filial. Muda o POST /login
   (server.js:142).

LEIA PRIMEIRO docs/plans/grupo-unificado-filiais.md (este plano — tem o mapa exato do
código e as decisões já confirmadas pelo operador) e a feature movimento-por-filial
(docs/specs/movimento-por-filial/) que ESTA reusa (resolveScope, resolveEmpresaAlvo,
GET /grupo/escopo, EmpresaSelector, threading de empresa_id).

CRÍTICO: na fase CLARIFY, resolva com o operador as ambiguidades da §2C do plano (o que
fazer com filiais que já têm login; se o login do grupo = credenciais do pai; senha no
cadastro de filial passa a ser opcional/ignorada; como o backend nega login de filial) —
NÃO DEDUZA. A mudança de auth (C) e os ramos de envio/validação (A) tocam produção da
Movee: rode owasp-security e valide E2E. Acabamento das telas via /ui-ux-pro-max.
Commit/push/merge/deploy só com autorização explícita do operador.
```
