# UX Checklist: Refresh de UI/UX do Hub de Frota

**Purpose**: Validar qualidade dos requisitos (não da implementação) do
refresh visual do hub — sidebar colapsável, tema, hierarquia visual de
superfícies, padrões de indicador/filtro e cobertura sem exceção.
**Created**: 2026-08-05
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md)

## Completude de Requisitos

- [x] CHK001 - Requisitos de dica (tooltip) para itens colapsados cobrem tanto mouse quanto foco por teclado, não só hover? [Completude, Spec §US1 AC5, FR-002] {auto}
- [x] CHK002 - O comportamento durante a leitura inicial da preferência (antes do `localStorage` responder) está especificado, evitando estado indefinido? [Completude, Spec §Edge Cases "flash"] {auto}
- [ ] CHK003 - Estados vazios (empty states) de listagens têm requisito definido quanto ao novo padrão de superfície/cartão? [Cobertura, Gap] {auto} — spec não menciona empty states; herdam o padrão de card por token compartilhado (CHK008), mas nenhuma US/FR os cita explicitamente.
- [x] CHK004 - O comportamento quando o `localStorage` está bloqueado/indisponível é definido para AMBAS as preferências (sidebar e tema)? [Completude, Spec §Edge Cases] {auto}

## Clareza de Requisitos

- [ ] CHK005 - "Transição suave" (FR-004) é quantificada com duração/easing específicos, ou fica a critério do plano técnico? [Clareza, Spec §FR-004] {auto} — Ambiguity: spec não numera duração/easing; plan.md também não fixa um valor (Performance Goals cita apenas "perceptível como instantânea", sem ms).
- [ ] CHK006 - "Aumento mensurável de largura útil" (SC-001) define um valor ou percentual mínimo de ganho? [Clareza, Spec §SC-001] {auto} — Ambiguity: critério de sucesso não numera o ganho esperado (ex.: Xpx ou X%).
- [ ] CHK007 - Os "padrões mínimos reconhecidos de contraste de acessibilidade" (FR-010/SC-003) nomeiam um standard e ratio específicos (ex.: WCAG 2.1 AA, 4.5:1 texto / 3:1 não-textual)? [Clareza, Spec §FR-010, §SC-003] {auto} — Ambiguity: nenhum dos dois cita WCAG/ratio explicitamente, apenas "padrão mínimo reconhecido".
- [x] CHK008 - "Sombra sutil" (FR-012) e "separação discreta" (FR-011) têm um ponto de resolução técnica concreto (não ficam soltos em linguagem natural)? [Clareza, Spec §FR-011, §FR-012, plan.md linhas 33-36] {auto} — plan.md aponta a mudança em nível de token compartilhado (`components/ui/card.tsx` ring→shadow; `components/ui/table.tsx` borda de linha/header), não por página.

## Consistência de Requisitos

- [x] CHK009 - Os requisitos de tema (FR-006..010) são consistentes com o mecanismo já existente (`theme-toggle`/`next-themes`) reaproveitado, sem introduzir uma segunda implementação divergente? [Consistência, Spec §FR-006, §FR-007, plan.md linhas 18-22] {auto}
- [x] CHK010 - A persistência de sidebar (FR-003) é consistente com o mecanismo de persistência de tema (mesma técnica `localStorage`)? [Consistência, Spec §FR-003] {auto} — "reaproveitando o mesmo padrão já usado pelo controle de tema" é explícito.
- [x] CHK011 - O padrão de badge (FR-016) é consistente com a implementação já existente (`status-badge.tsx`) citada no plano, sem exigir redesenho? [Consistência, Spec §FR-016, plan.md linhas 25-27] {auto}
- [x] CHK012 - O requisito de "sem exceção, todas as telas" (FR-017) é consistente com os itens explicitamente excluídos do escopo (busca global, toggle Table/Card View)? [Consistência, Spec §Escopo, §Clarifications Q1-Q2] {auto} — a nota de escopo no topo da spec e as duas primeiras Clarifications delimitam a exclusão sem ambiguidade sobre o que é "toda tela".

## Qualidade de Critérios de Aceite

