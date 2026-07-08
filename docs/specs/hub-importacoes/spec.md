# Feature Specification: Pipeline de Importações (Faturamento e Performance)

**Feature**: `hub-importacoes`
**Created**: 2026-07-07
**Status**: Draft

> Sessão S4 do plano mestre do Hub de Gestão de Frota (`docs/plans/hub-frota/`). Sobre as
> fundações da S2 (contas, papéis, permissões, entidades, RLS — já mergeada) e o shell da S3
> (navegação por permissão — já mergeada), esta fase entrega o **pipeline de ingestão de
> dados operacionais** vindos de arquivos externos: faturamento e performance da operação,
> em formato de arquivo diário entregue pela plataforma parceira. Cobre o ciclo completo —
> envio do arquivo, validação, persistência, tratamento de erros linha a linha, histórico,
> reprocessamento e cancelamento — mais as telas de acompanhamento correspondentes.
>
> **Não inclui**: telas de consulta/análise dos dados já importados de faturamento ou
> performance (ficam para fases futuras dedicadas a cada um desses módulos); processamento
> em fila assíncrona (o volume atual não justifica — apenas uma fronteira interna isolada
> para permitir plugar fila depois, sem impacto observável nesta fase); o tipo de importação
> do envio em massa existente (entra em fase futura, reaproveitando o mesmo histórico);
> qualquer mudança de comportamento no fluxo de envio em massa já existente hoje.

> **Decisão já ratificada (não reabrir em `/clarify`)**: o sentido de negócio de dois campos
> numéricos do arquivo de faturamento — um indicador de "valor atingido" e um texto de
> composição de margem — permanece intencionalmente indefinido nesta fase. O sistema
> preserva o indicador fielmente dentro da faixa documentada pela fonte, e extrai apenas as
> subpartes do texto de margem que forem reconhecíveis por um padrão estável, sem inferir
> significado além do que é explicitamente extraível (ver FR-024). Essa decisão foi tomada
> pelo responsável do produto antes do início desta fase e está registrada no diário de bordo
> da iniciativa.

## Clarifications

### Session 2026-07-07

- Q: Como a segunda submissão concorrente (mesmo tipo + mesma entidade) deve aguardar a primeira importação terminar? → A: Vira uma **nova importação** com um estado de espera visível no histórico/acompanhamento, iniciando automaticamente quando a anterior atinge um estado terminal (não é rejeitada com 409 nem exige reenvio manual). Ver FR-019, FR-028-INFRA-LOCK e FR-006.
- Q: Reprocessar uma importação falha/cancelada cria um novo registro de Importação ou reseta o existente? → A: **Reseta o registro existente** (mesmo id, estado volta ao inicial/pending, erros antigos substituídos) — não cria novo registro de cabeçalho, pois a unicidade por impressão digital do arquivo (por entidade + tipo) impede um segundo registro. Ver FR-017 e FR-004.
- Q: Quando o mesmo arquivo contém duas linhas idênticas (mesma impressão digital de linha), a segunda conta como válida ou inválida? → A: **Válida** — é deduplicada silenciosamente (mesmo tratamento das duplicatas entre importações); não gera Erro de Linha. Ver FR-012.
- Q: O arquivo original retido segue a retenção indefinida do histórico ou tem expurgo próprio? → A: **Mesma política nesta fase** — retenção indefinida, sem expurgo automático. Uma política de expurgo por prazo/volume permanece uma decisão futura, fora do escopo desta fase. Ver FR-005 e FR-027-INFRA-IDEMP.
- Q: Linhas aceitas com aviso (categoria/valor de classificação desconhecido) devem ter contagem/lista própria visível ao usuário? → A: **Não nesta fase** — o resumo mostra apenas total/válidas/inválidas; avisos ficam registrados apenas internamente, sem superfície dedicada na UI/histórico. Ver FR-009 e FR-020.

## User Scenarios & Testing

### User Story 1 - Operador envia um arquivo de dados operacionais e acompanha até a conclusão (Priority: P1)

Uma pessoa responsável pela operação seleciona o tipo de dado (faturamento ou performance),
envia o arquivo do dia recebido da plataforma parceira, e acompanha o processamento até ele
terminar — sem precisar ficar recarregando a página manualmente ou adivinhar se algo travou.

**Why this priority**: É a capacidade central da fase — sem conseguir enviar um arquivo e
ver o resultado, nenhuma outra capacidade (erros, histórico, reprocessamento) tem propósito.
Sozinha, já entrega valor completo: dados novos entram no sistema.

