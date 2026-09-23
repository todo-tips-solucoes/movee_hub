# Briefing — repasse, extrato e a nota vinda da produção

Entrada para o fluxo `feature-00c` (specify → clarify → plan → checklist → create-tasks →
execute-task → converge → review-task). **Leia o `CLAUDE.md` antes de qualquer coisa**: o
ambiente "homologação" É produção, o rito do ciclo git é cláusula pétrea e a autorização é
**por etapa**. Repositório público — nenhum dado pessoal em código, teste, log ou documento.

Tudo na §1 foi **medido em produção em 2026-09-22**, não suposto.

---

## 1. O estado de hoje, medido

| O que | Medida |
|---|---|
| Repasse de qualquer semana no hub | **0 linhas, R$ 0,00** |
| Causa | `categorias_extrato` está **NULA** na config vigente (v9) |
| Se o extrato usasse as 18 categorias da produção | **692 motoristas · 3.397 lançamentos · R$ 88.744,15** só na semana corrente |
| O campo `categorias_extrato` na tela | **não existe** — está no estado do formulário (`page.tsx:77,101,209`) e **nunca é renderizado** |
| Apurações fechadas | **0** — nada foi pago errado; o repasse só não somava |
| `repasse_visivel_app` · `apuracao_dia_inicio` · dias | `true` · `1` (segunda) · `3` (quarta) |
| `desconto_adiantamentos` · `desconto_debitos` | `true` · `true` |

**Conclusão:** o repasse semanal **nunca funcionou pela interface**, e não tinha como —
faltava o campo na tela.

### O que já existe e não precisa ser inventado

