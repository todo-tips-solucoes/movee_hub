# Feature Specification: Cadastro de Filiais

**Feature**: `cadastro-filiais`
**Created**: 2026-06-09
**Status**: Draft

## User Scenarios & Testing

### User Story 1 - Admin cria empresa filial pelo formulário (Priority: P1)

Como admin de um grupo de empresas, quero preencher um formulário com os dados
essenciais da filial (nome, e-mail, senha, CNPJ e dados fiscais) e submetê-lo
para que a nova empresa já nasça cadastrada e vinculada ao meu grupo — sem
precisar informar nenhum ID numérico manualmente.

**Why this priority**: É o fluxo central da feature. Toda a demanda existe em
torno deste cadastro simplificado. Sem ele, a feature não existe.

**Independent Test**: Autenticar como admin de grupo (`is_grupo_pai = true`),
acessar a tela de configurações do grupo, preencher e submeter o formulário. A
filial criada deve aparecer na lista de filiais sem intervenção adicional.

**Acceptance Scenarios**:

1. **Given** um admin de grupo autenticado na tela de configurações, **When**
   ele preenche nome, e-mail, senha e CNPJ válidos e submete o formulário,
   **Then** o sistema cadastra a empresa filial, vincula-a automaticamente ao
   grupo do admin (sem que o admin informe o ID do grupo) e exibe a nova filial
   na lista.

2. **Given** o formulário preenchido corretamente, **When** a filial é criada
   com sucesso, **Then** ela consegue fazer login imediatamente com o e-mail e
   senha definidos pelo admin — sem nenhum fluxo de "primeiro acesso" ou
   redefinição de senha.

3. **Given** o formulário com campos de dados fiscais opcionais (endereço,
   número, CEP, e-mail de nota, observação), **When** esses campos são
   preenchidos junto com os obrigatórios, **Then** os dados fiscais são salvos
   na empresa filial criada.

4. **Given** o formulário com campos de dados fiscais vazios, **When** o admin
   submete apenas os campos obrigatórios, **Then** a filial é criada com sucesso
   e os campos fiscais ficam nulos, podendo ser preenchidos depois.

---

### User Story 2 - Sistema bloqueia duplicatas e erros de validação (Priority: P2)

Como admin de grupo, quero receber mensagens de erro claras e acionáveis
quando tento cadastrar uma filial com dados inválidos ou já existentes — para
corrigir o problema sem sair da tela.

**Why this priority**: Sem feedback de erro adequado, o admin fica sem saber
por que o cadastro falhou. É requisito de usabilidade diretamente ligado ao P1.

**Independent Test**: Tentar criar filial com (a) e-mail já cadastrado, (b)
CNPJ já cadastrado, (c) CNPJ com formato inválido, (d) senha fraca. Cada
tentativa deve exibir erro específico abaixo do campo inválido.

**Acceptance Scenarios**:

1. **Given** um e-mail já vinculado a outra empresa, **When** o admin submete
   o formulário com esse e-mail, **Then** o sistema exibe erro "E-mail já
   cadastrado" abaixo do campo de e-mail e mantém o foco nele.

2. **Given** um CNPJ já vinculado a outra empresa, **When** o admin submete
   o formulário com esse CNPJ, **Then** o sistema exibe erro "CNPJ já
   cadastrado" abaixo do campo de CNPJ.

3. **Given** um CNPJ com formato inválido (diferente de 14 dígitos numéricos),
   **When** o admin submete o formulário, **Then** o sistema exibe erro de
   formato abaixo do campo de CNPJ.

4. **Given** uma senha que não atende ao requisito mínimo de segurança,
   **When** o admin submete o formulário, **Then** o sistema exibe o medidor
   de força e uma mensagem explicativa abaixo do campo de senha.

5. **Given** o formulário sem o campo de nome da empresa preenchido, **When**
   o admin tenta submeter, **Then** o sistema bloqueia o envio e aponta o campo
   obrigatório vazio.

