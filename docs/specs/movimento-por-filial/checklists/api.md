# API Checklist: Movimento por Empresa/Filial

**Purpose**: Validar completude, clareza e consistência dos contratos de API — endpoints, error handling, autenticação, retrocompatibilidade e cobertura de cenários de borda.
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md) | [contracts/grupo-escopo-api.md](../contracts/grupo-escopo-api.md) | [contracts/movimento-api.md](../contracts/movimento-api.md)

---

## Contratos e Schemas

- [x] CHK001 - Todos os 7 endpoints de movimento threadados têm contrato documentado com: método HTTP, path, fonte do `empresa_id`, comportamento antes e depois? [Completude, Contract movimento-api.md] {auto}
  > **Evidência**: `movimento-api.md` cobre os 7 endpoints (§1–§7) com método, path, fonte (`req.query` vs `req.body`), comportamento atual e comportamento após a feature, incluindo o gap do PATCH.

- [x] CHK002 - O shape do response 200 do `GET /grupo/escopo` está especificado — campos `empresas[]`, `default`, tipos e ordenação? [Clareza, Contract grupo-escopo-api.md §Response 200] {auto}
  > **Evidência**: `grupo-escopo-api.md §Response 200`: `{ empresas: [{ id: number, nome_empresa: string }], default: number }`. Ordenação: empresa-pai primeiro. Tipo dos campos definidos.

- [x] CHK003 - O shape do response 200 do `GET /envio-massa` está especificado (ou referenciado) para o contexto threadado? [Clareza, Contract movimento-api.md §1] {auto}
  > **Evidência**: Contract §1 especifica o filtro PostgREST (`EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false`) e que o response é "array de registros da filial N (movimento aberto)". O shape detalhado dos registros não é redefinido (compatível com o existente).

- [ ] CHK004 - O response de erro 401 (token ausente/inválido) está especificado para o `GET /grupo/escopo` e tem shape documentado? [Completude, Contract grupo-escopo-api.md §Response 401] {auto}
  > **Evidência parcial**: `grupo-escopo-api.md` menciona "Response 401" mas o shape `{ "error": "..." }` não é explicitado para 401 — apenas para 403. Inconsistência menor. Marcar `[Ambiguity]`: o shape do 401 deveria ser definido explicitamente ou referenciado ao padrão existente no projeto.
  > **[Ambiguity]**

- [x] CHK005 - O shape do 403 é uniforme para todos os endpoints (origem única: `resolveEmpresaAlvo`) e está documentado em ponto único? [Consistência, Contract movimento-api.md §Contrato dos 403] {auto}
  > **Evidência**: `movimento-api.md §Contrato dos 403`: shape `{ "error": "empresa fora do escopo" }` (ou `"empresa_id inválido"` para não-numérico), status 403, sem stack trace — definido em ponto único referenciado por todos os endpoints.

- [ ] CHK006 - O response de sucesso do `POST /upload` inclui especificação do que é retornado quando o `empresa_id` válido resulta em registros vinculados à filial correta? [Clareza, Contract movimento-api.md §4] {auto}
  > **[Gap]**: Contract §4 especifica a validação e o threading do `empresa_id` no upload, mas não define o shape do response 200/201 de sucesso — apenas indica que `validateXmlBatch`/`processBatchMessages` existem. O shape de retorno (ex: quantidade de registros criados, IDs) não está documentado.

---

## Error Handling

- [x] CHK007 - O requisito para o caso "empresa_id fora do escopo" especifica o código HTTP 403 (não 404) para não revelar a existência da empresa-alvo? [Clareza, Contract movimento-api.md §Contrato dos 403] {auto}
  > **Evidência**: `movimento-api.md §Contrato dos 403`: status 403 em todos os casos de escopo violado. Semanticamente correto (403 = proibido, não 404 = não encontrado) e documentado.

- [x] CHK008 - O comportamento do DELETE quando o registro não existe (id inválido, já deletado) está distinguido do caso "registro existe mas pertence a outra empresa"? [Clareza, Contract movimento-api.md §6] {auto}
  > **Evidência**: Contract §6 (DELETE): filtro atômico `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}` — PostgREST retorna 0 rows em ambos os casos (id inválido OU empresa errada). O contrato documenta que o comportamento é uniforme (sem discriminar as duas causas) — escolha deliberada de não vazar informação.

- [ ] CHK009 - A spec define o comportamento quando `POST /close-movimento` é chamado e não há registros abertos para a empresa-alvo? [Cobertura de Edge Cases, Gap] {auto}
  > **[Gap]**: FR-011 especifica que o fechamento incide sobre "registros abertos da empresa/filial selecionada", mas não define o comportamento quando não há registros abertos (0 linhas afetadas) — deve retornar 200 com `{ fechados: 0 }`, 204 ou 400?

