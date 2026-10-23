# Implementation Plan — `lancamento-externo`

**Feature**: `lancamento-externo` · **Spec**: [`spec.md`](./spec.md) (52 FRs, 0 `[NEEDS CLARIFICATION]`)
**Research**: [`research.md`](./research.md) · **Data model**: [`data-model.md`](./data-model.md)
**Contrato**: [`contracts/import-lancamento-externo.md`](./contracts/import-lancamento-externo.md)
**Cenários**: [`quickstart.md`](./quickstart.md) · **Runbook**: [`../../plans/lancamento-externo/RUNBOOK.md`](../../plans/lancamento-externo/RUNBOOK.md)
**Constitution**: v1.1.0

> ⏱ **Prazo é requisito.** A dedução só existe se o lançamento entrar **antes do
> fechamento**. Config de produção confirma a aritmética: `apuracao_dia_inicio=1`
> (segunda), `apuracao_dias_ate_repasse=3` ⇒ 25/10 + 3 = **quarta 28/10**. Janela
> útil: **26/10 até o fechamento**.

---

## Summary

Uma tabela nova genérica (`LancamentoExterno`) com o **sinal derivado do tipo
por FK**, alimentando **um único termo novo** no `remanescente` das três funções
**vivas** do repasse — prévia, fechamento e detalhe. Leitura de planilha reusa o
núcleo endurecido do importador da Transfeera, **extraído** (não importado) com
contrato de cabeçalho parametrizado e fábrica de erro injetada, para que o
importador em produção não mude nem um byte de comportamento. Uma tela: um botão
na aba Repasse, antes de "Fechar apuração", e um diálogo com seletor de tipo.

**Abordagem em uma frase**: o sentido mora no banco (uma linha de lookup), o
termo entra uma vez (antes do piso), e a borda recusa linha a linha com motivo
nomeado — modo de falha **fechado** em todo caminho de dinheiro.

---

## Technical Context

| Campo | Valor | Como foi determinado |
|---|---|---|
| Linguagem/runtime | Node.js **20** (backend), Next.js (frontend_v2) | `CLAUDE.md` + `Dockerfile.hub`; `node --version` → `v20.20.2` já confirmado em produção |
| Persistência | PostgreSQL via **PostgREST** (sem ORM) — hub em banco próprio, RLS + JWT por requisição | `CLAUDE.md`; `lib/hub-postgrest.js` |
| Versão do Postgres | **13.23** medido no `hub_homolog` isolado; produção `[PROPOSTA]` | research §Unknowns — o DDL só usa recursos ≤ PG 12 |
| Testes | `node --test` (backend), `vitest` (frontend), drivers `infra/hub/testes/*.sh` | `package.json` |
| UI | Tailwind 4 + **Base UI** (`@base-ui/react`, **não** Radix) + shadcn | `CLAUDE.md` |
| Migrations | série única `infra/hub/migrations/NNNN_*.sql`, uma transação por arquivo | `scripts/migrate.sh:46-73` ⇒ **nada `CONCURRENTLY`** |
| Próximo número | **0117** (último aplicado: `0116_envio_massa_corrigir_valor.sql`) | `ls infra/hub/migrations/ \| tail` |
| Escala | ~223 entregadores no isolado; produção mediu **106 adiantamentos no total** | plano medido com **229.467** linhas sintéticas (pessimista) |

Nenhum eixo estrutural aberto: a feature vive inteiramente na stack ratificada.

---

## Constitution Check (v1.1.0)

*GATE antes do Phase 0 — re-checado após o Phase 1 (§Re-check).*

| Princípio | Status | Notas |
|---|---|---|
| **I. Segurança de Auth & Segredos** (NON-NEGOTIABLE) | **PASS** | Nenhum segredo novo. Fixtures com CNPJ sintético derivado do id (FR-043) — repositório é público. Resposta nunca carrega CNPJ/nome (FR-031) |
| **II. Isolamento Multi-Tenant** (NON-NEGOTIABLE) | **PASS** | `id_empresa` do token via `hub_jwt_escopo_ids()`, nunca do corpo (FR-035). RLS habilitada; **zero** GRANT de escrita; escrita só por `SECURITY DEFINER` com `REVOKE ALL FROM PUBLIC` antes do `GRANT` — o PostgREST é público |
| **III. Contratos de API & Proxy de Cookies** | **PASS** | Chamada passa pelo proxy `app/api/[...path]`; o browser não fala com o backend direto. Motivos de recusa em enum fechado e estável (FR-032) |
| **IV. Qualidade e Revisão** | **PASS** | Gates com números (§Gates). Controle negativo com testes **nomeados** e reversão conferida **antes** de medir (SC-011) |
| **V. Deploy Conteinerizado** (NON-NEGOTIABLE) | **PASS** | Nenhum serviço novo. Migration e deploy são do **operador** (FR-044); o agente entrega artefatos e não toca o ambiente vivo |
| Veracidade de Dados (Padrões de Qualidade) | **PASS** | Todo número do plano tem comando e saída literal. O contrato HTTP está marcado `[PROPOSTA]` por ainda não existir; o que é afirmado como real tem fonte citada |

