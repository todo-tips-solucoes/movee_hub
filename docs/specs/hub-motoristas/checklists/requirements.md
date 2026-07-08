# Requirements Checklist: Módulo Motoristas do Hub de Frota

**Purpose**: Quality gate sobre spec.md / plan.md / research.md / data-model.md / contracts/motoristas-api.md / quickstart.md antes de decompor em `tasks.md`. Valida qualidade dos requisitos (completude, clareza, consistência, testabilidade, cobertura de segurança), não a implementação.
**Created**: 2026-07-08
**Feature**: [spec.md](../spec.md)

## Completude de Requisitos

- [x] CHK001 - Estão os requisitos de leitura (lista + detalhe) definidos para todos os campos exibidos? [Completude, Spec §FR-001/FR-003, contracts GET /motoristas + /:id] {auto} — lista devolve `{id, nome, ativo, comVinculo, areas[]}`; detalhe acrescenta indicadores all-time + `areas` ordenadas por `dataMaisRecente` + `cnpjPrestadorMascarado`.
- [x] CHK002 - Estão os requisitos de edição (nome e situação) definidos com o efeito colateral de proteção contra reimportação? [Completude, Spec §FR-004, research Decision 6] {auto} — `PATCH` grava `nomeEditadoManualmente=true` quando `nome` muda; trigger protege na reimportação (Cenário 4).
- [x] CHK003 - Estão os sete endpoints da API especificados com verbo, path, request e response? [Completude, contracts/motoristas-api.md] {auto} — GET lista, GET /:id, PATCH /:id, GET /:id/sugestoes, GET /contas-elegiveis, POST /:id/vinculo, DELETE /:id/vinculo.
- [x] CHK004 - Estão as 5 migrations (0019–0023) enumeradas com o objeto que cada uma cria/altera? [Completude, data-model §Migrations, plan Fase 1] {auto} — 0019 coluna+trigger, 0020 índices subpraça, 0021 ContaMotorista+FK, 0022 EmpresaGrupoMovee, 0023 funções RPC.
- [x] CHK005 - Está definida a origem dos dados de conta de acesso para sugestão/vínculo dentro do isolamento do hub? [Completude, research Decision 2] {auto} — espelho local `ContaMotorista` populado por seed; sem ponte de rede para `chatmasterveloz`.
- [ ] CHK006 - Estão os requisitos de comportamento do `DELETE /motoristas/:id/vinculo` quando o Entregador NÃO tem vínculo definidos (idempotência do desvínculo vs. 404/409)? [Cobertura, Gap] {auto} — contracts descreve POST (criar/substituir) e cita `motorista.desvinculado` na auditoria, mas o corpo do checklist não localizou a semântica explícita do DELETE sobre um Entregador já sem vínculo. **Vira tarefa: especificar resposta do DELETE idempotente.**
- [ ] CHK007 - Estão os requisitos não-funcionais de rate limiting / proteção contra abuso das rotas de busca (`/sugestoes`, `/contas-elegiveis`) definidos? [Requisitos Não-Funcionais, Gap] {humano} — os códigos de erro do hub (401/403/404/409/422) não incluem `429`; decidir se rate limit é herdado do shell do hub (S3) ou requisito desta fase.

## Clareza de Requisitos

- [x] CHK008 - Está o algoritmo de similaridade quantificado (corte + limiar + normalização)? [Clareza, research Decision 4/10, plan Fase 5] {auto} — `pg_trgm`+`unaccent`, top 10 candidatos, limiar 0.3; candidatos abaixo do limiar nunca aparecem (Clarification Q4).
- [x] CHK009 - Está "múltiplas áreas de atuação" quantificado (todas as distintas, ordenação)? [Clareza, Spec §FR-002/FR-003, Clarification Q2, research Decision 5] {auto} — todas as subpraças distintas, ordenadas por `dataMaisRecente` desc.
- [x] CHK010 - Está a paginação quantificada (default e máximo)? [Clareza, contracts GET /motoristas] {auto} — `pageSize` default 20, máx. 100.
- [x] CHK011 - Está o mascaramento de dado sensível (CNPJ) especificado no shape de resposta? [Clareza, contracts /:id] {auto} — `cnpjPrestadorMascarado: "12.***.***/0001-**"`.
- [ ] CHK012 - Está "navegáveis sem degradação perceptível" (SC-002) quantificado com um alvo objetivo (latência-alvo ou tamanho de página que a sustenta)? [Mensurabilidade, Ambiguity, Spec §SC-002] {auto} — SC-002 usa "sem degradação perceptível" (subjetivo). A paginação (máx 100/página) mitiga, mas não há alvo numérico. **Aceitável como qualitativo se o revisor concordar; senão vira clarify.** Reclassificado abaixo.
- [x] CHK013 - Está a validação de entrada da edição especificada (nome vazio/só espaços)? [Clareza, contracts PATCH /:id] {auto} — `422 INVALIDO` se `nome` vazio/só espaços.

