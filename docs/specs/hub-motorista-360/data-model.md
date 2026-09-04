# Data Model: Hub Motorista 360

Todas as tabelas/colunas já existentes citadas abaixo foram confirmadas por
leitura direta das migrations em `infra/hub/migrations/` nesta sessão
(Constitution VI). Colunas/migração **novas** propostas por este plano estão
marcadas `[NOVO]`; o número de arquivo de migration exato
(`infra/hub/migrations/NNNN_*.sql`) é resolvido em `create-tasks`/
`execute-task` contra o estado real do diretório no momento (hoje o próximo
livre é `0057`, ver `research.md`).

## Entity: `Entregador` (hub — já existente, migration 0010; estendida)

Tabela já existente. Campos atuais (não alterados):

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| id_empresa | int | NOT NULL | referência lógica a `Empresa.id` (legado) |
| id_externo | uuid | NOT NULL, UNIQUE (id_empresa, id_externo) | UUID EntreGô — chave de busca do FR-006 (já resolvido em clarify) |
| nome | text | NULL | |
| motorista_id | int | NULL, FK → `ContaMotorista(id)`, UNIQUE parcial (migration 0021) | vínculo de credencial |
| ativo | boolean | NOT NULL DEFAULT true | |
| criado_em / atualizado_em | timestamptz | NOT NULL DEFAULT now() | |

**Colunas novas `[NOVO]`** (esta feature, FR-001..FR-004, FR-016):

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| dados_entrego_json | jsonb | NULL | payload enriquecido — shape interno controlado pelo hub (ver nota de shape abaixo), não é cópia literal do payload da EntreGô (que é `[PROPOSTA]`, Decision 9 de `research.md`) |
| dados_entrego_enriquecidos_em | timestamptz | NULL | último enriquecimento bem-sucedido; `NULL` = nunca enriquecido (User Story 2, cenário 3: "sistema informa que falta associar identificador" continua sendo o gate de `id_externo`, não este campo). Também é o seletor da rotina semestral (FR-016): `< now() - interval '6 months'` |
| dados_entrego_solicitado_em | timestamptz | NULL | pedido pendente de busca sob demanda (FR-005); setado por `POST /motoristas/:id/entrego-enriquecimento`, limpo pelo worker de `infra/robo-entrego/` ao concluir (sucesso ou falha definitiva) |

**Shape interno de `dados_entrego_json`** (nomes de chave escolhidos pelo
hub — internos, não afirmam nome de campo da EntreGô, que segue
`[PROPOSTA]` até ser confirmado empiricamente):

```json
{
  "dadosPessoais": { "nomeCompleto": "", "dataNascimento": "", "email": "", "cpf": "", "nomeMae": "", "nomePai": "", "telefone": "" },
  "documentos": { "rg": "", "cnh": "" },
  "contatoEmergencia": { "grauParentesco": "", "nome": "", "telefone": "" },
  "informacoesEntrega": { "operadorLogistico": "", "modal": "" }
}
```

### Relationships

- `Entregador` N:1 `ContaMotorista` via `motorista_id` (já existente, migration 0021).

## Entity: `ContaMotorista` (hub — já existente, migration 0021; sem alteração de schema)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | serial | PK | |
| cnpj_prestador | text | NOT NULL UNIQUE | **chave de vínculo automático (FR-009)** e fonte do CNPJ exibido (FR-008 — Decision 3 de `research.md`) |
| nome | text | NOT NULL | |
| ativo | boolean | NOT NULL DEFAULT true | |
| cadastro_completo | boolean | NOT NULL DEFAULT true | |
| criado_em / atualizado_em | timestamptz | NOT NULL DEFAULT now() | |

Nenhuma coluna nova. Reaproveitada tal como está — o vínculo automático
(FR-009) e o backfill (FR-012) usam o `POST`/lookup por `cnpj_prestador`
já existente na mesma tabela.

## Entity: `Motorista` (legado — `chatmasterveloz`, fora do banco do hub — sem alteração)

Referência LÓGICA, sem FK física (mesmo padrão já usado para `Entregador.id_empresa`).

