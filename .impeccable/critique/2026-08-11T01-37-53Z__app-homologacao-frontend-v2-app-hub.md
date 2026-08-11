---
target: "https://app.moveelog.com.br/hub/* (medido no hub-homolog, mesmo bundle r10)"
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-08-11T01-37-53Z
slug: app-homologacao-frontend-v2-app-hub
---
Method: dual-agent (A: design review isolada, sem detector e sem críticas anteriores · B: detector + Playwright no hub-homolog)

**Alvo substituído, declarado:** `https://app.moveelog.com.br/hub/*` exige credencial de cliente real e é ambiente vivo — não foi acessado. Avaliado o mesmo bundle (`frontend_v2:hub-impeccable-r10-e5dbc9b`) no hub-homolog isolado, mais o código-fonte. **Viés conhecido:** a base de teste está vazia; nenhuma tela foi medida com tabela cheia.

## Design Health Score

| # | Heurística | Nota | Questão-chave |
|---|-----------|-------|-----------|
| 1 | Visibilidade do estado do sistema | 3 | Incerteza é nomeada ("Status indisponível — tentando de novo"), mas dois indicadores ao vivo do mesmo disparo, com vocabulário diferente |
| 2 | Correspondência com o mundo real | 3 | Domínio bem falado; resta prosa sem acento em `xml-validation-card.tsx` ("Ja validada", "Validacao concluida!") |
| 3 | Controle e liberdade | 2 | Desfazer não existe; "Ver as linhas com erro" apaga os filtros montados; "Voltar à lista" descarta filtro e página |
| 4 | Consistência e padrões | 2 | 5 larguras de container, 13 `<select>` nativos vs 2 Base UI, 2 idiomas de painel de filtro |
| 5 | Prevenção de erros | 3 | Excelente no fechamento; buraco simétrico no disparo (P0 abaixo) |
| 6 | Reconhecimento vs. memorização | 3 | Boas âncoras; seleção multipágina invisível e filtros ativos escondidos atrás do accordion |
| 7 | Flexibilidade e eficiência | 2 | Zero ordenação em todas as tabelas, zero atalhos, nenhuma ação em lote além do disparo |
| 8 | Estética e minimalismo | 3 | Tokens coerentes; acúmulo em envio_massa (5 KPIs + 6 ações + 9 filtros + 11 colunas) |
| 9 | Diagnóstico e recuperação | 3 | Erros reais com "Tentar novamente"; falhas de upload/fechamento saem só em toast de 4s |
| 10 | Ajuda e documentação | 2 | O formato da planilha não é documentado em lugar nenhum — sem modelo, sem lista de colunas |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

**Parcialmente ancorado.** A marca vive no detalhe preciso do disparo; a composição do produto ainda é um menu de módulos, não um ciclo de trabalho.

**Avaliação independente (A):** o que só existe porque é este produto — a cadeia de honestidade numérica (`selecionados` → `selecionadosPendentes` → rótulo → confirm → recibo, o mesmo número em quatro lugares), o bloqueio de fechamento durante disparo, o eco do período em pt-BR sob os inputs nativos, o gráfico sem biblioteca com valor em texto. O que qualquer SaaS usaria sem alterar: `/hub/dashboard` é um launcher que repete a sidebar item por item, com um card apontando para a página onde o usuário já está, e zero dado de frota. O ciclo semanal (importar → conferir → disparar → acompanhar nota → fechar) existe na cabeça do operador e em lugar nenhum da interface: 3 links cruzados no hub inteiro.

**Varredura determinística (B):** detector `detect.mjs` sobre `app/hub`, `components/hub` e os 8 compartilhados → **`[]`, exit 0, zero achados**. Consistente com a lição da r5: neste alvo o detector tem poder discriminante zero — ausência de sinal, não evidência de qualidade.

**axe-core completo, 12 rotas × 2 temas = 24 execuções: 22/24 limpas.** Única violação, nos dois temas: `scrollable-region-focusable` (serious, 1 nó, `div[data-slot="table-container"]`) em `/hub/dashboard/usuarios/papeis` — container rolável sem foco por teclado, em `components/ui/table.tsx`.

