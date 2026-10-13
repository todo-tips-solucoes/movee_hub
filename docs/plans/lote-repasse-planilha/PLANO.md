# Lote de repasse enxerga movimento vindo de planilha

> Pedido do operador em 2026-10-12, depois de descobrir que o lote mostrava **zero aptos**
> com 53 notas já aprovadas na semana: *"vamos com a opção b"*.

## 1. O problema, medido

A `hub_repasse_lote_avaliar` (migration 0108) verifica a nota olhando **só**
`ApuracaoRepasseMovimento` — tabela que **apenas** o botão "Gerar notas da semana" preenche.

Mas em produção os movimentos entram por **importação de planilha** no Envio em Massa. Medido em
12/10, na semana 05–11/10:

| | |
|---|---|
| Movimentos abertos da planilha | **950** (criados num único minuto, 12/10 19:25) |
| Com linha em `ApuracaoRepasseMovimento` | **0** |
| Apurações de repasse existentes em produção | **0** (nenhuma, nunca) |
| Entregadores com movimento casável por CNPJ | **907** de 1.487 com CNPJ no hub |
| Destes, com **todas** as notas aprovadas | **54** |
| Com conta bancária aprovada | **51** · **R$ 40.333,35** parados |

Sem a mudança, esses 54 nunca são pagos pelo hub. E "Gerar notas da semana" não resolve: recusaria
os 950 com `MOVIMENTO_ABERTO`, e pediria a nota **de novo** a quem já emitiu.

## 2. O que muda

O `LEFT JOIN LATERAL` da elegibilidade passa a considerar **dois caminhos**:

- **(a) hub** — como hoje, via `ApuracaoRepasseMovimento`;
- **(b) planilha** — `EnvioMassa` casando `cnpj_prestador` (via `Entregador.motorista_id` →
  `ContaMotorista.cnpj_prestador`) **e** período (`dt_inicial/dt_final` = `periodo_inicio/periodo_fim`).

**Decisão do operador: exigir nota aprovada em TODOS os movimentos** do conjunto unido.

### O que NÃO muda

O valor continua vindo de `ApuracaoRepasseItem.valor_pago` — **nunca** de `EnvioMassa.valor`
(double precision, e não desconta adiantamento). A mudança é **onde procurar a nota**, não quanto
pagar. A decisão D1 do plano da F5 continua de pé, e **o operador ainda precisa fechar a apuração**.

## 3. Por que é seguro aqui (medido, não suposto)

| Risco | Medição |
|---|---|
| CNPJ duplicado no período casaria 2 movimentos | **zero** — 950 movimentos, 950 CNPJs distintos |
| Datas não baterem com a apuração | **batem exatamente** — movimentos em `05/10–11/10`, apuração (semana começa na segunda, config v16) idem |
| Padrão instável entre semanas | consistente: 14–20/09, 21–27/09, 28/09–04/10, 05–11/10, sempre segunda a domingo |
| Custo da consulta | **224 ms** com Seq Scan; índice autorizado pelo operador |

## 4. As quatro armadilhas (cada uma quebra em silêncio)

1. **Dupla contagem** quando o movimento existir nos dois caminhos — na transição vai acontecer.
   Contar **distinto por movimento**, ou `aprovadas < total` bloqueia quem está correto.
2. ⚠️ **Movimento com `EnvioMassa` apagada tem de CONTINUAR bloqueando.** Hoje o caminho (a) conta
   `count(m.id)` (a linha da trilha), então movimento apagado conta no total e não nas aprovadas →
   `NOTA_PENDENTE`. **Isso é proposital**: sem a linha não há prova da nota. Reescrever partindo da
   `EnvioMassa` faria esse caso **sumir do total** e pagar sem prova.
3. **Escopo entre empresas** na junção nova — a `EnvioMassa` tem RLS com policy `USING (true)`, que
   **não filtra nada**. O filtro é responsabilidade da query.
4. **Entregador sem CNPJ no hub** (120 de 1.607) não casa e continua fora. Conservador e correto.

## 5. Interface: nada a fazer (medido)

O operador escolheu "bloqueados agrupados e recolhidos" e "sem selo de origem" — e **a tela já faz
exatamente isso**: `agruparBloqueadas` + `<details>` por motivo, com contagem, ação sugerida e os
nomes só ao expandir. Só o número muda: de 0 aptos para 54.

Dimensionado antes de decidir não mexer:
- payload da prévia com 907 candidatos: **~106 KB** — aceitável para tela de operador;
- no máximo **6 grupos**; os 853 nomes ficam em `<details>` fechado (ocultos, não ausentes).

853 nós simples são triviais para o React. **Não otimizar o que não dói** — se na prática pesar, é
uma linha para renderizar os nomes só na abertura. Limite declarado, não escondido.

## 6. Entregáveis

