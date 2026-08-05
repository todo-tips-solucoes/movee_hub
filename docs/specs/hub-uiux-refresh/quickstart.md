# Quickstart: hub-uiux-refresh

Cenários manuais/E2E que validam a implementação end-to-end. Feature é
puramente de apresentação (frontend) — **não há borda backend↔frontend
nova ou alterada**, então o cenário "Roundtrip End-to-End" do template não
se aplica (nenhum contrato de API é criado ou modificado por esta feature;
ver `plan.md` §Contratos de API).

## Scenario 1: Colapsar/expandir a sidebar com persistência (US1)

1. Login no hub (`https://localhost:8443/hub/login`, ambiente
   `hub-homolog`) em resolução desktop (`>= lg`).
2. Acionar o controle de colapso na topbar.
3. **Expected**: a sidebar reduz para a versão só-ícones com transição
   suave; o conteúdo principal reflui ocupando o espaço liberado.
4. Passar o foco por teclado (Tab) sobre um item colapsado.
5. **Expected**: tooltip com o nome do módulo aparece, mesmo sem mouse.
6. Recarregar a página (F5).
7. **Expected**: a sidebar permanece colapsada (lida de `localStorage`),
   sem "flash" perceptível de estado expandido antes de colapsar.
8. Reduzir a janela para largura mobile (`< lg`).
9. **Expected**: o comportamento de menu deslizante (Sheet) permanece
   idêntico ao atual — colapso não se aplica no mobile.

## Scenario 2: Alternar tema com persistência e white-label (US2)

1. Entrar em qualquer tela do hub no tema padrão (escuro).
2. Acionar `<ThemeToggle />` na topbar do hub.
3. **Expected**: interface muda para claro instantaneamente, sem reload;
   cores de marca white-label da empresa continuam aplicadas corretamente.
4. Navegar para outra tela ou recarregar.
5. **Expected**: tema claro persiste (chave `theme` já gerenciada pelo
   `next-themes`).
6. Avaliar contraste de texto/elementos em ambos os temas (ex.: DevTools
   ou ferramenta de contraste).
7. **Expected**: atende ao padrão mínimo de contraste (SC-003).

## Scenario 3: Superfícies leves em card + tabela (US3) — Error/Edge Case

1. Abrir uma tela com tabela dentro de um card (ex.: `performance` ou
   `motoristas`).
2. **Expected**: nenhuma combinação de "contorno forte do card + linhas de
   contorno forte da tabela" (FR-013); separação por sombra suave (card) e
   divisor discreto + cabeçalho por fundo (tabela).
3. Repetir em uma tela de cartões sem tabela (ex.: dashboard).
4. **Expected**: cartões se destacam por sombra, não por borda, nos dois
   temas.
5. Ativar "reduzir movimento" no sistema operacional e repetir os
   Scenarios 1/2.
6. **Expected**: transições de colapso/tema são reduzidas ou eliminadas
   (edge case da spec), sem quebrar a mudança de estado em si.

## Scenario 4: Padrões de indicador (KPI) e filtro consistentes (US4)

1. Abrir duas telas com indicadores numéricos (ex.: `dashboard` e
   `performance`).
2. **Expected**: ambas usam o mesmo componente `kpi-card` (rótulo, valor,
   ícone, variação opcional) — mesmo layout visual nas duas.
3. Abrir duas telas de listagem com busca/filtros (ex.: `usuarios` e
   `motoristas`).
4. **Expected**: ambas usam o mesmo componente `filter-bar` — mesma
   posição, mesmo padrão de "limpar filtros".

## Scenario 5: Cobertura completa + validação de papéis restritos (US5)

1. Percorrer cada tela autenticada do hub (dashboard, performance,
   faturamento, motoristas + detalhe, importações + detalhe, usuários,
   auditoria, admin, perfil) com a conta QA padrão
   (`qa.importacoes@moveelog.local`, `admin_entidade`, empresa 9001).
2. **Expected**: todas refletem o refinamento (US1–US4), sem nenhuma
   diferença de dado/comportamento/fluxo em relação a hoje (FR-018/SC-007).
3. Para telas restritas a papéis que essa conta não possui: elevar
   temporariamente o papel da conta via `psql` no `hub_homolog_db` (dentro
   da exceção standing hub-*), validar, e **reverter o papel ao final**
   (decisão do operador — Q3 do clarify).
4. Capturar screenshots antes/depois de cada tela e versioná-los em
   `docs/plans/hub-uiux-refresh/screenshots/` (decisão do operador — Q5).
5. Confirmar que painel legado (`app_homologacao/frontend`,
   `app_homologacao/frontend_v2/app/dashboard/**` fora do hub) e app
   motorista (`app_homologacao/frontend_motorista`) permanecem
   visualmente idênticos (FR-020/SC-008) — nenhum arquivo fora de
   `app/hub/**`, `components/hub/**` e os tokens compartilhados de
   `components/ui/{card,table}.tsx` deve ser tocado.
