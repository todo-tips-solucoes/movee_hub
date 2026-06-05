# Brief — App Motorista (PWA): Consulta de NF & Validação de XML

> Documento de discovery/entrada para o pipeline SDD do cstk (`/specify` / `/feature-00c`).
> Capturado em 2026-06-04. Branch: `feature/app-motorista-nfse`.

## Objetivo

Aplicação **mobile (PWA instalável)** para que **motoristas** consultem o **valor da nota
fiscal** referente ao período de pagamento, e possam **subir e validar** sua NFS-e em XML
direto pelo app.

## Requisitos funcionais (do solicitante, verbatim resumido)

### Consulta de valores
- Acesso via celular, com opção de **instalar como PWA**.
- Exibir, de acordo com o **movimento em aberto** (`mov_fechado = false`):
  - `valor` (Valor)
  - `dt_inicial` e `dt_final` (período de apuração)
  - `nome` (Nome)
  - `cnpj_tomador` (CNPJ Tomador)
  - `cnpj_prestador` (CNPJ Prestador)
  - `tribnac` (TribNac)

### Upload e validação de XML
- Botão para **subir a nota em XML**.
- Botão que valida a nota chamando a API:
  - **Endpoint:** `https://fastapihomologacaonexus.todo-tips.com/validade_nfse`
  - **Parâmetros:** `xml_input` (conteúdo do XML), `validar_descricao_servico = false`, `nexus = false`
  - **Retorno:** JSON (array). Exemplo:
    ```json
    [
      {
        "valid": true,
        "details": {
          "valid_cnpj_prestador": true,
          "valid_cnpj": true,
          "valid_descricao_servico": true,
          "valid_valor": true,
          "valid_trib_nac": true,
          "valid_trib_mun": true,
          "valid_dCompet": true
        }
      }
    ]
    ```
- O app deve **interpretar o JSON** e dar o retorno ao motorista:
  - **Se válida ("nota ok"):** mostrar sucesso e **bloquear o reenvio** de outro XML.
  - **Se inválida:** mostrar **na tela quais campos estão errados** (os `details.*` com `false`)
    e instruir o motorista a **cancelar a nota e emitir uma nova** com os campos corretos.

### Acesso / login
- **Tela de login** com credenciais para acessar o app.

### Atalho externo
- Botão de **fácil acesso** ao **site oficial de emissão de NF do estado de São Paulo**.

## Requisitos não-funcionais
- Segurança, boas práticas de desenvolvimento, **escalabilidade** e **disponibilidade**.

---

## Recomendação de stack (proposta — a confirmar no `/clarify`)

> Princípio norteador: **reaproveitar a stack já em produção** no `movee_hub` (ver
> `docs/constitution.md`) — mesma forma de auth, proxy, deploy — para ganhar segurança,
> consistência e velocidade, atendendo o requisito de PWA.

### Frontend (PWA) — **Next.js 16 + TypeScript + Tailwind + shadcn/ui + Serwist**
- Mesma base do `frontend_v2` (reuso de componentes, padrões e do proxy de cookies).
- **PWA** via **Serwist** (sucessor do next-pwa para Next 15/16): `manifest.json`, service
  worker, instalável no celular, shell offline.
- Mobile-first; telas: Login, Dashboard (valores do movimento), Upload & Validação.

### Backend — **Node.js / Express** (consistente com o backend atual)
- Expõe endpoints **escopados ao motorista**, lendo do **PostgREST** (tabela `EnvioMassa`).
- **Auth JWT em cookie httpOnly** (Constituição I) — tela de login emite os cookies.
- **Proxy server-side** da validação: o browser NÃO chama a FastAPI direto; o backend
  encapsula a chamada a `validade_nfse` (Constituição III — sem expor a integração ao cliente,
  evita CORS e centraliza tratamento de erro). O frontend_v2 já faz isso via `/api/*`.
- Persistir o resultado da validação (ex.: `nota_ok` / `erro_validacao` na `EnvioMassa`) para
  suportar a regra "se nota ok, não reenviar".

### Dados / Deploy / Disponibilidade
- **PostgREST** como camada de dados (já existente).
- **Docker + Traefik + DNS** próprio (Constituição V), **réplicas no Swarm** para
  disponibilidade e escala horizontal (backend stateless graças ao JWT).

### Alternativa considerada
- React + Vite (PWA plugin) ou Expo/React Native — descartadas: PWA foi pedido
  explicitamente e o alinhamento com Next.js do `frontend_v2` maximiza reuso.

---

## Perguntas em aberto (para o `/clarify`)

1. **Identidade do motorista:** o login é com contas `Empresa` já existentes, ou há uma
   **entidade Motorista** nova? Qual credencial (CPF/CNPJ + senha? e-mail?)?
2. **Escopo dos dados por motorista:** como um motorista mapeia para registros da
   `EnvioMassa`? Por `cnpj_prestador`? Por vínculo com a empresa?
3. **Persistência do "nota ok":** onde gravar o status validado — `EnvioMassa.nota_ok` e os
   campos de erro em `erro_validacao`? A regra de bloqueio de reenvio lê desse estado?
4. **Formato do `xml_input`:** o backend atual monta `JSON.stringify({filename, data})` ao
   chamar a validação. Confirmar o shape exato esperado por `validade_nfse`.
5. **URL do portal de emissão SP:** é a **NFS-e municipal de São Paulo**
   (`https://nfe.prefeitura.sp.gov.br`), a **NFS-e nacional** (`https://www.nfse.gov.br`), ou
   outro portal? Confirmar a URL exata do botão.
6. **Seleção de período:** mostrar só o movimento aberto atual, ou permitir escolher período?
7. **Mapeamento dos campos de erro → mensagem:** texto amigável por flag (`valid_valor`,
   `valid_trib_nac`, etc.) que o motorista verá.
