# Evidência 3.8.6 (parcial) — `npm run test:hub:integration`

Onda-019 (2026-09-27, janela de domingo). Rodados os 14 arquivos da suíte
`npm run test:hub:integration` (`app_homologacao/backend`) **um de cada
vez**, via `node --test tests/<arquivo>.test.js` (nunca o script npm
inteiro), cada um subindo/derrubando seu próprio projeto Docker Compose
`hub-test-<runid>` efêmero. `free -m`/`df -h /` conferidos antes de cada
arquivo — nunca abaixo de 7 GB RAM disponível / 34 GB disco livre.

| Arquivo | Resultado | Duração | pass | fail | skip |
|---|---|---|---|---|---|
| hub-rls-integration.test.js | PASS | 65s | 1 | 0 | 0 |
| hub-auditoria-integration.test.js | PASS | 63s | 1 | 0 | 0 |
| hub-importacoes-integration.test.js | PASS | 72s | 1 | 0 | 0 |
| hub-import-processor-integration.test.js | PASS | 84s | 1 | 0 | 0 |
| hub-motoristas.test.js | PASS | 100s | 1 | 0 | 0 |
| hub-motoristas-credencial.test.js | PASS | 68s | 1 | 0 | 0 |
| hub-faturamento.test.js | PASS | 88s | 1 | 0 | 0 |
| hub-usuarios.test.js | PASS | 72s | 1 | 0 | 0 |
| hub-papeis.test.js | PASS | 69s | 1 | 0 | 0 |
| hub-admin.test.js | PASS | 71s | 1 | 0 | 0 |
| hub-performance.test.js | PASS | 99s | 1 | 0 | 0 |
| hub-motorista-360-integration.test.js | PASS | 11s | 1 | 0 | 0 |
| hub-enriquecimento-automatico-integration.test.js | PASS | 21s | 1 | 0 | 0 |
| hub-avisos.test.js | PASS | 93s | 1 | 0 | 0 |

**14/14 arquivos PASS, 0 fail.** Como nenhum arquivo falhou, a comparação
de baseline via `git worktree` (main) não foi necessária (só se justifica
para classificar falha herdada vs. nova — não houve falha nenhuma).

Pós-execução: `docker ps -a`/`docker images` sem nenhum resíduo
`hub-test-*` (0 containers, 0 imagens); `package-lock.json` de
`app_homologacao/backend` e `app_homologacao/frontend_v2` sem alteração
(`git status --porcelain` vazio para os dois).

**Pendente para fechar 3.8.6 por completo**: `npm run test:e2e:hub`
(`frontend_v2/playwright.config.hub.ts`, suíte hub-shell S3, driver
`infra/hub/testes/hub-shell-e2e-browser.sh`, ~139 casos contra
`hub-homolog`) ainda não rodado nesta onda — orçamento da onda (80
tool_calls) não comportava a suíte de integração backend + esta suíte E2E
inteira no mesmo turno. Rodar numa próxima onda dedicada. Nota: o cenário
F3.12 em si (o citado no parênteses de 3.8.6) já está coberto e verde
desde a tarefa 3.6.4, via os drivers específicos
`hub-motorista-adiantamento-e2e-browser.sh` (50/50) e
`hub-adiantamentos-e2e-browser.sh` (13/13) — não é o mesmo comando que
`npm run test:e2e:hub` (que é a suíte hub-shell, não relacionada a
adiantamentos, mas uma checagem de regressão geral que vale rodar por a
F2 ter alterado `hub-usuarios.js`/a tela de usuários).
