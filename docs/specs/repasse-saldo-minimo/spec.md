# Feature Specification: Repasse — saldo mínimo carregado, aprovação restrita e identificação do motorista

**Feature**: `repasse-saldo-minimo`
**Created**: 2026-09-26
**Status**: Draft

Fonte: pedido do operador (2026-09-25/26), consolidado em
`docs/plans/repasse-saldo-minimo/BRIEFING-AGENTE-00C.md`. Três frentes
independentes, entregues em ordem de menor para maior risco — cada uma vai a
produção sozinha.

## Clarifications

### Session 2026-09-26

- Q: Deve existir ação manual (tela/endpoint, RBAC restrito) para
  baixar/quitar saldo retido de motorista sem movimento futuro, ou fica
  fora de escopo? → A: Fora de escopo. O saldo retido segue carregado
  indefinidamente e visível na tela de Repasse semanal e no CSV (FR-024);
  baixa/quitação excepcional é sempre escrita manual em produção pelo rito
  do projeto, caso a caso — nenhuma ação de produto é construída para isso.
- Q: O piso mínimo configurável (FR-025) é por empresa ou global da
  plataforma, e quem pode alterá-lo? → A: Por empresa, na coluna
  `repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50` da própria
  `AdiantamentoConfiguracao` (tabela já versionada e já escopada por
  `id_empresa`). Editável na tela de configurações do módulo, dentro do
  card "Repasse semanal", somente por quem tem a permissão
  `adiantamentos.pagamento_confirmar` — não pela permissão mais ampla
  `adiantamentos.configurar`, que administrador de entidade e financeiro
  também possuem. Checagem obrigatória no backend e no banco, valor deve
  ser maior que zero.
- Q: O fechamento de semanas de apuração deve ser estritamente sequencial,
  ou pode pular semanas intermediárias? → A: Estritamente sequencial —
  só a semana imediatamente seguinte à última fechada da empresa; fechar
  uma semana anterior ou pular uma intermediária é recusado com o mesmo
  motivo identificável (`APURACAO_FORA_DE_ORDEM`). A primeira apuração da
  empresa (nenhuma semana fechada ainda) permanece livre.
- Q: O registro de tentativas negadas de atribuição/alteração de vínculo
  com papel restrito (FR-012) precisa de tela de consulta dedicada? → A:
  Não. Usa o mecanismo de auditoria já existente, consultável na tela de
  Auditoria já existente no hub — nenhuma tela nova.
- Q: O saldo carregado de semanas anteriores é preservado integralmente
  quando o resultado da semana corrente é negativo? → A: Confirmado sem
  mudança — comportamento já descrito em FR-019 e no Acceptance Scenario 6
  da User Story 3.

### Session 2026-09-26 (plan — revisão de segurança, block-005)

- Q: A trava de papel restrito cobre também a edição do usuário (senha, nome,
  ativo) e a escrita direta na matriz de papéis/permissões? → A: Sim, ambos
  (operador). Ver FR-012a e FR-012b.

### Session 2026-09-26 (checklist — CHK007, block-006)

- Q: Qual versão do piso mínimo (FR-025) vale no fechamento da semana, e o
  valor aplicado fica registrado na apuração? → A: Vale o piso **vigente no
  momento do fechamento** (não o do início da semana); o valor aplicado é
  gravado numa coluna nova `piso_aplicado numeric(14,2)` em
  `ApuracaoRepasse`, para auditoria — apurações fechadas antes desta
  funcionalidade ficam com `piso_aplicado = NULL`. A prévia da semana em
  aberto já usa o piso vigente agora (sem mudança). Ver FR-025a.
- Q: Quando a F3 pode ir ao ar? → A: O operador segura o botão "Fechar
  apuração" em produção até a F3 estar implantada — ordem de deploy
  F1 → F2 → F3 mantida rigorosamente, para que nenhuma semana feche sem a
  regra de saldo mínimo. Pré-condição operacional registrada em
  `plan.md`/`quickstart.md`, não em requisito funcional (não há usuário do
  produto a impedir; é o próprio operador quem controla o botão).

