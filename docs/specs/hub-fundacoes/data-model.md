# Data Model: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

Convenção de nomes: tabelas em PascalCase singular, colunas em snake_case (mesmo padrão
das tabelas legadas `Empresa`/`Motorista`/`Grupo`/`Branding`). Todas as tabelas novas
vivem no schema `public` do banco isolado do hub (`hub_dev`/`hub_test`/`hub_homolog`) —
nenhuma delas existe no banco de produção `chatmasterveloz` nesta fase.

## Entity: Usuario

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| email | citext | UNIQUE, NOT NULL | case-insensitive (evita duplicidade `Foo@x.com`/`foo@x.com`) |
| senha_hash | text | NOT NULL | bcrypt; para contas migradas, é o MESMO hash de `Empresa.pass` (copiado, não recalculado) |
| nome | text | NOT NULL | |
| ativo | boolean | NOT NULL DEFAULT true | |
| tentativas_login | int | NOT NULL DEFAULT 0 | reseta a 0 em login bem-sucedido |
| bloqueado_ate | timestamptz | NULL | NULL = não bloqueado; setado a `now() + 15min` na 5ª falha consecutiva (FR-017) |
| token_recuperacao_hash | text | NULL | hash do token de recuperação (Decision 9); NULL quando não há pedido pendente |
| token_recuperacao_expira | timestamptz | NULL | |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |
| atualizado_em | timestamptz | NOT NULL DEFAULT now() | |
| criado_por | int | NULL, FK Usuario.id | NULL para linhas de bootstrap/migração (ovo-e-galinha do primeiro usuário) |

## Entity: UsuarioEntidade

Vínculo entre uma pessoa e uma entidade (empresa), com um papel.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| usuario_id | int | NOT NULL, FK Usuario.id | |
| empresa_id | int | NOT NULL | referencia `Empresa.id` (tabela legada, fora do escopo desta fundação — FK lógica, não física, dado que `Empresa` mora fora do banco do hub) |
| papel_id | int | NOT NULL, FK Papel.id | |
| ativo | boolean | NOT NULL DEFAULT true | desativar aqui remove o acesso (Edge Case: perda de acesso reflete na próxima ação sensível, não só no próximo login) |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |

**Constraint**: `UNIQUE(usuario_id, empresa_id)` — uma pessoa tem no máximo um papel por
entidade (se precisar de mais de um papel na mesma entidade, é resolvido por um Papel
mais amplo, não por múltiplas linhas).

## Entity: Papel

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| nome | text | UNIQUE, NOT NULL | ex.: `admin_plataforma`, `admin_entidade`, `operador`, `leitura` |
| escopo | text | NOT NULL, CHECK IN ('global','entidade') | `global` = válido em qualquer entidade (ex.: administração da plataforma); `entidade` = vinculado a uma entidade específica via `UsuarioEntidade` |
| is_sistema | boolean | NOT NULL DEFAULT false | papéis seed (os 4 obrigatórios de FR-008) marcados `true` — protegidos de exclusão acidental |

## Entity: Permissao

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| codigo | text | UNIQUE, NOT NULL | formato `modulo.acao` (ex.: `motoristas.consultar`, `faturamento.export`) |
| modulo_id | int | NOT NULL, FK Modulo.id | |

## Entity: PapelPermissao

Tabela de junção N:M entre `Papel` e `Permissao`.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| papel_id | int | NOT NULL, FK Papel.id | |
| permissao_id | int | NOT NULL, FK Permissao.id | |

**Constraint**: `UNIQUE(papel_id, permissao_id)` (chave composta como PK).

## Entity: Modulo

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| codigo | text | UNIQUE, NOT NULL | `dashboard, motoristas, faturamento, performance, importacoes, envio_massa, usuarios, auditoria, admin` |
| nome | text | NOT NULL | rótulo de exibição (para navegação futura, S3+) |
| icone | text | NULL | referência de ícone (para navegação futura, S3+) |
| ordem | int | NOT NULL DEFAULT 0 | ordenação de navegação futura |
| ativo | boolean | NOT NULL DEFAULT true | |

## Entity: ModuloEntidade

Habilita/desabilita um módulo para uma entidade específica (ex.: entidade sem
faturamento habilitado nesta fase de rollout modular).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| modulo_id | int | NOT NULL, FK Modulo.id | |
| empresa_id | int | NOT NULL | idem `UsuarioEntidade.empresa_id` — referência lógica a `Empresa.id` |
| ativo | boolean | NOT NULL DEFAULT true | |

