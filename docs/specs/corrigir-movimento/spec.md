# Feature Specification: Corrigir o valor de um movimento antes do envio da nota

**Feature**: `corrigir-movimento`
**Created**: 2026-10-20
**Status**: Draft
**Fontes**: `docs/briefing.md` (decisoes D1, D2, D3 fechadas na secao 4) e `docs/plans/corrigir-movimento/BRIEFING.md`.

## Contexto e problema (medido)

O operador fecha a semana importando uma planilha de movimentos. Quando um evento e
lancado errado ou falta no calculo, o valor do movimento sai errado, e e esse valor que o
motorista usa para emitir a nota fiscal. Hoje nao existe caminho para corrigir:

- Editar pela tela mostra **Valor** como editavel, responde "Registro atualizado com sucesso!" e **nao grava o valor**.
- Reimportar a planilha corrigida **duplica** as linhas.
- Excluir e reimportar, linha a linha, e o unico caminho real.

Agravante verificado no codigo e na planilha-modelo: o texto da mensagem enviada ao motorista
(`mensagem1`) **contem o valor por extenso** ("O valor total para emissao da NF e de R$ ...").
Corrigir so o campo de valor deixaria o motorista recebendo a mensagem com o valor antigo.

## User Scenarios & Testing

### User Story 1 - Reimportar a planilha corrigida atualizando em vez de duplicar (Priority: P1)

O operador corrige a planilha da semana (valores e textos) e a importa de novo. As linhas que
ja existem sao reconhecidas e atualizadas; as que nao existem sao criadas como hoje. Ao final a
tela mostra o resumo do que aconteceu com cada grupo de linhas.

**Why this priority**: e a correcao em lote, o caso real do operador (~980 linhas por semana) e
o unico que hoje obriga excluir e reimportar linha a linha.

**Independent Test**: importar uma planilha, alterar o valor de algumas linhas no arquivo,
importar de novo e conferir que o total de movimentos nao cresceu, os valores alterados foram
atualizados e o resumo bate com o esperado.

**Acceptance Scenarios**:

1. **Given** uma semana ja importada e uma planilha com os mesmos movimentos e alguns valores
   corrigidos, **When** o operador a reimporta informando o motivo, **Then** o total de
   movimentos da empresa permanece igual e os movimentos corrigidos passam a ter o novo valor.
2. **Given** a mesma planilha reimportada uma segunda vez sem nenhuma mudanca, **When** o
   operador a importa, **Then** nada e alterado e o resumo informa todos como inalterados.
3. **Given** uma planilha com linhas novas alem das ja existentes, **When** reimportada,
   **Then** as novas sao criadas e as existentes atualizadas, com contagem separada de cada.
4. **Given** uma planilha com uma linha invalida, **When** reimportada, **Then** nenhuma
   linha e criada nem atualizada e os erros sao apontados (regra de tudo ou nada preservada).
5. **Given** a reimportacao que alteraria movimentos existentes, **When** o operador nao
   informa o motivo, **Then** a operacao e recusada antes de qualquer alteracao.

---

### User Story 2 - Corrigir o valor de um movimento pela tela (Priority: P2)

O operador abre a edicao de um movimento, altera o valor, informa o motivo e salva. O valor e
de fato gravado e a mensagem que sera enviada ao motorista passa a refletir o novo valor.

**Why this priority**: correcao pontual, sem planilha. Hoje o botao mente (confirma sem gravar),
o que e pior que nao existir.

**Independent Test**: editar o valor de um movimento sem nota enviada, salvar com motivo, recarregar
a lista e conferir o valor novo, a mensagem coerente e o registro de auditoria.

**Acceptance Scenarios**:

1. **Given** um movimento sem nota enviada, **When** o operador altera o valor e informa o
   motivo, **Then** o valor e gravado e, ao recarregar, a tela mostra o valor novo.
2. **Given** a edicao sem motivo, **When** o operador tenta salvar, **Then** e recusado com
   mensagem clara e nada e alterado.
3. **Given** um valor nao numerico, **When** o operador tenta salvar, **Then** e recusado com a
   mesma regra de validacao da importacao.
4. **Given** que a gravacao falhou ou o movimento nao e da empresa do operador, **When** o
   operador salva, **Then** a tela mostra o erro real e **nunca** "atualizado com sucesso".

---

### User Story 3 - Movimento com nota ja enviada nao e alterado (Priority: P1)

Nos dois caminhos, o movimento cuja nota o motorista ja enviou mantem o valor, e a tela diz
quantos foram pulados. (E pre-condicao de liberacao das stories 1 e 2: sem esta protecao
nenhuma das duas e segura.)