**Complexity Tracking**: vazio — nenhuma violação a justificar.

---

## As 7 questões que o plano tinha de resolver

### 1 · Extração com rede de não-regressão **antes** de mudar comportamento

Núcleo novo `lib/xlsx-import-core.js` com
`lerPlanilha(buffer, { cabecalhoEsperado, maxLinhas, erro }) -> { linhas, date1904 }`.
A **fábrica de erro injetada** é o detalhe que preserva produção: a rota faz
`e instanceof RetornoTransfeeraParseError` (`hub-adiantamentos.js:1515`), e com a
fábrica o erro lançado continua sendo a mesma classe com o mesmo `motivo`.
As opções de leitura de `:136` são transportadas **sem uma alteração** — FR-052,
porque `bookProps:false` é justamente o que expõe `date1904`.

**Ordem obrigatória, com nomes** (não promessa):

1. **Medir antes** — rodar e anotar os números de
   `tests/adiantamento-retorno-transfeera-unit.test.js`,
   `tests/adiantamento-retorno-transfeera-arquivo-real.test.js`,
   `tests/adiantamento-transfeera-xlsx-unit.test.js`,
   `tests/hub-adiantamentos-rotas-unit.test.js`.
2. **Extrair** (movimento puro, zero mudança de comportamento).
3. **Medir depois** — os **mesmos** números. Diferente = pára.
4. Só então o leitor novo.

⚠️ `backend/package.json:8` lista os testes **um a um**: cada arquivo novo entra
na lista, ou não roda e o verde fica oco.

### 2 · A CTE nova, por que não colide, e o `EXPLAIN` medido com **três** fontes

`externos_cte`, agregada por `entregador_id`, duas direções por `FILTER`, termo
entrando **uma vez** no `remanescente` (detalhe em research §6).

Não colide com `debitos_cte` nas três frentes que FR-042 cobra: **nome**
distinto; **chave de junção** própria em `LEFT JOIN` de CTE já agregada (não
altera cardinalidade); e **dupla contagem impossível por construção** —
`debitos_cte` lê `"FaturamentoLancamento"` (`tipo='Debito'`), `externos_cte` lê
`"LancamentoExterno"`; tabelas diferentes, nenhum valor nas duas.

**Medido** (229.467 linhas sintéticas, `hub_homolog`):

| Medição | Resultado |
|---|---|
| CTE nova isolada | `Index Scan using idx_lancamentoexterno_empresa_data_entregador`, `Index Cond` cobre igualdade **e** faixa, **1.554 de 229.467** linhas (**0,68%**), 47 buffers, **1,604 ms** |
| **Três fontes juntas** | **2,094 ms**, 58 buffers, 222 linhas — cada fonte no seu índice |

**Índice**: `(id_empresa, data_pagamento, entregador_id)` — igualdade, faixa,
agrupamento, na ordem que o guia Supabase prescreve. É a lacuna de `0066:224-225`
que FR-042 proíbe repetir. `INCLUDE` rejeitado por falta de beneficiário medido.

### 3 · Migration `0117` — **escrita e aplicada** no isolado, sem erro

`infra/hub/migrations/0117_lancamento_externo.sql`. Tipo em **tabela de lookup
com FK** (o sinal mora em um lugar ⇒ registro incoerente é *impossível de
representar*, mais forte que CHECK, e tipo novo = um INSERT, FR-013); chave de
idempotência `UNIQUE (id_empresa, cnpj_prestador, data_pagamento, tipo)`; RLS no
padrão da série com `GRANT SELECT` e **zero** escrita; funções `SECURITY
DEFINER` com `REVOKE ALL FROM PUBLIC` **antes** do `GRANT`.

