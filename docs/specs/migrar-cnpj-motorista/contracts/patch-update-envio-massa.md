# Contrato — PATCH /update-envio-massa/:id (estendido)

Rota **existente** estendida para aceitar e processar `cnpj_prestador`. Demais
campos (`enviado/mensagem/tipo/empresa_id`) mantêm semântica atual — esta
feature **não** regride o fluxo de envio.

Arquivo: `app_homologacao/backend/server.js` (handler em `~:875`).
Middleware: `authenticateToken` (inalterado).

## Request

`PATCH /update-envio-massa/:id`

Path param:
- `id` — id do movimento (EnvioMassa) sendo editado.

Body (JSON) — campos relevantes (camelCase no front, mas o backend lê os nomes
abaixo conforme o handler atual e o PostgREST usam snake_case nas colunas):

| Campo | Tipo | Obrigatório | Notas |
|-------|------|-------------|-------|
| `cnpj_prestador` | string | não | **NOVO comportamento.** Pode vir mascarado; backend normaliza com `onlyDigits`. Se ausente/igual ao atual → no-op de CNPJ |
| `empresa_id` | int | condicional | resolvido por `resolveEmpresaAlvo(req.user, req.body.empresa_id, ...)` — escopo server-side, anti-IDOR. **Nunca confiar cegamente** |
| `enviado` | string | não | inalterado |
| `mensagem` | string | não | inalterado |
| `tipo` | string | não | inalterado |

## Validações (ordem)

1. `idEmp = resolveEmpresaAlvo(req.user, req.body.empresa_id, ctx)` → **403** se
   fora do escopo (comportamento atual, não regredir).
2. Se `cnpj_prestador` presente:
   - `cnpjNovo = onlyDigits(req.body.cnpj_prestador)` (FR-009).
   - `isCNPJ14(cnpjNovo)` falso → **400** `{ error: "CNPJ inválido — deve conter 14 dígitos." }`.
3. Buscar movimento atual escopado:
   `EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}&select=cnpj_prestador`.
   - Vazio → **404** `{ error: "Movimento não encontrado." }` (ownership atômico).
   - `cnpjAntigo = onlyDigits(movimento.cnpj_prestador)`.
4. Idempotência: se `cnpjNovo === cnpjAntigo` → pular toda a lógica de CNPJ
   (movimentos + Motorista); seguir com `enviado/mensagem/tipo` apenas.

## Ordem das operações (quando CNPJ muda)

```
[A] resolveEmpresaAlvo → idEmp (403 se fora do escopo)
[B] validar cnpjNovo (400 se inválido)
[C] buscar movimento atual → cnpjAntigo (404 se não existe na empresa)
[D] se cnpjNovo === cnpjAntigo → NO-OP de CNPJ, ir para [G]
[E] GATE DE GRUPO (SEC-03, guard-clause OBRIGATÓRIA antes de [E1]):
       se NÃO mesmoGrupoQue(idEmp, 6, cache) → PULAR [E1] e [F]-Motorista por completo
       (NENHUM SELECT/PATCH/POST em Motorista para empresa fora do grupo) e ir direto
       para o PATCH em lote dos movimentos. FR-013: a base Motorista é exclusiva do
       grupo Movee — consultá-la para tenant externo já vaza existência de CNPJ (BOLA/API1).
[E1] PRÉ-CHECK 409 (só executa se [E] passou — grupo Movee):
       Motorista?cnpj_prestador=eq.{cnpjNovo}
       existe → 409, ABORTA (nada escrito) — FR-006
[F] PATCH em lote dos movimentos:
       EnvioMassa?id_empresa=eq.{idEmp}&cnpj_prestador=eq.{cnpjAntigo}
       → { cnpj_prestador: cnpjNovo }   (FR-002 + FR-012, inclui enviado=true)
    migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmp, cache)   (FR-010: SÓ após [F]-movimentos OK)
       falha aqui após movimentos OK → 500 + log, SEM reverter (FR-011)
[G] PATCH demais campos do movimento editado (enviado/mensagem/tipo) — fluxo atual
[H] 200
```

> **Nota anti-IDOR (Princípio II / OWASP API4)**: o PATCH em lote [F] filtra
> **sempre** por `id_empresa=eq.${idEmp}` além de `cnpj_prestador`. Nunca trocar
> CNPJ de movimentos de outra empresa que por acaso compartilhem o CNPJ antigo.