- [x] CHK010 - A spec/contract especifica que o `DELETE /envio-massa/:id` e o `PATCH /update-envio-massa/:id` recebem `empresa_id` — distinguindo-os da assinatura atual (que não recebe)? [Completude, Contract movimento-api.md §6, §7] {auto}
  > **Evidência**: Contract §6 (DELETE): `req.query.empresa_id` (adicionado). Contract §7 (PATCH): `req.body.empresa_id` (adicionado). Mudança de interface documentada explicitamente.

---

## Autenticação e Autorização na API

- [x] CHK011 - O `GET /grupo/escopo` está especificado como SEM o middleware `requireGrupoPai` — acessível a filhos também? [Clareza, Contract grupo-escopo-api.md §Endpoint GET /grupo/escopo] {auto}
  > **Evidência**: `grupo-escopo-api.md`: "Acessível a qualquer usuário autenticado do grupo (pai OU filho) — SEM `requireGrupoPai`". Distinção em relação ao `/grupo/filhos` (pai-only) documentada.

- [x] CHK012 - A spec especifica que o escopo retornado pelo `GET /grupo/escopo` é o escopo REAL do usuário (não o escopo do grupo pai) quando o usuário é uma filial? [Clareza, Contract grupo-escopo-api.md §Regras de montagem] {auto}
  > **Evidência**: `grupo-escopo-api.md §Regras de montagem`: `escopo = resolveScope(req.user)` → inclui `empresaId` do usuário + filhos. Para uma filial sem sub-filiais, escopo = `[empresaId]` → 1 item → combobox oculto. Comportamento correto especificado.

---

## Retrocompatibilidade

- [x] CHK013 - A spec especifica que clientes existentes que NÃO enviam `empresa_id` continuam funcionando sem alteração de comportamento? [Completude, Spec §FR-015] {auto}
  > **Evidência**: FR-015: "mantendo 100% de compatibilidade retroativa". `resolveEmpresaAlvo` retorna `user.empresaId` quando `requestedId` é nulo/ausente — sem breaking change.

- [x] CHK014 - Os endpoints marcados como "Fora do MVP (FR-EX-001)" têm sua exclusão documentada explicitamente no contrato? [Completude, Contract movimento-api.md §Fora do MVP] {auto}
  > **Evidência**: `movimento-api.md §Fora do MVP (FR-EX-001)`: lista explícita dos endpoints não threadados (ex: `processBatchMessages`, loops de envio) com justificativa. Exclusão auditável.

- [ ] CHK015 - O `GET /export-envio-massa` tem especificado que, embora threadado, o hook do dashboard não o chama — e há requisito de teste de que o endpoint funciona corretamente mesmo sem ser o caminho principal? [Clareza, Research §D0.6] {humano}
  > Research §D0.6 documenta que `exportCSV` (client-side) é o caminho real e `/export-envio-massa` é threadado "por consistência". A spec não define critérios de aceite específicos para este endpoint — decisão de cobertura de teste a cargo do dono do produto.

---

## Idempotência e Consistência

- [x] CHK016 - O `POST /close-movimento` tem requisito de comportamento idempotente (chamar duas vezes não duplica fechamento)? [Consistência, Spec §FR-011, Contract movimento-api.md §5] {auto}
  > **Evidência**: Contract §5: `PATCH EnvioMassa?id_empresa=eq.${idEmp}&mov_fechado=eq.false` com `{ mov_fechado: true }` — o filtro `mov_fechado=eq.false` garante que uma segunda chamada não afeta registros já fechados. Idempotência garantida pelo design do filtro.

- [ ] CHK017 - A spec define o que acontece quando o `POST /upload` recebe múltiplos XMLs e um deles falha na validação — o comportamento é atomico (tudo ou nada) ou partial commit? [Clareza, Gap] {humano}
  > FR-008 especifica que upload vincula registros à filial selecionada, mas não define atomicidade de batch com falha parcial. Decisão de comportamento (rollback vs partial success) é de negócio.

---

## Observabilidade

- [ ] CHK018 - A spec define métricas ou indicadores de saúde para os endpoints novos (ex: latência do `GET /grupo/escopo`, taxa de 403)? [Completude, Gap] {humano}
  > Nenhum artefato define requisitos de observabilidade (métricas, alertas) para os endpoints desta feature. Decisão de operações/negócio.

---

## Notes

- Items `{auto}` estão resolvidos com citação de evidência ou marcados `[Gap]`/`[Ambiguity]`
- Items `{humano}` aguardam decisão do dono do produto
- **Gaps**: CHK006 (response success do upload), CHK009 (close-movimento sem registros abertos)
- **Ambiguidade**: CHK004 (shape do 401 para `/grupo/escopo`)
- **Humano**: CHK015 (cobertura de teste do export), CHK017 (atomicidade do upload), CHK018 (observabilidade)
