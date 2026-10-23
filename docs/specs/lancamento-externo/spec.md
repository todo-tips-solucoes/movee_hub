# Feature Specification: Importar lançamentos pagos por fora do sistema

**Feature**: `lancamento-externo`
**Created**: 2026-10-22
**Status**: Draft
**Briefing**: [`docs/briefing.md`](../../briefing.md) · **Constitution**: v1.1.0

> ⚠️ **Prazo é parte do requisito, não contexto.** A dedução só existe se o lançamento
> entrar **antes do fechamento da apuração**, que grava retrato imutável em
> `ApuracaoRepasseItem`. A semana 19–25/10 fecha a partir de 26/10 e o pagamento sai
> 28/10 — janela útil: **26/10 até o fechamento** (`docs/briefing.md:20-27`). Entregar
> depois disso entrega zero valor para a semana corrente.

---

## Contexto do Problema

O financeiro paga valores aos motoristas **por fora do sistema** (adiantamento na mão,
vale, acerto) e hoje não tem como informar isso ao hub. O repasse semanal paga o valor
cheio, sem descontar o que já saiu do caixa — o motorista recebe duas vezes pelo mesmo
dinheiro.

A feature **não é só de adiantamento**. Decisão do operador na mesma conversa: *"posso
usar essa feature para inputar outros valores pagos por fora"*. Por isso o modelo nasce
genérico, com **tipo** e **sinal derivado do tipo**, e `ADIANTAMENTO` é apenas o primeiro
tipo (`docs/briefing.md:14-17`).

---

## Decisões Ratificadas (ENTRADA — não são pendências)

Estas 11 decisões foram tomadas pelo operador antes desta spec. Estão aqui para
rastreabilidade, não para revisão.

| # | Decisão | Justificativa do operador |
|---|---|---|
| D1 | Tabela **nova e genérica** (`LancamentoExterno`), não `AdiantamentoSolicitacao` | *"posso usar essa feature para inputar outros valores pagos por fora"* — recusou tabela só de adiantamento |
| D2 | Dois sentidos, **sinal derivado do TIPO** (`ADIANTAMENTO` deduz, `AJUSTE_CREDITO` soma). Valor na planilha **sempre positivo** | Evita erro de sinal digitado: quem preenche nunca decide o sinal |
| D3 | A dedução **soma as duas fontes**, no fechamento **e** na prévia | É o caminho do dinheiro: prévia e fechamento não podem divergir |
| D4 | A semana é a que **contém a data do pagamento** | Conceito distinto do adiantamento do app (ver "Dois conceitos de data") |
| D5 | Chave do motorista: **CNPJ do prestador** | Nome tem homônimos reais; id não está na mão do financeiro |
| D6 | Idempotência por **empresa + CNPJ + data do pagamento + tipo** (um de cada tipo por dia) | Reenviar o mesmo arquivo tem de ser seguro |
| D7 | Semana já fechada ⇒ **recusa só a linha** (`SEMANA_JA_FECHADA`), aplica as demais | Uma linha atrasada não pode invalidar o arquivo todo |
| D8 | CNPJ que não casa ⇒ **recusa só a linha**, contando por motivo. **O CNPJ não volta na resposta** | Dado de terceiro; gate owasp de 01/10 já cortou isso neste caminho |
| D9 | `AJUSTE_CREDITO` compõe o remanescente **antes** do teste do saldo mínimo | Quem tinha R$ 4,00 e recebe R$ 3,00 passa a R$ 7,00 e **recebe**, em vez de ter tudo retido |
| D10 | Permissão **`adiantamentos.pagamento_confirmar`** (a mesma do retorno da Transfeera) | Já pertence a `financeiro`, `financeiro_aprovador` e `admin_plataforma` desde a 0115 — nada a configurar antes do prazo |
| D11 | **Uma única tela**: botão "Importar pagos por fora" na aba Repasse já existente + diálogo | Qualquer tela além desta exige nova aprovação |

### Dois conceitos de data — a diferença é deliberada (D4)

| Fluxo | Regra da semana | Por quê |
|---|---|---|
| Adiantamento do app (existente) | `data_producao = data_solicitacao - 1` | O motorista pede hoje sobre a produção de ontem; a data da **produção** é que define a semana |
| **Lançamento externo (esta feature)** | a semana que **contém a data do pagamento** informada na planilha | O financeiro informa **quando o dinheiro saiu do caixa**; não há produção associada |

Confundir os dois joga o lançamento na semana errada e o dinheiro é descontado do período
errado. A spec exige que a regra desta feature seja a data do pagamento, **sem** o
deslocamento de −1 dia.

---

## Clarifications

### Session 2026-10-22 (onda-002)

- **Q1 — célula nativa do Excel para data e valor** → **Aceitar os dois formatos (texto e
  nativo), com conversão determinística e recusa de linha na menor ambiguidade.** Recusar
  a célula nativa rejeitaria justamente a planilha que o financeiro produz: em
  `xlsx@0.20.3` a conversão de data vem **desligada** por padrão, logo uma data
  preenchida no Excel chega como **número de série** e o valor como **número**. Regras
  medidas no runtime instalado, não supostas (ver §Anexo — *Conversão de data e valor*):
  a data de serial é convertida **só** por `XLSX.SSF.parse_date_code(serial, { date1904 })`;
  o valor numérico só é aceito quando já é múltiplo de centavo; data fora da faixa, valor
  não-positivo, valor acima do teto por linha e epoch ilegível são **recusa de linha com
  motivo nomeado**. Ler o número errado em silêncio continua sendo o único desfecho
  proibido. Materializa FR-045 a FR-048, FR-051.
- **Q2 — FR-022, interação com a flag `desconto_adiantamentos`** → **o lançamento externo
  do tipo `ADIANTAMENTO` RESPEITA a flag** (decisão do operador). A flag passa a
  significar, sem exceção, "esta empresa não desconta adiantamento do repasse" — vale
  para o do app e para o pago por fora. O operador **aceitou explicitamente o risco**: com
  a flag desligada, a empresa paga o repasse cheio a quem já recebeu por fora, isto é,
  **paga duas vezes**. Mitigação aprovada e exigida: a tela **avisa** quando existir
  lançamento externo de dedução numa semana cuja flag está desligada — o repo nunca falha
  calado. Materializa FR-022 e FR-049.
- **Q3 — reuso de `lerXlsx` / `conferirTetoZip` / `paraCentavos`** → **extração para
  módulo compartilhado, não import** (a correção de `docs/briefing.md:§5`, que mandava
  reusar os três por import, está registrada em
  [`docs/plans/lancamento-externo/BRIEFING.md`](../../plans/lancamento-externo/BRIEFING.md)).
  Só `lerXlsx` é exportado; `conferirTetoZip` é interna e o leitor compara contra o
  cabeçalho de 21 colunas do retorno da Transfeera. A extração é de **código vivo em
  produção desde 2026-10-22**, logo exige rede de não-regressão explícita. Materializa
  FR-050.

---

## User Scenarios & Testing

### User Story 1 - Descontar do repasse o que já foi pago por fora (Priority: P1)

O financeiro pagou adiantamentos na mão durante a semana. Antes de fechar a apuração, ele
sobe a planilha com CNPJ, data e valor de cada pagamento, escolhendo o tipo
`ADIANTAMENTO` no diálogo. Ao fechar a apuração, o repasse de cada motorista já vem
descontado do que ele recebeu por fora.

**Why this priority**: é a razão de a feature existir e a única que o prazo de 26/10
cobra. Sem ela, nada mais tem valor — o motorista continua recebendo duas vezes.

**Independent Test**: lançar um valor para um motorista conhecido numa semana aberta,
fechar a apuração dessa semana e verificar que o item do repasse desse motorista
diminuiu exatamente o valor lançado, e que o de todos os outros motoristas ficou intacto.

**Acceptance Scenarios**:

1. **Given** a semana está aberta e um motorista tem R$ 100,00 de remanescente,
   **When** o financeiro lança R$ 30,00 de `ADIANTAMENTO` para o CNPJ dele com data
   dentro dessa semana e a apuração é fechada,
   **Then** o repasse desse motorista é de R$ 70,00 e nenhum outro motorista é afetado.
2. **Given** um motorista tem dois lançamentos de `ADIANTAMENTO` em dias diferentes da
   mesma semana, **When** a apuração é fechada,
   **Then** a dedução é a **soma** dos dois.
