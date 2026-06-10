# Feature Specification: Grupo Unificado de Filiais

**Short name**: `grupo-unificado-filiais`
**Status**: Clarified
**Version**: 0.1.0
**Date**: 2026-06-10

## Visão Geral

O sistema atual trata a Movee (empresa de id 6) com comportamento especial
em pontos críticos: canal de envio de mensagens, template Meta, validação
de datas no upload de planilha e validação de NFSe. Esse privilégio está
hardcoded como `id_empresa === 6`, o que significa que as filiais do grupo
Movee — criadas pela feature `cadastro-filiais` — não herdam o mesmo
comportamento.

Esta feature unifica o grupo em três frentes:

- **A) Comportamento por grupo**: o comportamento especial da Movee passa a
  ser determinado por pertencimento ao grupo, não por ID fixo. Filiais do grupo
  automaticamente herdam o canal whatsmeow, a isenção de template Meta, o upload
  sem data obrigatória e a validação NFSe via API da Movee.

- **B) Edição de filiais**: o admin de grupo hoje só cria filiais. Passa a
  poder editar os dados de uma filial existente pela mesma tela de gestão.

- **C) Login único do grupo**: um único login (do grupo) opera todas as
  filiais via o seletor de empresa. Filiais não têm login próprio.

> **Decisões de infraestrutura**: N/A para A e B (stateless, sem scheduling).
> C — **RESOLVIDO na clarify**: implementação somente em lógica de aplicação;
> SEM DDL. O login único reutiliza as credenciais da empresa-pai (id=6) já
> existentes. Filiais (id_grupo != null e não-pai) têm login NEGADO com HTTP
> 403. NÃO gerar `docs/sql/007-*`.

---

## User Scenarios & Testing

### User Story 1 — Filial do grupo envia mensagem pelo canal certo (Priority: P1)

Como admin de um grupo de empresas que usa o canal whatsmeow da Movee, quero
que qualquer filial do grupo consiga enviar mensagens pelo mesmo canal — sem
precisar que cada filial tenha um ID especial cadastrado manualmente.

**Why this priority**: É o impacto mais crítico e imediato do hardcode atual.
Filiais criadas hoje não conseguem enviar mensagens pelo canal correto, o que
torna o grupo de empresas inoperante para envio.

**Independent Test**: Autenticar como admin de uma filial do grupo Movee,
iniciar um envio em massa. O envio deve usar o canal whatsmeow (não o
template Meta). Uma empresa sem grupo deve continuar usando o canal Meta.

**Acceptance Scenarios**:

1. **Given** uma empresa filial do grupo Movee autenticada no painel, **When**
   ela dispara um envio em massa, **Then** o sistema usa o canal whatsmeow para
   o envio — o mesmo canal que a empresa-pai usa hoje.

2. **Given** uma empresa sem grupo cadastrado autenticada no painel, **When**
   ela dispara um envio em massa, **Then** o sistema continua usando o canal
   template Meta — comportamento atual preservado.

3. **Given** a empresa-pai Movee autenticada no painel, **When** ela dispara
   um envio em massa, **Then** o comportamento continua idêntico ao de hoje
   (sem regressão).

4. **Given** uma filial do grupo Movee, **When** ela faz upload de planilha de
   envio, **Then** os campos de data inicial e data final são opcionais —
   exatamente como a Movee-pai funciona hoje.

5. **Given** uma filial do grupo Movee, **When** ela valida uma nota NFSe
   (XML), **Then** o sistema usa a API de validação da Movee — o mesmo endpoint
   que a empresa-pai usa hoje.

---

### User Story 2 — Admin de grupo edita dados de uma filial (Priority: P2)

Como admin de um grupo de empresas, quero editar os dados de uma filial já
cadastrada — nome, CNPJ, e-mail e dados fiscais — pela mesma tela de gestão
de filiais, sem precisar recriar a filial do zero.

**Why this priority**: Complemento direto ao cadastro de filiais (feature
`cadastro-filiais`). Dados mudam (nome fantasia, endereço fiscal, e-mail de
contato) e o admin precisa corrigi-los sem intervenção manual no banco.

**Independent Test**: Autenticar como admin de grupo (`is_grupo_pai = true`),
abrir a lista de filiais, clicar em "editar" em uma filial existente,
alterar um campo e salvar. A mudança deve aparecer na lista sem recriar a
filial.

**Acceptance Scenarios**:

1. **Given** um admin de grupo autenticado na tela de gestão de filiais,
   **When** ele clica em "editar" em uma filial da lista, **Then** o sistema
   abre um formulário pré-preenchido com os dados atuais da filial.

