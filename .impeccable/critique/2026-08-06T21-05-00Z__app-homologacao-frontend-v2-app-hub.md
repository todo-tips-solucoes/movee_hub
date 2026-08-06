---
target: painel do hub (app/hub no frontend_v2) — rodada 3
total_score: 30
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-08-06T21-05-00Z
slug: app-homologacao-frontend-v2-app-hub
---
# Rodada 3 — Painel do Hub de Frota (registro pós-fix)

**O que este documento é:** registro da rodada 3 e da sua verificação viva. Diferente das
rodadas 1 e 2, esta rodada **não** partiu de uma crítica dual-agent nova — partiu dos
resíduos já documentados no critique #2 (as heurísticas de nota mais baixa que a rodada 2
não tocou). A releitura de score abaixo é derivada do que mudou e foi **medido**, não de
uma nova varredura de personas.

Escopo decidido com o operador: os 4 itens (A–D), fonte da ajuda no frontend.

## Releitura do Design Health Score — 30/40 (baseline: 26/40)

| # | Heurística | Score | O que mudou nesta rodada |
|---|-----------|-------|--------------------------|
| 1 | Visibilidade do status | 4 | — (mantida) |
| 2 | Sistema ↔ mundo real | 3 (↑ de 2) | Datas: presets removem a digitação do caminho comum e o intervalo é ecoado em pt-BR (`DD/MM/AAAA`) sob os campos. Não vai a 4: o `<input type="date">` continua renderizando no locale do browser — limite do HTML, não do código. |
| 3 | Controle e liberdade | 3 | — (mantida) |
| 4 | Consistência | 4 (↑ de 3) | Os 4 módulos com período passaram a usar UM componente em vez de 4 pares de `<input>` duplicados; o combobox de entidade virou fonte única (admin + auditoria). |
| 5 | Prevenção de erro | 4 (↑ de 3) | Intervalo invertido é acusado na hora com `role="alert"` nomeando problema e recuperação; `min`/`max` cruzados nos dois campos. |
| 6 | Reconhecimento > memória | 3 (↑ de 2) | A auditoria não pede mais ID de entidade decorado: combobox com as entidades do próprio usuário **com nome** (do `/me`), recentes e busca por texto. Não vai a 4: auditoria ainda pede ID de usuário responsável à mão. |
| 7 | Flexibilidade/eficiência | 3 (↑ de 2) | Presets Hoje / 7 dias / 30 dias / Este mês em 4 módulos. Não vai a 4: seguem sem atalhos de teclado e sem "últimos filtros". |
| 8 | Estética/minimalismo | 3 | — (mantida) |
| 9 | Recuperação de erros | 3 | — (mantida) |
| 10 | Ajuda e documentação | 3 (↑ de 1) | Cada card do dashboard diz o que o módulo **faz**; o estado vazio nomeia a entidade e a ação que destrava, em vez de "fale com um administrador". Não vai a 4: segue sem ajuda contextual dentro dos módulos. |
| **Total** | | **30/40** | Trend: 25 → 26 → 30. |

## O que foi entregue

**A) Filtro de período com presets** — `components/hub/period-filter.tsx` +
`lib/hub/periodo.ts` (matemática pura, sem `toISOString()`: em UTC-3 ele adianta o dia).
Aplicado em auditoria, importações, performance e faturamento. O estado do chamador
continua sendo só `de`/`ate` — qual chip acende é **derivado** do par, então sobrevive a
reload sem persistir preset.

**B) Ajuda contextual** — `resolveModuleDescription` em `lib/hub/module-nav.ts`, ao lado do
ícone e da rota. Módulo fora do mapa renderiza como antes, sem buraco. Estado vazio do
dashboard reescrito: nomeia a entidade e a ação, sem inventar um contato que o produto não
conhece.

**C) EntidadeCombobox compartilhado** — extraído de `admin/page.tsx` (onde era privado) para
`components/hub/entidade-combobox.tsx`, e enriquecido com as entidades do `/me` (que já
vinham com nome desde a rodada 2 e ninguém usava como fonte de escolha). Reusado no filtro
da auditoria com opção "Todas as entidades".

**D) `--font-mono`** — deixou de incluir a Plus Jakarta Sans (proporcional). Afeta
`copyable-uuid`, colunas de valor do faturamento e contagens das importações.

## Verificação

- **Unit:** vitest 323/323 (era 307; +13 de `periodo.test.ts`, +3 do dashboard). `tsc` limpo.
- **Build:** `next build` verde, 29 rotas.
- **Detector mecânico:** 0 achados nos 8 arquivos alterados.
- **E2E vivo:** 41/41 no hub-homolog rebuildado, via container oficial
  (`infra/hub/testes/hub-shell-e2e-browser.sh`). 14 dos 41 são o spec novo
  `impeccable-rodada3.spec.ts`, medindo no DOM: presets nos 4 módulos, eco pt-BR,
  intervalo invertido, mobile 390px sem estouro horizontal, descrição em todo card,
  contraste da descrição ≥ 4,5:1 calculado no DOM, combobox na auditoria e no admin,
  e a `font-mono` medida por largura de glifo.

### Dois testes falsamente verdes, corrigidos no caminho

1. O teste de contraste media logo após `goto()`, com o `/me` ainda em voo — lia os
   skeletons e devolvia `null`.
2. O teste da mono assertava sobre `getPropertyValue('--font-mono')`, que devolve `""`:
   o tema é `@theme inline`, resolvido em build pelo Tailwind v4, sem custom property em
   runtime. **Toda asserção sobre essa var passa por vacuidade.** Reescrito para medir a
   utility `font-mono`, que é o que o usuário recebe.

### Falha pré-existente corrigida

`menus-por-papel.spec.ts` fixava `expect(itens.length).toBe(6)`; o PR #85 semeou
`validacao_xml` com permissão de operador e a contagem virou 7. A contagem exata é do
**seed**, não da regra sob teste — trocada por `toBeLessThan(8)`, mesmo idioma do
`toBeGreaterThanOrEqual(8)` da contraprova do admin, que já era robusto a módulo novo.

## Deixado de fora (deliberado)

- `.text-gradient-warm` / `.text-gradient-warm-rich` em `app/globals.css`: o detector as
  aponta, e não têm nenhum uso em `frontend_v2`. **Não cortadas** — são do kit de tokens
  EntreGô documentado em `docs/specs/app-motorista-nfse/`, e a lição registrada nesta base
  é que grep de "0 usos" errou 6 de 6. Corte de CSS morto é `ponytail-audit`, não uma
  mudança de UX embarcada num PR de produção.
- Descrição de módulo no contrato do backend: exigiria migration no hub, que em produção
  vive dentro do `chatmasterveloz` (rito integral de 5 gates). Decisão do operador nesta
  rodada: mapa no frontend.

## Candidatos à rodada 4

1. **h6 (3/4):** auditoria ainda pede "ID do usuário responsável" à mão — o mesmo
   tratamento do combobox de entidade se aplica.
2. **h7 (3/4):** zero atalhos de teclado; nenhum "caminho de ontem" (últimos filtros).
3. **h10 (3/4):** ajuda contextual **dentro** dos módulos, não só no launcher.
4. **h8 (3/4):** `envio_massa` continua um cockpit de 6 zonas; Sheet de usuário mistura 3 domínios.
5. **h4:** os dois modelos de paginação seguem convivendo.
