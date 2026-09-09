# Requirements Checklist: Enriquecimento automático de entregadores novos

**Purpose**: Gate de qualidade dos requisitos (spec.md) antes de `create-tasks` — "unit tests for English", não verificação de implementação.
**Created**: 2026-09-08
**Feature**: [spec.md](../spec.md)

## Completude de Requisitos

- [x] CHK001 - Os requisitos cobrem os quatro eixos de estado que a feature introduz (criação vs. atualização, empresa habilitada vs. não, dentro vs. fora do teto, origem manual vs. automática)? [Completude, Spec §FR-001, FR-002, FR-010, FR-011, FR-012] {auto}
  Evidência: FR-001 (criação → fila), FR-002 (atualização → sem mudança de estado, exceção FR-010), FR-010 (teto adia sem cancelar), FR-011 (manual fura fila), FR-012 (habilitação nega-por-padrão) cobrem as quatro dimensões de forma explícita e cruzada.
- [x] CHK002 - Cada FR de mitigação nascida do gate de segurança (FR-010–FR-013, `block-003`/dec-022) tem um Success Criterion mensurável correspondente? [Completude, Spec §SC-005, SC-006, SC-007] {auto}
  Evidência: SC-005 mede FR-010 (teto nunca excedido), SC-006 mede FR-011 (ordem de prioridade do manual), SC-007 mede FR-012 (empresa sem habilitação não enfileira). FR-013 (ativação "explícita, reversível e auditável") não tem SC próprio — ver CHK015 (marcado {humano}).
- [ ] CHK003 - Existe requisito definindo o comportamento quando o **teto** de uma empresa é **reduzido** enquanto há mais pedidos automáticos pendentes do que o novo valor (ex.: teto cai de 100 para 50 com 80 pendentes)? [Completude, Gap] {humano}
  Nenhuma FR ou SC trata explicitamente de redução de teto com excedente já enfileirado; o design em data-model.md (`pendentes < cfg.teto`) apenas impede novos INSERTs até drenar, sem mencionar essa decisão como requisito. Decisão de produto: comportamento implícito é aceitável, ou precisa virar requisito explícito?
- [x] CHK004 - O requisito de desabilitação (`ativo=false`) e seu efeito sobre pedidos automáticos **já enfileirados** antes do desligamento estão implicitamente resolvidos pela mesma regra de FR-002 (fila não é alterada retroativamente por mudança de estado do entregador)? [Completude, Spec §FR-002, FR-012] {auto}
  Evidência: FR-012 governa apenas o **enfileiramento de novos** entregadores ("O enfileiramento automático MUST ocorrer somente para empresa explicitamente habilitada"); nada na spec autoriza remover pedidos já pendentes ao desabilitar, e FR-002 estabelece o princípio geral de que o estado de fila não é alterado por eventos que não sejam a criação original. Consistente por extensão do princípio já existente — não é um Gap.

## Clareza de Requisitos

- [x] CHK005 - O valor inicial do teto (FR-010) está marcado como configurável por empresa e não como constante embutida, com justificativa numérica explícita? [Clareza, Spec §FR-010] {auto}
  Evidência: "cujo valor é configurável por empresa e MUST NOT ser uma constante embutida no código... Valor inicial escolhido e justificado pelo operador: 100 — o volume normal é ~6 entregadores novos/dia... 100 pedidos drenam em ~100 min".
- [x] CHK006 - O termo "identificador externo" (FR-001, FR-003) é usado de forma consistente e não-ambígua ao longo da spec, sem exigir conhecimento externo ao documento para interpretá-lo? [Clareza, Spec §FR-001, FR-003] {auto}
  Evidência: usado uniformemente em FR-001 ("identificador externo dentro de uma empresa"), FR-003 e Key Entities ("Entregador: pessoa entregadora identificada por um identificador externo dentro de uma empresa") — três ocorrências consistentes entre si, sem definição contraditória.
