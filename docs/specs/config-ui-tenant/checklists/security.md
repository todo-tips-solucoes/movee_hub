# Security Checklist: Configuração de UI por Tenant (White-label) + Grupo de CNPJs

**Purpose**: Validar qualidade dos requisitos de segurança — cobertura dos mandatos F1-F6
do Security Hardening (plan.md), invariante do Princípio II (Tenant Isolation), autorização
de grupo, upload de logo, e exposição mínima de dados.

**Created**: 2026-06-05
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)
**Domínio**: security

---

## F1 — Injeção via PostgREST (A05 Injection)

- [x] CHK001 - O requisito de coerção de inteiro para `empresaIdFilho`, `?id_empresa` e
  `?movimento` antes de interpolação em query PostgREST (`eq.`/`in.(…)`/path param) está
  especificado nos artefatos? [Completude, Mandato F1] {auto}
  > SATISFEITO — plan.md §Security Hardening F1 (linha 208): "TODO id que entra em
  > `eq.`/`in.(...)`/path param (`empresaIdFilho`, `?id_empresa`, `?movimento`) DEVE ser
  > coagido a inteiro (`Number.isInteger`) e rejeitado se não-numérico, ANTES de interpolar."
  > Contrato grupo-api.md §DELETE Request: "Path param: `empresaIdFilho` — validado server-side
  > como pertencente ao grupo do token."

- [x] CHK002 - Todos os parâmetros que chegam ao PostgREST via URL/body estão enumerados
  com seus tipos esperados nos contratos? [Clareza, Mandato F1, contratos/branding-api.md,
  contratos/grupo-api.md] {auto}
  > SATISFEITO — branding-api.md §PUT Request tabela de campos lista tipo e validação de
  > cada campo; grupo-api.md §POST Request e §DELETE Request listam `empresaIdFilho` como
  > path param validado server-side.

- [ ] CHK003 - Existe requisito explícito definindo o comportamento esperado quando um id
  **não-numérico** (ex: `abc`, `1;DROP`) chega em parâmetros de rota/query do grupo?
  Qual status code retorna (400 vs 422)? [Clareza, Gap — contrato não especifica status
  code para input não-numérico] {humano}

---

## F2 — Upload / Stored XSS (SVG)

- [x] CHK004 - O requisito de restrição de Content-Type no upload de logo (PNG/JPEG/SVG
  ≤ 512 KB) está documentado com tipos MIME aceitos e tamanho máximo? [Completude,
  Mandato F2, FR-011] {auto}
  > SATISFEITO — spec.md §FR-011: "apenas formatos de imagem (PNG, SVG, JPEG), tamanho
  > máximo definido (ex.: 512 KB)." plan.md linha 163: "logo (mimetype PNG/SVG/JPEG +
  > tamanho ≤ 512 KB)." Contrato PUT /empresa/branding §Request: campo `logo` com
  > "mimetype permitido, ≤ 512 KB."

- [x] CHK005 - O requisito de servir SVG via `<img src>` (não inline) como mitigação de
  XSS está especificado nos artefatos? [Completude, Mandato F2] {auto}
  > SATISFEITO — plan.md §Security Hardening F2: "Logo é servido por URL pública do
  > Storage e exibido via `<img src>` (não inline) — mitiga." Decisão de arquitetura
  > documentada como requisito de implementação.

- [ ] CHK006 - O requisito de enforce de `Content-Type` no Supabase Storage (rejeitar
  SVG com MIME errado) está especificado com o mecanismo concreto (policy de bucket,
  MIME check no upload handler, ou ambos)? [Clareza, Mandato F2, Gap — plano menciona
  enforce mas não especifica onde/como é configurado no Storage] {humano}

- [x] CHK007 - O requisito de sanitização de SVG (strip de `<script>`/`on*`) está
  claramente marcado como fora do escopo MVP, com a condição de reentrada documentada?
  [Completude, Mandato F2] {auto}
  > SATISFEITO — plan.md F2: "se algum front inlinar SVG no futuro, sanitizar (strip
  > script/on*) no upload OU restringir MVP a PNG/JPEG." Escopo MVP explicitamente
  > limitado a `<img src>`; reentrada condicionada a inline SVG futuro.

---

## F3 — SSRF Guard

- [x] CHK008 - O requisito de não aceitar URL remota como origem de logo (apenas upload
  de arquivo multipart) está declarado no MVP como proteção SSRF? [Completude,
  Mandato F3, FR-011] {auto}
  > SATISFEITO — plan.md F3: "MVP faz upload de arquivo (multipart), sem fetch de URL
  > remota → sem SSRF." spec.md FR-011 especifica upload validado sem menção a URL
  > remota.

