# UX Checklist: migrar-cnpj-motorista

**Purpose**: Validar a qualidade dos requisitos de experiência do usuário — máscara de CNPJ, feedback de validação, aviso contextual e tratamento de erro no formulário de edição.
**Created**: 2026-06-21
**Feature**: [spec.md](../spec.md) · [US4 Validação de CNPJ](../spec.md)
**Domínios**: ux (primário)

---

## 1. Máscara e Validação no Campo CNPJ

- [x] CHK032 - É o requisito de máscara de formatação (FR-008) especificado com critério de aceite mensurável — qual o formato esperado visualmente? [Clareza, Spec §FR-008, §US4] {auto}
  > *Evidência*: FR-008 — "exibir máscara de formatação e validar que o valor contém exatamente 14 dígitos numéricos antes de habilitar o envio"; US4-AC1 — "uma dica visual indica o formato esperado". O critério de habilitação do botão é mensurável. O formato visual da máscara (ex.: `XX.XXX.XXX/XXXX-XX`) não está explicitado — mas o plan.md §Frontend cita reutilização do padrão existente em `edit-dialog.tsx`, o que implica consistência. Aceitável; sem gap crítico.

- [x] CHK033 - É o critério de desabilitação do botão "Salvar" (< 14 dígitos) especificado de forma não-ambígua e verificável por teste independente? [Mensurabilidade, Spec §US4-AC1, §US4-AC2, §Independent Test] {auto}
  > *Evidência*: US4 §Independent Test — "digitar um CNPJ incompleto (menos de 14 dígitos) → botão 'Salvar' permanece desabilitado. Completar os 14 dígitos → botão habilita." AC1 e AC2 reforçam. Critério binário e verificável.

- [x] CHK034 - O requisito de normalização no front (FR-008 + FR-009 + US4-AC3) é consistente com o requisito de normalização no back (FR-009) — o sistema não valida CNPJ com pontuação como "inválido"? [Consistência, Spec §FR-008, §FR-009, §US4-AC3] {auto}
  > *Evidência*: US4-AC3 — "admin digita o CNPJ com pontuação (ex: `11.111.111/0001-00`), quando o sistema processa o valor, apenas os 14 dígitos são enviados ao servidor (pontuação é descartada)". FR-009 reforça normalização antes de qualquer comparação. Front e back alinham: a máscara aceita pontuação para usabilidade, mas envia apenas dígitos. Sem conflito.

- [ ] CHK035 - É a dica visual de formato esperado (US4-AC1) especificada com conteúdo concreto — texto, placeholder, ou ícone — de forma que o implementador não precise inventar? [Clareza, Gap] {humano}
  > *Gap*: US4-AC1 menciona "dica visual indica o formato esperado" mas não especifica se é: (a) placeholder `XX.XXX.XXX/XXXX-XX`, (b) label abaixo do campo, (c) tooltip, ou (d) contador de dígitos. O implementador pode interpretar de formas divergentes. **Decisão do operador: aceitar implementação livre ou especificar o padrão visual?**

---

## 2. Aviso Contextual sobre Impacto no App Motorista

- [x] CHK036 - É o requisito de aviso (FR-014) especificado como texto fixo — sem dependência de lógica de grupo no front — e com justificativa para essa escolha? [Clareza, Spec §FR-014] {auto}
  > *Evidência*: FR-014 — "PODE ser exibido como texto fixo no diálogo de edição ao alterar o CNPJ, para todos os usuários — não é necessário o front detectar pertencimento ao grupo Movee (inofensivo para empresas externas, cujo motorista não é tocado; evita expor dados de grupo ao cliente)". Escolha de design justificada na spec.

- [x] CHK037 - É o texto do aviso especificado literalmente na spec — sem deixar ao implementador inventar o conteúdo? [Completude, Spec §FR-014] {auto}
  > *Evidência*: FR-014 cita: "Isto também atualizará o login do motorista no app". Texto literal definido; sem ambiguidade de conteúdo.

