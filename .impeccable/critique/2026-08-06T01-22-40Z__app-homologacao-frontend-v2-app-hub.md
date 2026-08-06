---
target: painel do hub (app/hub no frontend_v2)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-06T01-22-40Z
slug: app-homologacao-frontend-v2-app-hub
---
# Critique — Painel do Hub de Frota (app_homologacao/frontend_v2/app/hub)

Method: dual-agent (A: design review em subagente isolado · B: detector + evidência de browser em subagente isolado). Evidência visual obtida via Playwright (container oficial do projeto) contra o hub-homolog isolado; o Chrome MCP não anexou ao interstitial do certificado self-signed.

## Design Health Score — 25/40 (todas as 10 heurísticas aplicáveis)

| # | Heurística | Score | Issue-chave |
|---|-----------|-------|-------------|
| 1 | Visibilidade do status | 3 | Skeletons estáveis + aria-live fortes; mas importações em `processing` não se auto-atualizam (F5 manual), e o dashboard chegou a renderizar "Nenhum módulo disponível" numa carga em que a sidebar listava 9 módulos (corrida no fetch). |
| 2 | Sistema ↔ mundo real | 2 | `EntitySwitcher` exibe "Empresa #9001 — admin_entidade"; auditoria pede códigos crus (`usuario_criado`); inputs de data renderizam mm/dd/yyyy (locale EN) num produto pt-BR. |
| 3 | Controle e liberdade | 2 | Filtros/página só em state local — voltar do detalhe ou F5 perde tudo (sem sync de URL). |
| 4 | Consistência e padrões | 3 | Primitivas compartilhadas disciplinadas; lacunas: `<select>` nativo vs Base UI Select, drill-down divergente (importações→página, motoristas→modal), copy legada sem acentos no envio_massa. |
| 5 | Prevenção de erros | 3 | Validação client espelha o backend; o buraco é o disparo em massa sem confirmação. |
| 6 | Reconhecimento > memorização | 2 | Filtros por ID numérico digitado (auditoria, faturamento, importações) enquanto `EntregadorCombobox` (busca por nome) já existe e não é reusado. |
| 7 | Flexibilidade e eficiência | 2 | Sem ordenação por coluna, paginação só Anterior/Próxima, page size fixo 20, sem visões salvas. |
| 8 | Estética e minimalismo | 3 | Hierarquia limpa; links/badges cian no dark repetidos ~150x na tabela (1 decisão de cor contada N vezes pelo detector). |
| 9 | Recuperação de erros | 3 | "Tentar novamente" em todo fetch, mensagens reais do backend, foco no campo inválido, 409→link à original. |
| 10 | Ajuda e documentação | 2 | Dicas contextuais boas; zero ajuda estruturada/onboarding. |
| **Total** | | **25/40** | **Bom com lacunas claras — meio da banda real (20–32)** |

## Veredito de especificidade

**Autoral na moldura, intercambiável no miolo.**

- **Autoral**: tokens de identidade reais (`app/globals.css`: creme `#f9f2e8`, navy `#0f1849`, gradiente frio azul→menta, Plus Jakarta Sans, radius 0.875rem); auth com aurora-orbs + card glass (`auth-shell.tsx`) inconfundível; sidebar/chrome com decisões próprias.
- **Intercambiável**: módulos internos são shadcn canônico (FilterBar de `<select>` nativos, Table default, KpiCard padrão de mercado) — qualquer back-office rodaria trocando strings. A copy de domínio (movimento, subpraça, "aguardando lock") é o que os ancora ao produto.
- **White-label pela metade**: só `--primary`/`--accent` sobrepõem em runtime; `Wordmark` com `alt="EntreGô"` hardcoded, gradiente e orbs permanecem EntreGô para todo tenant.

**Scan determinístico**: fonte limpa — 0 achados em `app/hub` + `components/hub`. No DOM renderizado (injeção via Playwright no hub-homolog): dashboard 10 · motoristas 156 · importações 52 · wizard 53 — dominado por `ai-color-palette` ("cyan neon on dark", ~150x = os links "Detalhes" por linha), mais `nested-cards` (8x no dashboard), `text-overflow` (span truncado do header estoura 42px), advisories de fonte única e `gradient-text`. Falsos positivos identificados: `marquee` (inexistente no fonte e no build) e `cramped-padding` em elemento `hidden`; re-scan +3 = auto-detecção do overlay do próprio detector.

**Overlays visuais**: não visíveis no browser do usuário (Chrome não anexa ao interstitial do cert); screenshots das 5 telas entregues como evidência.

## Impressão geral

