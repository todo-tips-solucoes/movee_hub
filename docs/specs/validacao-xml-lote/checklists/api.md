# API Checklist: Validação de XML em Lote Idempotente

**Purpose**: Quality gate de requisitos para o contrato `POST /validate-xml-batch` — cobre completude de contrato, error handling, autenticação/autorização, idempotência, rate limiting e observabilidade.
**Created**: 2026-06-14
**Feature**: [spec.md](../spec.md) · [contracts/validate-xml-batch.md](../contracts/validate-xml-batch.md)

---

## Contratos e Schemas

- [x] CHK001 — O formato de request (multipart/form-data com campo `xmlFiles`) está definido para o endpoint? [Completude, Spec §FR-001, Contract §Request] {auto}
  > Evidência: `contracts/validate-xml-batch.md §Request` define `Content-Type: multipart/form-data`, campo `xmlFiles`, limite `upload.array('xmlFiles', 100)`.

- [x] CHK002 — O schema completo de response 200 (campos por linha + agregados em `stats`) está especificado com tipos e enums? [Completude, Contract §Response 200] {auto}
  > Evidência: contract define `ValidationRow` com `status` (6 valores enum), `match_criterio` (chave|fallback|none), `movimento_id` (int|null), `cnpj_prestador`, `numnota`, `erro_validacao`; e `BatchStats` com todos os 6 contadores.

- [x] CHK003 — O enum `status` cobre exaustivamente todos os estados possíveis do processamento por linha? [Completude, Contract §Enum status] {auto}
  > Evidência: 6 valores definidos — `ja_validada`, `validada`, `revalidada`, `duplicada_no_lote`, `sem_movimento`, `erro` — mapeando toda a árvore de decisão (FR-006 a FR-009 + FR-014/FR-015/FR-016). Conjunto fechado.

- [x] CHK004 — Está especificado que a mudança de contrato é aditiva (request inalterada, campos novos na response) e não quebra clientes existentes? [Consistência, Plan §Constitution Check, Contract] {auto}
  > Evidência: `plan.md §Constitution Check`: "Contrato de API (Princ. III): PASS — mudança aditiva na resposta; request inalterada; documentada em contracts/". `contracts/validate-xml-batch.md §Erros` confirma que o status HTTP nunca muda para erros por-linha.

- [x] CHK005 — O campo `match_criterio` está definido como distinguível entre casamento primário (chave de acesso) e fallback (CNPJ+número+data)? [Clareza, Contract §Enum match_criterio, Spec §FR-002/FR-003] {auto}
  > Evidência: enum `match_criterio` com valores `chave | fallback | none`; mapeados a FR-002 (casamento primário por chave de acesso 50 dígitos) e FR-003 (fallback CNPJ+numnota+data_emissao).

- [ ] CHK006 — Há especificação de versionamento de API (header, URL ou estratégia) para esta mudança de contrato? [Clareza] {humano}
  > A spec e o contrato documentam a mudança como aditiva e sem quebra, mas não especificam se o endpoint deve carregar versão explícita (ex: `/v2/validate-xml-batch`) nem a política de deprecação dos campos antigos (`valid`, `valid_cnpj_prestador`, `valid_valor`). Decisão de produto sobre estratégia de versionamento.

---

## Error Handling

- [x] CHK007 — Está especificado que erros por linha (parse, casamento, serviço externo) nunca elevam o status HTTP para além de 200? [Completude, Contract §Erros, Spec §FR-015] {auto}
  > Evidência: `contracts/validate-xml-batch.md §Erros`: "Erros por linha (parse, casamento, FastAPI) ficam em `results[].status=erro` + `erro_validacao`, não em status HTTP. O HTTP só falha em auth/escopo." FR-015 confirma que falha em uma linha não interrompe o processamento.

- [x] CHK008 — A distinção entre erro de negócio (4xx FastAPI com `detail`) e erro de infraestrutura (timeout/5xx) está especificada com comportamentos distintos? [Clareza, Spec §FR-014, Research §Decision 6] {auto}
  > Evidência: FR-014: "4xx com mensagem de negócio → propagar a mensagem real; erros de infra (timeout, 5xx, sem resposta) → mensagem genérica 'serviço de validação indisponível'". Research §Decision 6 ratifica a distinção. Cenário 7 do quickstart cobre o caso de infra down.

