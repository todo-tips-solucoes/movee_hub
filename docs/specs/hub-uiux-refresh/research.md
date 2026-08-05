# Research: hub-uiux-refresh

Documento produzido no Phase 0 do `/plan`. Todos os `NEEDS CLARIFICATION` do
Technical Context já foram resolvidos (spec tem `## Clarifications` com as 5
perguntas do clarify + decisões prévias do briefing); este documento registra
o "como" técnico para cada ponto que a spec deixou aberto quanto a
implementação.

## Decision 1: Persistência da preferência de colapso da sidebar

**Decision**: estado local (`useState`) + leitura/escrita em
`localStorage` (chave própria, ex.: `hub:sidebar-collapsed`), lido no
`useEffect` de montagem do `ModuleNav` (mesmo componente que já hospeda a
sidebar fixa `>= lg`).

**Rationale**: decisão já fixada pelo operador no clarify (Q2) —
"localStorage, reaproveitando o padrão do theme-toggle existente". O
`theme-toggle.tsx` atual não implementa a persistência ele mesmo — quem
persiste é a biblioteca `next-themes` (que grava a chave `theme` no
`localStorage` e injeta um script síncrono no `<head>` para aplicar a classe
antes do primeiro paint). Não há biblioteca equivalente para um estado
arbitrário como "colapso da sidebar", então o "padrão reaproveitado" é o
**mecanismo** (localStorage, chave dedicada, leitura o mais cedo possível),
não a biblioteca em si.

**Alternatives considered**:
- Cookie lido no server component (SSR-safe, sem flash) — rejeitado no
  clarify: exigiria tornar `module-nav.tsx` ciente do cookie no server e
  quebrar seu padrão atual 100% client-driven (`'use client'`); custo maior
  para o ganho, dado que o "flash" já é aceito como mitigável via transição
  suave em vez de eliminação total.
- Context API compartilhado entre tema e sidebar — desnecessário; os dois
  estados são independentes e não precisam de um provider comum.

## Decision 2: Mitigação do "flash" de estado inicial

**Decision**: sem bloqueio de renderização (sem script síncrono adicional no
`<head>`); o valor inicial assume expandido (padrão seguro) e, assim que o
`useEffect` lê o `localStorage`, aplica o estado real com uma transição CSS
suave (`transition-[width]` ou equivalente, respeitando
`prefers-reduced-motion` via `motion-safe:`/`motion-reduce:`, mesmo padrão já
usado em `components/hub/status-badge.tsx` com `motion-safe:animate-spin`).

**Rationale**: decisão do operador no clarify (Q2) — "flash mitigado com
transição suave" em vez de replicar o script de blocking do `next-themes`.
Evita adicionar uma segunda tag de script inline no layout raiz só para um
estado de UI de baixo risco (o pior caso é a barra aparecer expandida por um
instante antes de colapsar).

**Alternatives considered**: script inline síncrono idêntico ao do
`next-themes` (mais robusto contra flash, mas mais invasivo — tocaria
`app/layout.tsx` raiz, compartilhado com painel legado e app motorista,
para um ganho cosmético) — rejeitado pelo operador.

## Decision 3: Dica textual (tooltip) para itens colapsados

**Decision**: reusar `components/ui/tooltip.tsx` (Base UI) já presente no
projeto, aplicado a cada `ItemLink` quando a sidebar está colapsada;
respeitar ativação por foco de teclado (não só hover), exigido por FR-002 e
pelo Acceptance Scenario 5 de US1.

**Rationale**: Base UI Tooltip já dispara em foco de teclado por padrão
(ao contrário de tooltips CSS-only via `title`), satisfazendo a acessibilidade
exigida sem componente novo.

**Alternatives considered**: atributo HTML `title` nativo — rejeitado por
não ser consistentemente acessível via teclado em todos os navegadores e por
já existir um componente de Tooltip dedicado no projeto (rung 2 da ladder:
reusar o que já existe).

## Decision 4: Superfícies de card/tabela (US3, FR-011/012/013)

