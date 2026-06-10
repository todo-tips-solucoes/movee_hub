# Data Model: Movimento por Empresa/Filial

**Feature**: `movimento-por-filial` · **Phase 1** · 2026-06-10

**Nenhuma mudança de schema.** Todas as entidades e colunas já existem
(criadas por features anteriores: `Empresa`/`id_grupo` por `config-ui-tenant`
e `cadastro-filiais`; `EnvioMassa` é a tabela base do produto). Este documento
descreve as entidades **como já são** e como o escopo é derivado — não propõe
DDL.

---

## Entity: Empresa (Filial)

Unidade organizacional (PostgREST: tabela `Empresa`).

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | int (PK) | Identificador único da empresa/filial. |
| `nome_empresa` | text | Nome exibido (combobox e header). |
| `id_grupo` | int NULL (FK → `Grupo`) | Grupo ao qual a empresa pertence. NULL = sem grupo. Criado por config-ui-tenant. |
| `email` | text (UNIQUE) | Login. |

**Relacionamentos**:
- N empresas → 1 `Grupo` (via `id_grupo`). A empresa-pai e as filiais
  compartilham o mesmo `id_grupo`.
- 1 empresa → N `EnvioMassa` (via `id_empresa`).

**Estados**: não há máquina de estados; empresa é criada por
`cadastro-filiais` (POST /grupo/empresas) ou registro.

---

## Entity: Movimento (EnvioMassa)

Registro de nota fiscal/XML importado (PostgREST: tabela `EnvioMassa`).
Titular de **exatamente uma** empresa.

| Campo (subset relevante) | Tipo | Notas |
|--------------------------|------|-------|
| `id` | int (PK) | Identificador do registro. |
| `id_empresa` | int (FK → `Empresa.id`) | **Empresa dona do registro.** É a coluna de escopo. |
| `mov_fechado` | bool | `false` = movimento aberto (visível no dashboard); `true` = fechado. |
| `numnota`, `nota_ok`, `erro_validacao`, `cnpj_prestador`, `cnpj_tomador`, `valor`, `dCompet`, `data_emissao`, `uuid`, `dt_inicial`, `dt_final`, ... | vários | Campos de negócio da NFSe (inalterados). |

**Relacionamentos**:
- N `EnvioMassa` → 1 `Empresa` (via `id_empresa`).

**Transições de estado** (`mov_fechado`):
- `false` → `true`: via `POST /close-movimento` (escopado à empresa-alvo).
- Criação: `POST /upload` insere com `id_empresa = <empresa-alvo>` e
  `mov_fechado = false`.

**Invariante de leitura do dashboard**: a listagem mostra apenas
`EnvioMassa?id_empresa=eq.<alvo>&mov_fechado=eq.false`.

---

## Entity: Grupo de Empresas

Agregado formado pela empresa-pai e suas filiais diretas (PostgREST: tabela
`Grupo`, criada por config-ui-tenant).

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | int (PK) | Identificador do grupo (= `id_grupo` nas empresas). |
| `id_empresa_pai` | int (FK → `Empresa.id`) | Empresa administradora do grupo. |

**Escopo derivado (não é coluna — é computado por `resolveScope(req.user)`)**:

| Situação do token (`req.user`) | Escopo retornado |
|--------------------------------|------------------|
| `id_grupo` NULL (sem grupo) | `[empresaId]` |
| `is_grupo_pai === true` | `[empresaId, ...ids dos filhos]` (filhos = `Empresa?id_grupo=eq.<idGrupo>`, excluindo o próprio pai) |
| `id_grupo` presente mas `is_grupo_pai === false` | `[empresaId]` (filho não expande) |

**Invariante crítico (Princípio II, v1.1.0)**: os IDs do escopo saem
**exclusivamente do token JWT** (`empresaId`, `id_grupo`, `is_grupo_pai`),
nunca do corpo/query da requisição. `id_grupo` é coercido a inteiro
(`parseInt`) antes de montar a query PostgREST (anti-injeção), com fail-safe
para escopo individual em qualquer erro.

---

## Empresa-Alvo (conceito derivado desta feature)

Não é uma entidade persistida — é o resultado de
`resolveEmpresaAlvo(req.user, requestedId)`:

```
escopo = resolveScope(req.user)                  // [empresaId, ...filhos]
se requestedId vazio/null  → empresaId           // default backward-compatible
senão                      → parseInt(requestedId)
  se não-inteiro OU ∉ escopo → throw 403
  senão → o inteiro validado
```

A **empresa-alvo** é o `id_empresa` efetivo usado em todas as queries
PostgREST de movimento daquela requisição. Garante que o cliente nunca opera
fora do escopo do seu token.
