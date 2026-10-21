# Feature Specification: Importar o retorno da Transfeera em XLSX

**Feature**: `retorno-transfeera-xlsx`
**Created**: 2026-10-21
**Status**: Implementada, aguardando revisao adversarial e PR (reconciliada com o codigo em 2026-10-21, onda de converge)
**Fonte dos fatos medidos**: `docs/plans/retorno-transfeera-xlsx/BRIEFING.md` e a amostra
`app_homologacao/backend/tests/fixtures/retorno-transfeera-21col-exemplo.xlsx`.

Triagem 0.0: modo autonomo detectado (AGENTE_00C_STATE_DIR) — confirmacao herdada da invocacao do
orquestrador; classificacao: ajuste/extensao (bugfix de formato) — divergencia registrada para auditoria.

## User Scenarios & Testing

### User Story 1 - Confirmar pagamentos de um lote de adiantamento com o arquivo XLSX da Transfeera (Priority: P1)

O financeiro baixa da Transfeera o arquivo de retorno do lote de adiantamento (planilha XLSX de 21 colunas)
e o envia na tela do lote. O sistema casa cada linha com um pagamento do lote pelo ID de integracao
(`ADV-000123`) e marca os pagamentos como efetivados.

**Why this priority**: Hoje a tela recusa o arquivo real e o financeiro nao consegue confirmar pagamentos;
a mensagem de erro exibida nao tem relacao com a causa. E o defeito que originou a frente.

**Independent Test**: enviar a planilha de amostra (58 linhas, `ADV-000015` a `ADV-000074`, todas
`FINALIZADO`) a um lote cujos itens tenham esses IDs e valores; os 58 pagamentos ficam confirmados.

**Acceptance Scenarios**:

1. **Given** um lote de adiantamento com 58 itens pendentes cujos IDs e valores batem com a planilha,
   **When** o financeiro envia a planilha XLSX, **Then** os 58 itens sao confirmados e o resumo informa 58 aplicados, 0 ignorados.
2. **Given** a mesma planilha enviada pela segunda vez, **When** o financeiro reenvia, **Then** nenhum item e alterado e o resumo informa que todos ja estavam aplicados.
3. **Given** um arquivo CSV (formato antigo), **When** o financeiro o envia, **Then** o sistema recusa com mensagem clara de que so o XLSX e aceito.
4. **Given** a tela de importacao do lote (adiantamento ou repasse), **When** o financeiro escolhe o arquivo, **Then** a tela aceita e envia arquivos `.xlsx`, descreve o formato esperado e exibe de forma legivel a mensagem de recusa quando houver.
5. **Given** um retorno aplicado, **When** a confirmacao termina, **Then** os efeitos de negocio (confirmacao do lote, falhas, auditoria, idempotencia, bloqueio de confirmacao parcial) sao identicos aos do fluxo anterior.

---

### User Story 2 - Confirmar pagamentos de um lote de repasse com o mesmo arquivo (Priority: P1)

O mesmo fluxo vale para lotes de repasse, cujos IDs de integracao tem prefixo `REP` (`REP-000123`).

**Why this priority**: os dois fluxos usam o mesmo importador; corrigir so um deixaria o outro quebrado.

**Independent Test**: enviar uma planilha com IDs `REP-…` a um lote de repasse e conferir a confirmacao.

**Acceptance Scenarios**:

1. **Given** um lote de repasse e uma planilha com IDs `REP-…` correspondentes, **When** a planilha e enviada, **Then** os itens sao confirmados.
2. **Given** um lote de repasse e uma planilha com IDs `ADV-…`, **When** enviada, **Then** nenhuma linha e aplicada e o resumo mostra que os IDs nao seguem o padrao do lote.

---

### User Story 3 - Recusa explicita do que o sistema nao sabe interpretar (Priority: P1)

Quando o arquivo traz um status de pagamento que o sistema nao conhece (fora de `FINALIZADO`, `Finalizada`,
`Devolvida`), ou um layout diferente do contrato, o sistema recusa em voz alta, nomeando o que encontrou, em vez de adivinhar.