- [ ] CHK038 - É a condição de exibição do aviso especificada — ele aparece sempre (campo CNPJ presente no form) ou apenas quando o campo é alterado (valor difere do original)? [Clareza, Ambiguity] {humano}
  > *Ambiguity*: FR-014 diz "ao alterar o CNPJ", mas não define o gatilho preciso de UX: (a) aviso fixo visível assim que o diálogo abre, (b) aviso aparece quando o campo é focado/editado, ou (c) aviso aparece somente quando o valor digitado difere do CNPJ original. As três opções são tecnicamente "ao alterar". **Decisão do operador ou aceitável como livre implementação (impacto baixo)?**

---

## 3. Feedback de Erro ao Usuário (Respostas 409 e 500)

- [x] CHK039 - É a mensagem de erro do 409 especificada com texto legível pelo usuário — não apenas o código HTTP — para que o admin entenda o que fazer? [Clareza, contrato §Respostas, Spec §FR-006] {auto}
  > *Evidência*: contrato §Respostas — 409 body: `{ error: "CNPJ já possui motorista cadastrado — altere manualmente se necessário" }`. FR-006 — "mensagem legível pelo usuário". Texto definido e orientado à ação.

- [x] CHK040 - É a mensagem de erro do 500 (falha parcial) especificada com texto que indica a necessidade de verificação manual — sem expor detalhes técnicos ao usuário? [Clareza, contrato §Respostas, Spec §FR-011] {auto}
  > *Evidência*: contrato §Respostas — 500 body: `{ error: "Inconsistência ao migrar cadastro do motorista. Verifique manualmente." }`. FR-011 confirma "mensagem clara" sem expor segredos. Texto neutro e acionável.

- [ ] CHK041 - São os requisitos de exibição dessas mensagens de erro no front (toast, modal, inline) especificados de forma consistente com os demais erros do diálogo de edição? [Consistência, Gap] {humano}
  > *Gap*: a spec e o contrato definem as mensagens de erro (textos), mas não especificam o mecanismo de exibição no front (toast/snackbar como nos outros erros do painel, ou mensagem inline no diálogo). O padrão do painel usa toast para erros de API — mas não há FR explícito. **Decisão do operador: seguir padrão existente (toast) ou especificar explicitamente?**

---

## 4. Acessibilidade e Estados do Formulário

- [x] CHK042 - É o estado de desabilitação do botão "Salvar" especificado de forma acessível — o campo CNPJ inválido deve ter `aria-invalid` ou similar para leitores de tela? [Cobertura de Requisitos Não-Funcionais, Gap] {auto}
  > [Gap] — Nenhum FR especifica atributos de acessibilidade (`aria-invalid`, `aria-describedby`) para o campo CNPJ ou para o estado desabilitado do botão. Para um painel que passou por ciclo de UI/UX (PRs #39–#41), a omissão é explícita. **Nível de risco**: baixo para MVP (campo numérico com máscara é autoexplicativo visualmente), mas deveria ser coberto como requisito não-funcional se o produto tiver compromissos de a11y.

- [ ] CHK043 - É o comportamento do campo CNPJ durante carregamento/submissão especificado — o campo deve ficar desabilitado enquanto o PATCH está em andamento? [Cobertura de Edge Cases, Gap] {humano}
  > *Gap*: spec e plan descrevem o estado "antes do envio" (validação, máscara) e "depois do envio" (resposta 200/400/409/500), mas não o estado "durante o envio" (loading). Sem especificação, o implementador pode deixar o botão habilitado durante o request, permitindo duplo clique. **Decisão do operador: especificar loading state ou aceitar como livre implementação?**

---

## Notes

- Items `{auto}` resolvidos com `[x]` incluem citação da evidência nos artefatos.
- Items `{humano}` aguardam decisão do operador antes de `execute-task`.
- CHK042 tem marcador `[Gap]` de acessibilidade — baixo risco para MVP mas recomendado documentar.
- CHK035 e CHK038 são os gaps de especificação de detalhe de UX mais relevantes; resolução livre pelo implementador (seguindo padrão do painel) é aceitável se o operador confirmar.
