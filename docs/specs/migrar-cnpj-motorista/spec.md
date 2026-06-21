# Feature Specification: Migrar Cadastro do Motorista ao Alterar CNPJ do Prestador

**Feature**: `migrar-cnpj-motorista`
**Created**: 2026-06-21
**Status**: Draft

## User Scenarios & Testing

### User Story 1 - Admin corrige CNPJ digitado errado em um movimento (Priority: P1)

Um administrador do grupo Movee percebe que o CNPJ do prestador foi cadastrado incorretamente em um ou mais movimentos. Ele abre o diálogo de edição do movimento, corrige o CNPJ para o valor correto e salva. O sistema atualiza o CNPJ em todos os movimentos da mesma empresa que tinham o CNPJ antigo, e migra o cadastro de login do motorista para o novo CNPJ, preservando senha, nome e status ativo — garantindo que o motorista continue conseguindo fazer login no app.

**Why this priority**: É o fluxo principal da feature e resolve o defeito crítico atual: o CNPJ editado não é gravado e o motorista perde acesso ao app motorista.

**Independent Test**: Editar o CNPJ de um movimento existente para um CNPJ válido não utilizado → verificar que o movimento e todos os movimentos irmãos da mesma empresa foram atualizados, e que o motorista consegue logar no app com o novo CNPJ.

**Acceptance Scenarios**:

1. **Given** um movimento com `cnpj_prestador = "11111111000100"` pertencente à empresa do grupo Movee, **When** o admin edita e salva o CNPJ para `"22222222000100"`, **Then** o movimento (e todos os movimentos da mesma empresa com o CNPJ antigo) passa a ter `cnpj_prestador = "22222222000100"`, e o cadastro do motorista é migrado para o novo CNPJ preservando senha/nome/ativo.

2. **Given** três movimentos com o mesmo `cnpj_prestador` antigo na mesma empresa, **When** o admin edita apenas um deles, **Then** os três movimentos são atualizados para o novo CNPJ (nenhum fica órfão).

3. **Given** a edição não altera o CNPJ (campo permanece igual), **When** o admin salva, **Then** o sistema persiste normalmente os demais campos sem acionar a lógica de migração de motorista.

---

### User Story 2 - Proteção contra fusão acidental de contas de motoristas distintos (Priority: P2)

Ao tentar corrigir um CNPJ, o admin digita por engano um CNPJ que já pertence a outro motorista cadastrado. O sistema detecta a colisão e recusa a operação com uma mensagem clara — sem fundir as contas nem sobrescrever senhas.

**Why this priority**: Fundir contas de motoristas distintos comprometeria autenticação e dados de ambos; a recusa explícita é mais segura que qualquer heurística de merge automático.

**Independent Test**: Tentar alterar o CNPJ de um movimento para um CNPJ que já existe na tabela de motoristas cadastrados → a operação deve ser recusada com status de conflito.

**Acceptance Scenarios**:

1. **Given** já existe um motorista cadastrado com `cnpj_prestador = "33333333000100"`, **When** o admin tenta alterar um movimento para esse CNPJ, **Then** a operação é recusada com mensagem clara ("CNPJ já possui motorista cadastrado — altere manualmente se necessário") e nenhum dado é modificado.

2. **Given** a recusa por conflito de CNPJ, **When** o admin confirma a mensagem de erro, **Then** o diálogo de edição permanece aberto com os valores anteriores para que ele possa corrigir.

---

### User Story 3 - Admin registra CNPJ de motorista ainda não pré-cadastrado (Priority: P3)

O admin edita um movimento para um CNPJ válido que ainda não tem nenhum motorista pré-cadastrado no sistema. Para empresas do grupo Movee, o sistema cria automaticamente um pré-cadastro de login (sem senha) para que o motorista possa ser ativado posteriormente.

**Why this priority**: Sem o pré-cadastro, o motorista com o novo CNPJ nunca conseguiria fazer login; criar automaticamente elimina uma etapa manual extra.

**Independent Test**: Editar um movimento para um CNPJ inexistente na tabela de motoristas (empresa do grupo Movee) → verificar que um registro com o novo CNPJ foi criado automaticamente com `ativo=true` e `senha=null`.

**Acceptance Scenarios**:

1. **Given** nenhum motorista cadastrado com `cnpj_prestador = "44444444000100"` e a empresa é do grupo Movee, **When** o admin salva o movimento com esse CNPJ, **Then** um pré-cadastro é criado com `cnpj_prestador = "44444444000100"`, `ativo = true` e `senha = null`.

2. **Given** nenhum motorista cadastrado com o CNPJ novo e a empresa NÃO é do grupo Movee, **When** o admin salva o movimento, **Then** o CNPJ do movimento é atualizado normalmente e nenhum pré-cadastro de motorista é criado.

