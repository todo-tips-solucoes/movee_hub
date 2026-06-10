# API Checklist: Grupo Unificado de Filiais

**Purpose**: Validar qualidade e completude dos requisitos de API —
contratos do `PUT /grupo/empresas/:id` (endpoint novo), modificações no
`POST /login` (módulo C) e consistência entre spec, contratos e OWASP.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md) · [contracts/grupo-unificado-api.md](../contracts/grupo-unificado-api.md)

---

## Contrato do Endpoint `PUT /grupo/empresas/:id`

- [x] CHK018 — O contrato define todos os campos do request body com
  obrigatoriedade, tipo e regras de validação explícitas? [Completude, contracts/grupo-unificado-api.md]
  > Evidência: Tabela do contrato define 9 campos com colunas "Obrigatório" e
  > "Regras": `nome_empresa` (sim, não vazio), `email` (sim, formato + UNIQUE
  > excluindo próprio ID), `cnpj` (sim, 14 dígitos numéricos + UNIQUE), campos
  > fiscais (não, string livre). Completo. {auto}

- [x] CHK019 — Os códigos de erro HTTP para cada cenário de falha do `PUT`
  estão definidos (400, 403, 409, 404)? [Completude, contracts/grupo-unificado-api.md, Spec §FR-010]
  > Evidência: contratos definem: 400 para param inválido (HIGH-002), 403 para
  > cross-group (MEDIUM-003), 409 para email/CNPJ duplicado (FR-010). FR-010
  > especifica "mensagem de erro específica por campo". A ausência de 404
  > (filial não encontrada no grupo) precisa de atenção — ver Gap abaixo. {auto}

- [ ] CHK019-GAP — **[Gap]** O contrato não define resposta 404 para o caso em
  que o `id` existe no banco mas não pertence ao grupo do token. OWASP MEDIUM-003
  instrui retornar 403 genérico ("Empresa não encontrada") em vez de 404 —
  a intenção é "fail-safe" (não vazar existência), mas esse comportamento não
  está documentado formalmente no contrato. [Gap, contracts §PUT, OWASP §MEDIUM-003]

- [x] CHK020 — O requisito de unicidade de email/CNPJ especifica se a verificação
  exclui o próprio registro sendo editado (sem falso positivo ao salvar sem
  alterar)? [Clareza, Spec §FR-010, contracts §PUT]
  > Evidência: contrato define "UNIQUE excluindo o próprio ID" para email e CNPJ.
  > FR-010 confirma rejeição de valor já existente "em outra empresa". Não-ambíguo. {auto}

- [x] CHK021 — O campo `senha` no `PUT` está documentado como ignorado mesmo
  se enviado, e a razão está justificada? [Clareza, contracts §PUT, Spec §CL-002]
  > Evidência: contrato define `senha: não | ignorada mesmo se enviada (FR-B)`.
  > CL-002 resolve que "senha de filial não é necessária — empresa-pai é o
  > único ponto de login do grupo." Justificativa documentada. {auto}

- [x] CHK022 — O path param `:id` do `PUT` tem requisito explícito de sanitização
  (inteiro positivo) para prevenir injeção PostgREST? [Completude, OWASP §HIGH-002]
  > Evidência: OWASP HIGH-002 define: `parseInt(req.params.id,10)` +
  > `Number.isInteger` + `>0`. Mapeado para task B. O contrato menciona
  > "inteiro, ID da empresa filial a editar" mas não detalha a sanitização
  > — o requisito de sanitização vive no OWASP, não no contrato formal. {auto}

- [ ] CHK022-GAP — **[Gap]** O contrato da API não menciona o requisito de
  sanitização do `:id` como critério de aceite da implementação. Recomendação:
  adicionar nota no contrato. [Gap, contracts §PUT, OWASP §HIGH-002]

---

## Contrato do Endpoint `POST /login` (Modificado — Módulo C)

- [x] CHK023 — O comportamento novo do `POST /login` (bloqueio 403 para filial)
  está descrito com o momento exato em que ocorre na sequência de verificação?
  [Clareza, Spec §FR-015, OWASP §HIGH-001, plan.md §POST /login]
  > Evidência: plan.md descreve a sequência modificada: verificar se empresa é
  > filial → se sim, retornar 403 sem completar login. OWASP HIGH-001 refina:
  > o `bcrypt.compare` (com dummy hash para email inexistente) deve ocorrer
  > ANTES da guarda de filial, equalizando timing. O "momento exato" está
  > dividido entre plan e OWASP, não consolidado na spec. {auto}

- [x] CHK024 — O body de resposta 403 para login de filial bloqueado está
  definido com string exata? [Clareza, Spec §FR-015, US3-AC3]
  > Evidência: FR-015 + US3 Acceptance Scenario 3 definem:
  > `{"error":"Acesse o painel usando o login do grupo"}`. Exato. {auto}