**Overlays visuais:** não houve injeção. O alvo roda atrás de TLS self-signed no container do Playwright, sem canal de mutação de página nesta sessão; a evidência é a saída de console do spec, não um overlay no browser do usuário.

## Overall Impression

O hub tem uma postura de honestidade rara — recusa sistemática de afirmar o que não sabe — e a implementou onde mais importa: o disparo. Isso não é polimento, é caráter, e a maioria dos produtos nesta categoria não tem.

O que falta não é acabamento; são **duas ausências estruturais**. A primeira: o produto é um menu de módulos, e o ciclo de trabalho que dá sentido a eles não aparece em nenhuma tela. A segunda: nenhuma tabela ordena, o que empurra a etapa de conferência — a tarefa central entre importar e disparar — para fora do produto, para o Excel.

E há um buraco de segurança de UX que sobrevive de rodadas anteriores: a mesma proteção que impede fechar um movimento com dados não carregados **não existe no disparo**, que é a ação que sai do sistema e chega em telefones.

## What's Working

**1. A cadeia de honestidade numérica do disparo.** A diferença entre "o que marquei" e "o que vai sair" é resolvida em todos os quatro pontos onde o operador olha, com o mesmo número. Uma discrepância aqui destruiria a confiança de uma vez — e não há nenhuma.

**2. A recusa de afirmar o que não se sabe, como postura de sistema.** "Status indisponível — tentando de novo" em vez de "Parado"; a tooltip da coluna Falhou admitindo que o motivo não é registrado em vez de inventar causa; o período calculado por min/max porque "mostrar o da primeira linha seria afirmar mais do que se sabe".

**3. Acessibilidade construída no sistema, não colada depois.** `status-badge` garante cor + ícone + texto por construção; `bar-chart` é `<figure>`+`<ul>` legível sem enxergar a barra; os tokens carregam a razão do valor no comentário. Resultado medido: 22 de 24 execuções do axe sem nenhuma violação.

## Priority Issues

### [P0] O disparo não tem a proteção que o fechamento tem — e o confirm afirma números falsos

**O quê.** `dadosIndisponiveis={erro !== null}` chega ao `ActionBar` e ao `CloseMovementDialog`, **nunca ao `ProcessControls` nem ao confirm de disparo** (verificado: `action-bar.tsx:120` repassa só ao diálogo de fechamento). Com um 500 na lista, `use-envio-massa.ts` faz `setData([])`, os 5 KPIs mostram `0 0 0 0 0`, a área da tabela mostra o erro — e o botão Iniciar continua verde. O `AlertDialogAction` tem `disabled={selecionados.length > 0 && selecionadosPendentes === 0}`: **com seleção vazia, está habilitado**, e o confirm diz "Neste momento o movimento tem 0 registros". Confirmar chama `startProcess([])`, que omite o campo, e o backend dispara para o movimento aberto inteiro.

**Por que importa.** É um diálogo de confirmação mentindo sobre o impacto de uma ação irreversível que sai do sistema e chega em telefones de pessoas. O comentário em `close-movement-dialog.tsx` já diz, palavra por palavra, por que isso é inaceitável no fechamento — e a ação do disparo é mais consequente.

**Fix.** Repassar `dadosIndisponiveis` ao `ProcessControls` (`disabled` + `title`); com `erro !== null`, trocar o corpo do confirm pelo texto de indisponibilidade e desabilitar a ação; `stats-cards` renderiza `—` em vez de `0` (zero é uma afirmação, travessão não é).

**Comando:** `/impeccable harden`

### [P1] A correção de alvo da rodada 9 na matriz de papéis é cosmética — e o teste que a validou mediu a coisa errada

**O quê.** A r9 embrulhou cada checkbox num `<span className="inline-flex h-11 w-11 md:h-6 md:w-6">`. **Um `<span>` sem handler não é clicável**: ele cria espaçamento visual, não área tocável. Quem estende a hit-area é o `after:-inset-x-3 after:-inset-y-2` do próprio `Checkbox` (`components/ui/checkbox.tsx`), que sobre `size-4` dá **40×32 px** — abaixo de 44 nas duas dimensões, e bem abaixo na altura. Pior: o E2E que escrevi para provar a correção mediu `(c.parentElement ?? c).getBoundingClientRect()`, ou seja, **mediu o wrapper não-clicável** e passou. O mesmo padrão está no `data-table.tsx` desde a r8.