3. **Given** um motorista tem adiantamento pelo app **e** lançamento externo na mesma
   semana, **When** a apuração é fechada,
   **Then** as duas fontes são deduzidas (nenhuma substitui a outra) e nenhuma é contada
   duas vezes.
4. **Given** um lançamento com data fora da semana que está sendo fechada,
   **When** a apuração é fechada,
   **Then** esse lançamento **não** afeta esta apuração.

---

### User Story 2 - Conferir o efeito na prévia antes de fechar (Priority: P2)

Antes de fechar — ação irreversível —, o financeiro abre a prévia do repasse e vê os
valores já com os lançamentos externos aplicados, podendo conferir se o desconto bate com
o que ele pagou de fato.

**Why this priority**: é a rede de proteção do caminho do dinheiro. O fechamento é
imutável; sem a prévia refletindo o lançamento, o financeiro só descobriria um erro
**depois** de congelar o retrato, sem desfazer. Entregar P1 sem P2 significa pedir ao
operador para fechar às cegas.

**Independent Test**: lançar um valor numa semana aberta e, **sem fechar nada**, abrir a
prévia dessa semana e verificar que o valor exibido já reflete o lançamento — e que ele
desaparece da prévia da semana seguinte.

**Acceptance Scenarios**:

1. **Given** um lançamento de `ADIANTAMENTO` aplicado numa semana aberta,
   **When** o financeiro consulta a prévia dessa semana,
   **Then** o valor a pagar exibido já está descontado, com o mesmo número que o
   fechamento produziria.
2. **Given** a mesma situação, **When** o fechamento é executado em seguida,
   **Then** o valor congelado é **idêntico** ao que a prévia mostrava (prévia e
   fechamento nunca divergem).

---

### User Story 3 - Reenviar o arquivo sem medo e saber o que foi recusado (Priority: P3)

O financeiro sobe a planilha, vê quantas linhas foram aplicadas e quantas foram
recusadas, com o motivo de cada grupo. Ao perceber que faltava uma linha, corrige a
planilha e sobe o arquivo **inteiro** de novo: as linhas já aplicadas não são duplicadas
e a nova entra.

**Why this priority**: sem idempotência, o reenvio — que é o comportamento natural de
quem corrige uma planilha — duplicaria dedução, e duplicar dedução tira dinheiro do
motorista. A contagem por motivo é o que permite ao financeiro agir sobre o que falhou.

**Independent Test**: subir o mesmo arquivo duas vezes e verificar que a segunda
aplicação não altera nenhum valor, devolvendo as linhas repetidas como `JA_APLICADO`.

**Acceptance Scenarios**:

1. **Given** um arquivo já aplicado com sucesso, **When** o financeiro sobe o mesmo
   arquivo outra vez, **Then** nenhuma linha é aplicada de novo, todas voltam contadas
   como `JA_APLICADO`, e nenhum valor de repasse muda.
2. **Given** um arquivo já aplicado, **When** o financeiro sobe um arquivo com a mesma
   chave (empresa + CNPJ + data + tipo) mas **valor diferente**,
   **Then** a linha é **recusada** com motivo próprio e o valor original é preservado —
   o sistema nunca sobrescreve um lançamento.
3. **Given** um arquivo com linhas boas e linhas de CNPJ desconhecido,
   **When** o arquivo é processado, **Then** as boas são aplicadas, as demais são
   recusadas com motivo, e a resposta traz a contagem por motivo **sem** nenhum CNPJ ou
   nome.
4. **Given** um arquivo cujo cabeçalho não bate com o contrato,
   **When** o financeiro tenta subir, **Then** **nenhuma** linha é aplicada e a mensagem
   diz qual cabeçalho era esperado.
5. **Given** um arquivo em que uma linha cai numa semana **já fechada**,
   **When** o arquivo é processado, **Then** essa linha é recusada como
   `SEMANA_JA_FECHADA` e as demais são aplicadas normalmente.

---

### User Story 4 - Creditar um valor e tirar o motorista da retenção (Priority: P4)

O financeiro precisa devolver/creditar um valor a um motorista (acerto a favor dele). Ele
sobe a planilha escolhendo o tipo `AJUSTE_CREDITO`. O valor **soma** ao remanescente da
semana, e um motorista que estava retido por ficar abaixo do saldo mínimo passa a receber.

**Why this priority**: é o que torna o modelo genérico (razão de D1) e já está decidido,
mas o que o prazo de 26/10 cobra é a dedução. Entregável de forma independente, sobre a
mesma estrutura.

**Independent Test**: lançar `AJUSTE_CREDITO` para um motorista cujo remanescente está
**abaixo** do saldo mínimo, num valor que o leve acima do piso, e verificar que ele passa
de retido a pago.

**Acceptance Scenarios**:

1. **Given** um motorista com remanescente de R$ 4,00 e saldo mínimo de R$ 5,50 (portanto
   retido), **When** recebe `AJUSTE_CREDITO` de R$ 3,00 na mesma semana e a apuração é
   fechada, **Then** o remanescente é R$ 7,00, ele **recebe** (não é retido) e a
   conservação de saldo do item continua válida.
2. **Given** o mesmo motorista, **When** o crédito o leva a um total ainda **abaixo** do
   piso, **Then** ele permanece retido e o valor segue transportado para a semana
   seguinte, sem perda.
3. **Given** um motorista com `ADIANTAMENTO` e `AJUSTE_CREDITO` na mesma semana,
   **When** a apuração é fechada, **Then** os dois são aplicados com os sinais opostos
   corretos, derivados **do tipo** — nunca do sinal do valor na planilha.

---

### Edge Cases

- **Célula nativa do Excel**: o financeiro preenche a planilha no Excel, onde uma célula
  formatada como data chega ao sistema como número de série e uma célula de valor chega
  como número — não como o texto do layout. Este é o caso **comum**, não a borda.
  **Resolvido (Q1)**: os dois formatos são aceitos, com conversão determinística e recusa
  de linha na menor ambiguidade (FR-045 a FR-048).
- **Planilha salva no Mac (epoch 1904)**: o mesmo número de série significa **duas datas
  diferentes** dependendo do epoch do arquivo — medido: serial `46309` vale `2026-10-14`
  com epoch 1900 e `2030-10-15` com epoch 1904, ou seja **4 anos e 1 dia** de
  deslocamento, sem nenhum sinal de erro. A conversão MUST ler o epoch do próprio arquivo
  (FR-046); epoch ilegível é recusa de linha, nunca palpite.
- **Data nativa e fuso horário**: converter a data por `Date` e ler o dia por
  `toISOString()` desloca a data em um dia num host a oeste de Greenwich (medido: a célula
  `2026-10-15` lida com `cellDates:true` chega como `2026-10-14T21:00:00Z`). A data MUST
  ser tomada pelos componentes de calendário, nunca por formatação em UTC (FR-046).
- **Valor nativo com precisão perdida**: `100.005` não é representável em centavos — o
  arredondamento altera o valor e a direção do arredondamento é convenção, não dado. É
  recusa de linha (FR-047), nunca escolha silenciosa.
- **Valor ambíguo**: `1.234` (ponto sem decimais) pode ser R$ 1,23 ou R$ 1.234,00 — a
  diferença é de 1000×. O sistema MUST recusar a linha, nunca escolher.
- **Valor zero ou negativo na planilha**: o layout exige valor positivo; linha fora disso
  é recusada com motivo, nunca interpretada como o sentido oposto (D2).
- **CNPJ sem motorista vinculado**: população conhecida de órfãos (o vínculo foi
  construído por similaridade de nome). É recusa **de linha** com motivo contado, nunca
  erro de arquivo (D8).
- **CNPJ com máscara, espaços ou menos de 14 dígitos**: máscara é aceita; menos de 14
  dígitos é recusa de linha.
- **Observação acima de 500 caracteres**: recusa de linha com motivo, nunca truncamento
  silencioso.
- **Planilha gigante / ZIP malicioso**: arquivo acima dos tetos (bytes, linhas, entradas
  internas) é recusado inteiro, antes de qualquer leitura de conteúdo.
- **Arquivo sem nenhuma linha de dados**: recusado como arquivo, com mensagem clara —
  não tratado como "0 aplicadas, sucesso".
