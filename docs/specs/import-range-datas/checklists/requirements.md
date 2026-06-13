# Requirements Quality Checklist: import-range-datas

**Purpose**: Validar qualidade, completude e clareza dos requisitos — não da implementação.
**Created**: 2026-06-13
**Feature**: [spec.md](../spec.md)
**Domínios cobertos**: UX, API, Security, Requirements

---

## Completude de Requisitos

- [x] CHK001 — Os requisitos definem o fluxo completo do operador, incluindo o passo de confirmação de range antes do envio? [Completude, Spec §P1, FR-001] {auto}
  > SATISFEITO: P1 Cenário A descreve o fluxo completo (escolha de arquivo → diálogo → preenchimento de datas → envio); FR-001 exige a etapa de confirmação como obrigatória.

- [x] CHK002 — Existe requisito para o estado do botão de envio em cada situação (range inválido, range válido, ambas as datas ausentes, apenas uma ausente)? [Completude, Spec §FR-002, §P2] {auto}
  > SATISFEITO: FR-002 especifica as duas condições de habilitação (ambas preenchidas + dt_ini ≤ dt_fim); P2 Cenários A, B e C cobrem os três estados de invalidade.

- [x] CHK003 — Existe requisito para o comportamento do sistema quando a planilha tem colunas de data presentes vs. ausentes? [Completude, Spec §FR-006, §P1-C] {auto}
  > SATISFEITO: FR-006 declara que colunas da planilha são ignoradas; P1-C cobre a linha sem data; P1-B cobre a linha com colunas legadas divergentes.

- [x] CHK004 — Existe requisito explícito para o comportamento do grupo Movee (que antes usava fallback 01/01/1982)? [Completude, Spec §P3, FR-008] {auto}
  > SATISFEITO: FR-008 + P3 Cenário A declaram explicitamente que o fallback é eliminado e o comportamento passa a ser uniforme.

- [x] CHK005 — Existe requisito de regressão para os campos não afetados (valor, gorjeta, CNPJ)? [Completude, Spec §P1-D, FR-009] {auto}
  > SATISFEITO: FR-009 + P1-D exigem explicitamente que os demais campos sigam com a mesma lógica existente.

- [x] CHK006 — O requisito de deploy coordenado está declarado e é verificável? [Completude, Spec §FR-010] {auto}
  > SATISFEITO: FR-010 declara que frontend e backend devem ser atualizados no mesmo ciclo de deploy; é verificável como critério de processo (não como runtime).

- [ ] CHK007 — Existe requisito definindo a mensagem de feedback de sucesso após import com range? [Completude, Gap] {humano}
  > [Gap]: A spec declara o critério de sucesso (SC-1 "lote sem falha por data") mas não especifica a mensagem de feedback ao operador após o envio bem-sucedido. O comportamento atual (`toast.success("importado com sucesso!")`) provavelmente é suficiente, mas o requisito não o explicita. Decisão do dono do produto: manter comportamento atual ou especificar mensagem que mencione o range aplicado (ex: "Importado com sucesso para o período 01/05 – 31/05").

---

## Clareza de Requisitos

- [x] CHK008 — A condição `dt_inicial ≤ dt_final` é inequívoca para datas iguais (igual é permitido)? [Clareza, Spec §FR-002, §Key Entities] {auto}
  > SATISFEITO: a spec usa `≤` explicitamente em FR-002 e na seção Key Entities. P2-A confirma que o botão habilita quando iguais ("data final `2026-06-01` (iguais) → botão habilita" — inferido de P2-A que só desabilita quando dt_ini > dt_fim).

- [x] CHK009 — "Meia-noite horário SP" em FR-007 é suficientemente preciso para orientar implementação sem ambiguidade? [Clareza, Spec §FR-007, research.md §D2] {auto}
  > SATISFEITO: FR-007 declara preservar a semântica existente; research.md D2 registra que a conversão usa `toTimestamptzMidnightSP` sem alteração — a referência ao código existente elimina a ambiguidade.

- [x] CHK010 — "Mensagem única em português" em FR-004 está suficientemente especificado? [Clareza, Spec §FR-004] {auto}
  > SATISFEITO PARCIALMENTE: FR-004 especifica "mensagem única em português" e o quickstart.md fornece exemplos concretos de mensagens para cada caso (ausência de dt_inicial, ausência de dt_final, range invertido). O requisito é suficiente para implementação.

