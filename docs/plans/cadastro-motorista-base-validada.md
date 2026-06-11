# Plano — Cadastro de motorista restrito à base validada (`Motorista`) + CRUD

> **Como usar:** briefing para rodar numa **sessão fresca** do Claude Code (via cstk).
> Abra na raiz do projeto, cole o "Prompt de retomada" (final) e **resolva as
> ambiguidades (§6) COM o operador na clarify ANTES de implementar**. Acompanhe pelo
> painel cstk. Segue o mesmo rito do corte do Módulo C ([[regra-nao-tocar-producao]]:
> produção é só do operador; o agente trabalha em homologação).

---

## 1. Objetivo

Garantir que **só motoristas presentes na base do cliente possam criar conta** no app
do motorista (`appmotorista`). A "base" é a tabela **`Motorista`**, que passa a ser
**populada automaticamente pelo upload da planilha de movimento** (no painel `envmassv2`),
capturando **nome + CNPJ do prestador**. No cadastro, o CNPJ digitado tem de **bater com
um registro da `Motorista`**: se não bater → aviso amigável; se bater → cria o acesso
(define/atualiza a senha). Entregar também uma **página de edição (CRUD) dos motoristas**
no painel — toda edição atualiza a tabela `Motorista`.

**Fim:** coibir auto-cadastro de motoristas que não fazem parte da base do cliente.

---

## 2. Estado atual (o que JÁ existe — ler antes de planejar)

A funcionalidade existe **parcialmente** hoje; esta feature **evolui** o que está pronto,
não constrói do zero.

- **Tabela `Motorista`** (já existe, 3 registros): `id` (bigserial), `cnpj_prestador`
  (text **NOT NULL**), `senha` (text **NOT NULL**), `nome` (text null), `ativo` (bool
  default true), `created_at`. **Não tem vínculo com empresa/grupo** (é global). CNPJ
  guardado como **14 dígitos puros**.
- **`POST /motorista/register`** — `app_homologacao/backend/routes/motorista.js:199`.
  Hoje: valida senha ≥ 8; **Guard 1 (linha 214): CNPJ ∈ `EnvioMassa`**; Guard 2 (226):
  não há conta `Motorista` com o CNPJ; senão **`INSERT`** em `Motorista` com `bcrypt.hash(senha,10)`
  (236). Erro genérico **409 "CNPJ não elegível para cadastro ou já possui conta."**
  (anti-enumeração, mesma msg p/ inexistente e já-cadastrado).
- **`POST /motorista/login`** — `motorista.js:142`. Valida `cnpj_prestador` + `senha`
  (`bcrypt.compare`), bloqueia `ativo=false`, emite JWT httpOnly com `aud:'motorista'`.
- **Outras rotas motorista**: `/token/refresh` (280), `/logout` (316), `/verify-auth`
  (325), `/empresas-proprietarias` (257), `/movimento-aberto` (337), `/validar-nota`
  (422 — rejeita XML cujo `<prest><CNPJ>` ≠ CNPJ do motorista logado).
- **Upload do movimento** — `app_homologacao/backend/server.js:1283` (`POST /upload`,
  multer + `xlsx`, `authenticateToken` + `resolveEmpresaAlvo` da feature
  [[feature-movimento-por-filial]]). Parseia a planilha (`sheet_to_json`), valida linha a
  linha, e **insere em `EnvioMassa`** no `server.js:1491`
  (`postgrestRequest('EnvioMassa','POST',dataToInsert)`). `cnpj_prestador` é normalizado
  p/ 14 dígitos (`onlyDigits`/`isCNPJ14`, `server.js:1185-1190`); `nome` vem `trim`. **NÃO
  toca a `Motorista` hoje.**
- **Frontend cadastro** — `app_homologacao/frontend_motorista/app/(auth)/cadastro/page.tsx`:
  form com CNPJ (máscara ao vivo), nome, senha, confirmar senha; `POST /motorista/register`
  (submit ~linha 56); 409 → mensagem geral no bloco `animate-shake` (~linha 66/184). Há
  também `app/(auth)/login/page.tsx`.
