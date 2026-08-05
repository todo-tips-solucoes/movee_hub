# Screenshots antes/depois — hub-uiux-refresh (task 7.1)

Evidência visual da spec Clarifications Q5. Metodologia (Decisão dec-047,
`.claude/feature-00c-state/hub-uiux-refresh/state.json`):

- **"Depois"**: capturado direto contra o hub-homolog (branch atual já
  rebuildado, https://hub-homolog.todo-tips.com:8443), via Playwright
  (`mcr.microsoft.com/playwright`), fullPage, ambos os temas (dark
  default + light via toggle).
- **"Antes"**: nesta branch nenhum commit havia sido feito ainda (todo o
  trabalho está uncommitted) — logo `git HEAD` (`e78141a`, tip da `main`)
  **já é** o estado pré-migração. Extraído via `git archive HEAD --
  app_homologacao/frontend_v2`, rodado num container `node:20-alpine`
  efêmero (`npm install && next build && next start`, sem rebuild da
  imagem docker de produção/hub-homolog), roteado por 1 entrada temporária
  no traefik do hub-homolog (revertida logo após a captura) para preservar
  cookies `Secure` via TLS self-signed já existente. Credencial QA
  persistente (`qa.importacoes@moveelog.local`), sem seed/cleanup efêmero.
  Toda a infra temporária (container, router traefik, elevação pontual de
  papel p/ capturar admin/auditoria) foi desfeita ao final.

## Telas com par antes/depois (9)

Afetadas pelo refresh — `layout.tsx`/`module-nav.tsx` compartilhados
(sidebar colapsável + topbar com theme toggle) e/ou `page.tsx` próprio
migrado para `kpi-card`/`filter-bar`:

`dashboard`, `perfil`, `admin`, `auditoria`, `performance`, `faturamento`,
`motoristas`, `importacoes`, `usuarios`. "Antes" só tem `dark` (o toggle de
tema não existia na topbar do hub antes desta feature — evidência em si).

## Telas sem alteração visual (não capturadas em par)

`git diff HEAD` (working tree vs. `e78141a`) está **vazio** para estes
arquivos — confirmando que não fazem parte do escopo desta feature:
`/hub/login`, `/hub/recuperar-senha`, `/hub/redefinir-senha`,
`/selecionar-entidade` (usam `app/hub/layout.tsx`, não o
`app/hub/dashboard/layout.tsx` migrado). Câmera "depois" já existe para
white-label; as demais ficam documentadas aqui via o próprio diff (zero
mudança == zero necessidade de comparação visual).