- [x] CHK009 — Está especificado que XML malformado ou com campos obrigatórios ausentes resulta em `status=erro` por linha sem abortar o lote? [Cobertura de Edge Cases, Spec §FR-016, US1 edge cases] {auto}
  > Evidência: FR-016: "XMLs com campos obrigatórios ausentes ou malformados são reportados como erro de parsing — o sistema tenta extrair campos disponíveis graciosamente antes de desistir." US1 edge case: "XML malformado ou sem campos obrigatórios — reportado como erro de parsing na linha, os demais XMLs continuam."

- [x] CHK010 — Está especificado que movimento existente mas fechado (`mov_fechado=true`) é tratado como `sem_movimento` (sem criação de registro)? [Cobertura de Edge Cases, Spec §FR-004, US1 edge cases] {auto}
  > Evidência: FR-004: "Apenas movimentos com status aberto são elegíveis para casamento; movimentos fechados são ignorados como se não existissem." US1 edge case confirma resultado `sem_movimento`.

- [x] CHK011 — Está especificado que erros de escopo/tenant (empresa fora do escopo do token) resultam em HTTP 403/503, não em linhas `erro`? [Completude, Contract §Erros] {auto}
  > Evidência: `contracts/validate-xml-batch.md §Erros`: 403 para empresa fora do escopo do usuário (via `resolveEmpresaAlvo`), 503 para escopo indisponível. Esses são erros globais do handler, não por-linha.

---

## Autenticação e Autorização

- [x] CHK012 — Está especificado que o endpoint exige JWT válido (401 sem token) e que o escopo da operação é sempre a empresa resolvida pelo token do usuário? [Completude, Spec §US4, Contract §Erros, Plan §Constitution Check Princ. I/II] {auto}
  > Evidência: Contract §Erros: "401 — sem JWT válido (middleware)". Plan §Constitution Check: "Princípio I (Segurança de Autenticação): PASS — handler preserva `authenticateToken`". Spec §Q3 (clarify): "casamento opera sempre sobre `empresaId` exata extraída do token autenticado".

- [x] CHK013 — Está especificado que o casamento XML↔movimento opera exclusivamente sobre a empresa-alvo do token, nunca expandindo para outras empresas do grupo? [Completude, Spec §FR-002, Clarify §Q3, Spec §US4] {auto}
  > Evidência: Clarify §Q3: "casamento opera sempre sobre a `empresaId` exata extraída do token autenticado — nunca expande para outras empresas do grupo. `mesmoGrupoQue` afeta apenas o roteamento para a FastAPI correta (FR-013), nunca o escopo de busca de movimentos."

- [x] CHK014 — Está especificado o critério de roteamento para serviço de validação externo (grupo Movee vs. nexus), incluindo a regra de grupo (`mesmoGrupoQue(_, 6)`)? [Completude, Spec §FR-013, Clarify §Q3] {auto}
  > Evidência: FR-013 define a regra de roteamento. Clarify §Q3 reforça que `mesmoGrupoQue` afeta SÓ roteamento FastAPI. US4 cenários 4c/4d cobrem os dois caminhos de roteamento.

- [x] CHK015 — O `FASTAPI_VALIDATION_TOKEN` (segredo usado para autenticar na FastAPI) está especificado como variável de ambiente, sem exposição em logs ou resposta? [Completude, Plan §Constitution Check Princ. I] {auto}
  > Evidência: Plan §Constitution Check Princ. I: "`FASTAPI_VALIDATION_TOKEN` consumido de env como hoje; nenhum segredo logado/exposto." Sem mudança na forma de consumo do segredo.

---

## Idempotência

- [x] CHK016 — A condição exata de "nota aprovada" (que torna a operação no-op) está definida de forma não-ambígua? [Clareza, Spec §FR-006, Clarify §Q2] {auto}
  > Evidência: Clarify §Q2: "nota aprovada = `nota_ok` não-vazio E `erro_validacao` vazio/nulo. Esta é exatamente a lógica de `getNFeKeyFromNotaOk`. Não depende de valor específico na string de `nota_ok`." FR-006 confirma: "resultado de aprovação já presente e sem erro de validação → status `ja_validada`; nenhum dado é gravado ou alterado."

- [x] CHK017 — Está especificado que reenvio do mesmo lote produz o mesmo conjunto de status sem novos efeitos colaterais (INV-1)? [Completude, Spec §FR-011, Contract §Invariantes INV-1, SC-003] {auto}
  > Evidência: FR-011: "Reenviar o mesmo lote de XMLs produz o mesmo conjunto de status que o envio anterior". INV-1: "reenviar o mesmo lote produz o mesmo `stats` e nenhuma escrita nova para linhas `ja_validada`". SC-003: "O mesmo lote enviado duas vezes produz resultados idênticos na segunda execução."

