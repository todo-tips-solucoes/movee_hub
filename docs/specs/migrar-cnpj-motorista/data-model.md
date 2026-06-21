# Data Model — migrar-cnpj-motorista

**Sem DDL.** Esta feature não cria nem altera schema. Apenas passa a usar
colunas já existentes em duas tabelas. Confirmação read-only obrigatória antes
de codar (ver §Confirmação).

## Entity: EnvioMassa (movimento)

Tabela de movimentos/lançamentos de envio em massa, escopada por empresa.

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | bigserial PK | identificador do movimento |
| `id_empresa` | int/bigint | tenant scope — **todo acesso filtra por este** (Princípio II) |
| `cnpj_prestador` | text | CNPJ do prestador (14 dígitos normalizados). **Hoje editável na UI mas ignorado no PATCH** (bug FR-001) |
| `enviado` | text/enum | status de envio; **não é filtro** da troca em lote (FR-012: troca abrange `enviado=true` também) |
| `mensagem` / `tipo` | text | demais campos editáveis (inalterados por esta feature) |
| ... | ... | demais colunas do movimento (não tocadas) |

**Relacionamento lógico** (não FK física): `EnvioMassa.cnpj_prestador`
↔ `Motorista.cnpj_prestador` (só para movimentos do grupo Movee).

**State transition relevante** (CNPJ):
```
movimento.cnpj_prestador = ANTIGO
        │  admin edita CNPJ (grupo da empresa) → PATCH /update-envio-massa/:id
        ▼
TODOS os movimentos da MESMA empresa com cnpj_prestador=ANTIGO → NOVO
        (FR-002 + FR-012: independe de `enviado`)
```

## Entity: Motorista (login do app motorista) — EXCLUSIVA do grupo Movee

Pré-cadastro / login do app motorista. Definida em
`backend/db/001_create_motorista.sql`. **Só contém motoristas do grupo Movee.**

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | bigserial PK | id físico (preservado na migração — FR-005) |
| `cnpj_prestador` | text **UNIQUE NOT NULL** | **identidade de login** (normalizado, só dígitos). Já indexado por ser UNIQUE |
| `senha` | text **nullable** | `NULL` = pré-cadastro sem senha (migração 008). Preservada na migração de CNPJ (FR-005) |
| `nome` | text | preservado na migração (FR-005) |
| `ativo` | boolean default true | preservado na migração; `true` no pré-cadastro (FR-007) |
| `created_at` | timestamp | inalterado |

**Invariante crítico (Princípio II + FR-013)**: nenhuma leitura nem escrita
em `Motorista` para empresas **fora** do grupo Movee. O gate é
`mesmoGrupoQue(idEmpresa, 6, cache)` (nunca `id_empresa === 6` estrito).

**State transitions** (na migração de CNPJ, só grupo Movee):
```
                    ┌─ existe Motorista(cnpj=NOVO)?  ── SIM ──▶ 409, aborta tudo (FR-006)
                    │                                          (pré-check ANTES dos movimentos)
chave = cnpj_prestador
                    │
                    └─ NÃO ─┬─ existe Motorista(cnpj=ANTIGO)? ─ SIM ─▶ PATCH cnpj=NOVO
                            │                                         (preserva id/nome/senha/ativo) FR-005
                            │
                            └─ NÃO ─▶ POST pré-cadastro {cnpj:NOVO, ativo:true, senha:null} FR-007
```

Idempotência: re-rodar com o CNPJ já migrado → `PATCH cnpj=eq.{ANTIGO}` afeta
0 linhas (o registro já está em NOVO); `cnpjNovo===cnpjAntigo` → no-op total.

## Confirmação read-only obrigatória (antes de codar)

Artefato SQL para o operador rodar (sem escrita; agente não acessa produção):

```sql
-- 1. Confirmar que EnvioMassa.cnpj_prestador existe
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'EnvioMassa' AND column_name = 'cnpj_prestador';

-- 2. Confirmar schema de Motorista
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'Motorista'
 ORDER BY ordinal_position;
```

Esperado: (1) retorna 1 linha (`text`); (2) confirma `cnpj_prestador text NOT NULL`,
`senha text YES`, `ativo boolean`. Se (1) vier vazio, a premissa "sem DDL" cai
e a feature precisa de migração — re-abrir plano.