**Why this priority**: a amostra XLSX so tem `FINALIZADO`; os rotulos `Finalizada` e `Devolvida` foram medidos no CSV
da mesma fornecedora. Qualquer outro rotulo e desconhecido, e adivinhar poderia marcar como pago um pagamento devolvido.

**Independent Test**: planilha com uma linha de status fora dos tres rotulos conhecidos; o lote nao e confirmado e a mensagem cita o valor encontrado.

**Acceptance Scenarios**:

1. **Given** uma linha com status `XYZ` (qualquer valor fora de `FINALIZADO`, `Finalizada`, `Devolvida`), **When** o arquivo e enviado, **Then** essa linha nao e aplicada, o resumo cita `XYZ` (saneado, FR-014) e o lote nao e confirmado parcialmente.
4. **Given** uma linha com status `Devolvida`, **When** o arquivo e enviado, **Then** a linha segue o ramo de devolucao ja existente (falha com o motivo literal do arquivo), nunca o de pagamento efetivado.
2. **Given** uma planilha cujo cabecalho nao tem exatamente as 21 colunas do contrato (ausente, extra, fora de ordem ou renomeada), **When** enviada, **Then** o arquivo e recusado antes de qualquer linha ser interpretada.
3. **Given** um arquivo que nao e uma planilha XLSX valida (binario qualquer, ZIP corrompido, texto renomeado), **When** enviado, **Then** o sistema recusa com mensagem clara, sem erro interno.

---

### User Story 4 - Valores monetarios e celulas em formatos reais (Priority: P2)

Os valores vem como na Transfeera (`54,57`; no futuro `1.234,56`). O sistema interpreta corretamente
valores com separador de milhar, sem aceitar lixo como numero.

**Why this priority**: a amostra nao tem valor acima de mil, mas havera; um valor lido errado geraria
divergencia (item ignorado) ou, pior, confirmacao de valor errado.

**Independent Test**: planilhas com valores `54,57`, `1.234,56` e celulas numericas nativas; todos convertem para o mesmo numero de centavos esperado.

**Acceptance Scenarios**:

1. **Given** uma celula de valor `1.234,56`, **When** lida, **Then** equivale a 123456 centavos.
2. **Given** uma celula de valor ilegivel (`abc`, vazio onde ha ID), **When** lida, **Then** a linha e tratada como divergente e nao aplicada.
3. **Given** uma celula `1.234` ou `12.345` (ponto de milhar SEM parte decimal), **When** lida, **Then** a linha nao e aplicada e o motivo `VALOR_AMBIGUO:<texto>` (FR-020, distinto de `VALOR_DIVERGENTE`) sai em `ignoradasPorMotivo` tanto no 200 quanto no 409 `RETORNO_INCOMPLETO` (o item do lote com essa linha fica sem resultado, entao o 409 e o caso comum); a tela nomeia a causa junto da contagem de pagamentos sem resultado.

---

### Edge Cases

