# UX/A11y Checklist: Movimento por Empresa/Filial

**Purpose**: Validar completude e clareza dos requisitos de UX e acessibilidade — focado no combobox pesquisável de filial (shadcn Command + Popover), estados de interação, navegação por teclado, atributos ARIA e responsividade mobile.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md) | [research.md](../research.md) | [plan.md](../plan.md)

---

## Combobox Pesquisável — Completude de Requisitos

- [x] CHK001 - O requisito de busca textual por nome de empresa está especificado — incluindo que a busca é incremental (filtra enquanto digita)? [Completude, Spec §FR-006] {auto}
  > **Evidência**: FR-006: "seletor DEVE suportar busca textual por nome de empresa, permitindo localizar rapidamente uma filial em grupos com muitas empresas". O `cmdk` (shadcn Command) implementa filtro incremental por design — Research §D0.1 documenta a escolha.

- [x] CHK002 - O comportamento de visibilidade do combobox (oculto vs visível) está especificado de forma mensurável — com critério "empresas.length > 1"? [Clareza, Spec §FR-001, FR-002, Research §D0.4] {auto}
  > **Evidência**: FR-001 (exibir quando grupo com ≥2 empresas) + FR-002 (ocultar para empresa sem filiais). Research §D0.4: "combobox aparece se e somente se `GET /grupo/escopo` retornar `empresas.length > 1`" — critério mensurável e objetivo.

- [x] CHK003 - O requisito de pré-seleção da empresa do usuário logado como padrão está especificado? [Completude, Spec §FR-003] {auto}
  > **Evidência**: FR-003: "seletor DEVE pré-selecionar a empresa do próprio usuário logado como padrão ao abrir a página sem parâmetro de empresa na URL".

- [x] CHK004 - O requisito de persistência da seleção na URL (`?empresa_id=N`) está especificado — permitindo compartilhar ou salvar como favorito? [Completude, Spec §FR-004] {auto}
  > **Evidência**: FR-004: "seleção de filial DEVE ser refletida na URL como parâmetro persistível (`?empresa_id=N`)".

- [ ] CHK005 - A spec especifica o estado visual do combobox enquanto aguarda o carregamento dos dados de movimento após trocar de filial (loading state)? [Clareza, Gap] {auto}
  > **[Gap]**: FR-005 especifica que a troca de filial recarrega os dados automaticamente, mas nenhum artefato define o estado visual de carregamento (ex: spinner, skeleton, desabilitar combobox durante fetch). Ausente como requisito de UX.

- [ ] CHK006 - A spec define o estado visual do combobox quando `GET /grupo/escopo` falha ou retorna lista vazia inesperadamente? [Cobertura de Edge Cases, Gap] {auto}
  > **[Gap]**: O edge case "falha ao carregar a lista de empresas" não tem comportamento de UX definido (ex: mensagem de erro, retry, fallback para empresa atual). Ausente nos artefatos.

---

## Acessibilidade — Atributos ARIA

- [ ] CHK007 - A spec/plan especifica que o combobox deve ter `role="combobox"`, `aria-expanded` e `aria-haspopup="listbox"` no elemento trigger? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum artefato especifica atributos ARIA para o combobox. Research §D0.1 define o componente (shadcn Command + Popover) mas não os requisitos de atributos ARIA obrigatórios. O `cmdk` tem suporte nativo a ARIA — mas a spec deveria afirmar o requisito explicitamente.

- [ ] CHK008 - A spec especifica que o campo de busca dentro do combobox tem `aria-label` ou `aria-labelledby` descritivo (ex: "Buscar filial")? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum artefato define o label acessível para o input de busca do combobox. O nome acessível é crítico para usuários de leitor de tela compreenderem o propósito do campo.

- [ ] CHK009 - A spec especifica que cada opção de empresa na lista do combobox tem o nome da empresa como texto visível — sem depender apenas de ícone ou código? [Completude, Gap] {auto}
  > **[Gap]**: FR-006 fala em "busca textual por nome de empresa", mas a spec não especifica explicitamente que o `nome_empresa` é o texto exibido na lista (vs exibir apenas ID ou código). Inferível, mas não documentado como requisito.

- [ ] CHK010 - A spec/plan especifica `aria-live` ou mecanismo equivalente para anunciar para leitores de tela que os dados de movimento foram recarregados após troca de filial? [Completude, Gap] {auto}
  > **[Gap]**: FR-005 (recarregar dados ao trocar filial) não tem requisito de acessibilidade correspondente para anunciar a mudança de contexto. Usuários de leitor de tela precisam ser informados que o conteúdo da tabela mudou.

---

## Navegação por Teclado

- [ ] CHK011 - A spec especifica que o combobox é acessível via teclado — incluindo: Tab (foco), Enter/Space (abrir), Arrow keys (navegar opções), Escape (fechar)? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum artefato especifica requisitos de navegação por teclado para o combobox. O shadcn Command tem suporte nativo a estas teclas, mas a spec deveria afirmar o requisito para que seja verificável.

