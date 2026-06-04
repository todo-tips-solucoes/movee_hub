# Backend — Envio em Massa (Movee Hub)

API REST em **Node.js / Express** (`server.js`) que dá suporte ao app de envio em massa: autenticação, CRUD de movimentos, importação de planilhas, disparo de mensagens em lote (via n8n) e validação de XMLs de NFSe.

- **Porta:** `3000`
- **Persistência:** [PostgREST](https://postgrest.org) (tabelas `Empresa`, `EnvioMassa`, `ProcessControl`)
- **Integrações:** n8n (processamento/disparo em lote) e um serviço FastAPI de validação de NFSe

## Como rodar

```bash
cp .env.example .env   # preencha os valores (ver tabela abaixo)
npm install
npm start              # http://localhost:3000
```

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `POSTGREST_URL` | URL base do PostgREST |
| `POSTGREST_API_KEY` | Chave de API (Bearer) do PostgREST |
| `JWT_SECRET` | Segredo do **access token** |
| `JWT_REFRESH_SECRET` | Segredo do **refresh token** |
| `N8N_API_TOKEN` | Token da API do n8n |
| `FASTAPI_VALIDATION_TOKEN` | Token (Bearer) do serviço de validação de XML |

## Autenticação

A autenticação é via **JWT em cookies httpOnly** — não há header `Authorization`:

- `accessToken` — validade **15 min** (`maxAge` 15 min)
- `refreshToken` — validade **7 dias**

Ambos são definidos no `POST /login` com `httpOnly`, `sameSite=Strict` e `secure` em produção. O middleware `authenticateToken` lê o cookie `accessToken`; sem ele → `401`, inválido → `403`.

> Como usa cookies, requisições do front precisam enviar credenciais (`credentials: 'include'` / `withCredentials: true`). O CORS está restrito às origens de homologação (`envmasshomologacao`, `envmassv2`) com `credentials: true`.

O payload do token carrega: `empresaId`, `nome_empresa`, `workflow_id`, `sender`, `tk`, `connection_id`. Endpoints autenticados sempre operam no escopo da `empresaId` do token.

---

## Endpoints

Legenda: 🔒 = exige cookie `accessToken` válido.

### Autenticação

#### `POST /login`
Body JSON: `{ "email": string, "password": string }`
Valida as credenciais (`bcrypt`), define os cookies `accessToken`/`refreshToken` e retorna os dados da empresa.
- **200** → `{ empresaId, nome_empresa, workflow_id, sender, tk, connection_id }`
- **400** email/senha incorretos · **500** erro de servidor

#### `POST /register`
Body JSON: `{ "nomeEmpresa": string, "email": string, "senha": string }`
Cria uma nova empresa (senha com hash `bcrypt`).
- **201** criado · **400** dados inválidos/duplicados · **500** erro

#### `POST /token/refresh`
Lê o cookie `refreshToken`, valida e emite um novo `accessToken` (cookie).
- **200** `{ message: "Token renovado" }` · **401** refresh ausente · **403** refresh inválido

#### `GET /verify-auth` 🔒
Confirma que o `accessToken` é válido (usado pelo front para checar a sessão).

#### `POST /logout`
Limpa os cookies `accessToken` e `refreshToken`. **200** `{ message: "Logout bem-sucedido" }`.

---

### Movimentos (tabela `EnvioMassa`)

Um "movimento" é o conjunto de registros com `mov_fechado = false` da empresa.

#### `GET /envio-massa` 🔒
Retorna todos os registros do **movimento em aberto** da empresa (`id_empresa = empresaId AND mov_fechado = false`).
- **200** → array de registros `EnvioMassa` · **400** erro ao buscar

#### `PATCH /update-envio-massa/:id` 🔒
Atualiza um registro. Body JSON (campos editáveis): `{ "enviado": bool, "mensagem": string, "tipo": string }`.
- **200** atualizado · **500** erro

#### `DELETE /envio-massa/:id` 🔒
Remove o registro `:id`. **500** em caso de erro.

#### `POST /close-movimento` 🔒
Fecha o movimento em aberto da empresa (marca `mov_fechado = true` em todos os registros abertos).
- **200** `{ message: "Movimento fechado com sucesso" }` · **500** erro

---

### Importação e exportação

#### `POST /upload` 🔒
`multipart/form-data` com o campo **`file`** (planilha **`.xlsx`**).
Lê a primeira aba da planilha, converte as linhas em registros e popula a `EnvioMassa` da empresa.
- **200** `{ success: true, ... }` · **400** arquivo ausente/inválido · **401** não autenticado · **500** erro

#### `GET /export-envio-massa` 🔒
Exporta o movimento em aberto da empresa em **CSV** (`json2csv`).
- **200** → arquivo CSV · **404** nada a exportar · **500** erro

#### `GET /download-xml-movimento` 🔒
Gera um **ZIP** (`archiver`) com os XMLs do movimento em aberto, considerando apenas registros **com `numnota` preenchido** e **sem `erro_validacao`**.
- **200** → arquivo ZIP · **404** nenhum registro elegível · **500** erro

---

### Processamento em lote (disparo de mensagens)

Controlado pela tabela `ProcessControl` (`status`: `active`/`inactive`); o disparo usa os dados do token (`tk`, `connection_id`) e integra com n8n.

#### `POST /start-process` 🔒
Marca o processo como `active` e inicia o envio em lote das mensagens (`processBatchMessages`).
- **200** `{ message: "Processo iniciado com sucesso!" }` · **500** erro (reverte para `inactive`)

#### `GET /process-status` 🔒
Retorna o estado do processo da empresa.
- **200** → `{ active: false }` ou `{ active: true, execution_id }`
- **500** erro

#### `POST /stop-process` 🔒
Marca o processo como `inactive`.
- **200** `{ message: "Processo parado com sucesso!" }` · **500** erro

---

### Validação de NFSe

#### `POST /validate-xml-batch` 🔒
`multipart/form-data` com o campo **`xmlFiles`** (array de até **100** XMLs).
Campo de body opcional: `validar_descricao_servico` (`"true"` para validar a descrição do serviço).
Para cada XML extrai os campos da NFSe (`xml2js`) — `cnpj_prestador`, `data_emissao`, `razao_social`, `valor_nota` — e valida contra o serviço FastAPI (autenticado com `FASTAPI_VALIDATION_TOKEN`).
- **200** → array de resultados por arquivo, com flags `valid`, `valid_cnpj`, `valid_descricao_servico`, `valid_valor`, `valid_trib_nac`, `valid_dCompet`, etc.
- **400** nenhum arquivo enviado

---

---

## App Motorista — Rotas `/motorista/*`

> Feature: `app-motorista-nfse` — PWA para motoristas consultarem valor de NF e validarem XML.
> Ref: `docs/specs/app-motorista-nfse/` (spec, contracts, research).

A autenticação do motorista usa cookies httpOnly **separados** dos cookies de Empresa. O claim `aud: 'motorista'` no JWT impede que tokens de Empresa funcionem nessas rotas e vice-versa.

**Variável de ambiente adicional:**

| Variável | Descrição |
|---|---|
| `JWT_SECRET` | Compartilhado com Empresa (audiência diferencia os escopos) |
| `JWT_REFRESH_SECRET` | Compartilhado com Empresa (idem) |
| `FASTAPI_VALIDATION_TOKEN` | Já existente — reutilizado aqui |

### Sessão do motorista

#### `POST /motorista/login`
Body JSON: `{ "cnpjPrestador": string, "senha": string }` (CNPJ aceita pontuação — normalizado internamente).
Busca `Motorista?cnpj_prestador=eq.{cnpj}` via PostgREST, valida senha bcrypt, checa `ativo`.
- **200** → `{ cnpjPrestador, nome }` + cookies `accessToken` (15min) / `refreshToken` (7d) httpOnly SameSite=Strict
- **400** campos ausentes · **401** credenciais inválidas (mensagem genérica — anti-enumeração) · **403** conta inativa

#### `POST /motorista/register` — auto-cadastro com guard
Body JSON: `{ "cnpjPrestador": string, "nome": string, "senha": string }` (senha ≥ 8 chars).
Guard 1: CNPJ deve existir em `EnvioMassa`. Guard 2: CNPJ não pode ter conta `Motorista` existente.
- **201** criado · **400** campos inválidos/senha curta · **409** CNPJ não elegível ou já cadastrado (mensagem idêntica — anti-enumeração)

#### `POST /motorista/token/refresh`
Lê cookie `refreshToken` de motorista, valida audiência `motorista`, emite novo `accessToken`.
- **200** `{ message: "Token renovado." }` · **401** token ausente · **403** inválido

#### `POST /motorista/logout` 🔒
Limpa cookies `accessToken` e `refreshToken`. **200** `{ message: "Logout bem-sucedido." }`.

#### `GET /motorista/verify-auth` 🔒
Confirma sessão ativa.
- **200** → `{ authenticated: true, nome, cnpjPrestador }` · **401** sem/inválido token

---

### Movimento e validação

#### `GET /motorista/movimento-aberto` 🔒
Consulta `EnvioMassa?cnpj_prestador=eq.{token}&mov_fechado=eq.false` (escopo exclusivo pelo token — Constituição II: nunca por parâmetro externo).
- **200** → `{ movimento: { id, valor, dtInicial, dtFinal, nome, cnpjTomador, cnpjPrestador, tribnac, notaOk, erroValidacao } }` ou `{ movimento: null }` quando sem movimento aberto.
- **401** sem auth · **500** erro de servidor

#### `POST /motorista/validar-nota` 🔒 — `multipart/form-data`
Campo: **`file`** — XML de NFSe (limite: 2 MB; apenas `text/xml`/`application/xml`/`.xml`).

Fluxo:
1. Valida XML bem-formado via `xml2js` (segurança XXE: xml2js ^0.4.x não resolve entidades externas por design).
2. Verifica existência de movimento aberto no escopo do token.
3. Bloqueia reenvio se nota já aprovada (`nota_ok = sim`) — FR-008.
4. Chama `POST https://fastapihomologacaonexus.todo-tips.com/validade_nfse` (multipart/form-data) com `xml_input=JSON.stringify([{filename,data}])`, `validar_descricao_servico=false`, `nexus=false`.
5. Persiste resultado em `EnvioMassa` (`nota_ok` / `erro_validacao`).

Respostas de sucesso:
- **200 valid:true** → `{ valid: true, notaOk: true, mensagem: "Nota ok! ..." }`
- **200 valid:false** → `{ valid: false, notaOk: false, camposInvalidos: [{campo, mensagem}], instrucao: "Cancele..." }`

Campos de `camposInvalidos` em pt-BR: `valid_cnpj_prestador`, `valid_cnpj`, `valid_descricao_servico`, `valid_valor`, `valid_trib_nac`, `valid_trib_mun`, `valid_dCompet`.

Erros:
- **400** sem arquivo ou XML inválido · **401** sem auth · **409** nota já aprovada ou sem movimento aberto · **502** serviço externo indisponível · **413** arquivo > 2 MB

---

### Tabela `Motorista` (PostgREST)

```sql
CREATE TABLE IF NOT EXISTS "Motorista" (
  id BIGSERIAL PRIMARY KEY,
  cnpj_prestador VARCHAR(14) UNIQUE NOT NULL,
  senha TEXT NOT NULL,              -- bcrypt hash
  nome TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Testes

```bash
npm test              # unit + integração (node:test nativo, sem jest)
npm run test:unit     # só unitários (23 testes)
npm run test:integration  # só integração (22 testes, mocks para PostgREST/FastAPI)
```

---

## Modelo de dados (resumo)

- **`Empresa`** — empresas/usuários (`id`, `email`, `senha` hash, `nome_empresa`, `workflow_id`, `sender`, `tk`, `connection_id`).
- **`EnvioMassa`** — registros do movimento (`id`, `id_empresa`, `nome`, `numnota`, `nota_ok`, `erro_validacao`, `enviado`, `mensagem`, `tipo`, `mov_fechado`).
- **`ProcessControl`** — controle do processamento por empresa (`user_id`, `status`, `execution_id`).

## Stack / dependências

`express`, `jsonwebtoken`, `bcrypt`, `cookie-parser`, `cors`, `multer`, `xlsx`, `xml2js`, `json2csv`, `archiver`, `axios`, `dotenv`.