## Função `migrarCnpjMotorista(cnpjAntigo, cnpjNovo, idEmpresa, cache)`

Nova função em `server.js`. Idempotente. Loga sem expor segredos.

```
se NÃO mesmoGrupoQue(idEmpresa, 6, cache):
    return { tocou: false }            // FR-013: empresa fora do grupo nunca consulta Motorista
                                       // (defesa em profundidade: pré-check [E] já é gateado por grupo)

existeNovo = Motorista?cnpj_prestador=eq.{cnpjNovo}
se existeNovo:
    throw Conflict409("CNPJ já possui motorista cadastrado — altere manualmente se necessário")  // FR-006

existeAntigo = Motorista?cnpj_prestador=eq.{cnpjAntigo}
se existeAntigo:
    PATCH Motorista?cnpj_prestador=eq.{cnpjAntigo}  { cnpj_prestador: cnpjNovo }   // FR-005 (preserva id/nome/senha/ativo)
senão:
    POST Motorista  { cnpj_prestador: cnpjNovo, ativo: true, senha: null }         // FR-007 (pré-cadastro)
    // SEC-04 (TOCTOU): há janela entre o pré-check [E1] e este POST. Se o POST violar o
    // UNIQUE de cnpj_prestador (race: outra operação criou o novo nesse meio-tempo),
    // mapear o erro para Conflict409 — NÃO 500. O UNIQUE NOT NULL do banco é a barreira
    // atômica real que fecha o TOCTOU; um race legítimo não deve virar "inconsistência 500".

log("[UPDATE][MOTORISTA] migrou <antigo>-><novo> (grupo Movee)")   // sem segredos; nunca logar objeto Motorista completo (carrega hash de senha) — SEC-05
return { tocou: true }
```

## Respostas

| Código | Quando | Body |
|--------|--------|------|
| **200** | Sucesso (com ou sem mudança de CNPJ) | `{ message: "Registro atualizado com sucesso!" }` (ou shape atual da rota) |
| **400** | CNPJ inválido (≠ 14 dígitos após normalizar) | `{ error: "CNPJ inválido — deve conter 14 dígitos." }` |
| **403** | empresa fora do escopo do token | `{ error: "empresa fora do escopo" }` (atual) |
| **404** | movimento não pertence à empresa-alvo | `{ error: "Movimento não encontrado." }` |
| **409** | já existe Motorista com o CNPJ novo (grupo Movee) — pré-check [E1] **ou** violação de UNIQUE no POST de pré-cadastro (race TOCTOU, SEC-04) | `{ error: "CNPJ já possui motorista cadastrado — altere manualmente se necessário" }`. **Nada modificado** |
| **500** | movimentos trocados mas migração do Motorista falhou por erro **não-409** (ex.: PostgREST indisponível) | `{ error: "Inconsistência ao migrar cadastro do motorista. Verifique manualmente." }` + log da inconsistência (sem segredos) — **movimentos NÃO revertidos** (FR-011). Uma violação de UNIQUE NÃO cai aqui: é 409 (SEC-04) |

## Invariantes de segurança (gates de review)

- **IDOR**: todo `postgrestRequest` sobre `EnvioMassa` filtra `id_empresa=eq.${idEmp}` (resolvido server-side). O PATCH em lote NÃO pode vazar para outra empresa.
- **Multi-tenant Motorista (SEC-03)**: nenhum SELECT/PATCH/POST em `Motorista` fora do gate `mesmoGrupoQue(idEmpresa,6,cache)`. O gate é guard-clause EXPLÍCITA antes do pré-check 409 (`[E]` precede `[E1]` na ordem), **não** só dentro de `migrarCnpjMotorista` — um implementador seguindo `[A]..[H]` não pode emitir o SELECT de pré-check para tenant externo. `create-tasks`/`execute-task` devem materializar o gate como primeira instrução do bloco de Motorista.
- **TOCTOU / barreira atômica (SEC-04)**: a janela entre o pré-check `[E1]` e o POST de pré-cadastro é fechada pelo `UNIQUE NOT NULL` de `Motorista.cnpj_prestador`. Violação de UNIQUE no POST → **409** (não 500).
- **Falha parcial**: 500 + log, sem reverter (FR-011). Log nunca expõe senha/segredo; **nunca** logar o objeto `Motorista` completo no catch do 500 (carrega hash de senha) — SEC-05.
- **Sem regressão**: `enviado/men1/men2/tipo` mantêm semântica atual.