---

### User Story 4 - Validação de CNPJ no formulário de edição (Priority: P4)

Ao editar um movimento, o campo de CNPJ do prestador exibe máscara de formatação e só habilita o botão "Salvar" quando o valor informado contém exatamente 14 dígitos numéricos — evitando que CNPJs incompletos ou malformados cheguem ao servidor.

**Why this priority**: Prevenção de erro na entrada; elimina categoria inteira de erros de digitação antes do envio.

**Independent Test**: Abrir o diálogo de edição, digitar um CNPJ incompleto (menos de 14 dígitos) → botão "Salvar" permanece desabilitado. Completar os 14 dígitos → botão habilita.

**Acceptance Scenarios**:

1. **Given** o diálogo de edição está aberto, **When** o campo de CNPJ contém menos de 14 dígitos, **Then** o botão "Salvar" permanece desabilitado e uma dica visual indica o formato esperado.

2. **Given** o campo de CNPJ tem 14 dígitos válidos, **When** os demais campos estão preenchidos, **Then** o botão "Salvar" fica habilitado.

3. **Given** o admin digita o CNPJ com pontuação (ex: `11.111.111/0001-00`), **When** o sistema processa o valor, **Then** apenas os 14 dígitos são enviados ao servidor (pontuação é descartada).

---

### Edge Cases

- O que acontece se o CNPJ antigo e o novo forem iguais após normalização (remoção de pontuação)? O sistema deve detectar que não houve mudança e não acionar a lógica de migração.
- O que acontece se a atualização em lote de movimentos falhar parcialmente? O sistema deve reportar erro sem deixar estado inconsistente (movimentos parcialmente atualizados).
- O que acontece se os movimentos forem atualizados com sucesso mas a migração do motorista falhar em seguida (sem transação atômica no PostgREST)? O sistema deve retornar erro (HTTP 500) com mensagem clara e logar a inconsistência — sem tentar reverter os movimentos (rollback em lote sem transação é inseguro).
- Movimentos já finalizados (`enviado=true`) também têm o CNPJ atualizado na troca em lote — a correção de digitação vale para todo o histórico da empresa.
- O que acontece se o admin de uma empresa fora do grupo Movee editar o CNPJ? O CNPJ deve ser atualizado nos movimentos normalmente, sem qualquer operação na tabela de motoristas.
- O que acontece se o campo CNPJ for removido do payload de edição? O sistema deve ignorar a lógica de migração (comportamento atual mantido para outros campos).

## Requirements

### Functional Requirements

- **FR-001**: O sistema DEVE persistir o novo `cnpj_prestador` no movimento quando ele for alterado via edição (hoje o campo é ignorado).
- **FR-002**: Quando o CNPJ do prestador for alterado em um movimento, o sistema DEVE atualizar todos os demais movimentos da mesma empresa que possuíam o CNPJ antigo para o novo CNPJ.
- **FR-003**: A lógica de migração do cadastro de motorista DEVE ser acionada exclusivamente para empresas que pertencem ao grupo Movee, verificado via critério de grupo (não por ID fixo de empresa).
- **FR-004**: Quando o CNPJ for alterado e a empresa for do grupo Movee, o sistema DEVE verificar a existência de um motorista cadastrado com o CNPJ antigo antes de migrar.
- **FR-005**: Se existir um motorista com o CNPJ antigo (empresa do grupo Movee), o sistema DEVE migrar o registro: atualizar a chave primária para o novo CNPJ, preservando `nome`, `senha` e `ativo`.
- **FR-006**: Se já existir um motorista cadastrado com o CNPJ novo, o sistema DEVE recusar a operação inteira com resposta de conflito (HTTP 409) e mensagem legível pelo usuário — sem modificar nenhum dado.
- **FR-007**: Se não existir motorista com o CNPJ antigo e a empresa for do grupo Movee, o sistema DEVE criar um pré-cadastro com o novo CNPJ, `ativo = true` e `senha = null`.
- **FR-008**: O campo de CNPJ do prestador no formulário de edição DEVE exibir máscara de formatação e validar que o valor contém exatamente 14 dígitos numéricos antes de habilitar o envio.
- **FR-009**: O sistema DEVE normalizar o CNPJ (remover pontuação, manter apenas dígitos) antes de qualquer comparação ou persistência.
- **FR-010**: A lógica de migração de motorista DEVE ser executada somente após a atualização bem-sucedida dos movimentos — nunca antes.
- **FR-011**: Se a atualização dos movimentos suceder mas a migração subsequente do motorista falhar, o sistema DEVE retornar erro (HTTP 500) com mensagem clara e registrar a inconsistência em log (sem expor segredos), SEM tentar reverter os movimentos — reversão em lote sem transação atômica é insegura.
- **FR-012**: A troca em lote do CNPJ DEVE abranger todos os movimentos da mesma empresa com o CNPJ antigo independentemente do status `enviado` (incluindo movimentos já finalizados), garantindo consistência total do prestador.
- **FR-013**: A verificação de conflito de unicidade (HTTP 409) e qualquer leitura/escrita na tabela de motoristas DEVE ocorrer exclusivamente para empresas do grupo Movee; empresas fora do grupo nunca consultam a tabela de motoristas (preserva isolamento multi-tenant — a base de motoristas é exclusiva do grupo Movee).
- **FR-014**: O aviso "Isto também atualizará o login do motorista no app" PODE ser exibido como texto fixo no diálogo de edição ao alterar o CNPJ, para todos os usuários — não é necessário o front detectar pertencimento ao grupo Movee (inofensivo para empresas externas, cujo motorista não é tocado; evita expor dados de grupo ao cliente).

