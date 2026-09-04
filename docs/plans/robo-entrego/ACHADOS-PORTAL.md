# Achados medidos no portal EntreGô franqueado — 2026-08-27

Levantamento feito **no portal real**, com o operador logado, via Claude in Chrome.
Tudo abaixo foi **medido** (DOM, rede, resposta HTTP). Nada aqui é suposição — o que
não foi medido está marcado como **⚠️ NÃO VERIFICADO**.

Origem: sessão de descoberta anterior à pipeline SDD, a pedido do operador
("não suponha nada").

## 1. Navegação

| Item | Valor medido |
|---|---|
| Login | `https://franqueado.entregolog.com/login` |
| Tela de relatórios | `https://franqueado.entregolog.com/supply/reports` (URL direta funciona) |
| Menu | SPA sem `<a href>` — `document.querySelectorAll('a[href]')` retorna `[]`. Navegação por clique/pushState, **ou** ir direto na URL |
| Caminho pela UI | `Operador logístico` → `Relatórios` |

## 2. Formulário de relatórios

| Campo | Seletor medido | Observação |
|---|---|---|
| Tipo de relatório | `#downshift-1-input` (`name="color"`), `readOnly` | combobox Downshift |
| Data início | `#initialDate` (`name="initialDate"`), **`readOnly`** | **não aceita digitação** — só clique no calendário |
| Data fim | `#finalDate` (`name="finalDate"`), **`readOnly`** | idem |
| Botão | `button` com texto `Gerar Relatório` | fica `disabled` até os 3 campos preenchidos |

Opções do combobox (ids estáveis do Downshift):

| id | rótulo | enum na API |
|---|---|---|
| `downshift-1-item-0` | Performance | `PERFORMANCE` |
| `downshift-1-item-1` | Pedidos pagos em Dinheiro | ⚠️ NÃO VERIFICADO |
| `downshift-1-item-2` | Pedidos extraviados | ⚠️ NÃO VERIFICADO |
| `downshift-1-item-3` | Financeiro | `FINANCE` |

**Regra de data medida no calendário**: o dia corrente (27/08) e os futuros aparecem
desabilitados; o último dia selecionável é **D-1**. Após escolher a Data início, o
calendário da Data fim desabilita tudo fora do intervalo válido. Formato exibido:
`dd/MM/yyyy`. Formato na API: `yyyy-MM-dd`.

## 3. A API interna (achado que muda o desenho)

O botão `Gerar Relatório` **não baixa direto**: chama um BFF que devolve URL
pré-assinada do S3.

```
GET https://api.entregolog.com/logistics-web-bff/operation/logistics-operator/reports/{TIPO}/urls
    ?type={TIPO}&initialDate=YYYY-MM-DD&finalDate=YYYY-MM-DD
```

`{TIPO}` ∈ `PERFORMANCE` | `FINANCE` (aparece tanto no path quanto na query).
Status medido: `200`.

**Corpo da resposta** (capturado pelo operador via DevTools em 2026-08-28, credenciais AWS
redigidas na origem):

```json
[
  {
    "url": "https://s3.amazonaws.com/logistics-operator-management-production/ol_reports/performance-report/<uuid-operador>/2026-08-26/performance-report_<uuid-operador>_2026-08-26.csv?X-Amz-Security-Token=<REDIGIDO>&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260828T123259Z&X-Amz-SignedHeaders=host&X-Amz-Expires=604800&X-Amz-Credential=<REDIGIDO>&X-Amz-Signature=<REDIGIDO>",
    "date": "2026-08-26"
  }
]
```

Contrato do endpoint:

- **Array na raiz** — sem envelope (`{data:…}`, `{urls:…}`). Um objeto por dia do intervalo.
- Cada item: `url` (string, S3 pré-assinada) e **`date` (string, `YYYY-MM-DD`)**.
- `X-Amz-Expires=604800` — a assinatura vale 7 dias.
- 🟢 **O campo `date` dispensa parsear nome de arquivo.** É ele que identifica o dia de cada
  CSV, nomeia o arquivo local (`<tipo>_<date>.csv`) e vira `data_referencia` na importação.
  Confirma de forma independente a granularidade diária de `dec-026`: N dias ⇒ N itens.

