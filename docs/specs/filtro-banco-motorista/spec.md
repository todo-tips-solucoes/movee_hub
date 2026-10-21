# Feature Specification: Busca de banco pelo nome que o motorista conhece

**Feature Branch**: `filtro-banco-motorista`
**Status**: Draft
**Input**: Pedido do operador (21/10/2026): "o motorista ao pesquisar por um banco só tem retorno caso ele saiba o código do banco; caso queira a conta nubank, ao digitar `nu` o banco já deveria retornar."
**Contexto medido**: `docs/plans/filtro-banco-motorista/BRIEFING.md` e `docs/briefing.md` §4.

> Decisões de infraestrutura: N/A (consulta sobre lista oficial em memória, sem agendamento, sessão, chave, lock, backup ou idempotência novos).

## Diagnóstico do defeito (medido, não suposto)

A hipótese original ("o filtro só casa o começo do nome") é **falsa**. Hoje a busca já ignora maiúsculas/minúsculas e já procura o termo em qualquer posição do nome. Rodada contra a lista oficial de 463 bancos:

| Busca | Hoje | Por quê |
|---|---|---|
| `nu` | acha `260 NU PAGAMENTOS - IP`, mas em **2º** lugar (1º é `360 TRINUS CAPITAL DTVM`) | acha, porém não prioriza a marca |
| `nubank` | **nada** | a lista traz a razão social, não a marca |
| `itau` | acha `479 BCO ITAUBANK`, **não** `341 ITAÚ UNIBANCO` | acento só de um lado |
| `itaú` | acha `341 ITAÚ UNIBANCO` | funciona |
| `260` | acha pelo código | funciona (guarda de não-regressão) |

As causas reais são **duas**: (1) acento na lista oficial que o teclado do celular não produz; (2) nome comercial (marca) diferente da razão social registrada.

## User Scenarios & Testing

### User Story 1 - Achar o banco pela marca que conheço (Priority: P1)

O motorista, ao cadastrar a conta bancária no app, digita o nome comercial do banco (ex.: `nubank`, `mercado pago`, `picpay`, `inter`, `c6`) e o banco correto aparece na lista, sem precisar saber o código nem a razão social.

**Why this priority**: é o pedido do operador e o motivo de o motorista desistir ou escolher o banco errado (o que gera pagamento recusado).

**Independent Test**: digitar `nubank` e verificar que `260 NU PAGAMENTOS - IP` está na lista, no topo. Hoje retorna vazio.

**Acceptance Scenarios**:

1. **Given** a lista oficial de bancos, **When** o motorista busca `nubank`, **Then** `260 NU PAGAMENTOS - IP` aparece como primeiro resultado.
2. **Given** a mesma lista, **When** busca `mercado pago`, **Then** o banco `323 MERCADO PAGO IP LTDA.` aparece no topo.
3. **Given** a mesma lista, **When** busca `picpay`, `inter` ou `c6`, **Then** o banco correspondente à marca (PicPay, Banco Inter, C6) aparece no topo.
4. **Given** qualquer resultado, **When** exibido, **Then** o nome mostrado é o nome oficial do banco (o que consta no comprovante), nunca a marca digitada.

---

### User Story 2 - Digitar sem acento (Priority: P1)

O motorista digita `itau` (sem acento, como o teclado do celular entrega) e encontra `341 ITAÚ UNIBANCO`. Vale para qualquer banco com acento no nome oficial, e também quando o motorista digita com acento um nome que na lista está sem.

**Why this priority**: defeito medido; afeta o banco mais usado do país.

**Independent Test**: buscar `itau` e verificar que `341 ITAÚ UNIBANCO` está entre os resultados. Hoje só aparece `479 BCO ITAUBANK`.

**Acceptance Scenarios**:

1. **Given** a lista oficial, **When** busca `itau`, **Then** `341 ITAÚ UNIBANCO` aparece, e antes de `479 BCO ITAUBANK`.
2. **Given** a lista oficial, **When** busca `itaú` (com acento), **Then** o resultado é o mesmo da busca `itau`.
3. **Given** um banco cujo nome oficial não tem acento, **When** o motorista digita o nome com acento, **Then** o banco ainda é encontrado.