## Consistência de Requisitos

- [x] CHK014 - São consistentes as regras de escopo/`404` entre lista, detalhe, sugestões e busca manual? [Consistência, contracts + research Decision 11] {auto} — todas usam RLS de `Entregador` (0015) → 0 linhas fora do escopo → `404 NAO_ENCONTRADO`; padrão único.
- [x] CHK015 - É consistente a regra de elegibilidade de grupo entre `/sugestoes` e `/contas-elegiveis`? [Consistência, contracts + research Decision 2/11] {auto} — ambas resolvem elegibilidade via `EmpresaGrupoMovee` dentro da RPC; `entidadeElegivel=false` → lista vazia sem erro (FR-011).
- [x] CHK016 - É consistente a confirmação humana obrigatória entre a camada de sugestão e a de vínculo? [Consistência, Spec §FR-008, contracts] {auto} — `/sugestoes` só lista (nunca cria); `POST .../vinculo` é a única ação de escrita; nenhum auto-vínculo (Cenário 6, SC-004).
- [x] CHK017 - São consistentes os códigos de erro entre o padrão do hub e os endpoints desta fase? [Consistência, contracts §códigos] {auto} — 401/403(fail-closed)/404/409/422 reusados uniformemente.

## Cobertura de Segurança (RLS / RBAC / OWASP)

- [x] CHK018 - Estão os requisitos de isolamento multi-tenant definidos para toda leitura e escrita? [Segurança, Spec §FR-005, Constitution II, data-model §RLS, Cenário 10] {auto} — RLS de `Entregador` (`id_empresa = ANY(hub_jwt_escopo_ids())`) desde 0015; tabelas allowlist globais sem RLS por design.
- [x] CHK019 - Está a proteção contra SQL injection nas consultas de similaridade especificada? [Segurança, research Decision 10, data-model §uso combinado] {auto} — sugestão/busca via funções RPC do PostgREST com bind nativo de parâmetros (OWASP A05); sem filtro string ad-hoc.
- [x] CHK020 - Está o BOLA/IDOR das rotas com `:id` de terceiro coberto explicitamente? [Segurança, research Decision 11, contracts /sugestoes] {auto} — a RPC faz `SELECT ... FROM "Entregador" WHERE id = p_entregador_id` sob a RLS do chamador → 0 linhas fora do escopo → `404`.
- [x] CHK021 - Está a proteção contra mass assignment / BOPLA no `PATCH` e no `POST vinculo` especificada? [Segurança, research Decision 12, data-model §edição/vínculo] {auto} — allowlist de campos: `{contaMotoristaId}` no vínculo; campos permitidos no PATCH; nenhum outro campo (ex: `motorista_id` direto) é aceito.
- [x] CHK022 - Está o requisito de autorização por permissão RBAC definido para as ações de edição? [Segurança, Spec §FR-005, research Decision 7, data-model §mapa permissão] {auto} — `requirePermission` sobre códigos já semeados em 0007 (módulo `motoristas`); mapa lógico→real documentado.
- [x] CHK023 - Está a trilha de auditoria definida para toda escrita (editar/vincular/desvincular)? [Segurança/Completude, Spec §FR-014, research Decision 9] {auto} — `registrarAuditoria()` grava `motorista.editado`/`.vinculado`/`.desvinculado`; mascara chaves sensíveis.
- [x] CHK024 - Está a restrição de não-escrita na base de contas de acesso do app motorista especificada? [Segurança, Spec §FR-015/SC-007] {auto} — `ContaMotorista` é espelho local read-only por seed; MUST NOT criar/alterar/apagar na base do app.