- **Painel admin** (`frontend_v2`): **NÃO há** tela de motoristas hoje → o CRUD é página nova.

---

## 3. Gap — o que muda (atual → desejado)

| Frente | Hoje | Desejado |
|--------|------|----------|
| Fonte de verdade do gate | CNPJ ∈ `EnvioMassa` | CNPJ ∈ **`Motorista`** (curada) |
| Origem da linha `Motorista` | criada só no cadastro (com senha) | **criada no upload** (nome+CNPJ, sem senha) |
| Cadastro no app | `INSERT` nova linha | **`UPDATE`** da senha/nome na linha existente |
| CNPJ ausente da base | 409 genérico | **aviso amigável** "não é possível criar o cadastro" |
| Edição de motoristas | inexistente | **CRUD** no painel (atualiza `Motorista`) |
| `senha` no pré-cadastro | NOT NULL | **nullable** (linha existe sem senha até o motorista se cadastrar) |

---

## 4. Schema & DDL proposto (`008`, aplicada pelo operador)

DDL `008-cadastro-motorista-base.sql` (idempotente):
1. `ALTER TABLE "Motorista" ALTER COLUMN senha DROP NOT NULL;` — permite pré-cadastro
   (linha vinda do upload sem senha). Login/`register` tratam `senha NULL` (ver §5).
2. (Decisão §6.2) Eventual coluna de vínculo multi-tenant (`id_empresa`/`id_grupo`) **ou**
   nenhuma — depende do modelo escolhido na clarify.
3. (Opcional) `UNIQUE (cnpj_prestador)` se ainda não houver — garante upsert determinístico
   e 1 conta por CNPJ. Verificar constraint atual antes.
4. `GRANT SELECT, INSERT, UPDATE ON "Motorista" TO authenticated;` (padrão 003/004/007;
   só os verbos usados).
5. **Seed de migração** (separado, `008b`): popular `Motorista` a partir do histórico de
   `EnvioMassa` — `INSERT ... SELECT DISTINCT cnpj_prestador, nome ... WHERE NOT EXISTS`
   (sem senha). Para os motoristas que já têm conta hoje (3), preservar senha.

---

## 5. Implementação — 3 frentes

### A) Upload popula `Motorista` (upsert) — `server.js` (após o INSERT em `EnvioMassa`, ~1491)
Para cada `cnpj_prestador` **distinto** do lote, garantir uma linha em `Motorista`:
- Se não existe → `INSERT { cnpj_prestador, nome, ativo:true }` (sem senha).
- Se existe → **não tocar `senha`**; atualizar `nome` só se estiver vazio (não sobrescrever
  nome curado no CRUD — decisão §6.4).
- Idempotente e tolerante a falha (não derrubar o upload se o upsert do motorista falhar —
  log + segue; o movimento em `EnvioMassa` é o dado primário). Reusar `onlyDigits`.

### B) Gate de cadastro por `Motorista` + definir senha — `motorista.js:199` (`/register`)
- Trocar **Guard 1** de `EnvioMassa` → **`Motorista?cnpj_prestador=eq.<cnpjNorm>`**.
- Se **não existe** linha → **409 genérico** (mensagem amigável; anti-enumeração mantida).
- Se **existe e já tem senha** → 409 genérico ("já possui conta") — mesma msg (anti-enum).
- Se **existe e senha nula** (pré-cadastro do upload) → **`UPDATE`** `senha=bcrypt.hash`,
  `nome` (se vier), `ativo:true`. Retorno 201/200 "Conta criada".
- `/login`: tratar `senha NULL` como credencial inválida sem crash (padrão `senha || DUMMY_HASH`
  já usado no corte do login único — ver [[feature-grupo-unificado-filiais]]).

