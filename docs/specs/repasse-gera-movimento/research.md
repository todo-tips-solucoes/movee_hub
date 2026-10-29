# Research — `repasse-gera-movimento`

**Data**: 2026-10-28 · **Fase**: Phase 0 (plan)
**Fonte autoritativa de requisito**: `docs/plans/repasse-gera-movimento/BRIEFING.md` (D1–D12) + `spec.md`
**Fonte autoritativa de fato**: as medições M1–M14 abaixo, todas por leitura direta do repositório nesta onda. Nenhuma assinatura, coluna, código de erro ou `path:linha` neste documento é suposto (Constitution VI).

> Todos os caminhos são relativos à raiz `/var/lib/envioMassa_homologacao`.
> Prefixos usados: `BK = app_homologacao/backend`, `FE = app_homologacao/frontend_v2`, `MIG = infra/hub/migrations`.

---

## As medições que sustentam tudo o que vem depois

| # | Fato medido | Onde |
|---|---|---|
| **M1** | `hub_adiantamento_repasse_fechar(p_periodo_inicio date)` **viva** já é **uma transação única** e já faz: permissão `adiantamentos.pagamento_confirmar`; `pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))`; `APURACAO_JA_FECHADA`; `APURACAO_FORA_DE_ORDEM` (período ≠ último + 7); `APURACAO_NAO_CONFIGURADA`; `PERIODO_EM_ABERTO`; `APURACAO_COM_PENDENCIAS`; `INSERT` em `ApuracaoRepasse` + `INSERT` de todos os `ApuracaoRepasseItem`. `id_empresa` é **hardcode 6** nas escritas; as leituras usam `hub_jwt_escopo_ids()` | `MIG/0117_lancamento_externo.sql:708` (lock `:732`, dup `:741`) |
| **M2** | A rota `POST /repasse/:periodo/movimentos` é **orquestração JS** sobre ~10 chamadas HTTP PostgREST independentes + N inserts (um `EnvioMassa` + um `ApuracaoRepasseMovimento` por motorista, loop em `:2309`–`:2323`). **Não existe transação entre chamadas HTTP.** O desenho não-atômico é **declarado** no comentário `:2306`: *"Insere um a um: um CNPJ que falhe não pode derrubar a rodada inteira"*. A idempotência real vem da trilha `ApuracaoRepasseMovimento` (UNIQUE apuração+entregador). O 409 que trava a frente é `:2193` | `BK/routes/hub-adiantamentos.js:2177`, `:2193`, `:2306` · trilha em `MIG/0092_apuracao_divisao_nota_e_trilha.sql:39`, policy de INSERT corrigida pela `MIG/0099_apuracaorepassemovimento_insert_policy.sql` |
| **M3** | **Rollback de apuração é impossível**: `REVOKE UPDATE, DELETE ON "ApuracaoRepasse"/"ApuracaoRepasseItem" FROM authenticated` + trigger `hub_bloqueia_alteracao_apuracao()` que faz `RAISE EXCEPTION` em `BEFORE UPDATE OR DELETE` | `MIG/0066_adiantamento_tabelas.sql:460`–`:461` (REVOKE) · `:463` + `:470`–`:478` (função e triggers) |
| **M4** | CHECK `apuracaorepasseitem_saldo_conserva`, literal: `valor_pago IS NULL OR (valor_pago >= 0 AND valor_transportado >= 0 AND (valor_pago = 0 OR valor_transportado = 0) AND ((remanescente < 0 AND valor_pago = 0 AND valor_transportado = saldo_anterior) OR (remanescente >= 0 AND remanescente + saldo_anterior = valor_pago + valor_transportado)))`. **(i)** `valor_transportado` negativo é proibido; **(ii)** com `remanescente < 0` o CHECK **exige** `valor_transportado = saldo_anterior` — isto é, o remanescente negativo é **descartado por contrato**; **(iii)** `transportado_nota` / `transportado_fora` **não aparecem** no CHECK | `MIG/0098_repasse_saldo_minimo.sql:71`–`:81` |
| **M5** | **A dedução do pago por fora hoje não alcança a nota.** O termo `externos_deducao` entra **apenas** no `remanescente` (`creditos - adiantamentos - debitos - externos_deducao + externos_credito`), enquanto `valor_nota`/`valor_fora_nota` são gravados como `r.total_nota`/`r.total_fora` — a divisão **bruta** de `creditos`. A rota de geração usa `valor_nota` para o campo `valor` da `EnvioMassa` | `MIG/0117:910`–`:911` (gravação) · `MIG/0117:860` (remanescente) |
| **M6** | `planejarGeracao` é **pura e testada** (arquivo de 198 linhas). Ordem de decisão por item: `RETIDO` → `SEM_CNPJ` → `SEM_DIVISAO` (`item.valor_nota == null`) → calcula `valor = valor_nota + (remanescente<0 ? 0 : saldo_anterior_nota)` e `gorjeta = valor_fora_nota + (remanescente<0 ? 0 : saldo_anterior_fora)` → `VALOR_ZERO` → `JA_GERADO` → `MOVIMENTO_ABERTO` → `MOVIMENTO_LEGADO_EM_SEMANA_RETIDA`; depois monta a linha com `renderizarMensagem()` | `BK/lib/adiantamento-geracao-movimento.js:114` (MOTIVOS em `:11`–`:28`) · testes em `BK/tests/adiantamento-geracao-movimento-unit.test.js` |
| **M7** | `ApuracaoRepasse` tem **0 linhas** na história ⇒ **não existe apuração legada** | BRIEFING §1 |
| **M8** | Colunas atuais relevantes de `ApuracaoRepasseItem`: `valor_nota`/`valor_fora_nota`; `saldo_anterior`, `saldo_anterior_nota`, `saldo_anterior_fora`, `valor_pago`, `valor_transportado`, `transportado_nota`, `transportado_fora`; `lancamentos_externos numeric(12,2) NOT NULL DEFAULT 0` = efeito **líquido** (negativo deduz, positivo soma) | `MIG/0092:28`–`:29` · `MIG/0098:49`–`:55` · `MIG/0117:675` |
| **M9** | Funções **vivas** que expõem `valor_nota`/`valor_fora_nota`: prévia `hub_adiantamento_repasse` (`MIG/0117:942`), congelado `hub_adiantamento_repasse_congelado` (`MIG/0117:1253`/`:1267`, via `CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_nota,0) END`) e **as duas do app do motorista** (`_motorista`, `_motorista_ultimo_fechado`). `CREATE OR REPLACE` é recusado quando o tipo de retorno ganha coluna ⇒ caminho é `DROP FUNCTION` + `CREATE` + `GRANT` | `MIG/0117:690`–`:707` (nota de método da própria 0117, que diz "são CINCO funções vivas") |
| **M10** | Front — `periodoAberto` = `h.dados?.periodo.situacao === 'aberto'`, e `situacao` vem do backend como `apuracao ? 'fechado' : 'aberto'`. **"Aberto" significa "sem apuração fechada"** — nada a ver com o corte D-1. Botão *Fechar apuração* (`disabled={!h.dados \|\| !periodoAberto}`, handler `fecharDialog.abrir`); botão *Gerar notas da semana* (`disabled={!h.dados \|\| periodoAberto \|\| gerando}`, `title="Feche a apuração antes de gerar as notas."`). Ambos só renderizam sob `podeFechar = permissoes.includes('adiantamentos.pagamento_confirmar')` de `useHubAuth()`. Resultado da geração é **só toast** (`sonner`) + `resumirRecusas()`; não há JSX que itere `recusados`. Semana em exibição = estado `periodo` (`'YYYY-MM-DD'`), default `inicioDaSemanaApuracao(new Date(), apuracaoDiaInicio)` | `FE/app/hub/dashboard/adiantamentos/repasse/page.tsx` (`periodoAberto` ~`:184`, botões ~`:232`–`:259`, `podeFechar` ~`:152`) · `BK/routes/hub-adiantamentos.js:1962` · `FE/components/hub/adiantamento-fechar-apuracao-dialog.tsx` · `FE/lib/hub/adiantamento-recusas.ts` · `FE/lib/hub/periodo.ts` |
| **M11** | Client: `fecharRepasse(periodo)` (`:737`–`:750`) e `gerarMovimentos(periodo)` (`:752`–`:775`), com `GerarMovimentosResponse = { apuracaoId, gerados, semTelefone, recusados: MovimentoRecusado[] }` e `MovimentoRecusado = { entregadorId, nome \| null, motivo, detalhe }` | `FE/lib/hub/adiantamentos-api.ts` |
| **M12** | Tela de **Envio em Massa** = `FE/app/dashboard/page.tsx` (painel **legado**, `'use client'`); upload via `FE/components/action-bar.tsx:109` → `FE/components/import-button.tsx` (input file ~`:165`). O período (`dt_inicial`/`dt_final`) é estado **local do `ImportButton`** (`:65`–`:66`), digitado pelo usuário. **O dashboard não tem noção de semana.** | idem |
| **M13** | `HubAuthProvider` é montado **só** em `FE/app/hub/layout.tsx:42` e `FE/app/selecionar-entidade/layout.tsx:21`. O painel legado usa o `AuthProvider` legado (`FE/app/layout.tsx:47`). **O provider em si não redireciona** — o redirect vive no `HubSessionGuard`, componente **irmão** (`FE/app/hub/layout.tsx:44`). Já existe precedente de import cruzado legado→hub: `FE/components/data-table.tsx:8` importa `@/components/hub/cabecalho-ordenavel`; `FE/app/layout.tsx:9` importa `@/components/hub/env-badge` | idem |
| **M14** | **Não existe nenhum teste vitest cobrindo `gerarMovimentos` nem o botão "Gerar notas da semana"** (`page.test.tsx` tem 19 testes e mocka só `fecharRepasse`; `adiantamentos-api.test.ts` tem 15, nenhum de `gerarMovimentos`). Drivers de integração existentes e verdes: `hub-adiantamentos-integration` 231/0, `hub-lancamento-externo-integration` 150/0, `hub-repasse-lote-integration` 86/0 | `FE/app/hub/dashboard/adiantamentos/repasse/page.test.tsx`, `FE/lib/hub/adiantamentos-api.test.ts` · BRIEFING §8 |

