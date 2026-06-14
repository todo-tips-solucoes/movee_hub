# Feature Specification: Validação de XML em Lote Idempotente

**Short name**: `validacao-xml-lote`
**Status**: Draft
**Data**: 2026-06-14
**Versão**: 1.0.0

---

## Contexto

O painel Movee Hub (app.moveelog.com.br) permite que operadores façam upload
de XMLs de NFS-e em lote para validar notas fiscais de prestadores de serviço.
Hoje, a validação é efêmera — retorna apenas o resultado momentâneo da chamada
à FastAPI, sem persistir nada na base de movimentos da empresa (EnvioMassa).

Se um operador reenviar os mesmos XMLs (por erro ou re-tentativa), a validação
roda do zero sobre notas que já foram aprovadas, sem nenhuma proteção. Isso
cria risco de sobrescrever resultados aprovados e impede rastreabilidade.

Esta feature torna a validação em lote **idempotente e persistente**: cada XML
do lote é casado com o movimento correspondente e o resultado é gravado — mas
uma nota já aprovada nunca é sobrescrita.

---

## User Scenarios & Testing

### User Story 1 — Reenvio seguro de XMLs com notas já aprovadas (Priority: P1)

**Como** operador da empresa no painel Movee Hub,
**quero** reenviar um lote de XMLs sem me preocupar em apagar notas já aprovadas,
**para** corrigir envios parciais ou re-processar notas com falha sem risco de perda.

**Cenários de aceite**:

| # | Dado (estado da nota em EnvioMassa) | Quando (operador envia XML) | Então (resultado esperado) |
|---|-------------------------------------|-----------------------------|----------------------------|
| 1a | Nota aprovada (resultado positivo presente + sem erro) | Envia XML com mesma chave | Status `ja_validada` — nota preservada, NADA é gravado |
| 1b | Nota reprovada (resultado e erro ambos preenchidos) | Envia XML com mesma chave | Revalida via serviço externo e atualiza o resultado; status `revalidada` |
| 1c | Nota sem validação prévia (resultado vazio) | Envia XML com mesma chave | Valida via serviço externo e grava o resultado; status `validada` |
| 1d | Mesmo XML aparece duas vezes no lote | Upload com arquivo duplicado | Valida uma vez; a segunda ocorrência aparece como `duplicada_no_lote` |
| 1e | XML não corresponde a nenhum movimento aberto da empresa | Upload de XML desconhecido | Status `sem_movimento` — nenhum registro é criado |

**Edge cases**:

- Lote misto: XMLs com estados variados (aprovada + sem validação + sem movimento) no mesmo upload — cada linha processa independentemente
- Movimento existe mas está fechado (`mov_fechado=true`) — tratado como `sem_movimento` (fora do escopo de movimentos abertos)
- XML malformado ou sem campos obrigatórios — reportado como erro de parsing na linha, os demais XMLs continuam
- Serviço externo de validação indisponível (timeout, 5xx) — linha reporta erro de infra "serviço de validação indisponível"; os demais XMLs continuam
- Serviço externo retorna erro de negócio (4xx com mensagem) — a mensagem real é propagada e gravada como resultado reprovado

---

### User Story 2 — Visibilidade do resultado por linha no painel (Priority: P1)

**Como** operador do painel,
**quero** ver o status de cada XML do lote com indicação visual clara (cor + ícone + texto),
**para** identificar rapidamente quais notas foram aprovadas, preservadas, com erro ou sem correspondência.

**Cenários de aceite**:

| # | Status da linha | Apresentação esperada |
|---|-----------------|----------------------|
| 2a | `ja_validada` | Indicador neutro/info — "Já validada – preservada" |
| 2b | `validada` | Indicador positivo — "Validada" |
| 2c | `revalidada` | Indicador positivo — "Revalidada" |
| 2d | `duplicada_no_lote` | Indicador aviso — "Duplicada no lote" |
| 2e | `sem_movimento` | Indicador aviso — "Sem movimento correspondente" |
| 2f | `erro` | Indicador negativo — texto do erro |

**Requisito de acessibilidade**: a distinção entre status NÃO pode depender apenas de cor — cada status tem ícone distinto E texto legível (color-not-only).

**Resumo no topo do card**: contagem agregada (N validadas, M preservadas, P erros).

---

### User Story 3 — Rastreabilidade: qual movimento foi afetado (Priority: P2)

**Como** operador do painel,
**quero** saber qual movimento (id) foi atualizado por cada XML do lote,
**para** auditar o processo e investigar casos específicos sem precisar consultar o banco diretamente.

**Cenários de aceite**:

| # | Situação | Dado visível |
|---|----------|--------------|
| 3a | XML casou com movimento | ID do movimento exibido na linha |
| 3b | Casamento via chave de acesso (primário) | Critério de casamento indicado |
| 3c | Casamento via CNPJ+número+data (fallback) | Critério de casamento indicado como fallback |
| 3d | XML sem movimento | ID vazio / não aplicável |

