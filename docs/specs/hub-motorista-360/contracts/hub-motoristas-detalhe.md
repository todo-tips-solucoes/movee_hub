# Contract: Detalhe do motorista (extensão) — CNPJ, EntreGô, RBAC de campo

Extensão de um endpoint **já existente e verificado**:
`GET /motoristas/:id` (`app_homologacao/backend/routes/hub-motoristas.js:534`,
handler `buscarDetalheMotorista` na mesma linha 460). Auth/RBAC de rota
inalterados (`requirePermission('motoristas.consultar')`).

## GET /motoristas/:id (campos adicionados ao payload já existente)

**Auth**: cookie `accessToken` (já existente) + `motoristas.consultar` (já
existente, inalterado).

### Response (200) — campos NOVOS adicionados ao shape já existente

| Field | Type | Sempre presente? | Descrição |
|-------|------|-------------------|-----------|
| cnpjPrestador | string \| null | sim | `ContaMotorista.cnpj_prestador` quando `motorista_id` setado; `null` caso contrário (FR-008, Decision 3 de `research.md`) |
| entregoEnriquecimento | object \| null | sim | `null` se `Entregador.dados_entrego_enriquecidos_em IS NULL` (nunca buscado) |
| entregoEnriquecimento.enriquecidoEm | string (ISO 8601) | se objeto presente | espelha `dados_entrego_enriquecidos_em` |
| entregoEnriquecimento.dadosPessoais | object \| omitido | se permissão `motoristas.dados_sensiveis` presente | `{ nomeCompleto, dataNascimento, email, cpf, nomeMae, nomePai, telefone }` — omitido inteiro (não `null` por campo) quando a permissão falta, exceto `nomeCompleto`/`dataNascimento`/`telefone` que **não** são sensíveis por FR-014 e continuam presentes num sub-objeto `dadosPessoaisBasicos` sempre visível |
| entregoEnriquecimento.documentos | object | sempre, mas `rg` só se permissão `motoristas.dados_sensiveis` presente | `{ rg, cnh }` — **`rg` É sensível por FR-013/FR-014** (ambos o enumeram) e MUST ser omitido (chave ausente, não `null`) quando a permissão falta, mesmo tratamento de `dadosPessoais`/`contatoEmergencia`. `cnh` não consta das listas de FR-013/FR-014 e segue sempre presente |
| entregoEnriquecimento.contatoEmergencia | object \| omitido | se permissão presente | `{ grauParentesco, nome, telefone }` — categoria inteira sensível (FR-014: "contato de emergência") |
| entregoEnriquecimento.informacoesEntrega | object | sempre | `{ operadorLogistico, modal }` |
| vinculoCredencialAutomatico | boolean | sim | `true` quando o vínculo atual foi criado pelo hook automático (FR-009) ou pelo backfill (FR-012), `false` quando manual — necessário para SC-002 ser observável em teste; fonte exata da flag (nova coluna vs. valor derivado) a decidir em `create-tasks` |

### RBAC de campo (FR-013) — implementação

Dentro de `buscarDetalheMotorista()`: chamar
`obterPermissoesEfetivas(usuarioId)` (já existe, `lib/hub-rbac-cache.js`,
mesmo helper usado por `middleware/hub-require-permission.js` — cacheado,
sem custo adicional relevante) e checar
`.has('motoristas.dados_sensiveis')` antes de incluir `dadosPessoais`,
`documentos.rg` e `contatoEmergencia` no payload. **Omitir a chave**, não retornar
`null`/string mascarada — evita vazar até o formato do dado (ex.: máscara
`***.***.***-**` ainda revela que existe CPF).

### Defesa em profundidade (gate `owasp-security`, achado A01 — informativo)

O mascaramento é só em camada de aplicação (DTO), consistente com o padrão
já estabelecido no projeto (`mascararCnpj`, `lib/hub-motoristas-dto.js`, já
é app-layer). Risco residual aceito: um endpoint FUTURO que exponha
`Entregador`/`dados_entrego_json` bruto sem passar por
`buscarDetalheMotorista()` vazaria os campos sensíveis sem o gate. Mitigação
obrigatória: `quickstart.md` Scenario 4 (RBAC de campo) e Scenario 7
(roundtrip) MUST fazer parte da suíte automatizada de `execute-task`, não
só verificação manual — é o teste de regressão que pega esse tipo de vazamento
futuro.

### Error Responses (inalterado)

| Status | Code | Description |
|--------|------|--------------|
| 401 | NAO_AUTENTICADO | (já existente) |
| 403 | PERMISSAO_NEGADA | (já existente, nível de rota) |
| 404 | NAO_ENCONTRADO | (já existente) |