- [x] CHK007 - O termo "nega-por-padrão" (FR-012) está quantificado com o comportamento concreto esperado, em vez de ficar como jargão sem explicação? [Clareza, Spec §FR-012] {auto}
  Evidência: "empresa sem registro de habilitação nunca enfileira automaticamente" — a frase seguinte explicita o comportamento, não deixa o termo solto.
- [ ] CHK008 - O termo "auditável" em FR-013 está quantificado com um mecanismo concreto (ex.: linha de log, endpoint de consulta, campo de autoria) ou permanece um adjetivo sem critério de verificação objetivo dentro da própria spec? [Clareza, Spec §FR-013] {auto}
  [Gap] A spec exige "Ligar o enfileiramento automático... MUST ser um ato explícito, reversível e auditável" mas não define o que conta como "auditável" (quem alterou, quando, por quê). O plano técnico resolve isso fora da spec (data-model.md: "o rastro é a própria linha `ativo`+`desde`+`atualizado_em` mais o registro no runbook" — sem linha em `"Auditoria"`) — ver CHK015 para a tensão entre essa leitura restrita de "auditável" e a redação MUST da spec.

## Consistência de Requisitos

- [x] CHK009 - FR-002 (fila não muda por atualização) e a exceção introduzida por FR-010 (excedente do teto permanece elegível) são compatíveis sem contradição? [Consistência, Spec §FR-002] {auto}
  Evidência: FR-002 declara a exceção dentro do próprio enunciado ("Única exceção (introduzida por FR-010)...") e delimita seu alcance ("Nenhum entregador existente antes da habilitação é alcançado por esta exceção") — a regra geral e a exceção coexistem sem sobreposição ambígua.
- [x] CHK010 - O invariante "sucesso e `dados_entrego_enriquecidos_em` no mesmo PATCH" está declarado como decisão deliberada e não como redundância a ser eliminada por fases futuras (`/plan`)? [Consistência, Spec §linhas 246-253] {auto}
  Evidência: bloco de nota explícito — "Este design é deliberado: o `/plan` MUST NOT tentar 'simplificar' removendo um dos dois campos sob alegação de redundância — a redundância é a garantia de consistência, não um descuido." Plan.md respeitou o invariante (não há remoção do campo redundante nos artefatos gerados).
- [x] CHK011 - FR-007 (nova tentativa substitui desfecho anterior) e FR-008 (falha nunca descarta sucesso anterior) definem sem ambiguidade qual prevalece quando uma tentativa após sucesso falha? [Consistência, Spec §FR-007, FR-008] {auto}
  Evidência: FR-008 é explícito e resolve o único caso que poderia colidir com FR-007 — "falhar por qualquer motivo... MUST NUNCA descartar dados de um enriquecimento bem-sucedido anterior... apenas uma nova tentativa bem-sucedida substitui dados já enriquecidos" — FR-007 rege apenas o campo de desfecho (classificação), FR-008 rege os dados enriquecidos; não há sobreposição de autoridade entre os dois.

## Qualidade de Critérios de Aceite

- [x] CHK012 - SC-001 a SC-007 são todos objetivamente mensuráveis (contáveis/verificáveis por consulta), sem adjetivo sem critério? [Mensurabilidade, Spec §SC-001..SC-007] {auto}
  Evidência: todos os 7 SCs descrevem um método de verificação concreto (contagem, comparação de estado antes/depois, ordem de consumo da fila) — nenhum usa termos como "rápido", "robusto" ou "adequado" sem quantificação.
- [x] CHK013 - SC-003 usa um baseline numérico real de produção (não uma meta arbitrária) para justificar o "tende a zero"? [Mensurabilidade, Spec §SC-003] {auto}
  Evidência: "hoje esse número cresce continuamente sem intervenção manual (67 → 75 em 1 hora medido em produção)" — número citado como medição real, não estimativa.
