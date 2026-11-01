# Cadastro do motorista no hub — fechar movimento, sincronia hub↔legado, troca de CNPJ

Frente aberta em 2026-10-31. O painel legado deixa de ser usado em **08/11/2026**; a partir daí
toda a gestão do motorista acontece no hub. A tabela legada `Motorista` continua sendo lida pelo
**login do app motorista** (o gate `HUB_MOTORISTA_LOGIN_CONTA_ATIVA` segue DESLIGADO em produção)
até uma frente posterior.

Relatórios de análise desta frente (fora do git, na pasta temporária da sessão):
`analise-banco.md` (database-architect) e `analise-codigo.md` (backend-architect). O que importa
deles está consolidado aqui.

## 1. Os três defeitos — causa MEDIDA

| # | Sintoma | Causa |
|---|---|---|
| A | "Fechar movimento" mostra `[object Object]` | `POST /close-movimento` exige `envio_massa.aprovar` (só admin_entidade/admin_plataforma, seed 0007). O middleware responde `403 {"error":{"code":"PERMISSAO_INSUFICIENTE"}}` (reproduzido em staging com `qa.financeiro`). `lib/api-client.ts:81` faz `body.message \|\| body.error` → objeto vira texto. Atinge 8 ações da tela (Fechar, Excluir, Importar, Editar, Disparar, Parar, Carregar, Download XML). `use-xml-validation.ts` mostra 403 como "indisponível". A tela não esconde o botão. |
| B | CNPJ alterado no envio em massa não muda no hub | `migrarCnpjMotorista` (`server.js:~1658`, via `PATCH /update-envio-massa/:id`, chamado pelo painel E pela tela do hub) migra `Motorista` e `EnvioMassa`, nunca `ContaMotorista`. Agravantes: o PATCH em lote da `EnvioMassa` roda ANTES do pré-check de conflito (409 deixa movimentos migrados); filtra só a grafia de dígitos. |
| C | Credencial criada no hub não entra no app | O login lê `Motorista`. `espelharSenhaNoLegado` faz PATCH com `return=minimal`: 0 linhas = "ok". Sem linha legada (ou com CNPJ migrado por B) nada é gravado. Desativar no hub também não chega ao legado (o motorista desativado continua entrando). |

### Medido na cópia do backup de produção de 2026-10-31 (container isolado, sem rede)

| Classe | Qtde |
|---|---|
| ContaMotorista / com senha | 1678 / 859 |
| Motorista / com senha | 2491 / 1067 |
| CNPJ pontuado em Motorista / ContaMotorista | 0 / 0 |
| Credenciais criadas pelo hub (Auditoria) / delas sem linha legada (= não entram) | 22 / **5** |
| Conta com senha sem legado | 3 |
| Senha: só no legado (hub nulo) / só no hub / as duas diferentes | 210 / 2 / **8** |
| `ativo` divergente | 1 |
| Motorista sem conta / com senha | 828 / 3 |
| Entregador vinculado a CNPJ ≠ do último movimento (heurística por nome) | **23** |
| EnvioMassa com CNPJ pontuado (todas em movimento fechado) | 17483 |
| Entidades com Entregador no hub | só a 6 (Movee) |
| Dono das tabelas | `chatmasterveloz`; `EnvioMassa` sem gatilhos |

Caso do print (Thiago da Silva Lima): movimentos passaram do CNPJ 30…31 para 69…09 em out/2026;
o Entregador do hub segue vinculado à conta 30…31 (sem senha). Já existem conta e Motorista
69…09 (este com senha). Correção: **re-vincular** o Entregador à conta 69…09 (lista C2 do gate).

Staging (`hub-homolog`) **não** está na versão de produção: imagens de 14/10 (26 commits atrás),
banco na 0118 (produção na 0119), e o compose liga `HUB_MOTORISTA_LOGIN_CONTA_ATIVA` por default
(produção desligado) — foi por isso que os testes de credencial passavam.

## 2. Decisões do operador (2026-10-31) — não reabrir

