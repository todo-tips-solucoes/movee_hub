---
target: painel do hub (app/hub no frontend_v2) — rodada 5, crítica medida
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-07T02-00-07Z
slug: app-homologacao-frontend-v2-app-hub
---
# Critique #3 (rodada 5) — Painel do Hub de Frota

Method: dual-agent (A: design review isolado, não-ancorado · B: detector + evidência medida no DOM do hub-homolog)

Primeira crítica **medida** desde o critique #2 (2026-08-06). As rodadas 3 e 4 derivaram score a partir do que mudaram; esta partiu do zero, sem que A visse críticas anteriores nem saída de detector.

## Design Health Score — 25/40

| # | Heurística | Nota | Questão-chave |
|---|-----------|-------|---------------|
| 1 | Visibilidade do estado | 3 | Polling de importações é exemplar e admite quando para; mas o **disparo em massa** só mostra "Processando", sem contador nem progresso — é a ação de maior consequência com o feedback mais pobre. |
| 2 | Sistema ↔ mundo real | 2 | Slug cru na auditoria (`usuario_vinculo_desativado`), pessoa como `#12`, **uuid de 36 caracteres digitado à mão** no cadastro de motorista; e (medido) `"Erro 500. Tente novamente."` nas 4 listas + `document.title` idêntico nas 6 rotas, nomeando o produto legado. |
| 3 | Controle e liberdade | 3 | Desfazer real em vínculos, confirmação de descarte no wizard. Mas **nenhuma tela sincroniza filtro com URL**: Voltar não restaura nada e nenhum recorte é compartilhável. |
| 4 | Consistência | 2 | Dois idiomas de cartão de filtro, 8 `<select>` nativos × Base UI, 4 larguras de container sem regra, 2 telas sem container; pt-BR acentuado do hub × sem acento do legado **na mesma página**. Medido: `h-8` (32px) × `min-h-11` (44px) para controles equivalentes. |
| 5 | Prevenção de erro | 3 | Bloqueia combinação que o backend recusaria (faturamento). Mas **"Fechar movimento" segue clicável durante o disparo ativo**. |
| 6 | Reconhecimento > memória | 3 | Investimento sério em comboboxes e presets (rodadas 3–4). Sobrou recall pesado: "Turno (período)" e "Categoria" são texto livre com igualdade exata no backend. |
| 7 | Flexibilidade/eficiência | 1 | **Zero atalhos de teclado** em todo o app. **Zero ordenação de coluna** nas 6 tabelas. `PAGE_SIZE=20` fixo. Nenhuma ação em lote. Medido: primeiro controle do conteúdo é o **15º tab stop**, sem skip link. |
| 8 | Estética/minimalismo | 2 | `envio_massa` empilha 5 KPIs + 6 ações + 9 filtros expandidos + 11 colunas antes do primeiro dado; `performance` renderiza 13 colunas. |
| 9 | Recuperação de erro | 3 | Padrão forte: erro tipado → `role="alert"` → "Tentar novamente"; 409 linka a importação original. Mancha: falha de **envio** é um X vermelho mudo, sem motivo e sem rota de diagnóstico. |
| 10 | Ajuda e documentação | 3 | Descrições de módulo, persistência declarada no Sheet, empty state que nomeia a ação. Sem ajuda global nem onboarding. |
| **Total** | | **25/40** | Aceitável — melhorias significativas antes de o operador estar satisfeito. |

## Veredito de especificidade

**A copy é deste produto; a composição e a linguagem visual não são.**

Genuinamente ancorado: o eco de data em pt-BR (nasceu de um problema real de operador brasileiro), "data de competência (não a data de importação)", o relógio de `aguardandoLock` que distingue fila de espera, o badge "Agregados/bônus", e as descrições de módulo escritas como verbo do operador.

