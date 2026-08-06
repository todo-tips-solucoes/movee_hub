---
target: painel do hub (app/hub no frontend_v2) — pós-fixes
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-06T02-12-36Z
slug: app-homologacao-frontend-v2-app-hub
---
# Critique #2 — Painel do Hub de Frota (pós-harden/clarify/polish, hub-homolog rebuildado)

Method: dual-agent (A: design review em subagente isolado · B: detector + evidência de browser via Playwright no container oficial contra o hub-homolog rebuildado).

## Design Health Score — 26/40 (baseline anterior: 25/40)

| # | Heurística | Score | Issue-chave |
|---|-----------|-------|-------------|
| 1 | Visibilidade do status | 4 (↑ de 3) | Referência: pill aria-live Processando/Parado, skeletons sr-only em todo módulo, polling com estado visível, toast em toda mutação. Evidência de browser: dashboard pós-login mostra 12 skeletons — sem flash de estado vazio. |
| 2 | Sistema ↔ mundo real | 2 | IDs crus ainda vazam: "Empresa #9001" (contrato /me sem nome), "ID do entregador", slug de ação como formato de filtro; datas nativas mm/dd/yyyy em browser EN. |
| 3 | Controle e liberdade | 3 (↑ de 2) | Confirmações nos pontos certos (disparo, cancelar importação, descartar arquivo, desabilitar módulo); falta undo nos toggles de permissão/vínculo. |
| 4 | Consistência | 3 | Kit interno forte; quebra na ilha legada: close-movement-dialog sem acentos, select nativo no wizard, dois modelos de paginação. |
| 5 | Prevenção de erro | 3 | Validação client espelha backend; UUID digitado à mão em motoristas; filtros de ID sem validação. |
| 6 | Reconhecimento > memória | 2 | Admin exige digitar ID da entidade; auditoria pede IDs de memória; correlação auditoria↔usuários é mental. |
| 7 | Flexibilidade/eficiência | 2 | Sem atalhos, sem presets de período, busca sem debounce; positivos: histórico do admin, sidebar colapsável. |
| 8 | Estética/minimalismo | 3 | Módulos novos limpos; envio_massa é um cockpit de 6 zonas; Sheet de usuário mistura 3 domínios. |
| 9 | Recuperação de erros | 3 | 409→link, retry em toda lista; mancha: usePapeisCatalogo engole erro silenciosamente. |
| 10 | Ajuda e documentação | 1 (↓ de 2) | Nenhum help contextual estruturado; placeholders fazem todo o trabalho pedagógico. |
| **Total** | | **26/40** | Trend: 25 → 26. |

## Fixes da rodada anterior — todos verificados no browser real (Assessment B)

1. ✅ **Confirmação do disparo**: clique em "Iniciar" abre `role="alertdialog"` com o texto "Iniciar envio em massa? … Neste momento o movimento tem 2 registros, 0 já com mensagem enviada e 2 ainda sem envio." — números dinâmicos reais; Cancelar funciona. A (não-ancorado) chamou de "o melhor confirm do produto".
2. ✅ **Dashboard sem flash de vazio**: pós-login renderiza 12 skeletons e assenta nos 9 cards de módulo — a corrida do /me não expõe mais o estado vazio.
3. ✅ **"Limpar filtros" com estado**: `disabled: true` no DOM sem filtros aplicados, esmaecido.
4. ✅ Polling de importações com estado visível (citado por A na h1 4/4).

## Scan determinístico

Fonte: **limpa** (0 achados, exit 0). DOM renderizado: dashboard 10 · motoristas 156 · importações 52 · envio_massa 15 — dominado por `ai-color-palette` (~211 = 1 decisão de badge/ícone por linha contada ×N). FPs page-level confirmados: overused-font (fonte é a marca), gradient-text/layout-transition/marquee apontando `body`, cramped-padding em elemento hidden. Sinais a olhar: `nested-cards` 8× no dashboard (card de módulo dentro de card) e `text-occlusion` 8×/2×.

## Issues prioritários (nova rodada)

1. **[P1] Copy do Fechar Movimento (ilha legada)** — `components/close-movement-dialog.tsx`: a ação mais irreversível do fluxo tem a pior escrita do produto ("Voce realmente deseja… nao podera mais ter acesso"), a 10px do melhor confirm do produto. Fix: reescrever em pt-BR correto com resumo quantitativo, mesmo idioma do confirm de disparo. → clarify/harden
2. **[P1] Entidades sem nome** — `entity-switcher.tsx`, usuarios, admin, auditoria: todo o multi-tenant opera sobre números; exige incluir `nome` no contrato GET /me e DTOs (mudança de backend, decisão do operador).
3. **[P2] Busca sem debounce** — usuarios, auditoria, motoristas, importações, faturamento/performance: um fetch por tecla; o padrão DEBOUNCE_MS=300 já existe em entregador-combobox. Fix: hook useDebouncedValue compartilhado. → optimize/polish
4. **[P2] Toggles de permissão/vínculo sem undo** — matriz de papéis persiste célula a célula no clique. Fix: toast com "Desfazer" ou modo rascunho com diff. → harden
5. **[P3] Select nativo no wizard para decisão binária** — trocar por 2 radio-cards com descrição. → polish

## Red flags por persona (resumo)

Power user: datas à mão sem presets, dois idiomas de paginação, busca repintando por tecla, zero atalhos. Recém-convidado: primeira impressão é número de empresa; cards do dashboard sem descrição; "Fale com um administrador" não diz quem. Admin: Sheet com persistência híbrida (vínculo salva no clique, dados no botão); catálogo de papéis falha silenciosamente.

## Observações menores

--font-mono aponta para a própria Jakarta (UUIDs sem mono real); min-h-11 sm:min-h-8 repetido dezenas de vezes (pede variant); rodapé com total só em usuarios; validacao_xml embute card legado sob chrome novo; datas mm/dd/yyyy = locale do browser (produto já tem lang=pt-BR).

## Perguntas a considerar

1. Se a entidade é o eixo do multi-tenant, por que ela ainda não tem nome em nenhum pixel?
2. O disparo mostra o impacto exato antes do clique; por que o Fechar Movimento — mais irreversível — mostra menos que qualquer confirm do produto?
3. Onde está o "caminho de ontem" do operador (últimos filtros, preset "este mês", próxima ação sugerida)?
