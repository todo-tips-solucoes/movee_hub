# Plano — Movimento (EnvioMassa) por Empresa/Filial + seletor de filial (envmass2 / frontend_v2)

> **Como usar este documento:** ele é o briefing para **rodar numa sessão fresca**.
> Abra uma nova sessão do Claude Code na raiz do repo `movee_hub`, cole o
> "Prompt de retomada" (final deste arquivo) e siga as fases. O desenvolvimento
> deve ser conduzido **via skill `feature-00c`** (pipeline SDD) e o acabamento da
> tela **via skill `ui-ux-pro-max`**.
>
> **Pré-requisito já entregue:** a feature `cadastro-filiais` (já na `main`) permite
> ao admin do grupo criar filiais (Empresas com `id_grupo`). Esta feature consome
> esse cadastro: o **movimento** (tabela `EnvioMassa`) e o **import** passam a ser
> tratados por **empresa/filial**, com um **seletor (combobox)** que filtra a visão.

---

## 1. Objetivo

Hoje o movimento (`EnvioMassa`) e o import são **fixos na empresa logada**
(`id_empresa` do token). Quando o usuário é o **admin de um grupo** (ex.: Movee,
`id_empresa = 6`, `is_grupo_pai = true`), ele precisa **operar o movimento de cada
filial separadamente**:

- **Seletor de filial (combobox)** no dashboard, cuja lista são as **empresas do
  grupo** (a própria empresa do admin **+** as filiais cadastradas). No caso da
  Movee, a empresa cadastrada (id 6) **já conta como uma filial** na lista.
- O seletor funciona como **filtro da visão do movimento**: ao escolher uma filial,
  a tela mostra **apenas o movimento daquela filial** (`EnvioMassa` com aquele
  `id_empresa`).
- O **import (upload)** passa a inserir o movimento **na filial selecionada**
  (`id_empresa` = filial escolhida), não mais sempre na empresa logada.

**Invariante de segurança (constitution §II v1.1.0):** o `id_empresa` alvo é um
**pedido** do cliente, **sempre validado no servidor** contra o escopo do token
(`resolveScope(req.user)`). Fora do escopo → **403**. Nunca confiar no `id_empresa`
do body/query cegamente.

---

## 2. Estado atual (o que existe e será reaproveitado)

### Backend (`app_homologacao/backend`)
- **`server.js`** — todos os endpoints de movimento são **hard-scoped** ao
  `empresaId` do token (`EnvioMassa?id_empresa=eq.${empresaId}`):
  - `GET /envio-massa` (~276) — lista o movimento aberto (`mov_fechado=false`).
  - `POST /upload` (~1165) — import; monta as linhas e grava **`id_empresa: empresaId`**
    (~1321).
  - `GET /export-envio-massa` (~1410), `GET /download-xml-movimento` (~1498).
  - `POST /close-movimento` (~1770) — `PATCH` `mov_fechado=true` por `id_empresa`.
  - `DELETE /envio-massa/:id` (~776) e `PATCH /update-envio-massa/:id`.
  - Loop de envio/processo (~881+) lê `EnvioMassa` por `id_empresa` e usa
    `ProcessControl?user_id=eq.${empresaId}`.
  - ⚠️ **Casos hardcoded `id_empresa === 6` / `=== 16`** (linhas ~406, ~899, ~934,
    ~1706): lógica específica de template/conexão da Movee. **Conferir** que a
    troca de `id_empresa` alvo não quebra esses ramos.
- **`routes/grupo.js`** — **`resolveScope(user)`** (linha ~50) **já exportado**:
  - `id_grupo` nulo ou `is_grupo_pai=false` → `[empresaId]` (escopo individual).
  - `is_grupo_pai=true` → `[empresaId, ...idsFilhos]` (pai + filhos diretos).
  - Faz coerção de `id_grupo` para inteiro (anti-injeção) e degrada fail-safe.
  - `requireGrupoPai`, `GET /grupo/filhos` (lista filhos, exclui o pai),
    `POST /grupo/empresas` (cria filial), `module.exports = { router, init,
    resolveScope, resolveOrCreateGrupo }`. `init({ postgrestRequest, bcrypt })`.
  - Mount: `app.use('/grupo', authenticateToken, grupoRoutes.router)`.

### Frontend (`frontend_v2`)
- **`hooks/use-envio-massa.ts`** — hook central do movimento. Métodos via client
  `api`: `fetchData` (`GET /envio-massa`), `deleteRecord`, `updateRecord`
  (`/update-envio-massa/:id`), `uploadFile` (`POST /upload`), `exportCSV`,
  `downloadXML` (`/download-xml-movimento`), `closeMovement` (`/close-movimento`).
  **É o ponto único** onde o `empresa_id` selecionado precisa ser threadado.
