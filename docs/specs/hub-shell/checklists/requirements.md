# Requirements Checklist: Shell Modular do Hub (hub-shell)

**Purpose**: Gate formal de qualidade de requisitos (não de implementação) antes de
`/create-tasks`. Audiência: dono do produto (reviewer). Profundidade: standard. Foco: (1)
contrato `/me` e navegação por permissão, (2) critérios de aceite mensuráveis (SC) e
cobertura de edge cases.
**Created**: 2026-07-07
**Feature**: [`spec.md`](../spec.md) · [`plan.md`](../plan.md) · [`research.md`](../research.md) ·
[`data-model.md`](../data-model.md)

## Cluster 1 — Contrato `/me` e Navegação por Permissão

- [x] CHK001 - FR-001 define os DOIS fatores exclusivos (módulo habilitado para a entidade ativa
  **e** permissão de visualização da pessoa) que determinam presença na navegação, sem margem
  para lista fixa? [Completude, Spec §FR-001] {auto}
- [x] CHK002 - A divergência entre o campo contratado na spec Q1 (`habilitado`) e o campo
  realmente emitido pelo backend (`ativo`) está reconciliada explicitamente nos artefatos, e não
  deixada implícita para a execução descobrir? [Consistência, Plan §1.1 nota + Research D2,
  dec-010] {auto} — Satisfeito: plan.md §1.1 tem nota dedicada "Discrepância spec×código a
  reconciliar" e research.md D2 registra a decisão + 2 alternativas descartadas com justificativa.
- [ ] CHK003 - A convenção `<codigo>.view` (spec Q1/dec-007) diverge do critério real do backend
  ("≥1 permissão com qualquer ação, prefixo `<codigo>`" — não especificamente `.view`); os
  artefatos deixam claro que **nenhuma tela desta fase** depende de checar `.view` como condição
  de navegação (só `PermissionGate` interno usa a convenção)? [Conflict, Plan §1.1 nota / Research
  D2] {auto} — **Parcialmente satisfeito**: a decisão está clara para `ModuleNav` (usa presença no
  array), mas a spec Q1 (linha 24-30) ainda descreve a convenção `.view` como "a" regra de
  visualização de módulo sem apontar de volta para a reconciliação — quem ler só a spec (sem o
  plano) pode implementar um filtro `.view` redundante e divergente do backend real. [Ambiguity] —
  recomenda-se um `Nota` cruzada em spec.md apontando para plan §1.1.
- [x] CHK004 - As três ramificações de vínculo pós-login (`entidades.length` > 1 / == 1 / == 0)
  cobrem exaustivamente o espaço de estados, sem sobreposição nem lacuna, e cada uma tem FR
  correspondente (FR-003, FR-004, FR-016)? [Completude/Mensurabilidade, Spec §FR-003/004/016,
  Plan §3.4] {auto}
- [x] CHK005 - FR-005/FR-006 especificam o comportamento de recusa da troca de entidade
  (mantém a entidade anterior, não interrompe sessão) com contrato de erro citável
  (`403 SEM_VINCULO`)? [Clareza, Plan §1.2] {auto}
- [x] CHK006 - FR-007 ("refletir a entidade ativa... sem misturar dados") tem mecanismo de
  atualização explícito e não-ambíguo (`refetchMe()` completo após troca, não atualização
  parcial de estado)? [Clareza, Plan §3.2 EntitySwitcher / §3.4] {auto}
- [x] CHK007 - FR-015 (perda de vínculo em sessão aberta) tem mecanismo de detecção
  especificado com precisão suficiente para implementar sem ambiguidade (guard de rota +
  `refetchMe()`, explicitamente SEM polling), resolvendo o Q3/dec-009 do clarify? [Clareza,
  Spec Q3/dec-009, Plan §3.4] {auto}
