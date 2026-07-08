# Research — Módulo Motoristas (hub-motoristas / S5)

Phase 0 do `/plan`. Resolve os unknowns técnicos antes do design (data-model,
contracts). Fontes canônicas: `docs/plans/hub-frota/01-plano-tecnico.md` §9.2,
§13, §14, D3 em §18; briefing `docs/plans/hub-frota/briefings/s5-modulo-motoristas.md`;
CLAUDE.md (regras de domínio da base `Motorista`); Clarifications integradas em
`spec.md` (Q1–Q5). Estado real da S2/S3/S4 verificado no código (não presumido).

---

## Decision 1 — Série de migrations continua em `infra/hub/migrations/`, próxima = `0019`

**Decision**: as migrations desta fase começam em `0019_*.sql`, continuando a
série física única do hub (última aplicada = `0018_dedupe_erro_recuperacao_orfa.sql`,
verificado por `ls infra/hub/migrations/`). Aplicadas por `infra/hub/scripts/migrate.sh`
(registra `SchemaMigration` + `SIGUSR1` no PostgREST). Todas idempotentes.

**Rationale**: mesmo raciocínio já ratificado em `docs/specs/hub-importacoes/research.md`
Decision 1 — o rótulo "011+" do plano mestre é lógico, não físico; a série real
no repo está em `0018`. `app_homologacao/backend/db/011+` continua sem runner que
a aplique contra o banco do hub.

---

## Decision 2 — Origem dos dados de `Motorista` para sugestão/vínculo: espelho local `ContaMotorista`

**Decision**: como o banco do hub (`hub_dev`/`hub_test`/`hub_homolog`) é **isolado**
por desenho (G1/G2) e a tabela `Motorista` mora fisicamente em `chatmasterveloz`
(produção), esta fase introduz uma tabela nova e local ao hub — `ContaMotorista`
— que espelha os campos de `Motorista` relevantes para busca/sugestão por nome
(`cnpj_prestador`, `nome`, `ativo`, `cadastro_completo`). O algoritmo de
similaridade (FR-007) roda **inteiramente** sobre `ContaMotorista`, nunca contra
`chatmasterveloz`. A elegibilidade de grupo (FR-010/FR-011) é resolvida por uma
segunda tabela nova, `EmpresaGrupoMovee` (allowlist de `id_empresa`), consultada
antes de expor qualquer candidato. Ambas as tabelas são populadas por **seed**
(mesmo mecanismo de `infra/hub/seeds/` + `infra/hub/scripts/gen-seeds.py` já usado
para os demais dados sintéticos do ambiente isolado) — nunca por sincronização ao
vivo com produção.

**Rationale** (evidência literal do código, não suposição):
1. `infra/hub/migrations/0010_entregador.sql` já registra a decisão original:
   `motorista_id` é "referência LÓGICA... SEM FK física — Motorista mora fora do
   banco do hub". Ou seja, a ausência de acesso direto já era um fato conhecido e
   aceito desde a S4 — esta fase só precisa decidir COMO tornar essa referência
   operável (buscável, sugestionável) dentro do isolamento.
2. `infra/hub/migrations/0006_rls_policies.sql` linhas 11-12 e 27-28: "RLS NUNCA
   se estende às tabelas legadas Empresa/Motorista/EnvioMassa/chatmasterveloz" e
   "`mesmoGrupoQue`/`resolveScope` de `routes/grupo.js` NÃO se aplicam ao hub" —
   confirma que nem RLS nem a lógica de grupo do backend legado alcançam o hub
   hoje; não há mecanismo (nem de leitura, nem de policy) que already resolva
   "esta conta pertence ao grupo Movee" a partir do banco do hub.
3. `infra/hub/compose.hub.homolog.yml` (env do serviço `backend`): `POSTGREST_URL`
   aponta só para `http://postgrest:3000` (o PostgREST do próprio hub); não há
   nenhuma env apontando para o PostgREST/DB legado. `01-plano-tecnico.md` §6
   (Matriz dos ambientes) declara explicitamente, para development/test/
   homologation: "Integrações: mocks (sempre)". Uma chamada ao vivo à
   `chatmasterveloz` a partir do hub isolado violaria essa invariante e o
   Princípio V da constitution (não pode disputar/depender de recursos de
   produção).
4. Como consequência de (1)+(2)+(3), `Entregador.motorista_id` ganha agora **FK
   física real** para `ContaMotorista.id` (Decision 3) — o hub finalmente tem, no
   seu próprio banco, a tabela que a referência lógica da S4 previa "morar fora".