1. `envio_massa.aprovar` passa a valer também para **financeiro** e **financeiro_aprovador**.
   Corrigir a mensagem de erro (central) e esconder botões de quem não tem permissão.
2. Medição de produção pela **restauração do backup** em container isolado.
3. Sincronia `ContaMotorista` ↔ `Motorista` por **gatilho no banco** (ponto único).
4. Réplica no legado **só para o grupo Movee** (empresa 6 + filiais, critério de `mesmoGrupoQue`).
5. Troca de CNPJ no hub migra **todos os movimentos da empresa** (como o legado).
6. Reconciliação **por campo**: CNPJ vem do legado; senha vem do hub quando o legado está vazio
   ou falta a linha legada (e do legado quando o hub está vazio — só existe um valor). **Caso
   ambíguo vai para lista no gate, sem correção automática** (senha diferente nos dois lados,
   `ativo` divergente, CNPJ divergente/re-vínculo).
7. **Não** ligar `HUB_MOTORISTA_LOGIN_CONTA_ATIVA` nesta entrega.
8. Ciclo git: agente commita e prepara PR; operador cola push + `gh pr create`; agente mergeia
   (avisando), builda da main e **para no gate de produção** com recomendação.

Decisões do agente (Opus), tomadas antes da execução:
- Troca de CNPJ exige `motoristas.credencial` (financeiro já a tem pela 0114).
- Troca de CNPJ com conflito (CNPJ novo já tem conta ou Motorista) → **409 sem escrever nada**;
  a tela orienta usar "Alterar vínculo". Fusão de contas é destrutiva: fora.
- Conta bancária PJ após troca de CNPJ: **mantida** (nada apagado); a resposta e a auditoria
  sinalizam `contaBancariaPjDesatualizada` e a tela avisa.
- Não normalizar `EnvioMassa` pontuada (destrutivo, só movimentos fechados). As buscas por CNPJ
  na troca cobrem as duas grafias.
- Pré-cadastro sem senha (825 Motorista) **não** ganha ContaMotorista: o vínculo do hub cria
  quando precisar (YAGNI). Motorista com senha sem conta (3) ganha.
- Fora de escopo, registrado como dívida: refresh do app revalidar `ativo`/CNPJ; ligar o gate do
  login; dropar o G4 e a `Motorista`; aba "contas sem Entregador" (120).

## 3. Frentes (paralelas, worktree próprio, branch própria, commit local)

Numeração de migrations reservada (não usar outra): **0120** F1 · **0121, 0122, 0123** F2 · **0124** F3.

### F1 — Fechar movimento e erro legível
- `0120_envio_massa_aprovar_financeiro.sql`: dá `envio_massa.aprovar` a `financeiro` e
  `financeiro_aprovador` (idempotente, `ON CONFLICT DO NOTHING`, registra em `SchemaMigration`
  no padrão das vizinhas).
- `frontend_v2/lib/api-client.ts`: função única `lerErroApi(body, status)` que entende
  `{message}`, `{error:string}`, `{error:{code,message}}`, `{erro:'CODIGO'}`, com mapa de códigos
  para pt-BR (`PERMISSAO_INSUFICIENTE`, `SEM_ENTIDADE_ATIVA`, `ADAPTADOR_INDISPONIVEL`,
  `TOKEN_INVALIDO`…); `ApiError` ganha `codigo` opcional. `hooks/use-xml-validation.ts` usa o
  mesmo helper para 401/403. Nenhuma mudança de contrato no backend.
- `GET /me` (`routes/hub-me.js`) ganha `permissoesEntidadeAtiva` (via
  `obterPermissoesEfetivasPorEntidade`, cache de 60 s existente); exposto no contexto de auth do hub.
- `app/hub/dashboard/envio_massa/page.tsx` calcula `podeAprovar/podeCriar/podeEnviar` e passa
  como **props opcionais com default `true`** para `ActionBar`/`DataTable` (o painel legado não
  passa nada e não muda). Fechar/Excluir ← aprovar; Importar/Editar ← criar; Disparar/Parar ← enviar.
