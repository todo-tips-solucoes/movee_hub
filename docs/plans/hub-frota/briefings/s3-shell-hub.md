# Briefing S3 — Shell do hub (navegação modular)

**Fase:** S3 · **Branch:** `feat/hub-shell` · **Pré-requisito:** S2 mergeada (auth
`/api/v1`, RBAC, `GET /me` funcionando na homolog isolada).

## Contexto mínimo (autossuficiente)

- Frontend base: `app_homologacao/frontend_v2` — Next.js 16 (App Router), React 19,
  Tailwind v4 (`@theme`), **Base UI** + shadcn, design system **EntreGô 2.0**
  (azul/menta/creme, Plus Jakarta Sans), white-label por tenant via
  `contexts/tenant-theme-context.tsx`, auth por cookie via `contexts/auth-context.tsx` +
  proxy `app/api/[...path]/route.ts` (reusar como estão).
- Backend da S2 fornece: `GET /api/v1/me` → `{usuario, entidades[], entidade_ativa,
  modulos[], permissoes[]}`; `POST /api/v1/me/entidade` troca entidade ativa.
- ⚠️ Ambiente "homologação" do VPSTodo É PRODUÇÃO. Trabalho só no ambiente isolado da S1.
- Referências: plano técnico §13 (interface), §14 (APIs), §15 (S3).

## Objetivo

Transformar o painel em **shell modular**: navegação data-driven por permissão, seleção
de entidade, identificação de ambiente e dashboard inicial.

## Escopo

**Inclui**
1. **`ModuleNav`** (sidebar): módulos vindos de `GET /me` (código, nome, ícone, ordem);
   item só aparece com o módulo habilitado para a entidade E permissão `modulo.view`.
   Responsivo (drawer no mobile — padrão do header responsivo já existente).
2. **`EntitySwitcher`**: evolui o `empresa-selector` existente; multi-vínculo →
   `/selecionar-entidade` no login; troca chama `POST /me/entidade` e recarrega contexto.
3. **`EnvBadge`**: banner fixo + favicon alternativo quando `NEXT_PUBLIC_APP_ENV !=
   production` ("HOMOLOGAÇÃO — dados fictícios").
4. **`PermissionGate`** (helper client): esconde ações sem permissão — decorativo; a
   autoridade é o backend.
5. **Rotas do shell**: `/login` (aponta para `/api/v1/auth`), `/recuperar-senha`,
   `/redefinir-senha`, `/selecionar-entidade`, `/dashboard` (cards por módulo habilitado),
   perfil do usuário (nome/e-mail/troca de senha), logout.
6. Design de todas as telas novas via **/ui-ux-pro-max** sobre o EntreGô 2.0 (dark/light
   e white-label preservados).

**Não inclui:** telas dos módulos (S4–S9); mudanças no backend além de ajustes triviais
de contrato do `/me`; mudanças nas telas atuais do envio em massa (permanecem onde estão
até a S8).

## Ordem

contratos `/me` verificados → ModuleNav+EnvBadge → EntitySwitcher/seleção → telas de auth
(login/recuperação/perfil) → dashboard → E2E → evidências → PR.

## Testes exigidos

- Unit: PermissionGate, mapeamento módulo→rota.
- E2E (homolog isolada): 2 usuários com papéis distintos veem menus diferentes; usuário
  sem `usuarios.manage` não vê /usuarios e recebe 403 do backend se forçar a URL; troca
  de entidade altera os dados exibidos; banner de ambiente visível; axe ≥ 95 nas telas novas.

## Evidências

Prints das navegações por papel; saída E2E; axe report; troca de entidade demonstrada.

## Critérios de aceite

1. Navegação 100% data-driven (nenhum item hardcoded); 2. módulo sem permissão invisível
no menu E bloqueado no backend; 3. banner de ambiente presente em todo o shell na homolog;
4. design system e white-label preservados; 5. PR + DIARIO.md.

## Gotchas

- Comentário `{/* */}` logo após `return (` quebra build turbopack — usar `//` acima.
- `Select` Base UI precisa de `items` no Root para exibir rótulo.
- Breadcrumb deve derivar de NAV_ITEMS (padrão adotado no U-fix do painel).
- Build Next: nunca no VPSTodo; na VPS Hub ou CI.