**Decision**: ajustar os tokens compartilhados em `components/ui/card.tsx`
(hoje `ring-1 ring-foreground/10`) e `components/ui/table.tsx` (hoje
`border-b` com a cor de borda default) para uma separação mais discreta —
substituir o contorno forte do card por profundidade (`shadow-sm`/
`shadow-xs` + ring bem mais sutil ou removido) e suavizar a cor/opacidade do
divisor de linha da tabela e do cabeçalho (destaque por fundo, não por
borda), nos dois temas.

**Rationale**: como `Card`/`Table` são componentes de base já usados em
100% das telas do hub, ajustar aqui satisfaz FR-011/012/013/017 (cobertura
universal, US5) numa única mudança, em vez de editar cada `page.tsx`
individualmente — menor diff, zero risco de esquecer uma tela.

**Alternatives considered**: overrides por página (`className` extra em
cada uso de `<Card>`/`<Table>`) — rejeitado: exigiria tocar ~13 telas e
correria o risco de inconsistência entre elas, exatamente o problema que
FR-017/US5 quer eliminar.

## Decision 5: Componente de indicador numérico (KPI) — FR-014

**Decision**: criar `components/hub/kpi-card.tsx` (rótulo, valor em
destaque, ícone, variação opcional), construído sobre o `Card` já existente
(`components/ui/card.tsx`), e migrar as telas que hoje montam esse padrão ad
hoc (`dashboard/page.tsx`, `performance/page.tsx`, `faturamento/page.tsx`)
para usá-lo.

**Rationale**: não existe hoje um componente compartilhado para esse
padrão — cada tela resolve o layout do indicador isoladamente, o que é
exatamente a inconsistência que US4/FR-014 pede para eliminar.

**Alternatives considered**: nenhuma — não há biblioteca de terceiros já
instalada que resolva isso melhor que compor `Card` (rung 2 da ladder: usar
o que já existe como base, sem dependência nova).

## Decision 6: Componente de área de busca/filtros — FR-015

**Decision**: criar `components/hub/filter-bar.tsx` (busca + filtros +
ação de limpar, com o bloco visualmente destacado), migrando as telas que já
têm busca/filtro ad hoc (`usuarios/page.tsx`, `motoristas/page.tsx`,
`importacoes/page.tsx`) para o componente compartilhado.

**Rationale**: mesmo racional da Decision 5 — padrão hoje duplicado
(`placeholder="Buscar por..."` implementado à mão em pelo menos duas telas),
consolidar em um componente elimina a divergência visual que FR-015 aponta.

**Alternatives considered**: nenhuma — mesma lógica de reuso da Decision 5.

## Decision 7: Badges de status — FR-016 (sem mudança)

**Decision**: nenhuma alteração — `components/hub/status-badge.tsx` já
implementa o padrão único (cor suave + ícone + texto) exigido por FR-016 e
já é reusado por `ImportacaoStatusBadge`, `AtivoBadge`, `VinculoBadge`,
`TipoAtividadeBadge`.

**Rationale**: verificado por leitura direta do componente — já satisfaz o
requisito. Rung 1 da ladder (isso já existe, não recriar).

**Alternatives considered**: N/A.

## Decision 8: Theme toggle na topbar do hub — FR-006

**Decision**: montar `<ThemeToggle />` (componente já existente, sem
alteração) no header de `app/hub/dashboard/layout.tsx`, ao lado de
`EntitySwitcher`/`AccountMenu`. O `ThemeProvider` (`next-themes`) já envolve
o app inteiro em `app/layout.tsx:44` (`attribute="class" defaultTheme="dark"
enableSystem={false}`), então nenhuma mudança de provider é necessária —
só falta o controle estar visível dentro do hub.

**Rationale**: grounding direto no código (`grep ThemeToggle`) mostrou que o
componente e o provider já existem e já funcionam em `/login`/`/register`;
o único gap é a ausência de montagem dentro do shell autenticado do hub.

**Alternatives considered**: N/A — reuso direto, sem alternativa a avaliar.