- Linhas repetidas do mesmo ID de integracao: identicas sao deduplicadas; conflitantes recusam o arquivo (comportamento ja existente, preservado).
- Celula vazia no meio de uma linha: a coluna continua existindo (a presenca da coluna e determinada pelo cabecalho, nunca pelo conteudo da linha).
- Linhas totalmente vazias ao final da planilha sao ignoradas.
- Planilha com mais de 10.000 linhas de dados: recusada.
- Arquivo acima do tamanho maximo de transporte: recusado antes de ser lido.
- Planilha com varias abas: so a primeira aba e considerada.
- IDs de integracao em texto livre (arquivo de envio editado a mao): linha ignorada com motivo de ID invalido.
- Celulas com formulas ou conteudo que parece instrucao: tratadas apenas como texto/numero, nunca executadas nem interpretadas.
- Item faltante no arquivo (item do lote sem linha): lote nao e confirmado parcialmente (comportamento existente, preservado).

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST aceitar como retorno da Transfeera, nos lotes de adiantamento e de repasse, arquivos XLSX recebidos como binario, sem corromper os bytes.
- **FR-002**: O sistema MUST deixar de aceitar o retorno em CSV; ao receber CSV (ou qualquer formato nao-XLSX) MUST recusar com mensagem clara de que o formato aceito e XLSX.
- **FR-003**: O sistema MUST conferir o cabecalho da primeira linha contra o contrato exato de 21 colunas (mesmos nomes, mesma ordem) antes de interpretar qualquer linha de dados, recusando o arquivo em caso de divergencia.
- **FR-004**: A presenca de cada coluna MUST ser determinada pelo cabecalho, nunca pelo conteudo das linhas de dados.
- **FR-005**: O casamento de linha com pagamento do lote MUST ser feito exclusivamente pelo ID de integracao (`ADV-<n>` em adiantamento, `REP-<n>` em repasse), reaproveitando a regra de casamento, deduplicacao e idempotencia ja existentes; nunca por nome, CPF/CNPJ ou valor.
- **FR-006**: O sistema MUST reconhecer exatamente tres rotulos de status (comparacao por `trim`, caixa exata): `FINALIZADO` e `Finalizada` como pagamento efetivado e `Devolvida` como devolucao; MUST recusar qualquer outro valor, nomeando o valor encontrado (saneado, FR-014) na mensagem; MUST NOT presumir nenhum rotulo que nao tenha sido medido em arquivo real da Transfeera. *(Revisao: a versao anterior aceitava so `FINALIZADO`. Os tres rotulos foram medidos — o primeiro no XLSX, os outros dois no CSV da mesma fornecedora — e tornar o ramo de devolucao inalcancavel criaria codigo morto de proposito. O plan D3 e a fonte.)*
- **FR-007**: Quando existir motivo de falha no arquivo, ele MUST ser repassado literalmente, sem traducao ou texto fabricado.
- **FR-008**: O sistema MUST converter valores monetarios com virgula decimal e separador de milhar em formato brasileiro (`1.234,56`) e valores numericos nativos para centavos, e MUST tratar valor ilegivel como divergente; o tratamento MUST NOT alterar o resultado para entradas que o importador de outros fluxos ja converte hoje.
- **FR-009**: O sistema MUST limitar o tamanho do arquivo recebido e o numero de linhas de dados (10.000), recusando acima do limite antes de processar o conteudo.
- **FR-010**: O sistema MUST tratar todo o conteudo do arquivo como dado nao confiavel: nenhuma celula e executada, e o tipo da celula (texto, numero, data, formula) nao e presumido.
- **FR-011**: Falhas de leitura (arquivo corrompido, nao-XLSX, vazio, sem aba) MUST resultar em recusa clara ao usuario, nunca em erro interno nem em corpo vazio silencioso.
- **FR-012**: A tela de importacao de ambos os fluxos MUST aceitar e enviar arquivos `.xlsx`, descrever o formato esperado e exibir as mensagens de recusa de forma legivel.
- **FR-013**: Os efeitos de negocio apos o casamento (confirmacao do lote, falhas, auditoria, idempotencia, bloqueio de confirmacao parcial) MUST permanecer identicos aos atuais.
- **FR-014**: O valor de um status desconhecido exibido na mensagem (`STATUS_DESCONHECIDO:<valor>`) MUST ser truncado (40 caracteres) e restrito a letras, numeros, espaco e `. _ -` na BORDA DO BACKEND, onde o motivo e montado — nunca so na tela —, porque a celula e texto arbitrario de terceiro. Teste MUST falhar se o truncamento ou a restricao sairem.
- **FR-015**: Toda mencao a CSV como formato do retorno MUST ser revista: mensagem `CABECALHO_INVALIDO`, `accept` do seletor, constante de tamanho, frase informativa do dialog e os textos da Central de Ajuda que descrevem o retorno da Transfeera. O limite de 20 MB da ajuda pertence ao importador de Faturamento (EntreGo) e MUST NOT ser tocado; o caminho de menu antigo ("Transferencias › Exportar CSV") MUST ser REMOVIDO da ajuda (passa a mandar exportar o arquivo que o sistema recusa) e nenhum caminho novo MUST ser afirmado (nao foi medido; pendencia do operador). Em seu lugar a ajuda descreve o contrato verificavel: `.xlsx`, 21 colunas, coluna `ID integração` com o `ADV-…`/`REP-…` do hub; sobrescrever essa coluna a mao no arquivo de envio faz o casamento falhar.
- **FR-016**: O proxy do frontend (`app/api/[...path]`) MUST repassar ao backend, byte a byte, o corpo cujo `Content-Type` (apos `split(';')[0].trim()`, igualdade exata) e o mime XLSX; nenhum outro endpoint tem seu comportamento de corpo alterado.
- **FR-017**: No ramo XLSX, o proxy MUST recusar antes de ler o corpo: `content-length` ausente ou invalido -> 411; acima de 10 MB -> 413 com `{erro:'ARQUIVO_INVALIDO', motivo:'ARQUIVO_MUITO_GRANDE'}`. O teste MUST afirmar que o corpo nao foi lido nesses casos.
- **FR-018**: O retry do proxy apos 401 (refresh de sessao) MUST reenviar o corpo binario do ramo XLSX; o corpo `multipart` MUST continuar nao reenviavel (stream consumido).
- **FR-019**: As duas rotas de retorno MUST receber o corpo por `express.raw` aplicado na propria rota (depois de modulo, permissao e rate limit; nunca no `express.json()` global), com limite de 10 MB. `Content-Type` diferente do mime XLSX MUST resultar em 400 `FORMATO_INVALIDO`. Um corpo acima do limite recebe o 413 padrao do Express (HTML), igual a rota CSV anterior: **consequencia aceita**, pois o caminho normal e barrado antes pelo teto do dialog; nenhum handler de erro novo e criado para isso.
- **FR-020**: Uma celula de valor que casa `^-?\d{1,3}(?:\.\d{3})+$` (ponto de milhar sem decimais: R$ 1.234,00 no contexto BR, mas `paraCentavos` le 1,23) MUST ser ignorada com motivo proprio `VALOR_AMBIGUO:<texto>` (texto saneado como FR-014), checado ANTES da comparacao de valor, para o diagnostico apontar a leitura do arquivo e nao o cadastro do lote. A validacao MUST ficar na BORDA do leitor/casamento do retorno; `paraCentavos` MUST NOT mudar (compartilhada com o remanescente do adiantamento, onde `1.234` pode ser 1,234). Falha fechada: nunca confirma valor errado. Teste e contraprova (`1.234,56`, `54,57` seguem aplicaveis) em `adiantamento-retorno-transfeera-unit.test.js`.

