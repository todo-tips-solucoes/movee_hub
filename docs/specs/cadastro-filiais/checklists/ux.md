# UX Checklist: Cadastro de Filiais

**Purpose**: Valida a qualidade dos requisitos de UX do formulário "Cadastrar filial" — labels, erros, foco, feedback de loading/sucesso, estado vazio e confirmação de desvincular.
**Created**: 2026-06-09
**Feature**: [spec.md](../spec.md)

## Labels e Estrutura do Formulário

- [x] CHK001 - Os campos obrigatórios do formulário estão enumerados na spec? [Completude, Spec §FR-001] {auto}
  > FR-001 lista: nome da empresa, e-mail, senha, CNPJ (obrigatórios) + endereço, número, CEP, e-mail de nota fiscal, observação (opcionais). Enumeração completa.

- [ ] CHK002 - Os rótulos visíveis (labels) de cada campo estão especificados na spec ou no plano? [Completude, Spec §FR-001] {humano}
  > Spec e contrato nomeiam os campos em snake_case de API (`nome_empresa`, `email_nota`), mas não definem os rótulos de UI ("Nome da empresa", "E-mail da nota fiscal", etc.). Sem especificação de labels, a implementação pode divergir do esperado pelo produto. Decisão: definir labels canônicos na spec ou deixar para o designer?

- [ ] CHK003 - Há distinção visual especificada entre campos obrigatórios e opcionais no formulário? [Clareza, Spec §FR-001] {humano}
  > Spec distingue obrigatórios dos opcionais na descrição, mas não especifica como comunicar essa distinção na UI (asterisco, seção separada, placeholder diferente). Decisão: como indicar visualmente quais campos são opcionais?

- [ ] CHK004 - A organização dos campos fiscais opcionais (se em seção colapsável, accordion, ou inline) está especificada? [Clareza, Spec §FR-001] {humano}
  > Spec menciona "dados fiscais opcionais" como grupo, mas não especifica a estrutura visual (todos inline, seção separada, progressiva). Para formulários com 9 campos, a organização afeta diretamente a usabilidade.

## Feedback de Erro por Campo

- [x] CHK005 - O requisito de exibir erros abaixo do campo inválido está especificado? [Completude, Spec §FR-008] {auto}
  > FR-008: "mensagens de erro por campo logo abaixo do respectivo input." Explícito.

- [x] CHK006 - O requisito de foco automático no primeiro campo inválido ao submeter está especificado? [Completude, Spec §FR-008] {auto}
  > FR-008: "com foco automático no primeiro campo inválido ao submeter." Explícito.

- [x] CHK007 - Cenários de erro por campo específico estão descritos em user stories testáveis? [Completude, Spec §US-002] {auto}
  > US-002 cobre: e-mail duplicado (erro abaixo do campo + foco nele), CNPJ duplicado, CNPJ formato inválido, senha fraca, nome ausente. Cinco cenários com Given/When/Then.

- [ ] CHK008 - O comportamento do erro ao campo ser corrigido pelo usuário está especificado (limpar erro ao digitar ou somente ao re-submeter)? [Clareza, Spec §US-002] {humano}
  > Spec define quando o erro aparece (ao submeter), mas não quando desaparece (on-change? on-blur? somente na próxima submissão?). Comportamento de "limpar erro" não especificado. Decisão: qual o momento de dismissal do erro inline?

- [ ] CHK009 - O comportamento do medidor de força de senha (quando aparece — ao focar, ao digitar, ao submeter) está especificado? [Clareza, Spec §FR-008] {humano}
  > FR-008 menciona "medidor de força de senha", mas não especifica: aparece sempre ou só após interação? Em tempo real ao digitar ou só ao sair do campo? Decisão: comportamento temporal do medidor.

## Feedback de Loading e Sucesso

- [x] CHK010 - O requisito de feedback de carregamento durante a submissão está especificado? [Completude, Spec §FR-009] {auto}
  > FR-009: "exibir feedback de carregamento durante a submissão." Explícito.

- [x] CHK011 - O requisito de feedback de sucesso está especificado? [Completude, Spec §FR-009] {auto}
  > FR-009: "feedback de sucesso ao concluir, recarregando a lista de filiais sem recarregar a página inteira." Explícito.

- [ ] CHK012 - O comportamento do formulário após sucesso está especificado (limpar campos, fechar modal, redirecionar)? [Clareza, Spec §FR-009] {humano}
  > FR-009 especifica que a lista recarrega sem recarregar a página, mas não define o destino do formulário: ele fecha? Os campos são limpos para um novo cadastro? Exibe toast de sucesso por quanto tempo? Decisão: UX pós-sucesso do formulário.

- [ ] CHK013 - O comportamento do botão de submit durante o carregamento está especificado (desabilitado para evitar duplo envio)? [Clareza, Spec §FR-009] {humano}
  > Spec menciona "feedback de carregamento" mas não especifica que o botão de submit deve ser desabilitado durante a request, prevenindo duplo envio. Decisão: botão desabilitado + spinner, ou apenas spinner visual?

## Estado Vazio e Tela de Não-Admin

- [x] CHK014 - O requisito de estado vazio (grupo sem filiais) está especificado? [Completude, Spec §SC-005] {auto}
  > SC-005: "A tela de configurações do grupo exibe estado vazio amigável para grupos sem filiais." Explícito, embora o texto do estado vazio não esteja definido.

- [ ] CHK015 - O texto ou componente visual do estado vazio está especificado (o que exibir quando não há filiais)? [Clareza, Spec §SC-005] {humano}
  > SC-005 diz "estado vazio amigável" sem definir o conteúdo (ícone? texto explicativo? call-to-action direto para o formulário?). Decisão: copy e visual do empty state.

- [x] CHK016 - O requisito de tela de bloqueio para não-admins está especificado? [Completude, Spec §SC-005 + US-003] {auto}
  > SC-005 e US-003 SC-1: "formulário de cadastro de filiais não é exibido e uma mensagem informativa é apresentada." Comportamento definido.

- [ ] CHK017 - O texto da mensagem informativa exibida para não-admins está especificado? [Clareza, Spec §US-003 SC-1] {humano}
  > Spec define que "mensagem informativa é apresentada" sem definir o texto. Decisão: copy da mensagem de não-autorizado.

## Confirmação de Desvincular

- [x] CHK018 - O requisito de manter o comportamento de desvinculamento existente está especificado? [Completude, Spec §FR-010] {auto}
  > FR-010: "o desvinculamento de filiais (DELETE) [...] nenhum comportamento existente é removido." Explícito.

- [ ] CHK019 - Há requisito de confirmação antes do desvincular (dialog/modal de confirmação)? [Completude, Spec §FR-010] {humano}
  > Spec mantém o DELETE sem adicionar nem remover a confirmação, mas não especifica se o fluxo existente tem ou não um diálogo de confirmação. Se a ação é irreversível para o negócio, a ausência de confirmação é risco de UX. Decisão: o desvincular exige confirmação explícita do usuário?

## Notes

- Items `{auto}` resolvidos com citação de evidência
- 9 items `{humano}` abertos — maioria sobre copy/visual/comportamento temporal não especificados na spec
- Gaps CHK002-CHK004 (labels e organização) são os mais críticos para implementação coerente do formulário
- Nenhum gap bloqueante de fluxo principal; gaps são de refinamento de UX
