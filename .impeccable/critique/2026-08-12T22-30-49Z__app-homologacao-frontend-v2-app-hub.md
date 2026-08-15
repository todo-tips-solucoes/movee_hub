---
target: hub de frota (app/hub) — crítica r22, dual-agent, medida no hub-homolog da main bfde6bc
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-12T22-30-49Z
slug: app-homologacao-frontend-v2-app-hub
---
Method: dual-agent (A: revisão de design por código · B: detector + medição no Chromium do hub-homolog)

Alvo: `app_homologacao/frontend_v2/app/hub/**` — 16 rotas, modo **Operate**. Frontend medido: `hub-homolog` buildado da `main` atual (`bfde6bc`), base QA vazia, tema dark, 390px e 1440px.

## Design Health Score

| # | Heurística | Nota | Achado que define a nota |
|---|-----------|------|--------------------------|
| 1 | Visibilidade do estado | 3 | Skeleton em 7/7 rotas aplicáveis (medido), polling com hora da última atualização, rótulo próprio para "status indisponível". Mas a pílula de estado do disparo fica no header e o controle no meio da página; disparo que falha volta a "Parado", indistinguível de "nunca comecei" |
| 2 | Correspondência com o mundo real | 3 | Vocabulário de negócio excelente e desambiguado ("data de competência, não a data de importação"). Três telas falam SQL: `usuario_vinculo_desativado` como coluna de auditoria, `motoristas.excluir` em mono ao lado do rótulo humano (visto na tela), usuário como `#42` |
| 3 | Controle e liberdade | 3 | Desfazer real onde dói (toast com refazer em papéis e usuários). Mas 4 das 6 listas guardam filtro em `useState` — F5 apaga, e o link não é colável —, enquanto motoristas/importações já usam `useFiltrosUrl` |
| 4 | Consistência e padrões | 3 | `PageHeader`, larguras, selects e bloco de erro unificados. Mas coexistem dois containers de filtro com duas semânticas de "Limpar" (um desabilita em zero e conta, o outro não), e três destinos diferentes para "ver o detalhe" |
| 5 | Prevenção de erros | 3 | Eixo mais trabalhado do produto: confirmação com números reais, botão desabilitado sobre dado obsoleto, toggle em vez de DELETE. Dois furos: revogar permissão "alto impacto" grava no clique, e filtros de igualdade exata em texto livre devolvem zero silencioso |
| 6 | Reconhecimento vs. memorização | 3 | Comboboxes, `<datalist>`, presets de período, modelo de planilha baixável. Mas na mesma grade de filtros convivem um campo que pede a string exata (`Ex.: ALMOCO 11H30-15H29`) e um select populado por endpoint |
| 7 | Flexibilidade e eficiência | 3 | Ações em lote fortes (seleção multipágina, disparo, export). Ordenação em 3 das 7 listas; **zero atalhos de teclado no produto inteiro** — o único acelerador é o skip-link; 13 colunas fixas em performance sem controle de colunas |
| 8 | Estética e minimalismo | 3 | Telas respiram, hierarquia de header consistente. Mediana medida de 30 controles/rota @1440; `usuarios/papeis` = **148, 4,9× a mediana**; `envio_massa` empilha 8 regiões simultâneas; em faturamento o gráfico aparece **acima** dos filtros que o governam |
| 9 | Diagnóstico e recuperação | 3 | Bloco `role="alert"` + "Tentar novamente" replicado com fidelidade em 8 telas. Mas as falhas da tela de maior consequência (iniciar/parar disparo, exportar, fechar movimento) são **todas** `toast.error` efêmero |
| 10 | Ajuda e documentação | 3 | Uma ajuda contextual genuína (o `<details>` do wizard: separador, codificação, ordem das colunas, "a falha é total") e notas explicativas nos filtros de período. Nada define "Taxa de aceitação" vs "Taxa de conclusão" nem "Agregados/bônus" |
| **Total** | | **30/40** | **Good** |

**Isto não é regressão contra os 35/40 da R21 — é outra lente.** A R21 mediu conformidade mecânica (alvo de toque, overflow, `h1`, larguras, selects nativos) e continua correta: reconferi e nada disso regrediu. Esta passada julga fluxo, arquitetura de informação, estados e copy — exatamente o eixo que as 20 rodadas não atacaram.

## Veredito de especificidade de design

**Identidade visual autoral aplicada sobre um esqueleto shadcn-admin intercambiável.**

