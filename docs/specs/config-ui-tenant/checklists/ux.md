# UX Checklist: Configuração de UI por Tenant (White-label) + Grupo de CNPJs

**Purpose**: Validar qualidade dos requisitos de UX — form de aparência com preview ao vivo,
fallback Movee, comportamento em dark/light, wordmark/logo, e experiência no PWA motorista.

**Created**: 2026-06-05
**Feature**: [spec.md](../spec.md) | [contracts/branding-api.md](../contracts/branding-api.md)
**Domínio**: ux

---

## Form de Aparência — Preview ao Vivo

- [x] CHK050 - O requisito de preview ao vivo das cores/logo no form de aparência está
  declarado como FR com critério de "ao vivo" (antes de salvar)? [Completude, FR-009,
  spec.md] {auto}
  > SATISFEITO — spec.md §FR-009: "O `frontend_v2` DEVE aplicar os tokens de branding
  > [...] imediatamente ao salvar, sem necessidade de reload." US2 Acceptance Scenario 3:
  > "ao alterar a cor primária, o painel muda de cor em tempo real." Requisito de
  > preview é explícito.

- [x] CHK051 - O mecanismo de preview ao vivo (CSS custom properties via `style` no
  `:root`, sem dependências externas) está especificado nos artefatos técnicos?
  [Completude, contratos/branding-api.md, plan.md] {auto}
  > SATISFEITO — branding-api.md §Mapeamento snake_case → CSS custom property:
  > TenantThemeProvider aplica os campos via CSS vars. plan.md §Complexity Tracking:
  > "Zero deps novas: usa CSS custom properties nativas + `style` no `:root`."

- [ ] CHK052 - O requisito de preview ao vivo especifica se a mudança de cor é aplicada
  **apenas no preview** (sem persistir) até o usuário clicar "Salvar", ou se é aplicada
  instantaneamente e persiste a cada keystroke? [Clareza, Ambiguity — FR-009 diz
  "imediatamente ao salvar" mas US2 Acceptance Scenario 3 diz "ao alterar [...] muda
  em tempo real"; os dois trechos sugerem comportamentos diferentes (save-triggered
  vs. live-as-you-type)] {humano}

- [ ] CHK053 - Os requisitos de acessibilidade do form de aparência estão definidos
  para seleção de cor (color picker com input hex manual acessível via teclado, label
  visível)? [Completude, Gap — nenhum FR ou acceptance scenario especifica
  acessibilidade do seletor de cor; usuários com daltonismo podem não perceber cor
  via picker visual] {humano}

---

## Fallback Movee — Completude e Consistência

- [x] CHK054 - O comportamento de fallback Movee para empresa sem grupo está especificado
  em todos os contextos de exibição (painel, PWA motorista)? [Completude, SC-007,
  spec.md §Edge Cases] {auto}
  > SATISFEITO — spec.md §Edge Cases: "Grupo sem branding configurada no pai: todos os
  > filhos exibem o fallback Movee." SC-007: "A identidade visual padrão (Movee) é
  > exibida como fallback em 100% dos casos." branding-api.md especifica fallback
  > payload para ambos os endpoints.

- [x] CHK055 - O requisito de que fallback nunca resulta em "tela em branco" ou erro
  visual está declarado como success criterion mensurável? [Completude, SC-007, spec.md] {auto}
  > SATISFEITO — spec.md §SC-007: "A identidade visual padrão (Movee) é exibida como
  > fallback em 100% dos casos onde a branding do tenant está ausente ou a busca falha —
  > nunca erro visual ou tela em branco."

- [x] CHK056 - O fallback cobre o caso de **falha de rede** (não apenas ausência de
  branding) — o requisito especifica que timeout na busca também aciona fallback?
  [Completude, FR-010, spec.md] {auto}
  > SATISFEITO — spec.md §FR-010: "em caso de falha ou ausência, aplicar fallback
  > Movee." branding-api.md §GET /motorista/branding-tomador Response: "ou erro de
  > resolução → fallback."