### C) CRUD de motoristas — novo, no painel `frontend_v2` + endpoints backend
- **Endpoints** (em `routes/motorista.js` ou novo `routes/admin-motorista.js`, sob
  `authenticateToken` de **empresa**, não do motorista):
  - `GET /admin/motoristas` — lista os motoristas **no escopo do admin logado**
    (ver §6.1 multi-tenant) com paginação/busca por CNPJ/nome.
  - `PUT /admin/motoristas/:id` — edita `nome`/`ativo` (e CNPJ? §6.5). Valida `:id`
    (`parseInt`+`Number.isInteger`+`>0`, padrão HIGH-002). **Nunca** retorna/edita `senha`
    hash diretamente; "resetar senha" = setar `senha=NULL` (motorista refaz cadastro) —
    decisão §6.6.
  - `POST /admin/motoristas` — (opcional) cadastro manual de motorista pelo admin.
  - `DELETE /admin/motoristas/:id` — (decisão §6.7) hard delete vs `ativo=false`.
- **Tela**: nova rota em `frontend_v2/app/dashboard/` (ex.
  `dashboard/motoristas/page.tsx`), no padrão visual já existente (tabela + modal de edição,
  como a aba grupo de [[feature-grupo-unificado-filiais]]). Toda edição → `PUT` → `Motorista`.

---

## 6. Ambiguidades para resolver COM o operador (CLARIFY — NÃO deduzir)

1. **Multi-tenant do CRUD (o ponto mais importante).** `Motorista` é **global** (sem
   `id_empresa`). Um mesmo CNPJ de prestador pode ter movimento de **várias** empresas. Como
   o admin enxerga "seus" motoristas?
   - **(rec.) Escopo derivado de `EnvioMassa`**: o CRUD lista/edita só motoristas cujo
     `cnpj_prestador` aparece no movimento das empresas no escopo do admin
     (`resolveScope`/`resolveEmpresaAlvo`, [[feature-movimento-por-filial]]). Sem mudar o
     schema; preserva Princípio II (multi-tenant) e evita BOLA.
   - Alternativa: adicionar `id_empresa`/`id_grupo` à `Motorista` (1ª empresa que importou)
     — mais simples de filtrar, mas modela mal o caso 1 motorista→N empresas.
2. **`senha` nullable**: confirmar o `DROP NOT NULL` (pré-cadastro sem senha). OK?
3. **Migração inicial** (`008b`): popular `Motorista` do histórico de `EnvioMassa` já
   existente? (senão, só motoristas de uploads futuros entram na base.)
4. **Upsert de `nome` no upload**: na reimportação, atualizar o `nome` sempre, ou só quando
   vazio (preservando edição manual do CRUD)? (rec.: só quando vazio.)
5. **CRUD pode editar o CNPJ?** (rec.: **não** — CNPJ é a chave/identidade; editar quebra o
   vínculo com o movimento. Permitir só `nome`/`ativo`.)
6. **"Resetar senha" pelo admin**: setar `senha=NULL` (motorista refaz o cadastro) vs gerar
   senha temporária? (rec.: `NULL` + refazer — não expõe senha.)
7. **Excluir motorista**: hard delete vs `ativo=false` (soft). (rec.: soft, preserva histórico.)
8. **Mensagem amigável** exata do bloqueio ("Seu CNPJ não está na base de motoristas
   habilitados. Procure a empresa contratante."?) — manter **anti-enumeração** (mesma msg
   para CNPJ ausente e conta já existente)? Há tensão UX×segurança: aviso muito específico
   ("não está na base") enfraquece o anti-enum do FR-017 atual. Decidir o trade-off.
9. **`ativo` e elegibilidade**: pré-cadastro nasce `ativo=true` (mas sem senha não loga) —
   ok? `ativo=false` no CRUD bloqueia login (já hoje) **e** deve bloquear novo cadastro?

---

## 7. Segurança (owasp-security obrigatório — mexe em auth/cadastro)

- **Anti-enumeração** (FR-017 atual): hoje 409 genérico. Se §6.8 escolher msg específica,
  documentar o trade-off no PR (como foi feito no HIGH-001 do login único).
- **BOLA/multi-tenant no CRUD** (A01/API1): `PUT/DELETE /admin/motoristas/:id` deve checar
  que o motorista está no escopo do admin (§6.1) → senão **403 genérico** ("não encontrado").
  `parseInt`+`Number.isInteger`+`>0` no `:id` (padrão HIGH-002).
