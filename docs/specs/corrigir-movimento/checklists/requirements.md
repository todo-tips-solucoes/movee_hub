# Requirements Checklist: Corrigir o valor de um movimento antes do envio da nota

**Purpose**: Validar a qualidade dos requisitos (spec.md) antes de create-tasks; cobre dados, seguranca e desempenho.
**Created**: 2026-10-20
**Feature**: [spec.md](../spec.md)

## Completude

- [x] CHK001 - Todo FR de reimportacao (FR-001..FR-010) tem cenario associado? [Completude, Spec §FR-001..010] {auto} -- `requirement-coverage.sh spec.md`: requirements=25 covered=25 errors=0.
- [x] CHK002 - Esta definido o que acontece com linha sem `uuid` ou com `uuid` inexistente? [Completude, Spec §FR-007, Clarifications Q2] {auto} -- fallback por empresa+CNPJ+dt_inicial+dt_final; cria so se nao ha movimento do CNPJ no periodo.
- [x] CHK003 - Esta definido o tratamento de linha ambigua (casa com >1 movimento)? [Completude, Spec §FR-006, Q4] {auto} -- nao atualiza nenhum, lista, aplica o resto do lote.
- [x] CHK004 - Esta definido o tratamento de movimento fechado? [Completude, Spec §Suposicoes, Q3] {auto} -- nao alteravel, pulado e contado.
- [x] CHK005 - Esta definido o comportamento em falha no meio da reimportacao? [Cobertura, Spec §Edge Cases] {auto} -- resumo preciso, nunca sucesso total.
- [x] CHK006 - Estao definidos os campos do registro de auditoria e sua imutabilidade? [Completude, Spec §FR-021, FR-024] {auto}
- [x] CHK007 - Esta definido quem e o autor quando a sessao e do hub e quando e da conta da empresa? [Completude, Spec §FR-022] {auto}

## Clareza e mensurabilidade

- [x] CHK008 - "Nota enviada" esta definido de forma verificavel? [Clareza, Spec §FR-015] {auto} -- nota anexada preenchida e erro de validacao ausente.
- [x] CHK009 - O requisito de desempenho e quantificado? [Mensurabilidade, Spec §SC-005, FR-010] {auto} -- 980 linhas em ate 10 s, sem consulta individual por linha.
- [x] CHK010 - A idempotencia e mensuravel? [Mensurabilidade, Spec §SC-008] {auto} -- 0 alteracoes e 0 novos registros na 2a execucao.
- [x] CHK011 - O isolamento entre empresas e mensuravel? [Mensurabilidade, Spec §SC-006, FR-019] {auto}
- [x] CHK012 - A atomicidade verificacao+gravacao esta especificada? [Clareza, Spec §FR-017] {auto} -- indivisivel por movimento.

## Consistencia

- [x] CHK013 - FR-006 (aplicar o resto e listar ambiguas) e coerente com o tudo-ou-nada atual, e a mudanca esta declarada? [Consistencia, Spec §Q4] {auto} -- mudanca deliberada, autorizada pelo operador.
- [x] CHK014 - FR-005 (linha invalida continua impedindo) nao conflita com FR-006? [Consistencia, Spec §FR-005, FR-006] {auto} -- invalida e validacao de formato; ambigua e de casamento, classes distintas.
- [x] CHK015 - FR-025 (nao tocar repasse) nao conflita com a correcao de valor? [Consistencia, Spec §FR-025] {auto}

## Seguranca

- [x] CHK016 - A permissao exigida pela correcao esta definida sem criar permissao nova? [Completude, Spec §FR-020, Suposicoes] {auto}
- [x] CHK017 - O requisito trata movimento de outra empresa como inexistente (sem vazar existencia)? [Seguranca, Spec §Edge Cases, FR-019] {auto}
- [x] CHK018 - O motivo e preservado sem mascaramento e sem tratamento como instrucao? [Seguranca, Spec §Edge Cases] {auto}
- [ ] CHK019 - Como a EnvioMassa NAO tem RLS (so GRANT por tabela), FR-019 exige filtro explicito de id_empresa em TODA leitura e escrita, inclusive no fallback? [Premissa, Spec §FR-019] {auto} [Gap] -- spec nao diz que o banco nao escopa; a protecao unica e o filtro da query. Acao: explicitar a premissa em FR-019 (via /clarify) e tarefa de teste de isolamento por query.

## Dependencias e premissas

- [x] CHK020 - A estabilidade do `uuid` esta marcada como NAO provada e nao e assumida? [Premissa, Spec §Q1, Suposicoes] {auto}
- [ ] CHK021 - A premissa "periodo do fallback vem do range informado no import" cobre planilha importada sem range? [Ambiguity, Spec §Suposicoes] {auto} [Ambiguity] -- spec nao diz o que ocorre sem range; levar ao /clarify.
- [ ] CHK022 - O custo da consulta de casamento (indice existente basta?) foi medido com EXPLAIN (ANALYZE)? [Premissa, Spec §SC-005] {humano} -- PENDENCIA DO OPERADOR: a tabela vive so em `chatmasterveloz` (producao); nenhum ambiente do agente a tem. Exigir a medicao ANTES do deploy; se reprovar, indice alternativo (id_empresa, dt_inicial, dt_final).

## Valor de negocio / risco

- [ ] CHK023 - O limite de 10 s (SC-005) e o corte "so movimento aberto" refletem o apetite do produto? [Risco, Spec §SC-005] {humano}
- [ ] CHK024 - Avisar o operador (FR-018) sobre mensagem ja enviada com valor antigo basta, ou o produto exige reenvio automatico? [Risco, Spec §FR-018] {humano}

## Notes

- Itens `{auto}` resolvidos contra spec.md; `{humano}` ficam `[ ]`.
- Gaps: CHK019 e CHK021 -> /clarify; CHK022 -> pendencia do operador antes do deploy.
- Dividas herdadas: dec-015 (registro de `clarify` da onda-003 nao corresponde a invocacao real; gate de doc foi `validate-sdd.sh`, nao `validate-documentation`); backups wave-002/003 ausentes (lacuna do runtime); sug-001/sug-002 informativas abertas.

## Adendo (onda-006)

- [ ] CHK025 - Os requisitos de ajuste da mensagem (FR-014) cobrem movimentos cuja `mensagem1` foi gerada pelo hub a partir de molde (sem a frase fixa da planilha)? [Gap, Spec §FR-014, research.md nota de auditoria] {auto} [Gap] -> tarefa de especificar/testar o caso "mensagem nao reconhecivel" para movimento gerado pelo hub.
- [ ] CHK026 - Medicoes das planilhas (.xlsx) e inventario de indices de producao tem procedencia reproduzivel? [Assumption] {humano} -- operador confirma; EXPLAIN (CHK022) segue pendente.