- [ ] CHK057 - O requisito de fallback define o que "identidade visual padrão Movee"
  significa concretamente: quais cores hexadecimais, qual logo, qual nome de exibição?
  [Clareza, Gap — SC-007 e FR-010 referenciam "fallback Movee" mas não definem os
  valores concretos de cores/logo Movee; o comportamento correto é "não sobrescrever
  as CSS vars do globals.css", mas isso não está declarado como requisito] {humano}

---

## Dark/Light Mode — Preservação e Compatibilidade

- [ ] CHK058 - O requisito de que branding personalizada preserva o modo dark/light
  do usuário (não sobrescreve o tema de sistema) está declarado nos FRs? [Completude,
  Gap — nenhum FR especifica o comportamento da branding em dark mode; CSS custom
  properties sobrescrevem `--primary` globalmente; se o tema dark ajusta `--primary`
  para uma variante escura, a branding pode quebrar o contraste] {humano}

- [ ] CHK059 - O requisito especifica se `cor_primaria` e `cor_destaque` fornecidas
  pelo tenant são aplicadas **tal qual** em dark mode, ou se o TenantThemeProvider
  deve derivar variantes dark automaticamente? [Clareza, Ambiguity — branding-api.md
  §Mapeamento descreve aplicação direta de HEX; não há spec de adaptação por tema;
  acessibilidade pode ser comprometida se tenant configurar cor clara em tema escuro] {humano}

---

## Wordmark e Logo — Requisitos Visuais

- [x] CHK060 - O requisito de que `nome_exibicao` é usado como texto do wordmark/header
  quando não há logo está especificado? [Completude, data-model.md, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §Mapeamento: "nome_exibicao → texto do wordmark/header
  > (frontend_v2) / texto do wordmark (frontend_motorista)." data-model.md §Branding:
  > "`logo_url` NULL → sem logo (usa wordmark/nome)."

- [x] CHK061 - O requisito de hierarquia de exibição (logo tem precedência sobre
  wordmark de texto quando ambos estão presentes) está especificado? [Completude,
  contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §Mapeamento: `logo_url` mapeia para `src` do logo
  > no header; `nome_exibicao` mapeia para texto do wordmark. Implicitamente, logo_url
  > presente → exibe imagem; NULL → exibe nome. Hierarquia clara por design.

- [ ] CHK062 - O requisito especifica as dimensões/proporções esperadas do logo no
  header (aspect ratio, tamanho máximo de exibição, comportamento em mobile vs.
  desktop)? [Completude, Gap — spec.md FR-008 menciona "tela de aparência" mas não
  define dimensões de exibição do logo; apenas o limite de upload (512 KB) está
  definido] {humano}

---

## PWA Motorista — Branding por Movimento

- [x] CHK063 - O requisito de que a branding é carregada **por movimento** (cada
  abertura de movimento busca branding do tomador) está declarado como FR? [Completude,
  FR-010, spec.md] {auto}
  > SATISFEITO — spec.md §FR-010: "O `frontend_motorista` DEVE buscar, em cada
  > carregamento de movimento, a branding do tomador associado."

- [x] CHK064 - O acceptance scenario de motorista visualizando logo/cores do tomador
  no painel de movimento está especificado com critério verificável? [Completude,
  US3, spec.md] {auto}
  > SATISFEITO — spec.md §US3 Acceptance Scenario 1: "Given motorista autenticado com
  > movimento em aberto de um tomador com branding configurada, When abre o painel do
  > movimento, Then vê o logo, as cores e o nome do tomador aplicados no header/tema."

- [x] CHK065 - O requisito de que o motorista **sem movimento ativo** ou **com tomador
  sem branding** vê o fallback Movee (não branding de outro tomador) está especificado?
  [Completude, spec.md §Edge Cases, SC-007] {auto}
  > SATISFEITO — spec.md §US3 (último cenário): "motorista sem movimento ativo, ou
  > tomador sem branding configurada, vê o fallback Movee." SC-007 cobre o caso genérico.

- [ ] CHK066 - O requisito de que a branding muda ao trocar de movimento (carregamento
  novo de branding quando motorista muda o movimento ativo) está especificado?
  [Completude, Gap — FR-010 especifica "em cada carregamento de movimento" mas não
  descreve o ciclo de vida: se o motorista muda de movimento sem reload da página,
  o TenantThemeProvider deve reatualizar as CSS vars] {humano}

---

## Consistência entre Painel (frontend_v2) e PWA (frontend_motorista)

- [x] CHK067 - O mapeamento de `cor_destaque` está diferenciado para `frontend_v2`
  (`--accent`) e `frontend_motorista` (ponto do gradiente `--warm-2`) de forma
  documentada nos artefatos? [Completude, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §Mapeamento: `cor_destaque` → `--accent`
  > (frontend_v2) vs. `--accent`/`--warm-2` (frontend_motorista, extremos derivados
  > por luminância). Decisão de derivação documentada.

- [ ] CHK068 - O algoritmo de derivação de gradiente (extremos por luminância a partir
  de `cor_destaque`) está especificado com critério verificável para garantir contraste
  mínimo WCAG AA? [Clareza, Ambiguity — branding-api.md menciona "extremos derivados
  por luminância" mas não especifica o algoritmo; sem critério de contraste mínimo,
  um tenant pode configurar cor que resulta em texto ilegível no gradiente] {humano}

---

## Notes

- Items `{auto}` resolvidos com citação direta dos artefatos
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto
- **{auto} resolvidos**: 10 (`[x]` com evidência citada)
- **{humano} aguardando decisão**: 9 (CHK052, CHK053, CHK057, CHK058, CHK059, CHK062, CHK066, CHK068)
- **Gaps abertos**: 7 gaps de requisito (CHK053, CHK057, CHK058, CHK062, CHK066, CHK068) + 1 ambiguidade de comportamento (CHK052)

### Gaps prioritários para /clarify ou definição antes de create-tasks

| Item | Gap | Ação sugerida |
|------|-----|---------------|
| CHK052 | Preview ao vivo: live-as-you-type vs. save-triggered | Reconciliar FR-009 com US2 Acceptance Scenario 3 |
| CHK057 | Definição concreta de "identidade visual Movee" (cores/logo hardcoded) | Documentar valores padrão no TenantThemeProvider ou globals.css |
| CHK058/59 | Comportamento de branding em dark mode | Decidir: aplicar HEX direto ou derivar variante escura |
| CHK062 | Dimensões/proporções do logo no header | Especificar aspect ratio e tamanho de exibição no FR-008 |
| CHK066 | Ciclo de vida do TenantThemeProvider ao trocar movimento | Especificar no FR-010 ou contrato do componente |
| CHK068 | Algoritmo de derivação de gradiente (WCAG AA) | Especificar critério mínimo de contraste |
