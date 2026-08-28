# Requirements Checklist: Robô de Importação EntreGô

**Purpose**: qualidade geral dos requisitos — completude, clareza, consistência e
cobertura de cenários — com foco nos clusters operacional/confiabilidade e de
integração externa (fora do que já foi coberto em `checklists/security.md`).
**Created**: 2026-08-27
**Feature**: [spec.md](../spec.md)

## Cobertura de Cenários (gate determinístico)

- [x] CHK001 - Todo requisito funcional tem pelo menos um cenário de aceite
  associado? [Cobertura] {auto} — `requirement-coverage.sh spec.md` →
  `requirements=16|covered=16|errors=0` (16/16 FRs, incluindo FR-016 adicionado no
  clarify; 0 findings).

## Idempotência e Deduplicação

- [x] CHK002 - O comportamento diante de reenvio do mesmo arquivo é definido e
  tratado como sucesso, não erro? [Completude, Spec §FR-008] {auto} — FR-008: "MUST
  tratar uma resposta do hub indicando que o arquivo já foi importado anteriormente
  como sucesso, não como falha".
- [x] CHK003 - O critério de "mesmo relatório" é mensurável (não subjetivo)?
  [Mensurabilidade, Spec §SC-004] {auto} — SC-004: "nunca produz um segundo
  registro para o mesmo dia no hub" — critério objetivo (mesma data de referência);
  reforçado por US1 cenário 2.

## Retry e Alerta

- [x] CHK004 - O número de tentativas e o intervalo de backoff são quantificados
  (não "algumas tentativas")? [Mensurabilidade, Spec §Clarifications, FR-012] {auto}
  — quantificado explicitamente: "até 3 tentativas, com backoff crescente de 1, 5 e
  15 minutos" (resposta registrada na sessão de clarify + FR-012).
- [x] CHK005 - O SLA de tempo entre falha definitiva e alerta ao operador é
  mensurável? [Mensurabilidade, Spec §SC-002] {auto} — SC-002: "em até 15 minutos
  após a última tentativa fracassada" — métrica numérica clara.
- [ ] CHK006 - A spec distingue explicitamente "falha transitória que ainda está
  em retry" de "falha definitiva" nos termos usados nos requisitos, ou depende de
  inferência do leitor? [Clareza, Spec §FR-012 + FR-013] {auto} — **parcialmente
  coberto**: FR-012 define retry para falha "transitória" e FR-013 fala em "esgotar
  as tentativas... sem sucesso", mas a spec não define EXPLICITAMENTE o que torna
  uma falha "transitória" (vs. definitiva-sem-retry, ex.: erro de configuração ou
  desafio anti-bot) — a distinção de fato só existe em `research.md` Decision 11
  (plan.md, Phase 0), não na spec. Não é [Gap] crítico (FR-011 já cobre
  explicitamente o caso do anti-bot como parada imediata, distinto de "transitório")
  mas vale nota para uma futura revisão de spec.

## Agendamento e Concorrência (User Story 4)

- [x] CHK007 - O comportamento diante de dois horários sobrepostos é definido de
  forma não-ambígua (fila vs. descarte vs. paralelo)? [Clareza, Spec §FR-010] {auto}
  — FR-010: "impedir que duas execuções agendadas rodem ao mesmo tempo... mesmo que
  os horários... coincidam ou se sobreponham"; Acceptance Scenario 2 da US4 detalha
  "a segunda aguarda ou é descartada, nunca roda em paralelo" — a spec
  DELIBERADAMENTE deixa "aguarda OU descarta" como escolha de implementação (ambas
  satisfazem o requisito), não uma ambiguidade não-resolvida.
- [x] CHK008 - A mudança de horário de execução é testável sem exigir novo deploy?
  [Mensurabilidade, Spec §SC-005] {auto} — SC-005: "só editando configuração —
  nenhuma mudança de código nem novo empacotamento... é necessária" — critério
  binário e verificável.

## Integração Externa (Portal EntreGô)

- [x] CHK009 - O escopo de dados coletados (quais relatórios, de qual período) é
  definido sem ambiguidade? [Clareza, Spec §FR-003] {auto} — FR-003: "para cada
  tipo de relatório suportado (Performance e Financeiro)... o relatório referente
  ao dia imediatamente anterior à data de execução" — período e tipos explícitos.
- [x] CHK010 - O comportamento diante de ausência de dados no portal (dia sem
  movimento) é definido como não-falha? [Cobertura de Edge Case, Spec §US1] {auto}
  — US1 Acceptance Scenario 3: "reconhece a ausência de dados e não trata isso como
  uma falha".
- [x] CHK011 - O tempo de espera pela geração assíncrona do relatório tem
  tratamento definido para o caso de demora excessiva? [Cobertura de Edge Case,
  Spec §FR-004 + Edge Cases] {auto} — FR-004 + Edge Cases: "demora além de um tempo
  limite" tratada "como falha de tentativa" — não fica esperando indefinidamente.
  (Nota: o valor NUMÉRICO do timeout não está na spec — apropriadamente, é decisão
  de implementação, não de requisito de negócio.)

## Rejeição pelo Hub

- [x] CHK012 - O comportamento diante de rejeição do arquivo pelo hub (tipo/
  conteúdo inválido) inclui requisito de rastreabilidade do motivo para o operador?
  [Completude, Spec §Edge Cases] {auto} — Edge Cases + US3 cenário 3: "o motivo da
  rejeição fica registrado de forma que o operador entenda a causa sem precisar
  investigar logs brutos do servidor".

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`)
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto
- Nenhum `[Gap]` crítico neste checklist — CHK006 é observação de clareza, não
  bloqueante (a distinção já existe operacionalmente em `research.md`, só não está
  formalizada na linguagem da spec).
- Ver `checklists/security.md` para o gap mais material do conjunto (CHK011 lá —
  comportamento de falha parcial entre os 2 tipos de relatório).

### Próximos Passos

- `/create-tasks` — os gaps abertos (security.md CHK011, principalmente) viram
  tarefa de definição explícita no backlog, com a resolução padrão proposta já
  registrada como ponto de partida.