**Why this priority**: a nota ja emitida carrega o valor antigo; alterar o movimento faria a nota
divergir e ser recusada na validacao, criando problema pior que o original (decisao D2).

**Independent Test**: preparar movimentos com nota aprovada, nota reprovada e sem nota, tentar
corrigir os tres pelos dois caminhos e conferir qual mudou e a contagem informada.

**Acceptance Scenarios**:

1. **Given** um movimento com nota anexada e sem erro de validacao, **When** a reimportacao ou a
   edicao tenta mudar o valor, **Then** o valor permanece e o movimento e contado como pulado.
2. **Given** um movimento com nota anexada **e** erro de validacao (nota reprovada), **When** o
   operador corrige o valor, **Then** a correcao e aceita (a nota nao esta valida).
3. **Given** uma reimportacao com N movimentos de nota enviada, **When** concluida, **Then** a
   tela informa exatamente N pulados por esse motivo.
4. **Given** a edicao pela tela de um movimento de nota enviada, **When** o operador salva,
   **Then** a tela informa que nao foi alterado porque a nota ja foi enviada, e orienta que
   a nota precisa ser cancelada antes.

---

### User Story 4 - Saber quem, quando, por que e de quanto para quanto (Priority: P2)

Toda alteracao de valor, por qualquer dos caminhos, deixa um registro de auditoria consultavel.

**Why this priority**: alterar valor e alterar o que o motorista vai faturar; precisa ser
rastreavel e nao editavel.

**Independent Test**: fazer uma correcao pela tela e uma por reimportacao e localizar os dois
registros com valor anterior, valor novo, motivo, instante, origem e autor.

**Acceptance Scenarios**:

1. **Given** uma correcao pela tela, **When** concluida, **Then** existe um registro com o
   movimento, valor anterior, valor novo, motivo, instante e origem "tela".
2. **Given** uma reimportacao que atualizou K movimentos, **When** concluida, **Then** existem K
   registros (um por movimento alterado) com origem "reimportacao" e o mesmo motivo informado.
3. **Given** uma sessao do painel legado (login da empresa, sem pessoa), **When** corrige, **Then**
   o registro e gravado e atribui a autoria a conta da empresa, sem inventar uma pessoa.
4. **Given** uma sessao do hub (login por pessoa), **When** corrige, **Then** o registro
   identifica a pessoa.

---

### Edge Cases

- **Linha da planilha que casa com mais de um movimento existente** (resultado de duplicacoes
  passadas): nao atualiza nenhum, conta como ambigua e lista para o operador resolver.
- **Linha sem identificador proprio na planilha**: nao ha como reconhecer; e criada como nova e
  contada no resumo, para o operador saber que pode haver duplicidade.
- **Reimportar o mesmo arquivo duas vezes**: segunda execucao nao altera nada (idempotente).
- **Movimento enviado ao motorista por mensagem mas sem nota**: pode ser corrigido (D2 so protege
  nota), mas o resultado informa quantos ja tinham a mensagem enviada com o valor antigo, para o
  operador reenviar ou avisar.
- **Mensagem na edicao pela tela nao reconhecivel** (texto sem o padrao do valor): o sistema nao
  declara sucesso pleno; informa que a mensagem nao pode ser ajustada automaticamente.
- **Nota enviada entre a verificacao e a gravacao** (motorista envia durante a reimportacao): o
  movimento nao pode ser alterado; verificacao e gravacao sao indivisiveis por movimento.
- **Motivo com numero que parece documento ou e-mail**: o motivo e preservado integralmente no
  registro; nao e descartado nem mascarado.
- **Falha no meio da reimportacao**: o resumo diz com precisao o que foi e o que nao foi aplicado;
  nunca confirma sucesso total.
- **Movimento de outra empresa** (identificador adivinhado): tratado como nao encontrado.
- **Movimento ja fechado**: nao e alterado (ver Suposicoes).

## Clarifications

### Session 2026-10-20

- Q1: estabilidade do `uuid` entre planilha original e corrigida? -> **C, nao provada** (operador
  "nao sei"). Chave dupla `uuid` -> fallback (`id_empresa`+`cnpj_prestador`+`dt_inicial`+`dt_final`).
  Nunca assumir estabilidade. Evidencia: 982/982 com `uuid` (exportada) vs 3/271 (manual).
- Q2: linha sem `uuid` ou com `uuid` inexistente? -> tenta o fallback antes de criar nova; cria
  so se nao ha movimento do CNPJ no periodo (substitui o default "criar nova e contar").
- Q3: movimento `mov_fechado`? -> **confirmado**: nao alteravel, pulado e contado no resumo (D2).
- Q4: ambiguas? -> aplicar o resto do lote e **listar** as ambiguas sem toca-las; muda
  deliberadamente o tudo-ou-nada atual do `POST /upload` (FR-006), autorizado pelo operador.