**`DROP FUNCTION` + `CREATE` + `GRANT`: É necessário em QUATRO das CINCO funções vivas.**
*(Correção da rodada 2 — a versão anterior deste parágrafo afirmava o contrário e estava errada.)*
Só `hub_adiantamento_repasse_fechar` mantém o tipo de retorno ⇒ `CREATE OR REPLACE`, GRANT preservado.
As outras quatro — a prévia, o congelado, o detalhe do app e o "último fechado" do app — **ganham a coluna
`lancamentos_externos`** (FR-018/FR-040) ⇒ `CREATE OR REPLACE` é recusado ⇒ `DROP` + `CREATE` + `GRANT EXECUTE
… TO authenticated`, e o `DROP` **apaga a ACL** (aviso de `0098:30`). O `migrate.sh` roda cada arquivo em
`psql -1` (uma transação): nenhuma sessão enxerga a janela entre o `DROP` e o `GRANT`. A prova do caminho de
volta é `hub-lancamento-externo-rollback.sh` (DROP → reaplicar salvo → REVOKE ALL FROM PUBLIC + GRANT).

Aplicação no `hub_homolog` **achou um bug meu** antes de qualquer revisão
humana: `= ANY ((SELECT hub_jwt_escopo_ids()))` falha com
`operator does not exist: integer = integer[]` — a forma recomendada pelo guia
Supabase não se aplica a função que devolve array. Corrigido para a forma da
casa; a forma correta para array (`IN (SELECT unnest(...))`) está registrada
como dívida de repo, não aplicada pontualmente (research §9).

### 4 · Onde o aviso de FR-049 aparece

Nos **dois** momentos em que alguém decide sobre o dinheiro da semana, quando
`qtd_deducao > 0` **e** `flag_desconto_ligada = false`:

| Momento | Local |
|---|---|
| Prévia do repasse | aba Repasse, acima da tabela |
| Confirmação do fechamento | `adiantamento-fechar-apuracao-dialog.tsx:97-118` — bloco de aviso **já existente**, que ganha mais um caso |

Nomeia que existem valores pagos por fora que **não** serão descontados e
**quantos** são; **não bloqueia**; nada identificável. Inerte hoje
(`desconto_adiantamentos = t`), existe porque a flag é editável pela tela.

### 5 · A tela — só o botão e o diálogo

Botão **"Importar pagos por fora"** no `PageHeader` da aba Repasse
(`app/hub/dashboard/adiantamentos/repasse/page.tsx:207-238`), **antes** de
"Fechar apuração" (`:214-222`) — a ordem é o próprio ensinamento: o lançamento
só tem efeito **antes** do fechamento (FR-038/dec-012).

Diálogo no molde de `adiantamento-fechar-apuracao-dialog.tsx` (hook + JSX
separados, `useFecharApuracaoDialog`/`FecharApuracaoDialog`), com **seletor de
tipo** — o tipo vem da tela e vale para o arquivo todo (FR-010), nunca é coluna
da planilha. Resultado exibido: aplicadas, recusadas, contagem por motivo.
**Sem CNPJ, sem nome** (FR-039).

⚠️ `Select` do Base UI exige `items` no `Root` para exibir o rótulo (gotcha já
catalogado no `CLAUDE.md`).

**Nada além disto** (FR-040): sem página nova e sem aba nova. Se a implementação
concluir que falta tela, isso vira **bloqueio para o operador** — não é criado.

⚠️ **Superado em 2026-10-23 (rodada 3)**: a **listagem** e a **exclusão** passaram a
ser escopo (FR-056/FR-057), como diálogo da aba Repasse, por autorização do operador.
O bloqueio acima foi o caminho que produziu essa autorização, e funcionou como previsto.

### 6 · Runbook, com a conferência da prévia

[`docs/plans/lancamento-externo/RUNBOOK.md`](../../plans/lancamento-externo/RUNBOOK.md):
ordem **migration → código**, e o passo **4 — conferir a prévia antes de
fechar**, dizendo quais números conferir e o que é sinal de problema. A prévia
(`hub_adiantamento_repasse`, `0100`) é ao vivo e **não congela nada** — é a
única chance de ver o efeito antes de ele virar imutável.

### 7 · Documentação oficial e o que ela embasou