Um painel Operate maduro na infraestrutura de estados (skeleton/empty/erro industrializados) e acima da média em acessibilidade, com identidade forte no chrome e no auth — mas que fica genérico nos módulos, fala linguagem de máquina nos pontos de orientação (entidade, filtros por ID) e, criticamente, dá menos fricção à ação de maior raio de dano do produto (disparo em massa) do que a descartar um arquivo no wizard. A maior oportunidade: fechar o ciclo de feedback do fluxo central (upload → processamento → validação) sem F5.

## O que funciona

1. **Tríade de estados industrializada** — toda lista tem skeleton de shape estável, empty state com ação real e erro com "Tentar novamente", na mesma gramática nas 7 listas.
2. **Acessibilidade acima da média** — 306 ocorrências aria/role/focus-visible, correção documentada de contraste na navegação, badges sempre cor+ícone+texto, alvos `min-h-11`.
3. **Edge cases do import desenhados de verdade** — 409 → link à importação original, pending vs "aguardando lock" com tooltip, validação client espelhando o contrato.

## Issues prioritários

1. **[P1] Disparo em massa sem confirmação** — `components/process-controls.tsx` via `envio_massa/page.tsx`. Ação de maior raio de dano (notifica motoristas reais) com menos fricção que descartar arquivo. **Fix**: AlertDialog com resumo de impacto (N registros elegíveis, movimento alvo) antes de `startProcess`. **Comando**: /impeccable harden
2. **[P1] Importação em processamento sem atualização automática** — `useImportacoesHistorico` só refaz fetch em filtro/página; o operador acompanha o passo central por F5. **Fix**: polling enquanto houver item pending/validating/processing + timestamp da última carga. **Comando**: /impeccable harden
3. **[P2] Dashboard pode renderizar vazio por corrida** — evidência de browser: home exibiu "Nenhum módulo disponível para sua conta" enquanto a sidebar listava 9 módulos para a mesma conta. Empty state incorreto no primeiro contato pós-login. **Fix**: distinguir loading de vazio no fetch de módulos; nunca mostrar empty antes de resposta definitiva. **Comando**: /impeccable harden
4. **[P2] Orientação em linguagem de máquina** — "Empresa #9001 — admin_entidade" no EntitySwitcher (o que o usuário lê o dia todo para saber onde está); filtros exigem ID numérico digitado enquanto `EntregadorCombobox` existe pronto no repo; datas en-US. **Fix**: nome amigável no `/me` + papéis humanizados; reusar combobox nos filtros; select de ações conhecidas na auditoria; `lang`/locale pt-BR nos inputs de data. **Comando**: /impeccable clarify
5. **[P3] Duas línguas no mesmo produto** — o módulo envio_massa (o mais usado) reusa componentes legados com copy sem acentos ("Voce", "nao podera"), motion próprio e drill-down divergente entre módulos irmãos. **Fix**: passada de copy nos 3 diálogos legados + um idioma único de drill-down. **Comando**: /impeccable clarify

## Red flags por persona

**Power user (opera o dia todo)**: perde filtros ao navegar ao detalhe e voltar; nenhuma tabela ordena por coluna; performance com 13 colunas sem `overflow-x-auto` no padrão (risco em notebook 1366px); auditoria exige transcrever IDs de outras telas.

**Recém-convidado com papel restrito**: ações sem permissão desaparecem em vez de aparecer desabilitadas com explicação (ImportWizard retorna `null`; coluna Ações vira "-") — nunca descobre que a função existe; cards mobile sem permissão viram `<Link href="#">` ainda clicável.

**Admin de entidade**: matriz de papéis aplica toggle imediato, global ao papel, sem dizer quantos usuários afeta; tela de admin pede ID numérico da entidade digitado (mitigado por histórico local).

## Observações menores

- Toggle de senha com `tabIndex={-1}` (`login/page.tsx:167`) — fora do fluxo de teclado.
- "Limpar filtros" sempre ativo, sem contagem de filtros aplicados.
- `BarChart` sem alternativa tabular (valores só visuais + `title`).
- Tema default é dark enquanto a identidade assinatura é o creme do light — a primeira impressão não é a da marca.
- `KpiCard` com `text-emerald-600` hardcoded em vez do token `--success`.
- Dashboard home duplica a sidebar (cards de navegação) — nenhum KPI/atenção do dia.
- `text-overflow` real no span truncado do header (estoura 42px, achado do detector no DOM).

## Perguntas a considerar

1. Se o hub é o futuro que absorve o legado, por que o módulo mais crítico (envio em massa) é o único que fala outra língua — visual, copy e motion — justamente na hora do risco?
2. O que o operador precisa ver às 8h? A home responde "quais módulos existem", não "o que precisa da sua atenção" (importação falhada, movimento aberto há N dias, validações pendentes).
3. White-label é compromisso ou cosmético? Cores sobrepõem, mas logo, gradiente e orbs do login continuam EntreGô para todo tenant.