## User Scenarios & Testing

### User Story 1 - Financeiro identifica o motorista sem ambiguidade (Priority: P1)

O financeiro usa a tela "Repasse semanal" (e a planilha exportada dela) para
conciliar pagamentos com os próprios sistemas. Hoje a tela e o CSV só trazem o
nome do motorista, o que obriga o financeiro a cruzar informação manualmente
quando há homônimos ou dados cadastrais inconsistentes. Esta story adiciona,
tanto na tela quanto na exportação, o identificador único do motorista já
usado em outras telas do sistema — sem introduzir um identificador novo.

**Why this priority**: É a mudança de menor risco (não altera cálculo de
valores nem permissões, não exige migração de banco) e resolve uma dor
recorrente e imediata do financeiro na conciliação.

**Independent Test**: Abrir a tela de Repasse semanal (semana corrente e uma
semana já fechada), verificar que o identificador do motorista aparece em
ambas, exportar o CSV e confirmar que o identificador está presente e é
idêntico ao mostrado na tela de Motoristas para o mesmo motorista.

**Acceptance Scenarios**:

1. **Given** a tela de Repasse semanal exibindo a semana corrente, **When** o
   financeiro a visualiza, **Then** cada linha mostra o identificador único do
   motorista, igual ao exibido na tela de Motoristas para o mesmo motorista.
2. **Given** uma semana de repasse já fechada, **When** o financeiro a
   consulta, **Then** o identificador do motorista também aparece, sem
   diferença de comportamento frente à semana corrente.
3. **Given** a tela de Repasse semanal, **When** o financeiro exporta o CSV,
   **Then** o identificador do motorista é a primeira coluna do arquivo.
4. **Given** o identificador exibido na tela, **When** o financeiro tenta
   copiá-lo, **Then** consegue selecioná-lo e colá-lo em outra ferramenta
   (ex.: planilha) sem erro de formatação.

---

### User Story 2 - Aprovação de pagamento restrita a um papel de confiança (Priority: P2)

Hoje, qualquer usuário com o papel "financeiro" ou "administrador da
entidade" pode fechar a apuração semanal, gerar as notas de pagamento e
confirmar ou devolver lotes de adiantamento — ações que movimentam dinheiro
real. O operador quer que só o administrador da plataforma e um novo papel de
confiança, dedicado a essa aprovação, possam executar essas ações. Para não
concentrar tudo em uma única pessoa (ponto único de falha), esse novo papel
mantém todas as demais capacidades do papel "financeiro" hoje existente, mas
só pode ser concedido, alterado ou revogado pelo administrador da plataforma
— fechando também uma brecha hoje existente em que qualquer administrador de
entidade pode promover alguém (inclusive a si mesmo) a administrador da
plataforma.

**Why this priority**: Depende apenas de papéis e permissões já existentes no
sistema (não introduz cálculo novo), mas precisa vir **antes** da story 3,
pois toda mudança nas regras de pagamento (retenção/transporte de saldo)
deve nascer sob o controle de aprovação já restrito.

**Independent Test**: Com um usuário "financeiro" e outro "administrador da
entidade" (sem o papel novo), tentar fechar a apuração, gerar notas e
confirmar um lote — todas as tentativas devem ser recusadas. Atribuir o papel
novo a um usuário e repetir — todas devem funcionar. Tentar, como
administrador de entidade, atribuir o papel novo (ou o de administrador da
plataforma) a alguém — a tentativa deve ser recusada.

**Acceptance Scenarios**:

1. **Given** um usuário com o papel "financeiro" e nenhum papel adicional,
   **When** ele tenta fechar a apuração da semana, gerar as notas da semana,
   ou confirmar/devolver um lote de adiantamento, **Then** o sistema recusa a
   ação em todas elas.
2. **Given** um usuário com o papel "administrador da entidade" e nenhum
   papel adicional, **When** ele tenta qualquer uma das três ações acima,
   **Then** o sistema recusa a ação em todas elas.
3. **Given** um usuário com o novo papel de aprovação (ou com administrador
   da plataforma), **When** ele executa qualquer uma das três ações, **Then**
   o sistema permite normalmente.