- **Duas linhas idênticas no MESMO arquivo**: colidem na mesma chave de idempotência; a
  segunda é recusada, nunca somada.
- **Semana fechada entre o upload e a gravação**: o fechamento pode acontecer
  concorrentemente; a aplicação MUST ser recusada para essa semana em vez de gravar um
  lançamento que nunca terá efeito.
- **Lançamento para empresa fora do grupo Movee**: fora de escopo (o fechamento é da
  empresa 6) — recusa.

---

## Requirements

### Functional Requirements

**Arquivo e leitura**

- **FR-001**: O sistema MUST aceitar um arquivo XLSX com exatamente 5 colunas, na ordem
  e com os nomes exatos: `CNPJ`, `Data do pagamento`, `Valor`, `Nome`, `Observação`.
- **FR-002**: O sistema MUST conferir o cabeçalho **por contrato** (nome e ordem exatos)
  e, fora do contrato, MUST recusar o **arquivo inteiro** informando qual cabeçalho era
  esperado — sem aplicar nenhuma linha.
- **FR-003**: `CNPJ`, `Data do pagamento` e `Valor` MUST ser obrigatórios. `Nome` e
  `Observação` MUST ser opcionais.
- **FR-004**: A coluna `Nome` MUST ser ignorada no casamento do motorista (serve apenas
  para o financeiro conferir) e MUST NOT aparecer em nenhuma resposta.
- **FR-005**: `CNPJ` MUST ser aceito com ou sem máscara, exigindo 14 dígitos após a
  normalização.
- **FR-006**: `Valor` MUST ser sempre positivo na planilha; o sistema MUST NOT derivar
  sentido do sinal do valor (D2).
- **FR-007**: O sistema MUST recusar a linha quando o valor for ambíguo (ponto de milhar
  sem decimais), com motivo próprio, e MUST NOT adivinhar a intenção — o modo de falha é
  **fechado**.
- **FR-008**: `Observação` MUST aceitar até 500 caracteres; acima disso a linha é
  recusada, sem truncamento silencioso.
- **FR-009**: O sistema MUST impor teto de tamanho do arquivo, de número de linhas e de
  conteúdo descomprimido, recusando o arquivo antes de interpretar o conteúdo.

**Célula nativa do Excel — data e valor (Q1)**

- **FR-045**: `Data do pagamento` e `Valor` MUST ser aceitos **tanto** como texto no
  layout **quanto** como célula nativa do Excel (data como número de série, valor como
  número). Recusar o formato nativo rejeitaria a planilha que o financeiro de fato
  produz, porque a conversão automática de data vem desligada por padrão
  (`xlsx@0.20.3`, `node_modules/xlsx/types/index.d.ts:115`).
- **FR-046**: A data em célula nativa MUST ser convertida **exclusivamente** pela API
  oficial do SheetJS `XLSX.SSF.parse_date_code(serial, { date1904 })`, com `date1904`
  lido do próprio arquivo (`wb.Workbook.WBProps.date1904`; tipo em
  `types/index.d.ts:339,374,385,397`), e a data MUST ser tomada dos componentes de
  calendário devolvidos (`y`, `m`, `d`), **ignorando** a fração de dia. O sistema MUST NOT
  derivar a data por aritmética própria sobre o serial, nem por `Date` + formatação em
  UTC. Quando o epoch **não** puder ser lido (o campo ausente é anômalo — a leitura de um
  XLSX real sempre o popula, inclusive como `false`), ou quando a API devolver `null`
  (serial inválido), a linha MUST ser recusada com motivo nomeado.
- **FR-047**: O valor em célula nativa MUST ser aceito **somente** quando já for múltiplo
  exato de centavo a menos do erro de representação do número (critério:
  `|valor × 100 − round(valor × 100)| <= 1e-6`); fora disso a linha MUST ser recusada com
  motivo nomeado, porque a precisão foi perdida e a direção do arredondamento é
  convenção, não dado. Em caminho de dinheiro o sistema MUST NOT adivinhar.
- **FR-048**: Toda linha MUST ter a data e o valor validados por faixa, com recusa nomeada
  por critério: data fora de `[2024-01-01, hoje+1]`; valor menor ou igual a zero; valor
  acima do teto por linha. O teto por linha é um guard-rail contra erro de digitação
  (valor lançado sem separador decimal), não um limite de negócio, e MUST ser justificado
  no plano — o limite **estrutural** do domínio é `numeric(12,2)`
  (`infra/hub/migrations/0066_adiantamento_tabelas.sql:13`). Decisão **dec-026**: o teto é aplicado no leitor JS (recusa de linha com motivo), nunca em `CHECK` (ver `data-model.md` §Constraints).
- **FR-051**: Cada caminho de leitura MUST ser coberto por teste com planilha **gerada
  pelo próprio SheetJS** contendo célula nativa, exercitando `cellDates` ligado e
  desligado e os epochs 1900 e 1904 — não apenas células de texto. Fixtures MUST ser
  sintéticas (FR-043).

**Tipo e sentido**

- **FR-010**: O **tipo** MUST ser escolhido na tela, no diálogo, e MUST valer para todas
  as linhas do arquivo — o tipo MUST NOT ser uma coluna da planilha.
- **FR-011**: O sistema MUST suportar `ADIANTAMENTO` (deduz do repasse) e
  `AJUSTE_CREDITO` (soma ao repasse), com o sentido **derivado do tipo**.
- **FR-012**: O sistema MUST garantir, no próprio armazenamento, a coerência entre tipo e
  sentido, de forma que um registro incoerente seja impossível de gravar.
- **FR-013**: Um tipo novo de valor pago por fora MUST poder ser acrescentado sem
  redesenho do modelo (razão de D1, `docs/briefing.md:128-131`).

**Semana e efeito no repasse**

- **FR-014**: O sistema MUST atribuir cada lançamento à semana de apuração que **contém a
  data do pagamento** informada, sem o deslocamento de −1 dia usado pelo adiantamento do
  app (D4).
- **FR-015**: O sistema MUST derivar o início da semana da configuração vigente
  (`apuracao_dia_inicio`), e MUST NOT fixar o dia da semana em código — o valor vigente em
  produção é pendência do operador (`docs/briefing.md:132-136`).
- **FR-016**: O fechamento da apuração MUST deduzir a **soma** das duas fontes:
  adiantamentos do app e lançamentos externos do tipo `ADIANTAMENTO` da semana (D3).
- **FR-017**: A prévia do repasse MUST refletir os lançamentos externos com o **mesmo**
  resultado que o fechamento produziria, de modo que prévia e fechamento nunca divirjam
  (D3, US2).
- **FR-018**: `AJUSTE_CREDITO` MUST compor o remanescente **antes** do teste do saldo
  mínimo, para que um crédito possa tirar o motorista da retenção (D9).
- **FR-019**: A alteração do cálculo MUST preservar a invariante de conservação de saldo
  do item de apuração: o total disponível é integralmente pago **ou** integralmente
  transportado, nunca parcialmente, e nada entra nem sai do item
  (`0098:71-81` — `remanescente + saldo_anterior = valor_pago + valor_transportado`
  quando `remanescente >= 0`).
- **FR-020**: Lançamento cuja semana já está **fechada** MUST ter a linha recusada com
  motivo `SEMANA_JA_FECHADA`, aplicando-se as demais linhas do arquivo (D7). O sistema
  MUST NOT reabrir nem alterar apuração fechada.
- **FR-021**: O sistema MUST NOT alterar o comportamento do repasse para empresas sem
  nenhum lançamento externo — quem não usa a feature não vê diferença alguma.
  **Emenda autorizada pelo operador em 2026-10-23** (W1, `0117` — prévia somando `EXPORTADA`): a
  prévia (`hub_adiantamento_repasse`) passa a somar adiantamento `EXPORTADA` como o fechamento já
  somava (`PAGA` + `EXPORTADA`). Isso **muda o número** de um motorista com adiantamento
  `EXPORTADA` e **zero** lançamentos externos — exceção deliberada a esta FR. A divergência
  prévia × fechamento era **pré-existente** (não nasceu desta feature); corrigi-la foi condição para o
  operador conferir a prévia ANTES de fechar (FR-017). Nenhuma outra alteração de resultado para
  quem não usa a feature está autorizada.
  **Emenda da rodada 3 (2026-10-23, MEDIUM 8 — registrada, não autorizada de antemão):** o CSV de exportação do
  repasse mudou de FORMATO nas **doze colunas pré-existentes**: um valor monetário NEGATIVO saía `'-5.00` (apóstrofo
  anti-injeção, o Excel lia TEXTO) e agora sai `-5.00` (número, soma). É melhoria e é seguro (a string vem de
  `formatarCentavos`, só `^-?\d+\.\d{2}$`; texto livre segue escapado), mas é mudança de saída para quem não usa a
  feature — por isso fica aqui e **fixada por teste** (`adiantamento-remanescente-unit`, MEDIUM 8).
