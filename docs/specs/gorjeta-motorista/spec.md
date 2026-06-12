# Feature Specification: Gorjeta do Motorista

**Feature**: `gorjeta-motorista`
**Created**: 2026-06-12
**Status**: Draft

## Contexto

A planilha de upload do Movee Hub contém uma coluna `gorjeta` com valores em formato monetário
(ex.: "R$ 22,00") ou vazia ("R$ -"). Hoje esse dado é descartado silenciosamente: não existe
coluna no banco, não é gravado no upload, não é lido pelo backend e não é exibido ao motorista.
Esta feature fecha essa lacuna em todas as camadas.

> Decisões de infraestrutura: N/A — feature stateless de persistência/leitura simples, sem scheduling, sem criptografia de dados novos, sem multi-pod locking.

---

## User Scenarios & Testing

### User Story 1 — Motorista vê sua gorjeta na tela de movimento (Priority: P1)

Quando o operador faz upload de uma planilha com gorjeta preenchida (ex.: "R$ 22,00"), o
motorista deve conseguir ver o valor da gorjeta na sua tela de movimento — ao lado do valor
do serviço — para saber exatamente o quanto vai receber naquele período.

**Why this priority**: É o valor central da feature. Sem isso, toda a persistência/mapeamento
não tem utilidade visível para o usuário final.

**Independent Test**: Dado um movimento aberto com gorjeta = 22,00, o motorista acessa a tela
de movimento e vê "Gorjeta: R$ 22,00" exibido.

**Acceptance Scenarios**:

1. **Given** um motorista com movimento aberto cujo upload incluiu `gorjeta = "R$ 22,00"`,
   **When** o motorista acessa a tela de movimento,
   **Then** a tela exibe o valor da gorjeta formatado em BRL próximo ao valor do serviço.

2. **Given** um motorista com movimento aberto cujo upload não incluiu gorjeta (ou veio "R$ -"),
   **When** o motorista acessa a tela de movimento,
   **Then** a tela não exibe nenhum campo de gorjeta (campo oculto quando vazio/nulo).

3. **Given** um motorista sem movimento aberto,
   **When** acessa a tela de movimento,
   **Then** o comportamento existente (tela vazia/estado neutro) é preservado — gorjeta não introduz regressão.

---

### User Story 2 — Upload preserva gorjeta sem quebrar planilhas existentes (Priority: P2)

O operador consegue fazer upload de planilhas que incluam a coluna `gorjeta` (com valores ou
vazia) sem erros, e também de planilhas antigas que não tenham essa coluna — ambos os casos
devem funcionar sem intervenção manual.

**Why this priority**: A retrocompatibilidade é crítica — planilhas em uso antes desta feature
não podem começar a falhar após o deploy.

**Independent Test**: Upload de planilha com coluna gorjeta preenchida → registro salvo com
valor correto. Upload de planilha antiga sem coluna gorjeta → registro salvo normalmente,
gorjeta nula.

**Acceptance Scenarios**:

1. **Given** uma planilha com coluna `gorjeta` contendo "R$ 15,00",
   **When** o operador faz upload,
   **Then** o sistema grava o valor numérico da gorjeta no banco sem erros, e o restante dos
   campos do movimento (valor, nome, tomador, etc.) é preservado exatamente como antes.

2. **Given** uma planilha com coluna `gorjeta` contendo "R$ -" (vazia),
   **When** o operador faz upload,
   **Then** o sistema grava `null` para a gorjeta desse registro, sem erro e sem alterar outros campos.

3. **Given** uma planilha sem coluna `gorjeta` (formato legado),
   **When** o operador faz upload,
   **Then** o upload é concluído com sucesso; a gorjeta do registro fica `null`.

4. **Given** uma planilha mista (algumas linhas com gorjeta, algumas sem ou "R$ -"),
   **When** o operador faz upload,
   **Then** cada linha é gravada corretamente de forma independente — linhas com valor têm gorjeta preenchida, demais têm `null`.

---

### Edge Cases

- O que acontece se a coluna `gorjeta` na planilha tiver um valor não-monetário (texto livre)?
  → O sistema deve ignorar/tratar como vazio (gravar `null`), sem lançar erro 500.
- O que acontece se o banco ainda não tiver a coluna `gorjeta` no momento do upload?
  → O sistema deve falhar apenas no campo gorjeta, nunca corromper os demais campos.
  (Mitigado pela ordem de deploy: DDL antes do backend.)
- Reload do schema PostgREST: se o serviço PostgREST não recarregar o schema após o DDL,
  a nova coluna não fica visível → o rito de produção deve incluir verificação do reload.

---

## Requirements

### Functional Requirements

- **FR-001**: O sistema DEVE persistir o valor da gorjeta no banco de dados quando a planilha de
  upload contiver a coluna `gorjeta` com valor monetário válido.

- **FR-002**: O sistema DEVE gravar `null` (ausência de valor) para a gorjeta quando a planilha
  não contiver a coluna ou quando o valor for "R$ -" ou equivalente a zero/vazio.

- **FR-003**: O sistema DEVE aceitar planilhas sem a coluna `gorjeta` sem gerar erro — a gorjeta
  é um campo opcional; a ausência não impede o upload.

- **FR-004**: O endpoint de consulta do movimento aberto DEVE retornar o campo `gorjeta` no
  payload de resposta, com o valor numérico ou `null`.

- **FR-005**: A tela de movimento do motorista DEVE exibir o valor da gorjeta formatado em BRL
  quando o campo for não-nulo e não-zero.

- **FR-006**: A tela de movimento do motorista NÃO DEVE exibir o campo gorjeta quando o valor
  for `null` ou zero — ocultar, não mostrar "R$ 0,00".

- **FR-007**: A adição da coluna `gorjeta` no banco DEVE ser idempotente: aplicar o DDL numa
  base que já possui a coluna não gera erro.

- **FR-008**: O schema do serviço de API REST do banco DEVE ser recarregado após o DDL para
  que a nova coluna fique imediatamente acessível via API — isso faz parte do rito de deploy.

### Key Entities

- **Movimento (EnvioMassa)**: Registro de serviço de um motorista num período. Ganha o atributo
  `gorjeta` (valor monetário opcional, mesmo formato do campo `valor`). Relacionamento: 1 movimento
  → 0 ou 1 gorjeta.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% dos registros de upload com gorjeta preenchida ("R$ X,XX") chegam ao banco
  com o valor numérico correto — zero regressão nesse caminho.

- **SC-002**: 100% dos uploads de planilhas legadas (sem coluna `gorjeta`) continuam com sucesso
  após o deploy — zero regressão no caminho existente.

- **SC-003**: O motorista vê a gorjeta na tela em até 1 recarregamento após o upload ser
  processado — sem etapa manual adicional além do upload já existente.

- **SC-004**: Campos de gorjeta nulos ou zero nunca aparecem na tela do motorista — nenhum usuário
  vê "R$ 0,00" onde não há gorjeta.

- **SC-005**: O DDL pode ser reaplicado ao banco (em testes, rollback/replay) sem gerar erro —
  idempotência verificável por script.
