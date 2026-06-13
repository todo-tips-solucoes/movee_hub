# UX Checklist: Gorjeta do Motorista

**Purpose**: Validar qualidade dos requisitos de interface — exibição condicional, formatação, hierarquia visual e acessibilidade na tela de movimento do motorista.
**Created**: 2026-06-12
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)

## Completude de Requisitos — Exibição

- [x] CHK201 - O requisito de formatação monetária (BRL) está especificado para exibição da gorjeta? [Completude, Spec §FR-005, Plan §4.4] {auto}
  > Evidência: FR-005 "exibir o valor formatado em BRL"; Plan §4.4 especifica `formatCurrency(gorjetaNum, 'BRL')` como função de formatação. Requisito presente.

- [x] CHK202 - O requisito de ocultação da linha (null/zero) está especificado com a condição exata de disparo? [Completude, Spec §FR-006, CL-003, Plan §4.4] {auto}
  > Evidência: FR-006 "null ou zero → ocultar"; CL-003 "só renderiza se `gorjetaNum` finito e `> 0`". Condição exata definida: `gorjetaNum > 0` (cobre null, zero e NaN).

- [x] CHK203 - O requisito cobre o estado "sem movimento aberto" para garantir que a gorjeta não cause regressão nesse caso? [Completude, Spec §US1 Acceptance Scenario 3, Plan §6.4] {auto}
  > Evidência: Spec US1 Acceptance Scenario 3 "sem movimento em aberto: tela exibe estado vazio sem regressão"; Plan §6.4 inclui cenário "Sem movimento → estado vazio preservado, sem regressão".

- [ ] CHK204 - O requisito define o label/rótulo exibido ao lado do valor da gorjeta (ex.: "Gorjeta", "Bônus", "Gratificação")? [Completude, Gap, Plan §4.4] {auto}
  > [Gap]: FR-005 define exibição "formatada em BRL" mas não especifica o texto do rótulo. Plan §4.4 usa como exemplo "Gorjeta R$ 22,00" (cenário de teste 6.4), mas não formaliza o rótulo como requisito. Se o cliente preferir outra terminologia, não há base para validar.

- [ ] CHK205 - O requisito define o posicionamento/hierarquia visual da linha de gorjeta em relação a outros campos da tela (valor do frete, número da nota)? [Completude, Gap] {humano}
  > Sem especificação de hierarquia visual na spec ou plan. A gorjeta é um campo adicional numa lista de informações do movimento — posição relativa (acima/abaixo do valor principal) não está definida. Decisão de UX do produto.

## Clareza de Requisitos — UX

- [x] CHK206 - "Exibir formatado em BRL" em FR-005 é suficientemente preciso para implementação consistente? [Clareza, Spec §FR-005, Plan §4.4] {auto}
  > Evidência: Plan §4.4 especifica `formatCurrency(gorjetaNum, 'BRL')` — a mesma função já usada para `valor` no frontend. Consistência com campo análogo garante clareza.

- [x] CHK207 - "Ocultar, não mostrar R$ 0,00" em FR-006 é claro sobre a diferença entre ocultar a linha vs. exibir traço "—"? [Clareza, Spec §FR-006, CL-003] {auto}
  > Evidência: CL-003 especifica "ocultar a linha completamente. Não exibir 'R$ 0,00' nem traço '—'". Sem ambiguidade entre as opções.

## Consistência de Requisitos — UX

- [x] CHK208 - O comportamento de ocultação (FR-006) é consistente com CL-003 para todos os estados: null, zero e NaN? [Consistência, Spec §FR-006, CL-003, Plan §4.4] {auto}
  > Evidência: CL-003 define condição `gorjetaNum finito e > 0`; cobre null (parseFloat → NaN → não finito), zero ("0.00" → 0 → não > 0), e NaN (texto inválido → não finito). Consistente para os três estados.

- [x] CHK209 - O tratamento de gorjeta zero ("0.00") é consistente entre Plan §6.4 e FR-006? [Consistência, Spec §FR-006, Plan §6.4] {auto}
  > Evidência: Plan §6.4 tabela inclui linha "Gorjeta zero → '0.00' → linha oculta" em conformidade com FR-006 "null ou zero → ocultar". Consistente.

## Qualidade dos Critérios de Aceitação — UX

- [x] CHK210 - SC-004 ("gorjeta nula/zero nunca aparece na tela") é objetivamente verificável? [Mensurabilidade, Spec §SC-004] {auto}
  > Evidência: SC-004 define "nenhum usuário vê 'R$ 0,00' onde não há gorjeta". Verificável por render de componente com `gorjeta: null` e `gorjeta: "0.00"` — ausência do elemento no DOM.

## Cobertura de Edge Cases — UX

- [x] CHK211 - O requisito cobre o caso de gorjeta presente + formatação de valor com centavos (ex.: R$ 22,50)? [Cobertura, Spec §US1 Acceptance Scenarios, Plan §6.4] {auto}
  > Evidência: Spec US1 Acceptance Scenarios usa "R$ 22,00" como exemplo; `formatCurrency` lida com centavos via função existente. O edge de centavos não é um caso especial — a formatação BRL é genérica.

- [ ] CHK212 - Existe requisito de acessibilidade para o campo gorjeta (ex.: aria-label, contraste mínimo, leitura por screen reader)? [Cobertura, Gap] {humano}
  > Sem requisito de acessibilidade específico para o campo na spec. A constitution não impõe A11y como NON-NEGOTIABLE para o app motorista. Decisão do produto se acessibilidade é requisito desta feature.

- [x] CHK213 - O requisito de regressão cobre que a ausência de gorjeta não afeta a exibição dos demais campos da tela de movimento? [Cobertura, Spec §US1 Acceptance Scenario 3, Plan §6.4] {auto}
  > Evidência: Plan §6.4 inclui cenário "Sem movimento → estado vazio preservado, sem regressão". Spec §7 Escopo define explicitamente que painel `frontend_v2` e outros campos NÃO mudam.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **CHK204** `[Gap]`: rótulo do campo não especificado — baixa criticidade, mas pode causar inconsistência de terminologia com o cliente.
- **CHK205** `{humano}`: posicionamento visual da gorjeta na tela — decisão de layout do produto.
- **CHK212** `{humano}`: acessibilidade (a11y) para o campo gorjeta — decisão do produto.