- **FR-022**: A dedução do lançamento externo do tipo `ADIANTAMENTO` MUST respeitar a flag
  de configuração `desconto_adiantamentos` (`0066:69`, `DEFAULT true`), exatamente como já
  faz a dedução do app. A flag passa a significar, **sem exceção**, "esta empresa não
  desconta adiantamento do repasse" — um único interruptor para as duas fontes. O gate
  MUST ser aplicado nos **mesmos** pontos onde ele já existe hoje, sem criar um quarto:
  prévia (`0100:103`), fechamento (`0098:237`) e detalhe por motorista (`0098:597`).
  ⚠️ **Correção de rótulo (medida em 2026-10-22, `grep -n desconto_adiantamentos`)**: são
  **três** gates vivos, não quatro. A redação anterior listava um quarto ponto "cálculo"
  (`0098:391`) que está dentro de **código morto** — a prévia definida em `0098:321-444`,
  que a `0098:319`→`0100:24`/`0100:26` dropa e recria —, e apontava o detalhe para
  `0071:104`, também morto (`0098:513`/`0098:515` redefine
  `hub_adiantamento_repasse_motorista`). Os rótulos ainda estavam trocados: `0098:237` está
  dentro de `hub_adiantamento_repasse_fechar` (`0098:111-312`) e `0098:597` dentro de
  `hub_adiantamento_repasse_motorista` (`0098:515-627`).
  ⚠️ **Risco aceito explicitamente pelo operador (Q2)**: com a flag desligada, a empresa
  paga o repasse cheio a quem já recebeu por fora — ou seja, **paga duas vezes**. A
  decisão é deliberada; a mitigação é FR-049, que torna o risco visível sem alterar a
  regra. **Estado em produção (2026-10-22)**: `desconto_adiantamentos = t`, logo o risco é
  **teórico hoje** — mas a flag é editável pela tela de Configurações, e é por isso que
  FR-049 continua obrigatório.
- **FR-049**: Quando existir lançamento externo de **dedução** numa semana cuja flag
  `desconto_adiantamentos` está **desligada**, o sistema MUST avisar na tela — na prévia
  do repasse **e** na confirmação do fechamento, os dois momentos em que alguém decide
  sobre o dinheiro daquela semana. O aviso MUST nomear que existem valores pagos por fora
  que **não** serão descontados e quantos são, MUST NOT bloquear a operação e MUST NOT
  revelar dado identificável de motorista (FR-031). O sistema MUST NOT falhar calado.
  A fonte do aviso (`hub_lancamento_externo_resumo`) MUST ser gateada pela **mesma**
  permissão da rota que mostra a prévia — `adiantamentos.pagamentos_consultar`
  (`routes/hub-adiantamentos.js:1659`) — e **MUST NOT** exigir
  `adiantamentos.pagamento_confirmar`, senão quem abre a prévia com a permissão mais fraca
  recebe erro no lugar do aviso (dec-036; a `0117` nasceu com o gate errado). O aviso MUST
  NOT ser degradado por `catch` — degradar é o falhar-calado que esta FR proíbe.

**Identificação do motorista**

- **FR-023**: O sistema MUST identificar o motorista pelo **CNPJ do prestador**, nunca por
  nome e nunca por id informado no arquivo (D5).
- **FR-024**: CNPJ sem motorista vinculado MUST resultar em recusa **da linha**, com
  motivo contado, aplicando-se as demais (D8).
- **FR-025**: O sistema MUST resolver o CNPJ para exatamente um motorista ou nenhum — a
  unicidade está garantida no armazenamento (`0021:20` `cnpj_prestador` UNIQUE; `0021:57-58`
  índice único de vínculo), logo um mesmo CNPJ MUST NOT poder produzir dedução duplicada.

**Idempotência**

- **FR-026-IDEMP**: A chave de idempotência MUST ser **empresa + CNPJ + data do pagamento
  + tipo** — no máximo um lançamento de cada tipo, por motorista, por dia (D6). Sem TTL:
  a chave é permanente, porque o efeito (dinheiro) é permanente.
- **FR-027**: Reenvio da **mesma** chave com o **mesmo** valor MUST ser contado como
  `JA_APLICADO`, sem aplicar de novo e sem alterar nenhum valor de repasse.
  **Precedência (H5, rodada 2)**: a idempotência MUST ser avaliada **antes** da janela da semana
  (`SEMANA_JA_FECHADA`/`SEMANA_ANTERIOR_A_APURACAO`). Reenviar, depois do fechamento, linhas que **foram**
  aplicadas devolve `JA_APLICADO` — nunca `SEMANA_JA_FECHADA`, que é indistinguível de "nunca aplicada" e levava o
  operador a relançar na semana seguinte (dedução em dobro).
- **FR-028**: Reenvio da mesma chave com valor **diferente** MUST ser **recusado** com
  motivo próprio, preservando o lançamento original — o sistema MUST NOT sobrescrever
  (D6).
- **FR-029**: Duas linhas com a mesma chave no **mesmo** arquivo MUST resultar em uma
  aplicada e a outra recusada, nunca em soma.
  **Consequência (H4, decisão do operador 2026-10-23: a chave FICA como está)**: é **um lançamento por
  motorista, por dia e por tipo**. Se houve **dois pagamentos** ao mesmo motorista no mesmo dia e tipo, o
  segundo volta `DUPLICADA_NO_ARQUIVO` (mesmo arquivo) ou `VALOR_DIVERGENTE` (arquivos separados) e **NÃO é
  deduzido — o repasse paga esse valor de novo**. Quem prepara a planilha MUST **somar os pagamentos do dia
  numa única linha ANTES de enviar**. Um lançamento já aplicado é imutável (append-only): somar e
  reenviar **depois** não o altera (volta `VALOR_DIVERGENTE`). As mensagens dos dois motivos MUST dizer isso, com o
  **mesmo texto** no backend (`lib/lancamento-externo.js`) e no frontend (`lib/hub/lancamento-externo.ts`).

**Resposta ao usuário**

- **FR-030**: A resposta MUST informar quantas linhas foram aplicadas, quantas foram
  recusadas, e a contagem **por motivo**.
- **FR-031**: A resposta MUST NOT conter CNPJ, nome ou qualquer outro dado identificável
  de motorista — apenas contagens por motivo (D8; mesma disciplina do gate de 01/10
  registrada em `hub-adiantamentos.js:1519-1524`).
- **FR-032**: Cada motivo de recusa MUST ser nomeado e estável (ex.: `SEMANA_JA_FECHADA`),
  para que o financeiro saiba o que corrigir e para que a tela não precise inventar
  frases.
- **FR-033**: Mensagens ao usuário MUST estar em português, claras e acionáveis
  (Constitution, Padrões de Qualidade).

**Permissão e escopo**

- **FR-034**: A operação de **escrita** — importar/aplicar o arquivo
  (`hub_lancamento_externo_aplicar`) — MUST exigir a permissão
  `adiantamentos.pagamento_confirmar` (D10), porque move dinheiro. O sistema MUST NOT
  criar permissão nova. ⚠️ **Escopo desta FR**: ela **não** alcança a leitura que
  alimenta o aviso de FR-049 (`hub_lancamento_externo_resumo`), gateada por
  `adiantamentos.pagamentos_consultar` — a mesma da prévia (dec-036). Ler "a operação"
  como "tudo nesta feature" tornaria FR-034 e FR-049 contraditórias, e o gate
  `requirement-coverage.sh` apontou FR-034 como sem cenário justamente por essa
  ambiguidade.
  **Cenário de aceite**: usuário com `pagamentos_consultar` mas **sem**
  `pagamento_confirmar` vê a prévia e o aviso, e recebe `PERMISSAO_NEGADA` ao tentar
  importar.