- **O movimento da EnvioMassa já separa o que queremos:** tem `valor` (base da nota) e
  `gorjeta` (fora da nota). A FastAPI valida exatamente isso (`valid_valor`: "valor da nota
  não confere com o valor do movimento").
- **A FastAPI é externa e não está neste repositório.** Ela recebe só o **XML** e o
  `id_empresa` (+ `nexus`), acha sozinha o movimento aberto pelo CNPJ do prestador e grava
  `nota_ok`/`erro_validacao`. O backend só relê. Roteamento por grupo: Movee → endpoint
  não-nexus; demais → nexus (`CLAUDE.md §Regras de domínio`).
- **A regra de família de categorias** (migration 0087, `hub_adiantamento_categoria_familia`
  + `hub_adiantamento_categoria_casa`) já existe e está em produção, mas **só o cálculo da
  produção do adiantamento a usa**. O repasse ainda compara por nome exato.
- O app do motorista já tem `/repasse`, `/movimento` e `/validar`.

---

## 2. Decisões do operador (2026-09-22) — não reabrir sem ele

1. **Base da nota:** produção bruta da semana **menos** as categorias marcadas como "não
   entra na nota" (hoje, gorjeta; amanhã, o que for). **Parametrizável**, não fixo.
2. **Período:** a semana de apuração (segunda a domingo), a mesma do repasse.
3. **Validação:** **manter a FastAPI como está.** O hub passa a **gerar o movimento** na
   EnvioMassa no lugar da planilha. Não mexer nos endpoints de validação nesta etapa.
4. **Extrato no app:** mostra **só as categorias configuradas** (as do extrato) — o que ele
   vê é exatamente o que forma o repasse.
5. **Gatilho da geração:** **botão manual no hub** ("gerar notas da semana"), não automático.
6. **O que não entra na nota** é somado no campo **`gorjeta` que já existe** — reusa o
   contrato atual e a validação não muda.
7. **Transição:** planilha e hub **convivem**; o hub **recusa** gerar movimento para quem já
   tem movimento aberto na semana (aviso de duplicidade), em vez de bloquear a planilha.
8. **A marcação "entra na nota"** é atributo **das categorias do extrato** — uma lista só.
9. **Os valores do repasse saem da coluna `valor` de `FaturamentoLancamento`** — travar isso
   com teste, não deixar implícito.

---

## 3. Fases, em ordem de prioridade

A regra que ordena tudo: **não inviabilizar o app nem o hub**. Cada fase entrega valor
sozinha e pode ir a produção sem a seguinte.

### F1 — Destravar o repasse (o que está quebrado agora)

- Expor **`categorias_extrato`** na tela de configuração, reusando o componente de
  categorias da produção (busca, contagem, famílias) — `app/hub/dashboard/adiantamentos/
  configuracoes/page.tsx` + `lib/hub/adiantamento-categorias.ts`.
- **Estender a regra de família ao extrato** (decisão B do operador): trocar
  `f.descricao = ANY (COALESCE(categorias_extrato, …))` por
  `hub_adiantamento_categoria_casa(f.descricao, …)`. São **4 funções / 6 pontos**; achar as
  versões mais recentes com
  `grep -lE "categorias_extrato" infra/hub/migrations/*.sql` (as funções foram redefinidas
  em 0071/0082/0083 — **nunca** partir da 0067 sem conferir).
- Teste que trava a origem do valor: o repasse soma `FaturamentoLancamento.valor` (decisão 9).
- ⚠️ É **código de dinheiro**: controle negativo obrigatório (com a comparação antiga, o
  teste tem de falhar) e revisão independente antes do PR.

**Pronto quando:** o hub mostra o repasse da semana com valores, e o app do motorista também.

### F2 — Extrato no app do motorista

- Endpoint + tela com os lançamentos do motorista **das categorias do extrato**, com
  **consolidado da semana** e **consolidado por dia**.
- Reusar `formatCurrency` (trata ausência com "—"); o painel aprendeu isso do jeito difícil
  (incidente 2026-09-22, `formatBRL(null)`).

**Pronto quando:** o motorista vê o próprio extrato e os dois consolidados batem com o
repasse que o hub mostra.

### F3 — "Entra na nota" e a separação do valor

- Interruptor **por categoria do extrato**: entra na nota / não entra.
- No app: **"valor da nota"** e **"outros lançamentos (não entram na nota)"**, com o total a
  receber sendo a soma dos dois.
- No hub, no repasse: produção da semana − adiantamentos (o desconto já existe e está ligado).

**Pronto quando:** o motorista enxerga quanto vai para a nota e quanto não vai, antes de
qualquer nota ser emitida.

### F4 — Gerar o movimento a partir do repasse (o coração da mudança)

- Botão no hub: **"gerar notas da semana"** para uma apuração **fechada**.
- Para cada motorista: cria movimento na EnvioMassa com `valor` = base da nota e `gorjeta` =
  soma do que não entra na nota.
- **Guarda de duplicidade:** recusa (com relatório por motorista) quem já tem movimento
  aberto na semana. A planilha continua funcionando em paralelo (decisão 7).
- **Nada muda na FastAPI nem nos endpoints de validação.** O app segue validando como hoje.
- Idempotente: reexecutar não duplica.

**Pronto quando:** o motorista recebe a ordem de emitir vinda do hub, emite, valida pelo
`/validar` de sempre, e a nota é aprovada.

### F5 — Estudo da rotina de validação (só depois do F4 rodando)

Levantamento **medido**, sem mexer em nada: o que a FastAPI confere hoje, o que passa a
divergir com a origem nova (competência, descrição do serviço, valor), e se vale mudar algo.
Entrega um documento com opções e riscos — **não** código.

---

## 4. Riscos e o que NÃO fazer

- **Não mexer na FastAPI nem nos endpoints de validação** nas fases F1–F4 (decisão 3). O app
  do motorista em produção depende deles.
- **Não bloquear o upload de planilha** (decisão 7) — a operação atual não pode parar.
- **Não tocar em `categorias_producao`** (do adiantamento). É outra lista, com outra função,
  já em produção e em uso pelo piloto.
- **Cuidado com a versão da função**: várias funções de repasse foram redefinidas depois da
  0067. Partir da versão errada desfaz correções (0082/0083).
- **Nenhuma apuração fechada ainda** — dá para corrigir o repasse antes do primeiro
  fechamento. Depois do primeiro fechamento, valores congelados não podem ser reescritos.

## 5. Gates (o mínimo de cada PR)

`tsc --noEmit` · suíte unit do backend e do painel · `next build` se tocar frontend ·
detector impeccable 0 achados se tocar UI · E2E do hub · integração do adiantamento ·
**smoke full-chain** se tocar leitura via PostgREST (foi o que pegou o `select=*` em
2026-09-22) · controle negativo em tudo que for dinheiro.

Migration nova = rito integral de produção, com rollback testado antes (ver
`docs/plans/adiantamento-motorista/RUNBOOK-GO-LIVE.md` e o rollback da 0087 como modelo).