- [ ] CHK008 - A nota de segurança sobre `permissoes[]` ser uma união cross-entidade (não
  escopada à entidade ativa) — que torna `PermissionGate` puramente decorativo — está refletida
  em algum FR/SC verificável, ou vive só em plan/research (fora da spec)? [Gap, Spec — ausente;
  Plan §3.3, Research D3] — a spec não tem um FR/SC explícito cobrindo "o client nunca é a única
  barreira para ações client-only baseadas em `permissoes[]`" (FR-002 cobre só "acesso a área",
  não ações internas de UI gateadas por `PermissionGate`). Risco de regressão futura (S4-S9) se
  um dev novo assumir que `PermissionGate` autoriza. {humano} — decisão de produto se vale a pena
  formalizar como FR novo ou manter como nota de arquitetura.
- [x] CHK009 - Os campos exatos do DTO (`MeResponseDTO`/`toHubMe`) usados pelos componentes
  (`ModuleNav`, `EntitySwitcher`, `EnvBadge`, `PermissionGate`) têm rastreabilidade 1:1 com o
  contrato `/me` verificado por leitura de código (não suposição)? [Completude, Plan §1.1 +
  Data-model §1-3] {auto}
- [ ] CHK010 - O item de teste do plano (§8, E2E) "pessoa sem `usuarios.manage` não vê `/usuarios`
  e recebe 403 do backend ao forçar a URL" usa um **código de permissão** (`usuarios.manage`) que
  não corresponde ao código real seedado pela fundação S2 (`usuarios.gerenciar`, confirmado em
  `docs/specs/hub-fundacoes/quickstart.md` linhas 35/52/55) — nem existe rota `/usuarios` em
  `app_homologacao/frontend_v2/app/` (dashboard só tem `validacao-xml`, `configuracoes`,
  `motoristas` — verificado por `find`). [Conflict, Plan §8] — o exemplo de teste cita um
  código de permissão inexistente e uma rota que esta fase não entrega (módulos de negócio são
  S4-S9, fora de escopo). Corrigir a permissão citada e substituir o exemplo por uma rota
  realmente exercitável nesta fase, ou marcar o cenário como adiado para quando a 1ª rota de
  módulo existir.

## Cluster 2 — Critérios de Aceite Mensuráveis (SC-001..007) e Edge Cases

- [x] CHK011 - SC-001/SC-002/SC-004/SC-005/SC-007 têm limiar objetivo e verificável por
  inspeção/teste (100%, taxa de recusa, presença/ausência binária, comparação lado a lado,
  comparação antes/depois)? [Mensurabilidade, Spec §SC-001/002/004/005/007] {auto}
- [x] CHK012 - SC-003 ("menos de 5 segundos") define um limiar numérico claro e testável para
  refletir dados após troca de entidade? [Mensurabilidade, Spec §SC-003] {auto}
- [ ] CHK013 - SC-006 ("sem regressão perceptível" na identidade visual) e FR-008/FR-017
  ("aviso... visível", "preservar identidade visual") usam termos qualitativos
  (perceptível/visível) sem métrica objetiva (ex.: contraste mínimo, diff de screenshot,
  threshold de axe) — consistente com o padrão já usado no projeto (validação visual manual do
  operador, ver precedentes em outras fases do hub-frota)? [Ambiguity, Spec §SC-006/FR-008/FR-017]
  {humano} — decisão do dono do produto se aceita validação qualitativa (como nas fases
  anteriores) ou exige métrica objetiva antes do release.
- [x] CHK014 - FR-014 e a nota de "Decisões de infraestrutura" citam a mesma fundação (S2) e o
  mesmo número (5 falhas/15 min) de forma consistente ENTRE SI dentro desta spec? [Consistência
  interna, Spec §FR-014 + nota pós-Requirements] {auto}