4. **Given** um usuário com o novo papel de aprovação, **When** ele realiza
   qualquer tarefa que hoje é do papel "financeiro" (fora as três ações
   restritas), **Then** o sistema permite, sem diferença de comportamento.
5. **Given** um usuário "administrador da entidade" (sem ser administrador da
   plataforma), **When** ele tenta atribuir, alterar ou desativar o vínculo
   de alguém com um papel restrito (administrador da plataforma ou o novo
   papel de aprovação), **Then** o sistema recusa a ação e informa que o
   papel é restrito.
6. **Given** o mesmo usuário "administrador da entidade" tentando as mesmas ações
   do cenário anterior por uma via que não passe pela tela (acesso direto à
   camada de dados), **Then** o sistema recusa igualmente — a restrição não
   depende só da tela.
7. **Given** um "administrador da entidade" atribuindo um papel que não é
   restrito, **When** ele cria ou edita esse vínculo, **Then** o sistema
   permite normalmente, sem regressão.

---

### User Story 3 - Saldo abaixo do mínimo nunca é perdido (Priority: P3)

Motoristas cujo valor a receber numa semana fica muito baixo (abaixo de um
piso mínimo) não recebem naquela semana — mas hoje, se isso acontecesse
(não acontece hoje porque a regra não existe), o valor simplesmente seria
esquecido: nenhum registro guardaria que aquele dinheiro ainda é devido. Esta
story introduz a retenção controlada: quando o total a receber na semana
(incluindo qualquer valor retido de semanas anteriores) fica abaixo do piso,
o motorista não recebe naquela semana, o valor é somado ao cálculo da semana
seguinte automaticamente — inclusive se o motorista não tiver nenhuma
movimentação na semana seguinte — e o motorista vê esse valor retido no
aplicativo. Quando o motorista finalmente recebe, os valores retidos
anteriores entram somados na mesma nota fiscal, sem gerar uma nota extra por
semana em que ficou retido.

**Why this priority**: É a regra de maior valor de negócio (evita que
dinheiro do motorista se perca) mas também a de maior risco — mexe
diretamente no cálculo de pagamento e na emissão de notas fiscais. Por isso
vai por último, depois que a identificação (story 1) e o controle de quem
aprova pagamento (story 2) já estiverem em produção.

**Independent Test**: Simular uma sequência de semanas fechadas para um
motorista cujo total fica abaixo do piso em uma ou mais semanas seguidas e
confirmar que (a) ele não recebe nas semanas retidas, (b) o valor retido
aparece corretamente na semana seguinte mesmo sem movimento, (c) quando o
total acumulado cruza o piso, ele recebe tudo de uma vez numa única nota, e
(d) em nenhum momento a soma dos valores devidos diverge da soma do que foi
efetivamente pago mais o que ainda está retido.

**Acceptance Scenarios**:

1. **Given** um motorista cujo total a receber na semana é maior que zero e
   menor que o piso mínimo, **When** a semana é fechada, **Then** ele não
   recebe nesta semana e o valor total fica registrado como retido para a
   próxima semana.
2. **Given** um motorista com valor retido de uma semana anterior, **When** a
   semana seguinte é fechada — mesmo que ele não tenha tido nenhuma
   movimentação nela —, **Then** o valor retido aparece somado ao cálculo
   dessa semana e continua retido (ou é pago, se cruzar o piso).
3. **Given** um motorista com valores retidos por três semanas seguidas,
   **When** o total acumulado finalmente cruza o piso mínimo em uma semana,
   **Then** ele recebe o valor acumulado das três semanas junto com o valor
   da semana corrente, numa única nota.
4. **Given** um motorista cujo total a receber é exatamente igual ao piso
   mínimo, **When** a semana é fechada, **Then** ele recebe normalmente (o
   piso só retém valores estritamente abaixo dele).
5. **Given** um motorista cujo resultado da semana é negativo e ele não tem
   nenhum valor retido de semanas anteriores, **When** a semana é fechada,
   **Then** nada é retido/transportado — o comportamento permanece o de
   hoje (alerta, sem transporte).
