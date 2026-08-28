# Contract — Portal EntreGô (franqueado, externo)

Fonte: `docs/plans/robo-entrego/ACHADOS-PORTAL.md` (medição ao vivo, 2026-08-27,
Claude in Chrome, operador logado). Tudo abaixo é o que foi MEDIDO — não é um
contrato publicado pela plataforma parceira; é o comportamento observado, sujeito a
mudar sem aviso (é um portal de terceiro, não nosso). Base de todas as rotas de API:
`https://api.entregolog.com/logistics-web-bff`.

Todas as chamadas abaixo MUST ser feitas via `page.evaluate()` dentro de um contexto
Playwright com sessão herdada — nunca via HTTP client fora do browser (research.md
Decision 2).

---

## Login — 4 passos (nenhum é chamado diretamente pelo robô fora de um form real;
o robô preenche os campos e clica, deixando a página disparar as chamadas)

### Passo 1 — `GET /operation/users/validation/first-login`

Disparado ao clicar **Continuar** na tela `/` (ou `/login`) após preencher
`input#email`. Resposta: `200`. Avança para `/login/password`.

### Passo 2 — `POST /operation/users/authentication/validate`

Disparado ao clicar **Continuar** em `/login/password` após preencher
`input#email` (`data-testid="email"`) e `input#password`
(`data-testid="password"`). Resposta: `200`. **É esta chamada que dispara o e-mail
com o código de acesso** — o robô MUST capturar o timestamp exato do disparo desta
chamada para filtrar a mensagem de e-mail correta (nunca reaproveitar código de
e-mail recebido antes deste timestamp).

### Passo 3 — modal (sem chamada de API)

Modal sobre `/login/password`, sem `role="dialog"` — localizar o botão pelo texto
**"OK, entendi"**.

### Passo 4 — `POST /operation/users/authentication/token`

Disparado ao clicar **Confirmar** em `/login/code?email=<urlencoded>` após
preencher `input#code` (`name=code`, `maxlength=6`, `inputmode=numeric`) com o
código de 6 dígitos lido por IMAP. Resposta: `200` — **estabelece a sessão**. Em
seguida a própria página dispara `GET /operation/users/authentication/me` e
`GET /operation/users/permissions/logged-user` (ambos `200`) — o robô pode reusar
`GET .../authentication/me` como sonda de "sessão ainda válida" nas próximas
execuções (research.md Decision 3), sem precisar refazer o formulário de código.

**Sinal de sucesso**: após o passo 4, `localStorage.redux.authentication.userData`
passa a existir — sinal barato de "estou logado".

**Sinal de possível desafio anti-bot**: qualquer um dos passos acima não completar
dentro de um timeout razoável (elemento esperado não aparece, botão não habilita),
OU a resposta de qualquer uma das 3 chamadas POST/GET acima vier com corpo/status
fora do documentado aqui. A ASSINATURA EXATA de uma resposta de desafio
PerimeterX/Akamai **não foi observada** durante o levantamento (as chamadas cobertas
sempre tiveram sucesso) — não inventar um formato de detecção específico; tratar
qualquer desvio estrutural como suspeita e seguir FR-011 (parar + alertar, nunca
tentar interpretar ou repetir).

---

## `GET /operation/logistics-operator/reports/{TIPO}/urls`

**Auth**: sessão de cookie httpOnly do portal (herdada pelo `page.evaluate`).
**Path param + query**: `{TIPO}` ∈ `PERFORMANCE` \| `FINANCE` (aparece tanto no path
quanto na query `type`).

```
GET https://api.entregolog.com/logistics-web-bff/operation/logistics-operator/reports/{TIPO}/urls
    ?type={TIPO}&initialDate=YYYY-MM-DD&finalDate=YYYY-MM-DD
```

**Headers observados** (enviados pelo app; reproduzir os mesmos dentro do
`page.evaluate`, já que o contexto do browser os aplica automaticamente para
requisições same-origin/app — não é o robô que precisa montá-los manualmente):
`X-IFood-Logistics-Auth: "true"` (flag, não token), `x-cookie-login: "true"` (flag),
`X-Timezone: America/Sao_Paulo`, `Accept-Language: pt`, `x-country: BR`,
`Accept: application/json, text/plain, */*`.

**Response `200`**: devolve N URLs pré-assinadas do S3 (achado §3-4). Formato exato
do corpo JSON **não foi registrado** no levantamento (só os headers de request e o
destino final das URLs foram capturados) — a implementação MUST inspecionar a
resposta real na primeira execução de teste antes de assumir um shape de parsing.

**Geração assíncrona**: a tela mostra "Relatório em processamento" → "Relatório
concluído!"; levou poucos segundos nos 2 testes realizados. Tempo com volume alto
**não verificado** — o robô MUST aguardar com timeout generoso e tratar estouro
como falha de tentativa (FR-004), não como sucesso silencioso.

---

## Download do CSV (S3, fora do portal)

```
https://s3.amazonaws.com/logistics-operator-management-production/ol_reports/
  performance-report/<uuid-operador>/<data>/performance-report_<uuid>_<data>.csv
  finance-report/<uuid-operador>/<data>/finance-report_<uuid>_<data>.csv
```

**Auth**: NENHUMA — URL pré-assinada (`X-Amz-Expires` ~604800s/7 dias). Pode ser
baixada com HTTP client puro (axios), **fora** do contexto Playwright — não há
sessão de portal envolvida neste passo.

**Formato**: CSV puro (não ZIP — o `bundle.zip` visto na UI é montado no CLIENTE
pelo próprio app; a API devolve o CSV direto). Cabeçalho/colunas internas **não
verificados** neste levantamento (research.md Decision 10).

**Response de erro esperada**: se a URL expirar ou for inválida, S3 responde com XML
de erro padrão AWS (`<Error><Code>...`) — não JSON. O robô MUST detectar `Content-Type`
não-CSV antes de tentar enviar o corpo para o hub.