**Independent Test**: Selecionar um tipo de dado, enviar um arquivo válido de exemplo, e
observar o estado do processamento evoluir até um estado final, com um resumo de quantas
linhas foram aceitas.

**Acceptance Scenarios**:

1. **Given** uma pessoa autorizada na tela de importação, **When** ela seleciona um tipo de
   dado e envia um arquivo dentro do tamanho permitido com a estrutura esperada, **Then** o
   sistema aceita o envio e inicia o processamento, sem exigir nenhuma ação manual adicional.
2. **Given** um processamento em andamento, **When** a pessoa consulta o estado da
   importação, **Then** ela vê o estado atual e, quando concluído, um resumo com o total de
   linhas, quantas foram aceitas e quantas falharam.
3. **Given** um arquivo enviado além do tamanho permitido, **When** a pessoa tenta enviá-lo,
   **Then** o sistema recusa o envio imediatamente, antes de iniciar qualquer processamento,
   com uma mensagem específica sobre o motivo.
4. **Given** um arquivo cuja estrutura não corresponde ao tipo de dado esperado (colunas
   ausentes ou incompatíveis), **When** o processamento tenta validar sua estrutura,
   **Then** a importação termina em um estado de falha estrutural, sem nenhuma linha
   persistida, e com um resumo explicando o motivo.

---

### User Story 2 - O sistema nunca duplica dados ao reenviar o mesmo arquivo (Priority: P1)

Como os arquivos diários às vezes são reenviados por engano (nome trocado, reenvio manual,
nova tentativa após instabilidade), uma pessoa consegue reenviar o mesmo conteúdo quantas
vezes quiser sem correr o risco de duplicar dados que já foram importados.

**Why this priority**: Sem essa garantia, qualquer reenvio corrompe silenciosamente os
números do negócio (faturamento e performance duplicados) — é uma condição de correção
tão crítica quanto a própria capacidade de importar, por isso compartilha a prioridade
máxima com a User Story 1.

**Independent Test**: Importar um arquivo com sucesso, anotar as contagens resultantes,
reenviar exatamente o mesmo arquivo (uma vez com o nome original, outra com o nome
alterado), e confirmar que nenhuma linha nova foi adicionada em nenhum dos dois casos.

**Acceptance Scenarios**:

1. **Given** um arquivo já importado com sucesso, **When** a mesma pessoa (ou outra) envia
   o arquivo idêntico novamente, **Then** o sistema identifica o envio como duplicado e
   recusa a nova importação, indicando de forma clara onde está a importação original.
2. **Given** um arquivo já importado com sucesso, **When** o mesmo conteúdo é enviado sob um
   nome de arquivo diferente, **Then** o sistema ainda assim reconhece o conteúdo como já
   importado e nenhuma linha nova é criada.
3. **Given** um arquivo cujo conteúdo é parcialmente novo (algumas linhas já existem de uma
   importação anterior, outras são inéditas), **When** ele é processado, **Then** apenas as
   linhas inéditas resultam em dados novos — as repetidas são identificadas e ignoradas sem
   gerar erro nem duplicidade.

---

### User Story 3 - Operador entende o que falhou e consegue agir sobre isso (Priority: P2)

Quando nem todas as linhas de um arquivo são válidas, uma pessoa consegue ver exatamente
quais linhas falharam, por qual motivo, e obter essa lista para levar de volta à origem dos
dados (a plataforma parceira) e corrigir o problema — sem nunca ver, no processo, o dado
pessoal bruto de quem está envolvido na linha com erro.

**Why this priority**: Sem visibilidade sobre erros, uma importação parcial vira uma
caixa-preta — a pessoa sabe que "algo falhou" mas não consegue agir. É essencial para o uso
contínuo do pipeline, mas depende das Stories 1 e 2 já existirem (só faz sentido depois que
o fluxo principal de importação está funcionando).

**Independent Test**: Importar um arquivo contendo deliberadamente algumas linhas inválidas
(campo obrigatório ausente, valor fora de faixa), verificar a lista de erros exibida, baixar
o relatório de erros, e confirmar que nenhum dado pessoal bruto aparece nele.

**Acceptance Scenarios**:

1. **Given** uma importação concluída com algumas linhas inválidas, **When** a pessoa
   consulta os erros daquela importação, **Then** ela vê, para cada linha inválida, o
   número da linha, o campo problemático e o motivo — em linguagem compreensível.