**Constraint**: `UNIQUE(modulo_id, empresa_id)`.

## Entity: Auditoria

Append-only — ver reforço de imutabilidade em duas camadas (research.md Decision 6).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | bigserial | PK | |
| id_empresa | int | NULL | NULL para eventos sem entidade (ex.: login com e-mail inexistente) |
| usuario_id | int | NULL, FK Usuario.id | NULL quando o ator não pôde ser identificado (ex.: tentativa de login com e-mail que não existe) |
| acao | text | NOT NULL | ex.: `login_sucesso`, `login_falha`, `logout`, `troca_papel`, `troca_entidade_ativa` |
| recurso | text | NOT NULL | tipo do recurso afetado (ex.: `Usuario`, `UsuarioEntidade`) |
| recurso_id | text | NULL | id do recurso afetado, quando aplicável |
| detalhes | jsonb | NOT NULL DEFAULT '{}' | **NUNCA** contém senha/hash/token em texto aberto (FR-025) — diffs de edição entram mascarados |
| ip | inet | NULL | |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |

**Reforço de imutabilidade (FR-024)**:
- `REVOKE UPDATE, DELETE ON "Auditoria" FROM authenticated;` (e de qualquer role de
  aplicação usado pelo backend do hub via PostgREST).
- Trigger `BEFORE UPDATE OR DELETE ON "Auditoria"` que executa `RAISE EXCEPTION` sempre.
- Nenhum endpoint do hub expõe `PUT`/`PATCH`/`DELETE` para este recurso.

## Entity: SessaoRefresh

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| usuario_id | int | NOT NULL, FK Usuario.id | |
| token_hash | text | UNIQUE, NOT NULL | hash do refresh token (Decision 9) — nunca o valor bruto |
| expira_em | timestamptz | NOT NULL | |
| revogado_em | timestamptz | NULL | setado no logout (FR-018) ou na rotação/troca de senha (FR-022) |
| user_agent | text | NULL | |
| ip | inet | NULL | |
| criado_em | timestamptz | NOT NULL DEFAULT now() | |

## Entity: SchemaMigration

Já existente (criada em `0000_schema_migration.sql`, S1) — reutilizada tal qual, sem
alteração de schema. `id serial PK`, `nome text UNIQUE NOT NULL`, `aplicado_em
timestamptz NOT NULL DEFAULT now()`.

### Relationships

- `Usuario` 1:N `UsuarioEntidade` via `usuario_id`
- `Usuario` 1:N `SessaoRefresh` via `usuario_id`
- `Papel` 1:N `UsuarioEntidade` via `papel_id`
- `Papel` N:M `Permissao` via `PapelPermissao`
- `Permissao` N:1 `Modulo` via `modulo_id`
- `Modulo` N:M `Empresa` (legada, referência lógica) via `ModuloEntidade`
- `UsuarioEntidade` N:1 `Empresa` (legada, referência lógica, `empresa_id`)
- `Auditoria` N:1 `Usuario` (opcional, `usuario_id` NULL-ável)

### State Transitions

**Usuario.bloqueado_ate** (FR-017):
```
desbloqueado (bloqueado_ate = NULL)
  --5ª falha consecutiva--> bloqueado (bloqueado_ate = now() + 15min)
  --login correto após expirar bloqueado_ate--> desbloqueado (tentativas_login reset a 0)
```

**Usuario.token_recuperacao_hash** (FR-021, Edge Case "apenas o pedido mais recente"):
```
sem_pedido (NULL)
  --solicitação de recuperação--> pedido_pendente (hash + expiração setados;
                                    QUALQUER pedido anterior é sobrescrito, nunca
                                    coexistem dois pedidos válidos)
  --uso bem-sucedido | expiração | novo pedido--> sem_pedido (NULL)
```

**SessaoRefresh** (FR-018, FR-022):
```
ativa (revogado_em = NULL, expira_em > now())
  --logout--> revogada (revogado_em = now())
  --redefinição de senha bem-sucedida (qualquer sessão da conta)--> revogada
  --renovação (refresh)--> revogada (rotação: esta linha é revogada, uma nova é criada)
  --expira_em ultrapassado--> expirada (implícita, sem UPDATE — tratada como inválida na leitura)
```
