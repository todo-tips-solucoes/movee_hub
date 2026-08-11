# Crítica medida do hub — estado pós-rodada 16

**Data:** 2026-08-11 · **Alvo:** `hub-frontend:homolog` buildado de `main@a1f44f7`
(= o que está em produção como `:hub-impeccable-r16-a1f44f7`) · **Placar: 31/40**

## Método, e o que ele não cobre

Medição no Chromium real (390px e 1440px) em 11 rotas do hub, via
`tests/e2e-hub-browser/medicao-r17.spec.ts` (temporário, removido após esta
crítica; o log fica em `evidencias/S3/fase6-browser-run-20260811T203335Z.log`),
mais leitura do código nos pontos que a sonda apontou.

**Viés declarado, e ele importa:** agente único. As críticas de 24/40 e 26/40
foram dual-agent (uma review de código cega + uma medição independente), e o
valor daquele formato foi justamente uma metade discordar da outra. Aqui quem
mede e quem interpreta é o mesmo — a defesa foi verificar cada sinal contra
uma fonte independente antes de aceitá-lo, e **dois dos cinco sinais principais
caíram nessa verificação** (abaixo). A base de teste segue vazia: nenhuma tela
foi medida com tabela cheia, e nenhum disparo real foi observado.

## Sinais que a verificação DERRUBOU

Registrados porque quase viraram trabalho — e porque o modo como erraram é o
mesmo erro da r9, agora invertido.

**1. "265 alvos abaixo de 44px na matriz de papéis."** Falso. A sonda de hoje
mede `getBoundingClientRect()` do controle (ou do `<label>`) e **não enxerga o
pseudo-elemento `after:`**, que é onde vive a área tocável desde a r12. No mesmo
run, `impeccable-rodada12.spec.ts` — que mede a hit-area real com
`elementFromPoint` — passou: 44,9×44,9. A r9 usou uma sonda ingênua e obteve
*aprovação* falsa; hoje a mesma família de sonda produziria *reprovação* falsa.
**Sonda que não conhece o mecanismo da correção erra nos dois sentidos.**