Headers enviados pelo app (capturados por interceptor de `XMLHttpRequest`):

| Header | Valor medido |
|---|---|
| `X-IFood-Logistics-Auth` | `"true"` — **é uma flag, não um token** |
| `x-cookie-login` | `"true"` — **também flag** |
| `X-Timezone` | `America/Sao_Paulo` |
| `Accept-Language` | `pt` |
| `x-country` | `BR` |
| `Accept` | `application/json, text/plain, */*` |

**Autenticação real = cookie httpOnly.** Provas:
- `localStorage`/`sessionStorage`/`redux` **não contêm token** — só `userData`
  (`userUuid`, `name`, `roles`, `resources`, `sub`), `permissions`, `lastLoginDate`,
  `isFederatedUser`.
- `fetch` sem os headers → `401 {"message": "no jwt token"}`.
- `fetch` com os headers + `credentials:'include'`, feito do console → ainda `401`.
  ⚠️ **NÃO VERIFICADO** por que o XHR do app passa e o fetch do console não
  (candidatos: PerimeterX, `withCredentials` do axios, ordem/origem da requisição).
  Resolver na implementação — o caminho seguro é chamar a API **de dentro da página**
  (`page.evaluate`), herdando a sessão do browser.

## 4. O arquivo baixado

Downloads reais observados (2 execuções, intervalo de 1 dia):

```
s3.amazonaws.com/logistics-operator-management-production/ol_reports/
  performance-report/<uuid-operador>/2026-08-26/performance-report_<uuid>_2026-08-26.csv
  finance-report/<uuid-operador>/2026-08-26/finance-report_<uuid>_2026-08-26.csv
```

- **É CSV puro, não ZIP.** O `<uuid-operador>` é o mesmo nos dois (identifica a franquia).
- **Dentro do `bundle.zip` o arquivo se chama `AAAA-MM-DD.CSV`** (informado pelo operador
  em 2026-08-27, não medido por mim — o caminho da API entrega o CSV direto e não passa
  pelo ZIP). Duas consequências materiais:
  1. **Performance e Financeiro do mesmo dia têm nome IDÊNTICO.** Renomear no download
     não é conveniência — sem isso um sobrescreve o outro. Sugestão:
     `<tipo>_<AAAA-MM-DD>.csv`.
  2. **Um range de N dias produz N arquivos**, um por dia — não um arquivo com N dias
     dentro. Bate com o endpoint se chamar `/urls` (plural) e com `data_referencia` do
     hub ser data única. Logo: **uma importação por dia, por tipo** — um range de 5 dias
     são 10 chamadas ao POST, não 2.
  3. ⚠️ Decorrência: um `bundle.zip` multi-dia tem >1 entrada e seria **rejeitado** pelo
     hub (`hub-import-zip.js` exige exatamente 1). Não afeta a rotina diária (D-1, 1 dia),
     mas afeta reprocessamento manual de range pela tela.
- A URL do S3 é pré-assinada: `X-Amz-Expires=604799`/`604800` (~7 dias) — o download em
  si **não precisa de autenticação nenhuma**.
- Os nomes já são distintos por tipo, mas contêm UUID (ruim para leitura humana).

## 5. Divergências vs. a descrição inicial do operador

Registradas para não virarem requisito falso:

1. **"download zip com nome bundle"** — esclarecido pelo operador em 2026-08-27: o
   `bundle.zip` é montado **no cliente**. O endpoint se chama `/urls` (plural), devolve
   N URLs do S3, e o front baixa e empacota num ZIP. Com intervalo de 1 dia há 1 CSV
   dentro. **Pela API o robô pega o CSV direto e o ZIP deixa de existir no caminho** —
   e, se um dia vier ZIP, o hub aceita ZIP de exatamente 1 entrada.
2. **"digitar o dia anterior nos dois campos data"** — os campos são `readOnly`, não
   aceitam digitação. Pela API o problema desaparece (parâmetro de querystring).
3. **Geração é assíncrona** — a tela mostra "Relatório em processamento" e depois
   "Relatório concluído!" com toast "Download de relatório concluído". Levou poucos
   segundos nos dois testes; ⚠️ **NÃO VERIFICADO** o tempo com volume alto.