Intercambiável: **a composição nunca muda de forma por módulo**. Fechar pagamento, analisar performance, investigar auditoria e monitorar importação são quatro trabalhos cognitivamente distintos com o mesmo esqueleto literal (`PageHeader` → KPIs → filtros → tabela → paginação). E **a marca só existe deslogada**: `font-display`, `glass`, orbs e o gradiente assinatura vivem em `/hub/login`; dentro da sessão é shadcn neutro com tokens trocados. `--font-sans`, `--font-display` e `--font-heading` apontam todos para a mesma fonte — `font-heading` é sinônimo de nada.

**Scan determinístico: 46 arquivos de markup do hub → zero achados, exit 0.** Validado com controle positivo (o mesmo binário retorna 2 achados em `globals.css`), sem regras suprimidas, e reconfirmado com `--no-config` e em modo texto. É resultado real — e significa que o detector tem **poder discriminante zero** aqui: suas regras são regex sobre markup, não alcançam contraste efetivo, geometria nem ordem de foco. Todo o sinal veio da medição.

Sem overlays visuais: o Chrome MCP não opera contra o cert self-signed do hub-homolog, então não há aba com sobreposição para inspecionar — as medidas vieram do Playwright no container oficial.

## Impressão geral

O produto tem **excelente linguagem e péssima economia de tempo**. As rodadas anteriores investiram em copy, reconhecimento e estados — e isso aparece: os três estados existem em todas as listas, o foco é visível em 30/30 elementos, o contraste do texto secundário passa AA nos dois temas, não há rolagem horizontal em nenhuma rota. Nada disso é pouco.

Mas o operador que passa 7 horas por dia aqui não tem um único atalho, não consegue ordenar uma coluna, não consegue salvar um recorte de filtros, perde tudo ao apertar Voltar, e atravessa 14 paradas de teclado antes de chegar ao conteúdo — em toda página. A maior oportunidade não é estética: é **devolver tempo ao operador**.

E há um buraco de confiança no meio do fluxo mais caro: o disparo notifica motoristas reais sem mostrar progresso, o fim do ciclo é um toast que some, e uma falha de envio é um X vermelho sem motivo.

## O que está funcionando

1. **Confirmações que dizem o tamanho do dano.** "Neste momento o movimento tem 340 registros, 12 já com mensagem enviada e 328 ainda sem envio." Substitui a pergunta retórica que todo mundo confirma no automático por informação que o operador não tinha — muda a decisão em vez de registrar consentimento.
2. **Degradação honesta e sistemática.** Combobox de entregador vira input numérico quando a busca cai (e a degradação é sticky pela sessão); combobox de usuário se apresenta como campo de ID para quem não tem permissão; filtro de área cai para "Todas". O hub trabalha sobre integrações que caem, e a alternativa usual — spinner eterno — pararia a operação.
3. **`status-badge.tsx`: cor, ícone e texto, sempre, num lugar só.** Garante estruturalmente que nenhum estado dependa só de cor, com fallback para status desconhecido. A regra vive no componente, não na disciplina de quem escreve a próxima tela.

## Issues prioritários

### [P1] "Fechar movimento" tem 1,54:1 de contraste — a ação irreversível é a menos visível da tela
`close-movement-dialog.tsx:46` usa `text-warm-2` (`#2ceabc`) num botão `variant="outline"`. **Verificado por cálculo: 1,54:1 sobre card branco e 1,39:1 sobre o fundo bege da página** — contra 4,5:1 exigido para texto e 3:1 para componente. É a única ocorrência de `warm-*` em todo o código de componentes. No mesmo fluxo, `bg-success` com texto branco dá **3,50:1**, que falha AA para texto normal.

**Por que importa:** o compromisso declarado é WCAG 2.1 AA, e o item que falha é a ação permanente que trava o ciclo de pagamento. Pior que o contraste é a hierarquia: renderizada como `outline` igual ao "Download XML" ao lado, a ação irreversível lê-se como a menos importante das seis.