### Key Entities

- **Arquivo de retorno**: planilha XLSX de 21 colunas gerada pela Transfeera para um lote.
- **Linha de retorno**: ID de integracao, status, valor e, quando houver, motivo literal.
- **Item do lote**: pagamento previamente enviado (adiantamento ou repasse), com ID de integracao, valor e situacao.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A planilha de amostra (58 linhas) e importada com 58 de 58 pagamentos confirmados em um lote correspondente.
- **SC-002**: 100% dos arquivos com cabecalho diferente do contrato, formato nao-XLSX ou status fora de `FINALIZADO`/`Finalizada`/`Devolvida` sao recusados com mensagem que nomeia o motivo.
- **SC-003**: Os testes que usam a planilha de amostra falham contra a versao anterior do sistema e passam depois, e a suite do backend permanece sem falhas (baseline 1956 pass / 0 fail, acrescida dos novos).
- **SC-004**: Um arquivo de 10.000 linhas e importado em menos de 5 segundos; acima disso e recusado.
- **SC-005**: Nenhuma dependencia nova e nenhuma alteracao em arquivos de lock.

## Delta Requirements

### Capability: adiantamento-retorno-transfeera

#### MODIFIED

- **FR-013 da spec `adiantamento-retorno-transfeera` (spec anterior; nao confundir com o FR-013 desta spec)**: O retorno da Transfeera passa a ser XLSX de 21 colunas (substitui o CSV de 23 colunas) em adiantamento e repasse.