- Testes: vitest do `lerErroApi` (cada formato) e dos botões escondidos; unit do `/me`.

### F2 — Sincronia no banco, reconciliação, segurança da credencial
- `0121_reconcilia_motorista.sql` (uma transação, idempotente, aditiva): C4 (normalizar CNPJ
  pontuado sem colisão), C3a (hub nulo ← legado, pulando `token_reset_hash` em curso), C3c
  (legado nulo ← hub), C1 (conta com senha sem legado → INSERT `Motorista`, só Movee), C5
  (legado com senha sem conta → INSERT conta). **Sem** C3b nem C3d nem C2 (vão para a lista).
- `0122_motorista_estrutura.sql`: CHECK 14 dígitos `NOT VALID` + `VALIDATE` nas duas tabelas;
  `Motorista.atualizado_em` + gatilho BEFORE UPDATE de `atualizado_em` nas duas; índice único
  parcial em `ContaMotorista.token_reset_hash`; redefinir
  `hub_motorista_vincular_por_base_motorista` normalizando o CNPJ (defeito da 0102, ler a
  definição VIVA).
- `0123_sync_motorista_legado.sql`: gatilhos G1–G4 da §2.3 do `analise-banco.md` (G1 conta nasce
  sem senha adota a do legado; G2 conta→legado; G3 vínculo tardio em `Entregador`; G4
  legado→conta, temporário). Anti-laço por GUC de transação + `IS DISTINCT FROM`. SECURITY
  DEFINER, `SET search_path`, `REVOKE … FROM PUBLIC`. INSERT na `Motorista` só com senha e CNPJ
  Movee. Colisão de UNIQUE aborta (fail-closed). Cabeçalho com ROLLBACK.
- `infra/hub/scripts/diagnostico-motorista-sync.sql` (só leitura, sem imprimir hash nem CNPJ
  completo): contagens D1–D9 + as **listas do gate** (C3b senhas diferentes, C3d ativo, C2
  entregador×CNPJ do último movimento com conta-alvo existente ou não).
- Backend: apagar `espelharSenhaNoLegado` e o 2º PATCH do `/motorista/definir-senha` (o gatilho
  cobre); nas 4 rotas de credencial: gate Movee (`entidadeEhElegivel`), gravar o vínculo ANTES da
  senha, recusar `credencial_existente` quando a conta já tem senha; DTO de criação exige
  `/^\d{14}$/`; `lib/senha.js` com `DUMMY_HASH` único (hoje duplicado em `server.js` e
  `hub-auth.js`) e o login do app passa a comparar contra ele quando não há conta/senha
  (anti-enumeração por tempo).
- Testes: unit dos handlers reais (sem cópia local), incluindo o caso "0 linhas"; SQL dos
  gatilhos provado em banco (ver §4).

### F3 — Trocar o CNPJ da conta vinculada pelo hub (substitui o painel)
- `0124_motorista_trocar_cnpj.sql`: RPC `hub_motorista_trocar_cnpj(p_cnpj_antigo, p_cnpj_novo,
  p_id_empresa)` numa transação: valida 14 dígitos e empresa do grupo Movee; **pré-checa
  conflito** em `ContaMotorista` e `Motorista` antes de qualquer escrita (erro com código
  próprio → 409); atualiza `ContaMotorista` (o G2 da 0123 leva à `Motorista`) ou, sem conta, a
  `Motorista` (o G4 cobre); migra `EnvioMassa` da empresa nas duas grafias; devolve contagens.
  Assume os gatilhos da 0123 (aplicada antes). GRANT só a `authenticated`, no padrão das RPCs
  vizinhas.
- Backend: rota nova `PATCH /motoristas/:id/credencial/cnpj` (`motoristas.credencial`, gate
  Movee, escopo por `entidadeAtiva`, allowlist `{cnpjPrestador}`), auditoria
  `motorista.cnpj_alterado` com CNPJs mascarados, `contaBancariaPjDesatualizada` na resposta.
  `PATCH /update-envio-massa/:id` passa a chamar a MESMA RPC (some a lógica duplicada de
  `migrarCnpjMotorista`; a função sai ou vira um invólucro fino). Mover para `lib/` o que for
  testável e testar o handler real.