2. **Given** uma lista de erros de importação, **When** a pessoa solicita baixar o
   relatório, **Then** recebe um arquivo contendo os mesmos dados apresentados na tela,
   pronto para abrir em uma planilha comum sem risco de comandos ocultos serem executados.
3. **Given** uma linha inválida que continha um dado pessoal (ex.: um identificador de
   pessoa), **When** a pessoa vê o erro correspondente (na tela ou no relatório baixado),
   **Then** o valor exibido está mascarado — o conteúdo bruto da linha nunca é exposto.
4. **Given** um arquivo em que mais da metade das linhas são inválidas, **When** o
   processamento avalia essa proporção, **Then** a importação inteira é recusada, nenhuma
   linha (válida ou não) é persistida, e a pessoa recebe uma explicação clara do motivo.

---

### User Story 4 - Operador consulta o histórico e retoma ou cancela importações (Priority: P2)

Uma pessoa consegue ver todas as importações já realizadas (de qualquer tipo), com filtros
por tipo, estado, período e responsável, e a partir desse histórico consegue reprocessar
uma importação que falhou (sem reenviar o arquivo de novo) ou cancelar uma que ainda está
em andamento e não é mais necessária.

**Why this priority**: Complementa o ciclo de vida da importação (Stories 1-3) com
capacidade de correção e governança operacional — importante para o dia a dia, mas o
pipeline já é funcional e testável sem essa camada de gestão retroativa.

**Independent Test**: Realizar duas ou mais importações (uma bem-sucedida, uma que falhe
estruturalmente), consultar o histórico e confirmar que ambas aparecem com seus estados
corretos, reprocessar a que falhou, e cancelar uma nova importação enquanto ela ainda está
em andamento.

**Acceptance Scenarios**:

1. **Given** múltiplas importações já realizadas, **When** a pessoa acessa o histórico,
   **Then** vê uma lista paginada com tipo, estado, responsável, duração e data de cada
   uma, filtrável por esses mesmos critérios.
2. **Given** uma importação em estado de falha ou cancelada, **When** a pessoa solicita
   reprocessá-la, **Then** o sistema reutiliza o arquivo já enviado (sem exigir novo envio)
   e inicia o processamento novamente.
3. **Given** uma importação que já concluiu (com ou sem erros), **When** a pessoa tenta
   reprocessá-la, **Then** o sistema recusa a ação, pois reprocessar uma importação
   concluída não é uma operação válida (correções entram como um novo arquivo).
4. **Given** uma importação ainda em andamento, **When** a pessoa solicita cancelá-la,
   **Then** o processamento é interrompido em um ponto seguro sem exigir que o arquivo
   inteiro termine de ser processado, e o estado final reflete o cancelamento.
5. **Given** uma pessoa com permissão apenas para consultar (sem permissão de exportar),
   **When** ela tenta acessar o arquivo original de uma importação, **Then** o sistema
   recusa o acesso ao arquivo, embora ela continue vendo o restante das informações da
   importação às quais tem permissão.

---

### Edge Cases

- O que acontece quando duas pessoas tentam enviar, ao mesmo tempo, dois arquivos do mesmo
  tipo para a mesma entidade operante? A segunda submissão deve aguardar a primeira
  terminar, em vez de processar as duas em paralelo e arriscar inconsistência.
- Como o sistema trata um arquivo comprimido malicioso (múltiplos arquivos dentro do
  pacote, caminho de arquivo tentando escapar do local esperado, ou conteúdo que se
  expande para um tamanho desproporcional ao arquivo comprimido)? Deve ser recusado antes
  de qualquer extração completa.
- O que acontece com uma linha que não possui o identificador de pessoa, quando o tipo de
  dado permite legitimamente essa ausência (ex.: um lançamento agregado sem pessoa
  associada)? Não deve ser tratada como erro — apenas linhas em que a ausência não é
  esperada para aquele tipo de dado são inválidas.
- Como o sistema se comporta ao encontrar um valor novo em um campo de classificação onde
  só um conjunto conhecido de valores era esperado (ex.: uma categoria nova que a origem
  passou a usar)? A linha deve ser aceita com um aviso, não rejeitada — o conjunto de
  valores conhecidos pode evoluir sem quebrar a importação.
