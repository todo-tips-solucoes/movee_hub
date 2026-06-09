# Research: Cadastro de Filiais

Resolução dos unknowns técnicos antes do design (Phase 0). Todas as decisões
abaixo eliminam NEEDS CLARIFICATION; nenhuma fica pendente para implementação.

## Decision 1 — Injeção de bcrypt em grupo.js

**Decision**: Alterar a assinatura para `init({ postgrestRequest, bcrypt })` em
`routes/grupo.js` e passar `bcrypt` no mount do `server.js` (~linha 1825):
`grupoRoutes.init({ postgrestRequest, bcrypt })`.

**Rationale**: `grupo.js` hoje recebe só `{ postgrestRequest }` (linhas 26-28,
confirmado empiricamente). O `bcrypt` já é `require`-ado no topo do `server.js`
(usado por `POST /register`). Injetar a instância existente mantém uma única
dependência de hashing no processo e evita acoplar `routes/grupo.js` a um novo
`require('bcrypt')` direto. É a mudança de menor superfície (uma chave a mais no
objeto de init, um campo a mais no destructuring).

**Alternatives considered**:
- *Helper compartilhado `criarEmpresa(...)` no server.js injetado em grupo.js*:
  evita acoplar bcrypt à rota, mas cria uma indireção a mais e duplica a
  responsabilidade de "como criar uma Empresa" entre `register` e `grupo`.
  Rejeitado por overhead sem ganho — `POST /register` e `POST /grupo/empresas`
  têm validações e vínculos diferentes (register não tem id_grupo/cnpj/limite).
- *`require('bcrypt')` direto em grupo.js*: rejeitado — quebra o padrão de
  injeção de dependências já estabelecido (`init({...})`), dificultando teste.

## Decision 2 — Coluna `cnpj`: tipo e UNIQUE

**Decision**: `ADD COLUMN IF NOT EXISTS cnpj text;` + constraint UNIQUE em `cnpj`.
Tipo `text` (não `numeric`/`char(14)`), armazenando exatamente 14 dígitos
(validação de formato no backend, não no banco).

**Rationale**: `text` evita perda de zeros à esquerda (CNPJ pode começar com 0)
e não impõe semântica numérica a um identificador. UNIQUE em PostgreSQL **permite
múltiplos NULL** — empresas pré-existentes sem CNPJ permanecem válidas (não
violam a constraint), e só novos cadastros (que exigem CNPJ) competem por
unicidade. Alinha com a observação do plano de referência (§10) e do contexto.

**Alternatives considered**:
- *`char(14)` NOT NULL*: rejeitado — NOT NULL quebraria todas as Empresas
  existentes sem CNPJ; a feature não tem mandato de backfill.
- *Validação de 14 dígitos no banco (CHECK)*: rejeitado para o MVP — a regra de
  formato vive no backend (mensagem de erro em português, FR-003/SC-002);
  duplicar no banco adiciona acoplamento sem ganho imediato.

## Decision 3 — Gating da degradação (cnpj antes do DDL)

**Decision**: Assumir que o **operador aplica o DDL 004 ANTES do deploy do
backend** que usa a coluna `cnpj`. Nenhum gate de feature no runtime.

**Rationale**: o plano de deploy (§8 do plano de referência) já estabelece que
"se criar .sql, o operador aplica o DDL + GRANT antes do deploy do backend".
Replicar esse contrato operacional aqui evita código de feature-flag/probe de
schema (que adicionaria complexidade e um caminho de erro silencioso). O
`POST /grupo/empresas` é novo — não existe tráfego legado batendo nele antes do
deploy, então não há janela de incompatibilidade em produção se a ordem
DDL→deploy for respeitada.

**Alternatives considered**:
- *Probe de schema em runtime + degradar (gravar sem cnpj)*: rejeitado — gravar
  filial sem CNPJ violaria FR-001/FR-003 silenciosamente; melhor falhar no
  deploy mal-ordenado (visível ao operador) do que aceitar dado inconsistente.

## Decision 4 — Idempotência sem transação

