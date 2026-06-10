# Feature Specification: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial`
**Created**: 2026-06-10
**Status**: Draft

## Visão Geral

Administradores de grupos de empresas precisam visualizar e operar o movimento
(EnvioMassa — lista de notas fiscais/XMLs importados) separado por empresa/filial.
Hoje, o painel mostra apenas o movimento da própria empresa logada. Com esta feature,
um seletor de filial (combobox pesquisável) aparece no cabeçalho da página de
movimento, permitindo alternar entre a empresa-pai e as filiais cadastradas — e
todas as operações (listar, importar, exportar, baixar XML, fechar, deletar, editar)
passam a refletir a filial selecionada.

Para administradores de empresa única (sem filiais), a interface permanece exatamente
igual ao comportamento atual — sem seletor visível e sem regressão.

> **Decisões de infraestrutura**: N/A — feature stateless do ponto de vista de
> scheduling e rotação de chaves. A persistência do estado de seleção é feita
> exclusivamente via query param na URL (sem sessão, sem banco adicional).

---

## User Scenarios & Testing

### User Story 1 — Admin de grupo seleciona filial e visualiza movimento dela (Priority: P1)

Como administrador de um grupo de empresas, quero escolher uma empresa/filial
num seletor pesquisável no topo da página de movimento para que a listagem mostre
apenas os registros da filial selecionada — e consiga alternar entre filiais sem
sair da página.

**Why this priority**: É o núcleo da feature. Sem o seletor e o filtro de
listagem por filial, nenhuma das demais operações (importar, exportar, fechar)
tem contexto de filial. Todas as outras stories dependem desta.

**Independent Test**: Autenticar como admin de grupo (`is_grupo_pai = true`)
com ao menos uma filial cadastrada, acessar a página de movimento e usar o
combobox para alternar entre a empresa-pai e uma filial. Verificar que a listagem
muda de conteúdo a cada seleção.

**Acceptance Scenarios**:

1. **Given** um admin de grupo autenticado com duas ou mais empresas no grupo,
   **When** ele acessa a página de movimento,
   **Then** o seletor de filial aparece no cabeçalho da página, exibindo a
   empresa-pai como seleção padrão, e a listagem de movimento corresponde
   àquela empresa.

2. **Given** o seletor exibindo a empresa-pai selecionada,
   **When** o admin escolhe uma filial no combobox,
   **Then** a listagem é recarregada automaticamente com os registros da
   filial selecionada, sem confirmação prévia do usuário.

3. **Given** o admin ter selecionado uma filial,
   **When** ele copia e abre a URL da página em outra aba do navegador,
   **Then** a filial selecionada está preservada na nova aba (URL contém
   o identificador da filial como parâmetro).

4. **Given** o admin autenticado numa empresa sem filiais cadastradas,
   **When** ele acessa a página de movimento,
   **Then** o seletor de filial não aparece e a experiência é idêntica
   à atual (sem regressão).

---

### User Story 2 — Admin importa XML/notas para uma filial específica (Priority: P2)

Como administrador de grupo, quero fazer upload de XML(s) de notas fiscais
para a filial que está selecionada no combobox — garantindo que os registros
criados pertençam àquela filial, não à minha empresa-pai.

**Why this priority**: Importar para a filial errada cria dados inconsistentes
de difícil correção. O segundo passo natural após selecionar a filial é operar
sobre ela; o import é a principal operação de escrita.

**Independent Test**: Selecionar uma filial no combobox, fazer upload de um XML
válido. Verificar que o registro importado aparece na listagem da filial — e
*não* aparece na listagem da empresa-pai.

**Acceptance Scenarios**:

1. **Given** a filial X selecionada no combobox,
   **When** o admin faz upload de um XML válido,
   **Then** o registro é criado com a filial X como empresa titular,
   aparece na listagem da filial X e não afeta a listagem da empresa-pai.

2. **Given** a empresa-pai selecionada (comportamento padrão),
   **When** o admin faz upload de um XML válido,
   **Then** o registro é criado para a empresa-pai — idêntico ao
   comportamento atual (sem regressão).

3. **Given** a filial Y selecionada,
   **When** o admin tenta importar um XML cujo CNPJ prestador não
   corresponde à filial Y,
   **Then** o sistema rejeita a importação com mensagem clara indicando
   a incompatibilidade (comportamento de validação de CNPJ preexistente
   deve ser preservado).

---

### User Story 3 — Admin exporta, baixa XML e fecha movimento por filial (Priority: P3)

Como administrador de grupo, quero que as operações de exportação (CSV/planilha),
download de XML individual e fechamento de movimento operem sobre a filial
selecionada no combobox — não sobre minha empresa-pai por padrão.

**Why this priority**: Estas operações são derivadas da seleção de filial
estabelecida nas stories P1 e P2. Sem elas, o admin precisaria alternar de
empresa para executar cada operação, gerando fricção operacional.

