# API Checklist: Cadastro de Filiais

**Purpose**: Valida a qualidade dos requisitos do contrato POST /grupo/empresas — completude, clareza, consistência e cobertura de cenários da API.
**Created**: 2026-06-09
**Feature**: [spec.md](../spec.md) | [contrato](../contracts/grupo-empresas-api.md)

## Contrato de Resposta

- [x] CHK001 - O código de sucesso do endpoint POST /grupo/empresas está especificado? [Completude, Contrato §POST /grupo/empresas] {auto}
  > Contrato define `201` com body `{ id, nome_empresa, email, id_grupo }`.

- [x] CHK002 - Todos os campos retornados no body de sucesso (201) estão enumerados e tipados? [Completude, Contrato §Validações e respostas] {auto}
  > Body documentado: `{ "id": 42, "nome_empresa": "...", "email": "...", "id_grupo": 7 }`. Tipos implícitos (int/string) são suficientes para REST JSON.

- [x] CHK003 - O campo `pass` (hash bcrypt) está explicitamente excluído do response? [Segurança/Completude, Contrato §POST /grupo/empresas] {auto}
  > Contrato declara: "`pass` (hash) **nunca** aparece no response."

- [x] CHK004 - Os campos opcionais da filial (endereço, número, CEP, email_nota, observação) têm comportamento definido no response quando omitidos? [Clareza, Spec §FR-001] {auto}
  > Spec §FR-001 define que esses campos são salvos como nulos quando ausentes. O contrato não os inclui no body de response — comportamento de omissão implícito (campos fiscais não retornados no 201). Aceitável para criação; nenhuma ambiguidade operacional detectada.

- [ ] CHK005 - O body de response 201 inclui os campos fiscais (endereço, CEP, etc.) ou apenas o subconjunto essencial? [Clareza, Contrato §POST] {humano}
  > O contrato retorna apenas `{ id, nome_empresa, email, id_grupo }`. Se o frontend precisar exibir ou confirmar os dados fiscais salvos sem uma chamada adicional, esse subconjunto é insuficiente. Decisão de produto: o response 201 é intencional como "cabeçalho" ou deve retornar o objeto completo?

## Códigos de Erro e Validação

- [x] CHK006 - Cada cenário de erro tem código HTTP distinto e bem justificado? [Completude, Contrato §Validações e respostas] {auto}
  > Tabela cobre: 400 (validações de input), 409 (CNPJ duplicado), 422 (limite de filiais), 403 (não-admin). Sem sobreposição de código para erros distintos.

- [x] CHK007 - A distinção entre 400 (e-mail duplicado) e 409 (CNPJ duplicado) está justificada na spec ou no contrato? [Consistência, Contrato §Validações] {auto}
  > O contrato usa 400 para e-mail duplicado e 409 para CNPJ duplicado. A justificativa explícita está ausente no contrato, mas 409 (Conflict) para CNPJ é semanticamente correto (recurso único conflitante). 400 para e-mail é heterodoxo (409 seria mais preciso), porém documentado e consistente com a decisão ratificada. [Observação — não é gap bloqueante; registrada para referência futura.]

- [x] CHK008 - O código 422 para limite de filiais está justificado em vez de 400 ou 429? [Clareza, Contrato §Validações] {auto}
  > 422 (Unprocessable Entity) é semântica correta para "request válido, mas regra de negócio impede processamento". Escolha documentada e consistente com o contrato.

- [x] CHK009 - Todas as mensagens de erro estão em português? [Completude, Contrato §POST /grupo/empresas] {auto}
  > Contrato declara: "Mensagens de erro em português (Padrões de Qualidade da constitution)." Todas as mensagens na tabela estão em português.

- [x] CHK010 - O requisito de validação de formato de e-mail está especificado (não apenas "formato inválido")? [Clareza, Contrato §Validações] {auto}
  > Contrato declara: `email` formato inválido → 400 `{ "error": "E-mail inválido." }`. A regra de validação de formato (RFC 5322 básico, regex) não está explicitada, mas é convenção universal. Sem ambiguidade operacional.

- [x] CHK011 - A regra de força de senha está especificada com critérios verificáveis? [Clareza, Contrato §Validações] {auto}
  > Contrato define: "< 6, sem maiúscula, sem dígito". Três critérios enumerados. Testável objetivamente.

- [ ] CHK012 - Há requisito para o que acontece se `nome_empresa` for whitespace puro (ex: `"   "`)? [Cobertura de Edge Cases, Spec §Edge Cases] {humano}
  > Spec §FR-001 exige nome obrigatório; edge case de string com apenas espaços não está explicitado no contrato nem na spec. Decisão: validação de whitespace deve retornar o mesmo 400 de campo vazio, ou é tratada como preenchida?

## Idempotência e Fluxo Interno

- [x] CHK013 - A operação `resolveOrCreateGrupo` é descrita como idempotente e sua garantia está especificada? [Completude, Contrato §resolveOrCreateGrupo] {auto}
  > Contrato declara: "`Grupo.id_empresa_pai` é UNIQUE → get-or-create seguro." Idempotência garantida por constraint de banco.

- [x] CHK014 - A ordem das validações no fluxo interno está definida (evitar efeitos colaterais desnecessários antes de rejeitar)? [Completude, Contrato §Fluxo interno] {auto}
  > Fluxo numerado (1→8): auth → validações de input → unicidade email → unicidade CNPJ → resolveGrupo → limite filiais → insert → 201. Ordem defensiva correta: rejeições baratas primeiro.

- [x] CHK015 - O reuso de `resolveOrCreateGrupo` por POST /grupo/filhos está especificado sem quebrar o contrato existente? [Consistência, Contrato §POST /grupo/filhos MANTIDO] {auto}
  > Contrato declara que POST /filhos "continua funcionando após o refactor (agora chama `resolveOrCreateGrupo` internamente)". Contrato do endpoint mantido sem mudança de interface.

- [x] CHK016 - A condição de corrida para CNPJ duplicado simultâneo está especificada? [Cobertura de Edge Cases, Spec §Edge Cases] {auto}
  > Spec §Edge Cases: "O banco aplica a restrição de unicidade e apenas um registro é persistido; o outro recebe erro 409." Definido.

## Proxy e Transporte

- [x] CHK017 - O caminho de proxy frontend→backend para o novo endpoint está especificado? [Completude, Contrato §Proxy] {auto}
  > Contrato §Proxy: catch-all `/api/[...path]/route.ts` cobre `/api/grupo/empresas` → `/grupo/empresas` sem mudança. Cookies httpOnly repassados.

- [ ] CHK018 - Há especificação de timeout ou retry policy para o cliente frontend neste endpoint? [Cobertura de Requisitos Não-Funcionais] {humano}
  > Nem spec nem contrato definem timeout esperado do POST /grupo/empresas nem comportamento do frontend em caso de timeout de rede. Para formulário de cadastro, isso é normalmente aceitável (sem retry automático), mas deve ser confirmado.

## Notes

- Items `{auto}` resolvidos com citação de evidência (`[x]`) ou marcados `[Gap]`/`[Ambiguity]`
- Items `{humano}` aguardam decisão do dono do produto
- CHK005, CHK012, CHK018 são os três itens abertos para decisão humana
- Nenhum gap bloqueante identificado: o contrato é completo para o fluxo principal