**2. "Informação exclusiva em `title=` em 5 rotas."** Falso. Os 20 casos são os
botões de período (`Hoje`, `7 dias`…) e os cabeçalhos de ordenação: todos têm
texto visível, e o `title` é explicação adicional ("Os últimos 7 dias, incluindo
hoje"). A sonda classificou como exclusivo porque o texto do botão não *contém*
a frase do title. Enriquecimento não é informação escondida.

**3. "Skip link com alvo de 32×16."** Descartado. É `sr-only` até receber foco
(`focus:not-sr-only`) — atalho de teclado, não alvo de toque; 44px não se
aplica. Fica como observação menor: ao ganhar foco ele mede ~36px de altura.

## Design Health Score

| # | Heurística | Nota | O que a medição mostrou |
|---|-----------|------|--------------------------|
| 1 | Visibilidade do estado | 3 | Estados nomeados e honestos ("Status indisponível"), mas **4 regiões `aria-live` simultâneas** em `envio_massa`, sem prioridade, e a pílula anuncia a cada poll (P1 abaixo) |
| 2 | Correspondência com o mundo real | 4 | Domínio bem falado; os acentos do `xml-validation-card` foram corrigidos na r14 e não reapareceram |
| 3 | Controle e liberdade | 3 | r14 pôs filtro/página na URL e deu Desfazer ao recibo; seguem sem volta os 3 KPIs que filtram ao toque e o fechamento de movimento |
| 4 | Consistência e padrões | 2 | **5 larguras de container** (`max-w-5xl`, `max-w-[96rem]`, `max-w-4xl`, `max-w-lg`, e `validacao_xml` sem container próprio) e **12 `<select>` nativos** convivendo com 15 controles Base UI |
| 5 | Prevenção de erros | 4 | Disparo e fechamento agora simétricos (r11); confirmações dizem números verdadeiros |
| 6 | Reconhecimento vs. memorização | 3 | Boas âncoras; seleção multipágina ainda só se manifesta no texto de um botão |
| 7 | Flexibilidade e eficiência | 3 | Ordenação em 3 das 7 listas (r15/r16); faltam usuários, auditoria, faturamento, performance — e nenhum atalho de teclado |
| 8 | Estética e minimalismo | 3 | Mediana de **25 controles/rota**; `envio_massa` 45; **`usuarios/papeis` 280 — 6,2× a rota seguinte** |
| 9 | Diagnóstico e recuperação | 3 | Erros reais com "Tentar novamente"; a falha de envio segue sem motivo, e upload/fechamento saem só em toast de 4s |
| 10 | Ajuda e documentação | 3 | r13 documentou o formato da planilha na própria tela; os demais fluxos seguem sem ajuda |
| **Total** | | **31/40** | **Good** |

Trajetória medida: 25 (r5) → 24 (r7) → 33 (pós-r8, rubrica revisada) → 26
(2026-08-11) → **31**. Os saltos entre rubricas diferentes não são comparáveis
entre si; o par que vale é 26 → 31, mesma rubrica, seis rodadas depois.

## Achados

### [P1] A pílula de status anuncia ~46 vezes num disparo de 10 minutos

**Medido.** `use-process-status.ts:70` faz poll a cada **13000 ms**; o texto da
pílula muda a cada resposta e ela é `role="status" aria-live="polite"`
(`envio_massa/page.tsx:285`). Num disparo de 10 minutos são ~46 anúncios
interrompendo a leitura — e a informação nova entre um e outro costuma ser
"Enviando — 13 de 340" virando "Enviando — 14 de 340".

Na mesma tela há **4 regiões vivas** ao mesmo tempo (banner de ambiente, pílula,
recibo, e a região sr-only do seletor de entidade), nenhuma com prioridade
declarada. Para quem usa leitor de tela, a tela do disparo é a mais ruidosa do
produto justamente quando exige atenção.

**Fix.** Anunciar marcos, não ticks: início, conclusão e falha. Manter a pílula
como texto visual (`role="status"` sem `aria-live`, ou `aria-live="off"` com um
anúncio explícito nas viradas). Já existe o gancho certo — a virada
`isActive: true → false` que o `useProcessStatus` detecta desde a r6.

Este achado **estava na crítica de 26/40 e nenhuma das seis rodadas o tocou.**

### [P2] Cinco larguras de container e dois idiomas de filtro

**Medido.** Larguras: `max-w-[96rem]` (envio_massa, importações, motoristas,
faturamento, performance, auditoria), `max-w-5xl` (dashboard, papéis),
`max-w-4xl` (usuários), `max-w-lg` (perfil), e `validacao_xml` sem container
identificável. Navegar entre listas move a margem lateral sem motivo.

Nem toda diferença é defeito: `perfil` é formulário e ser estreito é correto. O
defeito é **as listas discordarem entre si** — papéis a `5xl` e motoristas a
`96rem` são a mesma classe de tela.

Idiomas de controle: 12 `<select>` nativos (`filters.tsx`, auditoria,
motoristas, importações, faturamento, performance, `import-wizard`,
`xml-validation-card`) contra 15 controles Base UI. O nativo tem estilo do
sistema operacional e ignora o design system.

### [P2] `usuarios/papeis` concentra 280 controles

**Medido.** 280 controles visíveis a 1440px, contra mediana de 25 e 45 na
segunda colocada. São 34 permissões × 4 papéis + a matriz de cabeçalhos. A r10
melhorou os rótulos e a r12 os alvos, mas a densidade em si nunca foi
enfrentada — a tela continua pedindo que se leia uma grade de 132 caixas para
responder "o operador pode fechar movimento?".

## O que já estava na fila e segue aberto

- **Recibo de fechamento** (P1 da crítica anterior): o ciclo semanal termina em
  toast de 4s. É o irmão do recibo de disparo que a r6 entregou.
- **Ordenação nas 4 listas restantes**: o helper da r16 serve; falta allowlist e
  testes por rota.
- **Mobile**: `ActionBar` em ~3 linhas a 390px, com "Fechar movimento"
  (irreversível) do mesmo tamanho que "Exportar CSV".
- **Menores**: nenhuma das 3 tabelas tem `<caption>`; `filters.tsx` abre sempre
  expandido com 10 controles; `perfil` centraliza em viewport inteira dentro do
  chrome sticky.

## Sem regressão

`overflow-x = 0` em 11/11 rotas nos dois viewports (a correção da r4 segue de
pé); 1 `<h1>` por rota em 11/11; a suíte E2E completa passou 122/122 no mesmo
run, incluindo os casos das r11–r16.

## Perguntas de produto (do operador, não minhas)

Repetidas da crítica anterior porque continuam sem resposta e mudam o que vale
construir: por que a falha de envio não tem motivo (o n8n devolve algo); o que
acontece com um movimento depois de fechado (hoje ele some); se a conferência é
no Excel de propósito; e se `/hub/dashboard` deveria ser o estado do ciclo em
vez de um menu que a sidebar já tem.