**Independent Test**: Com a filial Z selecionada: (a) exportar — verificar
que o arquivo gerado contém apenas registros da filial Z; (b) baixar XML de
uma nota da filial Z — verificar que o arquivo correto é retornado; (c) fechar
o movimento da filial Z — verificar que apenas os registros dela são fechados.

**Acceptance Scenarios**:

1. **Given** a filial Z selecionada com registros abertos,
   **When** o admin clica em exportar,
   **Then** o arquivo gerado contém apenas os registros da filial Z.

2. **Given** a filial Z selecionada,
   **When** o admin clica em baixar XML de um registro da filial Z,
   **Then** o arquivo XML correto daquela nota é retornado.

3. **Given** a filial Z selecionada com movimento aberto,
   **When** o admin confirma o fechamento do movimento,
   **Then** apenas os registros da filial Z são fechados; os registros
   de outras filiais permanecem inalterados.

---

### User Story 4 — Admin deleta e edita registros de uma filial (Priority: P4)

Como administrador de grupo, quero que as operações de deleção e edição de
registros individuais do movimento também respeitem o escopo da filial —
garantindo que não é possível deletar ou editar um registro que pertença
a outra empresa do grupo.

**Why this priority**: Completude do escopo de segurança. Um admin não deve
poder operar sobre registros de filiais que não estão no seu grupo, mesmo
construindo requisições manuais.

**Independent Test**: Como admin do grupo, tentar deletar/editar (via interface
ou requisição direta) um registro pertencente a uma empresa fora do grupo.
O sistema deve recusar com erro claro.

**Acceptance Scenarios**:

1. **Given** a filial W selecionada no combobox,
   **When** o admin exclui um registro da filial W,
   **Then** o registro é removido da listagem da filial W.

2. **Given** qualquer seleção de filial,
   **When** o sistema recebe uma tentativa de deletar/editar um registro
   que pertence a uma empresa fora do escopo do grupo do admin,
   **Then** a operação é recusada com erro de permissão (sem expor
   detalhes internos do sistema).

3. **Given** um admin de empresa única (sem grupo),
   **When** ele tenta deletar ou editar qualquer registro,
   **Then** o comportamento é idêntico ao atual — sem regressão.

---

### Edge Cases

- **Admin sem filiais**: combobox não aparece; todas as operações mantêm
  comportamento atual (sem regressão).
- **Filial selecionada na URL que saiu do grupo**: o sistema ignora o parâmetro
  inválido e usa a empresa-pai como padrão (sem expor erro ao usuário).
- **Sessão expirada com filial na URL**: ao renovar sessão e retornar à página,
  o parâmetro é mantido na URL mas revalidado contra o novo token.
- **Admin tenta forjar empresa_id fora do escopo via requisição direta**:
  o servidor recusa com 403 sem revelar dados da empresa-alvo.
- **Grupo com 1 filial**: combobox aparece (pois há escolha — pai ou filial),
  mas com apenas 2 itens.
- **Combobox com muitas filiais**: campo de busca dentro do combobox permite
  filtrar por nome, tornando a seleção viável mesmo com dezenas de empresas.

---

## Requirements

### Functional Requirements

**Seletor de filial:**

- **FR-001**: O sistema DEVE exibir um seletor de filial pesquisável no
  cabeçalho da página de movimento quando o usuário autenticado pertencer a um
  grupo com duas ou mais empresas (empresa-pai + ao menos uma filial).

- **FR-002**: O seletor DEVE ocultar-se automaticamente quando o usuário
  pertencer a uma empresa sem filiais cadastradas, mantendo a interface idêntica
  ao comportamento atual.

- **FR-003**: O seletor DEVE pré-selecionar a empresa do próprio usuário logado
  como padrão ao abrir a página sem parâmetro de empresa na URL.

- **FR-004**: A seleção de filial DEVE ser refletida na URL como parâmetro
  persistível (`?empresa_id=N`), permitindo que o link seja compartilhado ou
  salvo como favorito com o contexto de filial preservado.

- **FR-005**: Ao trocar a filial selecionada, o sistema DEVE recarregar os dados
  de movimento automaticamente, sem exigir confirmação do usuário.

- **FR-006**: O seletor DEVE suportar busca textual por nome de empresa,
  permitindo localizar rapidamente uma filial em grupos com muitas empresas.

**Listagem e operações de movimento:**

- **FR-007**: A listagem de registros de movimento DEVE mostrar apenas os
  registros da empresa/filial selecionada no combobox.

- **FR-008**: A operação de importação (upload de XML/notas) DEVE criar os
  registros vinculados à empresa/filial correntemente selecionada no combobox.

- **FR-009**: A operação de exportação (geração de arquivo para download) DEVE
  incluir apenas os registros da empresa/filial selecionada.