- **FR-035**: O escopo de empresa MUST ser resolvido a partir do token autenticado, nunca
  do corpo da requisição (Constitution, Princípio II — NON-NEGOTIABLE).
- **FR-036**: A leitura dos lançamentos MUST ser restrita ao escopo do solicitante, e a
  escrita MUST passar por caminho privilegiado controlado — nunca exposta diretamente
  pela camada de dados pública.

**Tela (única aprovada)**

- **FR-037**: Users MUST be able to importar a planilha por **um** botão "Importar pagos
  por fora" na aba **Repasse** que já existe, abrindo um diálogo que permite escolher o
  tipo e selecionar o arquivo (D11).
- **FR-038**: O botão MUST ficar entre as ações **por período** da aba, posicionado antes
  de "Fechar apuração", porque o lançamento só tem efeito **antes** do fechamento
  (`repasse/page.tsx:208-237`).
- **FR-039**: O diálogo MUST exibir o resultado do import (aplicadas, recusadas, contagem
  por motivo) e MUST NOT exibir CNPJ nem nome.
- **FR-040**: O sistema MUST NOT criar página nova, aba nova ou listagem dos lançamentos
  importados nesta entrega (D11, `docs/briefing.md:48-51`). Se a implementação concluir que
  falta tela, isso MUST ser registrado como bloqueio para o operador — não criado.
  **Emenda autorizada pelo operador em 2026-10-23** (informado do custo: 4 funções SQL passam a
  exigir `DROP`+`CREATE`+`GRANT` e o rollback muda de natureza): a restrição deixa de proibir
  alterar a tela do repasse **somente** para exibir a parcela de FR-053; **nenhuma outra tela,
  aba ou listagem** está autorizada.
  **Segunda emenda autorizada pelo operador em 2026-10-23 (rodada 3):** o lançamento aplicado era insalvável (valor errado
  ou pagamento em duplicidade no mesmo dia não tinha correção). Fica autorizada **uma** tela — a listagem dos lançamentos
  da semana, com exclusão (FR-056/FR-057) — como diálogo aberto da aba Repasse ("Ver pagos por fora"), **sem página nem
  aba nova**. Qualquer outra listagem continua proibida.
- **FR-054** (H1, rodada 2 — decisão do operador 2026-10-23): o **lote de pagamento do repasse**
  (`hub_repasse_lote_avaliar`) MUST aceitar o item cujo valor vem **de crédito externo e não de produção**,
  **sem exigir `EnvioMassa`**. ⚠️ **Inverte a invariante "faturado ≥ pago"**: a nota é emitida pela produção, e
  `AJUSTE_CREDITO` paga sem produção. Regras: (a) crédito **puro** (nenhum movimento e `creditos = 0` no item e
  `lancamentos_externos > 0`) → `apta=true` se tiver conta aprovada, paga `valor_pago`, **sem** `NOTA_PENDENTE`;
  (b) semana **mista** (produção + crédito) → continua exigindo a nota **da produção** (`aprovadas = total`),
  a nota emitida é só a da produção e o lote paga `valor_pago` inteiro (produção + crédito); (c) `ADIANTAMENTO`
  (dedução) **não muda**: a nota é da produção e o pagamento é líquido. "Gerar notas" segue recusando o crédito
  puro com `VALOR_ZERO` (não há base de nota) — o valor segue direto pelo lote.
- **FR-054b** (ALTO 1, rodada 3): a dispensa de nota de FR-054 MUST valer **só para o próprio crédito**:
  `valor_pago <= lancamentos_externos` (nada além do crédito está sendo pago). `valor_pago = remanescente +
  saldo_anterior`; sem o limite, R$ 0,01 de crédito destravava o pagamento de qualquer saldo retido de **produção sem
  nota** (W1 produz R$ 5,00 sem nota e fica retido; W2 recebe um crédito de R$ 0,01 e pagava R$ 5,01). Crédito mais
  saldo transportado numa semana **sem produção** volta a `NOTA_PENDENTE`, como um saldo transportado sozinho já é na
  `0112` — não é regressão. *Limitação conhecida (MEDIUM 1):* semana **conciliada** pela UneCont **com** crédito externo
  segue `JA_PAGO_CONCILIADO` — recusar é o lado seguro (liberar pagaria de novo a produção já paga); pagar só o crédito
  exigiria pagamento parcial, que não existe. Tratar fora do lote.
- **FR-055** (ALTO 2, rodada 3 — decisão do operador 2026-10-23): uma linha de **dedução** (`ADIANTAMENTO`) cujo valor
  **excede o líquido disponível** da semana do motorista MUST ser **recusada** (a linha, nunca o arquivo) com o motivo
  `VALOR_EXCEDE_LIQUIDO`, **nomeando o valor da linha e o líquido** ("Linha 7: R$ 100,00 excede o líquido disponível de
  R$ 30,00"; só número da linha, dois valores — nada identificável). Sem isto o excedente desaparece (remanescente
  negativo ⇒ `valor_pago 0` e o negativo **não transporta**, `0098`) e a **SC-001 ("exatamente esse valor") é falsa**.
  **Líquido disponível** = `créditos − adiantamentos(PAGA+EXPORTADA) − débitos − deduções externas + créditos externos`
  da semana (a MESMA conta da prévia, com os mesmos gates de flag), **antes** do saldo anterior e do piso, nunca
  negativo. **Ordem de aplicação (explícita, testada):** o líquido é lido do banco **no momento de cada linha**, logo já
  desconta as linhas **anteriores** gravadas (do mesmo arquivo e de arquivos anteriores): duas deduções do mesmo motorista
  na mesma semana disputam o mesmo saldo, **na ordem do arquivo**; um `AJUSTE_CREDITO` importado **antes** eleva o líquido;
  importado depois não reabre linha já recusada. Só vale com `desconto_adiantamentos` **ligada** (desligada, a dedução nem
  pesa no repasse e o aviso de FR-049 cobre). Crédito nunca é recusado por isto. Vale **na RPC** (autoridade) — o leitor JS
  não conhece o líquido; os **textos** são os do frontend (`MOTIVO_LINHA`), cruzados com os tokens da RPC por teste.
  ⚠️ Consequência operacional: importar o **faturamento da semana antes** dos pagos por fora (sem crédito, o líquido é
  zero e toda dedução é recusada). **SC-001 permanece verdadeira e sem emenda.** Limite: a conferência é do momento do
  import — um débito/adiantamento do app que chegue depois pode ainda deixar o remanescente negativo (comportamento
  pré-existente, fora do alcance desta FR).
  **Rodada 4 (A2, decisão de desenho do operador):** esse limite deixou de ser silencioso. `hub_lancamento_externo_resumo` devolve
  `qtd_negativo`/`total_negativo` (motoristas com lançamento por fora na semana cujo líquido está negativo AGORA); o diálogo de fechar
  mostra os dois números e **exige confirmação explícita**, e o aviso de negativo aparece **mesmo com a flag ligada**. O fechamento
  **NÃO recusa** (fechar é irreversível e a operação fecha na segunda). Revalidar-e-recusar foi rejeitado — ver `deferred-work.md` (R4-A2).
- **FR-056** (rodada 3, autorizada pelo operador 2026-10-23): o sistema MUST permitir **excluir** um lançamento aplicado,
  por RPC `SECURITY DEFINER` (`hub_lancamento_externo_excluir`) com a **mesma permissão da importação**
  (`adiantamentos.pagamento_confirmar`), o mesmo gate de escopo e a **mesma trava do fechamento**. A linha apagada MUST ser
  copiada para `"LancamentoExternoExclusao"` **na mesma transação** (quem, quando, o quê e o valor que havia; append-only;
  rodada 4/M8: **sem acesso do PostgREST** — guarda `cnpj_prestador`, nenhum leitor do produto a usa e o SELECT por escopo tinha gate
  mais fraco que a listagem; quem audita lê como dono do banco). 🔴 **Semana FECHADA MUST NOT permitir exclusão** (`SEMANA_JA_FECHADA`, fail-closed): o valor está
  congelado em `ApuracaoRepasseItem`, e apagar a origem divergiria o congelado da tabela. Semana aberta: a prévia recalcula
  sozinha. Excluir **não** burla a idempotência: depois de excluir, **reenviar a mesma chave volta a ser `APLICADA`** (era o
  ponto). 🔴 **Rodada 4 (A1):** excluir um **crédito** cujo líquido do motorista ficaria **negativo** é RECUSADO
  (`EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`, 409; simétrico à guarda do `aplicar`) — a mensagem manda apagar a dedução primeiro. Sem isso
  crédito 100 + dedução 100, excluindo o crédito, deixava −100 que não transporta e o valor evaporava no fechamento. A rota `DELETE /repasse/lancamentos-externos/:id` mapeia `LANCAMENTO_NAO_ENCONTRADO`→404, `SEMANA_JA_FECHADA`→409,
  `PERMISSAO_NEGADA`/`FORA_DE_ESCOPO`→403 e audita também no log do hub (best-effort).
