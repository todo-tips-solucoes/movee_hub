# UX Checklist: Grupo Unificado de Filiais

**Purpose**: Validar qualidade e completude dos requisitos de UX para a tela
de edição de filiais (módulo B) — formulário pré-preenchido, estados de
interação, feedback de erro e acessibilidade do campo de senha removido.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md)

---

## Formulário de Edição (Pré-preenchimento e Estados)

- [x] CHK033 — O requisito de pré-preenchimento do formulário especifica que
  **todos** os campos editáveis devem ser populados com dados atuais da filial
  ao abrir o modal/tela? [Completude, Spec §FR-011]
  > Evidência: FR-011 define "formulário de edição DEVE ser pré-preenchido com
  > os dados atuais da filial ao ser aberto". Success Criteria (módulo B):
  > "Formulário de edição exibe dados atuais corretos em 100% das aberturas
  > (sem campos em branco indevidos)". {auto}

- [ ] CHK034 — Os requisitos definem o que ocorre quando o carregamento dos
  dados da filial falha (API offline, timeout): o formulário exibe estado de
  erro ou fica em branco? [Edge Case, Spec §FR-011] {humano}
  > FR-011 especifica pré-preenchimento feliz mas não define fallback de falha
  > de carregamento. Decisão de UX necessária.

- [x] CHK035 — A acessibilidade do formulário considera a remoção do campo
  senha — especificamente que gerenciadores de senha não devem fazer autofill
  em campos de email/nome? [Completude, OWASP §LOW-003]
  > Evidência: OWASP LOW-003 define: "`autoComplete="off"`/`"username"` no form
  > de cadastro/edição de filial (campo senha removido → evitar autofill de
  > gerenciador)." Mapeado para task B (tela). {auto}

- [ ] CHK036 — Os requisitos definem estado de loading durante o submit do
  formulário (botão desabilitado, spinner) para prevenir duplo-submit? [Completude, Spec §FR-008]
  > FR-008 define que a operação de edição deve funcionar, mas não especifica
  > o estado visual do botão durante a chamada à API. [Gap] {humano}

---

## Navegação e Acessibilidade da Tela

- [x] CHK037 — O requisito de navegação define o ponto de entrada da tela de
  edição (a partir da lista de filiais existente) sem exigir nova rota de
  primeiro nível? [Completude, Spec §FR-012]
  > Evidência: FR-012 define: "acessível a partir da lista de filiais existente
  > (feature `cadastro-filiais`), sem introduzir nova rota de navegação de
  > primeiro nível." Requisito de navegação claro. {auto}

- [ ] CHK038 — Os requisitos definem qual elemento na lista de filiais dispara
  a abertura da tela de edição (botão "editar", ícone, linha clicável) e se
  abre em modal ou página separada? [Clareza, Spec §FR-012]
  > FR-012 não especifica o padrão de interação (modal vs. página, ícone vs.
  > botão). US2 Independent Test menciona "clicar em 'editar'" mas não
  > formaliza como requisito de UX. [Ambiguity] {humano}

- [ ] CHK039 — Os requisitos definem se a tela de edição é exibida apenas para
  `is_grupo_pai = true` (ocultada para filiais) ou se é exibida mas bloqueada
  com mensagem de permissão negada? [Clareza, Spec §FR-009, US2-AC6]
  > US2 Acceptance Scenario 6 define: "tela não é exibida e a ação é negada."
  > FR-009 define restrição server-side. A palavra "não exibida" sugere
  > ocultação no frontend, mas o requisito de UX (o que o usuário sem
  > permissão vê, se é botão sumido ou erro) não está explicitado. [Ambiguity] {humano}

---

## Feedback de Erro ao Usuário

- [x] CHK040 — As mensagens de erro para campos duplicados (email/CNPJ) estão
  definidas como strings específicas exibidas no formulário? [Clareza, Spec §FR-010, US2-AC3/AC4]
  > Evidência: US2 Acceptance Scenarios 3/4 definem strings exatas: "CNPJ já
  > cadastrado" e "E-mail já cadastrado". {auto}

- [ ] CHK041 — Os requisitos definem onde as mensagens de erro são exibidas no
  formulário — inline no campo, toast no topo, ou modal de erro? [Clareza, Spec §FR-010]
  > Nenhum FR nem acceptance scenario especifica o padrão de exibição. A
  > feature `cadastro-filiais` pode ter padrão a ser reaproveitado, mas não
  > está referenciado. [Ambiguity] {humano}

- [ ] CHK042 — Os requisitos definem mensagem de sucesso após salvar com êxito
  (confirmação visual ao admin)? [Completude, Spec §FR-008]
  > Success Criteria menciona "retorno de confirmação de sucesso" mas não
  > define o padrão de UX (toast, redirect para lista, banner). [Gap] {humano}

---

## Consistência com Feature `cadastro-filiais`

- [x] CHK043 — A spec referencia ou herda explicitamente padrões visuais da
  feature `cadastro-filiais` para o formulário de edição? [Consistência, Spec §FR-012]
  > Evidência: FR-012 estabelece dependência direta da lista de filiais da
  > feature `cadastro-filiais`. A herança de padrão visual é implícita pela
  > "mesma tela de gestão de filiais" (US2 título). A consistência é intenção
  > do design mas não está formalizada como requisito explícito de UX. {auto}

- [ ] CHK044 — Os campos do formulário de edição seguem os mesmos padrões de
  validação visual (estado inválido, cor de borda, ícone de erro) definidos
  na feature `cadastro-filiais`? [Consistência] {humano}
  > Nenhum requisito formal de consistência visual foi encontrado na spec
  > desta feature. Depende de inspeção do design system existente.

---

## Performance Perceptível

- [x] CHK045 — O critério de performance da edição ("menos de 30 segundos do
  clique em 'editar' até confirmação de sucesso") é verificável e inclui o
  tempo de carregamento do formulário pré-preenchido? [Mensurabilidade, Spec §SC-Módulo-B]
  > Evidência: Success Criteria módulo B define "menos de 30 segundos". O
  > critério cobre end-to-end (clique até confirmação), logo inclui o
  > carregamento do pré-preenchimento. Verificável em teste manual ou E2E. {auto}

---

## Notes

- Items `{auto}` resolvidos com evidência citada (`[x]`)
- Items `{humano}` aguardando decisão do dono do produto (`[ ]`)
- `[Ambiguity]` indica ponto a resolver via `/clarify` antes de `create-tasks`
- `[Gap]` indica requisito ausente — candidato a task em `create-tasks`
- IDs CHK033–CHK045 neste arquivo