4. **Nomenclatura**: o portal chama de "Financeiro"/`FINANCE`; o hub chama o mesmo tipo
   de **`faturamento`** (`lib/hub-import-parser.js:42`). O robô traduz.

## 6. Proteção anti-bot (risco material)

Cookies/chaves presentes na sessão:

- **PerimeterX / HUMAN Security**: `_px3`, `_pxvid`, `pxcts`, `pxsid`,
  `PXM0w7HcDf_px_ff`, `PXM0w7HcDf_px_fp`, `PXM0w7HcDf_px_c_p_*`
- **Akamai Bot Manager**: `bm_sv`

**Evidência direta medida em 2026-08-28**: durante uma sessão de cliques automatizados na
tela de relatórios (selecionar tipo → escolher datas no calendário → Gerar Relatório), a
captura de rede registrou **5 POSTs para `collector-pxm0w7hcdf.px-cloud.net/api/v2/collector`**
— o coletor do PerimeterX — e **nenhuma** chamada à API do EntreGô ou ao S3. Não ficou
determinado se a chamada de relatório não chegou a disparar ou se ocorre em contexto fora do
alcance do script da página (ambas explicam o observado; ⚠️ **NÃO VERIFICADO** qual). O que
ficou claro é que **o anti-bot pontua ativamente interação automatizada**. A tentativa foi
interrompida de propósito para não arriscar a sessão/conta do operador.

Consequência: **login automatizado headless tem risco real de challenge.**
Contornar detecção de bot ou resolver CAPTCHA está fora de escopo por decisão
permanente — se o portal desafiar, a rotina **para e alerta**, não tenta driblar.

## 7. Fluxo de login — MAPEADO 2026-08-27

Medido ao vivo: o operador fez logout na janela normal e refez o login inteiro
digitando ele mesmo e-mail, senha e código. Nenhum segredo passou pelo agente — o
monitor instalado registrava **só URL, método e status**, nunca o corpo da requisição.

São **4 passos** (não 3 — há um modal intermediário que não constava na descrição
inicial), cada tela com rota própria:

| # | Rota | Elementos | API disparada ao avançar |
|---|---|---|---|
| 1 | `/` (o logout cai na raiz; `/login` também serve) | `input#email` (`type=email`, `name=email`, placeholder `Digite seu e-mail`) · `button[type=submit]` **Continuar** (`disabled` até preencher) · `label[for="email"]` | `GET /operation/users/validation/first-login` → 200 |
| 2 | `/login/password` | `input#email` (`data-testid="email"`) · `input#password` (`data-testid="password"`, placeholder `Digite sua senha`) · `button[type=submit]` **Continuar** · links `/forgot-password`, `/recovery-email`, `/login` | `POST /operation/users/authentication/validate` → 200 — **é esta chamada que dispara o e-mail com o código** |
| 3 | modal sobre `/login/password` | texto "Um código de validação foi enviado para o e-mail …" · `button[type=submit]` **OK, entendi** | nenhuma |
| 4 | `/login/code?email=<urlencoded>` | `input#code` (`name=code`, **`maxlength=6`**, `inputmode=numeric`, placeholder `Digite o código`) · `button[type=submit]` **Confirmar** | `POST /operation/users/authentication/token` → 200 — **estabelece a sessão**; em seguida `GET /operation/users/authentication/me` e `GET /operation/users/permissions/logged-user`, ambos 200 |

Base de todas as rotas de API: `https://api.entregolog.com/logistics-web-bff`.

Detalhes que importam para o robô:

- **O código é um campo único de 6 dígitos numéricos**, não seis caixinhas separadas —
  preenchimento trivial (`fill`), sem varrer inputs.
- **Nenhum campo do login é `readOnly`** (ao contrário dos campos de data da tela de
  relatórios) — todos aceitam digitação direta.
- Os botões só habilitam depois do campo preenchido: esperar por `:not([disabled])`
  em vez de clicar imediatamente.
- O modal do passo 3 **não tem `role="dialog"`** (nenhum elemento com role de diálogo
  na página) — localizar o botão pelo texto `OK, entendi`.
- O e-mail viaja na **querystring** da rota do código. É o app da plataforma que faz
  isso, não o robô; não replicar esse padrão do nosso lado.
