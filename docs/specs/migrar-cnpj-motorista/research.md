# Research — migrar-cnpj-motorista

Phase 0. Todos os NEEDS CLARIFICATION foram resolvidos no clarify
(dec-007..dec-010 / FR-011..FR-014). Esta pesquisa consolida as decisões
técnicas que sustentam o design.

## Decision 1 — Onde estender o backend

**Decision**: Estender a rota existente `PATCH /update-envio-massa/:id`
(`app_homologacao/backend/server.js:~875`) em vez de criar nova rota.

**Rationale**: O front (`edit-dialog.tsx`) já envia `cnpj_prestador` no body
do mesmo PATCH que envia `enviado/mensagem/tipo`. O handler atual extrai
apenas `{ enviado, mensagem, tipo }` e **ignora** `cnpj_prestador` — esse é o
bug raiz (FR-001). Reusar a rota evita um segundo round-trip no front e
preserva o fluxo de UI existente (um único Salvar). A rota já tem o gate
multi-tenant correto: `resolveEmpresaAlvo(req.user, req.body.empresa_id, ...)`
+ filtro composto `id=eq.${id}&id_empresa=eq.${idEmp}` (anti-IDOR, OWASP
API4:2023 / CWE-862) — não regredir.

**Alternatives considered**:
- Nova rota `POST /migrar-cnpj` dedicada → rejeitada: duplicaria o gate de
  escopo e exigiria 2 chamadas no front (salvar movimento + migrar).
- Trigger no banco (PostgreSQL) → rejeitada: a regra de grupo Movee
  (`mesmoGrupoQue`) vive no Node e depende de cache em memória; mover para o
  banco acoplaria lógica de tenant ao DDL e violaria "sem DDL".

## Decision 2 — Ordem das operações e atomicidade

**Decision**: Ordem fixa: (1) validação de input → (2) buscar movimento atual
para obter `cnpjAntigo` + validar ownership → (3) pré-check de conflito 409
(só grupo Movee) → (4) PATCH em lote dos movimentos (`cnpjAntigo`→`cnpjNovo`,
escopado por `id_empresa`) → (5) `migrarCnpjMotorista` (só grupo Movee).
Sem transação cross-request (PostgREST não oferece). Falha parcial após (4)
→ HTTP 500 + log, **sem reverter** (FR-011).

**Rationale**: FR-010 exige migração do motorista **somente após** o sucesso
dos movimentos. O pré-check 409 vem **antes** de qualquer escrita (FR-006:
"sem modificar nenhum dado") para que uma colisão aborte cedo, sem deixar
movimentos já trocados. Reverter um PATCH em lote sem transação atômica é
inseguro (pode falhar a si mesmo e piorar a inconsistência) — por isso a
decisão é logar e retornar 500 claro (dec-007).

**Alternatives considered**:
- Migrar `Motorista` antes dos movimentos → rejeitada: viola FR-010.
- Reverter movimentos no catch → rejeitada (dec-007): reversão em lote sem
  transação é insegura e pode falhar, mascarando a inconsistência real.
- 2PC / saga → rejeitada: over-engineering para uma correção de digitação de
  baixo volume; o operador pode re-tentar a migração do motorista
  manualmente (operação idempotente).

## Decision 3 — Idempotência

**Decision**: Se `cnpjNovo === cnpjAntigo` (após `onlyDigits`), tratar a parte
de CNPJ como **no-op** (não tocar movimentos por CNPJ nem `Motorista`); o
resto do PATCH (`enviado/mensagem/tipo`) segue normal. O PATCH em lote do
`Motorista` (`cnpj_prestador=eq.{antigo}` → `{novo}`) é naturalmente
idempotente: re-rodar com o antigo já migrado afeta 0 linhas.

**Rationale**: Editar o movimento sem mexer no CNPJ não deve disparar
migração nem 409. Idempotência protege contra duplo-clique no Salvar e
re-tentativas após 500 parcial (dec-007).

**Alternatives considered**: detectar mudança comparando com o banco a cada
campo → desnecessário; basta comparar `cnpjNovo` vs `cnpjAntigo` do movimento
buscado em (2).

## Decision 4 — Conflito 409 e pré-cadastro (FR-006 / FR-007)

**Decision**: Dentro de `migrarCnpjMotorista`, só para grupo Movee:
1. `Motorista?cnpj_prestador=eq.{cnpjNovo}` → se existe linha, **409** com
   mensagem legível ("CNPJ já possui motorista cadastrado — altere manualmente
   se necessário"), sem escrever nada. **Mas o pré-check 409 roda ANTES dos
   movimentos** (ver Decision 2) — a função `migrarCnpjMotorista` o repete como
   defesa em profundidade (idempotente; a janela entre pré-check e migração é
   curta e single-tenant).
2. `Motorista?cnpj_prestador=eq.{cnpjAntigo}` → existe: `PATCH` para `{novo}`
   (preserva `id/nome/senha/ativo`, FR-005). Não existe: `POST` pré-cadastro
   `{ cnpj_prestador: novo, ativo: true, senha: null }` (FR-007), espelhando o
   padrão de `upsertMotoristasFromLote`.

**Rationale**: Fundir contas distintas comprometeria autenticação (senhas) —
a recusa explícita (P2) é mais segura que merge automático. Pré-cadastro
com `senha=null` é o mesmo estado que `upsertMotoristasFromLote` cria; o
motorista define senha no primeiro `/register`.

**Alternatives considered**: merge automático de contas no 409 → rejeitada
(risco de credenciais, P2).

## Decision 5 — Validação CNPJ no front (FR-008)

**Decision**: No `edit-dialog.tsx`, transformar o campo `cnpj_prestador` em
input com máscara visual + normalização para 14 dígitos. Desabilitar o botão
Salvar enquanto `onlyDigits(valor).length !== 14` (apenas quando o campo foi
tocado / valor não-vazio, para não travar edições que não mexem no CNPJ).
Aviso fixo no diálogo: "Isto também atualizará o login do motorista no app."
(FR-014, texto fixo para todos — sem detectar grupo no client).

**Rationale**: FR-008 exige feedback de validação antes do envio; o backend
re-valida (400) como fonte da verdade. Aviso fixo evita expor pertencimento ao
grupo Movee ao cliente (FR-014). Front envia sempre os 14 dígitos crus
(normalizados) — o backend re-normaliza com `onlyDigits` (defesa em
profundidade, FR-009).

**Alternatives considered**: validar dígito-verificador de CNPJ no front →
fora de escopo (spec pede só "14 dígitos numéricos"; `isCNPJ14` no backend
checa formato, não DV).

## Decision 6 — Modelo de dados (sem DDL)

**Decision**: Nenhuma migração SQL. `EnvioMassa.cnpj_prestador` já existe
(é editado hoje na UI, só ignorado no PATCH). `Motorista.cnpj_prestador` é
`text UNIQUE NOT NULL` (identidade de login). Confirmar existência da coluna
em `EnvioMassa` via `SELECT` read-only (artefato; aplicação pelo operador,
sem escrita) antes de codar — defesa documentada, não bloqueante.

**Rationale**: A feature é puramente comportamental (passar a usar uma coluna
já existente + tocar uma tabela existente). DDL violaria "sem DDL" e exigiria
rito de produção desnecessário.

**Alternatives considered**: adicionar índice em `Motorista.cnpj_prestador`
→ desnecessário (já é `UNIQUE`, logo indexado).
