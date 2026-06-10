# Plano — Cadastro de Filiais por dentro do sistema (envmass2 / frontend_v2)

> **Como usar este documento:** ele é o briefing para **rodar numa sessão fresca**.
> Abra uma nova sessão do Claude Code na raiz do repo `movee_hub`, cole o
> "Prompt de retomada" (final deste arquivo) e siga as fases. O desenvolvimento
> deve ser conduzido **via skill `cstk`** (pipeline SDD) e o acabamento da tela
> nova **via skill `ui-ux-pro-max`**.

---

## 1. Objetivo

Hoje, o administrador do grupo (is_grupo_pai) só consegue **vincular uma filial
que já existe** informando o **ID numérico** da empresa (tela
`/dashboard/configuracoes/grupo`). Isso exige que a empresa filha tenha sido
criada antes, por fora, e que o admin descubra o ID dela.

**O que queremos:** o admin **cria a empresa filial de dentro do sistema**
(formulário completo) e ela já nasce **vinculada ao grupo** — sem precisar de
ID, sem passo manual de descoberta. A tela de "vincular por ID" é substituída
por uma tela de "cadastrar filial".

---

## 2. Estado atual (o que existe e será reaproveitado)

### Backend
- **`app_homologacao/backend/server.js`**
  - `POST /register` (linhas ~1775-1810): único ponto que faz `POST Empresa`.
    Recebe `{ nomeEmpresa, email, senha }`, valida e-mail único, `bcrypt.hash(senha,10)`,
    grava **apenas** `{ nome_empresa, email, pass }`. **Não** grava CNPJ nem `id_grupo`.
  - Mount das rotas de grupo (linha ~1825): `grupoRoutes.init({ postgrestRequest })`
    e `app.use('/grupo', authenticateToken, grupoRoutes.router)`.
    ⚠️ **`bcrypt` NÃO é injetado em `grupo.js`** — é um gap a resolver (ver §4).
- **`app_homologacao/backend/routes/grupo.js`**
  - `requireGrupoPai` (linha 85): 403 se `req.user.is_grupo_pai !== true`.
  - `resolveScope(user)` (linha 45): escopo só a partir do JWT (Princípio II).
  - `POST /grupo/filhos` (linha 141): **a lógica que vamos reaproveitar** —
    resolução/criação preguiçosa do `Grupo` (busca `Grupo?id_empresa_pai=eq.{empresaId}`,
    cria se não existir via `POST Grupo {nome, id_empresa_pai}`), checagem do
    **limite de 100 filhos** (422), e `PATCH Empresa SET id_grupo`.
  - `GET /grupo/filhos` (linha 100) e `DELETE /grupo/filhos/:id` (linha 262).

### Frontend (`frontend_v2`)
- **`app/dashboard/configuracoes/grupo/page.tsx`**: tela atual "vincular por ID"
  (input `empresaIdFilho`, `POST /api/grupo/filhos {empresa_id_filho}`,
  `GET /api/grupo/filhos`, `DELETE /api/grupo/filhos/:id`).
  Gate: `isGrupoPai = user?.is_grupo_pai === true`.
- **`app/api/[...path]/route.ts`**: proxy que tira `/api`, encaminha para
  `BACKEND_URL` e reconstrói o cookie de auth. **Funciona para rotas novas sem
  alteração** (qualquer `/api/grupo/*` é encaminhado).
