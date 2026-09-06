# Briefing — sessão do hub: renovação silenciosa, inatividade de 6 h, vida máxima de 24 h

Prompt para sessão paralela. Leia o `CLAUDE.md` do repositório antes de qualquer
coisa: o ambiente chamado "homologação" É produção, e o ciclo git é cláusula
pétrea (branch → gates com números → `git add` por caminho → commit → PR → merge
→ build da main com tag `<rótulo>-<sha7>` → deploy pelos 5 gates → prova do
bundle servido). Autorização é por etapa.

## O sintoma que originou isto (observado 2026-09-05)

Operador logado no hub (`https://app.moveelog.com.br/hub`) foi **deslogado duas
vezes em ~15 min** com a aba parada entre ações. Login ~17:30 → páginas de
detalhe já caíam em `/hub/login` às ~17:44. Não parece ser "inatividade": parece
o `accessToken` de 15 min vencendo **sem ninguém renová-lo**.

## O que já foi levantado (confirmar no código antes de acreditar)

Backend — `app_homologacao/backend/routes/hub-auth.js`:
- `ACCESS_TOKEN_TTL = '15m'` (l.41–42); `REFRESH_TOKEN_TTL_MS = 7 dias` (l.43, "Decision 9").
- `POST /refresh` existe (l.352) com **rotação** e **detecção de reuso** que
  revoga a família inteira (l.375–385); expiração benigna não revoga (l.400).
- A cada refresh, `expira_em = agora + 7 dias` (l.423) — ou seja, a janela do
  refresh **já é deslizante**; hoje ela é de 7 dias.
- Tabela `SessaoRefresh` (`token_hash`, `usuario_id`, `expira_em`, `revogado_em`).
- `lib/hub-access-token.js`: decodificação pura do JWT (HS256 pinado — manter).
- Cookies: `hub_accessToken` / `hub_refreshToken` (renomeados em 2026-08-04 por
  colisão com o legado — não voltar aos nomes antigos).

Frontend — `app_homologacao/frontend_v2`:
- **Nenhum código do hub chama `/auth/refresh`.** O único arquivo que chama é
  `contexts/auth-context.tsx` — o contexto do painel **legado**, não do hub.
- `contexts/hub-auth-context.tsx` trata 401 limpando a sessão (l.138–160) — é
  o "deslogou".
- O proxy `app/api/[...path]/route.ts` repassa cookies ao backend e **não**
  trata 401 nem tenta refresh.

Hipótese a provar (não assumir): o hub desloga a cada 15 min **independente de
atividade**, porque o access vence e nada o renova. Medir antes de mudar: logar,
usar a tela normalmente por 16 min, e ver se cai. Depois: logar, deixar parado
16 min, e ver se cai. Os dois resultados vão no PR.

## O que o operador quer

1. **Renovação silenciosa**: usar o hub por horas sem ser deslogado.
2. **Expira com 6 horas de inatividade.** "Inatividade" = nenhuma requisição
   autenticada do usuário. ⚠️ Um timer no cliente que renova a cada 14 min
   **derrota** este requisito (aba aberta e esquecida contaria como atividade).
   A renovação tem de ser disparada por requisição real — o desenho natural é
   o proxy (ou o `hubFetch`) reagir ao 401 com `POST /auth/refresh` e repetir a
   requisição uma vez.
3. **Vida máxima de 24 horas desde o login**, mesmo com atividade contínua.
   Hoje não existe esse conceito: a família de refresh desliza para sempre.

Interpretação a confirmar com o operador no início: access continua curto
(15 min) e invisível ao usuário; refresh deslizante de **6 h** (era 7 dias);
teto absoluto de **24 h** contado do login que abriu a família.

## Restrições (constitution §I–III e CLAUDE.md)

- JWT **só** em cookies httpOnly. Nada em localStorage/query/header exposto.
- Escopo multi-tenant resolvido server-side a partir do token — não do corpo.
- Manter `algorithms: ['HS256']` em todo `jwt.verify`.
- Manter a rotação + detecção de reuso do refresh (Decision 9). Cuidado com o
  retry-on-401 no proxy: **duas** requisições concorrentes que recebem 401 ao
  mesmo tempo e ambas chamam `/refresh` com o MESMO refresh token disparam a
  detecção de reuso e revogam a família (deslogam o usuário). Serializar o
  refresh no cliente (uma promessa compartilhada) ou tolerar no backend uma
  janela curta de reapresentação do token recém-rotacionado. Decidir e testar.
- O teto de 24 h provavelmente exige coluna nova em `SessaoRefresh` (ex.:
  `familia_criada_em` ou `expira_absoluto_em`). Migration = próximo `NNNN` em
  `infra/hub/migrations/`, idempotente, nunca editar migration aplicada.
  ⚠️ **Em produção as tabelas do hub vivem DENTRO do `chatmasterveloz`** —
  aplicar migration lá é rito integral (5 gates), registrar em
  `"SchemaMigration"` **sem informar `id`** (a coluna tem sequence), e ordem
  obrigatória: migration → `SIGUSR1` no PostgREST → provar a coluna na API →
  `service update`. Ver `docs/plans/hub-frota/G3-CUTOVER-STATUS-E-RETOMADA.md`
  e as memórias de deploy anteriores (runbooks em `docs/plans/*/RUNBOOK-DEPLOY.md`).
- Não tocar em `infra/robo-entrego/` (o robô EntreGô tem sessão própria com o
  portal externo; é outro assunto, resolvido em 2026-09-05).
- Não tocar no legado (`contexts/auth-context.tsx`, `server.js`) além do
  estritamente necessário — e se tocar, declarar no PR.

## Entregáveis

1. Medição do sintoma (os dois cenários acima), com horários.
2. Backend: refresh deslizante de 6 h + teto absoluto de 24 h + testes em
   `tests/hub-auth-unit.test.js` (renovação dentro da janela; expiração por
   inatividade; recusa após 24 h mesmo com atividade; reuso continua revogando
   a família; requisições concorrentes não derrubam o usuário).
3. Frontend: renovação silenciosa disparada por 401 (proxy ou `hubFetch`),
   sem timer, com uma única chamada de refresh em voo por vez; teste em vitest
   provando que uma tela continua funcionando após o access vencer e que o
   segundo 401 (refresh falhou) leva ao login.
4. Migration (se necessária) + runbook de deploy com rollback anotado.
5. PR com: o que muda, risco, verificação com números, o que ficou de fora.
6. Prova pós-deploy: usar o hub por > 15 min sem cair; deixar parado 16 min e
   não cair; a inatividade de 6 h e o teto de 24 h podem ser provados com TTLs
   reduzidos no `hub-homolog` isolado (`infra/hub/compose.hub.homolog.yml`),
   nunca em produção.

## Gates antes de qualquer commit

`tsc --noEmit` · `npx vitest run` (frontend) · `npm test` (backend, 907+) ·
`next build` · detector impeccable 0 achados no que tocar UI · lint comparado
com a baseline (5 erros pré-existentes: `aparencia/page.tsx` ×3,
`grupo/page.tsx`, `empresa-selector.tsx`) · `package-lock.json` conferido
(o container do Playwright o reescreve).