- O que acontece quando a sessão da pessoa expira no meio do acompanhamento de uma
  importação em andamento? Ao autenticar novamente, ela deve conseguir retomar o
  acompanhamento do mesmo processamento, que continua em segundo plano independente da
  sessão de quem o iniciou.
- Como o sistema trata uma tentativa de cancelar uma importação que, entre o clique da
  pessoa e o processamento do pedido, já terminou (concluída ou falhou)? O pedido de
  cancelamento deve ser recusado de forma clara, sem gerar um estado inconsistente.
- O que acontece se o arquivo original de uma importação antiga não estiver mais disponível
  no momento em que alguém tenta reprocessá-la ou baixá-la? A pessoa deve receber uma
  mensagem de erro clara em vez de uma falha silenciosa ou tela quebrada.
- Como o sistema garante que uma pessoa de uma entidade nunca veja, no histórico ou nos
  detalhes, importações pertencentes a outra entidade fora do seu escopo de acesso?

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST permitir que uma pessoa autorizada selecione um tipo de dado
  (faturamento ou performance) e envie um arquivo correspondente (documento simples ou um
  único documento compactado) até um tamanho máximo definido (20 MB).
- **FR-002**: O sistema MUST validar, antes de aceitar qualquer envio para processamento: a
  extensão do arquivo, o limite de tamanho, e que o conteúdo é compatível com o tipo
  declarado — recusando imediatamente e com mensagem específica quando qualquer dessas
  condições falhar.
- **FR-003**: Para envios compactados, o sistema MUST recusar qualquer pacote que contenha
  mais de um arquivo interno, qualquer entrada cujo caminho tente escapar do local de
  extração esperado, ou cujo conteúdo descompactado ultrapasse um limite de segurança
  (100 MB) — a recusa MUST ocorrer antes de qualquer extração completa do conteúdo.
- **FR-004**: O sistema MUST calcular uma impressão digital estável do conteúdo de cada
  arquivo enviado e, caso um arquivo com a mesma impressão já tenha sido importado para a
  mesma entidade operante e o mesmo tipo de dado, MUST recusar o novo envio referenciando
  claramente a importação original, sem criar uma duplicata.
- **FR-005**: O sistema MUST reter o arquivo original de cada importação aceita, acessível
  posteriormente apenas a pessoas com a permissão específica de exportação, e MUST NOT
  expor ou usar o nome do arquivo enviado como identificador endereçável no sistema.
- **FR-006**: Toda importação aceita MUST progredir por um conjunto visível e ordenado de
  estados, e o estado atual de qualquer importação MUST ser sempre consultável por quem a
  enviou ou por qualquer pessoa com permissão de visualização no mesmo escopo.
- **FR-007**: O sistema MUST interpretar cada campo numérico do conteúdo de origem conforme
  a convenção de separador decimal própria daquele tipo de dado — os dois tipos suportados
  usam convenções diferentes entre si, e o sistema MUST NUNCA presumir a mesma convenção
  para os dois.
- **FR-008**: O sistema MUST validar cada linha do conteúdo contra as regras específicas do
  tipo de dado correspondente (campos obrigatórios, faixas de valor, formato de datas,
  durações e identificadores) e MUST NOT aceitar silenciosamente uma linha que viole uma
  regra obrigatória.
- **FR-009**: O sistema MUST aceitar, em campos de classificação não-obrigatórios para a
  integridade do registro, valores desconhecidos-porém-plausíveis como um aviso na linha
  (linha continua válida), reservando a rejeição da linha apenas para violação de regras
  obrigatórias. Um aviso NÃO reclassifica a linha como inválida e, nesta fase, NÃO possui
  contagem nem lista própria visível ao usuário (o registro do aviso é interno); o resumo da
  importação expõe apenas total/válidas/inválidas (ver FR-020).
- **FR-010**: O sistema MUST aceitar linhas sem identificador de pessoa quando o tipo de
  dado permite legitimamente essa ausência (registros agregados), sem tratar a ausência,
  isoladamente, como motivo de erro.
- **FR-011**: O sistema MUST consolidar cada pessoa referenciada por identificador externo
  em um único registro por entidade operante, reutilizando o registro existente em
  importações futuras que referenciem o mesmo identificador (sem duplicar pessoas).
- **FR-012**: O sistema MUST garantir que, para duas importações com exatamente o mesmo
  conteúdo de origem (mesmo sob nome de arquivo diferente ou reenvio), a segunda resulte em
  zero linhas de dado novas armazenadas. A mesma deduplicação por conteúdo de linha MUST se
  aplicar a duas linhas idênticas **dentro de um mesmo arquivo**: a ocorrência repetida é
  deduplicada silenciosamente (conta como válida, sem gerar Erro de Linha), com o mesmo
  tratamento dado às duplicatas entre importações.