- **Senha**: nunca trafega/retorna hash; `bcrypt` cost ≥10 (subir p/ 12 é INFO-001 backlog).
  Login trata `senha NULL` sem crash (`senha || DUMMY_HASH`).
- **Injeção PostgREST**: CNPJ sempre `onlyDigits` antes de interpolar; `:id` inteiro.
- **AuthZ de rota**: `/admin/motoristas*` sob `authenticateToken` de **empresa** (não
  `authenticateMotorista`); o motorista não acessa o CRUD.

## 8. Validação (E2E em homologação)

- Upload de planilha com `cnpj_prestador` novo → linha aparece em `Motorista` (sem senha).
- Cadastro com CNPJ **na base** → senha definida, login OK.
- Cadastro com CNPJ **fora da base** → 409 + aviso amigável; nenhuma linha criada.
- Cadastro com CNPJ que **já tem senha** → 409 (já possui conta).
- CRUD: admin do grupo X edita motorista do seu escopo (200); de outro escopo → 403
  genérico (BOLA). `:id` inválido → 400. `ativo=false` → login do motorista 403.
- **Não exercitar `/validar-nota` via HTTP** (dispara validação fiscal real). Cobrir login,
  cadastro, upload e CRUD. Reusar o banco de homologação (`chatmasterveloz`@`pgadmin_db`).

## 9. Governança / operação

- Backend roda **node:14** — não subir libs incompatíveis (ver `express-rate-limit@6.11.2`).
- Deploy homologação: **`docker service update --image`** (preserva env/labels; nunca
  `docker stack deploy`). Imagem `registry.todo-tips.com/envio-massa-backend`.
- DDL `008`/`008b` **aplicada pelo operador**. **Produção** (levantamento, DDL, deploy,
  qualquer ação) é **exclusiva do operador** — [[regra-nao-tocar-producao]]. Commit/push/
  merge/deploy só com autorização explícita; commit termina com
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Reusar SDD/feature-00c se desejado (specify→clarify→plan→checklist→create-tasks→
  execute-task→review-task), como nas features anteriores.

---

## Prompt de retomada (colar na sessão fresca / cstk)

```
Implemente a feature "cadastro de motorista restrito à base validada (tabela Motorista) +
CRUD". LEIA PRIMEIRO: docs/plans/cadastro-motorista-base-validada.md (este plano — tem o
mapa do código atual, o gap e as ambiguidades) e as memórias [[feature-grupo-unificado-filiais]],
[[feature-movimento-por-filial]], [[validacao-nota-motorista]] e [[regra-nao-tocar-producao]].

OBJETIVO: só motoristas presentes na tabela Motorista podem criar conta no appmotorista. A
Motorista passa a ser populada pelo upload da planilha de movimento (server.js:1283/1491 —
capturar cnpj_prestador+nome). No cadastro (motorista.js:199 /register) o CNPJ tem de existir
em Motorista: se não, aviso amigável; se sim (pré-cadastro do upload, sem senha), define a
senha (UPDATE, não INSERT). Entregar CRUD de motoristas no painel envmassv2 (página nova +
endpoints /admin/motoristas sob auth de empresa) — toda edição atualiza Motorista.

NA CLARIFY, resolva COMIGO (não deduza) os 9 itens da §6 do plano — em especial (1) o modelo
multi-tenant do CRUD (recomendo escopo derivado de EnvioMassa via resolveScope, sem mudar o
schema), (2) senha nullable (DDL 008 DROP NOT NULL), (3) migração inicial do histórico, e
(8) o trade-off UX×anti-enumeração da mensagem de bloqueio.

Implemente nas 3 frentes (upload→upsert Motorista; /register gate por Motorista + UPDATE
senha; CRUD), gere as DDLs 008/008b (aplicadas por mim), rode owasp-security e valide E2E em
homologação. Backend roda node:14. Deploy: docker service update --image. Produção é só
minha (não tocar). Commit/push/merge/deploy só com minha autorização explícita.
```