2. **Given** o formulário de edição pré-preenchido, **When** o admin altera o
   nome da empresa e salva, **Then** o sistema atualiza o registro e exibe o
   novo nome na lista de filiais.

3. **Given** o formulário de edição, **When** o admin tenta salvar com CNPJ
   já pertencente a outra empresa do sistema, **Then** o sistema bloqueia a
   atualização e exibe erro "CNPJ já cadastrado".

4. **Given** o formulário de edição, **When** o admin tenta salvar com e-mail
   já pertencente a outra empresa, **Then** o sistema bloqueia e exibe erro
   "E-mail já cadastrado".

5. **Given** um admin de grupo tentando editar uma filial que NÃO pertence ao
   seu grupo, **When** a requisição chega ao sistema (mesmo que manipulada),
   **Then** o sistema recusa a operação com erro de autorização — sem modificar
   nenhum dado.

6. **Given** uma empresa sem perfil de admin de grupo (sem `is_grupo_pai`),
   **When** ela tenta acessar a edição de filiais, **Then** a tela não é
   exibida e a ação é negada.

---

### User Story 3 — Login único do grupo opera todas as filiais (Priority: P3)

Como operador do grupo Movee, quero fazer login com uma única credencial do
grupo e operar qualquer filial pelo seletor de empresa — sem precisar manter
senhas separadas para cada filial.

**Why this priority**: P3 porque as ambiguidades de autenticação precisam ser
resolvidas antes de implementar (ver seção Clarifications). Mudança de modelo
auth impacta todas as empresas do grupo e exige backward-compat cuidadoso.

**Independent Test**: Fazer login com a credencial do grupo, verificar que o
seletor de empresa lista empresa-pai e todas as filiais, alternar entre elas e
confirmar que os dados de movimento exibidos correspondem à empresa
selecionada.

**Acceptance Scenarios**:

1. **Given** as credenciais da empresa-pai (e-mail/senha do id=6), **When** o
   operador faz login, **Then** o sistema autentica com sucesso e apresenta
   o seletor de empresa listando a empresa-pai e todas as filiais ativas do
   grupo.

2. **Given** o operador logado com a credencial do grupo, **When** ele
   seleciona uma filial no seletor, **Then** todas as operações (envio,
   movimento, upload) são realizadas no contexto dessa filial — sem
   re-autenticação.

3. **Given** que filiais têm e-mail cadastrado (feature `cadastro-filiais`),
   **When** uma empresa-filial (id_grupo != null, is_grupo_pai = false) tenta
   fazer login com seu e-mail/senha, **Then** o sistema retorna HTTP 403 com
   body `{"error":"Acesse o painel usando o login do grupo"}` — sem criar
   sessão.

4. **Given** uma empresa sem grupo (standalone), **When** ela faz login com
   seu e-mail e senha, **Then** o comportamento é idêntico ao atual — sem
   impacto desta mudança.

5. **Given** o operador do grupo logado, **When** o token expira e é
   renovado (refresh), **Then** o contexto de grupo (`id_grupo`,
   `is_grupo_pai`) é preservado no novo token.

---

### Edge Cases

- **Empresa pertence a grupo mas o grupo não tem empresa-pai definida**: o
  helper de pertencimento deve tratar graciosamente (sem crash); comportamento
  do sistema cai para "sem grupo".
- **Grupo Movee sem filiais cadastradas**: upload e validação NFSe da
  empresa-pai continuam funcionando exatamente como hoje.
- **Filial removida do grupo enquanto operador está logado**: na próxima
  operação que depender do escopo do grupo, o sistema deve re-validar o
  pertencimento; não deve permitir operações em empresa que saiu do grupo.
- **Performance no loop de envio em massa**: a verificação de pertencimento ao
  grupo não deve disparar uma consulta ao banco por mensagem individual.
  O resultado deve ser resolvido uma única vez por ciclo de envio.
- **Backward-compat**: empresas sem grupo (`id_grupo = null`) não devem ser
  afetadas por nenhuma mudança desta feature. Qualquer ramificação nova deve
  ter o ramo "sem grupo" como caminho padrão.
- **DDL (item C)**: o módulo C não exige DDL (CL-003 resolvido). Os três
  módulos A, B e C podem ser implantados juntos sem dependência de migração
  de schema para C.

---

## Requirements

### Functional Requirements

**Módulo A — Comportamento por Grupo**

- **FR-001**: O sistema DEVE determinar o canal de envio de mensagens com
  base em pertencimento ao grupo da Movee, não por ID de empresa fixo. Toda
  empresa que pertence ao grupo da Movee usa o canal whatsmeow; demais
  empresas usam o canal template Meta.