- **FR-013**: O sistema MUST processar as linhas em lotes delimitados, de forma que uma
  falha ou interrupção no meio do processamento não exija reprocessar do zero os lotes já
  confirmados com sucesso.
- **FR-014**: Quando a proporção de linhas inválidas em um envio ultrapassar um limite
  definido (50%), OU a estrutura do arquivo for irreconhecível (colunas esperadas ausentes
  ou incompatíveis), o sistema MUST rejeitar a importação inteira, não persistir nenhuma
  linha dela, e marcá-la em um estado terminal distinto de uma conclusão parcial.
- **FR-015**: Quando apenas parte das linhas falhar validação (abaixo do limite), o sistema
  MUST persistir todas as linhas válidas e registrar individualmente cada linha inválida com
  detalhe suficiente (número da linha, campo problemático, motivo) para uma pessoa entender
  e agir — o motivo registrado MUST NUNCA incluir o valor bruto e não tratado da linha
  quando esse valor puder conter dado pessoal (apenas representação mascarada é permitida).
- **FR-016**: O sistema MUST permitir que uma pessoa com permissão adequada visualize a
  lista de linhas com erro de uma importação e obtenha essa lista como um arquivo para
  download, protegido contra execução de comandos ocultos ao ser aberto em programas de
  planilha comuns.
- **FR-017**: O sistema MUST permitir reprocessar uma importação que tenha terminado em
  estado de falha ou de cancelamento, reaproveitando o arquivo originalmente enviado sem
  exigir um novo envio. O reprocessamento MUST **resetar o registro de importação existente**
  (mesmo identificador; estado retorna ao inicial; erros anteriores substituídos) em vez de
  criar um novo registro de cabeçalho — a unicidade da submissão por impressão digital do
  arquivo (por entidade operante e tipo) impede um segundo registro para o mesmo conteúdo
  (ver FR-004).
- **FR-018**: O sistema MUST permitir cancelar uma importação enquanto ela ainda não
  atingiu um estado terminal; o cancelamento MUST surtir efeito em um intervalo curto,
  sem depender de o arquivo inteiro terminar de ser processado primeiro.
- **FR-019**: O sistema MUST impedir que duas importações do mesmo tipo de dado, para a
  mesma entidade operante, sejam processadas simultaneamente — uma segunda submissão
  concorrente MUST ser aceita como uma **nova importação em estado de espera** (visível no
  histórico/acompanhamento) e MUST iniciar automaticamente assim que a anterior atingir um
  estado terminal, sem ser rejeitada nem exigir reenvio manual. O conjunto ordenado de
  estados de FR-006 MUST incluir esse estado de espera.
- **FR-020**: O sistema MUST permitir que uma pessoa autorizada visualize um histórico
  paginado e filtrável de importações (por tipo, estado, período, responsável) restrito às
  entidades do seu escopo, incluindo duração e um resumo legível das contagens
  (total/válidas/inválidas).
- **FR-021**: O sistema MUST restringir cada ação relacionada a importações (enviar,
  visualizar lista/detalhe, visualizar/baixar erros, baixar arquivo original, reprocessar,
  cancelar) conforme a permissão específica da pessoa para aquela entidade operante — nenhuma
  ação MUST ficar disponível fora do escopo de entidades da pessoa.
- **FR-022**: O sistema MUST registrar, para toda importação (bem-sucedida ou não), uma
  entrada de trilha auditável identificando quem a enviou, quando, e o resultado final.
- **FR-023**: O sistema MUST NUNCA expor o conteúdo bruto e não tratado de uma linha
  importada que contenha dado pessoal em nenhuma mensagem de erro, registro de log ou
  relatório de erro disponibilizado para download — apenas representações mascaradas são
  permitidas fora do conjunto de dados persistido em si.
- **FR-024**: O sistema MUST preservar fielmente dois campos numéricos cujo significado de
  negócio é intencionalmente indefinido nesta fase (um indicador de "valor atingido" e um
  texto de composição de margem), aceitando o indicador dentro da faixa documentada pela
  origem e, separadamente, extraindo apenas as subpartes do texto de margem que forem
  reconhecíveis por um padrão estável — sem inventar ou inferir significado além do que é
  explicitamente extraível; quando o texto não seguir o padrão reconhecível, o sistema MUST
  preservar o texto original sem as subpartes derivadas.