Tabela completa em research §11. Resumo honesto: **Supabase Postgres Best
Practices** embasou ordem de colunas do índice, least-privilege, índice de FK,
advisory lock e a tentativa de InitPlan que a medição refutou. Os **tipos
instalados do SheetJS** embasaram FR-045/046/052 e revelaram que
`parse_date_code` **não é tipado** (exige `null`-check).
`nodejs-backend-patterns` e `nextjs-app-router-patterns` foram consultadas e
**não embasaram nada**: são stubs de 1.663 e 1.500 bytes com texto genérico,
zero exemplo — citá-las como fundamento seria desonesto. O fundamento de
Node/Next veio dos padrões **vivos do repo**, que é fonte mais forte.

---

## Decisões de qualidade que o operador exigiu

| Exigência | Como o desenho atende |
|---|---|
| **Deduplicação** | Chave única no banco (FR-026) + dedup **dentro do arquivo** antes de enviar (FR-029, precedente: `deduplicarPorIdIntegracao`). O núcleo de leitura é **extraído**, não copiado. A fórmula da semana ganha **um** nome em vez de uma 6ª cópia |
| **Escalabilidade** | Índice medido com **2.166×** o volume real; a CTE já vem agregada (uma linha por entregador), então a junção não cresce com o nº de lançamentos |
| **Performance** | `EXPLAIN (ANALYZE, BUFFERS)` real: 1,604 ms isolado, **2,094 ms com as três fontes**, 0,68% da tabela lida, zero `Seq Scan` na tabela nova. **Limiar de regressão (dec-040, spec §SC-009)**: `Seq Scan`, ou `Index Cond` sem igualdade+faixa, ou > 2x a baseline (3,208 ms/94 buffers isolada; 4,188 ms/116 buffers três fontes) — checado por `infra/hub/testes/hub-lancamento-externo-perf.sh` |
| **Segurança** | RLS + zero GRANT de escrita + `SECURITY DEFINER` com `REVOKE` antes do `GRANT`; resposta sem dado de terceiro (FR-031); tetos de ZIP **antes** de o SheetJS tocar nos bytes; `express.raw` na rota, sem subir o teto global; modo de falha **fechado** em toda ambiguidade de dinheiro |

---

## Project Structure

Documentação (criada nesta fase):

```text
docs/specs/lancamento-externo/
├── spec.md                                   (existente)
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/import-lancamento-externo.md
docs/plans/lancamento-externo/
├── BRIEFING.md                               (existente, do operador)
└── RUNBOOK.md
```

Código (árvore **real**; `[novo]` / `[alterado]`):

```text
infra/hub/migrations/
└── 0117_lancamento_externo.sql                            [novo, já aplicado no isolado]
app_homologacao/backend/
├── lib/xlsx-import-core.js                                [novo]  núcleo extraído
├── lib/lancamento-externo.js                              [novo]  leitor do layout de 5 colunas
├── lib/adiantamento-retorno-transfeera.js                 [alterado] só delega ao núcleo
├── routes/hub-adiantamentos.js                            [alterado] rota de import + resumo
├── package.json                                           [alterado] §8: registrar os testes novos
└── tests/
    ├── lancamento-externo-unit.test.js                    [novo]
    ├── lancamento-externo-xlsx-nativo.test.js             [novo]  FR-051: cellDates on/off, epochs 1900/1904
    └── hub-lancamento-externo-integration.test.js         [novo]
app_homologacao/frontend_v2/
├── app/hub/dashboard/adiantamentos/repasse/page.tsx       [alterado] botão no PageHeader
├── components/hub/lancamento-externo-dialog.tsx           [novo]
├── components/hub/adiantamento-fechar-apuracao-dialog.tsx [alterado] aviso FR-049
└── lib/hub/lancamento-externo.ts                          [novo]
```

---

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas do banco | `snake_case` | CHECK + FK + UNIQUE | `infra/hub/migrations/0117_lancamento_externo.sql` |
| Cabeçalho da planilha | rótulo humano PT-BR, **exato e ordenado** | comparação por contrato **antes** de ler linha | `contracts/import-lancamento-externo.md` §1 |
| Payload da RPC | chaves curtas `i/cnpj/data/valor/obs` | montado pelo backend, nunca pelo cliente | `lib/lancamento-externo.js` |
| Resposta HTTP | `camelCase` (`ignoradasPorMotivo`) | molde já em produção | `routes/hub-adiantamentos.js:1525-1586` |
| DTO do frontend | `camelCase` | tipo TS no cliente de API | `lib/hub/lancamento-externo.ts` |
| Motivos de recusa | `SCREAMING_SNAKE` | enum fechado | `contracts/…` §1 |
| Query params | `camelCase` (`?tipo=`) | router | rota |