- **FR-002**: O sistema DEVE determinar a obrigatoriedade de datas no upload
  de planilha com base em pertencimento ao grupo da Movee. Empresas do grupo
  não precisam informar `dt_inicial` e `dt_final`; demais empresas continuam
  com os campos obrigatórios.

- **FR-003**: O sistema DEVE determinar o endpoint de validação de NFSe com
  base em pertencimento ao grupo da Movee. Empresas do grupo usam a API
  fastapihomologacao da Movee; demais empresas usam o endpoint padrão.

- **FR-004**: O sistema DEVE determinar se o template Meta é aplicado com
  base em pertencimento ao grupo da Movee. Empresas do grupo pulam a lógica
  de template; demais empresas seguem o fluxo atual.

- **FR-005**: O resultado de pertencimento ao grupo DEVE ser resolvido no
  máximo uma vez por ciclo de operação (envio, upload, validação) — nunca
  uma consulta por item/mensagem individual.

- **FR-006**: Empresas sem grupo (`id_grupo = null`) DEVEM manter o
  comportamento atual sem nenhuma alteração.

- **FR-007**: O ramo de comportamento especial para `id_empresa === 16` DEVE
  ser preservado exatamente como está — fora do escopo desta feature.

**Módulo B — Edição de Filiais**

- **FR-008**: O sistema DEVE permitir que o admin de grupo atualize os dados
  de uma filial existente: nome da empresa, e-mail, CNPJ e dados fiscais
  (endereço, número, CEP, e-mail de nota, observação).

- **FR-009**: A operação de edição DEVE ser restrita ao admin de grupo
  (`is_grupo_pai = true`) e somente para filiais que pertencem ao grupo do
  token autenticado.

- **FR-010**: O sistema DEVE rejeitar atualização de e-mail ou CNPJ para um
  valor já existente em outra empresa, com mensagem de erro específica por
  campo.

- **FR-011**: O formulário de edição DEVE ser pré-preenchido com os dados
  atuais da filial ao ser aberto.

- **FR-012**: A tela de edição DEVE ser acessível a partir da lista de filiais
  existente (feature `cadastro-filiais`), sem introduzir nova rota de
  navegação de primeiro nível.

**Módulo C — Login Único do Grupo**

- **FR-013**: O sistema DEVE autenticar o operador do grupo com a credencial
  existente da empresa-pai (e-mail/senha da empresa de `id = 6` no banco).
  Nenhuma credencial nova é criada; nenhum DDL é necessário. O login da
  empresa-pai já carrega `is_grupo_pai = true` no token, o que concede acesso
  a todas as filiais ativas do grupo via o seletor de empresa.
  *(CL-001 = Opção A — RESOLVIDO)*

- **FR-014**: O sistema DEVE listar empresa-pai e todas as filiais no seletor
  de empresa após login do grupo, permitindo alternar entre elas sem
  re-autenticação.

- **FR-015**: O sistema DEVE negar o login de empresa-filial
  (`id_grupo != null` e `is_grupo_pai = false`) no endpoint `POST /login`
  com resposta HTTP 403 e body `{"error":"Acesse o painel usando o login do
  grupo"}`. A lógica é implementada no `server.js:142` usando o campo
  `id_grupo` derivado da tabela `Grupo`. Breaking change controlado pelo
  operador via deploy.
  *(CL-002 = Opção A — RESOLVIDO)*

- **FR-016**: O token de sessão do grupo DEVE carregar as informações
  necessárias para que o seletor de empresa e o escopo de dados funcionem
  corretamente para todas as filiais, preservando o isolamento multi-tenant
  (Constitution Princípio II).

- **FR-017**: Empresas standalone (sem grupo) NÃO DEVEM ser impactadas pela
  mudança de login. Seu fluxo de autenticação permanece idêntico ao atual.

- **FR-018**: O módulo C NÃO exige DDL. A implementação é somente em lógica
  de aplicação: o `POST /login` verifica se a empresa autenticada tem
  `id_grupo != null` e `is_grupo_pai = false` (via JOIN com a tabela `Grupo`)
  e, em caso afirmativo, retorna 403 sem completar o login. Nenhum script
  `docs/sql/007-*` será gerado para este módulo.
  *(CL-003 = Sem DDL — RESOLVIDO)*