- [ ] CHK012 - A spec especifica que selecionar uma empresa via teclado (Enter na opção) tem o mesmo efeito que clicar (dispara recarregamento de dados e atualiza URL)? [Consistência, Gap] {auto}
  > **[Gap]**: FR-005 especifica recarregamento ao "trocar a filial selecionada", mas não distingue entre seleção via mouse vs teclado. A paridade deve ser explicitada.

---

## Contraste e Responsividade

- [ ] CHK013 - A spec define que as labels do combobox (texto de empresas na lista, placeholder, item selecionado) atendem contraste mínimo WCAG 2.1 AA (4.5:1 para texto normal)? [Completude, Gap] {humano}
  > Nenhum artefato especifica requisitos de contraste para o combobox. O design system EntreGô 2.0 (reskin em andamento) define a paleta — mas a conformidade WCAG do combobox de filial especificamente não está documentada como requisito desta feature. Decisão: usar paleta EntreGô ou definir requisito explícito?

- [ ] CHK014 - A spec especifica tamanho mínimo de área de toque para o trigger do combobox em dispositivos touch (≥44×44px conforme WCAG 2.5.5)? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum artefato define requisito de área de toque para o combobox. FR-001 especifica a existência do seletor, mas não dimensões mínimas para mobile. A plataforma é web (Next.js) com uso em desktop e mobile não explicitado como requisito.

- [ ] CHK015 - A spec define o comportamento do combobox em telas pequenas (≤375px) — ex: popover ocupa largura total, altura máxima da lista scrollable? [Clareza, Gap] {auto}
  > **[Gap]**: Nenhum artefato especifica layout responsivo do combobox. Em mobile, um popover de combobox pode sobrepor conteúdo crítico se não tiver restrição de altura ou width adaptivo. Ausente como requisito.

---

## Estados de Interação

- [x] CHK016 - O estado "empresa selecionada" está especificado — o item selecionado aparece no trigger do combobox (não apenas na lista)? [Clareza, Spec §FR-003, FR-005] {auto}
  > **Evidência**: FR-003 (pré-selecionar empresa do usuário) + FR-005 (refletir seleção) — implicitamente o estado selecionado deve aparecer no trigger. O padrão shadcn Command exibe o item selecionado no Popover trigger — comportamento implícito no componente escolhido.

- [ ] CHK017 - A spec define o comportamento do combobox para grupos com 1 única empresa no escopo (edge case "Grupo com 1 filial": 2 itens, pai + filial)? [Cobertura de Edge Cases, Spec §Edge Cases] {auto}
  > **Evidência parcial**: Spec §Edge Cases: "Grupo com 1 filial: combobox aparece (pois há escolha — pai ou filial), mas com apenas 2 itens". O comportamento de visibilidade está coberto, mas o requisito UX (ex: combobox com 2 itens — deve aparecer como dropdown completo ou simplificado?) não está especificado.
  > **[Ambiguity]**: O edge case especifica que o combobox aparece com 2 itens, mas não define se a experiência visual deve ser diferenciada de um combobox com 30 itens (ex: sem campo de busca para listas pequenas).

- [ ] CHK018 - A spec define o texto do placeholder do campo de busca dentro do combobox? [Clareza, Gap] {humano}
  > Microcopy (ex: "Buscar empresa...", "Selecionar filial...") não está definido na spec. Decisão de produto/UX.

---

## Recarregamento e Feedback de Progresso

- [x] CHK019 - O requisito de recarregamento automático ao trocar filial está especificado como "sem confirmação do usuário"? [Clareza, Spec §FR-005] {auto}
  > **Evidência**: FR-005: "sistema DEVE recarregar os dados de movimento automaticamente, sem exigir confirmação do usuário".

- [ ] CHK020 - A spec especifica o comportamento quando o recarregamento após troca de filial resulta em erro de rede (ex: a tabela exibe dados antigos, mostra mensagem de erro ou trava)? [Cobertura de Edge Cases, Gap] {auto}
  > **[Gap]**: FR-005 especifica o recarregamento automático, mas não o comportamento de UX em caso de falha do fetch subsequente. O usuário pode ficar sem feedback ou ver dados de outra filial.

---

## Notes

- Items `{auto}` estão resolvidos com citação de evidência ou marcados `[Gap]`/`[Ambiguity]`
- Items `{humano}` aguardam decisão do dono do produto
- **Gaps ARIA** (CHK007–CHK010): a spec não documenta requisitos de acessibilidade para o combobox; o shadcn Command tem suporte nativo, mas o requisito deve ser explicitado para ser verificável
- **Gaps de navegação por teclado** (CHK011–CHK012): ausentes como requisitos; devem ser adicionados ou explicitamente delegados ao componente shadcn
- **Gaps de responsividade** (CHK014–CHK015): comportamento mobile não especificado
- **Gaps de estado de erro** (CHK005–CHK006, CHK020): estados de loading/erro do combobox e recarregamento não cobertos
- **Humano**: CHK013 (contraste — decisão de design system), CHK018 (microcopy placeholder)
- Recomendação: os gaps ARIA + teclado (CHK007–CHK012) podem ser resolvidos via referência ao comportamento padrão do shadcn Command — basta adicionar uma nota de requisito que afirme que o comportamento WCAG nativo do componente é requisito desta feature.