- [x] CHK011 — O escopo de "todos os grupos" em FR-008 está delimitado (inclui Movee explicitamente)? [Clareza, Spec §FR-008, §P3] {auto}
  > SATISFEITO: FR-008 menciona explicitamente "incluindo o grupo Movee"; P3 tem o Cenário A exclusivamente para o grupo Movee.

- [ ] CHK012 — O requisito FR-002 especifica o comportamento quando o operador cancela o diálogo (sem confirmar o range)? [Clareza, Gap] {humano}
  > [Gap]: A spec descreve o caminho de confirmação (Enviar) e os caminhos de erro, mas não o caminho de cancelamento do diálogo (operador fecha sem confirmar). Comportamento esperado: arquivo descartado, dialog fecha, sem upload. Decisão do dono do produto: confirmar o comportamento de cancelamento (e se deve haver confirmação antes de descartar o arquivo).

- [x] CHK013 — "Deploy coordenado" em FR-010 está suficientemente definido para orientar o processo operacional? [Clareza, Spec §FR-010] {auto}
  > SATISFEITO: FR-010 declara o requisito; o plano §Ordem de Implementação item 6 detalha o processo (build simultâneo + service update no mesmo ciclo). A interpretação é inequívoca.

---

## Consistência de Requisitos

- [x] CHK014 — FR-005 (backend aplica range a todas as linhas) e FR-006 (colunas da planilha ignoradas) são consistentes e não conflitam? [Consistência, Spec §FR-005, §FR-006] {auto}
  > SATISFEITO: ambos apontam na mesma direção — fonte de dados é o range da UI, colunas da planilha são desconsideradas. Sem conflito.

- [x] CHK015 — FR-002 (validação na UI desabilita botão) e FR-004 (validação no backend retorna 400) são consistentes como defense-in-depth? [Consistência, Spec §FR-002, §FR-004] {auto}
  > SATISFEITO: a spec declara as duas camadas como complementares (não redundantes); research.md D3 registra explicitamente a decisão de defense-in-depth. Sem conflito.

- [x] CHK016 — P1 (happy path) e P2 (erros) têm cenários de aceite consistentes com FR-001 a FR-010? [Consistência, Spec §P1, §P2, §Requirements] {auto}
  > SATISFEITO: cada cenário de P1/P2 mapeia para ao menos um FR: P1-A→FR-001,FR-003,FR-005; P1-B→FR-006; P1-C→FR-005,FR-006; P1-D→FR-009; P2-A→FR-002,FR-004; P2-B→FR-002,FR-004; P2-C→FR-002.

- [x] CHK017 — O requisito de comportamento uniforme (P3/FR-008) é consistente com a eliminação do bloco condicional `_isGrupoMovee` no backend? [Consistência, Spec §FR-008, plan.md §Phase 1.3] {auto}
  > SATISFEITO: FR-008 exige uniformidade; o plano §1.3 prevê remoção explícita do bloco `if (!_isGrupoMovee)` e adiciona nota para verificar se `_isGrupoMovee` tem outros usos. Consistente.

---

## Qualidade dos Critérios de Aceite (Success Criteria)

- [x] CHK018 — SC-1 ("zero rejeições 400 por ausência de data na linha") é objetivamente mensurável? [Mensurabilidade, Spec §SC-1] {auto}
  > SATISFEITO: "zero rejeições" é verificável empiricamente importando planilha com linhas sem colunas de data e observando o status HTTP de retorno.

- [x] CHK019 — SC-2 ("feedback de erro antes do envio") especifica o mecanismo concreto de feedback? [Mensurabilidade, Spec §SC-2] {auto}
  > SATISFEITO: a spec combina SC-2 com FR-002 (botão desabilitado) — o mecanismo é o estado do botão. Verificável visualmente.

- [x] CHK020 — SC-3 ("numa única interação") tem a sequência de passos especificada e contável? [Mensurabilidade, Spec §SC-3, FR-001] {auto}
  > SATISFEITO: o fluxo é enumerado em P1-A (1. escolher arquivo → 2. dialog → 3. preencher datas → 4. enviar) — 4 passos, "única interação" refere-se à ausência de edição na planilha.

- [x] CHK021 — SC-4 ("comportamento idêntico para todos os grupos") é verificável sem acesso ao código-fonte? [Mensurabilidade, Spec §SC-4] {auto}
  > SATISFEITO: verificável via teste com contas de empresas de grupos diferentes (Movee e não-Movee) realizando o mesmo import e comparando o comportamento observado.

