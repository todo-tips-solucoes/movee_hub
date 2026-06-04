# Handoff Operacional — App Motorista (PWA)

**Feature**: `app-motorista-nfse` | **Date**: 2026-06-04
**Status do código/docs**: COMPLETO (ondas 1–4). **Pendências abaixo**: exigem
ambiente real (PostgREST/containers ativos, DNS, rede externa, dispositivo) e **não
podem ser executadas/validadas a partir da worktree de desenvolvimento**.

> Implementado e commitado: backend (`/motorista/*`), frontend PWA (`frontend_motorista`,
> Serwist), tabela `Motorista` (SQL), serviço no `docker-compose.yml`, 45 testes verdes,
> revisão OWASP, README do backend. Branch: `worktree-app-motorista-nfse`.

---

## 1. Banco de dados (PostgREST/PostgreSQL)

- [ ] **Aplicar a tabela `Motorista`** — rodar o SQL idempotente:
  ```bash
  psql "$DATABASE_URL" -f app_homologacao/backend/db/001_create_motorista.sql
  ```
  Cria `Motorista` (id, cnpj_prestador UNIQUE, senha, nome, ativo, created_at) + GRANTs
  para a role `authenticated` do PostgREST. (tarefa 1.1.1/1.1.2)
- [ ] **Recarregar o schema do PostgREST** (para ele enxergar a tabela nova):
  `NOTIFY pgrst, 'reload schema';` (ou reiniciar o container do PostgREST).
- [ ] **Seed de motorista de teste** (homologação) — tarefa 1.1.3:
  ```bash
  cd app_homologacao/backend && node db/seed-motorista.js
  # (ou aplicar db/002_seed_motorista_teste.sql)
  ```
- [ ] **Validar** (tarefa 1.1.4): `GET {POSTGREST_URL}/Motorista?cnpj_prestador=eq.<cnpj>`
  retorna o registro seedado.
- [ ] **Confirmar colunas `nota_ok`/`erro_validacao` na `EnvioMassa`** (tarefa 1.2.1):
  `GET {POSTGREST_URL}/EnvioMassa?limit=1` e checar a presença + tipo das colunas.
  Se ausentes, criar migração aditiva antes de usar a validação.

## 2. Variáveis de ambiente (`.env` — fora do git)

Garantir no `.env` do backend (já usados pelo código existente):
- [ ] `JWT_SECRET`, `JWT_REFRESH_SECRET` (reusa os mesmos cookies do padrão Empresa)
- [ ] `POSTGREST_URL`, `POSTGREST_API_KEY`
- [ ] `FASTAPI_VALIDATION_TOKEN` (header `Authorization` da validação)

No `frontend_motorista/.env`:
- [ ] `BACKEND_URL=https://envmassapihomologacao.todo-tips.com`

## 3. Roundtrip empírico do contrato de validação (R-1 / risco aberto)

> A divergência do `xml_input` (research.md Decision 5) foi **parcialmente** reconciliada:
> o schema OpenAPI confirmou `multipart/form-data` (bug de Content-Type corrigido). Falta
> a chamada com **payload real** — bloqueada no dev pelo classificador de rede do harness.

- [ ] **R2** (tarefa 7.1.2): com um XML de NFS-e de homologação, chamar a validação como o
  backend faz e conferir o shape da resposta `[{ valid, details: {...7 flags} }]`:
  ```bash
  curl -X POST https://fastapihomologacaonexus.todo-tips.com/validade_nfse \
    -H "Authorization: $FASTAPI_VALIDATION_TOKEN" \
    -F 'xml_input=[{"filename":"nota.xml","data":"<xml...>"}]' \
    -F 'validar_descricao_servico=false' -F 'nexus=false'
  ```
  Se a API **rejeitar** o `xml_input=[{filename,data}]`, cair para o formato da rota
  `validate-xml-batch` existente e atualizar `research.md` Decision 5 + `contracts/`
  (tarefas 7.1.3/7.1.4). O parser do backend já tolera resposta inesperada (FR-012).
- [ ] **R1** (tarefa 7.1.1): com backend + PostgREST reais, `GET /api/motorista/movimento-aberto`
  e conferir que o payload sai em camelCase conforme o contrato.

## 4. Deploy (Docker + Traefik) — Constituição V (aditivo, sem afetar produção)

- [ ] **Criar DNS** `appmotorista.todo-tips.com` → IP da VPS (para o Traefik emitir TLS). (R-3)
- [ ] **Validar o compose sem subir** (tarefa 6.2.3): `docker compose config` e conferir
  que **nenhum** container de produção precisa reiniciar.
- [ ] **Build + push da imagem** (tarefas 6.1.2/6.1.3):
  ```bash
  cd app_homologacao/frontend_motorista
  docker build -t registry.todo-tips.com/envio-massa-motorista:homologacao .
  docker push registry.todo-tips.com/envio-massa-motorista:homologacao
  ```
- [ ] **Subir o serviço novo** e validar acesso externo pelo host novo (tarefa 6.2.5):
  `docker compose up -d frontend_motorista_homologacao`.
- [ ] Garantir que o backend foi redeployado com as rotas `/motorista/*` (o serviço
  `backend_homologacao` precisa da imagem atualizada).

## 5. Validações manuais de UI/PWA

- [ ] Smoke local (tarefa 4.1.5): `npm run dev` no frontend, login devolve cookies via proxy.
- [ ] Cenários do quickstart (tarefa 7.3.2 / 5.x): login, cadastro elegível vs inelegível,
  movimento aberto, empty state, upload válido (bloqueia reenvio), upload inválido (lista
  campos), não-XML (400), serviço fora (502).
- [ ] **Lighthouse PWA** (tarefa 4.2.4): confirmar "installable"; instalar na tela inicial
  (Android/Chrome e iOS/Safari) e abrir em standalone.

## 6. Pull Request

- [ ] Abrir PR de `worktree-app-motorista-nfse` (ou `feature/app-motorista-nfse`) → `main`:
  ```bash
  git push -u origin worktree-app-motorista-nfse
  gh pr create --base main --title "feat: App Motorista (PWA) — consulta de NF + validação de XML" \
    --body "Pipeline SDD completo. Backend /motorista/*, frontend PWA, deploy aditivo. Ver docs/specs/app-motorista-nfse/."
  ```

---

## Riscos remanescentes
- **R-1**: contrato `validade_nfse` — só o roundtrip real (§3) fecha em definitivo.
- **R-3**: DNS do host novo é pré-condição para o TLS do Traefik.
- **Auto-cadastro**: guard anti-enumeração depende de a `EnvioMassa` ter o `cnpj_prestador`
  do motorista; validar com dados reais que o guard não bloqueia motoristas legítimos.