**Por que importa.** Além do alvo seguir pequeno onde se concede permissão, isto é o erro nº 1 do documento de metodologia desta casa — "a área tocável é o controle ou o `<label>`, nunca um ancestral" — cometido dentro do teste escrito para provar que o defeito tinha sido corrigido. Um teste que valida a aparência da correção é pior que nenhum teste.

**Fix.** Trocar o `<span>` por `<label>` (clicável por natureza, e o Base UI associa) ou estender o `after:` do Checkbox para `-inset-y-3.5` quando o alvo for de matriz. Reescrever a asserção para medir a hit-area real com `elementFromPoint` nos quatro cantos do alvo pretendido, não o retângulo do pai.

**Comando:** `/impeccable audit`

### [P1] Nenhuma tabela do hub ordena — a conferência acontece no Excel

**O quê.** Zero ocorrências de `aria-sort`, `onSort` ou `sortBy` em `app/hub/**` e `components/**`. Sete tabelas, todas de ordem fixa vinda do backend.

**Por que importa.** A tarefa central entre importar e disparar é conferir: achar valores fora da curva, agrupar as falhas, ver quem não mandou nota. Sem ordenação, isso é feito paginando de 100 em 100 ou exportando CSV — o produto terceiriza sua etapa mais importante, e o "Exportar CSV" deixa de ser conveniência e vira dependência.

**Fix.** Ordenação client-side onde o filtro já roda no cliente (`data-table.tsx`: Número, Nome, Valor, Enviado, Data de emissão) — um `useMemo` e um `<th><button aria-sort>`. Nas listas paginadas no servidor, `order` no endpoint para valor e data. Duas colunas resolvem 90%.

**Comando:** `/impeccable shape`

### [P1] O ciclo semanal termina em um toast de 4 segundos e um estado vazio genérico

**O quê.** `closeMovement` descarta a resposta do backend, que devolve `{ fechados: N }` e já grava `movimento_fechado` na auditoria. Depois do toast, o operador que acabou de lacrar 352 lançamentos vê exatamente a mesma tela de quem errou um filtro: "Nenhum registro encontrado — Importe um arquivo XLSX ou ajuste os filtros". Não existe nenhuma tela de movimentos fechados no hub.

**Por que importa.** Pico-fim: o último momento do ciclo é o que fica. Operacionalmente é pior — se o operador for interrompido durante os 4 segundos, não sobra nenhuma evidência na interface de que ele fechou a semana. O dado do desfecho existe e é jogado fora.

**Fix.** Reusar o padrão do `DisparoRecibo` (persistente, dispensável, sem timer): "Movimento de 01/08 a 07/08 fechado · 352 registros lacrados", com link para a auditoria filtrada por `movimento_fechado`. E um empty state pós-fechamento que diga "Importe uma planilha para começar o próximo ciclo", não "ajuste os filtros".

**Comando:** `/impeccable onboard`

### [P2] Cinco larguras de container, dois idiomas de select, dois idiomas de filtro

**O quê.** `max-w-[96rem]` em 6 rotas, `max-w-5xl` em 2, `max-w-4xl` em usuários, `max-w-3xl` em admin e nos dois detalhes, `max-w-lg` em perfil — e `validacao_xml` sem container nenhum. 13 `<select>` nativos contra 2 `Select` do Base UI. `envio_massa` usa o painel de filtros legado (accordion) enquanto as outras usam `FilterBar` (cartão aberto, com contagem no botão).

**Por que importa.** O operador troca de módulo dezenas de vezes por dia. Somado, é a diferença entre "um produto" e "nove telas que compartilham uma sidebar".

**Fix.** Duas larguras, não cinco: tabela larga e formulário/detalhe. Um só idioma de select. Migrar `envio_massa` para `FilterBar`.

**Comando:** `/impeccable polish`

## Persona Red Flags