---

## Decision 1 — "num passo só, em transação" (D1): sequência com recuperação idempotente, **não** função SQL única

**Decision**: opção **(b)** do enunciado — a rota **fecha a apuração se ela não existir e segue gerando na mesma requisição**, e passa a ser **re-entrante**: chamada de novo, detecta a apuração já fechada e **continua de onde parou**, em vez de recusar. Opção **(a)** (uma função SQL que feche e gere) é **rejeitada**. A variante **(c)** (nova função SQL que recebe as linhas já planejadas em `jsonb` e insere `EnvioMassa` + trilha numa transação) também é rejeitada.

**Rationale** — na ordem em que as medições decidem:

1. **Não existe transação entre chamadas HTTP PostgREST** (M2). Cada `hubPostgrestRequest` é uma requisição independente. Logo "um passo só, em transação" **só** seria literal se **toda** a geração virasse SQL.
2. Isso exigiria reescrever em `plpgsql` o `planejarGeracao` (M6: oito ramos de recusa, lógica de **dinheiro**, pura e testada) **e** o `renderizarMensagem`. Reescrever lógica de dinheiro que já funciona é exatamente o que a lição da frente anterior condena (BRIEFING §9: *"4 das 15 correções criaram defeito novo. As duas mais elegantes foram as mais caras. Preferir restringir a generalizar"*).
3. O fechamento **já é atômico de ponta a ponta** (M1) e a geração **já é não-atômica por motorista por desenho declarado** (M2, comentário `:2306`). A opção (b) não introduz fragilidade nova: ela usa a atomicidade onde ela já existe e a idempotência onde ela já existe.
4. **Rollback de apuração é impossível** (M3). A garantia "o estado volta ao anterior" **não está disponível em nenhuma das opções** — nem em (a): uma função SQL única que falhasse no meio faria `ROLLBACK` do seu próprio trabalho, mas qualquer falha **depois** do COMMIT (resposta perdida, timeout do proxy, queda do cliente) deixaria o mesmo estado parcial, e sem caminho de volta.