O que é deste produto e de mais ninguém: a paleta (fundo creme `#f9f2e8` / marinho `#0f1849` no claro, sidebar num tom distinto do card, gradiente azul→menta) sobrevive ao white-label por tenant e nenhum SaaS chega nela por acidente. E o `envio_massa` tem quatro invenções que só existem porque alguém entendeu o negócio: o período do movimento derivado de min/max das linhas em vez de `data[0]`; o escopo do disparo congelado no `start` porque o operador pode desmarcar durante o envio; a confirmação que distingue "marcados" de "que realmente saem"; e o par `DisparoRecibo`/`FechamentoRecibo`.

O que é intercambiável: **faturamento, performance, motoristas, importações, auditoria e usuários são o mesmo arquivo com substantivos trocados** — e o próprio código admite, com a frase "Mesmo molde de .../faturamento/page.tsx" repetida em quatro cabeçalhos. Troque "Faturamento" por "Invoices" e "Subpraça" por "Region" e isso é o admin de qualquer produto B2B. Nada na composição diz *frota*: não há representação do ciclo de vida do movimento, e `/hub/dashboard` é uma grade de cards de módulo que duplica a sidebar — o primeiro card leva à própria página em que o usuário já está.

**A especificidade do produto está concentrada em 1 das 16 rotas.** As outras 15 são o chassis: ninguém as desenhou, elas foram herdadas.

**Scan determinístico:** `detect.mjs` sobre `app/hub` + `components/hub` → **0 achados, exit 0**. Nenhum falso positivo a marcar — e nenhum sinal: o detector já foi registrado nesta base como tendo poder discriminante nulo neste alvo. Ele prova ausência de regressão nas regras que conhece, não qualidade.

**Medição no browser (16 combos, 8 rotas × 2 larguras):**
- **321 controles alcançados por Tab real; 0 sem indicador de foco.** A diferença para os 630 candidatos é `disabled`, não foco perdido — em `usuarios/papeis` são os 132 checkboxes em modo leitura.
- **634 textos com contraste medido contra o fundo efetivo compositado; 0 abaixo de AA.** Concorda com a regra `color-contrast` do axe rodada em separado — dois métodos independentes, mesmo resultado.
- `axe-telas` 6/6 verdes, score 95, **1 violação idêntica em todas**: `region` (moderate) — o header sticky fora de landmark. `contraste-telas-migradas` 12/12, zero violações. Suíte completa do hub: **134/134**.
- **Lacuna declarada:** contraste em tema claro não cobre `envio_massa`, `validacao_xml` e `usuarios/papeis` por nenhum dos dois caminhos. E nenhuma tela foi medida com tabela cheia — a base QA está vazia.

**Sem overlay no browser do usuário**: a medição rodou no container oficial do Playwright (é o rito deste repo, que proíbe instalar browser no host), então não há overlay visível para inspecionar. As 16 screenshots de página inteira estão em `docs/plans/hub-frota/evidencias/S3/critica-r22/`.

## Impressão geral

O hub tem uma tela desenhada e quinze montadas. As 20 rodadas anteriores endureceram a superfície — alvo de toque, contraste, foco, larguras, overflow: tudo medido e limpo, e isso não é pouco. O que elas não tocaram é a camada onde o operador realmente perde tempo: o filtro que evapora no F5, o "Voltar" que apaga o trabalho, o erro do disparo que some em 4 segundos, o campo que exige decorar uma string ao lado de um select que oferece a lista.

**A maior oportunidade:** o `envio_massa` prova que este time sabe desenhar para este domínio. A pergunta não é como melhorar as outras telas — é o que aconteceria com faturamento se recebesse o mesmo tipo de atenção que o disparo recebeu.

## O que está funcionando

**1. O par de recibos como resposta ao pico-fim.** `DisparoRecibo` e `FechamentoRecibo` trocaram um toast de 4s por um artefato que fica, no instante exato em que a memória do usuário se forma, com os números daquele disparo e não do movimento inteiro. O botão muda de rótulo quando houve escopo, para não prometer 3 e entregar 15. É a única parte do hub que nenhum outro produto poderia usar sem mudar nada.

**2. Uma gramática consistente de "eu não sei".** Cards renderizam `—` em vez de zeros quando a carga falhou; indicador nulo nunca vira `0%`; as duas confirmações irreversíveis se desabilitam sobre dado que não vale; o combobox degrada para campo de ID quando a busca cai e fica degradado. Quatro mecanismos independentes recusando-se a afirmar o que não sabem — a maioria dos dashboards renderiza zero e mente.

