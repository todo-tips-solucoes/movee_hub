# Research — Validação de XML em Lote Idempotente

Phase 0. Todos os NEEDS CLARIFICATION foram resolvidos no `/clarify` (spec §Clarifications,
plano mestre §12). Este documento consolida as decisões técnicas que sustentam o design.

---

## Decision 1 — Extração da chave de acesso e numnota do XML

**Decision**: Os 3 XMLs reais (`docs/nota_entrego/`) são do **padrão NACIONAL NFS-e**
(`sped.fazenda.gov.br/nfse`, `<NFSe versao="1.01">`), não ABRASF municipal. Mapa de extração:

| Campo | Caminho no XML | Regra |
|-------|----------------|-------|
| chave de acesso (50 díg.) | atributo `Id` de `<infNFSe>` | `Id.replace(/^NFS/, '')` |
| `numnota` | `<nNFSe>` | NÃO usar `<nDPS>` nem `<nDFSe>` |
| `cnpj_prestador` | `<emit><CNPJ>` (= `<prest><CNPJ>` em `infDPS`) | — |
| `data_emissao` | `<dhEmi>` (em `infDPS`); fallback `<dhProc>` (em `infNFSe`) | normalizar por dia p/ fallback |
| `valor` | `<vLiq>`; fallback `<vServ>` | apenas leitura — **não regravar** (P5) |
| tomador | `<toma><CNPJ>` | nos fixtures = `48904673000100` (MOVEE) → grupo Movee → FastAPI não-nexus |

**Rationale**: o nome do arquivo XML é exatamente a chave de 50 dígitos (sem prefixo), então o
fallback de chave = basename do `filename`, no MESMO formato que `getNFeKeyFromNotaOk` deriva do
`nota_ok` existente — casamento direto. Ao codar, **verificar** como `getNFeKeyFromNotaOk`
(server.js:1705) normaliza o basename (remove `.xml`, query string) e garantir que a chave
extraída do XML novo (50 díg., sem `NFS`) e a derivada do `nota_ok` fiquem no mesmo formato antes
de comparar.

**Alternatives considered**: extrair apenas do `Id` (rejeitado — defensivo exige fallback por
filename); assumir layout ABRASF municipal (rejeitado — fixtures confirmam padrão nacional). A
extração deve ser **defensiva e multi-layout** (campo `null` → cai no fallback), mas **ancorada**
no padrão nacional para os casos reais de hoje.

---

## Decision 2 — Estratégia de casamento XML ↔ movimento

**Decision**: Helper `findMovimentoParaXml(movimentosAbertos, fields)` retorna
`{ movimento, criterio }` ou `null`, onde `criterio ∈ {chave, fallback, none}`:
- **primário (`chave`)**: índice por chave construído via `getNFeKeyFromNotaOk` de cada movimento
  aberto; compara com a chave extraída do XML.
- **fallback**: índice por `cnpj_prestador + numnota + data_emissao` (por dia, sem hora) quando
  a chave está ausente ou não casa.

Movimentos abertos são carregados **UMA vez por lote** (não por arquivo): mesmo `select` da
server.js:1649 filtrando `mov_fechado=eq.false` + `id_empresa` (empresa-alvo).

**Rationale**: FR-002/FR-003/FR-004. Carregar uma vez evita N queries no PostgREST e dá
consistência intra-lote. Índices em memória → O(1) por arquivo.

**Alternatives considered**: query por arquivo (rejeitado — N+1, lento, sem ganho); casamento só
por chave (rejeitado — fallback é requisito FR-003 para XMLs sem chave legível).

---

## Decision 3 — Persistência idempotente (árvore de decisão §4)

**Decision**: Após o casamento, aplicar a árvore:

| Situação do movimento casado | Ação | Status | Grava? |
|------------------------------|------|--------|--------|
| Aprovado (`nota_ok` cheio + `erro_validacao` vazio) | **skip** | `ja_validada` | **NÃO** |
| Reprovado (`nota_ok` cheio + `erro_validacao` cheio) | revalida na FastAPI + `PATCH` | `revalidada` | SIM |
| Sem validação (`nota_ok` vazio) | valida na FastAPI + `PATCH` | `validada` | SIM |
| Chave já apareceu antes no MESMO lote | dedup (valida 1x) | `duplicada_no_lote` | NÃO (2ª+) |
| Nenhum movimento casado | reporta | `sem_movimento` | **NÃO insere** (P3) |
| Erro de parsing/serviço | reporta | `erro` | NÃO |

`PATCH EnvioMassa?id=eq.<id>` grava **apenas** `nota_ok` e `erro_validacao`. **Nunca** altera o
valor financeiro (P5).