- [ ] CHK014 - SC-004 ("nunca é reprocessada como se fosse 'nunca tentado' ... sozinho") é verificável sem exigir uma janela de observação indefinida, já que a métrica depende de "ao longo do tempo"? [Mensurabilidade, Ambiguity, Spec §SC-004] {humano}
  A formulação "medido... ao longo do tempo sem intervenção manual" não define um período de observação mínimo nem um mecanismo de amostragem — na prática é verificável por invariante estrutural (contagem de tentativas por entregador nunca regride a "nunca tentado"), mas a SC como escrita não fixa um teste de aceite com duração finita. Decisão do dono do produto: aceitar como invariante estrutural (verificação por inspeção do desfecho, não por janela temporal) ou reescrever com um teste de duração fixa?

## Cobertura de Cenários

- [x] CHK015 - Existe um Acceptance Scenario ou Edge Case dedicado a cada uma das quatro mitigações do operador (FR-010–FR-013), e não apenas menção em Requirements/Success Criteria? [Cobertura, Gap parcial, Spec §User Scenarios, §Requirements] {auto}
  [Gap] As duas User Stories (US1, US2) cobrem apenas FR-001–FR-009; FR-010 (teto), FR-011 (prioridade do manual) e FR-012 (habilitação) têm cobertura em Success Criteria (SC-005, SC-006, SC-007) mas nenhum Acceptance Scenario/Edge Case dedicado nas User Stories. FR-013 (ativação auditável) não tem SC nem Acceptance Scenario — apenas o enunciado da própria FR e a nota do gate de segurança. Isso também é a causa raiz de `requirement-coverage.sh` não reconhecer FR-010–FR-013 como entradas distintas (ver CHK016).
- [ ] CHK016 - O formato de FR-010 a FR-013 (`- **FR-0NN** (mitigação ..., decisão do operador em \`block-003\`): texto`) é compatível com o parsing determinístico usado pelo gate `requirement-coverage.sh`, que espera `- **FR-0NN**: texto` sem cláusula intermediária? [Consistência de formato, Gap, Spec §FR-010..FR-013] {auto}
  [Gap] Rodando `requirement-coverage.sh spec.md`: `RESULT|...|requirements=9|covered=9|errors=0` — o gate só reconheceu FR-001 a FR-009 como requisitos distintos; FR-010–FR-013 foram silenciosamente absorvidos como continuação de texto de FR-009 porque a cláusula `(mitigação H2, decisão do operador em \`block-003\`)` antes dos dois-pontos quebra o regex `^- \*\*FR-[0-9]+\*\*:` do script. O gate passou (exit 0) mas não avaliou 4 dos 13 FRs. Não bloqueia o checklist (script não emitiu FINDING), mas é um Gap real de cobertura da ferramenta — recomendação: `/create-tasks` deve gerar um item para normalizar o formato de FR-010–FR-013 para `**FR-0NN**:` seguido da cláusula de mitigação no corpo do texto, restaurando parsing determinístico.
- [x] CHK017 - Os Edge Cases documentados cobrem os pontos de decisão realmente ambíguos identificados nas User Stories (duplicata no lote, atualização sem tentativa prévia, reversão de "pessoa não encontrada", sucesso após falha)? [Cobertura, Spec §Edge Cases] {auto}
  Evidência: os 4 Edge Cases listados mapeiam 1:1 para os pontos versados nos Acceptance Scenarios de US1.3, US1.2, US2.4 e a nota de FR-008 — sem edge case órfão ou Acceptance Scenario sem edge case de reforço.

## Requisitos Não-Funcionais

- [x] CHK018 - O requisito de resolução de tenant/escopo (FR-009) é redigido de forma que exclui explicitamente a alternativa insegura (escopo vindo do corpo da requisição), em vez de apenas afirmar a alternativa positiva? [Não-Funcional/Segurança, Spec §FR-009] {auto}
  Evidência: "MUST ter seu escopo de empresa/tenant resolvido a partir do contexto autenticado da sessão que a executa, nunca de um valor informado livremente na requisição" — a negativa explícita fecha a ambiguidade que uma frase só-positiva deixaria aberta.