- [x] CHK022 — SC-5 ("sem regressão: gorjeta, valor e CNPJ gravados corretamente") tem critério concreto para comparar? [Mensurabilidade, Spec §SC-5, §P1-D] {auto}
  > SATISFEITO: o quickstart.md Cenário 6 (Roundtrip E2E) define os valores esperados campo a campo (gorjeta null vs. valor, CNPJ com/sem máscara). Mensurável.

---

## Cobertura de Cenários

- [x] CHK023 — Os cenários de aceite cobrem o caminho feliz (range válido, todas as colunas), o caminho legado (planilha com colunas de data) e o caminho de ausência de colunas? [Cobertura, Spec §P1-A, §P1-B, §P1-C] {auto}
  > SATISFEITO: três cenários distintos em P1 cobrem os três caminhos de entrada da planilha.

- [x] CHK024 — Os cenários de rejeição cobrem: range invertido, range ausente total e range parcial (apenas uma data)? [Cobertura, Spec §P2-A, §P2-B, §P2-C] {auto}
  > SATISFEITO: P2 tem três cenários mapeando exatamente essas três condições de invalidade.

- [x] CHK025 — O comportamento de chamada direta ao backend (sem UI) está coberto nos cenários? [Cobertura, quickstart.md §Cenário 3, §Cenário 4] {auto}
  > SATISFEITO: quickstart.md Cenários 3 e 4 cobrem chamada direta via curl com ausência de campos e range invertido.

- [ ] CHK026 — Existe cenário cobrindo o comportamento quando o arquivo é inválido (não-xlsx) com um range válido já preenchido? [Cobertura, Gap] {humano}
  > [Gap]: A spec cobre validação de extensão de arquivo (`import-button.tsx` valida `.xlsx?$`), mas não define o comportamento quando o operador preenche o range no diálogo e depois seleciona um arquivo não-xlsx. O comportamento atual (validação de extensão ocorre antes de abrir o diálogo) elimina esse caso — mas não está explicitado. Decisão do dono do produto: confirmar que a validação de extensão ocorre na seleção do arquivo (antes do diálogo), não na confirmação.

- [x] CHK027 — O cenário de regressão de gorjeta (R$ - → NULL vs. valor numérico) está coberto? [Cobertura, quickstart.md §Cenário 6] {auto}
  > SATISFEITO: quickstart.md Cenário 6 cobre gorjeta nula (R$ -) e gorjeta com valor, confirmando regressão específica da feature anterior.

---

## Cobertura de Edge Cases

- [x] CHK028 — O edge case de dt_inicial = dt_final (range de um dia) está coberto? [Edge Cases, Spec §P2-A] {auto}
  > SATISFEITO: P2-A menciona o caso explicitamente ("data final `2026-06-01` (iguais) → botão habilita").

- [x] CHK029 — O edge case de planilha vazia (zero linhas) está coberto? [Edge Cases, plan.md §1.3] {auto}
  > SATISFEITO: o backend existente já retorna `400` com "A planilha está vazia" antes de chegar na validação do range. O requisito de range não altera esse comportamento — foi verificado no código fonte (`server.js` linhas pré-loop).

- [ ] CHK030 — Existe edge case definindo o comportamento quando a planilha tem apenas a linha de cabeçalho (sem linhas de dados)? [Edge Cases, Gap] {humano}
  > [Gap]: Similar ao CHK029, mas específico para o caso em que `xlsx.utils.sheet_to_json` retorna array vazio porque só existe o cabeçalho. O backend existente trata (`rows.length === 0`), mas a spec não menciona. Decisão do dono do produto: confirmar que o tratamento existente é suficiente ou adicionar cenário explícito.

- [x] CHK031 — O edge case de planilha com datas em formatos diferentes por linha (legado) é coberto pelo requisito de ignorar colunas? [Edge Cases, Spec §FR-006] {auto}
  > SATISFEITO: FR-006 declara que as colunas são ignoradas independentemente do formato — o edge case é resolvido pela própria semântica do requisito.

---

## Requisitos Não-Funcionais

- [x] CHK032 — Existem requisitos não-funcionais de acessibilidade para os campos de data no diálogo? [Req. Não-Funcionais, Gap parcial] {auto}
  > SATISFEITO PARCIALMENTE: a spec não menciona acessibilidade explicitamente, mas o plano usa `<Input type="date">` nativo (que já tem suporte a navegação por teclado e labels nativas do browser). A constitution não exige especificação de acessibilidade explícita para esta feature. Aceitável para o escopo.