- **FR-019**: A empresa-pai do grupo (matriz) DEVE ser editável via a aba de
  gestão de grupo, listada junto com as filiais com o atributo `is_pai: true`.
  O endpoint `GET /grupo/filhos` DEVE incluir a empresa-pai na listagem.
  O endpoint `PUT /grupo/empresas/:id` NÃO DEVE bloquear edição da própria
  empresa-pai — a proteção cross-grupo (`empresa.id_grupo === token.id_grupo`)
  permanece; somente a restrição de editar a si mesmo é relaxada para a matriz.
  O login único NÃO é afetado: a empresa-pai continua sendo a única credencial
  válida para o grupo. O frontend exibe a matriz com rótulo "Matriz" e sem
  o botão de desvincular.
  *(Decisão do operador durante execução — dec-030, 2026-06-10)*

### Key Entities

| Entidade | Papel nesta feature |
|----------|---------------------|
| `Empresa` | Unidade central — tem `id_grupo` (FK para Grupo) e `is_grupo_pai` (derivado). Toda empresa, inclusive a pai, é tratada como membro do grupo. |
| `Grupo` | Agrupa empresas sob uma empresa-pai. Campo `id_empresa_pai` identifica o administrador. |
| `Grupo.pertencimento` | Relação lógica verificada em runtime: "empresa X pertence ao grupo da empresa Y?" — base dos FRs 001-005. |
| Token de sessão | Carrega `empresaId`, `id_grupo`, `is_grupo_pai` — o seletor de empresa (movimento-por-filial) já usa esses campos. |

---

## Clarifications

Questões sobre o módulo C (Login Único) — todas RESOLVIDAS pelo operador
antes do `plan` (onda 3, 2026-06-10).

### CL-001 — Credencial de login do grupo [RESOLVIDA]

**Decisão do operador**: **Opção A** — o login único do grupo usa as
credenciais da empresa-pai (id=6) já existentes. SEM credencial nova, SEM DDL.
A empresa-pai já loga hoje com `is_grupo_pai = true` no token; esse campo
existente é suficiente para autorizar acesso a todas as filiais via seletor.

---

### CL-002 — Tratamento de filiais com login existente [RESOLVIDA]

**Decisão do operador**: **Opção A** — filial (`id_grupo != null` e não-pai)
tem login **NEGADO** no `POST /login` com **HTTP 403** + body
`{"error":"Acesse o painel usando o login do grupo"}`. Breaking change
controlado pelo operador via deploy. As filiais que tinham senha cadastrada
perdem o acesso direto; devem usar o login da empresa-pai.

---

### CL-003 — Necessidade de DDL para o módulo C [RESOLVIDA]

**Decisão do operador**: **Sem DDL**. Implementação é somente lógica de
aplicação no `POST /login` (verificar `id_grupo` via JOIN com tabela `Grupo`).
NÃO gerar `docs/sql/007-*` para o módulo C. Senha continua no banco, apenas
o login é bloqueado por lógica de app.

**Decisão complementar (FR-B / senha no cadastro)**: no `POST`/`PUT
/grupo/empresas` a senha passa a ser **OPCIONAL/IGNORADA** (não gravada) para
filiais; e-mail continua OBRIGATÓRIO e UNIQUE como identificador. Sem mudança
de constraint.

---

## Success Criteria

### Measurable Outcomes

**Módulo A — Comportamento por Grupo**

- 100% dos envios de filiais do grupo Movee usam o canal whatsmeow — sem
  nenhum envio sendo roteado erroneamente para o canal Meta.
- 100% dos uploads de planilha de filiais do grupo aceitam linhas sem
  `dt_inicial` / `dt_final` sem erro de validação.
- 0 regressões para empresas sem grupo: todas continuam funcionando como
  antes da feature.
- A verificação de pertencimento ao grupo é realizada no máximo 1 vez por
  ciclo de operação (mensurável por log/trace de consultas ao banco).

**Módulo B — Edição de Filiais**

- Admin de grupo consegue editar qualquer filial do seu grupo em menos de
  30 segundos (do clique em "editar" até o retorno de confirmação de sucesso).
- 100% das tentativas de editar filial de outro grupo são rejeitadas com erro
  de autorização — zero vazamento de dados cross-grupo.
- Formulário de edição exibe dados atuais corretos em 100% das aberturas
  (sem campos em branco indevidos).

**Módulo C — Login Único**

- O operador de grupo consegue fazer login e alternar entre todas as filiais
  do grupo sem nenhuma re-autenticação.
- 0 impacto em empresas standalone: seus logins e sessões continuam
  funcionando exatamente como antes.
- O seletor de empresa lista empresa-pai + todas as filiais ativas imediatamente
  após o login do grupo.
- Revisão OWASP (Top 10) não identifica vulnerabilidades de severidade
  critical ou high no fluxo de autenticação modificado.