- Após o passo 4 o app redireciona para `/supply/driver-booking-import` e
  `localStorage.redux.authentication.userData` passa a existir — **sinal barato e
  confiável de "estou logado"** para o robô decidir se precisa relogar.
- ⚠️ **NÃO VERIFICADO**: quanto tempo a sessão dura. É o número que decide se o
  relogin (e portanto o IMAP + o risco de challenge do PerimeterX) é diário ou raro.
  Só se descobre observando ao longo dos dias — medir antes de fixar a frequência.

## 8. Ponta de destino (já existe, não precisa ser construída)

`POST /api/v1/importacoes` (router em `routes/hub-importacoes.js:215`, montado em
`server.js:2836`; autenticação por cookie `hub_accessToken`).

> ⚠️ Correção 2026-08-27: versões anteriores deste documento diziam
> `POST /hub/importacoes` — path errado, o prefixo real do mount é `/api/v1`.
- `multipart/form-data` com `tipo` ∈ `faturamento` | `performance` e o arquivo
- aceita `.csv` **ou** `.zip` com exatamente 1 entrada (`lib/hub-import-zip.js`)
- dedupe por `UNIQUE(id_empresa, tipo, hash_sha256)` — reenviar o mesmo arquivo não duplica
- escopo pela **entidade ativa do token**, nunca pelo corpo — o robô precisa de um
  usuário de serviço com `importacoes.criar` na entidade certa

## 8. "Dados da pessoa entregadora" (hub-motorista-360 FASE 5) — NÃO LEVANTADO

⚠️ **Diferente de tudo acima.** As seções 1-7 cobrem o fluxo de RELATÓRIOS
(Performance/Financeiro, já em produção desde 2026-08-28). A feature
`hub-motorista-360` (FASE 5, FR-005/FR-016) precisa de um fluxo NOVO e
DISTINTO: buscar o CADASTRO (CPF, RG, contato de emergência, ...) de UMA
pessoa entregadora específica, por UUID.

- **Endpoint do BFF: não levantado.** Nenhuma sessão de inspeção de Network
  (mesma metodologia de §1-7, com o operador logado via Claude in Chrome) foi
  feita para este fluxo. `src/busca-pessoa-entrego.js` implementa SÓ a
  navegação de UI (os 6 XPaths ditados pelo operador,
  `docs/plans/hub-motorista-360/BRIEFING-INPUT.md` linhas 41-48) — via de API
  fica `[PROPOSTA]` até esta seção ser preenchida com um achado real.
- **Seletores de campo da página de detalhe: não levantados.** Os 6 XPaths
  só cobrem a navegação ATÉ a página "Dados da pessoa entregadora" — nenhuma
  fonte documenta os seletores dos campos individuais (nome, CPF, RG, nome da
  mãe/pai, contato de emergência, operador logístico, modal) DENTRO dela. Por
  isso `busca-pessoa-entrego.js#extrairDadosPessoaPlaceholder` lança
  `ErroExtracaoNaoLevantada` em vez de adivinhar — Constitution VI (Zero
  Fabricação) proíbe supor DOM de sistema externo nunca inspecionado.
- **Risco operacional de fazer esse levantamento**: a sessão EntreGô é
  COMPARTILHADA com a importação diária (robô real, timers 11h/13h/14h) e
  com a busca sob demanda — o mesmo §6 acima (PerimeterX pontuando interação
  automatizada) se aplica aqui. O levantamento MUST seguir a MESMA
  metodologia já usada nesta seção: sessão operador-supervisionada (Claude in
  Chrome com o operador logado), FORA das janelas do robô, com o mesmo
  cuidado de interromper se houver qualquer sinal de challenge.
- **Próximo passo (task 5.3.1, ainda pendente)**: navegar os 6 passos com o
  operador logado, inspecionar a aba Network à procura de uma chamada de API
  equivalente a `.../operation/logistics-operator/...` para o cadastro da
  pessoa, E inspecionar o DOM renderizado da página de detalhe para
  documentar os seletores reais dos campos. Preencher esta seção com o
  achado (endpoint OU seletores confirmados) ANTES de substituir
  `extrairDadosPessoaPlaceholder` por uma implementação real.
