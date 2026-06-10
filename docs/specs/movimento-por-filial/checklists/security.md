# Security Checklist: Movimento por Empresa/Filial

**Purpose**: Validar completude, clareza e consistência dos requisitos de segurança — autorização por escopo de grupo, prevenção de IDOR, proteção de dados e logging.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md) | [contracts/grupo-escopo-api.md](../contracts/grupo-escopo-api.md) | [contracts/movimento-api.md](../contracts/movimento-api.md)

---

## Autorização e Escopo de Grupo (IDOR / Princípio II)

- [x] CHK001 - O requisito de validação server-side do `empresa_id` está especificado para TODOS os endpoints que recebem esse parâmetro (GET, POST, DELETE, PATCH)? [Completude, Spec §FR-014] {auto}
  > **Evidência**: FR-014 exige validação de `empresa_id` contra escopo do grupo em toda requisição. O contract `movimento-api.md` lista os 7 endpoints (GET /envio-massa, GET /export-envio-massa, GET /download-xml-movimento, POST /upload, POST /close-movimento, DELETE /envio-massa/:id, PATCH /update-envio-massa/:id) — todos cobertos pelo helper `resolveEmpresaAlvo`.

- [x] CHK002 - A spec distingue claramente "empresa_id ausente → default empresa do token" de "empresa_id presente → validar contra escopo"? [Clareza, Spec §FR-015, Contract grupo-escopo-api.md] {auto}
  > **Evidência**: FR-015 especifica default = empresa do usuário quando `empresa_id` não é informado. O pseudocódigo do `resolveEmpresaAlvo` em `grupo-escopo-api.md` (`if (requestedId == null || requestedId === '') return user.empresaId`) documenta esse comportamento explicitamente.

- [x] CHK003 - O gap pré-existente no `PATCH /update-envio-massa/:id` (ausência de validação de ownership) está documentado e há requisito explícito para corrigi-lo? [Completude, Contract movimento-api.md §7, Spec §FR-013] {auto}
  > **Evidência**: `movement-api.md §7` documenta "gap de segurança pré-existente" e especifica a correção via filtro atômico (`EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}`). FR-013 exige que edição seja permitida apenas para empresas no escopo do grupo.

- [x] CHK004 - A spec especifica que o escopo do grupo é derivado EXCLUSIVAMENTE do token JWT, nunca do corpo/query da requisição? [Clareza, Spec §FR-014, Contract grupo-escopo-api.md §Invariantes] {auto}
  > **Evidência**: FR-014: "derivado exclusivamente do token JWT, nunca do corpo/query não autenticado". `grupo-escopo-api.md §Invariantes`: "INV-1: IDs vêm do token, nunca do body/query".

- [x] CHK005 - O requisito de resposta 403 especifica que a mensagem NÃO deve vazar dados da empresa-alvo? [Clareza, Contract movimento-api.md §Contrato dos 403] {auto}
  > **Evidência**: `movimento-api.md §Contrato dos 403`: "Sem stack trace, sem dados da empresa-alvo". Shape: `{ "error": "empresa fora do escopo" }`.

- [x] CHK006 - O edge case "filial na URL pertencente a grupo diferente do usuário logado" está especificado com comportamento de fallback definido? [Cobertura de Edge Cases, Spec §Edge Cases] {auto}
  > **Evidência**: Spec §Edge Cases: "Filial selecionada na URL que saiu do grupo: sistema ignora o parâmetro inválido e usa a empresa-pai como padrão (sem expor erro ao usuário)". Comportamento server-side correspondente: `resolveEmpresaAlvo` retorna 403 → front faz fallback para empresa-pai.

- [ ] CHK007 - O requisito de validação do `empresa_id` no `POST /upload` (multipart/form-data) especifica que o campo vem do FormData parseado pelo multer — e NÃO de um header ou query string? [Clareza, Contract movimento-api.md §4] {humano}
  > Risco: ambiguidade na fonte do `empresa_id` para upload multipart pode gerar implementação divergente. O contract define `req.body.empresa_id` (após multer), mas a spec textual (FR-008) não detalha o mecanismo de transporte para esse endpoint específico.