- Frontend: botão "Alterar CNPJ" no card da conta vinculada (`app/hub/dashboard/motoristas/[id]`),
  escondido sem `motoristas.credencial`; diálogo com máscara, 14 dígitos, mensagem do 409
  orientando "Alterar vínculo", aviso de conta bancária PJ. `edit-dialog.tsx` segue tratando 409.
- Testes: unit/vitest + SQL da RPC provado em banco.

## 4. Como testar SQL sem tocar produção

Container isolado `hub_diag_restore` (postgres:13, `--network none`) com a cópia do backup de
produção de 31/10, papéis `authenticated`/`chatmasterveloz`/`hub_web_anon` criados, **sem GRANTs
e o usuário `diag` é superusuário** (RLS e GRANT não são exercitados ali — isso se prova em
staging). Bancos: `prod_copia` (F2), `prod_copia_f1` (F1), `prod_copia_f3` (F3, aplicar antes as
migrations da F2 quando existirem, ou o SQL dos gatilhos da §2.3 do relatório).

```bash
docker exec -i hub_diag_restore psql -U diag -d <banco> -v ON_ERROR_STOP=1 < arquivo.sql
```

Staging (`hub_homolog_db`, dados sintéticos, GRANT/RLS reais) é atualizado pelo integrador, não
pelas frentes.

## 5. Restrições para os executores

- Ler o `CLAUDE.md` da raiz. Nada de escrita em produção (`pgadmin_db`, serviços Swarm, `.env`).
- **Não** rodar `docker build`, `next build`, E2E nem drivers `infra/hub/testes/*.sh` (disco a
  20 GB, abaixo do mínimo; o integrador roda uma vez). Rodar: `node --test` dos arquivos tocados,
  `npm test` do backend, `npx vitest run` dos arquivos tocados, `npx tsc --noEmit`, lint dos
  arquivos tocados comparado com a baseline.
- `node_modules`: symlink para o do repositório principal (`/var/lib/envioMassa_homologacao/app_homologacao/{backend,frontend_v2}/node_modules`).
- Sem duplicação: reusar helpers existentes (`cnpjEnvioMassaFilter`, `mascararCnpj`,
  `entidadeEhElegivel`, `hubPostgrestRequest`, `registrarAuditoria`). Ficar dentro dos arquivos da
  sua frente; tocar arquivo de outra frente só se inevitável, e declarar.
- Commit local na branch do worktree, `git add` por caminho explícito, mensagem com o quê, por quê,
  verificação com números e o que ficou de fora; trailer `Co-Authored-By` da sessão. Sem push.
- Conferir e reverter `package-lock.json` se mudar sem querer.
- O hook `bash-guard` recusa por substring comandos que pareçam de rede, até em texto: escrever
  arquivo com a ferramenta de escrita, não heredoc.

## 6. Integração, gates e promoção (integrador)

1. Mesclar F1, F2, F3 numa branch `fix/motorista-cadastro-hub`; resolver conflitos.
2. Gates com números: tsc, unit backend e frontend, lint × baseline, `next build`, detector
   impeccable (UI tocada), integração/E2E do hub nos drivers.
3. Revisão adversarial independente sobre o diff; medir cada achado antes de aceitar.
4. Ensaio das migrations 0120–0124 na cópia NOVA do backup (do zero), com o diagnóstico antes e
   depois.
5. Staging atualizado para a branch (imagens + migrations até a 0124), gate de login desligado
   como em produção, smoke dos três defeitos.
6. Commit, PR (operador cola push), merge, build `<rótulo>-<sha7>` da main, **parar no gate**:
   runbook com `pg_dump -t`, ordem migrations → backend → frontend_v2, rollback, smoke, listas C2/
   C3b/C3d para decisão do operador.