**Fix:** remover `text-warm-2 hover:text-warm-3` (a marca não pertence a esta ação); promover a um tratamento próprio de zona de encerramento (`border-destructive/50 text-destructive`, idioma que `process-controls.tsx:45` já usa), separado por `Separator`. Escurecer `--success` no tema claro até ≥4,5:1 corrige os dois pontos de uma vez. → `/impeccable harden`

### [P1] Disparo em massa sem progresso e sem recibo
O disparo mostra um toast e depois uma pílula que alterna "Processando"/"Parado". Sem contador, sem "X de Y", sem estimativa, sem resumo ao terminar. O ciclo de pagamento de prestadores encerra num toast de 4 segundos. E **"Fechar movimento" continua clicável durante o disparo ativo** — dá para lacrar o movimento no meio do envio.

**Por que importa:** é a ação que notifica pessoas de fora do sistema e leva minutos. O operador não sabe se está andando ou travado; se fecha a aba, não há como saber depois o que aconteceu. Pela regra do pico-fim, o fim do trabalho da semana é um toast que some.

**Fix, em ordem de retorno:** (1) passar `isActive` ao `CloseMovementDialog` e desabilitá-lo durante o disparo, com motivo no `title`; (2) a pílula passa a exibir `{msgEnviada} de {total} enviadas` — os dois números **já existem** no `stats`, sem chamada nova; (3) ao terminar, abrir resumo persistente (não toast) com enviadas/erro/pendentes e link para filtrar os com erro. → `/impeccable harden`

### [P1] Falha de envio sem motivo visível
`data-table.tsx:180-186` renderiza a coluna "Erro" como um `<X>` vermelho isolado — sem `aria-label`, sem `title`, sem tooltip, sem texto. A coluna "Enviado" é um `<Check>` igualmente mudo. O `erro_validacao`, duas linhas abaixo, **tem** tooltip.

**Por que importa:** é o único ponto onde o operador descobre que um prestador não foi notificado. Ele vê um X e não sabe se foi número inválido, WhatsApp fora do ar ou dado faltando — e não tem onde clicar. Para leitor de tela a informação não existe.

**Fix:** reusar o padrão que já existe duas linhas abaixo — `Tooltip` com o motivo real, trigger focável, `aria-label`. Se o backend ainda não devolve o motivo, expor o timestamp da tentativa e "Reenviar este registro". → `/impeccable clarify`

### [P2] Checkboxes de seleção que não fazem nada
**Verificado:** `selectedIds` percorre hook → página → `DataTable` e é consumido **apenas** para desenhar o próprio estado marcado. Nenhuma ação da barra consulta a seleção; nenhuma rota recebe IDs.

**Por que importa:** é uma affordance que mente sobre o escopo da ação mais perigosa do produto. O padrão universal é "selecione, depois aja". Um operador que marca 12 linhas e clica em "Iniciar" tem razão para crer que disparou para 12 pessoas — e disparou para o movimento inteiro.

**Fix:** ou remover as duas colunas (honesto hoje, diff mínimo), ou dar-lhes destino com barra contextual "Disparar para os N selecionados". O que não pode continuar é a terceira opção. → `/impeccable distill` ou `/impeccable shape`

### [P2] Sem estado na URL, sem ordenação, sem atalhos: o custo diário do power user
Nenhuma tela sincroniza filtro com URL; nenhuma das 6 tabelas ordena por coluna; `PAGE_SIZE=20` fixo; zero atalhos de teclado; **sem skip link, com o primeiro controle do conteúdo no 15º tab stop** (medido nas 6 rotas).

**Por que importa:** o operador monta 6 filtros, abre um detalhe, volta — e recomeça. Não compartilha recorte com o colega. Fecha 2.000 lançamentos a 20 por página. Quem navega por teclado paga 14 paradas de chrome em cada troca de tela.

**Fix:** skip link no layout (1 elemento, resolve as 6 rotas); `useSearchParams` como fonte dos filtros em uma tela-piloto; ordenação nas colunas numéricas de faturamento e performance. → `/impeccable adapt` e `/impeccable polish`