**A garantia que realmente se entrega**, e que o plano declara no lugar da letra da spec: **retrato atômico (1 RPC) + geração idempotente e re-entrante, nunca um beco sem saída.**

**Reinterpretação explícita de FR-002 / Acceptance Scenario 3**: a spec diz *"o estado volta ao anterior e o financeiro pode tentar de novo"*. Medido M3, **o estado não volta — ele continua**. A metade que importa ("o financeiro pode tentar de novo") é entregue integralmente e é a que o operador pediu: D4 removeu o botão manual justamente para *"evitar o estado 'apuração fechada sem movimento', que travaria a geração sem caminho de volta pela tela"*. O que elimina esse travamento é a **remoção do 409 de `:2193`**: a própria rota passa a ser o caminho de volta. Um "apuração fechada sem movimento" deixa de ser um estado terminal e passa a ser um estado **retomável** — e é a trilha `ApuracaoRepasseMovimento` (M2) que garante que a retomada não duplique nada.

**Alternatives considered**:

| Alternativa | Por que não |
|---|---|
| **(a)** Função SQL única `fechar + gerar` | Porta lógica de dinheiro JS testada (M6) para `plpgsql`, incluindo renderização de texto de mensagem; a atomicidade extra que compra é ilusória diante de M3; e teria de escrever na `EnvioMassa`, tabela legada **sem RLS alguma** (BRIEFING §7), por `SECURITY DEFINER` — ampliando a superfície exatamente onde o isolamento de tenant é mais frágil |
| **(c)** Nova função SQL que recebe as linhas já planejadas (`jsonb`) e insere `EnvioMassa` + trilha numa transação | Compra atomicidade **do lote** — contrariando o desenho declarado em `:2306`, que prefere perder um CNPJ a perder a rodada — ao custo de um **caminho novo de escrita de dinheiro em SQL**. A trilha já torna a repetição segura. YAGNI |
| Fechar e gerar em **dois acionamentos** na tela (status quo) | É exatamente o que a operação nunca executou (BRIEFING §1): a frente existe para eliminar esse passo |