## Cobertura de Cenários e Edge Cases

- [x] CHK025 - Estão os cenários de teste mapeados 1:1 a FRs/SCs (rastreabilidade de aceitação)? [Cobertura, quickstart §Cenários 1–12] {auto} — 12 cenários citam FR/SC/Clarification correspondente.
- [x] CHK026 - Está o estado vazio (lista sem resultados) coberto como sucesso, não erro? [Edge Case, contracts GET /motoristas] {auto} — `items: [], total: 0` — nunca erro.
- [x] CHK027 - Está o conflito de vínculo duplo (mesma conta em 2 Entregadores) coberto? [Edge Case, Spec §FR-012, Cenário 8, contracts POST vinculo] {auto} — índice único → `409 CONFLITO` amigável.
- [x] CHK028 - Está a troca de vínculo de um Entregador já vinculado (substituição em ação única) coberta? [Edge Case, Spec §FR-013, Cenário 5, contracts POST vinculo] {auto} — POST substitui em uma única ação; `/sugestoes` responde mesmo para Entregador já vinculado.
- [x] CHK029 - Está a preservação do histórico ao editar (não tocar `FaturamentoLancamento`/`PerformanceTurno`) coberta? [Edge Case, Spec §FR-004, Cenário 3, contracts PATCH] {auto} — PATCH não toca tabelas de fato.
- [x] CHK030 - Está o ramo entidade-fora-do-grupo-Movee coberto (lista vazia, sem erro)? [Edge Case, Spec §FR-010/FR-011, Cenário 9] {auto} — `entidadeElegivel=false` → `items: []`, sem erro.
- [ ] CHK031 - Está o comportamento sob edição concorrente do mesmo Entregador (dois usuários simultâneos) definido? [Edge Case, Gap] {humano} — nenhum requisito de optimistic locking / last-write-wins localizado. Decidir se é in-scope (risco baixo em base de baixa concorrência) ou aceito como last-write-wins explícito.

## Requisitos Não-Funcionais (UI / Branding / Acessibilidade)

- [x] CHK032 - Está o requisito de preservação da identidade visual (branding claro/escuro) definido e testável para as telas novas? [NFR, Spec §FR-017/SC-008, Cenário 12] {auto} — telas em `/hub/dashboard/motoristas*` preservam design system; Cenário 12 valida dark/light via `next-themes`.
- [ ] CHK033 - Estão os requisitos de acessibilidade das telas novas (navegação por teclado, foco, rótulos) definidos além de "preservar identidade visual"? [NFR, Gap] {humano} — FR-017/SC-008 cobrem identidade visual, não a11y. A entrega das telas via `/ui-ux-pro-max` tende a cobrir, mas o requisito não é explícito. Decidir se a11y é gate desta fase.
- [x] CHK034 - Está o requisito de "usuário só-leitura não vê controles de edição" definido e mensurável? [NFR, Spec §FR-005/SC-006, quickstart] {auto} — SC-006: 100% dos controles de edição ausentes para quem não tem permissão; E2E exige 403 se forçar.

## Notes

- Items `{auto}` foram resolvidos contra os artefatos com citação; `[x]` = evidência encontrada, `[ ]` = `[Gap]`/`[Ambiguity]` aberto.
- Items `{humano}` (CHK007, CHK031, CHK033) aguardam decisão do dono do produto/operador.
- **Gaps abertos que viram tarefa no `create-tasks`**: CHK006 (semântica do DELETE idempotente), CHK012 (quantificar ou aceitar SC-002 como qualitativo).
- Resultado geral: feature bem especificada (17 FR + 8 SC + 12 cenários + 12 Decisions + contratos + data-model). Gates `doc-quality` e `owasp-security` já passaram no plan. 3 itens humanos + 2 gaps menores — nenhum bloqueia a decomposição em tasks; CHK006 e CHK033 devem virar tarefas explícitas.