---

### User Story 4 — Isolamento por empresa/filial (Priority: P1 — non-negotiable)

**Como** sistema multi-tenant,
**quero** que a validação em lote opere estritamente nos movimentos da empresa/filial em escopo,
**para** que dados de uma empresa nunca afetem ou sejam visíveis para outra.

**Cenários de aceite**:

| # | Situação | Comportamento esperado |
|---|----------|----------------------|
| 4a | Operador da empresa A envia XMLs | Apenas movimentos da empresa A são consultados e atualizados |
| 4b | XML corresponde a movimento de empresa B | Não casado — status `sem_movimento` para empresa A |
| 4c | Empresa pertence ao grupo Movee | Roteamento para serviço de validação exclusivo do grupo |
| 4d | Empresa não pertence ao grupo Movee | Roteamento para serviço de validação padrão (nexus) |

---

## Requirements

### Functional Requirements

**Casamento XML ↔ Movimento**

- **FR-001**: O sistema deve extrair de cada XML a chave de acesso (identificador de 50 dígitos), o número da nota, o CNPJ do prestador e a data de emissão.
- **FR-002**: O casamento primário usa a chave de acesso: comparar a chave extraída do XML com a chave derivada de cada movimento em aberto da empresa.
- **FR-003**: Quando o casamento primário falha (chave ausente ou não encontrada), usar fallback por CNPJ do prestador + número da nota + data de emissão (por dia, sem horário).
- **FR-004**: Apenas movimentos com status aberto são elegíveis para casamento; movimentos fechados são ignorados como se não existissem.
- **FR-005**: XML cujo casamento falha em ambas as estratégias (primária e fallback) resulta em status `sem_movimento` — nenhum registro novo é criado.

**Árvore de decisão — o que fazer após o casamento**

- **FR-006**: Movimento casado com resultado de aprovação já presente e sem erro de validação → status `ja_validada`; nenhum dado é gravado ou alterado.
- **FR-007**: Movimento casado com resultado de validação presente e erro de validação presente (nota reprovada) → revalida via serviço externo; grava o novo resultado; status `revalidada`.
- **FR-008**: Movimento casado sem resultado de validação (campo vazio) → valida via serviço externo; grava o resultado; status `validada`.
- **FR-009**: Mesmo XML (mesma chave de acesso) aparece mais de uma vez no lote → valida uma única vez; as demais ocorrências recebem status `duplicada_no_lote` sem nova chamada ao serviço externo.
- **FR-010**: Gravação do resultado opera apenas sobre os campos de resultado e erro de validação — o valor financeiro do movimento nunca é alterado pela validação em lote.

**Idempotência**

- **FR-011**: Reenviar o mesmo lote de XMLs produz o mesmo conjunto de status que o envio anterior — chamadas repetidas a notas já aprovadas retornam `ja_validada` sem efeito colateral.
- **FR-012**: A operação de persistência usa o identificador interno do movimento como chave; nunca cria registros duplicados.

**Roteamento do serviço de validação**

- **FR-013**: Empresas pertencentes ao grupo Movee (conforme regra de grupo vigente no sistema) usam o endpoint de validação exclusivo do grupo; demais empresas usam o endpoint padrão (nexus).
- **FR-014**: Erros retornados pelo serviço externo com código 4xx e mensagem de negócio propagam a mensagem real para o resultado da linha (erro de negócio). Erros de infraestrutura (timeout, 5xx, sem resposta) resultam em mensagem genérica "serviço de validação indisponível" (erro de infra).

**Resiliência do lote**

- **FR-015**: Falha em uma linha do lote (parsing, serviço, casamento) não interrompe o processamento das demais linhas.
- **FR-016**: XMLs com campos obrigatórios ausentes ou malformados são reportados como erro de parsing — o sistema tenta extrair campos disponíveis graciosamente antes de desistir.

**Frontend — feedback visual**

- **FR-017**: A tabela de resultados do lote exibe o status de cada linha com indicador visual diferenciado (ícone + rótulo textual + cor de fundo), garantindo que a distinção não dependa apenas de cor.
- **FR-018**: O resumo da sessão de validação exibe contagens agregadas: total validadas (novas), total revalidadas, total preservadas (`ja_validada`), total duplicadas, total sem movimento, total com erro.
- **FR-019**: Cada linha exibe o identificador do movimento afetado e o critério de casamento usado (chave de acesso ou fallback), quando disponível.
- **FR-020**: Erro de negócio retornado pelo serviço externo é exibido com a mensagem real; erro de infra exibe "serviço de validação indisponível" — sem misturar as duas categorias.

> Decisões de infraestrutura: N/A para esta feature — operação stateless por lote; sem scheduling, sem key rotation, sem mutex multi-pod. A idempotência é garantida pela chave de acesso do movimento (campo existente na base), sem DDL adicional.

### Key Entities