---

## Decision 2 — ordem de operações na rota, e por que o pré-flight de pendências vem **antes** do fechamento

**Decision**: a sequência de `POST /repasse/:periodo/movimentos` passa a ser:

1. **Pré-flight de pendências de adiantamento — sempre**, independente de a apuração existir.
2. Se **não** existe apuração para o período: chamar `rpc/hub_adiantamento_repasse_fechar` e **mapear os erros dele**, reusando o mapeamento que a rota `POST /repasse/:periodo/fechar` já tem (`BK/routes/hub-adiantamentos.js:2110`–`:2135`) — **extraído para helper compartilhado, não duplicado**.
3. Seguir o fluxo de geração de hoje (`:2196` em diante), **intocado** exceto pela leitura da coluna nova (Decision 4).

**Rationale**:

- A checagem `APURACAO_COM_PENDENCIAS` existe **dentro** do `fechar` (M1) e portanto **não roda** quando a apuração já existe. Mas FR-008/D5 é sobre **a semana**, não sobre o fechamento: um adiantamento pode ser liberado **depois** de a apuração ter sido fechada. Deixar a proteção só dentro do `fechar` criaria um caminho em que a geração roda sem ela.
- Fazer o pré-flight em JS (e não só confiar no `DETAIL` da exceção SQL) é o que permite **nomear** quem trava (FR-009): o `jsonb_object_agg(status, qtd)` de M1 só devolve **contagem por status**, nunca nomes.
- Os 409 `PERIODO_EM_ABERTO`, `APURACAO_FORA_DE_ORDEM` e `APURACAO_NAO_CONFIGURADA` **não desaparecem com D1** (M1): eles continuam sendo recusas legítimas do fechamento. ⚠️ `PERIODO_EM_ABERTO` em particular: `hub_adiantamento_repasse_pode_fechar` (`MIG/0067_adiantamento_funcoes.sql:1891`) exige `p_instante >= ((p_fim + 1) + horario_corte) AT TIME ZONE timezone`. **Uma semana ainda em curso, ou encerrada antes do corte do dia seguinte, não pode ser gerada** — e isso tem de aparecer na tela com texto próprio. Dizer ao financeiro "gere a semana da tela" (D9) sem explicar o corte D-1 produziria uma recusa misteriosa, que é o modo de falha que o BRIEFING §7 nomeia para a recusa de D5.