- [ ] CHK015 - O número citado por esta spec para o limite de recuperação de senha ("5 falhas
  consecutivas / 15 minutos", citando "S2 FR-017") corresponde ao mecanismo de código que
  realmente protege `/recuperar-senha`? **Verificado por leitura de
  `app_homologacao/backend/routes/hub-auth.js` linhas 151-160**: o middleware que decora tanto
  `/login` quanto `/recuperar-senha` é `authRateLimiter` com `windowMs: 15*60*1000` e **`max: 10`**
  (não 5), chaveado por `ip:email`, e o próprio comentário do código admite
  `// FR-016 não quantifica (CHK011) — mesma ordem de grandeza do legado`. O "5 falhas
  consecutivas" da fundação S2 é um mecanismo DIFERENTE (bloqueio de conta por falha de LOGIN,
  não limite de requisições de recuperação de senha). [Conflict, Spec §FR-014 vs.
  `hub-auth.js:151-160`] — a spec cita o mecanismo/número errado para o requisito que
  efetivamente descreve (throttling de solicitações de recuperação, não bloqueio de conta);
  corrigir a spec para citar `max:10`/15min por `ip+email` (ou o valor que o dono do produto
  confirmar como o pretendido) antes de basear tarefas de teste nesse número.
- [x] CHK016 - As 6 Edge Cases descritas em prosa (spec linhas 189-210) têm cada uma um FR/SC
  numerado que a torna testável, com exceção mapeada abaixo (CHK017)? [Cobertura de Edge Cases,
  Spec §Edge Cases] {auto} — 5 de 6 mapeiam: perda de vínculo→FR-015; sem vínculo algum→FR-016;
  módulos vazios→FR-010; acesso direto por URL→FR-002/SC-002; abuso de recuperação→FR-014.
- [ ] CHK017 - O edge case "sessão expira em meio de uma ação (ex.: trocando de entidade,
  preenchendo perfil)" (spec linhas 204-207) tem FR/SC numerado dedicado, ou depende
  implicitamente do guard de rota genérico (FR-015/plan §3.4) sem cobrir o caso de uma
  **submissão em andamento** (ex.: POST disparado com sessão já expirada, resposta 401 chegando
  no meio da troca)? [Gap, Spec — sem FR numerado] — nenhum FR cobre explicitamente o
  comportamento esperado de uma request in-flight que recebe 401 (vs. apenas o guard de
  navegação entre rotas). {humano} — decisão se o comportamento de fallback genérico (401 em
  qualquer chamada → redireciona a `/login`) é suficiente ou exige requisito próprio.

## Consistência Geral entre Spec, Plan, Research e Data-Model

- [x] CHK018 - FR-018 ("manter comportamento das áreas de negócio existentes") e o §3.1 do plano
  (contexto de auth novo/legado coexistindo sem edição do legado) são consistentes e a
  verificação empírica (leitura de `auth-context.tsx`) confirma o uso real de `/verify-auth` +
  `api.post('/login')`? [Consistência, Spec §FR-018, Plan §3.1] {auto} — confirmado por leitura
  direta de `contexts/auth-context.tsx` linhas 23/55.
- [x] CHK019 - O componente citado como ponto de evolução (`components/empresa-selector.tsx`) e
  o contexto de tema citado como reuso (`contexts/tenant-theme-context.tsx`) existem de fato no
  repositório (não é suposição do plano)? [Premissa validada, Plan §3.2/§3.5, Research D9] {auto}
  — ambos confirmados por `find`.
- [x] CHK020 - O proxy reusado (`app/api/[...path]/route.ts`) existe de fato, e o plano marca
  explicitamente como pendência de verificação (não suposição definitiva) o mapeamento exato do
  prefixo `/api/v1/*` na primeira task de execução? [Premissa + Clareza, Plan §3.1] {auto} —
  arquivo confirmado por `find`; o plano já assume corretamente a postura de reverificação (não
  finge certeza).
- [x] CHK021 - Data-model.md declara explicitamente que não há entidade de banco nova, e essa
  afirmação é consistente com plan §7 (decisão "DDL: NÃO é necessário") e com a regra de
  produção do projeto (nenhuma escrita em ambiente vivo)? [Consistência, Data-model §0, Plan §7]
  {auto}
