# Quickstart: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

Cenários de teste que validam a implementação end-to-end, contra o ambiente
`compose.hub.test.yml` (projeto efêmero `-p hub-test-<runid>`, já provido pela S1).

## Scenario 1: Conta existente autentica no hub sem trocar senha (US1, happy path)

1. Rodar a migração de dados (`0008_migracao_empresa_para_usuario.sql`) sobre uma cópia
   de dados anonimizados (`gen-seeds.py` da S1) contendo pelo menos 1 `Empresa` com
   `pass` (bcrypt) ativo.
2. `POST /api/v1/auth/login` com o e-mail e a senha ORIGINAIS da `Empresa` migrada.
3. **Expected**: `200`, cookies `accessToken`/`refreshToken` setados, evento
   `login_sucesso` gravado em `Auditoria`.

## Scenario 2: E-mail inexistente e senha errada são indistinguíveis (US3, FR-015/FR-020)

1. `POST /api/v1/auth/login` com `email=naoexiste@x.com`, senha qualquer.
2. `POST /api/v1/auth/login` com um e-mail que EXISTE, senha errada.
3. **Expected**: ambas retornam `401 CREDENCIAIS_INVALIDAS`, com o MESMO corpo/latência
   observável (dummy-hash sempre executado, mesmo quando o e-mail não existe).

## Scenario 3: Bloqueio após 5 falhas consecutivas (US4, FR-017, SC-006)

1. `POST /api/v1/auth/login` com senha errada, 5 vezes seguidas para a mesma conta.
2. Uma 6ª tentativa, agora com a senha CORRETA.
3. **Expected**: a 6ª tentativa retorna `423 CONTA_BLOQUEADA` (não `200`, mesmo com senha
   certa). Avançar o relógio (ou usar `bloqueado_ate` no passado em teste de integração)
   além de 15 min e repetir o login correto.
4. **Expected**: login aceito na primeira tentativa após o período de espera.

## Scenario 4: RBAC nega ação sem permissão (US2, FR-012, SC-003)

1. Criar um `UsuarioEntidade` com papel `leitura`.
2. Autenticar com essa conta e chamar um endpoint protegido por
   `requirePermission('usuarios.gerenciar')` (ou equivalente de escrita).
3. **Expected**: `403 PERMISSAO_NEGADA` em 100% das tentativas — a ação NUNCA executa
   (nenhum efeito colateral no banco).

## Scenario 5: Troca de entidade ativa (US2, FR-010/FR-011)

1. Criar um `Usuario` com `UsuarioEntidade` ativo para as entidades A e B.
2. `GET /api/v1/me` — confirmar que `entidades` lista as duas.
3. `POST /api/v1/me/entidade { empresa_id: B }`.
4. **Expected**: `200`, `entidade_ativa = B`; uma chamada subsequente a um recurso
   protegido por RLS retorna apenas dados de B.
5. Tentar `POST /api/v1/me/entidade { empresa_id: C }` (sem vínculo).
6. **Expected**: `403 SEM_VINCULO`, `entidade_ativa` permanece B.

## Scenario 6: Mudança de papel reflete em ≤60s sem logout (US2, FR-013, SC-004)

1. Pessoa autenticada com papel `operador`; confirmar via `GET /api/v1/me` que NÃO tem
   `usuarios.gerenciar`.
2. Admin altera `UsuarioEntidade.papel_id` dessa pessoa para `admin_entidade` (a
   invalidação ativa do cache, Decision 7 de research.md, dispara aqui).
3. Sem a pessoa fazer novo login, repetir uma ação que exige `usuarios.gerenciar`.
4. **Expected**: permitida em no máximo 60 segundos após a mudança (idealmente
   imediatamente, dado o cache invalidado ativamente).

## Scenario 7: Logout revoga a sessão de verdade (US4, FR-018)

1. Login bem-sucedido, capturar `refreshToken`.
2. `POST /api/v1/auth/logout`.
3. `POST /api/v1/auth/refresh` reusando o `refreshToken` capturado antes do logout.
4. **Expected**: `401 SESSAO_INVALIDA` — a sessão não renova mais acesso.

## Scenario 8: Recuperação de senha — resposta idêntica, sessões revogadas (US3, FR-019–022)

1. `POST /api/v1/auth/recuperar-senha` para um e-mail cadastrado.
2. `POST /api/v1/auth/recuperar-senha` para um e-mail não cadastrado.
3. **Expected**: corpo de resposta IDÊNTICO em ambos (`200 { ok: true, mensagem: ... }`).
4. Capturar o token gerado no mock de e-mail (passo 1) e chamar
   `POST /api/v1/auth/redefinir-senha` com esse token + nova senha.
5. **Expected**: `200`; login com a senha antiga falha; login com a nova senha funciona;
   qualquer `refreshToken` emitido antes da redefinição deixa de renovar acesso (reusar
   Scenario 7 para confirmar).
6. Reusar o MESMO token de redefinição uma segunda vez.
7. **Expected**: `410 TOKEN_EXPIRADO` (já usado).

## Scenario 9: Roundtrip End-to-End — RLS bloqueia leitura cross-entidade mesmo contornando a aplicação (US5, FR-026–028, SC-008)

Cenário obrigatório desta fundação: não usa mock — faz uma chamada REAL ao PostgREST
isolado do hub (`hub-test`), contornando deliberadamente o middleware de aplicação, para
provar que a defesa em profundidade funciona por si só.

1. Subir `compose.hub.test.yml` com dados de teste (2 entidades, A e B, cada uma com pelo
   menos 1 linha em uma tabela nova coberta por RLS, ex.: `Auditoria`).
2. Gerar (via `hub-postgrest-jwt.js`, Decision 3) um JWT `authenticated` com
   `empresa_ativa=A`, `escopo=[A]` — SEM passar pela aplicação Express, chamando o
   PostgREST diretamente: `curl -H "Authorization: Bearer <jwt-A>"
   http://localhost:<postgrest-port>/Auditoria?id_empresa=eq.B`.
3. **Expected**: `200` com corpo `[]` — zero registros de B retornados, mesmo pedindo
   explicitamente por B (RLS nega, não a query em si).
4. Repetir a mesma chamada pedindo `id_empresa=eq.A` (a própria entidade do escopo).
5. **Expected**: registros de A são retornados normalmente — a proteção não quebra o uso
   legítimo (FR-026, segundo Acceptance Scenario da US5).
6. Comparar o shape do JSON retornado pelo PostgREST contra o contrato declarado em
   `contracts/auditoria.md` — nomes de campo em snake_case, tipos batendo
   (`criado_em` como string ISO 8601, `detalhes` como objeto JSON) — confirma a
   Convenção de Borda declarada em `plan.md` (nenhum mapper, passthrough).

> **Por que este cenário é obrigatório aqui**: FR-026 exige que a proteção funcione
> "mesmo que a camada de verificação de permissão seja contornada" — o único teste que
> prova isso empiricamente é um que **de fato** contorna a aplicação e fala direto com a
> camada de dados, não um teste que passa pelo middleware (que provaria apenas RBAC, não
> RLS).