6. **Given** um motorista com um valor retido de uma semana anterior (por
   exemplo, um valor pequeno positivo) e um resultado negativo na semana
   corrente, **When** a semana é fechada, **Then** o valor retido
   anteriormente continua integralmente retido e é transportado para a
   próxima semana — o resultado negativo da semana corrente nunca reduz ou
   apaga o valor já retido.
7. **Given** a última semana fechada de uma empresa, **When** alguém tenta
   fechar uma semana anterior a ela **ou** pula para uma semana posterior
   sem fechar as intermediárias, **Then** o sistema recusa a ação em ambos
   os casos, com o mesmo motivo identificável (`APURACAO_FORA_DE_ORDEM`).
8. **Given** uma semana que já estava fechada antes desta funcionalidade
   existir, **When** o sistema calcula os relatórios após a mudança,
   **Then** o resultado dessa semana permanece idêntico ao que já era antes
   (semanas fechadas não são recalculadas).
9. **Given** um motorista com uma sequência de semanas (algumas retidas,
   outras pagas), **When** somamos tudo que ele deveria ter recebido ao
   longo dessas semanas, **Then** essa soma é igual à soma do que foi
   efetivamente pago mais o que ainda está retido ao final — nenhum valor
   desaparece.
10. **Given** um motorista com saldo retido em aberto, **When** ele abre o
    aplicativo antes de a semana seguinte fechar, **Then** vê uma indicação
    de que aquele valor será somado ao próximo repasse.
11. **Given** uma semana fechada em que o motorista ficou com saldo retido,
    **When** ele consulta essa semana no aplicativo, **Then** vê o valor
    retido e uma indicação de que entra no próximo repasse, no lugar do
    valor a receber daquela semana.

### Edge Cases

- Motorista com saldo retido de uma semana anterior é desativado ou some da
  base antes da próxima semana fechar — o saldo retido não deve ser
  descartado (fica associado ao motorista, disponível para conciliação e
  para quando ele voltar a ter movimentação).
- Duas ou mais semanas seguidas exatamente no limite do piso (nem acima, nem
  abaixo) — cada uma é avaliada de forma independente, sem acúmulo indevido.
- Tentativa de fechar uma semana pulando uma ou mais semanas intermediárias
  ainda não fechadas (mesmo que a semana alvo seja posterior à última
  fechada) — recusada com o mesmo motivo (`APURACAO_FORA_DE_ORDEM`) usado
  para tentar fechar uma semana anterior à última fechada.
- Motorista com saldo retido preso por falta de movimento futuro (nunca
  cruza o piso) — fica fora de escopo desta feature qualquer ação de
  produto para baixar/quitar esse saldo; permanece carregado e visível
  (FR-024) até resolução manual em produção pelo rito do projeto.
- Exportação do CSV de uma semana em que existem motoristas retidos — a
  linha do motorista retido aparece no arquivo com o valor a pagar daquela
  semana explicitamente zerado, nunca omitida.
- Tentativa de atribuir a um mesmo usuário, ao mesmo tempo, um papel restrito
  e alterar seu próprio vínculo — a restrição de "só administrador da
  plataforma altera papel restrito" vale mesmo quando o alvo é o próprio
  usuário autenticado.
- Nenhum usuário com o papel de aprovação existente ainda (papel recém-criado
  sem ninguém vinculado) — as três ações restritas ficam temporariamente
  disponíveis apenas para administrador da plataforma, o que é o
  comportamento esperado até a primeira atribuição.

## Requirements

### Functional Requirements

**Identificação do motorista (User Story 1)**

- **FR-001**: O sistema MUST exibir o identificador único do motorista como
  uma coluna na tela de Repasse semanal, tanto para a semana corrente quanto
  para semanas já fechadas.
- **FR-002**: O sistema MUST incluir o identificador único do motorista como
  coluna na exportação (CSV) do Repasse semanal, para semana corrente e para
  semanas fechadas.
- **FR-003**: O identificador exibido na tela e no CSV MUST ser exatamente o
  mesmo (mesmo valor, mesmo rótulo) já utilizado para o motorista na tela de
  Motoristas do sistema — não pode ser criado um identificador novo nem um
  segundo vocabulário para o mesmo dado.