1. Migration `0109` — os dois caminhos na `hub_repasse_lote_avaliar` + índice em
   `EnvioMassa (cnpj_prestador, dt_inicial, dt_final)`.
2. Integração: os 4 cenários (só hub · só planilha · nos dois · `EnvioMassa` apagada), com controle
   negativo.
3. `infra/producao/smoke-deploy.sh` — substitui a sequência manual de conferência pós-deploy.
4. Frontend: **nada**.

## 7. Divergências da execução (medidas, não supostas)

| # | O que eu especifiquei | O que o código pedia | Desfecho |
|---|---|---|---|
| 1 | casar período com `dt::date = data` | **faixa** `dt >= data AND dt < data+1` | **A faixa venceu.** Com `::date` o planner **não usa** as colunas de data do índice. ⚠️ E os 224 ms que eu medi não eram falta de índice: já existiam `idx_envio_massa_cnpj_prestador` (0094) e `idx_enviomassa_cnpj_prestador_legado` (0033) — era o **`::date` impedindo o uso**. Provado contra produção: as duas formas casam **os mesmos 950** movimentos. |
| 2 | "dupla contagem é bug: conte distinto" | o mutante `UNION ALL` **continuou apta** no caso C | **Eu estava errado sobre o sintoma.** Quando o mesmo movimento aparece 2×, `total` e `aprovadas` somam igual e `aprovadas < total` não dispara. O `UNION` fica, por correção conceitual, mas **nenhum teste distingue as duas versões** — e o executor recusou inventar um teste oco para fingir que sim. |
| 3 | escopo pelo `id_empresa` do item | `hub_jwt_escopo_ids()` (matriz + filiais) | Mantido o escopo amplo: movimento a mais no `total` só **endurece** a regra. Lado conservador. |

### ⚠️ O fuso, que é a armadilha de verdade

Em produção as datas estão gravadas como **`03:00:00` UTC** (= meia-noite de Brasília) e a sessão do
PostgREST roda em **`Etc/UTC`**. A faixa `>= 05/10 AND < 06/10` pega `05/10 03:00 UTC` corretamente —
confirmado: **950 de 950**.

Mas o limite existe e é herdado tanto pela faixa quanto pelo `::date` que eu havia especificado: um
movimento gravado às 22h de Brasília cairia no **dia seguinte em UTC** e não casaria com a semana.
Hoje não acontece, porque o import grava meia-noite local. **Se o formato de gravação da data mudar,
este casamento quebra em silêncio** — nenhum erro, só o motorista sumindo da lista de aptos.

### Outras observações do executor

- As tabelas de apuração são **imutáveis por trigger** (`hub_bloqueia_alteracao_apuracao`); o teste
  usa `session_replication_role = replica` só para limpar o que criou.
- `CREATE INDEX` comum, não `CONCURRENTLY`: o `migrate.sh` aplica com `psql -1` (transação única) e
  `CONCURRENTLY` falharia ali. Mesmo raciocínio da 0094. Com ~4 mil linhas/semana o lock é curto.
- Rollback: `DROP INDEX IF EXISTS idx_envio_massa_cnpj_periodo` + reaplicar a função da 0108.

## 8. Provas

**7 casos por HTTP no PostgREST** (`infra/hub/testes/hub-repasse-lote-planilha.sh`), todos PASS:

| Caso | Esperado | Resultado |
|---|---|---|
| A · só trilha (hub) | apta | PASS |
| B · só planilha (CNPJ + período) | **apta** (era o bug) | PASS |
| C · o mesmo movimento nos dois caminhos | apta, contando 1× | PASS |
| E · CNPJ também em outra empresa, pendente lá | apta (outro tenant não conta) | PASS |
| B2 · 2 movimentos, 1 aprovado | `NOTA_PENDENTE` | PASS |
| D · trilha com `EnvioMassa` apagada | `NOTA_PENDENTE` | PASS |
| F · entregador sem `motorista_id` | `NOTA_PENDENTE` | PASS |

**Controle negativo**: com a função da 0108 de volta, **B, C e E viram `NOTA_PENDENTE`** e só A fica
apta — confirma que o bug existia e que a 0109 é a causa da correção. Mutante sem o filtro de escopo:
o caso E quebra, que é exatamente o que ele existe para pegar.

## 9. Smoke de produção

`infra/producao/smoke-deploy.sh` — 12 verificações, exit 0 contra a produção atual.

⚠️ **A brecha que ele tinha e que foi fechada**: o arquivo de strings precisa ser atualizado a cada
entrega; esquecer faria o smoke **passar** provando o bundle anterior — justamente quando ele deveria
pegar "a imagem não subiu". Agora cada string carrega a **tag para a qual vale**, e tag divergente é
**FALHA**, não aviso. Aviso ignorado é o mesmo silêncio.

Também exercitado de verdade (não só em lógica): `curl 000` distingue **certificado recusado** de
**aplicação fora do ar** — confusão que já custou tempo neste projeto.