**Alternatives considered**: ler o `DETAIL` da exceção `APURACAO_COM_PENDENCIAS` e enriquecer com nomes depois — rejeitado: o `DETAIL` chega como texto num erro HTTP e só existe no caminho em que a apuração **não** existe; e a rota já tem precedente de `JSON.parse(detailDoErro(e))` com `try/catch` silencioso (`:2119`–`:2121`), que é frágil como fonte primária de um requisito MUST.

---

## Decision 3 — D2 + D3: onde a dedução entra, onde o excedente vai, e a migration `0118`

**Decision**: **migration `0118`** (nunca editar a `0117`), com **uma** coluna nova em `ApuracaoRepasseItem`:

```
nota_a_emitir numeric(12,2)   -- NULL quando não há divisão configurada
```

gravada **dentro da transação do fechamento** com o valor **final** da nota: nota bruta da semana + saldo de nota carregado, **menos** a dedução do pago por fora, com piso em 0. A gorjeta (`valor_fora_nota`, `transportado_fora`) fica **intocada** (D2 — *"Só da parte da nota. Gorjeta intacta"*).

O **excedente** (dedução maior que a nota disponível) vai para **`transportado_nota` como valor negativo**.

**Rationale**:

- **D2 é a peça que de fato falta, não só D3** (M5). Hoje a dedução entra apenas no `remanescente` (o livro do **caixa**), e a nota é gravada bruta. Sem a `0118`, o desacoplamento da Decision 1 entregaria uma nota **sem** a dedução — a frente inteira continuaria sem efeito, por outro motivo.
- **Por que `transportado_nota` e não `valor_transportado`**: o CHECK `apuracaorepasseitem_saldo_conserva` (M4) **proíbe** `valor_transportado` negativo **(i)** e, com `remanescente < 0`, ainda **exige** `valor_transportado = saldo_anterior` **(ii)** — ou seja, o CHECK atual **manda descartar** o negativo do caixa. `transportado_nota`/`transportado_fora` **não aparecem** no CHECK **(iii)**: o transporte negativo cabe lá sem tocar restrição nenhuma.
- **A assimetria resultante, declarada**: o excedente é transportado **no livro da nota** — onde ele nasceu, por D2 — e **não** no livro do caixa. Levá-lo ao caixa exigiria **alterar** `apuracaorepasseitem_saldo_conserva`, um CHECK sobre tabela de dinheiro **imutável** (M3) que a própria `0117:682`–`:685` se recusou explicitamente a tocar. Entre "transportar no livro onde a regra do operador colocou a dedução" e "enfraquecer uma restrição de conservação de dinheiro", a escolha restritiva é a primeira.
- **Por que `nota_a_emitir` e não redefinir `valor_nota`**: cinco funções vivas leem `valor_nota` (M9), **duas delas são o app do motorista**, que já exibe `lancamentos_externos` em separado (M8). Netar a dedução dentro de `valor_nota` faria o app **contar a dedução duas vezes** — e o app está explicitamente fora de escopo (BRIEFING §5 *Fora*). Coluna nova é aditiva; redefinição de semântica não é.
- **Por que uma coluna e não duas** (ex.: `nota_deducao_externa` + deixar o cálculo em JS): com a dedução separada, o JS teria de recombinar `valor_nota + saldo_anterior_nota − dedução` **respeitando** o ramo `remanescente < 0` (M6, que hoje descarta o saldo carregado de propósito, por `dec-055/block-008`) **e** o novo saldo carregado **negativo**. É justamente a interação que cria defeito novo. Congelar o número final em SQL mantém a aritmética da nota **num só lugar**, dentro do retrato imutável.

