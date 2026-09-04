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


## 9. "Dados da pessoa entregadora" (hub-motorista-360 FASE 5) — MAPEADO 2026-09-04

Levantado **no portal real**, com o operador logado, via Claude in Chrome —
mesma metodologia de §1-7. Tudo abaixo foi **medido**. O que não foi medido
está marcado **⚠️ NÃO VERIFICADO**.

> **Nenhum valor de dado pessoal foi registrado neste documento.** O payload
> foi inspecionado por uma função que classifica cada campo por FORMATO
> (`string<email>`, `string<11-digitos>`, `enum<...>`) e nunca devolve o
> conteúdo. Os enums são rótulos da plataforma, não PII, e por isso aparecem
> literais.

### 9.1 Rotas da SPA (dispensam a navegação por XPath)

| Tela | Rota | Como se chega |
|---|---|---|
| Busca de Pessoas | `/supply/driver-list` | menu `Operador logístico` → `Busca de Pessoas` |
| Detalhe da pessoa | **`/supply/driver-list/{uuid}`** | clique em `Ver detalhes`, **ou URL direta** |

🟢 **A URL direta do detalhe funciona** — testada com `navigate` puro, sem
passar por menu/filtro/tabela. Os 6 XPaths do briefing
(`docs/plans/hub-motorista-360/BRIEFING-INPUT.md`) tornam-se **desnecessários**
para o caminho feliz: basta `GET /supply/driver-list/{uuid}` (ou, melhor
ainda, a API de §9.3).

### 9.2 Seletores do filtro (quando a UI for necessária)

O XPath do campo de UUID ditado no briefing **NÃO bate** com a página real.
Os `id`/`name` abaixo foram medidos e são estáveis:

| Campo | Seletor | placeholder |
|---|---|---|
| Nome completo | `#fullName` | `Digite o nome da pessoa` |
| Email | `#email` | `Digite um email válido` |
| Telefone | `#phone` | `Digite um telefone válido` |
| UUid | **`#uuid`** | `Digite um UUid válido` |

Botões por texto: `Filtros`, `Limpar filtros`, `Aplicar filtros`.
O botão da linha da tabela: `Ver detalhes`.

⚠️ O input é controlado por React — atribuir `.value` direto não sensibiliza o
estado. Usar o setter nativo (`Object.getOwnPropertyDescriptor(
HTMLInputElement.prototype,'value').set`) + `dispatchEvent(new Event('input',
{bubbles:true}))`, como já feito no levantamento.

### 9.3 A API do BFF (o caminho recomendado)

```
GET https://api.entregolog.com/logistics-web-bff/operation/logistics-operator/drivers/{uuid}
```

- Status medido: **200**. Preflight `OPTIONS` respondido **200**.
- Busca (usada pelo filtro da listagem, não necessária se já se tem o uuid):
  `POST .../operation/logistics-operator/drivers/search` → **201**.
- Mesmos headers de §3 (`X-IFood-Logistics-Auth: true`, `x-cookie-login: true`,
  `X-Timezone`, `Accept-Language`, `x-country`) + `credentials: 'include'`,
  chamado **de dentro da página** (`page.evaluate`) — idêntico ao que
  `entrego-portal.js` já faz para relatórios.
- 🟢 **Uma única chamada alimenta a página de detalhe inteira.** Não há
  endpoint secundário (verificado: nenhuma outra requisição a
  `logistics-web-bff` durante o carregamento).

### 9.4 Estrutura da resposta (chaves e formatos — sem valores)

```
{
  uuid: string<uuid>,
  personalData: {
    fullName:   string,
    birthdate:  string<YYYY-MM-DD>,     // a tela exibe dd/MM/yyyy — formatação é do front
    email:      string<email>,
    cpf:        string<11 dígitos>,     // SEM máscara; a máscara 999.999.999-99 é do front
    motherName: string,
    fatherName: string,                 // ⚠️ OMITIDA quando vazia — ver 9.5.3
    phone:      string                  // formato exibido "(99) 99999-9999"
  },
  documentDriver: {                  // ⚠️ FORMA VARIÁVEL — ver 9.5.3
    rg:                         string,        // caso RG
    identityDocumentFrontPhoto: string<url>,   // caso RG
    identityDocumentBackPhoto:  string<url>,   // caso RG
    cnh:                        string<11 dígitos>,  // caso CNH
    driverLicensePhoto:         string<url>,   // caso CNH
    workerPhoto:                string<url>    // nos dois casos
  },
  emergencyContact: {
    name:         string,
    phone:        string,
    relationship: enum   // valor observado: SPOUSE
  },
  lastDelivery: {
    logisticOperatorName: enum,      // valor observado: FRANQUIA_MOVEE_SP
    possibleModals:       [enum],    // valor observado: [BICYCLE]
    region:               string     // veio VAZIA no caso observado
  },
  currentModal: {
    modalName: enum,                 // valor observado: BICYCLE
    modalUuid: string<uuid>
  },
  quality: {
    cashOnDeliveryEnabled: boolean,
    reasonInactivation:    null
  }
}
```