- **FR-010**: O download de XML individual de um registro DEVE retornar o
  arquivo da nota pertencente à empresa/filial selecionada; tentativas de baixar
  nota de outra empresa DEVEM ser recusadas.

- **FR-011**: O fechamento de movimento DEVE incidir apenas sobre os registros
  abertos da empresa/filial selecionada.

- **FR-012**: A deleção de um registro DEVE ser permitida apenas se o registro
  pertencer a uma empresa dentro do escopo do grupo do usuário autenticado.

- **FR-013**: A edição de um registro DEVE ser permitida apenas se o registro
  pertencer a uma empresa dentro do escopo do grupo do usuário autenticado.

**Segurança e isolamento (constitution §II — NON-NEGOTIABLE):**

- **FR-014**: O servidor DEVE validar toda empresa_id recebida como parâmetro
  contra o escopo do grupo do usuário autenticado (derivado exclusivamente do
  token JWT, nunca do corpo/query não autenticado). Empresa fora do escopo DEVE
  resultar em recusa com código de erro de permissão, sem vazar dados da empresa-alvo.

- **FR-015**: Quando nenhuma empresa_id for informada na requisição, o sistema
  DEVE usar a empresa do próprio usuário autenticado como padrão —
  mantendo 100% de compatibilidade retroativa com clientes que não enviam
  o parâmetro.

- **FR-016**: O sistema DEVE fornecer um endpoint autenticado que retorne a
  lista de empresas do grupo do usuário (empresa-pai + filiais) com nome e
  identificador, para alimentar o combobox. Esse endpoint DEVE ser acessível
  a qualquer usuário autenticado do grupo, independentemente de ser o
  administrador-pai ou uma filial.

**Escopo excluído do MVP:**

- **FR-EX-001** (fora do MVP): O loop de envio de notas fiscais e o controle
  de processo (ProcessControl) NÃO são afetados por esta feature. Eles
  continuam operando sobre a empresa do próprio usuário logado.

### Key Entities

- **Empresa/Filial**: unidade organizacional que possui registros de movimento.
  Atributos relevantes: identificador único, nome da empresa. Pode ser a
  empresa-pai de um grupo ou uma filial cadastrada via `cadastro-filiais`.

- **Movimento (EnvioMassa)**: conjunto de registros de notas fiscais/XMLs
  importados, pertencentes a uma empresa específica. Cada registro é titular
  de exatamente uma empresa.

- **Grupo de Empresas**: agregado formado pela empresa-pai e todas as filiais
  diretamente vinculadas a ela. O escopo de um usuário é sempre derivado
  do token de autenticação — nunca de dado externo.

---

## Clarifications

> As seguintes decisões foram **pré-confirmadas pelo operador** antes da especificação
> e estão folded diretamente nos requisitos acima. Não requerem clarificação adicional.

| # | Decisão | Impacto na spec |
|---|---------|-----------------|
| D1 | Seletor posicionado no header/topbar da página de movimento | FR-001, Acceptance Scenarios |
| D2 | Trocar filial recarrega dados automaticamente (sem confirmação) | FR-005, US1-AS2 |
| D3 | Seleção persiste na URL como `?empresa_id=N` | FR-004, US1-AS3 |
| D4 | Single-empresa: combobox oculto | FR-002, US1-AS4 |
| D5 | Loop de envio/ProcessControl fora do MVP | FR-EX-001 |
| D6 | empresa_id sempre validado server-side via escopo do token | FR-014, FR-015 |
| D7 | Novo endpoint autenticado para listar empresas do grupo | FR-016 |
| D8 | Acabamento UX via `/ui-ux-pro-max` como quality gate | (fora da spec — governança de pipeline) |
| D9 | Commit/push/merge/deploy apenas com autorização explícita | (governança de pipeline) |

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Administrador de grupo consegue visualizar o movimento de qualquer
  filial do seu grupo em no máximo 2 interações (selecionar filial + aguardar
  carregamento) a partir da página de movimento.

- **SC-002**: A troca de filial no combobox atualiza a listagem em menos de
  3 segundos em condições normais de rede.

- **SC-003**: 100% das operações de escrita (import, delete, edição, fechamento)
  sobre um registro de filial são recusadas quando a empresa não pertence ao
  escopo do usuário — sem nenhum dado sendo modificado ou exposto.

- **SC-004**: Usuários de empresa única (sem filiais) não percebem nenhuma
  diferença de comportamento ou interface em relação à versão anterior da
  página de movimento.

- **SC-005**: Um link com `?empresa_id=N` aberto por outro usuário do mesmo
  grupo exibe os dados da filial N sem necessidade de reselecionar manualmente.

- **SC-006**: A listagem de empresas disponíveis no combobox inclui a
  empresa-pai do usuário autenticado e todas as filiais ativas do grupo —
  sem listar empresas de outros grupos.