**3. `PeriodFilter`.** Resolve um problema sem solução limpa — `<input type="date">` mostra o formato do browser, não o do país — sem escrever um date-picker: presets como atalho, eco do intervalo em pt-BR abaixo, intervalo invertido dito na hora. O estado continua sendo só `de`/`ate`; qual chip acende é derivado.

## Problemas prioritários

### [P1] "Voltar à lista" descarta exatamente o trabalho que a URL foi construída para preservar
As duas telas de detalhe fazem `router.push('/hub/dashboard/<lista>')` — caminho nu, sem query string. As duas listas usam `useFiltrosUrl` precisamente para que, nas palavras do comentário no código, *"voltar ao histórico devolva o histórico como estava"*. O botão que tem esse nome é o único caminho que não faz isso.
**Por que importa:** filtrar → abrir um item → voltar é o loop mais repetido de uma superfície Operate. Em importações, cada volta custa remontar período, tipo, status e responsável à mão.
**Conserto:** `router.back()` quando houver histórico interno, ou recompor a URL a partir de `useSearchParams()` da lista.
**Comando:** `/impeccable harden`

### [P1] As falhas da tela de maior consequência são as únicas efêmeras do produto
Iniciar disparo, parar, exportar CSV, baixar XML e fechar movimento falham em `toast.error`. Todo o resto do hub usa bloco persistente com "Tentar novamente", replicado com fidelidade em 8 telas.
**Por que importa:** se o disparo falha, a mensagem some em segundos e a pílula volta a "Parado" — estado indistinguível de "nunca iniciei". O operador reclica e pode disparar duas vezes para gente real.
**Conserto:** o mesmo bloco `role="alert"` persistente do resto do hub, acima da barra de ações, com o motivo e "Tentar novamente". O toast fica só para o sucesso.
**Comando:** `/impeccable harden`

### [P2] Dois containers de filtro, duas semânticas de "Limpar" — e um gráfico acima dos filtros que o governam
`FilterBar` em motoristas/importações/usuários vs. uma `<div>` artesanal em faturamento/performance/auditoria. Não é só visual: o botão que desabilita quando não há nada a limpar e mostra `(N)` filtros ativos existe em 3 telas e não existe nas outras 3. Em faturamento, a screenshot mostra o problema maior: o gráfico "Distribuição do faturamento" é renderizado **acima** do bloco de filtros que o alimenta, e o "Limpar filtros" fica órfão no canto inferior direito, alinhado a uma nota explicativa em vez de aos campos.
**Por que importa:** o operador aprende um comportamento e ele muda de rota para rota; e lê um resultado antes de encontrar o controle que o produziu.
**Conserto:** trocar as três `<div>` por `FilterBar`; mover o bloco de filtros para acima do gráfico nas duas telas de análise.
**Comando:** `/impeccable layout`

### [P2] Recall exigido ao lado de reconhecimento oferecido
Na mesma grade, "Turno (período)" pede a string exata em texto livre (`Ex.: ALMOCO 11H30-15H29`) e "Subpraça" oferece um select populado por endpoint. Faturamento repete com "Categoria".
**Por que importa:** o filtro é por igualdade. Errar um espaço ou o acento devolve zero, e a tela diz "Nenhum lançamento no período selecionado" — o usuário não distingue "digitei errado" de "não existe".
**Conserto:** replicar o padrão `/areas` (`/performance/periodos`, `/faturamento/categorias`); ou, sem backend novo, um `<datalist>` alimentado pelos valores da página atual — recurso que a auditoria já usa.
**Comando:** `/impeccable clarify`

### [P2] A matriz de papéis: 148 controles, colunas que somem ao rolar, e um nome acessível diferente do visível
Medido: 148 controles interativos na rota, 4,9× a mediana de 30. A página tem 2054px de altura a 1440 e o `<thead>` **não é sticky** (conferido no código) — quem rola até "ADMIN" perde os quatro nomes de coluna e passa a marcar caixas às cegas, a ~600px de distância horizontal do rótulo da linha. Pior: o nome acessível de cada caixa é o **código** (`motoristas.excluir para Operador`) enquanto quem enxerga lê o rótulo humano. Duas verdades sobre o mesmo controle, 132 vezes, e o leitor de tela recebe a pior. Some-se a isso que revogar uma permissão marcada "alto impacto" grava no clique, sem a confirmação que o admin de módulos — mesma classe de perda de acesso — já pede.
**Conserto:** `sticky top-0` no cabeçalho da tabela; `aria-label` com o rótulo humano e o código como complemento, não como nome; `AlertDialog` na revogação de alto impacto.
**Comando:** `/impeccable distill`