- [x] CHK018 — Está especificado que a persistência usa o `id` interno do movimento como chave (nunca cria duplicatas na tabela)? [Completude, Spec §FR-012, Research §Decision 3, Contract §INV-1/INV-2] {auto}
  > Evidência: FR-012: "A operação de persistência usa o identificador interno do movimento como chave; nunca cria registros duplicados." Research §Decision 3: "`PATCH EnvioMassa?id=eq.<id>` grava apenas `nota_ok` e `erro_validacao`."

- [x] CHK019 — Está especificado que o mesmo XML aparecendo duas vezes no mesmo lote resulta em exatamente 1 chamada ao serviço externo? [Cobertura de Edge Cases, Spec §FR-009, SC-004] {auto}
  > Evidência: FR-009: "Mesmo XML (mesma chave de acesso) aparece mais de uma vez no lote → valida uma única vez; as demais ocorrências recebem status `duplicada_no_lote` sem nova chamada ao serviço externo." SC-004 quantifica: "1 chamada ao serviço externo". Cenário 4 do quickstart cobre este caso.

- [x] CHK020 — Está especificado que o valor financeiro do movimento (`valor`) é invariante — nunca alterado pela validação em lote? [Completude, Spec §FR-010, Contract §INV-4, Data Model] {auto}
  > Evidência: FR-010: "o valor financeiro do movimento nunca é alterado pela validação em lote." INV-4: "`valor` do movimento é idêntico antes/depois do lote." Data model: "valor — NUNCA alterado por esta feature (P5)." Research §Decision 3: "`PATCH` grava apenas `nota_ok` e `erro_validacao`."

---

## Rate Limiting

- [x] CHK021 — Está especificado o comportamento do rate-limit entre chamadas à FastAPI (delay condicional à chamada real)? [Completude, Research §Decision 5] {auto}
  > Evidência: Research §Decision 5: "O delay de 2s entre arquivos (hoje em server.js:1993-1995, incondicional) passa a ocorrer apenas quando houve chamada real à FastAPI (status `validada`/`revalidada`). Linhas `ja_validada`/`duplicada_no_lote`/`sem_movimento`/`erro-de-parsing` não esperam."

- [ ] CHK022 — Há limite máximo definido para o número de XMLs por lote e tamanho máximo por arquivo? [Clareza] {humano}
  > A spec e o contrato mencionam `upload.array('xmlFiles', 100)` como limite de quantidade, mas não especificam tamanho máximo por arquivo XML nem o que acontece se o limite de 100 for excedido (erro 400? silencioso?). Gap de requisito que pode gerar comportamento inesperado em produção.

- [ ] CHK023 — Está especificado o comportamento quando o serviço externo está temporariamente indisponível para todo o lote (não apenas para uma linha)? [Cobertura de Edge Cases, Spec §FR-014/FR-015] {humano}
  > FR-014/FR-015 especificam o comportamento por-linha quando a FastAPI está indisponível para aquela linha. Mas não está especificado se existe timeout global para o processamento do lote inteiro, nem o que acontece se 100% das chamadas falharem por infra (o lote retorna 200 com 100% `erro`? ou há algum fallback global?). Decisão de produto.

---

## Observabilidade

- [ ] CHK024 — Estão especificados quais eventos da operação de validação em lote devem ser logados (PATCH bem-sucedido, chamada à FastAPI, erro de parsing)? [Completude] {humano}
  > A spec e o plano não especificam requisitos de logging estruturado para o handler. O plan §Constitution Check menciona que nenhum segredo é logado, mas não define quais eventos de negócio (PATCH, chamada FastAPI, dedup) devem aparecer nos logs. Decisão de produto/ops.

- [x] CHK025 — Os agregados de resultado (`stats`) na response cobrem todos os status enum, permitindo observabilidade da distribuição do lote sem parsing linha-a-linha? [Completude, Contract §Response 200, Data Model §BatchStats] {auto}
  > Evidência: `BatchStats` no data model e Contract §Response define contadores para todos os 6 status: `ja_validada`, `validada`, `revalidada`, `duplicada_no_lote`, `sem_movimento`, `erro`, além de `total`. SC-001 e SC-002 dependem diretamente desses agregados para verificação.

---

## Notes

- Items `{auto}` resolvidos com citação de evidência nos artefatos (`[x]`).
- Items `{humano}` aguardam decisão do dono do produto (`[ ]`).
- `[Gap]` indica requisito ausente que deve virar tarefa em `/create-tasks`.
- Marcar itens concluídos com `[x]`.