---

### User Story 3 - Admin não-autorizado é bloqueado (Priority: P3)

Como sistema, quero garantir que apenas admins de grupo possam acessar o
formulário de cadastro de filiais — e que nenhum dado de grupo seja manipulável
via corpo de requisição.

**Why this priority**: Requisito de segurança. Protege o invariante de
isolamento multi-tenant (constitution §II v1.1.0).

**Independent Test**: Autenticar como empresa comum (não admin de grupo) e
tentar acessar a tela ou o endpoint. O acesso deve ser negado.

**Acceptance Scenarios**:

1. **Given** um usuário autenticado sem `is_grupo_pai = true`, **When** ele
   acessa a tela de configurações de grupo, **Then** o formulário de cadastro
   de filiais não é exibido e uma mensagem informativa é apresentada.

2. **Given** uma requisição direta ao endpoint de cadastro por um usuário sem
   privilégio de admin de grupo, **When** a requisição é processada, **Then**
   o sistema retorna erro 403 sem criar nenhum registro.

3. **Given** uma requisição que inclui um `id_grupo` no corpo, **When** o
   sistema processa o cadastro, **Then** o `id_grupo` do corpo é ignorado e
   o vínculo ao grupo usa sempre o grupo do token JWT do admin.

---

### User Story 4 - Sistema impede ultrapassar limite de filiais por grupo (Priority: P4)

Como sistema, quero impedir que um grupo ultrapasse o limite operacional de
filiais — para manter a integridade do modelo de dados do grupo.

**Why this priority**: Requisito de integridade. Necessário para evitar
crescimento ilimitado de grupos.

**Independent Test**: Criar ou simular um grupo com 100 filiais e tentar
adicionar a 101ª. O sistema deve rejeitar.

**Acceptance Scenarios**:

1. **Given** um grupo que já possui 100 filiais vinculadas, **When** o admin
   tenta cadastrar mais uma filial, **Then** o sistema retorna erro informativo
   indicando que o limite foi atingido, sem criar o registro.

---

### Edge Cases

- O que acontece se dois admins do mesmo grupo tentarem criar filiais com
  o mesmo CNPJ simultaneamente? O banco aplica a restrição de unicidade e
  apenas um registro é persistido; o outro recebe erro 409.
- O que acontece se o grupo do admin ainda não existe no banco? O sistema
  cria o grupo de forma preguiçosa antes de vincular a filial — comportamento
  herdado da lógica existente de resolução de grupo.
- O que acontece se o admin preenche o CNPJ com pontuação (ex.: `12.345.678/0001-90`)?
  O sistema valida apenas os 14 dígitos numéricos; a UI pode aceitar ou limpar a
  máscara antes de enviar.

## Requirements

### Functional Requirements

- **FR-001**: O sistema DEVE permitir que um admin de grupo cadastre uma empresa
  filial preenchendo: nome da empresa (obrigatório), e-mail (obrigatório), senha
  (obrigatório), CNPJ (obrigatório), e opcionalmente endereço, número, CEP,
  e-mail de nota fiscal e observação.

- **FR-002**: O sistema DEVE vincular automaticamente a filial criada ao grupo
  do admin autenticado — o identificador do grupo é sempre extraído do token de
  autenticação, nunca do corpo ou da query da requisição.

- **FR-003**: O sistema DEVE validar o CNPJ informado como exatamente 14 dígitos
  numéricos e rejeitar duplicatas com resposta 409.

- **FR-004**: O sistema DEVE validar a unicidade do e-mail da filial e rejeitar
  duplicatas com resposta 400.

- **FR-005**: O sistema DEVE armazenar a senha da filial com hash seguro (bcrypt).
  A filial deve conseguir fazer login imediatamente após o cadastro, sem fluxo
  de primeiro acesso.

- **FR-006**: O sistema DEVE rejeitar o cadastro quando o grupo do admin já
  tiver 100 filiais vinculadas, retornando resposta 422.

