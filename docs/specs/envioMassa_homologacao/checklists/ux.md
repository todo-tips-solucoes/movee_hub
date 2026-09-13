# UX Checklist: Notificações push no app do motorista

**Purpose**: validar a qualidade dos requisitos de experiência — estados de ativação,
tela de detalhe do aviso (FR-013), formulário de criação no hub, rotulagem de resultado
e cobertura, e lacunas de acessibilidade/copy não tratadas na spec.
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md), [contracts/hub-avisos.md](../contracts/hub-avisos.md),
[contracts/motorista-push.md](../contracts/motorista-push.md)

## Estados de ativação (app do motorista)

- [x] CHK001 - Cada estado de ativação do aparelho (ativas, bloqueadas, iOS sem
  instalação, sem suporte, não ativadas) tem uma mensagem/orientação distinta definida,
  sem dois estados compartilhando o mesmo texto genérico? [Clareza/Completude, Spec
  §FR-004/FR-005/FR-006/FR-007] {auto}
- [x] CHK002 - O conteúdo mínimo do passo de contexto (FR-001, "explica o valor dos
  avisos") fica livre para quem implementar decidir — o operador revisa o texto final no
  PR (dec-045/block-006). [Ambiguity resolvida, Spec §FR-001] {auto}
- [ ] CHK003 - O ponto de entrada para ativar depois de dispensar o contexto (Acceptance
  Scenario US1.7) não tem localização definida (tela/menu específico) — só que "continua
  visível" (contrato cita a chave `localStorage` que evita reabrir o passo, não onde o
  botão fica). [Gap, Spec §Acceptance Scenario US1.7, Contracts motorista-push.md§Estado
  local] {auto}

## Tela de detalhe do aviso (FR-013)

- [x] CHK004 - Os 3 casos do toque na notificação (aviso válido, expurgado, inexistente,
  e motorista não destinatário) resultam na MESMA resposta observável ("aviso não
  disponível"), evitando que a UI revele qual dos casos ocorreu? [Consistência/
  Segurança, Spec §FR-013, Contracts motorista-push.md GET /avisos/:id] {auto}
- [x] CHK005 - O fluxo de sessão expirada ao tocar na notificação (login → mesmo
  destino, via `next=<caminho>`) está completo, incluindo a validação do parâmetro
  `next` contra o achado de open redirect (S3)? [Completude/Segurança, Spec §FR-013
  Acceptance Scenario 7, Contracts motorista-push.md§Rotas novas, Plan §S3] {auto}

## Formulário de criação de aviso (hub)

- [x] CHK006 - O limite de caracteres do título e da mensagem (60/180) é mensurável e
  consistente entre spec ("limite de tamanho compatível com o canal") e o contrato, que
  fixa os números exatos? [Mensurabilidade/Clareza, Spec §FR-021, Contracts hub-
  avisos.md POST /avisos] {auto}
- [x] CHK007 - A prévia de alcance antes do disparo (FR-016) define o comportamento
  visual quando o número é zero (botão de disparo desabilitado), não só o requisito
  funcional de bloqueio no servidor? [Completude, Spec §FR-016, Contracts hub-
  avisos.md§Telas FV2] {auto}

## Resultado e cobertura

- [x] CHK008 - O rótulo de "aceitos" no resultado do aviso (FR-022) tem o texto exato
  definido no contrato ("Aceitos pelo serviço de push"), evitando que a implementação
  use um texto ambíguo como "entregue" ou "lido"? [Clareza, Spec §FR-022, Contracts
  hub-avisos.md GET /:id] {auto}
- [x] CHK009 - Os rótulos de plataforma e motivo de impedimento na tela de cobertura
  (US4/SC-011) são consistentes entre spec, contrato e data-model (mesmos nomes de
  categoria: android/ios/desktop_outros; iosSemInstalacao/bloqueadas/semSuporte)?
  [Consistência, Spec §FR-023, Contracts hub-avisos.md GET /cobertura, Data-model.md
  §PushEstadoAtivacao] {auto}

## Requisitos não-funcionais de UX

- [x] CHK010 - Acessibilidade básica (foco visível, rótulos acessíveis, navegação por
  teclado) entra no escopo desta entrega para as duas superfícies novas (passo de
  contexto no app motorista, formulário "Novo aviso" no hub) — decisão do operador
  (dec-046/block-007), agora requisito FR-032/SC-012. [Gap resolvido, Spec §FR-032] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **Resolução**: 9 `{auto}` resolvidos (`[x]`), 1 `[Gap]` aberto (CHK003), 0 `{humano}`
  pendente — CHK002 e CHK010 resolvidos nesta onda (dec-045/block-006, dec-046/block-007).