- [ ] CHK009 - O guard "se `logo via URL` for adicionado depois, vira superfície SSRF"
  está documentado como **requisito de revisão de segurança futura**, não apenas como
  comentário informal? [Completude, Mandato F3, Gap — atualmente é nota no plan.md
  mas não há FR explícito de revisão obrigatória antes de implementar essa extensão] {humano}

---

## F4 — IDOR / Ownership de Grupo

- [x] CHK010 - O requisito de validação server-side de `is_grupo_pai` antes de qualquer
  mutação de grupo está especificado em todos os endpoints de grupo? [Completude,
  Mandato F4, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §GET /grupo/filhos Request: "is_grupo_pai === true";
  > §POST /grupo/filhos Request: valida `is_grupo_pai`; §DELETE Request: "Auth:
  > authenticateToken + is_grupo_pai." Cobertura completa nos 3 endpoints.

- [x] CHK011 - O requisito de que `filho-de-outro-grupo → 403` está especificado no
  contrato do DELETE com caso de erro explícito? [Completude, Mandato F4,
  contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §DELETE Error Responses: "403 — token não é pai, ou filho
  > não é do grupo do token." Cenário de cross-grupo está mapeado.

- [x] CHK012 - O requisito de que a validação de ownership de `empresaIdFilho` é
  server-side (nunca confia no body do cliente) está declarado nos contratos? [Clareza,
  Mandato F4, Princípio II] {auto}
  > SATISFEITO — grupo-api.md §DELETE Request: "Path param: `empresaIdFilho` — validado
  > server-side como pertencente ao grupo do token (não aceita filho de outro grupo)."

---

## F5 — BOPLA (Allowlist de Campos)

- [x] CHK013 - O requisito de allowlist explícita de campos aceitos no handler de
  `PUT /empresa/branding` está especificado (campos enumerados, `id_grupo` proibido
  do body)? [Completude, Mandato F5, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §PUT Request: tabela de campos aceitos
  > (`cor_primaria`, `cor_destaque`, `nome_exibicao`, `logo`) com tipos e validações;
  > nota explícita "O `id_grupo` **não** vem do cliente — é derivado de
  > `resolveScope`/claim do token."

- [x] CHK014 - O requisito de allowlist de campos aceitos no handler de
  `POST /grupo/filhos` está especificado (apenas `empresa_id_filho`, `id_grupo` sempre
  do token)? [Completude, Mandato F5, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §POST Request: body `{ "empresa_id_filho": number }`
  > (campo único aceito); "id_grupo do token (Princípio II)" — proibido no body.

- [ ] CHK015 - Existe requisito que define o comportamento quando campos **não
  allowlistados** chegam no body (silently ignored vs. 400 com mensagem)? [Clareza,
  Mandato F5, Gap — contratos não especificam tratamento de campos extras no body] {humano}

---

## F6 — Exposição Mínima (select= explícito)

- [x] CHK016 - O requisito de usar `select=` explícito no GET leve do PWA
  (`GET /motorista/branding-tomador`) — nunca retornar linha completa da Empresa —
  está especificado no contrato? [Completude, Mandato F6, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /motorista/branding-tomador Response (200):
  > retorna apenas `{ logo_url, cor_primaria, cor_destaque, nome_exibicao }`. plan.md
  > F6: "GET leve do PWA usa `select=` explícito (logo/cores/nome) — nunca retorna a
  > linha completa da Empresa/tomador."

- [x] CHK017 - O campo `id_grupo` é **omitido** da resposta do GET /motorista/branding-tomador
  (exposição mínima para o PWA motorista)? [Completude, Mandato F6, contratos/branding-api.md] {auto}
  > SATISFEITO — branding-api.md §GET /motorista/branding-tomador Response (200):
  > resposta não inclui `id_grupo`, apenas os 4 campos de visual. Diferente do
  > GET /empresa/branding que expõe `id_grupo` para o painel (correto, painel precisa
  > do id).

---

## Princípio II — Tenant Isolation (resolveScope)

- [x] CHK018 - O invariante de que `resolveScope` lê **exclusivamente** do token JWT
  (nunca do corpo/query do cliente) está declarado formalmente como requisito?
  [Completude, Princípio II v1.1.0, spec.md §Amendment, contratos/grupo-api.md] {auto}
  > SATISFEITO — spec.md §Amendment à Constitution Princípio II v1.1.0 (redação
  > proposta): "O conjunto de empresas elegíveis é resolvido server-side por um helper
  > de escopo (`resolveScope(req.user)`), **nunca** por identificador enviado pelo
  > cliente." Contrato grupo-api.md §resolveScope: "o conjunto sai **exclusivamente**
  > do token."

- [x] CHK019 - O requisito de que tokens de **filhos** não recebem escopo expandido
  (retorna `[empresaId]` mesmo com `id_grupo` preenchido) está especificado?
  [Completude, Princípio II, contratos/grupo-api.md] {auto}
  > SATISFEITO — grupo-api.md §resolveScope tabela: "tem `id_grupo` mas
  > `is_grupo_pai === false` (é filho) → `[empresaId]` — escopo NÃO expandido."
  > spec.md FR-003: "tokens de CNPJs filhos enxerguem apenas a própria empresa."

- [x] CHK020 - O requisito de isolamento cross-tenant de branding está declarado como
  FR explícito, não apenas como inferência de design? [Completude, FR-012, spec.md] {auto}
  > SATISFEITO — spec.md FR-012: "O sistema DEVE garantir que a branding de um tenant
  > não vaze para outro — a resolução de branding respeita o mesmo escopo de isolamento
  > que os dados de negócio."

- [x] CHK021 - O requisito de autorização "somente o CNPJ pai gerencia filhos e branding"
  está coberto nos contratos de todos os endpoints mutantes (PUT branding, POST filhos,
  DELETE filho)? [Completude, spec.md FR-014, contratos] {auto}
  > SATISFEITO — branding-api.md PUT: "Auth: authenticateToken + is_grupo_pai === true
  > (senão 403)"; grupo-api.md POST e DELETE: "is_grupo_pai" obrigatório. spec.md
  > FR-014: "Toda mutação de branding exige autenticação e autorização de CNPJ pai."

- [ ] CHK022 - O requisito de `constitutionUpdate` (bump Princípio II v1.0.0 → v1.1.0
  em `docs/constitution.md`) está modelado como tarefa de implementação obrigatória,
  não apenas como nota no spec? [Completude, spec.md §Amendment, Gap — não há FR
  numerado cobrindo a atualização do arquivo constitution.md como entregável] {humano}

---

## Upload de Logo — Validação e Storage URL

- [x] CHK023 - O requisito de que `logo_url` armazenado é sempre uma URL pública do
  Supabase Storage (não path relativo, não URL arbitrária) está declarado no
  data-model? [Clareza, data-model.md §Entity Branding] {auto}
  > SATISFEITO — data-model.md §Branding: "`logo_url` | text | NULLABLE | URL pública
  > do Supabase Storage; NULL → sem logo (usa wordmark/nome)."

- [x] CHK024 - O requisito de idempotência do upload de logo (mesmo arquivo → mesma URL,
  sem duplicar no Storage) está declarado como FR? [Completude, FR-INFRA-IDEMP, spec.md] {auto}
  > SATISFEITO — spec.md §FR-INFRA-IDEMP: "O endpoint de upload de logo é idempotente
  > para o mesmo arquivo (mesma hash → não duplica no Storage)."

- [ ] CHK025 - O requisito de **remoção de logo** (logo_url → NULL) — caso de uso
  "operador quer voltar ao wordmark/nome sem logo" — está coberto nos contratos de PUT?
  [Completude, Gap — branding-api.md §PUT não documenta como setar logo_url = NULL
  explicitamente; campo `logo` omitido = "não altera", mas não há campo `remove_logo: true`
  ou semantics de null] {humano}

---

## Notes

- Items `{auto}` resolvidos com citação direta dos artefatos (`[x]` + evidência)
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto
- **{auto} resolvidos**: 16 (`[x]` com evidência citada)
- **{humano} aguardando decisão**: 6 (CHK003, CHK006, CHK009, CHK015, CHK022, CHK025)
- **Gaps abertos**: 5 gaps reais de requisito em aberto (CHK003, CHK006, CHK015, CHK022, CHK025) + 1 guard de extensão futura (CHK009)

### Gaps prioritários para /clarify ou definição antes de create-tasks

| Item | Gap | Ação sugerida |
|------|-----|---------------|
| CHK003 | Status code para parâmetro não-numérico (400 vs 422) | Definir no contrato grupo-api.md |
| CHK006 | Enforce Content-Type no Supabase Storage — onde exatamente | Especificar bucket policy ou handler |
| CHK015 | Campos extras no body: silently ignored ou 400 | Definir comportamento padrão nos contratos |
| CHK022 | Atualização de constitution.md como entregável obrigatório | Criar FR ou task explícita |
| CHK025 | Semantics de remoção de logo (volta a NULL) | Adicionar campo `remove_logo` ou doc no PUT |