- **`lib/api-client.ts`** — `api` (`get/post/patch/del/uploadFile/downloadBlob`),
  `BASE = '/api'`, `credentials: 'include'`. Precisa aceitar query/param extra para
  `empresa_id` (ou os call-sites montam o path com `?empresa_id=`).
- **`app/dashboard/page.tsx`** (~155 linhas) — consome `useEnvioMassa`.
  Componentes: `components/{import-button,action-bar,close-movement-dialog,
  edit-dialog,delete-dialog}.tsx`.
- **`contexts/auth-context.tsx`** — hoje guarda só `{ authenticated, nome_empresa }`.
  ⚠️ **Verificar** se `is_grupo_pai`/`empresaId` estão disponíveis no cliente; se
  não, **dirigir o combobox pelo resultado do endpoint de escopo** (mostrar quando
  houver > 1 opção) em vez de depender de `is_grupo_pai` no cliente.
- **`components/ui/`** — só há **`select.tsx`** (shadcn Select). **Não há**
  `command`/`popover`/`combobox`. Para um combobox **pesquisável** seria preciso
  adicionar `command` + `popover` (radix/shadcn). Decidir na §3.
- **Proxy `app/api/[...path]/route.ts`** — encaminha cookie p/ o backend;
  **funciona para rotas novas e query strings sem alteração**.

### Banco (PostgREST)
- `EnvioMassa.id_empresa` (FK lógica → `Empresa.id`) — já é a coluna de escopo.
- `Empresa.id_grupo` (nullable) e `Grupo(id, id_empresa_pai UNIQUE)` da feature
  config-ui-tenant. **Nenhuma mudança de schema é esperada** (confirmar na §3).

---

## 3. Decisões a confirmar com o usuário (logo no início — fase clarify)

1. **Tipo do seletor.** `Select` shadcn (dropdown simples, sem dep nova) **ou**
   **combobox pesquisável** (precisa adicionar `command`+`popover`)? Com até 100
   filiais, pesquisável é melhor. **Sugestão:** combobox pesquisável.
2. **Seleção default.** Abrir na **própria empresa do admin** (Movee), preservando
   o comportamento atual? (Sugestão: sim.)
3. **Opção "agregada" (todas as filiais)?** O pedido é filtro **por uma** filial.
   Incluir também uma visão agregada do grupo é **fora do MVP** (sugestão: não).
4. **Abrangência do escopo.** O `empresa_id` selecionado aplica-se a **todas** as
   operações do movimento (listar, importar, exportar, baixar XML, fechar, enviar,
   deletar/editar) — ou só a **listar + importar**? **Sugestão:** todas, por
   consistência (a tela inteira reflete a filial selecionada).
5. **Persistência da seleção.** Estado React (some no reload) vs **query param na
   URL** (`?empresa_id=`) vs `localStorage`. **Sugestão:** query param (filtro
   compartilhável e estável).
6. **Contas sem grupo / single-empresa.** Combobox **oculto** (1 opção = a própria
   empresa) — sem mudança de comportamento. (Sugestão: ocultar quando escopo = 1.)
7. **Schema.** Confirmar que **não** há mudança de banco (só leitura/escrita por
   `id_empresa` já existente). Se algo exigir índice/coluna, gerar `docs/sql/006-*`
   aplicado pelo operador.

---

## 4. Backend — proposta

### 4.1 Helper de validação de escopo (Princípio II)
Criar um helper compartilhado, ex. em `routes/grupo.js` (exportado) ou em
`server.js`, reaproveitando `resolveScope`:

```
async function resolveEmpresaAlvo(user, requestedId) {
  const escopo = await resolveScope(user);            // [empresaId, ...filhos]
  if (requestedId == null || requestedId === '') return user.empresaId; // default
  const alvo = parseInt(requestedId, 10);
  if (!Number.isInteger(alvo) || !escopo.includes(alvo)) {
    const err = new Error('empresa fora do escopo'); err.status = 403; throw err;
  }
  return alvo;
}
```
- **Default = `user.empresaId`** → 100% backward-compatible (quem não manda
  `empresa_id` continua igual).
- Fora do escopo → **403** (nunca 500; mensagem clara, sem vazar internals).

### 4.2 Endpoint de escopo p/ o combobox
`GET /grupo/escopo` (protegido por `authenticateToken`; **sem** `requireGrupoPai`,
pois single-empresa também responde):
- Resolve `resolveScope(req.user)` → busca `Empresa?id=in.(...)&select=id,nome_empresa
  &order=id.asc`.
- Responde `200 { empresas: [{ id, nome_empresa }], default: <empresaId> }`.
- **Inclui a própria empresa do admin** (Movee) como primeira opção (já está em
  `resolveScope`). Para single-empresa, retorna 1 item.