> Decisoes de infraestrutura: N/A (feature stateless, sem scheduling, rotacao de chaves ou refresh).
> Premissa de dados factuais: layout, status `FINALIZADO` e formato de ID vem do BRIEFING e da planilha de amostra; o rotulo de devolucao nao foi observado e por decisao nao e adivinhado (FR-006).

## Clarifications

### Session 2026-10-21 (autonomo, onda-002)

- Q: O caminho de recusa de status desconhecido (FR-006) exige mecanismo novo? -> A: Nao. `casarComItensDoLote` ja marca `STATUS_DESCONHECIDO:<valor>` e `rotuloIgnorada` (dialog) ja o renderiza; a mudanca e `STATUS_CONHECIDOS` passar a conter `FINALIZADO` como sucesso. Proibido criar segundo mecanismo de recusa.
- Q: Os rotulos antigos do CSV (`Finalizada`, `Devolvida`) continuam conhecidos? -> A: **Sim (revisado pelo operador, plan D3 prevalece; a resposta anterior "Nao" foi revogada).** Os tres rotulos foram medidos (`FINALIZADO` no XLSX, os outros dois no CSV da mesma fornecedora); recusar `Devolvida` tornaria o ramo de devolucao inalcancavel, codigo morto de proposito. Consequencia aceita (CHK040): o ramo so e alcancavel por `Devolvida`; se o XLSX trouxer outro rotulo, `STATUS_DESCONHECIDO:` nomeia o valor na tela e o operador envia a amostra.
- Q: Janela entre o deploy do backend e do frontend? -> A: Aceita (CHK039). Nela um frontend antigo enviando `text/csv` recebe 400 `FORMATO_INVALIDO`; dura minutos, o importador e de uso pontual e o frontend_v2 ja e stop-first. O runbook registra: nao importar retorno durante a janela de deploy. Nao se aceitam os dois formatos para evitar a janela (seria manter `lerCsv` como codigo morto).
- Q: 413 do `express.raw` sai como HTML? -> A: Aceito (CHK020), paridade com a rota CSV anterior (FR-019).
- Q: Comparacao do status e do cabecalho: tolerancia? -> A: `trim` apenas, sem normalizar caixa (`FINALIZADO` exato; cabecalho exato nome e ordem, apos trim).
- Q: Valor de status desconhecido exibido na mensagem — pode ser cru? -> A: Nao. (promovido a FR-014 na lista de requisitos) o valor do status MUST ser truncado (poucas dezenas de caracteres) e restrito a caracteres imprimiveis na BORDA DO BACKEND, onde o motivo `STATUS_DESCONHECIDO:` e montado, nunca so na tela (celula XLSX aceita texto longo/arbitrario de terceiro; gate owasp de 2026-10-01 ja cortou `ignoradas` cruas pelo mesmo motivo). Teste MUST falhar se o truncamento sair.
- Q: Textos que mencionam CSV? -> A: (promovido a FR-015 na lista de requisitos) toda mencao a CSV na UX e nas mensagens MUST ser revista: `MOTIVO_ARQUIVO.CABECALHO_INVALIDO` ("Exporte o relatorio em CSV" passa a mentir), `accept=".csv"`, `CSV_MAX_BYTES`, frase informativa do dialog.
- Q: Parser das rotas? -> A: As DUAS rotas (`hub-adiantamentos.js`, `hub-repasse-lotes.js`) trocam `express.text` por `express.raw` na propria rota (nunca no `express.json()` global); frontend envia binario (`arquivo.arrayBuffer()`), nao `arquivo.text()`.
- Q: Deteccao de coluna presente/ausente? -> A: so pelo cabecalho (`sheet_to_json(..., {header:1})[0]`), pois `sheet_to_json` omite celula vazia (FR-004).
