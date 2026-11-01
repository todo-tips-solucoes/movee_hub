# Virada de 08/11 — login do app pelo hub com UMA chave, e as dívidas que vêm antes

Continuação da frente [`BRIEFING.md`](BRIEFING.md) (PR #308, no ar desde 2026-11-01). Decisões do
operador em 2026-11-01, não reabrir:

1. A chave da virada faz **só uma coisa**: o login do app motorista passa a autenticar pela
   `ContaMotorista` (hub). O painel legado segue acessível; só deixa de ser usado.
2. A chave é a variável de ambiente que já existe, `HUB_MOTORISTA_LOGIN_CONTA_ATIVA`
   (`lib/hub-motorista-app-login.js`; liga só com o valor exato `true`). Virada =
   `docker service update --env-add HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true`; reversão = `--env-rm`.
3. Entram agora, antes da virada: **refresh relê o banco**, **checagem de prontidão**,
   **staging igual à produção**. A aposentadoria da tabela `Motorista` (e do gatilho G4) fica
   para depois de 08/11.

Estado medido em 2026-11-01: o login pela conta já tem `DUMMY_HASH` e recusa conta inativa;
diagnóstico de produção com zero divergência de senha/ativo entre `Motorista` e `ContaMotorista`.

## Decisões de implementação (agente, antes da execução)

### D1 — `POST /motorista/token/refresh` relê o banco (`routes/motorista.js`)
- Hoje só verifica o JWT e reemite o access token: motorista desativado ou com reset continua
  entrando por até 7 dias (vida do refresh).
- Passa a ler a conta pelo CNPJ do token, na **mesma tabela que o login usa conforme a chave**
  (chave ligada → `ContaMotorista`; desligada → `Motorista`). Os gatilhos mantêm as duas iguais,
  mas seguir a chave mantém login e refresh simétricos.
- Renova só se a linha existe, `ativo` é verdadeiro e `senha` não é nula (senha nula = reset em
  curso, que deve cortar a sessão). Caso contrário: 401 com a mensagem genérica e os cookies do
  app limpos, reusando o que o `/logout` já faz (sem duplicar).
- Erro ao ler o banco: 503, sem renovar e sem limpar cookies (fail-closed, mas não desloga por
  instabilidade).
- O `nome` do novo token vem da linha lida.
- Custo: uma consulta por CNPJ a cada 15 min por motorista com o app aberto (índice único no CNPJ).
- Testes unitários sobre o handler real, nos dois modos da chave: ativo, inativo, inexistente
  (CNPJ trocado), sem senha, erro de banco e audiência errada (já existe).

### D2 — checagem de prontidão (`infra/hub/scripts/prontidao-login-hub.sql`)
- Só leitura, sem hash e sem CNPJ completo.
- Critério único: nenhum motorista pode perder acesso ao ligar a chave. Conta-se `Motorista` com
  `senha IS NOT NULL` para os quais **não** existe `ContaMotorista` com o mesmo CNPJ, a mesma
  `senha` e o mesmo `ativo`.
- Última linha: `PRONTO` se 0; senão `NAO PRONTO: N motoristas perderiam acesso`, mais uma lista
  mascarada (id, nome, CNPJ mascarado, motivo: sem conta / senha diferente / ativo diferente).

### D3 — staging igual à produção
- `infra/hub/compose.hub.homolog.yml`: `HUB_MOTORISTA_LOGIN_CONTA_ATIVA: "${HUB_MOTORISTA_LOGIN_CONTA_ATIVA:-}"`,
  igual ao `compose.hub.test.yml`.
- O `/var/lib/hub_secrets/.env.hub.homolog` já tem `=false` desde 2026-11-01.

### D4 — runbook da virada (`docs/plans/motorista-cadastro-hub/RUNBOOK-VIRADA-0811.md`)
Passos, todos sob o rito de produção:
1. Prontidão (`PRONTO` obrigatório).
2. Anotar o env atual.
3. `service update --env-add`.
4. Provar no processo vivo (`printenv`).
5. Smoke: login de uma conta conhecida pelo app; senha errada dá 401.
6. Reversão (`--env-rm`) e quando usá-la.
7. Atualizar o CLAUDE.md e a memória: a chave está ligada.

## Entregável e gates
Backend (D1), SQL (D2), compose (D3), runbook (D4).
- Gates: `npm test` do backend; a prontidão rodada no staging e, só leitura, em produção.
- Deploy: só o backend.
