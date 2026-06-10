# Security Checklist: Grupo Unificado de Filiais

**Purpose**: Validar qualidade e completude dos requisitos de segurança —
autenticação/login único (módulo C), autorização multi-tenant (módulos A/B/C)
e cobertura das 10 ações de segurança mapeadas no OWASP review.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md) · [owasp-review.md](../owasp-review.md)

---

## Autenticação — Login Único (Módulo C)

- [x] CHK001 — O requisito de bloqueio de login de filial define o critério
  de decisão (predicado exato), o código HTTP de retorno e a mensagem exibida
  ao usuário? [Completude, Spec §FR-015]
  > Evidência: FR-015 define `id_grupo != null AND is_grupo_pai = false` →
  > HTTP 403 com body `{"error":"Acesse o painel usando o login do grupo"}`.
  > Acceptance Scenario 3 da US3 confirma os três elementos. {auto}

- [x] CHK002 — A especificação descreve o comportamento de login de
  empresa-pai como porta de entrada **única** do grupo, incluindo o que
  acontece com empresas standalone (sem grupo)? [Completude, Spec §FR-013, §FR-006]
  > Evidência: FR-013 define credencial da empresa-pai (id=6) como acesso ao
  > grupo. FR-006 garante que `id_grupo = null` não é afetado. Acceptance
  > Scenario 4 da US3 confirma backward-compat standalone. {auto}

- [x] CHK003 — O requisito de timing de autenticação (resistência a timing
  oracle / enumeração de usuário) está capturado como critério de
  implementação obrigatório? [Completude, OWASP §HIGH-001]
  > Evidência: OWASP HIGH-001 mapeia ação obrigatória: `bcrypt.compare`
  > SEMPRE primeiro, com dummy hash para e-mail inexistente, guarda de filial
  > (403) SÓ após senha válida. A ação está mapeada para task C. O requisito
  > de "equalizar timing" está documentado no owasp-review.md, mas **não está
  > refletido como FR na spec.md** — ver Gap CHK003-GAP abaixo. {auto}

- [ ] CHK003-GAP — **[Gap]** A spec não tem FR explícito requerindo timing
  equalizado no `POST /login` (dummy hash para e-mail inexistente). A ação
  OWASP HIGH-001 existe apenas no owasp-review.md. Recomendação: adicionar
  NFR ou critério de aceite em FR-015/FR-016 citando resistência a timing
  oracle. [Gap, Spec §FR-015, OWASP §HIGH-001]

- [x] CHK004 — O requisito de rate limiting no `POST /login` (empresa-pai
  vira ponto único de entrada) está especificado com threshold mensurável?
  [Clareza, OWASP §MEDIUM-001]
  > Evidência: OWASP MEDIUM-001 define threshold concreto: "10 tentativas /
  > 15 min / IP, via `express-rate-limit`". Threshold está no owasp-review.md,
  > não na spec como FR. Porém a ação está mapeada para task C com granularidade
  > suficiente para implementação. {auto}

- [ ] CHK004-GAP — **[Gap]** A spec não tem FR de rate limiting. Com a
  empresa-pai tornando-se ponto único de entrada do grupo, o impacto de
  ausência de rate limiting aumenta significativamente em relação a antes.
  Recomendação: adicionar FR ou SC mensurável em módulo C. [Gap, Spec §FR-013, OWASP §MEDIUM-001]

- [x] CHK005 — O requisito de renovação de token (refresh) com preservação
  de contexto de grupo está especificado, incluindo a guarda que impede
  refresh token de filial de renovar acesso após bloqueio? [Completude, Spec §US3-AC5, OWASP §LOW-004]
  > Evidência: US3 Acceptance Scenario 5 define que contexto `id_grupo` /
  > `is_grupo_pai` é preservado no refresh. OWASP LOW-004 mapeia guarda no
  > `/token/refresh` para impedir bypass do 403. Os dois requisitos existem em
  > documentos separados. {auto}

- [ ] CHK005-GAP — **[Gap]** US3-AC5 especifica preservação de contexto no
  refresh, mas a spec não tem FR explícito bloqueando refresh de token de
  filial (o bloqueio existe apenas no OWASP LOW-004). Isso é uma lacuna de
  requisito de segurança: um operador com refresh token de filial antigo
  poderia bypassar o 403 do login. [Gap, Spec §FR-015, OWASP §LOW-004]

- [x] CHK006 — O requisito de log de segurança no evento de bloqueio de
  filial está documentado, sem incluir credenciais no log? [Completude, OWASP §LOW-001]
  > Evidência: OWASP LOW-001 define "Log de segurança (sem credencial) no 403
  > de bloqueio de login de filial." Requisito de "sem credencial" está
  > explícito. Mapeado para task C. {auto}

---

## Autorização Multi-Tenant (Módulos A, B, C)

- [x] CHK007 — O requisito de isolamento multi-tenant para `PUT /grupo/empresas/:id`
  define o predicado de verificação de pertencimento ao grupo (cross-group check)
  e o que retornar em caso de violação? [Completude, Spec §FR-009, OWASP §MEDIUM-003]
  > Evidência: FR-009 define restrição a `is_grupo_pai = true` e filiais do
  > grupo do token. OWASP MEDIUM-003 complementa com: comparar `id_grupo` da
  > filial (via select) com `id_grupo` do token; retornar 403 genérico
  > "Empresa não encontrada" para cross-group. US2 Acceptance Scenario 5
  > confirma que manipulação direta de ID é recusada. {auto}