| Field | Type | Notes |
|-------|------|-------|
| cnpj_prestador | text | chave de vínculo (join com `ContaMotorista.cnpj_prestador`) |
| nome | text | |
| ativo | boolean | |
| senha | text (hash) | `NOT NULL` = credencial ativada (gate do hook automático, `research.md` Decision 1) |

Sem coluna de empresa (CLAUDE.md, base curada só populada para grupo Movee).

## Function: `hub_motoristas_candidatos_por_conta` (hub — nova, simétrica à 0023)

`[PROPOSTA]`. Mesmo padrão exato de
`hub_motoristas_candidatos(p_entregador_id)` (migration 0023,
`SECURITY INVOKER`, `hub_normaliza_nome`, `pg_trgm`, join
`EmpresaGrupoMovee`), invertendo qual lado é fixo:

```sql
CREATE OR REPLACE FUNCTION hub_motoristas_candidatos_por_conta(p_conta_motorista_id int)
RETURNS TABLE (entregador_id int, nome text, id_empresa int, similaridade real)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH alvo AS (SELECT nome FROM "ContaMotorista" WHERE id = p_conta_motorista_id)
    SELECT e.id, e.nome, e.id_empresa,
           similarity(hub_normaliza_nome(e.nome), hub_normaliza_nome(alvo.nome))
    FROM alvo
    JOIN "Entregador" e ON e.motorista_id IS NULL
    JOIN "EmpresaGrupoMovee" g ON g.id_empresa = e.id_empresa
    WHERE similarity(hub_normaliza_nome(e.nome), hub_normaliza_nome(alvo.nome)) >= 0.3
    ORDER BY 4 DESC LIMIT 10;
$$;
```

Usada pelo hook automático (FR-009) e pelo backfill (FR-012) com um
threshold de decisão MAIS ESTRITO (>= 0.9, exatamente 1 candidato) do que o
retornado pela função (0.3, mesmo piso da 0023) — o piso de retorno da
função é permissivo de propósito; quem decide "vincula ou não" é a
aplicação chamadora, não a função (research.md Decision 12). SQL acima é
esboço de referência para `create-tasks`, não migration final.

## Entity: `Permissao` / `PapelPermissao` / `Papel` (hub — já existentes, migration 0003; seeds novos)

Schema confirmado via `infra/hub/migrations/0044_seed_permissao_motoristas_credencial.sql`
(mesmas tabelas, sem alteração de schema — apenas INSERTs novos):

- `Permissao(codigo, modulo_id)` — novo registro `codigo = 'motoristas.dados_sensiveis'`
  `[PROPOSTA]` (research.md Decision 10), `modulo_id` = id do módulo `motoristas`.
- `PapelPermissao(papel_id, permissao_id)` — concede a `admin_plataforma` e
  `admin_entidade` apenas (mesmo padrão do seed 0044).
- Permissões novas para o papel de serviço `robo_entrego_servico`
  (já existente, `infra/robo-entrego/sql/001-*.sql`):
  `motoristas.enriquecimento.consultar` / `motoristas.enriquecimento.atualizar`
  `[PROPOSTA]` (research.md Decision 11) — script SQL avulso adicional,
  aplicado manualmente pelo operador (rito de produção).

### State Transitions

`Entregador.dados_entrego_solicitado_em` (fila sob demanda, FR-005):

```
NULL (sem pedido) → timestamp (pedido registrado, POST /entrego-enriquecimento)
  → NULL (worker processa: sucesso -> dados_entrego_json + dados_entrego_enriquecidos_em
          atualizados; falha definitiva -> apenas limpo, sem dado gravado —
          FR-007: não descarta dado enriquecido em busca ANTERIOR)
```

`Entregador.motorista_id` (vínculo de credencial, FR-009/FR-011):

```
NULL (sem vínculo) → id de ContaMotorista (vínculo manual, automático, ou
  backfill — idempotente: FR-011 exige que um segundo cadastro no app do
  motorista para o MESMO motorista NUNCA sobrescreva um vínculo já existente)
```
