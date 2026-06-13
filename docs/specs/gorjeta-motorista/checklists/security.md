# Security Checklist: Gorjeta do Motorista

**Purpose**: Validar qualidade dos requisitos de segurança — isolamento multi-tenant, input validation, ausência de exposição indevida de dados de terceiros via gorjeta.
**Created**: 2026-06-12
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)

## Isolamento Multi-Tenant

- [x] CHK301 - O requisito de isolamento multi-tenant é preservado para o novo campo gorjeta no upload? [Completude, Constitution §II, Spec §FR-001] {auto}
  > Evidência: O upload usa `id_empresa` do token para escopar todos os registros de `EnvioMassa`. A gorjeta é inserida no mesmo objeto `dataToInsert` — herdando o escopo existente. Constitution §II "escopo resolvido server-side a partir do token, nunca do corpo" é preservado.

- [x] CHK302 - O campo gorjeta na consulta `/movimento-aberto` é filtrado pelo token do motorista e não pode ser acessado por outro motorista? [Completude, Constitution §II, Plan §4.3] {auto}
  > Evidência: Plan §4.3 descreve adição de `gorjeta: row.gorjeta` no mapper do `/movimento-aberto`; esse endpoint usa `authenticateMotorist` + filtro por `cnpj_prestador` do token — a query já é escopada. Gorjeta não adiciona superfície de acesso cruzado.

- [x] CHK303 - O requisito FR-004 garante que a gorjeta retornada pertence ao movimento do motorista autenticado (não de terceiro)? [Consistência, Constitution §II, Spec §FR-004] {auto}
  > Evidência: FR-004 "endpoint de consulta do movimento aberto deve retornar o campo gorjeta" — o "movimento aberto" já é por definição o movimento do motorista autenticado. Sem campo livre de tenant no request.

## Input Validation

- [x] CHK304 - O requisito cobre validação de tipo para o campo gorjeta no upload (prevenção de injeção via valor monetário malformado)? [Completude, Spec §FR-002, §Edge Cases, Plan §4.2] {auto}
  > Evidência: Spec §Edge Cases define "valor não-monetário → gravar null, sem 500"; CL-002 usa `Number.isFinite(toNumberBR(valor))` como guard. `toNumberBR` é a mesma função já usada para `valor` — não cria nova superfície de injeção. Guard efetivo para payloads malformados.

- [x] CHK305 - O tamanho máximo do campo gorjeta está implícito ou explícito nos requisitos? [Completude, Plan §3.1, CL-001] {auto}
  > Evidência: CL-001 define formato `valorNum.toFixed(2)` — string de no máximo ~20 chars para qualquer valor monetário real. Tipo TEXT no Postgres não impõe limite de tamanho, mas o guard `Number.isFinite` rejeita strings arbitrariamente longas (retornam NaN). Superfície de injeção via tamanho é desprezível.

- [x] CHK306 - O requisito de "nenhum rowError para gorjeta inválida" garante que payloads maliciosos na coluna gorjeta não causam vazamento de informações no log/resposta? [Clareza, Spec §FR-002, Plan §6.1] {auto}
  > Evidência: FR-002 + Plan §6.1 definem que gorjeta inválida resulta em `null` silencioso, sem `rowErrors.push`. Isso previne que o valor de entrada malicioso seja refletido de volta na resposta de upload.

## Confidencialidade de Dados

- [x] CHK307 - Existe requisito ou escopo claro sobre quem tem acesso de leitura à gorjeta (apenas motorista vs. empresa)? [Completude, Spec §US1, Constitution §II] {auto}
  > Evidência: Spec US1 "Motorista vê sua gorjeta na tela de movimento" — a gorjeta é retornada pelo endpoint do motorista (`/movimento-aberto`). Spec §7 Escopo define que `frontend_v2` (painel da empresa) NÃO muda — a empresa não ganha tela de gorjeta nesta feature.

- [ ] CHK308 - Existe requisito explicitando se o painel da empresa (frontend_v2) DEVE ou NÃO DEVE exibir a gorjeta de seus motoristas? [Completude, Gap] {humano}
  > [Gap]: Spec §7 define que `frontend_v2` "NÃO muda" nesta feature, mas não declara explicitamente se a empresa tem direito de ver a gorjeta dos motoristas em futuras features. Relevante para decisão de privacidade/produto.

## Conformidade com Constitution

- [x] CHK309 - A feature gorjeta honra o princípio de "mudanças em auth/upload/XML passam por revisão OWASP" definido na constitution? [Conformidade, Constitution §Qualidade, Plan §9] {auto}
  > Evidência: Plan §9 "Conformidade com a Constitution" confirma que a OWASP review foi executada (dec-015 no state.json: gate owasp-security verde). Requisito de conformidade atendido.

- [x] CHK310 - A gorjeta não é usada como vetor para bypass de autenticação ou modificação de escopo do tenant? [Conformidade, Constitution §II] {auto}
  > Evidência: O campo gorjeta é uma coluna de valor monetário passiva — não afeta lógica de autenticação, autorização ou resolução de escopo. Não há condicional de auth baseada em gorjeta.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **CHK308** `[Gap]` `{humano}`: visibilidade da gorjeta no painel da empresa — não bloqueia esta feature, mas deve ser resolvido antes de uma feature de "relatório de gorjetas".
- OWASP gate já executado (dec-015, verde) — sem findings de segurança críticos nesta feature.