**Mapper layer**: não há ORM — o backend fala HTTP com PostgREST. A conversão
planilha → payload da RPC é explícita no leitor novo. **Sem Zod** (não é o
padrão do repo); a validação é o leitor, com modo de falha fechado.

---

## Riscos e o que os contém

| Risco | Contenção |
|---|---|
| **A semana 19–25/10 é a 1ª apuração da história** e o fechamento é irreversível | Cenário obrigatório no `quickstart.md`; `0098:140` confirma "sem apuração: livre"; `saldo_anterior` = 0 por `COALESCE`; ramo **pós-regra** do CHECK verificado (research §7). Runbook §4 obriga conferir a prévia **antes** |
| Extração mexe em código em produção desde 2026-10-22 | Não-regressão **antes** da mudança, com 4 suítes nomeadas; fábrica de erro preserva o `instanceof` da rota |
| `paraCentavos` arredonda calado (`100.005` → R$ 100,01) | Gate FR-047 roda **antes** dela; via nativa usa arredondamento exato pós-gate (research §5) |
| Alterar a função **morta** `0098:321-454` | Mapa das definições vivas em research §1, com o `grep` que o revela |
| Versão do Postgres de produção não medida | DDL restrito a recursos ≤ PG 12; operador confirma ao aplicar |
| Flag desligada ⇒ empresa paga duas vezes | Risco **aceito** pelo operador (Q2). Mitigação exigida: aviso FR-049 nos dois momentos |

---

## Gates (números a relatar)

| Gate | Baseline a bater |
|---|---|
| Backend `npm test` | **2030 pass / 0 fail** + os novos |
| `tsc --noEmit` | limpo |
| `vitest` | **941 / 0** + os novos |
| `next build` | concluído |
| Lint | sem erro **novo** contra a baseline de **28** (5 erros, 23 avisos) |
| Driver `hub-adiantamentos-integration.sh` | **231 PASS / 0 FAIL** + os novos |
| Controle negativo (SC-011) | testes que falham sem a correção **nomeados**, reversão conferida **antes** de medir |

⚠️ `docker build` **não** nesta onda: disco em **22 GB** livres (`df -h /`), e o
limite de abortar é ~20 GB.

---

## Gate `owasp-security` — achados e o que foi feito

Rodado sobre os artefatos **e** sobre a `0117`. Superfície revisada: upload
autenticado, parse de ZIP de terceiro, RPC `SECURITY DEFINER`, RLS em camada de
dados **pública**, caminho de dinheiro **irreversível**, multi-tenant por claim.