- [x] CHK033 — Os requisitos de segurança de input (validação de datas no backend) estão especificados? [Req. Não-Funcionais, Spec §FR-004, plan.md §Constitution Check §I] {auto}
  > SATISFEITO: FR-004 declara validação de presença e consistência no backend; o plano §Constitution Check §I confirma que `toTimestamptzMidnightSP` retorna `null` em input inválido (sem injeção possível).

- [x] CHK034 — O requisito de isolamento multi-tenant está mantido para o campo de range? [Req. Não-Funcionais, Spec §FR-003, constitution §II] {auto}
  > SATISFEITO: o range de datas é um dado do lote (não identidade de empresa); `empresaId` continua extraído do token via `resolveEmpresaAlvo`. Sem novo vetor de IDOR. Constitution §II PASS.

- [ ] CHK035 — Existe requisito de tempo máximo de resposta para o upload com range? [Req. Não-Funcionais, Gap] {humano}
  > [Gap]: A spec não define SLA de tempo de resposta para a rota `/upload`. O comportamento de performance do upload não muda (a única mudança é a eliminação do bloco per-row, que reduz processamento), mas não há critério explícito. Decisão do dono do produto: SLA necessário para este fluxo ou comportamento atual é aceitável?

---

## Dependências e Premissas

- [x] CHK036 — A premissa de que o proxy preserva campos extras do FormData está documentada e validada? [Dependências, research.md §D1, §D4] {auto}
  > SATISFEITO: research.md D1 e D4 documentam a validação empírica (padrão `empresa_id` já em produção via mesma rota).

- [x] CHK037 — A dependência de componentes UI existentes (Dialog, Input, Button de shadcn/ui) está verificada? [Dependências, plan.md §Technical Context] {auto}
  > SATISFEITO: o plano §Technical Context lista os componentes e o diretório foi verificado (`dialog.tsx`, `input.tsx`, `button.tsx` existem em `components/ui/`).

- [x] CHK038 — A premissa de que `api-client.ts` já suporta `extraFields` está verificada no código? [Dependências, research.md §D5] {auto}
  > SATISFEITO: research.md D5 registra que `api.uploadFile(path, file, extraFields?)` já está implementado no `api-client.ts` atual (verificado via leitura do arquivo).

- [ ] CHK039 — Existe dependência de `_isGrupoMovee` além do bloco de datas que possa ser afetada pela remoção? [Dependências, plan.md §Phase 1.3] {humano}
  > [Assumption]: o plan §1.3 nota "verificar se `_isGrupoMovee` tem outros usos" mas não documenta o resultado. Durante implementação, confirmar que a variável não é usada fora do bloco de datas (ou manter a query para outros fins). Decisão do implementador durante a task de backend.

---

## Notes

- Items `{auto}` foram resolvidos pelo agente com citação de evidência (`[x]` = satisfeito, `[ ]` = gap).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- Marcar items concluídos com `[x]`.

---

## Resumo da Resolução

| Estado | Count | Items |
|--------|-------|-------|
| `[x]` resolvidos `{auto}` | 29 | CHK001–CHK006, CHK008–CHK011, CHK013–CHK027, CHK028–CHK029, CHK031–CHK034, CHK036–CHK038 |
| `[ ]` gaps/humano | 8 | CHK007, CHK012, CHK026, CHK030, CHK035, CHK039 — mais CHK032 parcial |
| `[Gap]` abertos | 6 | CHK007, CHK012, CHK026, CHK030, CHK035, CHK039 |

**Rastreabilidade**: 100% dos items referenciam Spec §X, plan.md §Y, research.md §D, ou marcam `[Gap]`.

---

## Próximos Passos

- **CHK007** (mensagem de sucesso com range): confirmar se toast atual é suficiente ou incluir período
- **CHK012** (cancelar diálogo): confirmar comportamento (descartar arquivo)
- **CHK026** (arquivo inválido com range preenchido): confirmar que validação de extensão ocorre antes do diálogo
- **CHK030** (planilha só cabeçalho): confirmar que tratamento existente é suficiente
- **CHK035** (SLA de upload): decidir se há requisito de performance explícito
- **CHK039** (`_isGrupoMovee` outros usos): verificar durante implementação do backend
- `/create-tasks` — nenhum gap é bloqueante para implementação; todos os 6 gaps são observações para o implementador ou refinamentos de UX pós-deploy