- [x] CHK022 - O adaptador único de borda (`lib/hub/me-dto.ts`) é citado de forma consistente
  entre plan §2/§6 e data-model §3 quanto à responsabilidade (snake→camel, paridade testada,
  nenhum componente consumindo DTO cru)? [Consistência, Plan §2/§6, Data-model §3] {auto}
- [ ] CHK023 - O plano (§9) declara os gates `doc-quality` e `security` para esta onda, mas não
  há gate/critério equivalente declarado para validar a paridade de tipos do adaptador (§6) nem
  para os testes unitários listados (§8) como quality gate formal — ficam só como "testes
  exigidos"? [Gap, Plan §6/§8/§9] — sem um gate nomeado, a cobrança de paridade depende de
  disciplina da fase de execução, não de um checkpoint auditável equivalente aos outros dois.
  {humano} — aceitar como suficiente (testes unitários bloqueiam CI) ou formalizar como gate.

## Dependências e Premissas

- [x] CHK024 - O plano declara que backend S2 (`hub-me.js`, `hub-auth.js`) já está mergeado
  (PR #55) e é a fonte de verdade verificada por leitura direta — a dependência está resolvida
  (não é suposição de contrato futuro)? [Dependência validada, Plan §1] {auto}
- [x] CHK025 - A restrição de build (Next sempre sob cap de memória, nunca solto no host) é
  citada de forma consistente com o CLAUDE.md do projeto e com o histórico de incidente de
  starvation já registrado? [Premissa, Plan §4] {auto}
- [ ] CHK026 - O plano assume que "nenhuma nova dependência" será necessária "salvo
  justificativa" (§4) — os componentes previstos (ModuleNav, EntitySwitcher, EnvBadge,
  PermissionGate) foram confirmados como implementáveis 100% com Base UI/shadcn/Tailwind já
  presentes, ou essa é uma expectativa não verificada por inventário de pacotes? [Assumption,
  Plan §4] {humano} — depende de inspeção do `package.json` na execução; fica como premissa a
  confirmar na primeira task, não um gap de requisito em si.

## Requisitos Não-Funcionais / Design

- [x] CHK027 - FR-017/SC-006 (identidade visual) apontam para o mecanismo concreto de reuso
  (`tenant-theme-context.tsx`) e para a metodologia de design (`/ui-ux-pro-max`), evitando que o
  requisito fique só em prosa sem caminho de implementação? [Clareza, Plan §3.5] {auto}
- [x] CHK028 - O critério de acessibilidade citado nos testes (`axe ≥ 95`, plan §8) tem
  rastreabilidade a um FR/SC da spec, ou é um critério introduzido só no plano sem contrapartida
  formal na spec? [Rastreabilidade, Plan §8] {auto} — introduzido no plano como refinamento
  operacional de FR-017 (preservar identidade/qualidade visual); aceitável como detalhamento de
  implementação de um FR já existente, não um requisito novo não rastreado.
- [ ] CHK029 - Existe requisito (FR/SC) cobrindo o comportamento do `EnvBadge`/favicon quando
  `NEXT_PUBLIC_APP_ENV` está ausente/mal configurado (nem "production" nem outro valor
  reconhecido) — hoje FR-008 só descreve os dois estados binários (produção/não-produção)?
  [Gap, Spec §FR-008, Research D6] {humano} — decisão se "ausente" deve tratar como não-produção
  (fail-safe mostrando o aviso) ou é peso morto por já haver env var obrigatória no deploy.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou aberto com `[Gap]`/
  `[Ambiguity]`/`[Conflict]` quando a evidência mostrou não-satisfação).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto — não foram auto-marcados.
- Achados de maior severidade (recomendado tratar antes de `/create-tasks`): **CHK010** (código
  de permissão + rota inexistentes no exemplo de teste do plano) e **CHK015** (número de rate
  limit da recuperação de senha citado incorretamente na spec — evidência de código real anexada).