- **FR-004**: Na exportação (CSV), a coluna do identificador do motorista
  MUST ser a primeira coluna do arquivo.
- **FR-005**: O identificador exibido na tela MUST poder ser selecionado e
  copiado pelo usuário sem erro de formatação, para uso em outras
  ferramentas (ex.: planilhas externas).

**Aprovação restrita (User Story 2)**

- **FR-006**: O sistema MUST permitir fechar a apuração semanal, gerar as
  notas de pagamento da semana, e confirmar ou devolver lotes de
  adiantamento apenas a usuários com o papel de administrador da plataforma
  ou com um novo papel dedicado de aprovação financeira.
- **FR-007**: O sistema MUST negar (com mensagem clara) a execução de
  qualquer uma das três ações do FR-006 a usuários que possuam apenas o
  papel "financeiro" ou apenas o papel "administrador da entidade", sem o
  novo papel de aprovação.
- **FR-008**: O novo papel de aprovação financeira MUST conceder a quem o
  possui todas as capacidades que o papel "financeiro" já concede hoje, além
  da capacidade de aprovação.
- **FR-009**: O sistema MUST permitir que apenas usuários com o papel de
  administrador da plataforma atribuam, alterem ou desativem o vínculo de
  qualquer usuário com um papel restrito (administrador da plataforma ou o
  novo papel de aprovação financeira).
- **FR-010**: O sistema MUST negar, com um motivo identificável, a tentativa
  de um usuário que não seja administrador da plataforma de atribuir,
  alterar ou desativar um vínculo com papel restrito — inclusive quando essa
  tentativa é feita sem passar pela tela do sistema (acesso direto à camada
  de dados).
- **FR-011**: O sistema MUST continuar permitindo que administradores de
  entidade criem usuários e atribuam papéis não-restritos, sem alteração de
  comportamento.
- **FR-012**: O sistema MUST registrar (auditar) toda tentativa negada de
  atribuição/alteração de vínculo com papel restrito, usando o mecanismo de
  auditoria já existente no sistema (consultável na tela de Auditoria já
  existente no hub) — esta feature MUST NOT introduzir uma tela de consulta
  dedicada nova para esse registro.
- **FR-012a**: O sistema MUST permitir alterar senha, nome ou situação
  (ativo) de um usuário que tenha vínculo ativo com papel restrito apenas a
  administradores da plataforma; demais tentativas MUST ser negadas com o
  mesmo motivo identificável da FR-010 e auditadas como na FR-012.
- **FR-012b**: O sistema MUST NOT permitir que usuários autenticados criem ou
  alterem papéis, permissões, módulos ou a matriz papel×permissão por acesso
  direto à camada de dados; a matriz só muda pela operação exclusiva do
  administrador da plataforma já existente.

**Saldo mínimo carregado (User Story 3)**

- **FR-013**: O sistema MUST calcular, para cada motorista e cada semana, um
  total a receber que soma o resultado da própria semana com qualquer valor
  retido de semanas anteriores.
- **FR-014**: Quando esse total for maior que zero e menor que um piso
  mínimo configurado (valor padrão: R$ 5,50), o sistema MUST reter o
  pagamento da semana inteira para aquele motorista.
- **FR-015**: Quando esse total for igual ou maior que o piso mínimo, o
  sistema MUST liberar o pagamento do valor total (incluindo o que estava
  retido de semanas anteriores).
- **FR-016**: Um valor retido nos termos do FR-014 MUST ser automaticamente
  incluído no cálculo da semana seguinte, mesmo que o motorista não tenha
  nenhuma movimentação (créditos, débitos ou adiantamentos) naquela semana
  seguinte.
- **FR-017**: O sistema MUST NOT descartar ou deixar de considerar um valor
  retido em nenhuma execução de fechamento futura, até que ele seja pago.
  Fora de escopo desta feature: qualquer ação de produto (tela, endpoint)
  para baixar/quitar manualmente um saldo retido de motorista sem
  movimento futuro — quando necessária, essa baixa é sempre uma escrita
  manual em produção pelo rito do projeto, caso a caso.