- [x] CHK008 — O requisito de pertencimento ao grupo (módulo A, `mesmoGrupoQue`)
  especifica o comportamento quando a empresa pertence a grupo sem empresa-pai
  definida? [Edge Case, Spec §Edge Cases]
  > Evidência: Edge Case 1 define: "helper de pertencimento deve tratar
  > graciosamente (sem crash); comportamento cai para 'sem grupo'". FR-006
  > garante backward-compat para `id_grupo = null`. {auto}

- [x] CHK009 — O risco de compartilhamento de cache entre chamadas no helper
  `mesmoGrupoQue` (default object mutável em Node.js) está documentado como
  requisito de implementação obrigatório? [Completude, OWASP §MEDIUM-002]
  > Evidência: OWASP MEDIUM-002 define correção: "Remover default `cache = {}`
  > — caller declara `const _grupoCache = {}` antes do loop." Mapeado para
  > task A. {auto}

- [x] CHK010 — O requisito de injeção via path param `:id` no `PUT` está
  coberto com critério de sanitização obrigatório? [Completude, OWASP §HIGH-002]
  > Evidência: OWASP HIGH-002 define: `parseInt(req.params.id,10)` +
  > `Number.isInteger` + `>0`; usar só o inteiro sanitizado nas queries
  > PostgREST. Mapeado para task B. {auto}

- [ ] CHK011 — Os requisitos de autorização definem o que ocorre quando
  `requireGrupoPai` retorna erro (qual HTTP status, qual body)? É consistente
  com o 403 do módulo C e com o contrato existente da feature
  `cadastro-filiais`? [Consistência, Spec §FR-009]
  > Não encontrei definição explícita do body de erro de `requireGrupoPai` na
  > spec nem nos contratos. O middleware já existe (feature anterior) mas o
  > contrato de erro não está documentado nesta spec. **Reclassificado para
  > {humano}** — verificação de consistência com código existente. {humano}

- [x] CHK012 — A proibição de editar a própria empresa-pai via `PUT /grupo/empresas/:id`
  está especificada como requisito explícito? [Completude, OWASP §MEDIUM-003]
  > Evidência: OWASP MEDIUM-003 especifica: "proibir editar a própria
  > empresa-pai por esta rota." Mapeado para task B. Porém não está como FR
  > na spec.md — ver Gap abaixo. {auto}

- [ ] CHK012-GAP — **[Gap]** Spec não tem FR proibindo edição da empresa-pai
  via `PUT /grupo/empresas/:id`. A ação está somente no OWASP. Recomendação:
  adicionar cláusula em FR-009 ou FR-008. [Gap, Spec §FR-009, OWASP §MEDIUM-003]

---

## Consistência de Requisitos de Segurança

- [x] CHK013 — Os requisitos de validação de e-mail no `PUT` são consistentes
  com os do `POST /grupo/empresas` (mesmo regex)? [Consistência, OWASP §LOW-002]
  > Evidência: OWASP LOW-002 define: "Usar o MESMO regex de email do
  > `POST /grupo/empresas` no PUT." Contrato do PUT (contracts/grupo-unificado-api.md)
  > define campo email como "formato email; UNIQUE excluindo o próprio ID". A
  > exigência de consistência de regex está documentada. {auto}

- [x] CHK014 — A spec define o comportamento de backward-compat para empresas
  sem grupo em todos os três módulos (A, B, C)? [Consistência, Spec §FR-006, §FR-007]
  > Evidência: FR-006 (módulo A) garante `id_grupo = null` sem impacto.
  > FR-007 preserva o ramo `id_empresa === 16`. Edge Case "Backward-compat"
  > confirma para os três módulos. US3 AC4 confirma standalone. {auto}

- [x] CHK015 — O critério de sucesso "Revisão OWASP não identifica
  vulnerabilidades de severidade critical ou high" é verificável
  objetivamente dado que o OWASP review já foi executado? [Mensurabilidade, Spec §SC-Módulo-C]
  > Evidência: Success Criteria (módulo C) define esse critério. O
  > owasp-review.md confirma 0 CRITICAL, 2 HIGH identificados — ambos com
  > correção mapeada para tasks. O critério é verificável. {auto}

---

## Cobertura de Ações OWASP (rastreabilidade task)

- [x] CHK016 — As 10 ações de segurança mapeadas no OWASP review estão todas
  atribuídas a um módulo/task específico (A, B ou C)? [Completude, OWASP §Ações obrigatórias]
  > Evidência: Tabela "Ações obrigatórias" do owasp-review.md lista tasks A/B/C
  > para todas as 10 ações. HIGH-001 → C; HIGH-002 → B; LOW-004 → C; MEDIUM-001 → C;
  > MEDIUM-002 → A; MEDIUM-003 → B; LOW-001 → C; LOW-002 → B; LOW-003 → B(tela);
  > INFO-001/002/003 → backlog. Cobertura 100% das ações HIGH/MEDIUM/LOW. {auto}

- [ ] CHK017 — O tratamento de secrets (INFO-001: bcrypt cost, INFO-003: CSP)
  como tech debt é decisão deliberada do produto ou deve ser incluído como
  critério de aceite desta feature? [Risco, OWASP §INFO] {humano}

---

## Notes

- Items `{auto}` resolvidos com evidência citada (`[x]`)
- Items `{humano}` aguardando decisão do dono do produto (`[ ]`)
- `[Gap]` indica requisito ausente na spec que existe apenas no owasp-review.md —
  ação recomendada: `/clarify` ou adicionar FR complementar antes de `create-tasks`
- IDs CHK001–CHK017 neste arquivo; próximo domínio inicia em CHK018