**Fora do escopo desta fase** (documentado, não bloqueante — mesmo padrão das
decisões pendentes D5/D7/D8 do plano técnico §18): a **sincronização real** entre
`ContaMotorista` (hub) e `Motorista` (produção) — necessária só no cutover (S10+),
quando o hub deixar de ser um ambiente isolado. Até lá, `ContaMotorista` é
alimentada exclusivamente por seed determinístico, com script auditável e
idempotente (`infra/hub/scripts/gen-seeds.py`, extensão desta fase), permitindo
demonstrar os dois ramos de FR-010/FR-011 (entidade elegível / não elegível) em
qualquer ambiente do hub sem tocar produção.

**Alternatives considered**:
- **(a) `dblink`/Foreign Data Wrapper** apontando para `chatmasterveloz` a partir
  do banco do hub — rejeitada: cria dependência de rede/credencial viva entre um
  banco isolado e o banco de produção, violando a invariante "Integrações:
  mocks (sempre)" e o Princípio V (nunca disputar/depender de recursos vivos).
  Também reabriria a superfície de acesso cruzado que o G1/G2 foi desenhado para
  fechar.
- **(b) Chamada HTTP em runtime do backend do hub para o backend legado** (ex.:
  reusar `postgrestRequest()` contra o `POSTGREST_URL` de produção) — rejeitada
  pelo mesmo motivo de (a); além disso o hub isolado não tem rede para alcançar
  os serviços de produção (`hub_internal`/`hub_edge` são redes próprias, sem rota
  para o Swarm do VPSTodo além do necessário à infraestrutura, ver §4.4 do plano
  técnico "regras obrigatórias de isolamento").
