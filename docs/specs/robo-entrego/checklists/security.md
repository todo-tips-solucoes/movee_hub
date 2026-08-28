# Security Checklist: Robô de Importação EntreGô

**Purpose**: validar a qualidade dos requisitos de segurança da spec (autenticação
automatizada, segredos, sessão persistida, anti-bot) — não a implementação, que
ainda não existe.
**Created**: 2026-08-27
**Feature**: [spec.md](../spec.md)

## Autenticação Automatizada

- [x] CHK001 - É explícito que a rotina NUNCA deve tentar contornar/resolver um
  desafio de verificação humana? [Completude, Spec §FR-011] {auto} — "sem tentar
  resolver, repetir de forma automatizada, ou de qualquer outra forma contornar
  essa proteção" (FR-011); reforçado por SC-003 (métrica de zero contornos).
- [x] CHK002 - É definido o critério de sucesso para a leitura do código de 2FA
  (mensagem mais recente E não reaproveitada)? [Clareza, Spec §FR-002] {auto} —
  FR-002: "lendo automaticamente a mensagem mais recente e não utilizada, com o
  assunto correspondente"; Edge Case reforça "não reaproveita um código já
  consumido em outra tentativa".
- [ ] CHK003 - A spec define o que fazer se a MESMA execução tentar login mais de
  uma vez (ex.: retry de uma falha transitória durante o login) e cada tentativa
  disparar um NOVO e-mail de código — como o robô distingue qual código pertence a
  qual tentativa? [Ambiguity, Spec §FR-002 + FR-012] {humano} — a spec cobre "mais
  de uma mensagem não lida" (Edge Case) mas não cobre explicitamente retries do
  PRÓPRIO login gerando múltiplos e-mails na mesma execução. `plan.md`/
  `contracts/entrego-portal.md` já resolvem isso na prática (timestamp do
  `POST authentication/validate` MAIS RECENTE por tentativa) — mas a spec em si
  não amarra esse comportamento a um FR. Decisão de produto: aceitar a resolução
  técnica do plano como suficiente, ou formalizar em spec?

## Segredos e Credenciais

- [x] CHK004 - Toda credencial usada pela rotina tem requisito explícito de
  armazenamento fora do controle de versão? [Completude, Spec §FR-014] {auto} —
  FR-014 lista as 4 categorias (portal, e-mail, hub, destino de alerta)
  explicitamente.
- [x] CHK005 - O requisito de armazenamento de segredo é mensurável/verificável
  (não um adjetivo vago como "seguro")? [Mensurabilidade, Spec §FR-014] {auto} —
  "fora do controle de versão do código-fonte" é um critério objetivo e
  verificável (grep no git), não um adjetivo vago.

## Sessão Persistida (Portal EntreGô)

- [x] CHK006 - A spec define claramente quando a rotina deve refazer login
  completo (vs. reusar sessão)? [Clareza, Spec §FR-016] {auto} — FR-016: "só MUST
  rodar quando essa tentativa retornar `401`"; critério objetivo e binário.
- [x] CHK007 - A decisão de NÃO medir/assumir duração de sessão está registrada
  como decisão deliberada (não uma omissão)? [Consistência, Spec §Clarifications]
  {auto} — seção Clarifications registra a resposta `block-003` explicitamente
  como requisito dissolvido, com justificativa.

## Detecção de Desafio Anti-Bot

- [ ] CHK008 - A spec define um critério objetivo/verificável para "detectar
  sinal de desafio de verificação humana", ou deixa a detecção em si como
  subjetiva? [Mensurabilidade, Spec §FR-011] {humano} — FR-011 diz "detectar
  qualquer sinal" mas não define a ASSINATURA desse sinal (nem poderia: o
  levantamento técnico nunca observou um desafio real ocorrendo —
  `docs/plans/robo-entrego/ACHADOS-PORTAL.md` §6 é explícito sobre isso).
  `research.md` Decision 11 já declara a mitigação (postura conservadora,
  qualquer desvio estrutural = suspeita) — decisão de produto: esse nível de
  precisão é aceitável para MVP, ou a spec deveria exigir uma fonte de sinal mais
  específica antes de implementar (ex.: aguardar até observar um desafio real em
  ambiente controlado)?
- [x] CHK009 - É mensurável quando a rotina considera que "conseguiu se
  recuperar sozinha" de uma falha transitória vs. quando desiste? [Mensurabilidade,
  Spec §FR-012] {auto} — FR-012 quantifica exatamente: "até 3 vezes, com backoff
  crescente de 1, 5 e 15 minutos" — critério numérico, sem ambiguidade.

## Auditoria e Rastreabilidade

- [x] CHK010 - Toda falha definitiva tem requisito de registro em MÚLTIPLOS
  canais (não um único ponto de falha de visibilidade)? [Completude, Spec §FR-013]
  {auto} — FR-013 exige as 3 reações simultâneas (log + e-mail + auditoria do hub),
  "nunca apenas uma delas".
- [ ] CHK011 - A spec define o que "produzir simultaneamente as três reações"
  significa quando UM tipo de relatório falha definitivamente mas o OUTRO tem
  sucesso na mesma execução (falha parcial) — as 3 reações disparam mesmo assim, só
  para o relatório que falhou? [Gap, Spec §FR-013] {auto} — **NÃO especificado em
  spec.md**. `data-model.md` (Phase 1 do plan) já introduziu o conceito
  `resultado: falha_parcial` como decisão de design, mas a SPEC não amarra esse
  comportamento a nenhum FR — é uma lacuna real de requisito, não uma decisão já
  tomada pelo dono do produto. Segue para `create-tasks` como tarefa de definição
  (ver Notes).

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`)
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto
- **CHK011 é o gap mais material deste checklist**: segue para `create-tasks` como
  tarefa "definir se falha parcial (1 de 2 relatórios falha) dispara as 3 reações
  de FR-013 isoladamente para o relatório afetado" — resolução padrão proposta (a
  confirmar no backlog): SIM, dispara para o relatório afetado, já que é a leitura
  mais conservadora e a única consistente com `resultado: falha_parcial` do
  data-model.md.
- CHK003 e CHK008 ficam `{humano}` — não são bloqueantes para `create-tasks` (o
  `plan.md`/`research.md` já têm uma resolução técnica razoável para os dois), mas
  o dono do produto pode querer formalizá-los na spec numa rodada futura de
  `/clarify`.