## Red flags por persona

**Alex (power user):** zero atalhos; zero ordenação; `PAGE_SIZE` travado; "Turno (período)" e "Categoria" são texto livre com igualdade exata (precisa decorar `ALMOCO 11H30-15H29`); o `<datalist>` da auditoria **exclui deliberadamente** as ações com ponto porque o backend as rejeita — quem sabe que existem digita e leva 400.

**Sam (acessibilidade):** sem skip link, ~14 tabs por página; 1,54:1 no botão que fecha o ciclo; "Enviado"/"Erro" comunicados só por ícone colorido sem rótulo; erro de validação no card mobile vive num `title=` HTML, inalcançável por toque; linhas de tabela clicáveis sem `tabIndex`/`onKeyDown`; toasts efêmeros como único registro de operações irreversíveis. **Do lado bom, medido:** foco visível em 30/30 elementos, landmarks corretos nas 6 rotas, h1 único sem saltos de nível, e contraste do texto secundário passando AA nos dois temas.

**Operador de logística (persona do projeto):** não consegue responder "quantos motoristas foram notificados hoje?"; "Fechar movimento" habilitado durante o disparo; os KPIs contam o movimento inteiro enquanto a tabela abaixo mostra o filtrado, sem dizer qual número responde a quê; precisa **digitar um uuid de 36 caracteres** para cadastrar motorista fora de importação — um caractere errado passa na validação de formato e só aparece no fechamento seguinte; a tela de fechamento mostra "Total geral" e "Entregadores distintos", mas nunca "quanto falta pagar" ou "quantos lançamentos estão sem entregador".

## Observações menores

- `document.title` é `"EntreGô — Envio em Massa"` idêntico nas 6 rotas — nomeia o produto legado dentro do hub e quebra distinção de abas, histórico e anúncio de mudança de página.
- `"Erro 500. Tente novamente."` é a mensagem das 4 listas: única superfície do hub que ainda fala em código HTTP.
- Alvos de 32px (toggle de tema 32×32, entity switcher 358×32, chips de período) — **passam** o AA aplicável (WCAG 2.2 SC 2.5.8, 24×24) e falham só o AAA de 44×44; a inconsistência real é interna (`h-8` × `min-h-11` para controles equivalentes).
- Animação em cascata dos stat cards não respeita `prefers-reduced-motion`, enquanto a página que a envolve respeita.
- `usuarios/page.tsx:541` e `admin/page.tsx:207` expõem `#9001` cru embora o nome da entidade esteja carregado ali.
- Detalhe do evento de auditoria despeja `JSON.stringify` num `<pre>` — dump de log, não interface, para quem lê sob pressão.
- `empty-state.tsx` usa `role="status"` em contêiner estático: anuncia em toda montagem.
- `motoristas/page.tsx:396` usa `<a href="#">` com `aria-disabled` — continua focável e navegável.

## Onde A e B divergiram, e o que a verificação corrigiu

- **A errou uma referência:** afirmou que `ActionBar` "não recebe `isActive`". Recebe (declara, desestrutura e repassa ao `ProcessControls`). O defeito real é outro e mais estreito: é o `CloseMovementDialog` que não recebe `isActive` e por isso segue clicável durante o disparo. A conclusão sobrevive; a localização estava errada.
- **B não cobriu o pior caso de contraste:** mediu `text-muted-foreground` nas 6 rotas do hub nativo (tudo passa AA, pior caso 4,91:1 no tema claro), mas não visitou `envio_massa`, onde está o 1,54:1. Confirmei por cálculo direto sobre os tokens. Sem a A, a conclusão teria sido "contraste está bem".
- **O detector concordou com nada:** zero achados no markup do hub. Não contradiz A nem B — apenas não alcança o tipo de defeito que ambas encontraram.
- **B derrubou um alarme falso antes que virasse issue:** os alvos de 32px passam o AA aplicável; tratá-los como falha de conformidade teria sido incorreto.