- Design já está em **EntreGô 2.0** (Plus Jakarta Sans, paleta creme/marinho/azul
  #2C67EA/menta #2CEABC, white-label via `TenantThemeProvider`).

### Banco (PostgREST)
- `docs/sql/001-config-ui-tenant-schema.sql`: `Grupo(id, nome, id_empresa_pai UNIQUE FK→Empresa)`,
  `Empresa.id_grupo` (nullable FK→Grupo). **Não há UNIQUE em CNPJ** hoje.
- GRANTs concedidos ao role `authenticated` (PostgREST).

---

## 3. Decisões a confirmar com o usuário (logo no início da sessão fresca)

Antes de gerar a spec/tasks, alinhar:

1. **Campos do cadastro de filial.** Mínimo: `nome_empresa`, `email`, `senha`.
   Confirmar quais campos adicionais a Empresa precisa (CNPJ do prestador /
   `cnpj_prestador`, razão social, endereço/número/CEP, e-mail da nota,
   observação). ➜ **Inspecionar as colunas reais da tabela `Empresa`** no
   PostgREST/DB antes de definir o formulário (não assumir).
2. **CNPJ:** validar formato e exigir? Criar **UNIQUE** em CNPJ? (Hoje não existe.)
   Se sim → novo `.sql` (`docs/sql/004-...`) + GRANT, aplicado pelo operador.
3. **Senha da filial:** o admin define a senha da filial? Ou gera uma temporária
   e a filial troca no 1º login? (MVP sugerido: admin define no formulário.)
4. **A filial pode logar?** Sim — ela é uma Empresa normal com `id_grupo` setado
   e `is_grupo_pai` falso/ausente. Confirmar se há fluxo de "primeiro acesso".
5. **Limite de 100 filhos:** manter (reaproveitar a checagem existente → 422).

---

## 4. Backend — novo endpoint (proposta)

**`POST /grupo/empresas`** em `app_homologacao/backend/routes/grupo.js`,
protegido por `authenticateToken` (já no mount) + `requireGrupoPai`.

Responsabilidade: **criar a Empresa filial E já vinculá-la ao grupo do token**,
numa só chamada, reaproveitando a lógica de resolução/criação preguiçosa do
`Grupo` que já existe no `POST /grupo/filhos`.

Fluxo:
1. `requireGrupoPai` garante admin do grupo.
2. Validar body: `nome_empresa`, `email` (formato + unicidade via
   `Empresa?email=eq.{email}`), `senha` (regra mínima), + campos confirmados na §3.
3. **Resolver/criar o `Grupo` do pai** — extrair a lógica do `POST /grupo/filhos`
   (linhas 188-223) para um helper reutilizável `resolveOrCreateGrupo(user)` para
   não duplicar.
4. Checar **limite de 100 filhos** antes de criar (reaproveitar checagem 422).
5. `bcrypt.hash(senha, 10)` → **precisa injetar `bcrypt` no `init()` de `grupo.js`**
   (hoje só recebe `postgrestRequest`). Alterar a assinatura para
   `init({ postgrestRequest, bcrypt })` e passar `bcrypt` no `server.js` (linha 1825).
   *Alternativa:* extrair um helper compartilhado `criarEmpresa({nome_empresa,email,senha,...,id_grupo})`
   no server.js e injetá-lo — evita acoplar bcrypt à rota. (Decidir na sessão.)
6. `POST Empresa { nome_empresa, email, pass, id_grupo: <grupo do pai>, ...campos }`
   — `id_grupo` vem **do token/grupo resolvido, NUNCA do body** (Princípio II).
7. **Atenção: não há transação.** Criar Empresa + (eventual) criar Grupo são
   operações separadas. Como `id_grupo` já vai no `POST Empresa`, evitamos o
   2-passos do fluxo de vínculo (create + PATCH). Tratar erro de e-mail duplicado
   e CNPJ duplicado (se UNIQUE) com mensagem clara (400/409).
8. Resposta `201`: `{ id, nome_empresa, email, id_grupo }`.

Manter `POST /grupo/filhos` (vincular por ID) **ou** removê-lo? Sugestão:
**manter o backend** (não quebra contrato) e apenas trocar a **UI**. Decidir na §3.

---

## 5. Frontend — substituir a tela (proposta)

`app/dashboard/configuracoes/grupo/page.tsx`:
- Trocar o card "Vincular empresa filha (por ID)" por um **formulário "Cadastrar
  filial"** com os campos confirmados (§3). Validação inline, senha com
  show/hide e medidor (reaproveitar padrão de `register/page.tsx`).
- `POST /api/grupo/empresas` (passa pelo proxy sem mudança).
- Manter a **lista de filiais** (`GET /api/grupo/filhos`) e o **desvincular**
  (`DELETE`). Após criar, recarregar a lista.
- Manter o gate `isGrupoPai` e o estado vazio amigável.
- **Acabamento via `/ui-ux-pro-max`** (ver §7): hierarquia, estados de
  loading/erro/sucesso, toasts, acessibilidade (labels visíveis, foco no 1º campo
  inválido, contraste), inputs com `type` semântico (email/tel), touch targets.

---

## 6. Desenvolvimento via skill `cstk` (pipeline SDD)

Conduzir a implementação pela pipeline Spec-Driven Development do cstk
(ver memória [[cstk-setup]] e `CONTINUAR-CSTK.md` na raiz):

- Perfis aplicáveis: **`sdd` + `complementary`** (projeto Node/Express + Next/TS —
  ignorar skills `language-go`).
- Pipeline: `constitution → specify → clarify → plan → create-tasks → analyze →
  execute-task → review-task → commit`.
- Caminho recomendado: **`/feature-00c`** (orquestrador autônomo de UMA feature).
  Nome da feature sugerido: `cadastro-filiais`.
- Implementar em **branch feature** (`feat/cadastro-filiais`), nunca direto na main.
- Pré-requisitos do painel cstk (se for usar `cstk serve`): `sqlite3` instalado,
  `cstk recall --reindex` se a base estiver degradada; subir túnel com
  `ngrok http --basic-auth 'admin:SENHA' 127.0.0.1:5173` (IPv4 explícito).
- Após cada onda: `cstk recall --ingest`/`--reindex` para manter `knowledge.db`.

---

## 7. Acabamento da tela via `/ui-ux-pro-max`

Invocar a skill `ui-ux-pro-max` ao desenhar/revisar o formulário de cadastro.
Checks prioritários para esta tela (form):
- **Forms & Feedback:** labels visíveis (não placeholder-only), erro abaixo do
  campo, helper text, validação on-blur, foco no 1º campo inválido após submit,
  feedback de loading/sucesso, confirmação antes de desvincular (já existe).
- **Acessibilidade:** contraste 4.5:1, focus rings, `aria-live` para erros,
  `autocomplete`/`type` semânticos, touch target ≥44px.
- **Estilo:** manter EntreGô (Plus Jakarta Sans, tokens shadcn, white-label),
  um único CTA primário, estados hover/disabled distintos.

---

## 8. Deploy (Docker Swarm)

Como nas features anteriores (ver memórias [[redesign-movee-v2]] /
[[reskin-entrego-motorista]]):
- `next build` limpo no `frontend_v2`.
- Build + push da imagem para `registry.todo-tips.com`.
- `docker service update --force --image <digest>` no serviço
  `envio-massa-frontend-v2` (frontend) e no serviço do **backend** (pois `grupo.js`
  muda) — confirmar os nomes exatos dos serviços no `docker service ls`.
- Se criar `.sql` (CNPJ UNIQUE): **o operador aplica o DDL + GRANT** antes do deploy
  do backend.
- **Commit/push e merge só com autorização explícita do usuário** (o classifier
  bloqueia push autônomo). Mensagem de commit termina com
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## 9. Critérios de aceite

- [ ] Admin do grupo cria uma filial pelo formulário e ela aparece na lista de
      filiais **sem informar ID**.
- [ ] A filial criada tem `id_grupo` = grupo do admin (vindo do token, não do body).
- [ ] A filial consegue logar com e-mail/senha definidos.
- [ ] E-mail duplicado → erro claro (400). CNPJ duplicado (se UNIQUE) → 409.
- [ ] Limite de 100 filiais respeitado (422).
- [ ] Não-admin (is_grupo_pai falso) recebe a tela bloqueada / 403 no endpoint.
- [ ] Tela aprovada pelo checklist `ui-ux-pro-max`.
- [ ] `next build` limpo; deploy validado em `envmassv2.todo-tips.com`.

---

## 10. Riscos / atenção

- **Sem transação** entre criar Grupo (1ª filial) e criar Empresa — tratar falhas
  parciais e idempotência (Grupo já é resolvido por `id_empresa_pai UNIQUE`).
- **`id_grupo` jamais do body** (Princípio II — escopo só do JWT).
- **bcrypt em grupo.js**: decidir injeção direta vs helper compartilhado.
- **Colunas reais da Empresa**: confirmar no DB antes de fixar o formulário.
- **Proxy** não precisa mudar, mas conferir que `/api/grupo/empresas` chega ao backend.

---

## Prompt de retomada (colar na sessão fresca)

```
Implemente, via skill cstk (pipeline SDD, /feature-00c, branch feat/cadastro-filiais),
uma nova rotina no painel envmass2 (frontend_v2) para CADASTRO DE FILIAIS por dentro
do sistema, substituindo o fluxo atual de "vincular filial por ID numérico".

O admin do grupo (is_grupo_pai) deve CRIAR a empresa filial num formulário e ela já
nasce vinculada ao grupo dele — sem informar ID. Reaproveite a lógica de
resolução/criação preguiçosa do Grupo que já existe em POST /grupo/filhos
(routes/grupo.js). id_grupo vem SEMPRE do token (Princípio II), nunca do body.

Leia primeiro docs/plans/cadastro-filiais-envmass2.md (este plano) e a memória
cstk-setup + CONTINUAR-CSTK.md. Confirme comigo as decisões da §3 (campos da
Empresa — inspecione as colunas reais no DB —, CNPJ/UNIQUE, regra de senha) ANTES
de gerar a spec. O acabamento da tela deve passar pela skill /ui-ux-pro-max.
Backend e frontend deployam via Docker Swarm; commit/push/merge só com minha
autorização explícita.
```