**Alex (power user, 5×/semana):** cabeçalhos das 11 colunas não clicáveis — exporta CSV e confere no Excel · "Ver as linhas com erro" do recibo apaga os 9 filtros montados, sem desfazer · a seleção multipágina só se manifesta no texto de um botão ("Limpar seleção (40)") · "Exportar CSV" não diz se exporta o filtrado ou o movimento inteiro · "Voltar à lista" (`router.push`) perde filtro e página, 15 vezes ao conferir 15 motoristas · nenhum atalho de teclado.

**Sam (leitor de tela):** a pílula de status é `aria-live="polite"` e muda a cada poll de 13s — **~46 anúncios interrompendo a leitura** num disparo de 10 minutos; o correto é anunciar marcos, não cada tick · três regiões vivas simultâneas (pílula, recibo, entity-switcher) mais os toasts, sem prioridade definida · no card mobile do `data-table`, a explicação da falha existe só como `title=`, que não é anunciado de forma confiável · `xml-validation-card` sem acentos é a única fonte de status daquela tela · o aviso "Modo somente leitura" da matriz de papéis não tem `role` — é a informação mais importante da tela para `admin_entidade` e não é anunciada · **medido:** `scrollable-region-focusable` em papéis, nos dois temas.

**Casey (mobile, distraído):** em 390px a `ActionBar` vira ~3 linhas de botões, e "Fechar movimento" (irreversível) fica no mesmo bloco e no mesmo tamanho que "Exportar CSV" · 3 dos 5 KPI cards aplicam filtro ao toque, sem confirmação e sem desfazer — um toque acidental durante o scroll reescreve o recorte · toasts de 4s são o único feedback de importar, fechar e exportar · o seletor de entidade ocupa a linha inteira e trunca justamente a parte que distingue as entidades.

## Minor Observations

- `perfil/page.tsx` usa `min-h-svh justify-center` dentro do chrome com header sticky — centraliza numa altura de viewport inteira.
- `env-badge.tsx` injeta `<style>` no corpo do componente; um `data-attribute` no `<html>` seria menos frágil.
- O skip link recebe foco atrás do `EnvBadge` (`sticky z-[60]`) quando o banner renderiza — não atinge produção, atinge todo o QA.
- `page-header.tsx` sem `max-w-prose`: o subtítulo de `admin` vira uma linha de ~150 caracteres em telas largas.
- `filters.tsx` abre expandido sempre, com 10 controles — 250px recorrentes para quem raramente filtra.
- `xml-validation-card.tsx` usa `<table>` cru, fora do `components/ui/table.tsx`; nenhuma tabela do hub tem `<caption>`.
- A wordmark EntreGô permanece no header com white-label ativo — pode ser deliberado, mas vale explicitar.
- **Medido:** 0 overflow horizontal em 12/12 rotas a 390px; 0 skeletons presos 3s após load; DCL entre 34 e 70 ms (ambiente local, banco vazio — não é latência de cliente).
- **Densidade medida a 1280px:** mediana de 26 controles por rota; `envio_massa` 41; `usuarios/papeis` **280** — 6,8× a rota seguinte.

## Questions to Consider

1. O `/hub/dashboard` deveria ser um menu ou o **estado do ciclo**? Se mostrasse "Movimento aberto: 01/08 a 07/08 · 352 linhas · 12 falhas · 88 sem nota", os 9 cards ficariam supérfluos — a sidebar já os tem.
2. Por que "Envio em Massa" e "Validação XML" são módulos separados, se são duas etapas do mesmo movimento e não compartilham nem o período?
3. O que acontece com um movimento **depois** de fechado? Hoje ele some. Com um histórico, "Fechar movimento" deixaria de ser precipício e viraria transição.
4. Os checkboxes deveriam existir sem uma segunda ação em lote? Se a seleção só serve ao disparo, talvez o recorte certo seja "disparar para os filtrados" — o filtro já é o recorte mental do operador.
5. A conferência acontece na tela ou no Excel? Hoje, honestamente, no Excel. Se for intencional, o CSV merece ser primeiro-classe; se não, ordenação é obrigatória.
6. Por que a falha de envio não tem motivo? "12 falharam e ninguém sabe por quê" é dívida de produto, não de UI — o n8n devolve algo.