- **FR-018**: Quando o resultado da própria semana for negativo, o sistema
  MUST continuar sem transportar esse valor negativo (comportamento atual
  mantido: alerta, sem transporte). Isso vale só para o CAIXA da semana
  (`valor_pago`/`valor_transportado`, banco) — a produção nota-elegível
  dessa mesma semana (`valor_nota`/`valor_fora_nota`) NÃO fica presa: o
  sistema MUST gerar a nota fiscal da PRÓPRIA semana negativa normalmente
  (`planejarGeracao`), mesmo quando o motorista tiver saldo carregado de
  semana(s) anterior(es) — uma semana com resultado negativo nunca é
  "retida" nos termos do FR-014 (decisão do operador ao block-008,
  dec-055 — revisão adversarial da F3; o saldo carregado permanece
  intocado, FR-019, e não entra nessa nota — só na nota da semana em que
  finalmente for pago, FR-020).
- **FR-019**: Quando um motorista tiver valor retido de semana(s) anterior(es)
  e o resultado da semana corrente for negativo, o sistema MUST preservar o
  valor retido anterior integralmente e transportá-lo para a próxima semana,
  sem reduzi-lo pelo resultado negativo da semana corrente.
- **FR-020**: Quando um motorista finalmente receber pagamento após uma ou
  mais semanas com valor retido, o sistema MUST somar os valores retidos ao
  pagamento da semana corrente numa única nota fiscal — MUST NOT gerar uma
  nota fiscal adicional por semana em que houve retenção. (Semana com
  resultado negativo, FR-018, não conta como "semana com valor retido" para
  este efeito — ela já gerou sua própria nota na hora, com a produção
  daquela semana; o que segue acumulando é só o saldo carregado antigo.)
- **FR-021**: O sistema MUST permitir fechar apenas a semana de apuração
  imediatamente seguinte, em ordem cronológica, à última semana já fechada
  da mesma empresa — impedindo tanto o fechamento de uma semana anterior
  quanto o de uma semana posterior que pule uma ou mais semanas
  intermediárias ainda não fechadas — com um motivo identificável (ex.:
  `APURACAO_FORA_DE_ORDEM`). Quando a empresa ainda não tiver nenhuma
  semana fechada, a primeira apuração MUST permanecer livre, respeitando a
  janela de apuração já configurada.
- **FR-022**: O sistema MUST NOT recalcular ou alterar o resultado de uma
  semana de apuração que já estava fechada antes desta funcionalidade entrar
  em vigor.
- **FR-023**: O sistema MUST exibir ao motorista, no aplicativo, quando
  existir um valor retido de semana(s) anterior(es) — tanto durante a semana
  em curso quanto na consulta de uma semana já fechada em que ele ficou
  retido.
- **FR-024**: Na exportação (CSV) e na tela usadas pelo financeiro, uma
  semana com motorista retido MUST mostrar explicitamente o valor a pagar
  daquela semana como zero — nunca omitir a linha do motorista.
- **FR-025**: O piso mínimo usado no FR-014 MUST ser um valor de
  configuração **por empresa**, armazenado na coluna
  `repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50` da tabela
  `AdiantamentoConfiguracao` (mesma tabela versionada que já guarda os
  demais parâmetros do módulo, já escopada por `id_empresa`), com valor
  padrão de R$ 5,50. O sistema MUST rejeitar um valor informado menor ou
  igual a zero.
- **FR-026**: O sistema MUST permitir alterar o piso mínimo (FR-025) apenas
  a usuários com a permissão `adiantamentos.pagamento_confirmar` — a mesma
  já exigida para fechar apuração e confirmar/devolver lotes de
  adiantamento — e MUST negar a alteração desse campo especificamente a
  quem possui apenas a permissão mais ampla `adiantamentos.configurar`
  (usada pelos demais campos de configuração do módulo). A checagem MUST
  ocorrer tanto no backend quanto no banco de dados, não apenas na
  interface.
