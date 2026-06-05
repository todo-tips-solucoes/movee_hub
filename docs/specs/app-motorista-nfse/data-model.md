# Data Model — App Motorista (PWA)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04 | **Fase**: Phase 1

Camada de dados: **PostgREST** sobre PostgreSQL (já existente). Colunas em
`snake_case` (fonte da verdade). Mapeamento para DTO em `camelCase` no backend.

---

## Entity: Motorista (NOVA tabela)

Identidade que autentica no app. Provisionada externamente no MVP (ver research.md
Decision 3).

| Campo | Tipo | Constraints | Notas |
|-------|------|-------------|-------|
| `id` | bigint | PK, auto | identificador |
| `cnpj_prestador` | text | UNIQUE, NOT NULL | chave de login; casa com `EnvioMassa.cnpj_prestador` |
| `senha` | text | NOT NULL | hash **bcrypt** (nunca texto plano — Constituição I) |
| `nome` | text | NULL | nome do motorista (exibição) |
| `ativo` | boolean | default `true` | login negado se `false` |
| `created_at` | timestamptz | default `now()` | auditoria |

**Relacionamentos**: `Motorista.cnpj_prestador` → `EnvioMassa.cnpj_prestador`
(1 motorista : N registros de movimento). Não há FK rígida no PostgREST; o vínculo é
pelo valor de `cnpj_prestador`.

**Regras**:
- Login: `Motorista?cnpj_prestador=eq.{input}` + `bcrypt.compare(senha)` + `ativo=true`.
- O token NUNCA carrega a senha; carrega apenas `cnpjPrestador` (+ `nome`).
- **Cadastro (auto, R-2 / FR-017)**: só cria conta se `cnpj_prestador` já existir em
  `EnvioMassa` e ainda não houver `Motorista` com esse CNPJ (guard anti-enumeração).

> Migração necessária: criar a tabela `Motorista`. SQL de criação vai junto da tarefa
> de backend (idempotente, `CREATE TABLE IF NOT EXISTS`). Nenhuma outra tabela muda.

---

## Entity: EnvioMassa (EXISTENTE — sem alteração de schema)

Movimento de apuração/pagamento. Colunas já presentes no schema (confirmado na
exploração do código). O App Motorista **lê** o movimento aberto e **escreve** apenas
`nota_ok` / `erro_validacao`.

| Campo | Tipo | Uso no App Motorista |
|-------|------|----------------------|
| `id` | bigint | identifica o movimento p/ PATCH |
| `id_empresa` | bigint | (não usado no escopo do motorista) |
| `cnpj_prestador` | text | **filtro de escopo** do motorista |
| `mov_fechado` | boolean | **filtro**: só `false` (movimento aberto) |
| `valor` | numeric/text | exibido (Valor) |
| `dt_inicial` | date/text | exibido (período) |
| `dt_final` | date/text | exibido (período) |
| `nome` | text | exibido (Nome) |
| `cnpj_tomador` | text | exibido (CNPJ Tomador) |
| `tribnac` | text | exibido (TribNac) |
| `nota_ok` | text/bool | **escrito** após validação ok; governa bloqueio de reenvio |
| `erro_validacao` | text | **escrito**: campos reprovados quando inválida |
| `numnota` / `data_emissao` / `dCompet` / `uuid` | vários | metadados da nota (opcional) |

**State transitions de `nota_ok`** (por registro de movimento aberto):

```
[sem nota]  --upload+validação ok-->  [nota_ok = sim]  (reenvio BLOQUEADO)
     |
     +--validação inválida-->  [nota_ok não setado, erro_validacao = {campos}]  (reenvio permitido)
     |
     +--falha temporária do serviço-->  [estado inalterado]  (reenvio permitido)
```

**Invariantes**:
- Reenvio só é permitido enquanto `nota_ok` não estiver afirmativo para o movimento.
- `erro_validacao` é sobrescrito a cada nova tentativa inválida; limpo/ignorado quando
  `nota_ok` passa a afirmativo.
- Toda leitura/escrita é escopada por `cnpj_prestador` do token (Constituição II).

---

## Entity: ResultadoValidacao (transiente — não persistida como tabela)

Resposta do serviço externo `validade_nfse`, interpretada pelo backend e refletida em
`EnvioMassa.nota_ok`/`erro_validacao`. Shape (array de 1 item):

| Campo | Tipo | Significado |
|-------|------|-------------|
| `valid` | boolean | veredito geral |
| `details.valid_cnpj_prestador` | boolean | CNPJ prestador confere |
| `details.valid_cnpj` | boolean | CNPJ (tomador) confere |
| `details.valid_descricao_servico` | boolean | descrição do serviço |
| `details.valid_valor` | boolean | valor confere |
| `details.valid_trib_nac` | boolean | tributação nacional |
| `details.valid_trib_mun` | boolean | tributação municipal |
| `details.valid_dCompet` | boolean | competência (data) |

**Mapeamento campo → mensagem ao motorista** (FR-009; pt-BR, exibido quando `false`):

| Flag | Mensagem ao motorista |
|------|------------------------|
| `valid_cnpj_prestador` | "CNPJ do prestador (você) está incorreto na nota." |
| `valid_cnpj` | "CNPJ do tomador está incorreto na nota." |
| `valid_descricao_servico` | "Descrição do serviço está incorreta." |
| `valid_valor` | "Valor da nota não confere com o valor do movimento." |
| `valid_trib_nac` | "Tributação nacional (TribNac) está incorreta." |
| `valid_trib_mun` | "Tributação municipal está incorreta." |
| `valid_dCompet` | "Data de competência (dCompet) está incorreta." |

> Quando inválida, exibir só as flags `false`, seguidas da instrução padrão:
> "Cancele esta nota e emita uma nova com os campos corrigidos."