---

### User Story 3 - O banco pedido vem primeiro; busca continua previsível (Priority: P2)

Com o teto de 20 resultados (tela de celular), o banco que o motorista tem em mente aparece no topo, não perdido entre resultados de menor relevância. Termos genéricos não despejam dezenas de itens.

**Independent Test**: buscar `nu` e verificar que `260` é o primeiro; buscar `banco` e verificar que não volta uma lista de dezenas de itens irrelevantes.

**Acceptance Scenarios**:

1. **Given** a lista oficial, **When** busca `nu`, **Then** `260 NU PAGAMENTOS - IP` é o primeiro resultado.
2. **Given** a lista oficial, **When** busca `260`, **Then** o banco de código `260` aparece (busca por código continua por prefixo).
3. **Given** a lista oficial, **When** o termo é vazio, **Then** a lista é devolvida limitada a 20 itens.
4. **Given** a lista oficial, **When** busca `banco` (termo genérico), **Then** o resultado não passa de 20 itens e o motorista não recebe dezenas de bancos sem relação com a intenção; a busca não casa pedaços quaisquer do termo.

### Edge Cases

- Termo só com espaços ou acentos soltos: tratado como vazio (lista limitada a 20).
- Maiúsculas/minúsculas, espaços nas pontas e espaços múltiplos entre palavras (`mercado  pago`): não alteram o resultado.
- Marca que corresponde a mais de um banco oficial (ex.: `inter` também aparece em nomes como `PAGSEGURO INTERNET`): o banco da marca vem antes dos que apenas contêm o termo.
- Termo sem nenhuma correspondência: lista vazia (sem erro).
- Formato da resposta: cada item segue com código e nome oficial, compatível com o cliente atual do app, sem exigir mudança nele.
- Termo numérico: continua por prefixo do código, não por trecho do meio.

## Requirements

### Functional Requirements

- **FR-001**: A busca MUST ignorar acentos e diacríticos nos dois lados da comparação (termo digitado e nome do banco).
- **FR-002**: A busca MUST reconhecer nomes comerciais dos bancos mais usados pelos motoristas — no mínimo Nubank, PicPay, Inter, C6 e Mercado Pago — devolvendo o banco oficial correspondente.
- **FR-003**: O nome comercial MUST ser uma camada apenas de busca: o código e o nome oficial devolvidos ao motorista permanecem inalterados, e a lista oficial de bancos não é reescrita.
- **FR-004**: Os resultados MUST ser ordenados por relevância, com o banco que corresponde ao pedido (código, marca ou início do nome) antes dos que apenas contêm o termo; o teto de 20 itens permanece.
- **FR-005**: A busca por código MUST continuar por prefixo numérico.
- **FR-006**: A busca MUST NOT casar pedaços quaisquer do termo digitado (ex.: `banco` não pode devolver dezenas de bancos por casar "ban" ou "co").
- **FR-007**: Termo vazio, ou que se reduz a vazio após normalização, MUST devolver a lista limitada a 20 itens, no formato atual.
- **FR-008**: O formato da resposta (código + nome oficial por item) MUST permanecer compatível com o cliente atual; o app não exige mudança para obter o ganho.
- **FR-009**: A normalização de acento MUST reutilizar o helper de normalização de texto já existente no repositório, sem criar uma segunda implementação; a lista de nomes comerciais MUST ter uma única fonte.
- **FR-010**: Cada requisito acima MUST ter teste automatizado, e os casos de `nubank`, `itau`, `nu` e `´` (U+00B4) MUST falhar contra o comportamento anterior (controle negativo) e passar depois; `mercado pago`, `260`, `banco`, vazio e as chaves hostis são declarados como guarda de não-regressão, não como prova da correção.

  > **Emenda (medida no plan, 21/10)**: a redação original listava `nubank`, `itau` e
  > `mercado pago` como os reprovados e `nu` como guarda. A medição contra a fixture real
  > mostrou o contrário em dois pontos: `mercado pago` **já** devolve `323 MERCADO PAGO IP
  > LTDA.` como único resultado no topo (casa por substring do nome oficial), logo **não
  > reprova hoje**; e `nu` **reprova** hoje, não por ausência mas por **posição** (devolve
  > 260 em 2º, atrás de `360 TRINUS CAPITAL DTVM`). Corrigido para que o controle negativo
  > continue sendo prova real, e não um teste que passa dos dois lados. Nenhuma intenção
  > mudou — só a lista de quais casos provam o quê.

  > **Emenda 2 (medida no execute-task, 21/10 — dec-029)**: `´` (U+00B4) era guarda nesta
  > lista e é **prova**. A rota antiga devolvia **0 itens** para um acento solto, onde a
  > spec exige 20 (`´` não é marca combinante e sobrevive ao NFD, então sobrava um termo
  > não-vazio que não casava com banco nenhum). O caso foi separado do caso `vazio` num
  > teste próprio para que o controle negativo o exponha. Com isso os **reprovados reais
  > são quatro** — `nubank`, `itau`, `nu`, `´` — e não três; medido contra a rota anterior:
  > **5 pass / 4 fail**. O smoke também ganhou um 9º caso de guarda (`?q=a&q=b`, `?q[x]=1`,
  > `constructor`, `__proto__` não dão 500), vindo da tarefa 3.1.4. Nenhuma intenção mudou.