**Decision**: Reusar o padrão "get-or-create" de `Grupo` por
`id_empresa_pai UNIQUE`. O fluxo é: (1) `resolveOrCreateGrupo(user)` → garante
o `Grupo` do pai; (2) checar limite de 100; (3) `POST Empresa` já com
`id_grupo` resolvido. Sem PATCH em segundo passo.

**Rationale**: PostgREST não oferece transação multi-statement via
`postgrestRequest`. A criação do `Grupo` é idempotente porque
`Grupo.id_empresa_pai` é UNIQUE (criar duas vezes → a 2ª falha/é absorvida; a
resolução sempre relê o existente). Como o `id_grupo` vai direto no `POST
Empresa` (em vez do create+PATCH do fluxo de vínculo), a janela de
inconsistência some: ou a Empresa nasce já vinculada, ou o POST falha por
inteiro. Falha parcial possível: Grupo criado mas Empresa falha — aceitável,
pois um Grupo vazio é inócuo e será reusado no próximo cadastro.

**Alternatives considered**:
- *Função RPC PostgreSQL transacional (PostgREST `/rpc`)*: rejeitado para o MVP
  — exigiria nova função no banco aplicada pelo operador, ampliando o escopo de
  DDL além da coluna `cnpj`. Reavaliar se inconsistências aparecerem em produção.

## Decision 5 — Mapeamento de erros → códigos HTTP

**Decision**:
- `nome_empresa` ausente/vazio → `400` (campo obrigatório).
- `email` formato inválido → `400`; e-mail já existente (`Empresa?email=eq.{email}`) → `400` (duplicata — FR-004).
- `senha` fraca (regra mínima) → `400`.
- `cnpj` != 14 dígitos numéricos → `400`; CNPJ já existente → `409` (FR-003).
- limite de 100 filiais atingido → `422` (FR-006).
- não-admin (`is_grupo_pai !== true`) → `403` via `requireGrupoPai` (FR-007).
- sucesso → `201` com `{ id, nome_empresa, email, id_grupo }`.

**Rationale**: alinha com os códigos já decididos na spec (FR-003..FR-007) e com
o padrão dos endpoints de grupo existentes (`GET /filhos` retorna 422 no limite;
`DELETE` retorna 400 em param inválido, 403 em não-admin). E-mail duplicado é
`400` (decisão da spec) enquanto CNPJ duplicado é `409` — diferença deliberada
herdada da spec/clarify para distinguir os dois tipos de duplicata ao frontend.

**Alternatives considered**:
- *E-mail duplicado como 409*: rejeitado — a spec (FR-004) fixou 400 para e-mail
  e 409 para CNPJ; o frontend mapeia mensagens por código, então a distinção é
  intencional.

## Decision 6 — Regra de senha

**Decision**: Reusar a regra do `register/page.tsx`: `length >= 6 && /[A-Z]/ &&
/\d/` (mínimo 6 caracteres, ao menos 1 maiúscula, ao menos 1 dígito). Frontend
reaproveita o componente `PasswordStrength`. Backend revalida a mesma regra.

**Rationale**: consistência com o cadastro de empresa existente; o admin define
a senha da filial (decisão confirmada na fase clarify — sem fluxo de primeiro
acesso). Revalidar no backend evita confiar só no cliente (defesa em
profundidade). FR-005 exige login imediato → senha definida pelo admin é a
credencial final.

**Alternatives considered**:
- *Senha temporária + troca no 1º login*: rejeitado na clarify — não há fluxo de
  primeiro acesso no sistema; admin define a senha final (MVP do plano §3).

## Decision 7 — Case style da borda

**Decision**: snake_case em todas as camadas (DB, PostgREST, request body,
response body, estado do frontend). Sem mapper snake↔camel.

**Rationale**: os endpoints de grupo existentes (`GET/DELETE /filhos`) já
operam em snake_case (`nome_empresa`, `id_grupo`). Padronizar o novo endpoint em
snake_case elimina drift e mapper. O `register` usa camelCase no body apenas por
tradução interna do `POST /register`, que não se aplica aqui. O `id_grupo` nunca
aparece no body de request (Princípio II).

**Alternatives considered**:
- *camelCase no body (como register)*: rejeitado — divergiria dos outros
  endpoints de grupo e exigiria mapper; fonte conhecida de drift (histórico
  dec-172/dec-173 citado no template do plan).
