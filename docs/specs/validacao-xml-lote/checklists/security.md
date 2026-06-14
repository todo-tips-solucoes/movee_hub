# Security Checklist: Validação de XML em Lote Idempotente

**Purpose**: Quality gate de segurança dos requisitos — autenticação/autorização multi-tenant, proteção de dados, validação de input XML, isolamento de tenants e não-vazamento entre empresas.
**Created**: 2026-06-14
**Feature**: [spec.md](../spec.md) · [contracts/validate-xml-batch.md](../contracts/validate-xml-batch.md)

---

## Autenticação

- [x] CHK101 — Está especificado que o endpoint exige JWT válido e retorna 401 sem token? [Completude, Contract §Erros, Plan §Constitution Check Princ. I] {auto}
  > Evidência: Contract §Erros: "401 — sem JWT válido (middleware)." Plan §Constitution Check Princ. I: "PASS — handler preserva `authenticateToken`." Nenhuma mudança no middleware de autenticação.

- [x] CHK102 — Está especificado que o segredo de autenticação para a FastAPI externa (`FASTAPI_VALIDATION_TOKEN`) é consumido exclusivamente de variável de ambiente, sem exposição em logs, response ou código-fonte? [Completude, Plan §Constitution Check Princ. I] {auto}
  > Evidência: Plan §Constitution Check Princ. I: "`FASTAPI_VALIDATION_TOKEN` consumido de env como hoje; nenhum segredo logado/exposto." Sem mudança na forma de consumo do segredo.

---

## Autorização e Isolamento Multi-Tenant

- [x] CHK103 — Está especificado que o casamento XML↔movimento é sempre escopado pela `empresaId` exata do token JWT, nunca cruzando para outra empresa? [Completude, Spec §FR-002/FR-013, Clarify §Q3, Spec §US4] {auto}
  > Evidência: Clarify §Q3: "o casamento opera sempre sobre a `empresaId` exata extraída do token autenticado — nunca expande para outras empresas do grupo." Plan §Constitution Check Princ. II: "todo casamento/PATCH dentro de `id_empresa` via `resolveEmpresaAlvo`; índices construídos só sobre movimentos da empresa-alvo."

- [x] CHK104 — Está especificado que um XML correspondente a movimento de outra empresa resulta em `sem_movimento` (não em 403 nem em acesso ao dado da outra empresa)? [Completude, Spec §US4 cenário 4b, SC-007] {auto}
  > Evidência: US4 cenário 4b: "XML corresponde a movimento de empresa B → Não casado — status `sem_movimento` para empresa A." SC-007: "Dados de uma empresa nunca aparecem no resultado de outra — 0 vazamentos entre tenants verificados em cenários de teste com duas empresas distintas."

- [x] CHK105 — Está especificado que o resultado da operação (response) nunca expõe `movimento_id` ou dados de uma empresa diferente da empresa-alvo do token? [Completude, Contract §INV-3, SC-007] {auto}
  > Evidência: INV-3: "`movimento_id` retornado sempre pertence à empresa-alvo; XML de outra empresa → `sem_movimento`." SC-007 define critério de verificação de não-vazamento entre tenants.

- [x] CHK106 — O requisito de escopo por filial está especificado: o `resolveEmpresaAlvo` resolve tanto matriz quanto filial de forma que a filial não acessa dados da matriz e vice-versa? [Completude, Spec §US4, Plan §Constitution Check Princ. II] {auto}
  > Evidência: Plan §Constitution Check Princ. II: "todo casamento/PATCH dentro de `id_empresa` resolvido por `resolveEmpresaAlvo` (lança 403/503)." US4 cenário 4a/4b define o comportamento de isolamento. A regra é escopo exato — não grupo-expandido — confirmada por Clarify §Q3.

---

## Proteção de Dados

- [x] CHK107 — Está especificado que o PATCH grava apenas os campos de resultado (`nota_ok`, `erro_validacao`) e nunca altera dados financeiros ou de identidade do movimento? [Completude, Spec §FR-010, Contract §INV-4, Research §Decision 3] {auto}
  > Evidência: FR-010: "o valor financeiro do movimento nunca é alterado pela validação em lote." INV-4: "`valor` do movimento é idêntico antes/depois do lote." Research §Decision 3: "`PATCH` grava apenas `nota_ok` e `erro_validacao`. Nunca altera o valor financeiro (P5)."

- [x] CHK108 — Está especificado que a nota já aprovada não é sobrescrita em nenhum cenário (INV-2)? [Completude, Spec §FR-006, Contract §INV-2] {auto}
  > Evidência: FR-006: "Movimento casado com resultado de aprovação já presente e sem erro de validação → status `ja_validada`; nenhum dado é gravado ou alterado." INV-2: "nenhum `PATCH` ocorre para movimento APROVADO."

- [ ] CHK109 — Estão especificados os requisitos de retenção e proteção dos XMLs enviados durante o processamento (os arquivos são descartados após o processamento ou persistidos no servidor)? [Gap] {humano}
  > A spec não especifica o ciclo de vida dos arquivos XML após o upload. O handler processa os arquivos em memória? São gravados em disco temporariamente? São descartados após o processamento? Se persistidos, há risco de acumulação de dados fiscais sensíveis sem controle de retenção. Decisão de produto/ops.