### 4.3 ThreADInG do `empresa_id` nos endpoints de movimento
Em cada endpoint, trocar `const empresaId = req.user.empresaId` por
`const idEmp = await resolveEmpresaAlvo(req.user, <fonte>)` e usar `idEmp` na query:
- `GET /envio-massa?empresa_id=` (query).
- `POST /upload` — `empresa_id` como **campo do form** (multipart) → as linhas
  inserem `id_empresa: idEmp` (substitui o `empresaId` fixo em ~1321).
- `GET /export-envio-massa?empresa_id=`, `GET /download-xml-movimento?empresa_id=`.
- `POST /close-movimento` — `empresa_id` no body.
- `DELETE /envio-massa/:id` e `PATCH /update-envio-massa/:id` — **continuar
  validando que a linha pertence a um `id_empresa` do escopo** (hoje validam contra
  `empresaId`; passar a validar contra `resolveEmpresaAlvo`/`resolveScope`).
- Loop de envio/processo (~881) e `ProcessControl` — **decidir** (clarify §4) se o
  envio também passa a ser por filial; se sim, atenção ao `ProcessControl?user_id`
  (é por empresa). **Risco** — ver §10.
- ⚠️ Reavaliar os ramos `id_empresa === 6/16` (templates/conexão): garantir que
  continuam corretos quando `idEmp` é a filial.

### 4.4 Segurança
- `empresa_id` **nunca** confiado: sempre passa por `resolveEmpresaAlvo`.
- 403 padronizado para fora-de-escopo; logs server-side; sem stack ao cliente.
- Testes de unidade (mocks) cobrindo: default sem param; param válido no escopo;
  param fora do escopo → 403; param não-numérico → 403/400.

---

## 5. Frontend — proposta

- **Componente seletor** (combobox) no topo do dashboard, alimentado por
  `GET /api/grupo/escopo`. Renderizar **apenas quando `empresas.length > 1`**.
- **Estado de filial selecionada**: query param `?empresa_id=` (sugestão §3.5) +
  default = `default` do endpoint. Um pequeno provider/contexto
  (`SelectedEmpresaContext`) ou `useSearchParams` do Next.
- **Threading**: `useEnvioMassa` e `lib/api-client.ts` passam `empresa_id` em
  **todas** as chamadas de movimento (query nos GET/DELETE/close; campo no upload).
  Reavaliar assinaturas: `api.get('/envio-massa', { empresa_id })`,
  `api.uploadFile('/upload', file, { empresa_id })`, etc.
- **Recarregar a visão** ao trocar a filial (refetch do movimento, export/XML/close
  passam a operar na filial selecionada).
- **Acabamento via `/ui-ux-pro-max`**: label visível ("Filial"), estado de loading
  do combobox, empty/erro, contraste, `aria-*`, teclado, touch target ≥44px,
  feedback ao trocar de filial, manter identidade EntreGô 2.0 (Plus Jakarta Sans,
  tokens shadcn, white-label). Indicador visível de **qual filial está em foco**.

---

## 6. Desenvolvimento via skill `feature-00c` (pipeline SDD)

- Caminho: **`/feature-00c`** (orquestrador autônomo de UMA feature).
  Short-name sugerido: **`movimento-por-filial`**.
- Branch feature: **`feat/movimento-por-filial`** (a partir de `main`), nunca direto.
- Perfis SDD: **`sdd` + `complementary`** (Node/Express + Next/TS; ignorar
  `language-go`).
- Confirmar as decisões da §3 **antes** de gerar a spec (clarify).
- Rodar os Quality Gates que o subagente pode não ter no contexto
  (`owasp-security`, `ui-ux-pro-max`) no **contexto principal** ao final.

---

## 7. Acabamento via `/ui-ux-pro-max`
Checks prioritários (combobox + dashboard): label visível, item selecionado
destacado, busca acessível (se pesquisável), `aria-expanded`/roles, foco/teclado,
contraste 4.5:1, touch target ≥44px, estados loading/empty/erro, e **deixar claro
na tela qual filial está sendo visualizada**.

---