### 9.5 Divergências vs. o briefing — registradas para não virarem requisito falso

1. **`cpf` vem SEM máscara** (11 dígitos). O briefing descreve
   `999.999.999-99` porque é o que a tela mostra; a formatação é do frontend.
   A importação deve normalizar, não assumir a máscara.
2. **`birthdate` vem em `YYYY-MM-DD`**, não `DD/MM/AAAA` (idem: a tela
   formata).
3. 🔴 **O payload tem FORMA VARIÁVEL — confirmado com 2 motoristas em
   2026-09-04.** Não é só "omite nulos": o conjunto de chaves muda conforme o
   documento e o modal da pessoa.

   | Chave | Caso A (modal `BICYCLE`) | Caso B (modal `MOTORCYCLE`) |
   |---|---|---|
   | `personalData.fatherName` | **ausente** | presente |
   | `documentDriver.rg` | presente | **ausente** |
   | `documentDriver.cnh` | **ausente** | presente (11 dígitos) |
   | `documentDriver.identityDocumentFrontPhoto` / `...BackPhoto` | presentes | **ausentes** |
   | `documentDriver.driverLicensePhoto` | **ausente** | presente |
   | `documentDriver.workerPhoto` | presente | presente |

   **Consequência obrigatória para a implementação**: NENHUM campo de
   `documentDriver` nem `personalData.fatherName` pode ser tratado como
   garantido. Ler com acesso opcional, gravar `null` quando ausente e
   **nunca falhar a importação por ausência** — uma implementação que
   assumisse `rg` e `cnh` sempre presentes quebraria em boa parte da base,
   porque ciclista tende a ter RG e motociclista, CNH.

   As chaves `fatherName`, `cnh` e `driverLicensePhoto` foram **medidas** no
   Caso B; a tela renderiza os rótulos "Nome do pai" e "CNH" nos dois casos,
   vazios quando a chave não vem.
4. **Campos ADICIONAIS que o briefing não pediu** (o escopo da feature é
   decisão do operador — aqui fica só o registro): as URLs de foto
   (`identityDocumentFrontPhoto`, `identityDocumentBackPhoto` e
   `driverLicensePhoto`, conforme o caso; `workerPhoto` sempre),
   `currentModal.modalUuid`, `lastDelivery.possibleModals`,
   `lastDelivery.region` e a seção `quality` (`cashOnDeliveryEnabled`,
   `reasonInactivation`).

   ⚠️ As fotos são **imagens de documento de identidade** — dado pessoal de
   sensibilidade ainda maior que os campos de texto. Se entrarem no escopo,
   o RBAC de `motoristas.dados_sensiveis` (`dec-017`) e a auditoria de
   leitura (FR-018) precisam cobri-las explicitamente.
5. **A tela tem 2 seções além das 4 do briefing**: `Qualidade` e
   `Cash on Delivery` (mapeadas em `quality`).

### 9.6 Anti-bot durante este levantamento

O collector do PerimeterX (`collector-pxm0w7hcdf.px-cloud.net/api/v2/collector`)
registrou POSTs durante a navegação, como em §6. **Nenhum challenge** foi
apresentado e nenhuma requisição foi bloqueada, nem na navegação de UI nem nas
duas chamadas diretas à API.

**Horários medidos** (registrados porque a proximidade com o robô é o risco
real desta seção, e no levantamento ela foi maior do que se pretendia):

| Evento | Horário |
|---|---|
| Execução do robô (timer das 11h) | `11:02:01` → `11:07:22`, `status=0/SUCCESS` |
| Levantamento no portal | entre `~11:10` e `11:45` |

Ou seja: o levantamento ocorreu **depois** da janela das 11h ter concluído e
**antes** da de 13h — não houve sobreposição, e a execução do robô daquela
janela terminou com sucesso. Registrado com precisão porque a primeira
redação desta seção afirmava genericamente "fora das janelas" partindo de um
horário suposto, não medido. **Para o próximo levantamento: conferir
`systemctl list-timers robo-entrego.timer` ANTES de começar**, não depois.