- [x] CHK008 - A spec define que a deleção de registro deve ser recusada (403/404) quando o registro pertence a empresa fora do escopo — sem revelar se o registro existe ou não para a empresa-alvo? [Clareza, Spec §FR-012, Contract movimento-api.md §6] {auto}
  > **Evidência**: FR-012 especifica recusa para empresa fora do escopo. Contract §6 (DELETE): filtro atômico `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}` — PostgREST retorna 0 linhas sem expor existência do registro em outra empresa.

---

## Autenticação e Sessão

- [x] CHK009 - Todos os endpoints novos (`GET /grupo/escopo` e os 7 endpoints de movimento threadados) têm requisito explícito de autenticação via token JWT? [Completude, Spec §FR-014, FR-016] {auto}
  > **Evidência**: FR-014 e FR-016 exigem autenticação. `grupo-escopo-api.md §GET /grupo/escopo §Request`: "Header: `Authorization: Bearer <token>`". A nota "acessível a qualquer usuário autenticado do grupo (pai OU filho) — SEM `requireGrupoPai`" especifica o middleware esperado.

- [x] CHK010 - O edge case "sessão expirada com filial na URL" tem comportamento definido? [Cobertura de Edge Cases, Spec §Edge Cases] {auto}
  > **Evidência**: Spec §Edge Cases: "ao renovar sessão e retornar à página, o parâmetro é mantido na URL mas revalidado contra o novo token". Comportamento de segurança correto especificado.

- [ ] CHK011 - A spec especifica comportamento de rate limiting ou throttling para o `GET /grupo/escopo` (endpoint chamado em cada carregamento de página)? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum dos artefatos (spec.md, plan.md, contracts) especifica rate limiting para `/grupo/escopo`. Para grupo com dezenas de filiais e múltiplos admins, este endpoint pode ser chamado frequentemente. A spec menciona "requisitos não-funcionais" apenas implicitamente via Constitution Check. Recomendação: definir se rate limiting é in-scope ou explicitamente excluído (FR-EX).

---

## Proteção de Dados e Information Disclosure

- [x] CHK012 - A spec especifica que o `GET /grupo/escopo` retorna APENAS o conjunto de empresas do grupo do usuário logado — nunca empresas de outros grupos? [Completude, Contract grupo-escopo-api.md §Regras de montagem] {auto}
  > **Evidência**: `grupo-escopo-api.md §Regras de montagem`: `escopo = resolveScope(req.user)` → `[empresaId, ...idsFilhos]` — escopo derivado inteiramente do token do usuário.

- [x] CHK013 - Os requisitos especificam que a listagem de movimento (`GET /envio-massa`) retorna apenas registros da empresa selecionada — não o conjunto total? [Completude, Spec §FR-007] {auto}
  > **Evidência**: FR-007: "listagem de registros de movimento DEVE mostrar apenas os registros da empresa/filial selecionada no combobox".

- [ ] CHK014 - Há requisito que especifique o que ocorre quando `resolveScope(user)` falha (ex: banco indisponível, token corrompido) — o sistema falha de forma segura (fail closed)? [Completude, Gap] {auto}
  > **[Gap]**: Nenhum artefato especifica o comportamento de erro do `resolveEmpresaAlvo` quando a consulta ao banco para montar o escopo falha. "Fail closed" (recusar a requisição) é o comportamento seguro, mas não está documentado como requisito. Deve ser explicitado em FR ou no contract.

- [x] CHK015 - A spec especifica que o `GET /download-xml-movimento` deve recusar download de XML de empresa fora do escopo? [Completude, Spec §FR-010] {auto}
  > **Evidência**: FR-010: "tentativas de baixar nota de outra empresa DEVEM ser recusadas". Contract §3 (GET /download-xml-movimento): threading + 403 se fora do escopo.