- [x] CHK019 - A spec declara explicitamente o que fica FORA de escopo em dimensões não-funcionais tipicamente esperadas (scheduling, rotação de chave, mutex multi-pod, backup, política de retry nova), evitando que "não mencionado" seja lido como "esquecido"? [Não-Funcional, Spec §linhas 235-244] {auto}
  Evidência: bloco de nota dedicado — "Decisões de infraestrutura: N/A para scheduling/rotação de chave/mutex multi-pod/backup... Não introduz política de retry nova... Escopo desta feature é somente backend... nenhuma FR/SC de UI".
- [ ] CHK020 - Existe um requisito ou nota de escopo definindo o prazo de retenção/expurgo de PII (CPF/RG/CNH) coletada pelo enriquecimento, dado que FR-013 condiciona o cutover de produção a essa definição? [Não-Funcional/Privacidade, Gap, Spec §FR-013] {humano}
  FR-013 apenas condiciona a ativação em produção à "definição prévia do prazo de retenção/expurgo", mas a própria spec desta feature não define esse prazo — está deliberadamente fora do escopo desta entrega (mesma pendência já registrada em memória do projeto: "produção 2026-09-04" / plano hub-motorista-360, "Retenção segue SEM prazo definido"). Decisão do dono do produto: abrir feature/spec separada para o prazo de retenção antes de autorizar cutover, ou tratar como pré-condição de release sem spec própria?

## Dependências e Premissas

- [x] CHK021 - A spec declara a premissa de que o canal de consumo (processamento sob-demanda) e a autenticação já existem, evitando reintroduzir esses componentes como se fossem novos? [Dependências, Spec §FR-004, linhas 235-238] {auto}
  Evidência: FR-004 ("nenhum canal de consumo novo é necessário") e a nota de decisões de infraestrutura ("esta feature reutiliza o processamento sob-demanda e a autenticação já existentes... nenhum scheduler novo").
- [x] CHK022 - A premissa de que "empresa sem registro de habilitação" é o estado inicial de TODAS as empresas existentes (não apenas das novas) está clara o suficiente para SC-007 ser testável em uma empresa pré-existente sem setup adicional? [Dependências, Spec §SC-007, FR-012] {auto}
  Evidência: SC-007 fala em "empresa sem registro de habilitação" genericamente (não distingue empresa nova de existente), e FR-012 estabelece nega-por-padrão como regra geral sem exceção para empresas pré-existentes — a ausência de linha na tabela nova é o único critério, consistente para qualquer empresa.

## Ambiguidades e Conflitos

- [ ] CHK023 - A tensão entre FR-013 exigir ativação "auditável" e o design (fora desta spec, em data-model.md) resolver isso como "o rastro é a própria linha da tabela, sem linha em `Auditoria`" está reconciliada na spec, ou é uma leitura de "auditável" mais fraca do que a redação MUST sugere? [Ambiguity, Spec §FR-013] {humano}
  Ver CHK008. A spec não define o padrão mínimo de "auditável" (ex.: se um `UPDATE` direto no banco por um operador com acesso privilegiado, sem endpoint e sem linha formal de auditoria, satisfaz o requisito). Decisão do dono do produto: o padrão atual (linha da tabela + registro no runbook) é aceito como "auditável" o suficiente para FR-013, ou o requisito exige revisão de redação para não prometer mais do que o design entrega?

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com evidência citada, ou `[Gap]`/`[Ambiguity]` quando a checagem automática revela lacuna real).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto — nenhum foi auto-marcado.
- Gate determinístico `requirement-coverage.sh` rodado sobre `spec.md`: `RESULT|.../spec.md|requirements=9|covered=9|errors=0` (exit 0) — ver CHK016 para a limitação de parsing que faz o gate não avaliar FR-010–FR-013.