- **FR-025a**: No fechamento coberto pelo FR-021, o sistema MUST aplicar o
  piso mínimo (FR-025) **vigente no momento do fechamento** — não o vigente
  no início da semana — e MUST gravar o valor efetivamente aplicado numa
  coluna nova `piso_aplicado` em `ApuracaoRepasse`, para auditoria.
  Apurações fechadas antes desta funcionalidade entrar em vigor MUST manter
  `piso_aplicado` nulo (sem reprocessamento, FR-022). A prévia da semana
  ainda aberta continua usando o piso vigente no momento da consulta, sem
  gravação (não há fechamento).

> Decisões de infraestrutura: N/A — feature síncrona, orientada a requisição
> HTTP/tela, sem scheduler novo, sem criptografia de dado persistido, sem
> refresh de token externo, sem lock multi-processo novo e sem rotina de
> backup dedicada. Usa a infraestrutura de fechamento semanal e de papéis já
> existente no sistema.

### Key Entities

- **Motorista (Entregador)**: pessoa que presta serviço e recebe repasse
  semanal; possui um identificador único, já usado por outras telas do
  sistema, que passa a aparecer também no repasse.
- **Semana de Repasse (Apuração)**: registro do resultado financeiro de um
  motorista numa semana — créditos, débitos, adiantamentos e o resultado
  líquido. Uma vez fechada, é imutável.
- **Saldo Carregado**: valor que ficou retido numa semana por estar abaixo do
  piso mínimo e que passa a compor o cálculo da semana seguinte até ser
  pago. O piso mínimo é configurável por empresa (FR-025) e só pode ser
  alterado por quem tem a permissão `adiantamentos.pagamento_confirmar`
  (FR-026).
- **Papel de Aprovação Financeira**: conjunto de permissões que inclui tudo
  que o papel financeiro já faz, mais a capacidade de aprovar as ações que
  movimentam pagamento (fechar apuração, gerar notas, confirmar/devolver
  lote de adiantamento). Só pode ser concedido por um administrador da
  plataforma.
- **Lote de Adiantamento**: conjunto de pagamentos antecipados que precisa de
  confirmação ou devolução — passa a exigir o mesmo nível de aprovação das
  demais ações de pagamento.

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% dos motoristas com repasse na tela e na exportação
  passam a trazer o identificador único usado para conciliação (medido numa
  semana com 1.021 motoristas no repasse).
- **SC-002**: O financeiro consegue conciliar qualquer motorista do repasse
  usando somente o identificador exibido na tela ou no CSV, sem precisar
  consultar outra tela para descobrir a que motorista uma linha pertence.
- **SC-003**: 100% das tentativas de fechar apuração, gerar notas da semana
  ou confirmar/devolver lote de adiantamento por um usuário sem o papel de
  aprovação (financeiro ou administrador de entidade puros) são recusadas.
- **SC-004**: 100% das tentativas de atribuir, alterar ou desativar um
  vínculo com papel restrito por alguém que não é administrador da
  plataforma são recusadas, inclusive quando a tentativa não passa pela
  tela do sistema.
- **SC-005**: Numa sequência de semanas simuladas em que um motorista fica
  abaixo do piso mínimo em uma ou mais semanas seguidas, a soma de tudo que
  ele deveria receber ao longo da sequência é idêntica à soma do que foi
  pago mais o que permanece retido ao final — nenhum valor perdido, em 100%
  dos casos testados.
- **SC-006**: Um motorista cujo valor ficou retido numa semana o vê refletido
  no aplicativo antes de a próxima semana fechar, sem precisar de suporte
  para entender o que aconteceu com o pagamento.
- **SC-007**: Semanas de apuração fechadas antes da entrada em vigor desta
  funcionalidade produzem resultado idêntico ao que já produziam antes,
  após a mudança (nenhuma regressão em dado histórico).

## Delta Requirements

**Skip**: este projeto ainda não mantém um corpus de living-specs em
`docs/specs/current/` (diretório inexistente na data desta spec) — não há
capability documentada para referenciar ou versionar como delta. —
agente-00c-feature-orchestrator, 2026-09-26