- **FR-007**: O sistema DEVE restringir o acesso ao cadastro de filiais
  exclusivamente a empresas com `is_grupo_pai = true`; tentativas de outros
  perfis resultam em resposta 403.

- **FR-008**: O frontend DEVE exibir o medidor de força de senha e mensagens de
  erro por campo logo abaixo do respectivo input, com foco automático no
  primeiro campo inválido ao submeter.

- **FR-009**: O frontend DEVE exibir feedback de carregamento durante a submissão
  e feedback de sucesso ao concluir, recarregando a lista de filiais sem recarregar
  a página inteira.

- **FR-010**: O sistema DEVE manter intactos: a listagem de filiais do grupo
  (GET), o desvinculamento de filiais (DELETE) e a tela de bloqueio para
  não-admins — nenhum comportamento existente é removido.

- **FR-011**: O banco de dados DEVE suportar o armazenamento do CNPJ por empresa
  com restrição de unicidade. A migração de esquema é aplicada pelo operador, não
  pelo sistema em runtime.

### Key Entities

- **Empresa (filial)**: entidade criada pelo formulário. Atributos relevantes:
  nome, e-mail único, senha (hasheada), CNPJ único de 14 dígitos, id_grupo
  (referência ao grupo pai), e campos fiscais opcionais (endereço, número, CEP,
  e-mail de nota, observação).

- **Grupo**: entidade que agrega a empresa-pai e suas filiais. O vínculo é
  estabelecido pelo `id_grupo` da filial. O grupo é resolvido (ou criado
  preguiçosamente) a partir do token do admin.

- **Admin de grupo**: empresa com flag `is_grupo_pai = true` no token
  autenticado. É o único ator que pode cadastrar filiais.

> **Decisões de infraestrutura**: N/A — feature stateless. O endpoint de
> criação de filial não envolve scheduling, sessões persistentes, criptografia
> de dados além de bcrypt (já mandatório pela constitution), nem estado
> compartilhado entre réplicas. Unicidade de CNPJ e e-mail é garantida por
> constraints do banco, não por lock distribuído.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um admin de grupo consegue concluir o cadastro de uma filial
  (do formulário aberto até a filial aparecer na lista) em menos de 2 minutos,
  sem erro e sem precisar informar nenhum ID numérico.

- **SC-002**: 100% dos cenários de erro (e-mail duplicado, CNPJ duplicado,
  CNPJ inválido, senha fraca, limite de 100 filiais, não-admin) exibem
  mensagem específica ao usuário em português, no campo correspondente, sem
  recarregar a página.

- **SC-003**: Uma filial criada consegue fazer login com as credenciais
  definidas pelo admin imediatamente após o cadastro, sem etapas adicionais.

- **SC-004**: Nenhuma requisição de cadastro de filial aceita ou processa o
  `id_grupo` vindo do corpo — o vínculo ao grupo vem exclusivamente do token
  JWT, preservando o invariante de isolamento multi-tenant (constitution §II
  v1.1.0).

- **SC-005**: A tela de configurações do grupo exibe estado vazio amigável
  para grupos sem filiais e tela de bloqueio para empresas sem privilégio de
  admin, mantendo o comportamento pré-existente intacto.

- **SC-006**: O projeto passa pelo build de produção sem erros de TypeScript
  ou compilação após a implementação.

## Clarifications

Todas as decisões de design foram ratificadas pelo usuário antes da criação
desta spec. Não há itens pendentes de clarificação.

| Decisão | Escolha ratificada |
|---------|-------------------|
| Campos do formulário | nome_empresa + email + senha + CNPJ + campos fiscais opcionais |
| CNPJ | Coluna nova na Empresa, UNIQUE, 14 dígitos, DDL aplicado pelo operador |
| Senha | Admin define no formulário; sem fluxo de primeiro acesso |
| Branch base | main (já em vigor) |