## Red flags por persona

**Alex (power user — dispara e fecha todo dia).** Zero atalhos de teclado no produto inteiro; o único acelerador é o skip-link. Ordenação em 3 das 7 listas — faturamento, performance, auditoria e a lista de usuários têm cabeçalhos mudos. Filtro montado em faturamento/performance/auditoria não sobrevive a F5 nem vira link colável. "Voltar à lista" apaga os filtros. 13 colunas fixas em performance, sem controle de colunas: rolar pelas mesmas 7 irrelevantes, todo dia. `KpiCard` suporta `trend` e nenhuma tela passa — Alex nunca vê "vs. período anterior", que é a única pergunta que ele faz a um KPI.

**Sam (dependente de acessibilidade).** Foco visível e contraste passaram em tudo que foi medido — 321 controles, 634 textos, zero falhas. O que quebra é semântica: o nome acessível dos 132 checkboxes de papéis é o código, não o rótulo; o erro de validação em `redefinir-senha` é renderizado em `text-muted-foreground` sem `role="alert"` e sem `aria-describedby`, embora o input já receba `aria-invalid` — Sam sabe que o campo é inválido e não recebe o motivo; o payload da auditoria vive num `<pre>` rolável sem `tabIndex={0}`, inalcançável por teclado; o upload do wizard tem dois nomes acessíveis para o mesmo alvo. E a violação `region` do axe é a mesma em 6/6 telas.

**Operador de tenant pequeno (uma entidade, 2× por semana).** `/hub/dashboard` não diz nada sobre o estado do trabalho: nem se há movimento aberto, nem se a última importação terminou, nem se há linhas com erro — é uma grade de cards que duplica a sidebar, e o primeiro card aponta para a própria página. **O primeiro estado que um cliente novo vê é um beco sem saída:** medido, das 5 telas com estado vazio, só `envio_massa` diz o que fazer a seguir ("Importe um arquivo XLSX ou ajuste os filtros"); motoristas, importações, faturamento e performance param na constatação, embora o `EmptyState` aceite `children` e importações já use isso em outro ponto. Faturamento e performance ainda emitem **duas** mensagens de vazio na mesma tela, com vocabulários diferentes. E a auditoria de um tenant de 3 pessoas exibe `#12`, `#13`, `#14` — o combobox que resolve nomes existe no filtro e não na leitura.

## Observações menores

- A regra de largura foi escrita e quase não é usada: `LARGURA_LISTA` existe e só duas telas a importam; seis repetem o literal `max-w-[96rem]`. O gate passa porque o valor coincide; a regra nomeada, não.
- Duas implementações de formatação de hora convivem (`toLocaleTimeString` inline vs. `formatDataHoraBR` própria).
- O gráfico avisa que cortou em 10 barras e manda "refinar os filtros", mas não oferece o controle ali.
- A auditoria documenta em comentário que ações com ponto (`importacao.criada`) **são registradas mas o filtro do backend as rejeita com 400** — existem eventos na trilha que o filtro da própria tela não alcança, e a lista de sugestões esconde isso em vez de dizê-lo.
- `envio_massa` mantém um comentário sobre validação de XML que já saiu da página.

## Perguntas a considerar

1. **Se o produto é um ciclo (importar → conferir → disparar → validar → fechar), por que a navegação é uma lista de 10 destinos equivalentes?** Nada na sidebar diz que importações vem antes de envio em massa.
2. **`/hub/dashboard` é a única tela que não faz nada.** Se mostrasse "Movimento aberto 01/08–07/08 · 340 linhas · 12 com erro · última importação há 2h", o operador teria razão para abrir o hub em vez de ir direto ao disparo. Os dados já existem — o `envio_massa` os deriva.
3. **A conferência sai do produto de propósito?** "Exportar CSV" existe em três telas. Se a conferência é no Excel por escolha, otimize o export (nome do arquivo com o período, colunas escolhidas, ordenação). Se não é escolha, falta a tela de conferência — e ela é a etapa 2 de 5 do fluxo declarado.
4. **Fechado o movimento, para onde as linhas foram?** O recibo diz "saíram desta tela" e é honesto. Se a resposta permanecer "para lugar nenhum consultável", o produto pede ao operador que confie num sistema que apaga o trabalho dele toda semana — e nenhuma dose de UI conserta isso.
5. **A auditoria é para quem?** Se é para o operador, precisa de frases ("Ana removeu o acesso de Bruno ao Faturamento"). Se é para o suporte, não precisa estar no menu do operador.