---

## Input Validation

- [x] CHK016 - A spec especifica o tipo esperado do `empresa_id` (inteiro positivo) e o comportamento para valores não-numéricos? [Clareza, Contract grupo-escopo-api.md §Pseudocódigo] {auto}
  > **Evidência**: `grupo-escopo-api.md §Pseudocódigo`: `parseInt(requestedId, 10)` + `if (!Number.isInteger(alvo))` → erro 403 `"empresa_id inválido"`. Tipo inteiro positivo especificado implicitamente pelo `parseInt`.

- [ ] CHK017 - A spec define limites de tamanho/formato para o campo `empresa_id` recebido via query/body (ex: string máxima para evitar overflow no parseInt)? [Clareza, Gap] {auto}
  > **[Gap]**: O contract especifica `parseInt` mas não define tamanho máximo da string de entrada. Uma string muito longa poderia causar comportamento inesperado antes do parse. Baixo risco dado que PostgREST também valida o tipo na camada de banco, mas ausente como requisito explícito.

- [x] CHK018 - A spec/contract define que o `empresa_id` recebido em POST /upload (campo multipart) passa pelo MESMO `resolveEmpresaAlvo` que os demais endpoints? [Consistência, Contract movimento-api.md §4] {auto}
  > **Evidência**: Contract §4 (POST /upload): "empresa_id via campo FormData (`req.body.empresa_id` após multer) → `resolveEmpresaAlvo`". Consistência com os demais endpoints documentada.

---

## Logging e Auditoria

- [ ] CHK019 - Há requisito especificando o que deve ser logado quando um 403 é emitido por `resolveEmpresaAlvo` (ex: user_id, empresa_id tentada, endpoint)? [Completude, Gap] {auto}
  > **[Gap]**: Spec e contracts não especificam logging de eventos de autorização negada. Para rastrear tentativas de acesso cross-empresa (potencial indicador de ataque), um requisito de log de auditoria nos 403 é recomendado. Ausente nos artefatos atuais.

- [ ] CHK020 - A spec define retenção ou proteção de logs que contenham `empresa_id` e dados de movimento (potencial dado sensível de negócio)? [Completude, Gap] {humano}
  > Decisão de negócio: a spec não aborda política de retenção de logs. Depende do apetite de risco e requisitos regulatórios do cliente (LGPD / dados fiscais).

---

## Retrocompatibilidade Segura

- [x] CHK021 - A spec especifica que usuários de empresa única (sem grupo) NÃO devem ser afetados pelas mudanças de threading — comportamento 100% retrocompatível? [Completude, Spec §FR-015, Edge Cases] {auto}
  > **Evidência**: FR-015: "mantendo 100% de compatibilidade retroativa com clientes que não enviam empresa_id". `resolveEmpresaAlvo` retorna `user.empresaId` quando `requestedId == null`.

- [x] CHK022 - Os 3 ramos hardcoded de `id_empresa` (ids 6, 16) identificados na pesquisa têm impacto documentado no contexto da feature — e decisão explícita sobre como tratar? [Consistência, Research §D0.5] {auto}
  > **Evidência**: Research §D0.5 documenta os 3 ramos hardcoded e a decisão: "substituir pela variável `idEmp` derivada do `resolveEmpresaAlvo`" — eliminando os hardcodes como parte da implementação.

---

## Notes

- Items `{auto}` estão resolvidos com citação de evidência ou marcados `[Gap]`
- Items `{humano}` aguardam decisão do dono do produto
- **Gaps identificados**: CHK011 (rate limiting), CHK014 (fail closed em erro de escopo), CHK017 (tamanho de input), CHK019 (logging de 403), CHK020 (retenção de log)
- CHK007 e CHK020 são `{humano}` — dependem de contexto de negócio/operacional