- Q5: motivo? -> texto livre, um por lote; obrigatorio na reimportacao so quando ela alteraria
  movimentos existentes; sempre obrigatorio na edicao pela tela (dec-010).

## Requirements

### Functional Requirements

**Reimportacao (D1, caminho em lote)**

- **FR-001**: Na reimportacao, o sistema MUST reconhecer um movimento ja existente da mesma
  empresa por **chave dupla** e MUST atualiza-lo em vez de criar outro: (1) pelo `uuid` da linha,
  quando presente e quando casa com movimento da empresa; (2) senao, pelo fallback
  (`id_empresa` + `cnpj_prestador` + `dt_inicial` + `dt_final`), onde o periodo vem do range
  informado na requisicao de import (a planilha nao tem colunas de data). O sistema MUST NOT
  assumir que o `uuid` e estavel entre planilha original e corrigida.
- **FR-002**: Linhas sem correspondente existente MUST continuar sendo criadas como hoje.
- **FR-003**: A reimportacao MUST atualizar apenas o valor, a gorjeta e o texto da mensagem que
  acompanha o valor; nenhum outro campo do movimento (nota, status de envio, CNPJs, datas,
  nome) e alterado por ela.
- **FR-004**: Reimportar o mesmo arquivo repetidamente MUST ser idempotente: a segunda
  execucao nao altera dados nem gera registros de auditoria.
- **FR-005**: Linha **invalida** (validacao de formato/numerica) MUST continuar impedindo que
  QUALQUER linha seja criada ou atualizada (tudo-ou-nada preservado para invalidas).
- **FR-006**: Linha que casa com mais de um movimento existente MUST NOT atualizar nenhum e MUST
  ser reportada como ambigua, **listada** no resultado. As demais linhas do lote MUST ser
  aplicadas normalmente (Q4). Isto **muda deliberadamente** o comportamento atual do
  `POST /upload`, que e tudo-ou-nada tambem para ambiguidade; a mudanca foi autorizada pelo
  operador (uma ambiguidade nao pode travar centenas de linhas boas).
- **FR-007**: Linha sem `uuid`, ou com `uuid` inexistente, MUST tentar o fallback
  (`id_empresa`+`cnpj_prestador`+`dt_inicial`+`dt_final`) ANTES de ser criada como nova. So MUST
  ser criada quando nao existe movimento daquele CNPJ no periodo; nesse caso e contada no resumo.
  Motivo: planilha preenchida a mao vem quase sem `uuid` (268 de 271 linhas), e criar nova
  duplicaria o lote inteiro.
- **FR-008**: Quando a reimportacao alteraria movimentos existentes, o motivo MUST ser
  obrigatorio (um motivo para o lote); sem ele a operacao MUST ser recusada antes de qualquer
  alteracao.
- **FR-009**: O resultado MUST discriminar contagens de: criados, atualizados, inalterados,
  pulados por nota enviada, pulados por movimento fechado, ambiguos e sem identificador.
- **FR-010**: O sistema MUST reconhecer ~980 linhas sem consulta individual por linha e MUST
  entregar o resultado final dentro do limite de 10 segundos do navegador; o desempenho MUST
  escalar com o crescimento do volume semanal.

**Edicao pela tela (D1, caminho pontual)**

- **FR-011**: Ao salvar a edicao do valor, o sistema MUST gravar o valor informado e MUST
  exigir motivo nao vazio.
- **FR-012**: O valor editado MUST passar pela mesma validacao numerica da importacao.
- **FR-013**: O sistema MUST NOT confirmar sucesso quando o valor nao foi gravado; a resposta
  MUST refletir o desfecho real (atualizado, nao encontrado, pulado por nota enviada, falha).
- **FR-014**: Apos corrigir o valor, a mensagem que sera enviada ao motorista MUST refletir o
  valor corrigido; quando isso nao puder ser garantido automaticamente, o sistema MUST avisar o
  operador em vez de declarar sucesso pleno.

**Nota enviada (D2)**

- **FR-015**: "Nota enviada" MUST significar nota anexada preenchida **e** erro de validacao
  vazio; nota anexada com erro de validacao MUST NOT ser considerada enviada. Valores
  em branco (so espacos) valem como vazios.
- **FR-016**: Em ambos os caminhos, movimento com nota enviada MUST manter o valor e MUST ser
  contado como pulado, com a contagem exibida ao operador.
- **FR-017**: A verificacao de nota enviada e a gravacao do novo valor MUST ser indivisiveis por
  movimento (sem janela em que uma nota enviada nesse intervalo seja sobrescrita).