- [x] CHK013 - SC-002 (100% das telas oferecem controle de tema) é verificável contra uma lista fechada de telas? [Mensurabilidade, Spec §SC-002, plan.md Scale/Scope] {auto} — plan.md lista as ~13 telas do escopo (Project Structure).
- [x] CHK014 - SC-004 (zero telas com dupla ênfase de contorno "cartão + tabela") é verificável por auditoria visual objetiva, apontando o ponto de mudança técnica? [Mensurabilidade, Spec §SC-004, plan.md linhas 33-36] {auto} — resolvido no nível de token compartilhado citado em CHK008.
- [ ] CHK015 - SC-006 (cores de marca em ambos os temas) pode ser testado sem exigir a indicação de qual empresa de teste tem white-label configurado? [Mensurabilidade, Gap] {humano} — falta indicar o tenant/empresa concreto a usar na validação visual.
- [ ] CHK016 - SC-007 (zero regressão de comportamento) tem um critério objetivo de verificação (ex.: qual suíte de regressão cobre isso), ou depende de inspeção manual de escopo aberto? [Mensurabilidade, Spec §SC-007] {humano} — decisão de profundidade de verificação cabe ao dono do produto.

## Cobertura de Cenários

- [x] CHK017 - O cenário de dispositivo móvel (US1 AC4) cobre explicitamente que o colapso NÃO se aplica ao menu deslizante mobile? [Cobertura, Spec §US1 AC4, FR-005] {auto}
- [x] CHK018 - Há cenário de aceite cobrindo navegação só por teclado com a barra colapsada, não apenas mouse/hover? [Cobertura, Spec §US1 AC5] {auto}
- [x] CHK019 - Há cenário cobrindo diálogos/assistentes em etapas herdando o mesmo padrão visual (US5 AC2)? [Cobertura, Spec §US5 AC2, FR-017] {auto}
- [x] CHK020 - Há cenário cobrindo telas restritas por papel/permissão que a conta QA padrão não acessa? [Cobertura, Spec §Clarifications Q4] {auto} — resolvido via elevação temporária de papel no `hub_homolog_db`.
- [x] CHK021 - Há cenário cobrindo tela de detalhe com baixa densidade de dados, sem forçar elementos sem sentido (ex.: filtros numa tela sem lista)? [Cobertura, Spec §Edge Cases] {auto}

## Cobertura de Edge Cases

- [x] CHK022 - O comportamento sob preferência de SO "reduzir movimento" é definido para colapso E troca de tema? [Edge Case, Spec §Edge Cases, FR-004] {auto}
- [x] CHK023 - O comportamento de tabela muito larga com a barra colapsada (rolagem horizontal residual) é definido? [Edge Case, Spec §Edge Cases] {auto}
- [x] CHK024 - O comportamento de cores de marca personalizadas ao alternar tema (sem "vazar" cor padrão) é definido? [Edge Case, Spec §Edge Cases, FR-009] {auto}

## Requisitos Não-Funcionais

- [x] CHK025 - FR-010 cobre tanto texto quanto elementos não-textuais (ícones, bordas, indicadores) para contraste? [Não-Funcional, Spec §FR-010] {auto} — "para texto e para elementos não textuais" é explícito (complementa a lacuna de CHK007, que é sobre o *ratio*, não sobre a cobertura de tipos de elemento).
- [ ] CHK026 - Existe um orçamento de performance objetivo (ex.: ms) para a transição, ou fica apenas qualitativo ("instantâneo"/"sem jank")? [Não-Funcional, Clareza, plan.md Performance Goals] {humano} — decisão de se vale a pena numerar um orçamento além do já existente.

## Dependências e Premissas

- [x] CHK027 - As dependências de bibliotecas/componentes reaproveitados (`next-themes`, `theme-toggle`, `status-badge`, Base UI `tooltip`) estão validadas contra o código real, não supostas? [Dependência, plan.md linhas 18-29] {auto} — plan.md cita arquivos e linhas concretas (ex.: `app/layout.tsx:44`).
- [x] CHK028 - A premissa de que a navegação lateral já é 100% data-driven (sem item fixo introduzido pelo colapso, FR-019) está validada contra o componente existente? [Dependência, Spec §FR-019, plan.md linhas 30-32] {auto} — plan.md identifica `module-nav.tsx` como o único ponto que precisa de lógica nova (estado), sem introduzir item estático.

## Ambiguidades e Conflitos

- [ ] CHK029 - A premissa de qual empresa/tenant de teste possui white-label configurado para validar SC-006/US2-AC3 está documentada em algum lugar (spec, plan ou discovery)? [Ambiguity, Gap] {humano} — mesmo gap de CHK015; consolidado aqui como pendência única de origem de dado de teste.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou `[ ]` com marcador `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- Gate determinístico `requirement-coverage.sh` sobre spec.md: `requirements=20 covered=20 errors=0` (exit 0) — todos os 20 FRs têm cenário de aceite associado.