**Identidade de conservação a ser testada** (não é CHECK — é asserção de teste, porque envolve a parcela de `transportado_nota` atribuível à nota da semana):

```
total_nota + saldo_anterior_nota
    = nota_a_emitir + (parcela de transportado_nota) + deducao_aplicada_na_nota
```

**Alternatives considered**:

| Alternativa | Por que não |
|---|---|
| Alterar o CHECK para admitir `valor_transportado` negativo | Enfraquece conservação de dinheiro em tabela imutável; a `0117` já se recusou a isso pelo mesmo motivo |
| Redefinir `valor_nota` como líquido | Dupla contagem no app do motorista (M8/M9), fora de escopo |
| Transportar o excedente em coluna **nova** de dívida (ex.: `divida_nota`) | Um segundo mecanismo de transporte, quando D3 diz literalmente *"pelo mecanismo que já existe"*. `transportado_nota` **é** o mecanismo |
| Deixar a dedução da nota em JS, lendo `lancamentos_externos` | `lancamentos_externos` é o efeito **líquido** (M8): dedução e crédito somados. D2 fala só da dedução. Derivar dali conflataria os dois sentidos |

---

## Decision 4 — quem lê `nota_a_emitir`, e o caso `categorias_nota` ausente (a pergunta de D2)

**Decision**: `planejarGeracao` passa a usar `item.nota_a_emitir` como `valor`, em vez de recalcular `valor_nota + saldo_anterior_nota`. A **gorjeta segue exatamente a fórmula de hoje**. **Sem ramo de fallback** para coluna ausente.

Quando a empresa **não** tem `categorias_nota` configurada, a `0118` grava `nota_a_emitir = NULL` (**não** `0`), e a recusa `SEM_DIVISAO` continua sendo o comportamento — exatamente como hoje (M6).

**Rationale**:

- **Sem fallback porque não há legado**: `ApuracaoRepasse` tem 0 linhas (M7). Um ramo `nota_a_emitir ?? (valor_nota + saldo_anterior_nota)` seria código inalcançável — e, pior, seria um ramo que **passa com e sem a correção**, que é precisamente o anti-padrão que BRIEFING §9 nomeia (*"Teste que passa com e sem a correção é achado, não cobertura"*).
- **`NULL` e não `0`** preserva a distinção *"não configurado"* × *"zero"* que o SQL já usa em `CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_nota,0) END` (M9). `0` colidiria com `VALOR_ZERO`, que é outro diagnóstico.
- **Resposta explícita ao caso NULL de D2** (o ponto que o plano tinha de fechar): sem `categorias_nota` **não existe parte-da-nota de onde deduzir**. Então: não se inventa divisão; **não se gera movimento** (`SEM_DIVISAO`, comportamento de hoje); e **não se transporta excedente nenhum** no livro da nota. A dedução no **caixa** (`0117`, M5) continua valendo como hoje, inalterada. Uma feature que depende da divisão **recusa** quando a divisão não existe — não arbitra um rateio.
- A gorjeta não muda de mecanismo porque D2/D3 não a tocam; mexer nela seria generalizar sem requisito.

---

## Decision 5 — SC-002: o número da tela tem de ser o número do movimento

**Decision**: a prévia `hub_adiantamento_repasse` e o congelado `hub_adiantamento_repasse_congelado` passam a devolver **o mesmo valor líquido** que a geração usará (campo novo no tipo de retorno). As **duas** funções do app do motorista ficam **intocadas**.

**Rationale**:

- SC-002 exige que *"o valor de nota e gorjeta de cada movimento coincida com o exibido na tela de Repasse"*. Se a tela mostrasse a nota **bruta** e o movimento saísse **líquido**, SC-002 falharia por construção — e o financeiro veria um número e pagaria outro, que é o modo de falha mais caro desta base.
- Campo novo no tipo de retorno ⇒ `CREATE OR REPLACE` é **recusado** pelo Postgres; o caminho é `DROP FUNCTION` + `CREATE FUNCTION` + `GRANT EXECUTE ... TO authenticated`, exatamente como `MIG/0117:690`–`:707` documenta (há janela entre o DROP e o GRANT, mas tudo roda na transação do `migrate.sh`, então nenhuma sessão a enxerga).
- App do motorista fora de escopo (BRIEFING §5 *Fora*: *"Sem alteração no app do motorista"*). ⚠️ Isso é uma **dívida nomeada**, não um descuido: depois da `0118` o app mostra a nota bruta + a linha de pago por fora em separado, e a tela do hub mostra a nota líquida. Os dois são verdadeiros e explicáveis; unificar o vocabulário é frente própria. Registrar em `deferred-work.md`.

⚠️ **A prévia depende da claim de escopo do JWT**: sem ela, `hub_jwt_escopo_ids()` não resolve e a prévia devolve **zero** — *parece* defeito e não é (BRIEFING §9). Todo teste de integração desta frente tem de assinar o JWT com escopo, e todo diagnóstico de "a tela está vazia" tem de checar a claim **antes** de suspeitar do cálculo.

---

## Decision 6 — D5: o contrato da recusa que **nomeia** quem trava

**Decision**: `409` com `erro: 'ADIANTAMENTOS_PENDENTES'` e corpo

```
{
  total: int,
  porStatus: { "<STATUS>": qtd, ... },
  motoristas: [ { entregadorId, nome, status } ],   // capada em 20
  motoristasOmitidos: int
}
```

**Campos proibidos no corpo**: CNPJ, telefone, conta bancária, valor. **Nome + status + id bastam** para o financeiro destravar.

O front **renderiza a lista de verdade** (não só toast), reusando o tratamento de `pendencias` que `FE/components/hub/adiantamento-fechar-apuracao-dialog.tsx` já tem — o diálogo que D4 aposenta **cede sua lógica de exibição** para a recusa da geração.

**Rationale**:

- FR-009 exige *quantos, em que status e quais motoristas*. `porStatus` cobre os dois primeiros com a mesma forma que o SQL já produz (M1: `jsonb_object_agg(status, qtd)`); `motoristas[]` cobre o terceiro, que o SQL **não** dá.
- **Cap de 20 + `motoristasOmitidos`**: são **116 pendentes medidos hoje** (BRIEFING §1). Sem cap, uma recusa devolveria uma lista que ninguém lê e que cresce sem teto. 20 nomes é o que cabe numa tela e já diz ao financeiro **onde** mexer; o total exato continua em `total`/`porStatus`.
- **Privacidade (gate de 01/10)**: a recusa é um diagnóstico de operação, não um relatório de cadastro. CNPJ no corpo de um erro é dado pessoal exposto sem necessidade — e o `entregadorId` já é suficiente para o financeiro abrir a solicitação na tela.
- `express.json()` global de 100 KB é limite de **request**, não de resposta — não afeta este corpo; o cap existe por legibilidade e não por limite técnico. (Registrado porque o BRIEFING §restrições o nomeia e é importante **não** confundir os dois.)
- Reusar a exibição do diálogo aposentado é deleção líquida: a lógica sobrevive onde passa a ser necessária, em vez de nascer uma segunda.

**Alternatives considered**: recusar só com contagem (como o `fechar` faz hoje) — rejeitado por FR-009 e porque com 116 pendentes vira adivinhação (BRIEFING §7). Listar **todos** os 116 — rejeitado: resposta grande que ninguém usa.

---

## Decision 7 — D8: um componente, duas montagens

**Decision**: criar `FE/components/hub/gerar-do-repasse-button.tsx` — **um** componente que detém o seletor de semana, chama `gerarMovimentos(periodo)` de `FE/lib/hub/adiantamentos-api.ts` e renderiza resultado/recusa. Montado em dois lugares:

1. **Tela de Repasse** — substitui o botão inline (`~:245`–`:259`) e **recebe a semana em exibição por prop** (D9: a tela manda a semana; o componente não a reinventa).
2. **Tela de Envio em Massa** — em `FE/components/action-bar.tsx`, ao lado do `<ImportButton>`; aqui o componente usa **seu próprio** seletor de semana, porque **ali não existe semana na tela** (M12: o período é estado local do `ImportButton`, digitado no diálogo de upload).

Para FR-016 no painel legado: montar `HubAuthProvider` em `FE/app/dashboard/layout.tsx` **sem** o `HubSessionGuard`.

**Rationale**:

- FR-015 exige *um único componente com uma única chamada*. Duas chamadas divergem (BRIEFING §7).
- **Por que o provider sem o guard** (M13): o `HubAuthProvider` **não** redireciona — o redirect vive no `HubSessionGuard`, componente irmão. Montando só o provider, um usuário sem sessão de hub recebe `permissoes: []` e o botão **simplesmente não renderiza** — FR-016 satisfeito nas duas telas com **zero mecanismo novo**, sem redirect e sem tocar na autenticação legada. Alternativas (passar `podeGerar` por prop que o painel legado não tem como calcular; ou sondar permissão com uma chamada nova) custariam mais e entregariam menos.
- ⚠️ Custo honesto da montagem: o `HubAuthProvider` faz um `GET /me` no mount, então o dashboard legado passa a fazer essa chamada. É a **mesma** chamada que o hub já faz, pelo mesmo proxy. O que **não** se faz é mexer em cookie ou em fluxo de login — a colisão de cookie hub↔legado é incidente conhecido desta base e fica fora do caminho.
- **O import cruzado legado→hub tem precedente** (M13): `FE/components/data-table.tsx:8` importa de `@/components/hub/`, e `FE/app/layout.tsx:9` também. Não é padrão novo.
- **A única diferença entre as duas montagens é a origem da semana** — e ela é obrigatória, não acidental: na tela de Repasse a semana está na tela (D9 manda usá-la); na de Envio em Massa não existe, então o componente a oferece com o mesmo default do hub (`inicioDaSemanaApuracao`, M10).

---

## Decision 8 — FR-018: tenant explícito em toda query nova

**Decision**: toda query nova da rota leva filtro explícito de empresa. A consulta de pendências (Decision 6) usa `id_empresa=in.(<escopo>)`, como as demais do arquivo. A consulta de movimentos na `EnvioMassa` continua usando a resolução de grupo que a rota já faz: `mesmoGrupoQue(GRUPO_MOVEE_ID, GRUPO_MOVEE_ID, cache)` → `id_empresa=in.(...)` (`BK/routes/hub-adiantamentos.js:2268`–`:2271`).

**Rationale**: a `EnvioMassa` **não tem RLS alguma** (BRIEFING §7) — o filtro de `id_empresa` na query é a **única** proteção de tenant, e isso foi medido na frente `corrigir-valor`. Constitution §II (NON-NEGOTIABLE) exige escopo resolvido server-side a partir do token. E a regra de domínio do `CLAUDE.md` é `mesmoGrupoQue(_, 6)`, **nunca** `id_empresa === 6` estrito — a rota já respeita isso e o plano não introduz exceção.

---

## Dívidas nomeadas (não pagas nesta frente)

| Dívida | Por que não agora |
|---|---|
| App do motorista mostra nota **bruta** + pago por fora em separado, hub mostra nota **líquida** (Decision 5) | App fora de escopo por BRIEFING §5. Unificar vocabulário é frente própria — e a lição de 23/09 manda **abrir a tela e mostrar onde o dado já aparece** antes de propor rótulo novo |
| Excedente não é transportado no livro do **caixa** (Decision 3) | Exigiria alterar CHECK de conservação em tabela imutável. Se o operador quiser simetria caixa↔nota, é decisão de negócio + migration dedicada |
| `id_empresa` **hardcode 6** nas escritas do fechamento (M1) | Pré-existente, fora de escopo. Nomeado para que ninguém o leia como introduzido aqui |