### Key Entities

- **Banco**: código de 3 dígitos e nome oficial (lista COMPE/STR do BCB, 463 bancos, somente leitura).
- **Nome comercial**: apelido de busca associado a um banco oficial (ex.: Nubank → 260); não é exibido nem gravado.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Nos 9 casos de smoke, 100% passam: `nubank` → 260 no topo; `itau` → 341 presente e antes de 479; `mercado pago` → 323 no topo; `nu` → 260 no topo; `260` → banco 260; `banco` → no máximo 20 itens e **todo item devolvido contém a substring `banco` no nome oficial** (asserção que operacionaliza "nenhum aviso de lista descontrolada"; é substring e não palavra — `081 BANCOSEGURO S.A.` é resultado legítimo); vazio → exatamente 20 itens; `´` (U+00B4) → exatamente 20 itens; chaves hostis (`?q=a&q=b`, `?q[x]=1`, `constructor`, `__proto__`) → 200 com lista, nunca 500. Os casos eram 7 na redação original: ver a Emenda 2 sob FR-010.
- **SC-002**: Antes da mudança, `nubank`, `itau`, `nu` e `´` reprovam — **quatro** casos, medido: 5 pass / 4 fail contra a rota anterior; depois, aprovam (prova de que o teste detecta o defeito). Ver as emendas sob FR-010 — `mercado pago` já passava antes e foi reclassificado como guarda; `´` era guarda e virou prova.
- **SC-003**: O motorista encontra qualquer um dos 5 bancos da lista de marcas digitando o nome comercial, sem conhecer o código, em uma única busca.
- **SC-004**: Zero regressão: nenhuma busca que funcionava antes (`nu`, `260`, `itaú`) passa a falhar, e nenhum item devolvido tem código ou nome diferente do oficial.
- **SC-005**: O smoke funcional roda por HTTP, antes do merge, em laço: qualquer caso reprovado bloqueia a promoção; após o ajuste, a suíte completa (não só o caso que falhou) e o portão inteiro rodam de novo, e só 9 de 9 aprovados libera o merge.

## Fora de escopo

- Reescrever ou renomear a lista oficial de bancos.
- Casamento por pedaços quaisquer do termo ou busca aproximada (descartado pelo operador).
- Qualquer mudança em banco de dados, migration, permissão ou tela do app além do que a resposta já entrega.
- Confirmação funcional pós-deploy na tela real: é do operador (digitar `nubank` no cadastro de conta); o agente prova apenas que o código servido é o novo.

## Assumptions

- A lista oficial permanece a fonte da verdade dos bancos; novas marcas entram no mapa de nomes comerciais em mudança futura, sem reabrir esta decisão.
- Decisões da §4 de `docs/briefing.md` estão fechadas; não há itens a definir.