### Key Entities

- **Movimento**: Registro de envio em massa com campo `cnpj_prestador` que identifica o motorista responsável. Pertence a uma empresa (`id_empresa`).
- **Motorista**: Pré-cadastro de login do app motorista. Identificado unicamente por `cnpj_prestador` (chave primária). Atributos preserváveis: `nome`, `senha` (hash bcrypt), `ativo`.
- **Empresa / Grupo**: Organização que realiza os envios. O critério de grupo Movee é avaliado dinamicamente (não por ID fixo), permitindo que filiais futuras sejam automaticamente incluídas.

> Decisões de infraestrutura: N/A (feature stateless, sem scheduling, sem criptografia própria, sem estado cross-pod além do banco existente).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Após editar o CNPJ de um movimento, 100% dos movimentos da mesma empresa com o CNPJ antigo refletem o novo valor no banco em menos de 3 segundos.
- **SC-002**: 100% das edições de CNPJ para empresas do grupo Movee resultam em migração correta do cadastro do motorista (ou recusa explícita com 409 em caso de conflito), sem perda de senha ou status.
- **SC-003**: Empresas fora do grupo Movee têm 0 registros inseridos ou modificados na tabela de motoristas ao editar o CNPJ de um movimento.
- **SC-004**: CNPJs com menos de 14 dígitos são bloqueados no formulário, reduzindo a zero os erros de formato que chegam ao servidor.
- **SC-005**: Tentativas de unificação acidental de motoristas distintos são recusadas em 100% dos casos com mensagem legível pelo admin.

## Clarifications

Todas as decisões de design foram resolvidas pelo feature-briefing antes da especificação:

1. **Escopo da troca (Opção A)**: atualizar todos os movimentos da mesma empresa com o CNPJ antigo, não apenas o editado.
2. **Conflito de unicidade**: HTTP 409, sem merge automático.
3. **Motorista inexistente**: criar pré-cadastro (grupo Movee); ignorar (demais empresas).
4. **Validação no front**: máscara + 14 dígitos obrigatórios.

### Sessão de clarify 2026-06-21 (resolvida autonomamente — score 3, evidência nas fontes)

Operador ausente (background job); respostas decididas por heurística sobre briefing + constitution + spec (todas com citação literal). Decisões registradas no state.json (dec-007 a dec-010).

5. **Falha parcial movimentos→motorista (Q1)**: se os movimentos forem atualizados mas a migração do motorista falhar, retornar **HTTP 500 + log da inconsistência, sem reverter** os movimentos (FR-011). Reverter em lote sem transação atômica é inseguro; opção de migrar o motorista antes foi descartada por violar FR-010. *Evidência: briefing "logar e retornar status claro" + spec FR-010 (ordem movimento→motorista).*
6. **Escopo do UPDATE por status (Q2)**: a troca em lote abrange **todos os movimentos** da empresa com o CNPJ antigo, **incluindo os já enviados** (`enviado=true`) — FR-012. *Evidência: spec FR-002 "todos os demais movimentos da mesma empresa" sem restrição de status + briefing Opção A.*
7. **Checagem de conflito 409 exclusiva do grupo Movee (Q3)**: empresas **fora** do grupo Movee **nunca** consultam a tabela de motoristas; o 409 e qualquer leitura/escrita de motorista são exclusivos do grupo Movee — FR-013. *Evidência: briefing "Para empresas fora do grupo: apenas grava o novo CNPJ no movimento, sem tocar Motorista" + spec FR-003 + constitution Princípio II (isolamento multi-tenant NON-NEGOTIABLE).*
8. **Aviso de impacto no login no front (Q4)**: exibir o aviso como **texto fixo no diálogo para todos os usuários**, sem detectar grupo Movee no client (inofensivo para empresas externas) — FR-014. *Evidência: briefing "Exibir aviso... (Pode ser texto fixo no diálogo.)".*