- **FR-057** (rodada 3): o sistema MUST listar os lançamentos da semana (`hub_lancamento_externo_listar`, gate
  `pagamentos_consultar`, paginado, busca por nome) com motorista (**nome, nunca CNPJ**), tipo, data, valor, observação,
  quem lançou, `excluivel` (dica de tela: permissão de escrever **e** semana aberta; quem decide é a RPC de exclusão) e `semana_fechada`
  (rodada 4/M3: a tela distingue "Semana fechada" de "Sem permissão"). Rodada 4: a tela TEM o campo de busca por nome (M2) e página
  fora de faixa devolve o total real, nunca `0` (M13). A
  tela é o diálogo "Ver pagos por fora" da aba Repasse; excluir pede confirmação na linha e, ao concluir, **reconsulta a
  prévia e o aviso de FR-049**.
- **FR-053**: A decomposição exibida do repasse MUST fechar a conta: onde quer que se exiba
  `créditos`, `adiantamentos` e `débitos` de um motorista, MUST ser exibida também a parcela
  **"pago por fora"** (`lancamentos_externos`, valor LÍQUIDO e já após o gate de FR-022;
  negativo = dedução, positivo = crédito), de modo que
  `créditos − adiantamentos − débitos + lancamentos_externos = remanescente`. As superfícies
  são cinco e MUST mostrar a MESMA parcela: prévia (hub), semana fechada (hub, `_congelado`),
  semana em curso (app), última semana fechada (app, `_ultimo_fechado`) e o item congelado
  gravado pelo fechamento. Zero/ausente MUST ser exibido como "—" no hub e omitido no app.
  **Semana fechada MUST ler o valor CONGELADO** (`ApuracaoRepasseItem.lancamentos_externos`,
  já existente), nunca recalcular ao vivo — recalcular divergiria do retrato (SC-002).
  Nenhuma coluna nova em `ApuracaoRepasseItem` e o CHECK `apuracaorepasseitem_saldo_conserva`
  permanece válido e inalterado (ele não envolve as parcelas que compõem o remanescente).
  **O CSV de exportação do repasse (`/repasse/exportar`) TAMBÉM ganha a coluna** `Pago por fora (líquido)`
  (13ª, no fim, mesmo sinal da tela) — emenda da rodada 1 do code review, por decisão do operador: o CSV é onde o
  financeiro confere contra a planilha, e um CSV em que a conta não fecha reproduz o sintoma que esta feature existe
  para eliminar. Isto **revoga** a classificação anterior ("CSV fora de escopo", dec-053).

**Infraestrutura e qualidade**

- **FR-041-INFRA-LOCK**: A aplicação do arquivo MUST ser serializada contra o fechamento
  concorrente da mesma apuração, de modo que um lançamento nunca seja gravado para uma
  semana que está sendo fechada no mesmo instante (o fechamento já serializa por lock
  próprio, `0098:135`).
- **FR-042-PERF**: O acesso aos lançamentos pela rotina de repasse MUST ser coberto por
  índice adequado à consulta por empresa e período, com plano de execução **medido** — a
  rotina varre a semana inteira da empresa (`docs/briefing.md:118-120`). A feature MUST NOT
  repetir a lacuna já existente, em que o filtro por empresa e data não tem índice que o
  cubra (`0066:224-225`). ⚠️ O cálculo do repasse hoje já tem **duas** fontes de dedução
  agregadas por motorista — a do adiantamento do app e `debitos_cte`, nas **duas**
  definições vivas: prévia `0100:71` (`debitos_cte`) + `0100:81` (`adiant`) e fechamento
  `0098:208-217` (`debitos_cte`) + `0098:218` (`pagas`), ambas ativas em produção
  (`desconto_adiantamentos = t`,
  `desconto_debitos = t`). A fonte nova faz **três**: a CTE do lançamento externo MUST NOT
  colidir com `debitos_cte` (nome, chave de junção ou dupla contagem do mesmo valor) e o
  plano de execução MUST ser medido **com as três** fontes, não com duas.
- **FR-050-REUSO**: O núcleo comum de leitura endurecida de XLSX MUST ser **extraído** de
  `lib/adiantamento-retorno-transfeera.js` para um módulo compartilhado — não importado,
  porque só `lerXlsx` é exportado, `conferirTetoZip` é interna (`:105,:117`) e o leitor
  compara contra o cabeçalho de 21 colunas do retorno (`:148-149`). O que é extraído: os
  tetos de ZIP e de linhas e a leitura endurecida, **parametrizados pelo contrato de
  cabeçalho**. O que fica duplicado de propósito: a interpretação de cada coluna e os
  motivos de recusa, porque os dois layouts não têm coluna em comum e unificá-los
  acoplaria dois contratos externos independentes. A conversão de valor MUST reusar
  `paraCentavos` de `lib/adiantamento-remanescente.js` por import, que já é exportada.
  ⚠️ A extração mexe em **código em produção desde 2026-10-22** (importador do retorno da
  Transfeera), logo MUST ser provada por não-regressão **antes** de qualquer mudança de
  comportamento: a suíte própria do retorno MUST passar com os mesmos números de antes
  (`tests/adiantamento-retorno-transfeera-unit.test.js`,
  `tests/adiantamento-retorno-transfeera-arquivo-real.test.js`,
  `tests/adiantamento-transfeera-xlsx-unit.test.js`,
  `tests/hub-adiantamentos-rotas-unit.test.js`), e o arquivo de teste novo MUST ser
  acrescentado à lista de `backend/package.json:8` — fora dela ele não roda e o verde fica
  oco.
- **FR-052**: A extração MUST NOT alterar as opções de leitura hoje usadas
  (`lib/adiantamento-retorno-transfeera.js:136`). ⚠️ Medido: nessa versão `bookProps: false`
  — o valor em uso — é justamente o que **expõe** `wb.Workbook.WBProps.date1904`; com
  `bookProps: true` o objeto `Workbook` **não** é populado e o epoch fica ilegível,
  derrubando FR-046 para toda linha com data nativa. "Ligar as props do workbook para
  obter o epoch" é o engano a evitar.
- **FR-043**: Nenhum segredo e nenhum dado pessoal real MUST ser versionado — fixtures de
  teste usam CNPJ e nomes sintéticos (repositório é público).
- **FR-044**: A entrega MUST ser composta de artefatos (código, migration, testes,
  runbook). A aplicação da migration e o deploy MUST ser executados pelo **operador** — o
  agente não toca o ambiente vivo (`docs/briefing.md` + regra de produção do projeto).

> **Decisões de infraestrutura**: scheduling **N/A** (a feature é disparada por ação
> humana, sem trabalho periódico); key rotation **N/A** (não criptografa dado próprio);
> refresh de token externo **N/A** (não consome IdP externo); backup coberto pelo backup
> existente do banco; mutex e idempotência cobertos por FR-041 e FR-026-IDEMP.

### Key Entities

- **Lançamento Externo**: um valor pago por fora do sistema a um motorista. Atributos
  essenciais: empresa, CNPJ do prestador, data do pagamento, valor (sempre positivo),
  tipo (`ADIANTAMENTO` | `AJUSTE_CREDITO`), observação opcional, e autoria (quem lançou e
  quando). Relaciona-se ao motorista **pelo CNPJ** e, por consequência, ao item de
  apuração da semana que contém a data do pagamento. É **append-only**: não se edita nem
  se exclui pela tela nesta entrega.
