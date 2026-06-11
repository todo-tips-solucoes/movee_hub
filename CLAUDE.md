# CLAUDE.md

Instruções para o Claude Code (e qualquer agente) que opera neste repositório.

## ⚠️ Rito de produção — REGRA CRÍTICA

**O ambiente chamado de "homologação" É produção: é o que os clientes usam.** Não existe um
ambiente de produção separado. Todo deploy nesse ambiente atinge clientes reais
imediatamente. O nome "homologação" nos recursos é histórico — trate-o como produção.

Ambiente do cliente:

| | Identificação |
|---|---|
| Host | `VPSTodo` |
| Serviços (Docker Swarm) | `envio-massa-homologacao_backend_homologacao` · `envio-massa-homologacao_frontend_v2_homologacao` |
| Banco | `chatmasterveloz` no container `pgadmin_db` |
| Domínios | `https://envmassv2.todo-tips.com` (painel) · `https://appmotorista.todo-tips.com` (app motorista) |
| Registry | `registry.todo-tips.com/envio-massa-backend` · `.../envio-massa-frontend-v2` |

### O que exige rito de produção (escrita no ambiente vivo)

- `docker service update` (deploy de imagem)
- DDL ou qualquer escrita no banco do cliente (`pgadmin_db`)
- alteração de configuração/segredos/labels dos serviços
- qualquer comando que mude estado do host de produção

### O que NÃO exige (fluxo normal)

- escrever/alterar código; abrir, revisar e mergear PR
- buildar e dar `push` de imagem (a imagem só vira produção no `service update`)
- testes/lint locais, gerar artefatos e documentação

### Os 5 gates (nesta ordem, antes de qualquer escrita no ambiente vivo)

1. **Autorização explícita** para *aquela* mudança específica — não vale autorização
   genérica, antiga ou implícita.
2. **Janela combinada** com o operador.
3. **Plano de rollback à mão** antes de aplicar (imagem anterior anotada via `docker service ls`;
   rollback = `docker service update --with-registry-auth --image <anterior> <serviço>`; DDL
   sempre idempotente/aditiva, com `pg_dump -t` antes de seed/alteração de dados).
4. **Aplicar com `docker service update --image`** — **nunca** `docker stack deploy`.
5. **Smoke test** (HTTP, sem expor segredos) antes de declarar OK.

**Em qualquer dúvida: parar e devolver ao operador.** Nunca procurar rota alternativa (SSH,
credenciais, rede) para contornar um gate. O agente **nunca** decide sozinho aplicar em
produção — entrega artefatos (código, PRs, DDLs, runbooks) e só executa escrita no ambiente
vivo com os 5 gates satisfeitos.

Detalhe completo em [`docs/RITO-PRODUCAO.md`](docs/RITO-PRODUCAO.md).

## Convenções de deploy

- Deploy = `docker build` → `docker push` → `docker service update --with-registry-auth --image …`.
  **Nunca** `docker stack deploy` (preserva env/labels/segredos do serviço).
- Backend roda em `node:14`; frontend_v2 em `node:20-alpine` (Next.js standalone). O
  `.dockerignore` exclui `node_modules`, então módulos nativos (ex.: `bcrypt`) recompilam no
  build — não copiar binários do host.
- ⚠️ O `ENV BACKEND_URL` do Dockerfile do `frontend_v2` aponta para a API do ambiente; conferir
  antes de buildar para outro destino.

## Governança

- Commit/push/merge/deploy **somente com autorização explícita** do operador.
- Mensagens de commit terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  corpos de PR terminam com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Princípios de projeto em [`docs/constitution.md`](docs/constitution.md).
