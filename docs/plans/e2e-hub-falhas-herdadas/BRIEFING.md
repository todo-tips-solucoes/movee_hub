# Briefing — falhas herdadas no E2E do hub (medidas em 2026-09-20)

> Estado: **4 identificadas, 1 resolvida (§2.1), 3 abertas.**

Prompt para sessão limpa. **Leia o `CLAUDE.md` antes de qualquer coisa**: o ambiente
chamado "homologação" É produção, o ciclo git é cláusula pétrea e **autorização é por
etapa**. Repositório é público — nenhum dado pessoal real em código, teste, log ou
documento.

Tudo aqui foi **medido em 5 execuções do E2E**, não suposto. Onde é hipótese, está dito
— e a §2.1 mostra o que acontece quando a hipótese está errada.

---

## 1. O problema, medido

`infra/hub/testes/hub-shell-e2e-browser.sh` fecha hoje com **135 passed / 4 failed**
(era 133/5 antes da correção de §2.1), dos quais **3 falham de forma estável**. A última execução arquivada antes disso
(`docs/plans/hub-frota/evidencias/S3/fase6-browser-run-20260821T145301Z.log`,
**2026-08-21**) fechou **138 passed / 0 failed**.

Entre 21/08 e 20/09 entrou a feature de adiantamento inteira (PRs #182–#192) e **este
E2E não foi rodado**. As 4 falhas são regressões acumuladas que passaram despercebidas.

Foram descobertas de raspão, durante a verificação do PR #194 (bump do Next), e
**confirmadas como independentes da versão do Next**: aparecem igual com `16.2.3` e com
`16.3.5`.

| Execução | Placar |
|---|---|
| controle, next 16.2.3 | 133 / 5 |
| next 16.3.5 (1ª) | 132 / 6 |
| next 16.3.5 (2ª) | 133 / 5 |
| depois da correção de §2.1 (2 execuções) | **135 / 4** |

---

## 2. As falhas estáveis, com a causa medida

### 2.1 `sessao-expira.spec.ts:29` — ✅ RESOLVIDA (2026-09-20)

**A expulsão de sessão NUNCA esteve quebrada. Era o teste medindo o caminho errado.**

⚠️ **A hipótese que estava escrita aqui — "a renovação silenciosa pode estar engolindo o
token corrompido e renovando em vez de expulsar", sugerindo defeito de produto — foi
INVESTIGADA E É FALSA.** O produto está correto. Fica o registro para ninguém partir dela.

O mecanismo, medido:

1. o teste corrompia **só** o `hub_accessToken`;
2. `accessVenceEmBreve` (`lib/hub/sessao-proxy.ts:25`) cai no `catch` e devolve `true`
   para token indecifrável — trata como vencido;
3. o proxy então **renova antes de encaminhar**, usando o `hub_refreshToken`, que o teste
   não tocava e continuava válido;
4. a renovação dá certo, a resposta é 200, nunca há 401, nunca há logout.

Desde **2026-09-06** ([[plano-hub-sessao-inatividade]]), **access morto não é sessão
expirada — sessão expirada é REFRESH inválido.** Corromper só o access exercita hoje o
caminho de RENOVAÇÃO.

Corrigido corrompendo os **dois** cookies, mais uma contraprova nova (`access morto +
refresh válido RENOVA, não expulsa`). ⚠️ **Não corrigir isto no produto:** fazer o proxy
expulsar a cada access vencido "conserta" o teste e **quebra a inatividade deslizante de
6 h**, que é deliberada.

### 2.2 `impeccable-rodada10.spec.ts:19` — permissão nova sem rótulo

```
Error: permissões ainda em código cru: motoristas.dados_sensiveis
  Received + ["motoristas.dados_sensiveis", ...]
```

Causa direta: a permissão `motoristas.dados_sensiveis` chega à tela **em código cru**, sem
rótulo legível em português. Falta a tradução no mapa de rótulos.

### 2.3 `impeccable-rodada3.spec.ts:129` — card de módulo sem ajuda contextual

```
Received + ["Avisos", ...]
```

O card do módulo **Avisos** aparece no dashboard sem o texto que diz *o que o módulo faz*
— o teste exige que todo card explique a função, não só o nome. O módulo nasceu na
migration `0062` e nunca ganhou essa descrição.

### 2.4 `impeccable-rodada3.spec.ts:51` — filtro de período

```
Error: element(s) not found
  waiting for getByLabel('De (data de competência)', { exact: true })
  > await expect(campoDe).toHaveValue('');
```

O campo com rótulo exato `De (data de competência)` não é encontrado em
`/hub/dashboard/faturamento`. **Hipótese:** o rótulo mudou ou o campo foi reestruturado
por alguma entrega recente — confirmar lendo a tela antes de mexer no teste.

---

## 3. ⚠️ A causa RAIZ provável, e o que fazer com ela

O seed do driver ativa **todos os módulos do catálogo** para as entidades sintéticas:

```sql
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, e.empresa_id, true FROM "Modulo" m CROSS JOIN (VALUES (950101),(950102)) …
```

Ou seja: **todo módulo ou permissão novo entra automaticamente no E2E** e quebra se não
trouxer o acabamento de UI que os testes exigem (rótulo em português, ajuda contextual).
Foi o que aconteceu com `avisos` (0062) e `motoristas.dados_sensiveis`.

Isso é bom — o E2E é um detector honesto de "feature entregue sem acabamento". O defeito
é o E2E **não rodar no ciclo**: ficou 1 mês parado e acumulou 4 dívidas em silêncio.

**Consequência para o trabalho:** corrigir as falhas é metade. A outra metade é decidir como
esse E2E volta a rodar regularmente — hoje nada o obriga.

---

## 4. Como reproduzir, e os 4 enganos que custam tempo

```bash
infra/hub/testes/hub-shell-e2e-browser.sh
```

- ⚠️ **O driver NÃO builda o frontend.** Ele aponta para o projeto `hub-homolog` vivo.
  Se você mudou código do frontend e não rebuildou a imagem, **está testando o binário
  antigo** e o resultado não significa nada (teste oco). Rebuildar:
  `DOCKER_BUILDKIT=0 docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog
  --env-file /var/lib/hub_secrets/.env.hub.homolog build --memory=2g frontend` e
  `up -d frontend`. Confirmar dentro do container antes de rodar.
- ⚠️ **Cold start derruba o `global-setup`.** Logo após `up -d`, a primeira requisição do
  Next standalone é lenta e o `getByLabel('Email')` estoura os 30 s — a falha PARECE
  quebra de login e é só aquecimento. Bater um `curl -sk https://localhost:8443/hub/login`
  antes e só então rodar.
- ⚠️ **O container do Playwright REESCREVE `frontend_v2/package-lock.json`** (npm de outra
  versão, via bind mount). Em 2026-09-20 removeu 47 pacotes / 1027 linhas. **Conferir com
  `git diff --stat` e restaurar antes de commitar.** Ele também sobrescreve prints
  versionados em `evidencias/S3/`.
- ⚠️ **O E2E é flaky.** Além das estáveis, `rodada8:21` (skip link), `rodada10:58`,
  `rodada9:61` e `rodada9:32` falharam **uma vez cada**, em execuções diferentes e nos
  dois lados do controle. **Não trate uma falha isolada dessas como regressão sem repetir
  a execução.**

---

## 5. O que NÃO refazer

- **Não re-investigue se é o Next 16.3.5.** Já medido com controle em 3 execuções: não é.
- **Não "conserte" o teste mudando o esperado** sem antes olhar a tela. Em 2.2 e 2.3 o
  teste está certo e **o produto é que está incompleto** — a correção é na UI, não na
  asserção. (Em 2.4 pode ser o inverso; por isso está marcado como hipótese.)
- O baseline 138/0 de 21/08 está arquivado em `evidencias/S3/` — serve de referência do
  que já passou um dia.

---

## 6. Entregáveis sugeridos

1. ~~Corrigir **2.1**~~ — ✅ feito em 2026-09-20: era teste, não produto. Ver §2.1.
2. Corrigir **2.2** e **2.3** (rótulo + ajuda contextual) — provavelmente pequenas, na UI.
   **Nas duas o teste está certo e o produto é que está incompleto.**
3. Investigar **2.4** e decidir se é teste ou produto.
4. Decidir **como o E2E volta ao ciclo**, senão isto se repete na próxima feature.

⚠️ **Lição de §2.1, que vale para 2.2–2.4:** a hipótese registrada aqui apontava para
defeito de produto e estava ERRADA. Medir o mecanismo antes de mexer — e desconfiar
quando "corrigir o produto" significaria desfazer uma decisão deliberada.

Relacionado: [[gotcha-suite-integracao-hub-2-falhas-herdadas]] (baselines dos drivers de
integração, zeradas no PR #193), [[plano-hub-sessao-inatividade]], [[gotchas-medicao-ui-hub]].