- **Apuração da Semana** (existente): retrato **imutável** do repasse de uma semana, que
  passa a considerar os lançamentos externos na composição do valor de cada motorista.
  Uma vez fechada, não aceita mais lançamento com efeito.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Um motorista que recebeu valor por fora durante a semana tem o repasse
  reduzido em **exatamente** esse valor — diferença de zero centavo entre o lançado e o
  deduzido.
- **SC-002**: O valor exibido na prévia e o valor congelado no fechamento da mesma semana
  são **idênticos** em 100% dos casos.
- **SC-003**: O financeiro conclui o lançamento de uma semana inteira em **menos de 5
  minutos**, do clique no botão à confirmação do resultado.
- **SC-004**: Subir o mesmo arquivo duas vezes produz **zero** alteração de valor na
  segunda vez (nenhuma dedução duplicada).
- **SC-005**: Um arquivo com linhas boas e linhas inválidas aplica **todas** as boas e
  **nenhuma** das inválidas, na mesma operação.
- **SC-006**: 100% das linhas recusadas vêm acompanhadas de um motivo nomeado, e **zero**
  CNPJ ou nome aparece em qualquer resposta.
- **SC-007**: Um motorista retido por ficar abaixo do saldo mínimo e que recebe crédito
  suficiente passa a receber na mesma semana, sem perda de centavo no transporte de saldo.
- **SC-008**: Motoristas e empresas sem nenhum lançamento externo têm resultado de repasse
  **inalterado** em relação ao comportamento atual.
  **Emenda autorizada pelo operador em 2026-10-23** (ver FR-021/W1): exceção única — a **prévia** de
  motorista com adiantamento `EXPORTADA` passa a coincidir com o fechamento. O **fechamento** e o
  congelado seguem inalterados para quem não usa a feature.
- **SC-009**: A consulta dos lançamentos pela rotina de repasse usa índice (plano de
  execução medido e anexado), sem varredura completa da tabela.
  **Regressão (dec-040, tarefa 4.5.1)** = qualquer um de: (1) aparecer `Seq Scan` em
  `"LancamentoExterno"`; (2) o `Index Cond` de `idx_lancamentoexterno_empresa_data_entregador`
  deixar de cobrir igualdade (`id_empresa`) **e** faixa (`data_pagamento`); (3) a CTE isolada
  passar de **3,208 ms / 94 buffers** ou as três fontes de **4,188 ms / 116 buffers** (2x a
  baseline: 1,604 ms/47 e 2,094 ms/58). Checado por
  `infra/hub/testes/hub-lancamento-externo-perf.sh` (seed de 229.467 linhas dentro de
  `BEGIN..ROLLBACK`; controle negativo `PERF_NEG=noindex`).
- **SC-010**: Gates verdes com números relatados: backend **2030 pass / 0 fail** (396
  suítes) mais os testes novos; `tsc --noEmit` limpo; `vitest` **941/0** mais os novos;
  `next build` concluído; lint sem erro **novo** contra a baseline de 28 problemas (5
  erros, 23 avisos); driver de integração do adiantamento **231 PASS / 0 FAIL** mais os
  novos.
- **SC-011**: Cada correção de comportamento tem **controle negativo** executado: os
  testes que falham sem a correção são **nomeados**, com prova de que a reversão foi
  aplicada **antes** da medição.
- **SC-012**: A entrega está disponível para o operador aplicar **antes do fechamento da
  semana 19–25/10** (janela de 26/10 até o fechamento, pagamento em 28/10).

---

## Fora de Escopo

Delimitado pelo briefing (`docs/briefing.md:48-54`) e por D11:

- Página nova ou aba nova. (A **listagem** dos lançamentos e a **exclusão** deixaram de ser exclusão de escopo na rodada 3 — FR-056/FR-057, autorizadas
  pelo operador em 2026-10-23, como diálogo da aba Repasse; M6 da rodada 4 corrigiu esta contradição.)
- **Editar** lançamento (não existe; corrige-se excluindo e reenviando, com a semana aberta).
- Reabrir semana fechada (a apuração é imutável por desenho).
- Lançar valor para empresa fora do grupo Movee (o fechamento é da empresa 6).
- Afrouxar qualquer restrição do fluxo de adiantamento do app — o trade-off aceito pelo
  operador foi alterar a função de cálculo, **não** enfraquecer os CHECKs existentes
  (`docs/briefing.md:56-62`).
- Aplicar migration ou fazer deploy: é do operador.

---

## Anexo — Terreno medido (rastreabilidade)

Fatos verificados no código durante a especificação. Registrados para que o plano não
precise redescobri-los e para que nenhuma afirmação desta spec seja suposição
(Constitution — Veracidade de Dados).

**Caminho do dinheiro**

| Fato | Onde |
|---|---|
| Fechamento, definição **viva** (5 redefinições na série; esta é a última) | `infra/hub/migrations/0098_repasse_saldo_minimo.sql:111` |
| Dedução atual do app: soma `valor_bruto` com status `PAGA`/`EXPORTADA` por `data_producao`, agrupado por `entregador_id` | `0098:222-228` |
| Ordem das etapas do cálculo | `0098`: créditos(194) → débitos(209) → pagas(222) → saldo anterior(231) → linhas(237) → **cálculo do remanescente**(263) → **teste do piso**(266) |
| Remanescente = créditos − adiantamentos − débitos | `0098:264` |
| Teste do saldo mínimo ocorre **depois** do cálculo do remanescente (é o que viabiliza D9) | `0098:266-282` |
| Invariante de conservação de saldo do item | `0098:71-81` |
| Prévia, definição **viva**; a etapa equivalente à dedução chama-se `adiant`, **não** `pagas` | `0100_repasse_divisao_nota_previa.sql:26`, `0100:79-87` |
| Apuração é imutável (bloqueio de UPDATE/DELETE + trigger) | `0066:443-470` |
| Escopo vem da claim do token; a empresa 6 é fixa na função | `0098:122`, `0098:142/145/179/190/306` |
| Guardas do fechamento (permissão, lock, já fechada, fora de ordem, não configurada, em aberto, com pendências) | `0098:130-176` |
| Início da semana vem da configuração; validação recusa período desalinhado, fail-closed | `0066:65,92`; `0086_repasse_us6_janela_e_congelado.sql:35-70` |
| Saldo mínimo, default R$ 5,50 | `0098:87-88` |

**Identificação do motorista** — CNPJ alcança no máximo um motorista:
`0021_conta_motorista.sql:20` (CNPJ do prestador é único) e `0021:57-58` (vínculo único).
O vínculo foi construído por similaridade de nome (`0093`), com órfãos conhecidos — daí
D8 ser recusa de linha, não erro de arquivo.

**Reuso real do molde de import** — corrige a premissa do briefing §5: dos três helpers
que o briefing manda reusar, **apenas um é exportado**
(`lib/adiantamento-retorno-transfeera.js:322-330`). O teto de ZIP é interno ao módulo
(`:91`) e a conversão de valor vive em `lib/adiantamento-remanescente.js`. O leitor de
planilha é genérico **exceto** a comparação com o cabeçalho de 21 colunas do retorno
(`:160`). Portanto o reuso exige **extração** do núcleo comum, não import direto — a
alternativa seria reimplementar, o que o briefing §7 proíbe.

**Leitura de planilha, doc oficial** (`xlsx@0.20.3`, `node_modules/xlsx/types/index.d.ts`):
o valor bruto de uma célula pode ser texto, número, booleano ou data (`:711`); a
conversão automática de data vem desligada por padrão (`:115`); a leitura pode devolver o
dado bruto ou o texto formatado (`:822`). É esta a origem da pendência 1: o layout fixa
texto, mas o Excel entrega número.

**Conversão de data e valor — medido no runtime instalado** (`xlsx@0.20.3`, sonda em
`app_homologacao/backend`, planilhas geradas pelo próprio SheetJS). É esta medição que
embasa FR-045 a FR-048, FR-051 e FR-052:

