# Data/Persistência Checklist: Gorjeta do Motorista

**Purpose**: Validar qualidade dos requisitos de persistência, DDL e integridade dos dados da gorjeta.
**Created**: 2026-06-12
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)

## Completude de Requisitos — DDL & Persistência

- [x] CHK001 - O tipo da coluna `gorjeta` no banco está especificado nos requisitos? [Completude, Spec §FR-001, Plan §3.1] {auto}
  > Evidência: Plan §3.1 "Entidade Movimento" define coluna `gorjeta text` espelhando `valor` (TEXT); CL-001 especifica `valorNum.toFixed(2)`.

- [x] CHK002 - O comportamento de idempotência do DDL está coberto por um requisito verificável? [Completude, Spec §FR-007, Plan §4.1] {auto}
  > Evidência: FR-007 "aplicar o DDL numa base que já possui a coluna não gera erro"; DDL usa `ADD COLUMN IF NOT EXISTS`; SC-005 define critério mensurável.

- [x] CHK003 - O requisito de reload de schema (PostgREST) está especificado com o mecanismo concreto? [Completude, Spec §FR-008, Plan §4.1] {auto}
  > Evidência: FR-008 exige reload após DDL; Plan §4.1 especifica `NOTIFY pgrst, 'reload schema'` como mecanismo; Plan §5 descreve fallback (`docker service update --force`).

- [x] CHK004 - Existe requisito cobrindo o que acontece se a coluna ainda não existir no momento do upload? [Completude, Spec §Edge Cases, Plan §5] {auto}
  > Evidência: Spec §Edge Cases define que o sistema "deve falhar apenas no campo gorjeta, nunca corromper os demais campos"; Plan §5 mitiga via ordem de deploy DDL→backend.

- [x] CHK005 - A semântica de `null` vs. zero está diferenciada nos requisitos? [Clareza, Spec §FR-002, CL-002, CL-003] {auto}
  > Evidência: FR-002 define `null` como "ausência de valor" (não zero explícito); CL-002 detalha `"R$ -"` → `null`; FR-006/CL-003 distinguem null/zero para ocultação na tela.

- [x] CHK006 - O requisito de persistência cobre todos os caminhos de entrada possíveis (preenchida / vazia / ausente)? [Cobertura, Spec §FR-001..FR-003, CL-001..CL-004] {auto}
  > Evidência: FR-001 (valor válido), FR-002 ("R$ -"/vazio), FR-003 (coluna ausente); CL-004 cobre `undefined` → `null`. Três caminhos cobertos.

## Clareza de Requisitos

- [x] CHK007 - "Valor monetário válido" em FR-001 está quantificado com critério verificável? [Clareza, Spec §FR-001, CL-001] {auto}
  > Evidência: CL-001 define formato exato: string `valorNum.toFixed(2)` (ex. `"22.00"`); implica que `Number.isFinite(toNumberBR(valor))` é `true`. Critério verificável.

- [x] CHK008 - "Equivalente a zero/vazio" em FR-002 está suficientemente definido para implementação sem ambiguidade? [Clareza, Spec §FR-002, CL-002, CL-004] {auto}
  > Evidência: CL-002 especifica `Number.isFinite(toNumberBR("R$ -"))` é `false`; CL-004 define `undefined` → `NaN` → `null`. Cobre "R$ -", ausência, texto não-monetário.

- [x] CHK009 - O requisito FR-002 ("sem gerar erro") está claro sobre qual tipo de erro (linha rejeitada vs. 500 vs. silencioso)? [Clareza, Spec §FR-002, §Edge Cases] {auto}
  > Evidência: Spec §Edge Cases define "gravar null, sem lançar erro 500"; Plan §6.1 tabela de cenários especifica "sem rowError" para todos os casos de gorjeta inválida.

## Consistência de Requisitos

- [x] CHK010 - FR-002 (gravar null para "R$ -") e FR-003 (coluna ausente não gera erro) são consistentes entre si sem conflito de comportamento? [Consistência, Spec §FR-002, §FR-003] {auto}
  > Evidência: FR-002 trata o valor no campo; FR-003 trata a ausência do campo. São caminhos ortogonais; CL-004 unifica via `undefined → null` (mesmo resultado).

- [x] CHK011 - CL-001 (tipo TEXT para gorjeta) é consistente com o tipo da coluna `valor` no banco existente? [Consistência, Plan §3.2, CL-001] {auto}
  > Evidência: Plan §3.2 "Confirmação do tipo de `valor`" confirma que `valor` é TEXT; CL-001 define explicitamente espelhar o tipo. Consistência verificável.