- **FR-018**: O resultado MUST informar quantos movimentos corrigidos ja tinham a mensagem
  enviada ao motorista com o valor antigo.

**Seguranca e escopo**

- **FR-019**: Toda leitura e escrita MUST ficar restrita a empresa-alvo (e filiais do escopo do
  usuario) por filtro explicito, sem depender de controle de linha do banco, que nao filtra.
  Movimento de outra empresa MUST ser tratado como nao encontrado.
- **FR-020**: A correcao de valor MUST exigir a mesma permissao que hoje autoriza importar e
  editar movimentos do Envio em Massa; sessoes sem ela MUST ser recusadas.

**Auditoria (todos os caminhos)**

- **FR-021**: Cada movimento alterado MUST gerar um registro com: movimento, empresa, valor
  anterior, valor novo, motivo, instante, origem (tela ou reimportacao) e autor.
- **FR-022**: O autor MUST ser a pessoa quando a sessao for do hub e a conta da empresa quando
  for do painel legado; o sistema MUST NOT inventar autoria. O registro MUST existir tambem
  para sessoes do painel legado (hoje a trilha so cobre sessoes do hub).
- **FR-023**: A alteracao e o seu registro de auditoria MUST ocorrer juntos: sem registro nao
  ha alteracao.
- **FR-024**: Os registros MUST ser imutaveis para o operador (sem edicao nem remocao) e o
  motivo MUST ser preservado integralmente.

**Fora de escopo**

- **FR-025**: A feature MUST NOT reabrir, recalcular nem alterar apuracao de repasse, e MUST NOT
  alterar o calculo do valor, a origem ou o layout da planilha.

### Key Entities

- **Movimento (EnvioMassa)**: lancamento por motorista/periodo de uma empresa; atributos
  relevantes: valor, gorjeta, texto da mensagem, status de envio da mensagem, nota anexada,
  erro de validacao, indicador de fechado, identificador proprio da linha, empresa.
- **Registro de correcao (auditoria)**: um por movimento alterado; valor anterior e novo,
  motivo, instante, origem, autor, empresa.
- **Resultado da reimportacao**: contagens por desfecho (criado, atualizado, inalterado,
  pulado por nota enviada, pulado por fechado, ambiguo, sem identificador) e lista dos pulados e ambiguos.

## Suposicoes (defaults a confirmar no clarify/plan; nao reabrem D1-D3)

- Identificador da linha: chave dupla (FR-001). Medido nas planilhas reais: exportada do sistema
  (982 linhas) tem `uuid` em 100%; preenchida a mao (271 linhas) tem em 3, 268 sem. A estabilidade
  do `uuid` entre original e corrigida segue **NAO PROVADA** (operador: "nao sei"; amostra de 1
  CNPJ em comum, insuficiente) e nenhum requisito ou teste pode assumi-la.
- O periodo do fallback vem do range informado no import; a planilha nao tem `dt_inicial`/`dt_final`.
- Reconhecimento ocorre entre movimentos **abertos** da empresa; o fallback usa o periodo do range.
- Movimento fechado (`mov_fechado`) e tratado como nao alteravel, de forma conservadora.
- Permissao: reaproveitar a permissao de criar/importar do Envio em Massa (nao criar nova).
- Motivo: texto livre obrigatorio, sem lista fixa.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Reimportar uma planilha corrigida de ~980 linhas deixa o total de movimentos da
  empresa inalterado (0 duplicatas) e 100% dos valores corrigidos refletidos.
- **SC-002**: 0 respostas de sucesso sem gravacao: em teste, toda confirmacao exibida corresponde
  a um valor persistido.
- **SC-003**: 100% dos movimentos com nota enviada mantem o valor, e a contagem exibida de
  pulados coincide com a quantidade real.
- **SC-004**: 100% dos movimentos alterados possuem registro com valor anterior, valor novo,
  motivo, instante, origem e autor.
- **SC-005**: O operador recebe o resultado da reimportacao de 980 linhas em ate 10 segundos.
- **SC-006**: 0 alteracoes atingem movimentos de outra empresa em teste de isolamento.
- **SC-007**: Em 100% dos movimentos corrigidos, a mensagem a enviar ao motorista traz o valor
  corrigido, ou o operador e avisado de que nao pode ser ajustada.
- **SC-008**: Reimportar o mesmo arquivo uma segunda vez resulta em 0 alteracoes e 0 novos registros de auditoria.

> Decisoes de infraestrutura: N/A (sem scheduling, rotacao de chaves, refresh de token ou
> multi-pod; idempotencia coberta por FR-004).

## Delta Requirements

**Skip**: o corpus canonico `docs/specs/current/` nao existe neste repositorio, entao nao ha comportamento documentado a alterar por delta — Claude (feature-00c), 2026-10-20