**Rationale**: FR-006…FR-012 + clarify P3/P4/P5. Idempotência (FR-011): reenviar o mesmo lote
produz o mesmo conjunto de status; aprovadas retornam `ja_validada` sem efeito colateral. Chave =
`id` interno do movimento (FR-012) → nunca cria duplicata.

**Alternatives considered**: `UPSERT` por chave de acesso (rejeitado — exigiria DDL de coluna
`chave_nfse`, fora de escopo P2); inserir registro novo no `sem_movimento` (rejeitado por P3 —
poluiria a base com movimentos sem origem).

---

## Decision 4 — Enum de status SUBSTITUI flags booleanas (clarify Q4)

**Decision**: No `ValidationRow` (resposta + tipo FE), o **enum** `status`
(`ja_validada|validada|revalidada|duplicada_no_lote|sem_movimento|erro`) + `match_criterio`
(`chave|fallback|none`) + `movimento_id` **substituem** as flags booleanas atuais
(`valid`, `valid_cnpj_prestador`, `valid_valor`). `stats` ganha contadores por status.

**Rationale**: Q4 fixou que o novo enum substitui (não coexiste com) os booleanos — evita estado
ambíguo (ex.: `valid=true` + `status=ja_validada`) e simplifica o badge no FE (um status → um
ícone+cor+texto). Como a resposta atual é consumida só por este FE (proxy `/api/*`), a
substituição é segura desde que FE e BE mudem juntos (mesma PR).

**Alternatives considered**: manter booleanos + adicionar enum (rejeitado por Q4 — duplicação e
ambiguidade); versionar o endpoint (rejeitado — overkill, consumidor único interno).

---

## Decision 5 — Rate-limit condicional à chamada da FastAPI

**Decision**: O delay de 2 s entre arquivos (hoje em server.js:1993-1995, incondicional) passa a
ocorrer **apenas quando houve chamada real à FastAPI** (status `validada`/`revalidada`). Linhas
`ja_validada`/`duplicada_no_lote`/`sem_movimento`/`erro-de-parsing` **não esperam**.

**Rationale**: o rate-limit existe para não saturar a FastAPI; sem chamada não há o que limitar.
Lotes de reenvio (maioria `ja_validada`) ficam muito mais rápidos. Preserva a intenção original.

**Alternatives considered**: remover o rate-limit (rejeitado — protege o serviço externo); manter
incondicional (rejeitado — penaliza o caso idempotente comum sem motivo).

---

## Decision 6 — Erro de negócio × erro de infraestrutura

**Decision**: Manter a regra de domínio do `CLAUDE.md`/constituição:
- **negócio** — FastAPI responde 4xx com `detail` → propagar a mensagem real como
  `erro_validacao` (nota reprovada com motivo legível).
- **infra** — timeout / 5xx / sem resposta → status `erro` com mensagem genérica "serviço de
  validação indisponível"; **não** grava resultado de negócio falso.

A resiliência do lote (FR-015) garante que falha em uma linha não interrompe as demais.

**Rationale**: FR-014 + regra existente em `routes/motorista.js` (validar-nota single). Não
mascarar regra de negócio como indisponibilidade.

**Alternatives considered**: tratar todo erro como infra (rejeitado — esconde reprovação real);
abortar o lote no 1º erro (rejeitado por FR-015).

---

## Decision 7 — Roteamento FastAPI por grupo (preservar)

**Decision**: Manter `mesmoGrupoQue(empresaId, 6)` para escolher o endpoint: grupo Movee →
`fastapihomologacao/validade_nfse` (não-nexus, `id_empresa=6`); demais → `fastapihomologacaonexus`
(`nexus=true`). Já implementado (server.js:1944-1958) — **não regredir**.

**Rationale**: regra de domínio NON-NEGOTIABLE do `CLAUDE.md`. **Escopo (Q3)**: `mesmoGrupoQue`
afeta SÓ o roteamento da FastAPI; o **casamento de movimentos** é estritamente por `id_empresa`
da empresa-alvo (`resolveEmpresaAlvo`), nunca expandido para o grupo — sem vazamento entre
tenants.

**Alternatives considered**: usar `mesmoGrupoQue` também para casar movimentos do grupo (rejeitado
por Q3 — violaria isolamento multi-tenant do movimento por empresa/filial).

---

## Decisões de infraestrutura — N/A explícito

A feature é **stateless**: evolução de um handler HTTP existente + tipos de UI. **Não há**
scheduling, novas keys/segredos, refresh token, cache, fila ou store novo. Nenhuma decisão de
infraestrutura aplicável. **SEM DDL** (P2). **SEM build/deploy** pelo agente (rito é do operador).