- [x] CHK025 — O requisito de backward-compat do `POST /login` para empresas
  sem grupo e para a empresa-pai está especificado — i.e., o fluxo atual não
  é alterado para esses casos? [Completude, Spec §FR-013, §FR-006, US3-AC4]
  > Evidência: FR-013 define que login da empresa-pai ocorre com credencial
  > existente sem alteração de fluxo. FR-006 garante `id_grupo = null` sem
  > impacto. US3-AC4 confirma standalone. {auto}

- [x] CHK026 — A estratégia de rate limiting para `POST /login` tem threshold
  quantificado e comportamento de resposta definido? [Clareza, OWASP §MEDIUM-001]
  > Evidência: OWASP MEDIUM-001 define "10 tentativas/15min/IP via
  > `express-rate-limit`". Threshold concreto. O comportamento de resposta
  > (HTTP 429 é o padrão do express-rate-limit) não está explicitado na spec
  > — ver Gap abaixo. {auto}

- [ ] CHK026-GAP — **[Gap]** O código HTTP e o body de resposta quando o rate
  limit é excedido não estão definidos na spec nem nos contratos. O
  `express-rate-limit` retorna 429 por padrão, mas a mensagem de erro deveria
  ser definida como requisito (especialmente porque o operador verá essa
  mensagem ao tentar logar com grupo). [Gap, OWASP §MEDIUM-001]

---

## Consistência entre Endpoints e Spec

- [x] CHK027 — Os endpoints listados no contrato como "sem alteração de
  contrato" (`GET /grupo/escopo`, `GET /grupo/filhos`, etc.) têm seus
  comportamentos no escopo desta feature justificados como reuso sem mudança?
  [Consistência, contracts §Endpoints Existentes]
  > Evidência: contrato tem seção "Endpoints Existentes (sem alteração de
  > contrato)" com tabela de 5 endpoints e notas. `POST /grupo/empresas`
  > nota: "senha passa a ser opcional/ignorada internamente (FR-B)". {auto}

- [x] CHK028 — A exigência de `authenticateToken` + `requireGrupoPai` no `PUT`
  está consistente com o que FR-009 especifica como pré-condição de autorização?
  [Consistência, Spec §FR-009, contracts §PUT]
  > Evidência: contrato define "Auth: `authenticateToken` + `requireGrupoPai`".
  > FR-009 define restrição ao admin de grupo (`is_grupo_pai = true`) e filiais
  > do grupo do token. Consistente. {auto}

- [x] CHK029 — O requisito de performance por ciclo de operação (máximo 1
  resolução de pertencimento ao grupo por ciclo, FR-005) é verificável a
  partir dos critérios de sucesso? [Mensurabilidade, Spec §FR-005, §SC-Módulo-A]
  > Evidência: FR-005 define "no máximo uma consulta por ciclo de operação".
  > Success Criteria confirma: "mensurável por log/trace de consultas ao banco".
  > O critério é verificável com instrumentação de log. {auto}

- [ ] CHK030 — Os requisitos de idempotência do `PUT /grupo/empresas/:id`
  estão definidos (o que acontece se a mesma requisição for enviada duas vezes)?
  [Clareza, Spec §FR-008] {humano}
  > Nenhum FR ou contrato menciona idempotência explicitamente para o PUT.
  > Uma edição duplicada com os mesmos dados deve ser aceita ou retornar erro?
  > O comportamento natural do banco (UPDATE sem mudança) é silencioso, mas o
  > requisito não está formalizado.

---

## Error Handling Geral

- [x] CHK031 — As mensagens de erro visíveis ao usuário (409 de email/CNPJ
  duplicado) são específicas por campo, como requerido pelo FR-010? [Clareza, Spec §FR-010]
  > Evidência: FR-010 define "mensagem de erro específica por campo" e US2
  > Acceptance Scenarios 3/4 confirmam com strings: "CNPJ já cadastrado" e
  > "E-mail já cadastrado". {auto}

- [ ] CHK032 — Os requisitos de observabilidade (logging estruturado, métricas
  de latência e taxa de erro) estão definidos para os endpoints modificados
  (`PUT` novo e `POST /login` modificado)? [Cobertura, Gap]
  > Apenas OWASP LOW-001 menciona log de segurança no 403. Não há FR de
  > observabilidade geral (métricas, tracing) para os dois endpoints. [Gap] {humano}

---

## Notes

- Items `{auto}` resolvidos com evidência citada (`[x]`)
- Items `{humano}` aguardando decisão do dono do produto (`[ ]`)
- `[Gap]` indica requisito ausente — ação: `/clarify` ou adicionar FR antes de `create-tasks`
- IDs CHK018–CHK032 neste arquivo