- **FR-025**: Toda tela nova entregue por esta fase MUST preservar a identidade visual
  (incluindo variação por tenant/cliente e os modos claro/escuro) já estabelecida no
  restante do painel.
- **FR-026**: O sistema MUST manter, durante esta fase, o comportamento observável do
  fluxo de envio em massa já existente hoje — esta fase não MUST alterar seu funcionamento.

> **Decisões de infraestrutura**:
> - **FR-027-INFRA-IDEMP**: idempotência dupla e sem expiração — por conteúdo do arquivo
>   completo no nível da submissão, e por conteúdo de cada linha individual no nível do
>   registro, ambas escopadas por entidade operante e tipo de dado. Não há TTL: uma
>   importação antiga permanece uma referência de duplicidade válida indefinidamente
>   (histórico de importações nunca expira nem é limpo automaticamente). O arquivo original
>   retido (FR-005) segue a mesma política nesta fase — retenção indefinida, sem expurgo
>   automático; uma política de expurgo por prazo/volume é decisão futura, fora deste escopo.
> - **FR-028-INFRA-LOCK**: serialização de processamento — no máximo uma importação ativa
>   por combinação de entidade operante e tipo de dado simultaneamente; uma segunda
>   submissão concorrente aguarda em um estado de espera até a anterior atingir um estado
>   terminal.
> - Esta fase não introduz scheduling periódico, rotação de chaves de criptografia, refresh
>   de token externo, ou mecanismo de backup novo.

### Key Entities

- **Pessoa Entregadora**: indivíduo referenciado por um identificador externo dentro dos
  arquivos de origem, consolidado em um único registro por entidade operante; pode
  futuramente ser associado a uma conta de acesso de motorista (fora do escopo desta fase).
- **Importação**: registro de cabeçalho de cada arquivo enviado — tipo de dado, estado
  atual, contagens (total/válidas/inválidas), responsável, datas de início/conclusão, e
  referência ao arquivo original retido.
- **Erro de Linha**: um registro por linha inválida dentro de uma importação — localização
  na origem, campo problemático, motivo, e valor mascarado (nunca o valor bruto).
- **Lançamento de Faturamento**: um registro por linha de um arquivo de faturamento —
  detalhe de um movimento financeiro individual associado (quando aplicável) a uma pessoa
  entregadora.
- **Turno de Performance**: um registro por linha de um arquivo de performance — métricas
  operacionais de um turno individual de uma pessoa entregadora.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Importar os dois arquivos de referência anonimizados (faturamento e
  performance) resulta em 100% de suas linhas classificadas como válidas e persistidas,
  confirmado por comparação de contagens antes/depois com os totais conhecidos dos arquivos.
- **SC-002**: Reenviar o arquivo usado no SC-001 — tanto com o nome original quanto sob um
  nome diferente — resulta em zero linhas de dado novas em ambos os casos.
- **SC-003**: Um arquivo com estrutura não reconhecida (colunas esperadas ausentes) atinge
  um estado de rejeição distinto, com zero linhas persistidas, sem exigir nenhuma
  intervenção manual para a importação "travar" ou ficar em estado indefinido.
- **SC-004**: 100% dos relatórios de erro baixados e das mensagens de log geradas durante
  testes de importação contêm zero ocorrências de valores pessoais não mascarados,
  verificado por inspeção direta do conteúdo.
- **SC-005**: Uma pessoa consegue completar a jornada completa — enviar um arquivo,
  acompanhar até um estado final, revisar os erros linha a linha, baixar o relatório de
  erros e, para uma importação falha, reprocessá-la — inteiramente pelas telas de
  importação, sem precisar de nenhuma ação fora delas.
- **SC-006**: Duas pessoas com níveis de permissão diferentes, comparadas lado a lado sobre
  a mesma importação, têm conjuntos de ações disponíveis diferentes exatamente conforme
  suas permissões (ex.: uma consegue baixar o arquivo original, a outra não).
- **SC-007**: Todas as telas novas entregues nesta fase preservam a identidade visual
  (branding por cliente e temas claro/escuro) sem regressão perceptível em relação ao
  restante do painel.
- **SC-008**: Zero mudança no comportamento observável do fluxo de envio em massa já
  existente, verificado por comparação antes/depois.