| # | Sev | Achado | Desfecho |
|---|---|---|---|
| **F1** | **HIGH** | **Escrita cross-tenant (BOLA / API1 / ASI03)**. O `INSERT` gravava `id_empresa = 6` (a apuração é sempre da 6, `0098:142/179/306`) mas resolvia o `entregador_id` contra `ANY (v_escopo)`, **sem** checar que a 6 está no escopo. Usuário de outra empresa resolveria entregador do próprio escopo e a linha entraria como lançamento da **empresa 6** — dedução injetada na apuração de outro tenant, apontando para entregador que não é dela | **CORRIGIDO** na mesma onda, nas duas metades: `IF NOT (6 = ANY (v_escopo)) THEN RAISE EXCEPTION 'FORA_DE_ESCOPO'` (fail-closed) **e** resolução com `e.id_empresa = 6`. Os dois lados usam o mesmo número. Verificado no `hub_homolog`: `gate-escopo: OK`, `resolucao-empresa-6: OK` |
| **F2** | MEDIUM | `hub_lancamento_externo_resumo` exige `adiantamentos.pagamento_confirmar`. Quem **vê** a prévia com permissão mais fraca receberia erro em vez do aviso de FR-049 — e FR-049 diz que o sistema **MUST NOT falhar calado** | ✅ **RESOLVIDO na onda-004 (dec-036)**: o resumo passa a ser gateado por **`adiantamentos.pagamentos_consultar`** — a mesma permissão que a rota da prévia já exige (`routes/hub-adiantamentos.js:1659`); o fechamento exige `pagamento_confirmar` (`:1853`). Justificativa medida: o resumo devolve só contagem/total/estado-da-flag, **sem** dado identificável (FR-031), logo é estritamente **menos** revelador que a prévia que o usuário já está autorizado a ver; e o diálogo de fechamento é renderizado pela **mesma** página que carrega a prévia (`app/hub/dashboard/adiantamentos/repasse/page.tsx`), então quem alcança o 2º momento de FR-049 já passou pelo gate mais fraco — **um** gate cobre os dois momentos. Degradar o aviso foi **rejeitado**: reintroduz o falhar-calado que FR-049 proíbe. Item **bloqueante** do checklist (CHK-F2), não risco aceito |
| **F3** | MEDIUM | Motivo de recusa carregando conteúdo de célula. O módulo do retorno **anexa** o valor (`VALOR_AMBIGUO:${rotuloStatus(...)}`, `adiantamento-retorno-transfeera.js:300`); ali o dado é do parceiro, aqui a planilha é do financeiro e a célula pode ter dado de terceiro digitado na coluna errada | **CORRIGIDO no contrato**: motivo é **token fechado**, nunca `MOTIVO:<texto>`. Única exceção deliberada: `VALOR_ACIMA_DO_TETO` nomeia o **teto**, que é constante nossa |
| **F4** | LOW | Cast de `(v_linha->>'data')::date` / `::numeric` **levanta** e aborta a transação inteira, perdendo as linhas já aplicadas do lote | **ACEITO**: a borda só envia linha totalmente validada, e a direção da falha é a segura (**nada** aplicado em vez de parcial). Documentado em vez de silenciado |
| **F5** | INFO | `conferirTetoZip` soma os tamanhos **declarados** no diretório central — declaração é controlada pelo atacante | **ACEITO** (desenho pré-existente, `:87-90`): depois da leitura o parse ainda é limitado por `sheetRows` e pelo cheque de `!fullref`, e o `express.raw` limita o transporte |

**Controles verificados por medição** (`hub_homolog`), não por leitura:

| Controle | Medido |
|---|---|
| `search_path` pinado nas funções DEFINER | `{"search_path=public, pg_temp"}` nas duas |
| `PUBLIC` sem `EXECUTE` | `f` nas três funções novas |
| Escrita direta fechada para `authenticated` | `INSERT=f · UPDATE=f · DELETE=f · SELECT=t` |
| RLS ligada | `relrowsecurity = t` |
| Injeção | zero SQL dinâmico, zero `EXECUTE`; acesso a `jsonb` por operador e binding de variável |
| Fail-closed | permissão, escopo, config e tipo **levantam** antes de qualquer escrita |
| TOCTOU com o fechamento | mesma `pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))` de `0098:135` |

**Nenhum achado `critical`/`high` em aberto** após F1 — o gate re-passa limpo.
F2 era item obrigatório do backlog, não risco aceito — **FECHADO na onda-007 com evidência**: gate do resumo em
`0117_lancamento_externo.sql:307` = `adiantamentos.pagamentos_consultar`; driver `hub-lancamento-externo-integration.sh`
prova as duas metades — `resumo (a)` (só `pagamentos_consultar` vê o aviso), `resumo (b)` (sem as duas →
`PERMISSAO_NEGADA`), `resumo (c)` (a escrita continua exigindo `pagamento_confirmar`); controle negativo
`LE_NEG=gate-resumo` reprova só `resumo (a)` e `C9/FR-049`. Na tela: `repasse/page.test.tsx` (3 testes
`lancamento-externo:`) + `lancamento-externo.test.tsx` (`CHK008`).

---

## Re-check de Constitution (pós-Phase 1)

O design **não** introduziu camada nem serviço: uma tabela de domínio de 2
linhas, uma tabela de fatos, duas funções novas, um termo em três funções
existentes, um botão e um diálogo. Nenhum principio MUST afetado; II e V
ficaram **mais** protegidos (zero GRANT de escrita; migration/deploy do
operador). **PASS** — `Complexity Tracking` segue vazio.

---

## Próximos passos

1. `/checklist` — quality gate dos requisitos antes de implementar
2. `/create-tasks` — decompor em backlog, com a **ordem** de FR-050 preservada
   (medir → extrair → medir → só então o leitor novo)
3. `/analyze` — consistência cross-artifact após as tasks