| O que foi medido | Resultado literal | Consequência na spec |
|---|---|---|
| `XLSX.SSF.parse_date_code` existe e é pública | `SSF keys: format,load,_table,load_table,parse_date_code,is_date,get_table`; aridade 3 | FR-046 pode exigir a API oficial; não é suposição |
| Mesmo serial sob os dois epochs | `46309.875` → `2026-10-14` com `date1904=false` e `2030-10-15` com `date1904=true` | O serial isolado é **ambíguo**: 4 anos e 1 dia. FR-046 exige ler o epoch do arquivo |
| Serial inválido | `parse_date_code(-1)` → `null` | FR-046: `null` é recusa de linha |
| Bug do ano 1900 | `parse_date_code(60)` → `1900-02-29`, data que não existe | A faixa de FR-048 já o elimina |
| Epoch é populado na leitura de um XLSX real | `wb.Workbook.WBProps.date1904` veio `false` (1900) e `true` (1904) | Campo ausente é **anômalo**, logo a recusa de FR-046 não atinge planilha normal |
| ⚠️ Efeito de `bookProps` | `bookProps:false` → `date1904` legível; `bookProps:true` → `wb.Workbook` **ausente**, epoch ilegível | FR-052: não "ligar as props" para obter o epoch |
| `cellDates:true` e fuso | célula `2026-10-15` → `Date(2026-10-14T21:00:00.000Z)` em host UTC−3 | Ler o dia por `toISOString()` erra em 1 dia; FR-046 exige componentes de calendário |
| Valor: precisão de centavo | `100.005 × 100 = 10000.5` (meio centavo, recusa); `0.1+0.2 → 30.000000000000004` (erro de float, aceita) | FR-047: critério é "múltiplo de centavo a menos de `1e-6`", não "meio centavo", porque a fronteira literal do meio centavo é instável em ponto flutuante |

**Configuração vigente em produção** (lida por `SELECT` em
`hub_adiantamento_config_vigente(6)` em 2026-10-22, fornecida pelo operador — **não** é
suposição nem default de coluna):

| Campo | Valor em produção | Default da coluna | O que decide nesta spec |
|---|---|---|---|
| `apuracao_dia_inicio` | `1` (segunda) | — | Resolve a pendência 3: semana 19–25/10 alinhada |
| `apuracao_dias_ate_repasse` | `3` | — | 25/10 + 3 = quarta **28/10**, o prazo citado |
| `apuracao_data_base` | `data_lancamento` | — | Define a coluna de data usada nas CTEs de dedução |
| `desconto_adiantamentos` | `t` (ligado) | `true` (`0066:69`) | FR-022 respeita a flag; risco é teórico hoje |
| `desconto_debitos` | **`t` (ligado)** | `false` (`0066:70`) | ⚠️ O repasse já desconta **duas** fontes; a nova faz três (FR-042) |
| `repasse_valor_minimo` | `5.50` | — | Piso sobre o qual `AJUSTE_CREDITO` opera (FR-018) |

**Transporte** — o interpretador global de corpo JSON roda **antes** de toda autenticação,
com teto de 100 KB (`server.js:229`), e o módulo do repasse só é montado depois
(`:2970`); logo o tratamento do arquivo tem de ficar **na própria rota**, como já fazem
`routes/hub-repasse-lotes.js:524` e `routes/hub-adiantamentos.js:1471`. O teto também é
aplicado no caminho do frontend (`app/api/[...path]/route.ts:110-116`,
`lib/hub/retorno-xlsx.ts:8,11`).

**Padrão de resposta a reusar** — `{ aplicadas, ignoradas, ignoradasPorMotivo }` em
`routes/hub-adiantamentos.js:1525-1586`, com o motivo do corte de dados de terceiro
documentado em `:1519-1524`. Atende FR-030/FR-031 por construção.

**Dedup — o que NÃO reusar e por quê**

| Candidato | Por que não serve |
|---|---|
| Infra de importação existente (`ImportacaoArquivo`/`ImportacaoLinhaErro`) | Acoplada: origem é enum fechado (`0011:19`), o processador só grava em duas tabelas de fato (`lib/hub-import-processor.js:105`), e há travamento de uma importação ativa por origem (`0011:50-52`). O repo já rejeitou esse reuso por escrito (`lib/hub-envio-massa-import-log.js:4-11`) |
| Lançamentos de faturamento (`FaturamentoLancamento` com `tipo = 'Debito'`) | A **origem do dado é outra**: são lançamentos do extrato do parceiro (EntreGô), ingeridos fielmente e exigindo um arquivo importado por trás (`0098:208-217`) — não um campo genérico de dedução onde caiba um valor pago por fora. ⚠️ **Correção de premissa (2026-10-22)**: a razão **não** é a flag estar desligada. O default da coluna é `false` (`0066:70`), mas em produção `desconto_debitos = t` — a flag está **ligada**, e o repasse hoje já desconta **duas** fontes (adiantamentos e débitos) |
| Marcações de "já foi pago" no movimento (`0113`) e conciliação (`0110`) | Registram que a **nota** de um movimento foi resolvida fora do sistema, sem valor novo; o efeito no repasse é o oposto — o movimento conciliado **bloqueia** o item do lote (`0112:75`) |
| Lote de pagamento (`0108`) | Fica **depois** da apuração fechada (`0112:76`); é execução do pagamento, não composição de valor |

**Armazenamento, padrão vigente** (modelo mais recente, `0108_repasse_lote.sql:12-49`):
chave numérica sequencial, empresa obrigatória, autoria (quem criou e quando),
restrições nomeadas, índices idempotentes, leitura restrita por escopo e escrita apenas
por caminho privilegiado (`0108:110-119`). O par de revogação antes da concessão é
obrigatório nas funções (`0100:164-165`, `0098:629-630`) porque a camada de dados é
pública. Migrations não se auto-registram — quem registra é o aplicador, em transação
única por arquivo (`infra/hub/scripts/migrate.sh:46-73`), o que proíbe criação de índice
concorrente. Próximo número livre: **0117**.

**Gate de teste que engana**: o script de teste do backend lista os arquivos **um a um**
(`backend/package.json:8`) — um arquivo de teste novo que não entre na lista **não roda**,
e o verde fica oco. No frontend o descobrimento é por padrão de nome, sem essa pegadinha.

---

## Pendências

| # | Pendência | Bloqueia? |
|---|---|---|
| 1 | Tratamento de célula nativa do Excel para data e valor | ✅ **RESOLVIDA** no `/clarify` (Q1, onda-002) → FR-045 a FR-048, FR-051 |
| 2 | Interação com a flag `desconto_adiantamentos` (FR-022) | ✅ **RESOLVIDA** pelo operador (Q2, onda-002) → FR-022 respeita a flag; risco aceito; FR-049 torna o risco visível |
| 3 | Valor vigente de `apuracao_dia_inicio` em produção — do operador | ✅ **RESOLVIDA** (2026-10-22, lido por `SELECT` em `hub_adiantamento_config_vigente(6)`): `apuracao_dia_inicio = 1` (segunda) ⇒ a semana 19–25/10 está alinhada e o trigger de validação de janela aceita; `apuracao_dias_ate_repasse = 3` ⇒ 25/10 + 3 = **quarta 28/10**, a data de pagamento citada. FR-015 continua valendo: ler da configuração, nunca fixar em código |
| 4 | `docs/briefing.md:4` apontava para `docs/plans/lancamento-externo/BRIEFING.md`, que não existia | ✅ **RESOLVIDA**: o operador criou o arquivo em 2026-10-22; é lá que vive a correção do §5 (ver Q3) |
| 5 | Teto de valor **por linha** (FR-048) — número e justificativa | **Não** bloqueia o plano: é política de design, a definir e justificar no `/plan`. O limite estrutural (`numeric(12,2)`) já está medido |

> ℹ️ **Registro corrigido (rodada 1 do code review, D3):** `docs/briefing.md` **é legítimo e é desta frente**. Era o
> briefing da frente anterior (retorno da Transfeera em XLSX) e foi reescrito pelo operador/sessão corrente, nesta
> frente, **antes** do `state-rw.sh init` — por isso o sha256 gravado confere e o preflight passou com
> `{"ok":true,"findings":[]}`. A versão anterior deste parágrafo o descrevia como "sob verificação de integridade" e,
> em `tasks.md`, como "de outra sessão, preservado": ambas as leituras estavam erradas. O arquivo **não foi editado**
> pela execução autônoma. A correção do §5 do briefing vive em `docs/plans/lancamento-externo/BRIEFING.md` e em FR-050
> desta spec: o reuso de `lerXlsx` / `conferirTetoZip` / `paraCentavos` exige **extração**, não import, porque só
> `paraCentavos` e `lerXlsx` são importáveis e o leitor está acoplado ao cabeçalho do retorno da Transfeera.