## 8. Deploy (Docker Swarm — homologação)
Backend **e** frontend_v2 mudam → buildar/pushar/atualizar os dois (aditivo):
```
docker build -t registry.todo-tips.com/envio-massa-backend:homologacao app_homologacao/backend
docker push registry.todo-tips.com/envio-massa-backend:homologacao
docker service update --with-registry-auth --force \
  --image registry.todo-tips.com/envio-massa-backend@sha256:<DIGEST> \
  envio-massa-homologacao_backend_homologacao

docker build -t registry.todo-tips.com/envio-massa-frontend-v2:homologacao app_homologacao/frontend_v2
docker push registry.todo-tips.com/envio-massa-frontend-v2:homologacao
docker service update --with-registry-auth --force \
  --image registry.todo-tips.com/envio-massa-frontend-v2@sha256:<DIGEST> \
  envio-massa-homologacao_frontend_v2_homologacao
```
> Aditivo (`service update --force`) preserva envs/secrets. **Nunca** `docker stack
> deploy` do compose completo. **Commit/push/merge/deploy só com autorização
> explícita do usuário.** Mensagem de commit termina com
> `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## 9. Critérios de aceite
- [ ] Admin de grupo vê um **combobox de filial** com a própria empresa (Movee) +
      filiais cadastradas; single-empresa **não** vê combobox.
- [ ] Selecionar uma filial **filtra** o movimento para o `id_empresa` dela.
- [ ] **Import** insere `EnvioMassa` com `id_empresa` = filial selecionada.
- [ ] Export, download XML, fechar e (se decidido) enviar operam na filial em foco.
- [ ] **Princípio II:** `empresa_id` fora do escopo do token → **403**; sem param →
      comportamento atual (própria empresa).
- [ ] Single-empresa e fluxos existentes **inalterados** (backward-compatible).
- [ ] Testes backend (default/escopo-ok/escopo-fora/inválido).
- [ ] `next build` limpo; tela aprovada pelo checklist `ui-ux-pro-max`.
- [ ] Validação E2E em homologação (trocar filial, importar p/ filial, ver só o
      movimento dela; tentar `empresa_id` fora do escopo → 403).

---

## 10. Riscos / atenção
- **Princípio II em TODOS os endpoints** — esquecer um ponto (ex.: export, XML,
  close, delete) vaza dados entre filiais. Centralizar em `resolveEmpresaAlvo` e
  cobrir com testes.
- **Backward compatibility** — default = `req.user.empresaId`; não quebrar
  single-empresa nem o app que não envia `empresa_id`.
- **Loop de envio/`ProcessControl`** — é por `user_id`/empresa; escopar o **envio**
  por filial exige cuidado para não colidir processos. Decidir na clarify se o
  envio entra no MVP ou fica só a **visão+import**.
- **Ramos hardcoded `id_empresa === 6/16`** — templates/conexão da Movee; validar
  com a filial selecionada.
- **`auth-context` no cliente** — `is_grupo_pai` pode não estar disponível; dirigir
  o combobox pelo endpoint de escopo (mostrar se > 1 opção).
- **Sem combobox pronto** — se for pesquisável, adicionar `command`+`popover`
  (custo de UI); senão usar `Select`.

---

## Prompt de retomada (colar na sessão fresca)

```
Implemente, via skill feature-00c (pipeline SDD, /feature-00c, branch
feat/movimento-por-filial, a partir de main), uma feature no painel envmass2
(frontend_v2) que trata o MOVIMENTO (tabela EnvioMassa) e o IMPORT POR
EMPRESA/FILIAL, com um SELETOR DE FILIAL (combobox) no dashboard.

Contexto: a feature cadastro-filiais (já na main) deixa o admin do grupo
(is_grupo_pai) criar filiais (Empresas com id_grupo). Agora:
- Um combobox no dashboard lista as EMPRESAS DO GRUPO (a própria empresa do admin
  — ex.: Movee id_empresa=6, que já conta como filial — MAIS as filiais cadastradas).
- O combobox é um FILTRO da visão do movimento: ao escolher uma filial, a tela
  mostra só o EnvioMassa daquela filial (id_empresa).
- O IMPORT (POST /upload) passa a inserir EnvioMassa com id_empresa = filial
  selecionada (hoje grava sempre o empresaId do token, ~server.js:1321).

SEGURANÇA (constitution §II): o empresa_id é um pedido do cliente, SEMPRE validado
no servidor contra resolveScope(req.user) (já exportado em routes/grupo.js); fora do
escopo → 403; sem param → default = req.user.empresaId (backward-compatible).

Leia PRIMEIRO docs/plans/movimento-por-filial-envmass2.md (este plano) — ele tem o
mapa exato do código (endpoints de movimento em server.js: GET /envio-massa, POST
/upload, /export-envio-massa, /download-xml-movimento, /close-movimento, DELETE/PATCH;
hook frontend hooks/use-envio-massa.ts; client lib/api-client.ts; só há
components/ui/select.tsx). Reaproveite resolveScope; crie um helper
resolveEmpresaAlvo(user, requestedId) e um GET /grupo/escopo p/ alimentar o combobox.

Confirme comigo as decisões da §3 (tipo do combobox, default, abrangência do escopo,
persistência, comportamento single-empresa, envio por filial sim/não) ANTES de gerar
a spec. O acabamento da tela deve passar pela skill /ui-ux-pro-max. Backend e
frontend deployam via Docker Swarm aditivo (homologação); commit/push/merge/deploy só
com minha autorização explícita.
```