- **(c) Não implementar sugestão/busca nesta fase, só o campo `motorista_id` cru**
  — rejeitada: viola FR-007/FR-008/FR-009/SC-003 da spec (já ratificada, sem
  clarify pendente sobre isso) e o objetivo central do briefing ("vincular
  Entregador↔Motorista" com sugestão por nome).

---

## Decision 3 — `Entregador.motorista_id` ganha FK física para `ContaMotorista(id)`

**Decision**: nova migration `ALTER TABLE "Entregador" ADD CONSTRAINT
fk_entregador_conta_motorista FOREIGN KEY (motorista_id) REFERENCES
"ContaMotorista"(id)`, mais um índice único parcial `CREATE UNIQUE INDEX
idx_entregador_motorista_id_unico ON "Entregador"(motorista_id) WHERE
motorista_id IS NOT NULL` — impõe no banco a regra FR-012 (uma conta nunca
vinculada a mais de um Entregador simultaneamente), em vez de depender só de
checagem na aplicação.

**Rationale**: agora que `ContaMotorista` mora no mesmo banco (Decision 2), a
referência que a S4 deixou lógica pode virar física — reduz a chance de
inconsistência (ex.: dois requests concorrentes vinculando a mesma conta) para
zero no nível de banco, com o aplicativo tratando a violação de constraint como
`409 CONFLITO` amigável (mesma UX de `UNIQUE (id_empresa, hash_sha256)` em
`ImportacaoArquivo`, já usada na S4).

**Alternatives considered**: manter só checagem em nível de aplicação (SELECT
antes do UPDATE) — rejeitada, sujeita a corrida entre requests concorrentes
(mesma classe de problema que motivou o índice único parcial de mutex em
`ImportacaoArquivo`, research.md da S4 Decision 5/ADENDO).

---

## Decision 4 — Normalização e similaridade de nome via `pg_trgm` + `unaccent`

**Decision**: habilitar as extensões `pg_trgm` e `unaccent` no banco do hub e
usar a função nativa `similarity(a, b)` do `pg_trgm` para o cálculo de
semelhança (FR-007), com um wrapper **IMMUTABLE** próprio para poder indexar:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION hub_normaliza_nome(texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT lower(unaccent(coalesce(texto, '')));
$$;

CREATE INDEX IF NOT EXISTS idx_conta_motorista_nome_trgm
    ON "ContaMotorista" USING gin (hub_normaliza_nome(nome) gin_trgm_ops);
```

A busca de candidatos ordena por
`similarity(hub_normaliza_nome(cm.nome), hub_normaliza_nome($nomeEntregador)) DESC`,
aplica o corte **top N=10** (block-002, operador) e um limiar mínimo
`WHERE similarity(...) >= 0.3` (default do `pg_trgm`, documentado e ajustável via
constante no backend — não hardcoded em SQL solto, para permitir calibrar sem
nova migration).

**Rationale**: `pg_trgm`/`unaccent` são extensões padrão do PostgreSQL 13 (mesma
versão já usada em todos os bancos do hub, `postgres:13`), tolerantes a
acentuação/caixa/espaçamento por natureza (trigramas de substring), sem
dependência externa nem processamento em Node. A função `unaccent()` built-in
é `STABLE` (não `IMMUTABLE`), o que barra índice direto sobre `unaccent(nome)` —
por isso o wrapper `hub_normaliza_nome` (o dicionário de unaccent usado é
estático/embutido, seguro para marcar `IMMUTABLE` neste contexto, mesmo padrão
documentado da comunidade Postgres para este exato problema).

**Alternatives considered**:
- **Normalização em JavaScript** (`String.prototype.normalize('NFD')` +
  strip de diacríticos) com comparação Levenshtein em Node — rejeitada: exigiria
  carregar TODAS as `ContaMotorista` elegíveis em memória a cada sugestão
  (sem índice, sem `LIMIT` empurrado pro banco), não escala e duplica lógica que
  o Postgres já resolve nativamente e de forma indexável.
- **`similarity()` sem `unaccent`** — rejeitada: falha o exemplo do próprio
  Edge Case da spec ("José da Silva" vs "jose da silva" já funciona por `lower()`,
  mas variações com acento diferente exigem `unaccent`).

---

## Decision 5 — Área de atuação (subpraça) multi-valor: sem nova tabela, índice novo nos fatos

**Decision**: FR-002/FR-003 (block-001, operador: todas as áreas distintas,
filtro casa se qualquer uma corresponder) são resolvidos por **consulta direta**
às tabelas de fato já existentes (`FaturamentoLancamento.subpraca`,
`PerformanceTurno.subpraca`), nunca por desnormalizar "área" em `Entregador`.
Duas migrations aditivas de índice (sem alterar dado nem schema de coluna):

```sql
CREATE INDEX IF NOT EXISTS idx_faturamento_empresa_subpraca
    ON "FaturamentoLancamento"(id_empresa, subpraca, entregador_id);
CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca
    ON "PerformanceTurno"(id_empresa, subpraca, entregador_id);
```

O filtro por área na listagem (FR-002) usa `EXISTS` contra as duas tabelas com
esses índices; o resumo do detalhe (FR-003) usa `SELECT DISTINCT subpraca ...
ORDER BY MAX(data) DESC` (a mais recente primeiro, para poder "destacar" — Q2
do clarify) restrito ao `entregador_id`, custo desprezível (1 pessoa por vez).

**Rationale**: subpraça é um atributo do **fato** (linha de faturamento/turno),
não da dimensão `Entregador` — desnormalizar criaria uma segunda fonte de
verdade que pode divergir do fato real (a mesma classe de risco que o plano
técnico já evita para outras colunas, §9.2). O volume por entidade é da ordem de
milhares (não milhões — §7.5/§12.6), então `EXISTS` com índice composto é
suficiente; não há gatilho para view materializada (§12.6: "gatilho dashboard
>1s" — não atingido nesta escala).

**Alternatives considered**: coluna `areas_atuacao text[]` desnormalizada em
`Entregador`, mantida por trigger nos fatos — rejeitada: mais um lugar para
manter sincronizado, e o pipeline S4 já é append-only/sem update de fatos
(§9.2), então o trigger teria que rodar em todo INSERT de fato, adicionando
custo de escrita ao pipeline de importação (fora do escopo desta fase tocar).

---

## Decision 6 — Edição manual do nome sobrevive a reimportações via trigger, sem tocar o pipeline S4

**Decision**: nova coluna `Entregador.nome_editado_manualmente boolean NOT NULL
DEFAULT false` + trigger `BEFORE UPDATE` que preserva o nome quando a flag já
está ligada:

```sql
ALTER TABLE "Entregador"
    ADD COLUMN IF NOT EXISTS nome_editado_manualmente boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION hub_protege_nome_editado_entregador()
RETURNS trigger AS $$
BEGIN
    IF OLD.nome_editado_manualmente THEN
        NEW.nome := OLD.nome;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entregador_protege_nome ON "Entregador";
CREATE TRIGGER trg_entregador_protege_nome
    BEFORE UPDATE ON "Entregador"
    FOR EACH ROW EXECUTE FUNCTION hub_protege_nome_editado_entregador();
```

O endpoint de edição (`PATCH /motoristas/:id`) envia `nome` **e**
`nome_editado_manualmente=true` no mesmo UPDATE — nesse momento
`OLD.nome_editado_manualmente` ainda é `false`, então o trigger deixa passar; a
partir daí, qualquer UPDATE subsequente (inclusive o upsert em lote do S4, que
sempre reenvia `nome`) encontra a flag já `true` e o trigger reescreve
`NEW.nome := OLD.nome`, neutralizando a tentativa de sobrescrita.

**Rationale**: verificado em `app_homologacao/backend/lib/hub-import-processor.js`
linhas 307-335 (`upsertEntregadoresDoLote`) — o payload do upsert de reimportação
envia **apenas** `{id_empresa, id_externo, nome}` via
`Entregador?on_conflict=id_empresa,id_externo` com
`Prefer: resolution=merge-duplicates`; ou seja, o único campo que uma
reimportação pode alterar em um `Entregador` já existente é `nome`. Um trigger
`BEFORE UPDATE` intercepta esse UPDATE (o `merge-duplicates` do PostgREST é, sob
o capô, um `INSERT ... ON CONFLICT DO UPDATE`, que dispara triggers normalmente)
sem exigir **nenhuma mudança de código** em `hub-import-processor.js` — preserva
literalmente a restrição do briefing ("Não inclui... importação (S4 já fez)").

**Alternatives considered**:
- **Checagem em nível de aplicação** dentro de `hub-import-processor.js` (ler o
  flag antes de montar o payload do lote, omitir `nome` quando protegido) —
  rejeitada: exigiria alterar o arquivo do pipeline S4 (fora do escopo/restrição
  do briefing) e duplicaria a regra em dois lugares (app + banco).
- **Coluna `nome_original`/`nome_editado` separada** (guardar os dois, exibir o
  editado) — rejeitada: mais complexa sem necessidade — a resposta do operador
  (block-003) foi explícita ("upsert nunca sobrescreve"), não "guardar os dois".

---

## Decision 7 — Permissões: reusar os códigos já semeados em `0007`, sem nova migration de RBAC

**Decision**: o módulo `motoristas` e seus 7 códigos de permissão já existem em
`infra/hub/migrations/0007_seed_papeis_permissoes_modulos.sql`
(`motoristas.consultar`, `motoristas.listar`, `motoristas.criar`,
`motoristas.editar`, `motoristas.excluir`, `motoristas.importar`,
`motoristas.exportar`) — **nenhuma migration nova de permissão é necessária**.
Mapa desta fase:

| Ação | Permissão real |
|------|-----------------|
| `GET /motoristas` (lista) | `motoristas.listar` |
| `GET /motoristas/:id` (detalhe) | `motoristas.consultar` |
| `PATCH /motoristas/:id` (nome/ativo) | `motoristas.editar` |
| `GET /motoristas/:id/sugestoes` | `motoristas.editar` |
| `GET /motoristas/contas-elegiveis` (busca manual) | `motoristas.editar` |
| `POST /motoristas/:id/vinculo` | `motoristas.editar` |
| `DELETE /motoristas/:id/vinculo` | `motoristas.editar` |

**Rationale**: `motoristas.criar`/`.excluir`/`.importar`/`.exportar` não têm
endpoint nesta fase (Entregador só é criado pelo pipeline S4; não há delete nem
export nesta fase). Vínculo/desvínculo/edição de nome/situação reusam
`motoristas.editar` — não existe um código dedicado `motoristas.vincular` no
seed 0007, e a spec (FR-005) já trata "toda ação de edição (nome, situação,
vínculo, desvínculo)" como uma única permissão de atualização — inventar um
código novo fragmentaria sem necessidade uma regra que a spec já define como
unificada. Consistente com o papel `operador` (0007 linha 100-101) já incluir
`motoristas.editar` e `leitura` (linha 116) só ter `consultar`+`listar` — o
comportamento somente-leitura de FR-005/SC-006 já é natural com o RBAC
existente, sem seed corretivo.

**Alternatives considered**: seed corretivo criando `motoristas.vincular`
(paralelo à Decision 2 da S4, que criou `importacoes.exportar` por realmente
faltar) — rejeitada por não faltar nada: `motoristas.editar` já cobre
semanticamente "atualizar este recurso", e a spec não distingue vínculo de
edição para fins de permissão.

---

## Decision 8 — Rota frontend `/hub/dashboard/motoristas` (não `/motoristas`)

**Decision**: a tela desta fase vive em
`app_homologacao/frontend_v2/app/hub/dashboard/motoristas/page.tsx` +
`.../motoristas/[id]/page.tsx`, seguindo a convenção real já estabelecida pela
S4 (`app/hub/dashboard/importacoes/page.tsx`), **não** `/hub/motoristas` como o
plano técnico §13.1 sugeria antes da S4 concretizar a convenção real.

**Rationale**: verificado em `app_homologacao/frontend_v2/app/hub/dashboard/importacoes/page.tsx`
— cabeçalho do arquivo documenta explicitamente que a convenção real é
`/hub/dashboard/<codigo-do-modulo>`, divergindo do rascunho original do plano.
Seguir a convenção mais recente e já em produção no hub-homolog evita uma rota
órfã/duplicada.

**Padrão de implementação a reusar** (mesmo arquivo como referência): tabela e
filtros construídos **inline** com primitives shadcn (`Table*`, `Input`,
`Badge`), paginação **server-side** via hook próprio (`useMotoristasListagem()`,
paralelo a `useImportacoesHistorico()`), DTOs/tipos em
`lib/hub/motoristas-dto.ts` e chamadas em `lib/hub/motoristas-api.ts` (paralelo a
`lib/hub/importacoes-dto.ts`/`importacoes-api.ts`). Os componentes genéricos
`components/data-table.tsx`/`components/filters.tsx` do frontend_v2 **não** são
reusáveis aqui — são acoplados à tela legada `EnvioMassa` (props tipadas em
`EnvioMassa[]`), confirmado por leitura direta; a tela legada
`/dashboard/motoristas` também não expõe um componente genérico (paginação
client-side, primitives shadcn diretas) — o padrão mais próximo e mais recente é
o da S4.

**Alternatives considered**: seguir a tabela literal do plano técnico §13.1
(`/motoristas`) — rejeitada, ficaria inconsistente com a única tela hub já
entregue (S4) e exigiria decidir sozinho entre duas convenções conflitantes sem
necessidade (a mais nova sempre reflete o estado real do shell, S3).

---

## Decision 9 — Auditoria: `motorista.editado` / `motorista.vinculado` / `motorista.desvinculado`

**Decision**: cada ação de escrita registra `Auditoria` via
`registrarAuditoria()` (`lib/hub-auditoria.js`, reusado sem alteração):

| Ação | `acao` | `recurso` | `recursoId` | `detalhes` (não sensível) |
|------|--------|-----------|-------------|----------------------------|
| Editar nome/situação | `motorista.editado` | `Entregador` | id do Entregador | `{camposAlterados: ["nome"\|"ativo"]}` |
| Criar/substituir vínculo | `motorista.vinculado` | `Entregador` | id do Entregador | `{contaMotoristaId, origem: "sugestao"\|"busca_manual"}` |
| Desfazer vínculo | `motorista.desvinculado` | `Entregador` | id do Entregador | `{contaMotoristaIdAnterior}` |

**Rationale**: `registrarAuditoria()` já mascara chaves sensíveis
(`scrubDetalhes`, substring case-insensitive de `senha|password|pass|hash|token
|secret|segredo`) e é best-effort (nunca derruba o fluxo principal) — reusar sem
alteração satisfaz FR-014 (trilha de quem/quando) sem duplicar lógica. `detalhes`
nunca inclui nome/cnpj em texto livre (só ids), consistente com o padrão LGPD já
aplicado em `ImportacaoLinhaErro`/`valor_mascarado`.

---

## Decision 10 — Sugestão/busca de candidatos via função RPC do PostgREST (não filtro ad-hoc), fechando gap do gate `owasp-security`

**Decision**: as consultas de similaridade (`GET /motoristas/:id/sugestoes`) e de
busca manual (`GET /motoristas/contas-elegiveis`) são implementadas como
**funções SQL nativas** (`hub_motoristas_candidatos(p_entregador_id int)` e
`hub_motoristas_busca(p_termo text, p_limit int, p_offset int)`), expostas pelo
PostgREST via `POST /rpc/hub_motoristas_candidatos` /
`POST /rpc/hub_motoristas_busca` — nunca uma string SQL montada por
concatenação no backend Node. O backend chama o RPC pelo mesmo
`hubPostgrestRequest()` já usado para tudo mais, passando os parâmetros como
corpo JSON (bind automático do PostgREST, sem interpolação de texto). Ambas as
funções fazem a checagem de elegibilidade de grupo (`EmpresaGrupoMovee`)
internamente, retornando conjunto vazio quando a entidade não é elegível —
único ponto de verdade da regra, sem duplicar a checagem em cada endpoint.

**Rationale**: revisão de segurança (gate `owasp-security`, A05 Injection +
API7 SSRF/consulta dinâmica) sobre o rascunho inicial deste plano — os
exemplos de SQL em `data-model.md` (`similarity(hub_normaliza_nome(...),
hub_normaliza_nome($nomeEntregador))`) eram ilustrativos e, se implementados
literalmente como string interpolada no backend, seriam injeção clássica
(A05/CWE-89). PostgREST não expõe `similarity()`/`unaccent()` como filtro de
querystring nativo — a rota seguramente parametrizada e já usada em todo o hub
para lógica não-trivial é RPC (`POST /rpc/<function>`), que faz bind de
parâmetros como uma prepared statement. Corrigido nesta revisão do plano antes
de qualquer código existir — nenhuma linha de implementação foi escrita com o
padrão inseguro.

**Alternatives considered**: view materializada com filtro de querystring
comum do PostgREST — rejeitada, `similarity()` exige o segundo argumento
(nome do Entregador de referência) como parâmetro de request, não uma coluna
fixa da view; RPC é o mecanismo do próprio PostgREST para esse caso.

## Decision 11 — BOLA em `/sugestoes` e `/contas-elegiveis`: já coberto por RLS, tornado explícito no contrato

**Decision**: `GET /motoristas/:id/sugestoes` e `GET
/motoristas/contas-elegiveis` retornam `404 NAO_ENCONTRADO` quando `:id`
referencia um `Entregador` fora do escopo do token — **não** é uma checagem
nova de aplicação, é a RLS já vigente em `Entregador` desde `0015`
(`id_empresa = ANY(hub_jwt_escopo_ids())`) se propagando naturalmente: a
função RPC (Decision 10) faz `SELECT ... FROM "Entregador" WHERE id =
p_entregador_id` como primeiro passo, e RLS devolve 0 linhas para um id fora do
escopo, que o backend traduz em `404` (mesmo padrão de `GET /motoristas/:id`).
Documentado explicitamente em `contracts/motoristas-api.md` para eliminar
qualquer ambiguidade que o gate `owasp-security` (A01 Broken Access Control)
apontou no rascunho original (os dois endpoints não deixavam esse
comportamento por escrito).

**Rationale**: Constitution Principle II (Isolamento Multi-Tenant) já está
`PASS` no plano — esta decisão só fecha a lacuna de **documentação**
apontada pelo gate; o mecanismo de defesa (RLS) já existia e não muda.

## Decision 12 — Guarda contra mass assignment no `PATCH /motoristas/:id`

**Decision**: o handler de `PATCH /motoristas/:id` monta o payload de UPDATE
por **allowlist explícita** (`{nome, ativo}` — apenas esses dois campos são
lidos do `req.body`; qualquer outro campo, incluindo `motoristaId`/
`nomeEditadoManualmente`/`id`/`idEmpresa`, é ignorado, nunca repassado ao
PostgREST). Mesmo padrão já usado implicitamente pelos demais endpoints do hub
(nenhum deles faz `UPDATE ... SET *` a partir do corpo bruto do request).

**Rationale**: gate `owasp-security` (API3 BOPLA/mass assignment) — sem uma
allowlist explícita documentada, uma implementação apressada poderia repassar
`req.body` inteiro ao PostgREST, permitindo que um cliente autenticado com
`motoristas.editar` defina `nome_editado_manualmente=false` (burlando a
proteção da Decision 6) ou tentasse setar `motorista_id` diretamente
(contornando o fluxo de vínculo com auditoria da Decision 9). Fechado por
especificação explícita nesta revisão do plano, antes de qualquer código.

---

## Constraints herdados (não-decisões — invariantes já estabelecidas)

- Ambiente de trabalho e teste: **hub-homolog isolado** (`hub-*`/`hub_*`),
  jamais produção/`chatmasterveloz` (cláusula pétrea + exceção G1 escopada).
- Nenhuma mudança em `Motorista` (tabela legada), no fluxo de login do app
  motorista, no `upsertMotoristasFromLote`, em CRUD de veículos ou nos endpoints
  de importação (FR-015/FR-016, briefing "Não inclui").
- Migrations expand-only, idempotentes, numeradas na série física real
  (`infra/hub/migrations/00NN`), aplicadas só por `migrate.sh`.
- Toda tela nova via `/ui-ux-pro-max`, identidade visual EntreGô 2.0 preservada
  (FR-017/SC-008).
