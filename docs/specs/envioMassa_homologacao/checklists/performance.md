# PERFORMANCE Checklist: Notificações push no app do motorista

**Purpose**: validar a qualidade dos requisitos de desempenho — alvos mensuráveis
(SC-003/SC-004/SC-005), concorrência do envio em lote, retry/backoff e a premissa de
réplica única que sustenta rate limit e cache de RBAC em memória.
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md), [plan.md](../plan.md) §NFRs/§Riscos

## Alvos mensuráveis

- [x] CHK001 - O alvo de confirmação do disparo (até 3s, independente do número de
  destinatários — SC-004) está associado a uma arquitetura que não faz laço síncrono
  sobre destinatários dentro da requisição (disparo = 1 função SQL, envio em segundo
  plano)? [Mensurabilidade, Spec §SC-004, FR-017, Plan §NFRs Desempenho] {auto}
- [x] CHK002 - O alvo de entrega em até 1 minuto para 95% das entregas aceitas
  (SC-003) tem um mecanismo de verificação definido, ainda que manual (Quickstart
  Scenario 21, com aparelho real e operador)? [Mensurabilidade, Spec §SC-003, Quickstart
  Scenario 21] {auto}
- [ ] CHK003 - SC-005 ("as demais telas do hub e do app continuam respondendo sem erros
  atribuíveis ao envio" durante o processamento de um aviso para toda a base) não tem
  nenhum cenário do quickstart (1-21) referenciando SC-005 explicitamente. [Gap, Spec
  §SC-005, Quickstart] — recomendar que `create-tasks` inclua um cenário de carga ou de
  observação concorrente associado a este critério, não apenas o desenho arquitetural
  que o sustenta. {auto}

## Concorrência e confiabilidade

- [x] CHK004 - A concorrência limitada do envio em lote (FR-017) tem valores concretos
  definidos (lote de 50, 10 envios simultâneos por aviso, 1 aviso por vez por processo,
  lease de 120s), em vez de ficar apenas como "concorrência limitada" sem número?
  [Clareza/Mensurabilidade, Plan.md:84, Research.md Decision 4] {auto}
- [x] CHK005 - O retry de falha transitória (FR-019, "número limitado, espera
  crescente") tem os parâmetros exatos definidos (até 3 tentativas, espera de 1s e 4s),
  e a classificação transitória vs. definitiva (429/5xx/timeout/sem statusCode vs. 4xx)
  está inequívoca? [Clareza/Mensurabilidade, Spec §FR-019, Research.md Decision 5] {auto}
- [x] CHK006 - O mecanismo de exclusão entre instâncias do backend (`FOR UPDATE SKIP
  LOCKED` + lease com `lease_token`) está descrito com detalhe suficiente para ser
  testável (o que acontece se o lease vencer com a entrega em voo), cobrindo o edge case
  de reinício no meio do processamento (FR-018, SC-010)? [Mensurabilidade, Spec §FR-018,
  SC-010, Data-model.md PushEntrega/lease_ate] {auto}

## Premissa de escala (réplica única)

- [x] CHK007 - Rate limit (em memória por processo) e cache de RBAC (em memória por
  processo, R6) dependem da premissa de 1 réplica por serviço em produção — confirmada
  pelo operador via `docker service ls` em 2026-09-11 (dec-044/block-005): os 4 serviços
  do host estão `replicated 1/1`. Premissa válida; rate limit e cache seguem seguros sem
  store compartilhado. [Risco resolvido, Plan §R6] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **Resolução**: 6 `{auto}` resolvidos (`[x]`), 1 `[Gap]` aberto (CHK003), 0 `{humano}`
  pendente — CHK007 resolvido nesta onda (dec-044/block-005: 1 réplica confirmada).
