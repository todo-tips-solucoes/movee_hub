# Quickstart: config-ui-tenant

Cenários de teste technology-agnostic mapeando os Success Criteria da spec.
Cada cenário: passos → **Expected**.

---

## Scenario 1: Pai vincula filho e configura branding (US1 + US2 — happy path)

1. Login como CNPJ **pai** de um grupo (token com `is_grupo_pai = true`).
2. `GET /grupo/filhos` → lista pai + filhos atuais.
3. `POST /grupo/filhos` com `{ "empresa_id_filho": <id de empresa sem grupo> }`.
4. Abrir `/dashboard/configuracoes/aparencia`.
5. Preencher `cor_primaria=#1f63eb`, `cor_destaque=#ff7a18`,
   `nome_exibicao="Transportadora D&G"`, anexar logo PNG ≤ 512 KB.
6. Salvar (`PUT /empresa/branding`).
7. **Expected**:
   - filho aparece em `GET /grupo/filhos`;
   - branding persiste (`GET /empresa/branding` retorna os valores);
   - a tela aplica o tema **ao vivo** (cor primária/destaque/logo) **sem reload**
     (FR-009) — preview reflete antes mesmo de recarregar;
   - logo salvo no Supabase Storage; `logo_url` retornada.

---

## Scenario 2: Isolamento — filho não enxerga dados de outro filho (US1 — error/security case)

1. Login como CNPJ **filho** de um grupo (token com `id_grupo` setado,
   `is_grupo_pai = false`).
2. Tentar `GET /grupo/filhos`.
3. Tentar `PUT /empresa/branding`.
4. Chamar um endpoint de dados de negócio existente (ex.: `/envio-massa`).
5. **Expected**:
   - `GET /grupo/filhos` → **403** (apenas o pai gerencia);
   - `PUT /empresa/branding` → **403** (apenas o pai edita);
   - `/envio-massa` retorna **apenas** dados da própria empresa do filho —
     `resolveScope` para filho = `[empresaId próprio]`, escopo **não** expandido
     (Princípio II preservado);
   - nenhuma resposta inclui `empresaId` vindo do body do cliente.

---

## Scenario 3: Roundtrip End-to-End — branding do tomador no AppMotorista (US3 — obrigatório)

> Chamada **real** ao backend (não mock/fixture). Captura o payload de resposta e
> compara o shape contra `contracts/branding-api.md` — guarda contra drift de
> case/shape (lição: 40 ondas mascararam drift snake_case/camelCase por testar mocks).

1. Seed: tomador `T` com `id_empresa` pertencente a um grupo com branding
   configurada; movimento `M` do prestador autenticado cujo tomador é `T`.
2. Login motorista (cookie httpOnly, aud=motorista).
3. `GET /motorista/branding-tomador?movimento=<M>` — chamada **real**.
4. Capturar o JSON de resposta.
5. **Expected**:
   - payload tem exatamente as chaves do contrato: `logo_url`, `cor_primaria`,
     `cor_destaque`, `nome_exibicao` — **snake_case** (asserção literal das chaves,
     não de mock);
   - valores correspondem à branding do grupo de `T`;
   - o PWA, ao abrir o movimento `M`, aplica logo/cores/nome de `T` no tema
     (CSS custom properties no `:root`).
6. Trocar para um movimento `M2` cujo tomador `T2` está em **outro** grupo:
   - **Expected**: a branding exibida muda para a de `T2` (FR-010 — branding por
     movimento).

---

## Scenario 4: Degradação graciosa — tomador sem branding (US3 — error case)

1. Movimento `M3` cujo tomador `T3` **não tem grupo** (ou grupo sem branding).
2. `GET /motorista/branding-tomador?movimento=<M3>`.
3. Simular também falha de rede (timeout do fetch do PWA).
4. **Expected**:
   - resposta `{ "fallback": "movee" }` com **HTTP 200** (nunca erro que trave);
   - no timeout, o PWA aplica o fallback Movee localmente;
   - o app exibe a identidade Movee padrão **sem travar** nem mostrar branding
     errada (FR-010 + FR-012).

---

## Scenario 5: Validação de upload e cor (US2 — error cases)

1. Como pai, `PUT /empresa/branding` com `cor_primaria=azul` (não hex).
2. `PUT /empresa/branding` com logo de 2 MB / formato `.gif`.
3. **Expected**:
   - cor inválida → **400** com mensagem PT-BR, campo destacado no form, **nada**
     persistido;
   - logo inválido → **400** ("PNG/SVG/JPEG até 512 KB"), **nada** salvo no Storage
     (recusa antes de tocar o Storage), sem persistência parcial.

---

## Scenario 6: Migração D&G parametrizada (operacional)

1. Aplicar `docs/sql/001-config-ui-tenant-schema.sql` como operador.
2. Reload PostgREST (`NOTIFY pgrst` ou `docker kill -s SIGUSR1 pgadmin_postgrest`).
3. **Expected**:
   - `Grupo`, `Empresa.id_grupo`, `Branding` existem; empresas pré-existentes com
     `id_grupo` NULL (comportamento atual preservado, sem downtime);
   - `002-*.sql` permanece **bloqueado** até o usuário responder o levantamento
     (`docs/sql/dg-levantamento.sql`) — vínculos via placeholders, nunca ids
     hardcoded.