- **Movimento (EnvioMassa)**: registro de um envio de nota fiscal por empresa. Campos relevantes: identificador interno, CNPJ do prestador, número da nota, data de emissão, resultado da validação (nota_ok), erro de validação (erro_validacao), status de fechamento.
- **Resultado de validação por linha**: dado derivado em runtime para cada XML do lote; inclui: nome do arquivo, status (enum acima), identificador do movimento casado, critério de casamento, mensagem de erro (quando aplicável).
- **Lote de XMLs**: conjunto de arquivos NFS-e enviados em uma única operação; processados individualmente, com deduplicação por chave de acesso.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Ao reenviar um lote onde 100% das notas já estão aprovadas, nenhuma nota é alterada na base — 100% das linhas retornam `ja_validada`.
- **SC-002**: Ao enviar um lote misto (aprovadas, reprovadas, sem validação, sem movimento), cada linha recebe exatamente o status correto conforme a árvore de decisão — 0 status incorretos em testes com fixtures reais.
- **SC-003**: O mesmo lote enviado duas vezes produz resultados idênticos na segunda execução — idempotência verificável por comparação de status entre envios.
- **SC-004**: Um XML enviado em duplicata no mesmo lote resulta em exatamente 1 chamada ao serviço externo, com a segunda ocorrência marcada como `duplicada_no_lote`.
- **SC-005**: Falha no serviço externo para um XML do lote não interrompe o processamento dos demais — 100% das linhas restantes são processadas e retornam status.
- **SC-006**: Cada status no painel é distinguível sem depender de cor — verificável por checagem de acessibilidade (ícone + texto presentes em todos os 6 status).
- **SC-007**: Dados de uma empresa nunca aparecem no resultado de outra — 0 vazamentos entre tenants verificados em cenários de teste com duas empresas distintas.
- **SC-008**: O campo valor do movimento permanece inalterado após qualquer operação de validação em lote — verificável por comparação antes/depois.

---

## Clarifications

### Session 2026-06-14 (pré-resolvidas com o operador — §12 do plano mestre)

> Todas as ambiguidades críticas foram resolvidas com o operador em 2026-06-14 (§12 do plano mestre). Registradas como decisões de produto fixadas:

- **P1 — Layout XML**: padrão NACIONAL NFS-e (sped.fazenda.gov.br/nfse, `<NFSe versao="1.01">`). Chave = atributo `Id` de `<infNFSe>` sem prefixo "NFS" (50 dígitos = nome do arquivo). Campos: `numnota=<nNFSe>` (não `<nDPS>` nem `<nDFSe>`); `cnpj_prestador=<emit><CNPJ>`; `data_emissao=<dhEmi>` com fallback `<dhProc>`; `valor=<vLiq>` com fallback `<vServ>`. Defensivo para futuros layouts ABRASF.
- **P2 — Sem DDL**: a chave de acesso é derivada em runtime via `getNFeKeyFromNotaOk` (server.js:1705) a partir das colunas existentes `nota_ok` e `erro_validacao` — nenhuma migração de schema é necessária.
- **P3 — XML sem movimento**: reportar `sem_movimento`; nunca inserir registro novo.
- **P4 — Nota reprovada**: pode ser revalidada e substituída pelo novo resultado do lote (nota reprovada = `nota_ok` preenchido + `erro_validacao` preenchido).
- **P5 — Valor financeiro**: nunca atualizado pela validação em lote; apenas `nota_ok` e `erro_validacao` são gravados.

### Session 2026-06-14 (clarify asker/answerer — onda-002)

- **Q1 — Número da nota no fallback (FR-003)**: o número da nota usa exclusivamente `<nNFSe>`. Se `<nNFSe>` estiver ausente no XML, `numnota=null` e o fallback por CNPJ+número+data falha → linha recebe `sem_movimento`. NÃO usar `<nNumero>` (campo municipal não presente no layout nacional confirmado pelos XMLs reais).
- **Q2 — Critério de nota aprovada (FR-006)**: nota aprovada = `nota_ok` não-vazio **E** `erro_validacao` vazio/nulo. Esta é exatamente a lógica de `getNFeKeyFromNotaOk`. Não depende de valor específico na string de `nota_ok`.
- **Q3 — Escopo de casamento XML↔movimento (FR-002)**: o casamento opera sempre sobre a `empresaId` **exata** extraída do token autenticado — nunca expande para outras empresas do grupo. `mesmoGrupoQue` afeta **apenas** o roteamento para a FastAPI correta (FR-013), nunca o escopo de busca de movimentos.
- **Q4 — UI de resultados (FR-017/FR-018/FR-019)**: a tabela de resultados com os novos status (`ja_validada`, `validada`, `revalidada`, `duplicada_no_lote`, `sem_movimento`, `erro`) **substitui completamente** o feedback atual de validação de XML no painel. NÃO adicionar como seção paralela; os novos status enum substituem os flags booleanos atuais (`valid`, `valid_cnpj_prestador`, etc.) em `ValidationRow`.
