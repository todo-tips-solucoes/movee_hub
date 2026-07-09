# Data Model: Envio em Massa como Módulo do Hub

Esta feature **não introduz nenhuma tabela nova**. Ela consome tabelas legadas
já existentes (`EnvioMassa`, `Empresa`, `Grupo`, `Motorista`) sem alterar seu
schema, e tabelas do hub já criadas por fases anteriores (`Modulo`, `Permissao`,
`Papel`, `PapelPermissao`, `UsuarioEntidade`, `ModuloEntidade`,
`ImportacaoArquivo`, `Auditoria`). O único artefato de dados novo é uma **linha
de seed** (permissão `envio_massa.gerenciar`) — ver Migration 0032 no plan.md.

## Entity: Permissao (linha nova, tabela existente)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | auto |
| codigo | text | UNIQUE NOT NULL | valor novo: `'envio_massa.gerenciar'` |
| modulo_id | int | FK → Modulo(id) | resolve por `codigo='envio_massa'` (já existe) |

### Relationships

- `Permissao` N:M `Papel` via `PapelPermissao` — a migration 0032 concede
  `envio_massa.gerenciar` a `admin_plataforma` e `admin_entidade` (backfill
  explícito; ver research.md Decision 4).
- `Permissao.modulo_id` → `Modulo` (linha `codigo='envio_massa'`, já existe
  desde `0007`, sem alteração).

### Nenhuma State Transition — é uma linha de catálogo estática, não uma entidade
com ciclo de vida.

## Entity: ImportacaoArquivo (consumida, sem alteração de schema)

Já existe (`infra/hub/migrations/0011_importacao_arquivo.sql`). Esta feature
apenas passa a **inserir** linhas com `tipo='envio_massa'` — valor já aceito
pelo `CHECK` desde a criação da tabela (S2/S4 anteciparam este uso).

| Field | Type | Constraints | Uso por esta feature |
|-------|------|-------------|-----------------------|
| id | serial | PK | gerado |
| id_empresa | int | NOT NULL | = `req.user.empresaId` pós-adaptador (Decision 2) |
| tipo | text | CHECK IN (..., `'envio_massa'`) | fixo `'envio_massa'` |
| nome_arquivo | text | NULL | nome do `.xlsx` enviado |
| hash_sha256 | char(64) | NOT NULL | sha256 do arquivo recebido em `POST /upload` |
| status | text | CHECK IN (7 valores) | **gravado direto em estado terminal** (`completed`, `completed_with_errors`, ou `failed`) — nunca `pending`/`validating`/`processing` (Decision 9, evita colisão com o índice único parcial `importacaoarquivo_uma_ativa_por_tipo`) |
| total_linhas / linhas_validas / linhas_invalidas | int | NULL | dos contadores que o parser XLSX legado já produz |
| criado_por | int | FK → Usuario(id), NULL | `req.hubContext.usuarioId` — só preenchido para uploads via sessão hub |
| criado_em / atualizado_em | timestamptz | default now() | automático |

### Relationships

- `ImportacaoArquivo.id_empresa` → `Empresa.id` (legado, sem FK física — mesma
  convenção das demais linhas de `ImportacaoArquivo`).
- `ImportacaoArquivo.criado_por` → `Usuario.id` (hub) — FK física real.

### State Transitions

Para os tipos `faturamento`/`performance` (pipeline S4), o ciclo é
`pending → validating → processing → completed|completed_with_errors|failed`.
**Para `tipo='envio_massa'`, esta feature usa um subconjunto degenerado
deliberado**: a linha nasce e morre no mesmo INSERT, direto em um dos 3 estados
terminais — nunca passa pelos estados intermediários. Isso é uma decisão de
design (research.md Decision 9), não uma limitação do schema.

```
(upload processado) ──> INSERT direto em:
                           completed              (100% das linhas válidas)
                           completed_with_errors   (parte inválida)
                           failed                   (parse falhou antes de qualquer linha)
```

## Entity: EnvioMassa (legada, schema intocado)

Tabela pré-existente do fluxo legado (`app_homologacao/backend`). Esta feature
**não adiciona, remove nem altera nenhuma coluna** — apenas passa a ser
acessada também por sessões autenticadas via o hub (mesmas queries, mesmo
`id_empresa` como chave de isolamento, resolvido pelo adaptador de claims).
Fora de escopo detalhar o schema aqui (spec explicitamente exclui "alterar o
schema de `EnvioMassa`/`ProcessControl`").

## Entity: req.user / req.hubContext (contrato de runtime, não é uma tabela)

Estrutura de dados **em memória, por requisição** — o contrato central que o
adaptador de claims (research.md Decision 2) produz e que todo o resto do
fluxo legado consome sem saber a origem.

| Field | Type | Presente quando | Notes |
|-------|------|------------------|-------|
| `req.user.empresaId` | int | sempre (legado nativo ou preenchido pelo adaptador) | chave de isolamento — nunca vem do corpo/query |
| `req.user.id_grupo` | int \| null | sempre | espelha `Empresa.id_grupo` ou o grupo do qual a empresa é pai |
| `req.user.is_grupo_pai` | bool | sempre | idem `POST /login` legado |
| `req.hubContext.viaHub` | bool | só quando a sessão é do hub | gate de RBAC (Decision 5) e de log de importação (Decision 9) |
| `req.hubContext.usuarioId` | int | só quando `viaHub === true` | = `Usuario.id` (hub), usado em `criado_por` |

### State Transitions

N/A — vive só durante o ciclo de vida da requisição HTTP, nunca persistido.