---

## Validação de Input

- [x] CHK110 — Está especificado que o parsing de XML usa configuração segura (sem resolução de entidades externas / XXE)? [Completude, Plan §Constitution Check Princ. IV, OWASP gate onda-003] {auto}
  > Evidência: Plan §Constitution Check Princ. IV: "validação de entrada de XML mantida/reforçada (parsing defensivo, FR-016)." Research §Phase 0 e gate OWASP (dec-018 onda-003) confirmaram que `xml2js {explicitArray:false, stripPrefix}` sem `resolveEntities` é padrão seguro existente (dec-019, score 3, grep server.js:1929-1931).

- [x] CHK111 — Está especificado que XML malformado resulta em erro de parsing por linha (gracioso), sem abortar o lote nem expor stack trace ao cliente? [Completude, Spec §FR-016, US1 edge cases] {auto}
  > Evidência: FR-016: "o sistema tenta extrair campos disponíveis graciosamente antes de desistir." US1 edge case: "XML malformado — reportado como erro de parsing na linha, os demais XMLs continuam." O resultado da linha é `status=erro` com `erro_validacao` descritivo — sem exposição de stack trace na spec.

- [x] CHK112 — Está especificado que a chave de acesso (50 dígitos) e o CNPJ do prestador são os identificadores usados para casamento, sem expansão de escopo por outros campos não validados? [Clareza, Spec §FR-001/FR-002/FR-003, Research §Decision 1] {auto}
  > Evidência: FR-001 define campos extraídos (chave de acesso, número da nota, CNPJ, data de emissão). FR-002 define casamento primário por chave. FR-003 define fallback por CNPJ+numnota+data. Research §Decision 1 detalha a extração. Nenhum outro campo é usado como critério de casamento.

- [ ] CHK113 — Está especificado o comportamento quando o payload de upload excede o limite de tamanho (ex: 100 arquivos XMLs muito grandes) — o servidor rejeita antes do processamento? [Gap] {humano}
  > O contrato define `upload.array('xmlFiles', 100)` mas não especifica tamanho máximo por arquivo nem o que acontece com rejeição de tamanho. Sem esse requisito, um upload de 100 XMLs muito grandes pode causar OOM no servidor Node.js. Decisão técnica/produto sobre limite de tamanho.

---

## Logging e Auditoria

- [x] CHK114 — Está especificado que erros de infraestrutura (timeout/5xx FastAPI) resultam em mensagem genérica (sem vazamento de detalhes internos do serviço externo para o cliente)? [Completude, Spec §FR-014, Research §Decision 6] {auto}
  > Evidência: FR-014: "Erros de infraestrutura (timeout, 5xx, sem resposta) resultam em mensagem genérica 'serviço de validação indisponível'." Research §Decision 6: "não grava resultado de negócio falso." A mensagem genérica previne vazamento de detalhes de topologia interna.

- [ ] CHK115 — Estão especificados os requisitos de auditoria para operações de PATCH na tabela `EnvioMassa` (quem, quando, qual XML originou a gravação)? [Gap] {humano}
  > A spec especifica O QUE é gravado (`nota_ok`, `erro_validacao`), mas não especifica rastreabilidade da gravação: qual usuário (id do token) e qual arquivo XML originaram cada PATCH. Sem isso, em caso de dado incorretamente gravado, não há como auditar a causa. Decisão de produto sobre requisito de auditoria.

---

## Threat Modeling

- [x] CHK116 — O requisito de roteamento de grupo Movee vs. nexus está especificado de forma que uma empresa não-Movee nunca acessa o endpoint exclusivo do grupo Movee? [Completude, Spec §FR-013, Clarify §Q3, CLAUDE.md] {auto}
  > Evidência: FR-013: "Empresas pertencentes ao grupo Movee (conforme regra de grupo vigente no sistema) usam o endpoint de validação exclusivo do grupo; demais empresas usam o endpoint padrão (nexus)." Clarify §Q3 e CLAUDE.md confirmam que `mesmoGrupoQue(_, 6)` é o critério — não `id_empresa === 6` estrito.

- [x] CHK117 — Está especificado que a operação nunca cria registros novos na base (`EnvioMassa`) para XMLs sem movimento correspondente? [Completude, Spec §FR-005, Research §Decision 3] {auto}
  > Evidência: FR-005: "XML cujo casamento falha em ambas as estratégias resulta em status `sem_movimento` — nenhum registro novo é criado." Research §Decision 3 confirma que "inserir registro novo no `sem_movimento`" foi rejeitado (P3 — poluiria a base).

---

## Notes

- Items `{auto}` resolvidos com citação de evidência nos artefatos (`[x]`).
- Items `{humano}` aguardam decisão do dono do produto (`[ ]`).
- `[Gap]` indica requisito ausente que deve virar tarefa em `/create-tasks`.
- CHK109, CHK113, CHK115 são gaps de requisito identificados por este gate.