- [x] CHK012 - A ordem crítica DDL→reload→backend→frontend está alinhada com os requisitos FR-007 e FR-008? [Consistência, Spec §FR-007..FR-008, Plan §5] {auto}
  > Evidência: Plan §5 formaliza sequência inviolável com justificativa: "se backend novo subir antes da coluna existir, PostgREST rejeita o POST inteiro". FR-007+FR-008 fundamentam a ordem.

## Qualidade dos Critérios de Aceitação

- [x] CHK013 - SC-001 ("zero regressão no caminho de upload") é objetivamente mensurável? [Mensurabilidade, Spec §SC-001] {auto}
  > Evidência: SC-001 define "100% dos registros com gorjeta preenchida chegam ao banco com valor correto". Mensurável via teste unitário do parser e integração do upload.

- [x] CHK014 - SC-002 ("planilhas legadas continuam com sucesso") é objetivamente mensurável? [Mensurabilidade, Spec §SC-002] {auto}
  > Evidência: SC-002 define "100% dos uploads de planilhas legadas sem coluna gorjeta continuam com sucesso". Verificável por teste com fixture sem a coluna.

- [x] CHK015 - SC-005 ("DDL reaplicável sem erro") é objetivamente mensurável? [Mensurabilidade, Spec §SC-005] {auto}
  > Evidência: SC-005 define idempotência "verificável por script". `ADD COLUMN IF NOT EXISTS` retorna sucesso na segunda execução — critério binário verificável.

## Cobertura de Edge Cases de Dados

- [x] CHK016 - O requisito cobre o edge case de valor não-monetário (texto livre) na coluna gorjeta? [Cobertura, Spec §Edge Cases] {auto}
  > Evidência: Spec §Edge Cases define "sistema deve ignorar/tratar como vazio (gravar null), sem lançar erro 500". Plan §6.1 inclui cenário "Texto não-monetário → gorjeta: null".

- [x] CHK017 - O requisito cobre o caso de planilha com gorjeta presente em algumas linhas e ausente em outras (upload misto)? [Cobertura, Spec §US2 Acceptance Scenarios, Plan §6.1] {auto}
  > Evidência: Spec US2 Acceptance Scenario 4 define "planilha mista: linhas com e sem gorjeta processadas independentemente". Plan §6.1 inclui cenário "Mista → cada linha independente".

- [ ] CHK018 - Existe requisito explícito sobre o comportamento se `gorjeta` for um número negativo (ex.: `"R$ -5,00"`)? [Cobertura, Gap] {auto}
  > [Gap]: Spec e CL-002 definem "R$ -" (traço) → null, mas não tratam explicitamente valor monetário negativo (ex.: "-5.00"). `toNumberBR("R$ -5,00")` pode retornar `-5` (Number.isFinite = true), resultando em gorjeta gravada como `"-5.00"`. Impacto baixo (improvável em dados reais de gorjeta), mas o comportamento não está especificado.

- [x] CHK019 - O requisito de regressão de `valor` e demais campos está coberto? [Cobertura, Spec §FR-003, Plan §6.1] {auto}
  > Evidência: Plan §6.1 inclui cenário "Regressão valor: qualquer gorjeta → valor e demais campos idênticos ao comportamento atual". Spec §7 Escopo define explicitamente "demais colunas/validações do upload NÃO mudam".

## Dependências e Premissas

- [x] CHK020 - A dependência da ordem de deploy (DDL antes do backend) está documentada como premissa explícita? [Dependências, Plan §5] {auto}
  > Evidência: Plan §5 "Ordem Crítica de Runtime" documenta sequência com justificativa e consequência de quebrar a ordem. Premissa explicitamente documentada.

- [ ] CHK021 - Existe requisito ou premissa sobre o que acontece se o operador não executar o reload do PostgREST após o DDL? [Dependências, Assumption] {humano}
  > O rito de produção inclui verificação do reload (Plan §5 passo 3 + fallback), mas não há requisito formal definindo o comportamento do sistema em produção se o reload for omitido (coluna existiria no banco mas seria invisível via API). Decisão de nível operacional — fora do escopo técnico do agente.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **CHK018** `[Gap]`: valor negativo não especificado — baixo impacto, mas pode virar tarefa "definir comportamento para gorjeta < 0".
- **CHK021** `{humano}`: comportamento operacional sem reload — decisão do produto/operação.
