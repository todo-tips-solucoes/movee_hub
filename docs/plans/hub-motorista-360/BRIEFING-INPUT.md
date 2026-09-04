# Briefing de entrada — `hub-motorista-360`

**Origem**: pedido do operador na invocação `/feature-00c` de 2026-09-03.
**Fonte de TODO o conteúdo abaixo**: o texto do operador + três screenshots
anexados na mesma mensagem. Nada aqui foi inferido ou completado por conta
própria — ver "Lacunas conhecidas" no fim, que lista o que **não** foi dito e
portanto **não pode ser suposto** (Constitution §VI).

> ⚠️ **Sem dado pessoal neste arquivo, por decisão do operador (2026-09-03).**
> A primeira versão transcrevia os valores reais que apareciam nos screenshots —
> CPF, RG, nome completo, nome da mãe e do pai, e-mail e telefones de um
> entregador real e de seu contato de emergência. O gate `owasp-security` da
> fase `plan` classificou isso como achado CRITICAL e o histórico da branch foi
> reescrito antes de qualquer push (nada chegou ao remoto). As tabelas abaixo
> descrevem **formato e estrutura** de cada campo, que é o que a spec precisa;
> os valores reais nunca voltam para o versionamento.
>
> **Os screenshots ficam FORA do git**, em
> `arquivos_complementares/hub-motorista-360-evidencias/` (untracked e
> explicitamente ignorado), porque a PII neles é parte da imagem e não pode ser
> mascarada por edição de texto.

> A `descricao_curta` gravada no state está truncada em 453 caracteres pelo
> limite do contrato `feature-00c`. **Este arquivo é o briefing íntegro** e é a
> fonte que `specify` deve consumir.

---

## Objetivo

Enriquecer o cadastro de motorista no hub para que ele se torne o sistema
principal quando o **envio-massa legado sair do ar** (declarado pelo operador
como próximo passo, sem data informada).

Três frentes, uma feature só:

1. **Raspagem EntreGô** — capturar da plataforma EntreGô, por UUID do motorista,
   os campos das seções Dados pessoais, Documentos (RG e CNH), Contato de
   emergência e Informações de entrega.
2. **CNPJ do legado** — trazer para o hub o atributo de CNPJ que hoje existe
   apenas no envio-massa legado.
3. **Vínculo da credencial de acesso** — hoje, quando o motorista se cadastra no
   app do motorista, a credencial **não** se vincula ao motorista do hub. Isso
   precisa ser corrigido.

---

## Frente 1 — Raspagem da plataforma EntreGô

### Passo a passo de navegação (XPaths ditados pelo operador)

Todos os XPaths abaixo vieram literalmente do operador. Nenhum foi verificado
contra a plataforma real.

| # | Ação | XPath |
|---|------|-------|
| 1 | Abrir o menu | `/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[1]/div[1]/div/div[2]/span` |
| 2 | Item **"Busca de Pessoas"** | `/html/body/div[1]/div/div/div[2]/div/div/div/div/div[2]/div[2]/div[8]/div[1]/div/div[2]/span` |
| 3 | Botão **"Filtro"** (abre os parâmetros) | `/html/body/div[1]/div/div/div[2]/main/div/div[1]/div[2]/button/span` |
| 4 | Campo do **UUID do motorista** | `/html/body/div[2]/div/div[1]/form/div[1]/div[5]/div[1]/div/input` |
| 5 | Botão **"Aplicar Filtros"** | `//*[@id="pomodoro-modal-root"]/div/div[1]/form/div[2]/button[2]` |
| 6 | Botão **"Ver detalhes"** na linha do motorista | `/html/body/div[1]/div/div/div[2]/main/div/div[3]/table/tbody/tr/td[5]/button` |

Após o passo 6 abre-se a página **"Dados da pessoa entregadora"**.

> **Estes XPaths são plano B, não o mecanismo principal.** O robô já em operação
> (`infra/robo-entrego/src/entrego-portal.js:7-13`) estabelece que *"TODA chamada
> ao BFF do portal roda dentro do `page.evaluate()` (herda cookies/fetch do
> browser)… A UI só é tocada no fluxo de login (não há alternativa); o fetch de
> relatórios usa a API diretamente, minimizando interação com a página
> (evidência de PerimeterX no achado §6)"*. A via preferida é a API do BFF; a
> navegação por XPath fica como fallback declarado.

### Campos a capturar

Escopo definido pelo operador: **todos** os campos das seções Dados pessoais,
Contato de emergência e Informações de entrega; da seção Documentos, **apenas**
RG e CNH.

#### Seção "Dados pessoais" (todos)

| Rótulo na tela | Formato observado |
|---|---|
| Nome completo | texto livre, capitalização mista |
| Data de nascimento | `DD/MM/AAAA` (campo com date picker) |
| E-mail | endereço de e-mail |
| CPF | `999.999.999-99` (11 dígitos, com máscara) |
| Nome da mãe | texto livre, **caixa alta** na origem |
| Nome do pai | texto livre, **caixa alta** na origem |
| Telefone (com DDD) | `(99) 99999-9999` |

#### Seção "Documentos" (somente RG e CNH)

| Rótulo na tela | Formato observado |
|---|---|
| RG | `99.999.999-9` (com máscara) |
| CNH | mesmo tipo de campo — **veio VAZIO no exemplo observado**; tratar ausência como caso normal, não erro |

> A seção Documentos também exibe fotos ("Confira os números de documentos e
> fotos"). **Fotos estão fora do escopo declarado** — o operador pediu
> explicitamente só RG e CNH.

#### Seção "Contato de emergência" (todos)

| Rótulo na tela | Formato observado |
|---|---|
| Grau de parentesco | **enum** em inglês maiúsculo (valor observado: `SPOUSE`) |
| Nome completo | texto livre, capitalização mista |
| Telefone (com DDD) | `(99) 99999-9999` |

#### Seção "Informações de entrega" (todos)

| Rótulo na tela | Formato observado |
|---|---|
| Operador Logístico | **enum** maiúsculo com underscore (valor observado: `FRANQUIA_MOVEE_SP`) |
| Modal atual | **enum** em inglês maiúsculo (valor observado: `BICYCLE`) |

Os três valores de enum acima são rótulos da plataforma, não dado pessoal — ficam
registrados de propósito, porque a spec precisa saber que esses campos vêm em
inglês/maiúsculas e podem exigir tradução na exibição.

#### Elemento adicional do cabeçalho

A página exibe um badge no canto superior direito com o valor `Frota OL`. O
operador não o citou na lista de campos; fica como observação, não como campo a
capturar.

---

## Frente 2 — CNPJ vindo do envio-massa legado

O operador pediu: "trazer o atributo de cnpj que está no envio massa legado para
o hub".

Nenhuma tabela, coluna ou rota foi nomeada pelo operador. O que o repositório já
registra (`CLAUDE.md`, memória do projeto) e que a fase `plan` deve **verificar
na fonte real** antes de afirmar qualquer coisa:

- a base `Motorista` do legado (pré-cadastro) tem `cnpj_prestador`, `nome`,
  `ativo`, e **não** tem coluna de empresa;
- a coluna de CNPJ **difere por tabela** — `Empresa.cnpj` vs
  `Motorista.cnpj_prestador` (bugfix registrado no PR #49). Não assumir o nome
  da coluna: conferir por tabela.

---

## Frente 3 — Vínculo da credencial de acesso

### Sintoma relatado

Citação do operador: *"A credencial de acesso não está vinculado aos motoristas
que já estão cadastrados no legado. (…) esse motorista no print da tela do hub
tem credenciais cadastradas no legado. Porém quando o motorista se cadastra no
app do motorista, ele não se vincula no hub também."*

### Evidência (screenshot fora do git, ver nota no topo)

Tela de detalhe do motorista no hub, para um motorista **já cadastrado e ativo**:

- Identificador: UUID do motorista no hub, exibido com botão de copiar
- Status: `Ativo`
- Lançamentos de faturamento e Turnos de performance: contadores preenchidos
  (dois dígitos) — ou seja, **motorista com histórico real de operação**
- Atividade mais recente: data recente
- Áreas (subpraças): uma subpraça atribuída
- Card **"Conta de acesso vinculada"**: *"Nenhuma conta de acesso vinculada."* +
  botão `Vincular`
- Card **"Credencial de acesso"**: *"Nenhuma credencial de acesso criada."* +
  botão `Criar credencial`

Ou seja: os dois cards existem e há ação manual (`Vincular` / `Criar
credencial`), mas o cadastro feito pelo motorista no app não os preenche
sozinho. O comportamento a acertar é o **vínculo automático**. O caso observado é
um **cadastro antigo**, o que torna a retroatividade parte do problema — e não
um detalhe.

---

## Destino na UI

Todos os campos das três frentes devem aparecer **na tela de detalhe do motorista
no hub**, a mesma que hoje mostra apenas identificador, contadores, subpraças e
os dois cards de acesso.

---

## Lacunas conhecidas — NÃO supor (Constitution §VI)

Registradas explicitamente para que `specify`/`clarify` as tratem como
`[NEEDS CLARIFICATION]` ou perguntem, em vez de preencher com invenção.
Status atualizado após o `clarify` (ondas 002/003):

1. ~~**Como a raspagem roda**~~ → **RESOLVIDO**: sob demanda por motorista, mais
   uma rotina **semestral** de atualização da base, com throttle (resposta do
   operador a `block-001`).
2. **Autenticação na plataforma EntreGô** → parcialmente resolvido: reusar a
   sessão persistida do robô (`/var/lib/hub_secrets/robo-entrego/entrego-session.json`,
   chmod 600), **sem credencial nova**.
3. ~~**Chave de casamento motorista↔EntreGô**~~ → o UUID já existe em
   `Entregador.id_externo`, populado pelo robô
   (`lib/hub-import-normalizer.js:267`).
4. ~~**Chave de vínculo credencial↔motorista**~~ → **RESOLVIDO**:
   `cnpj_prestador`. `ContaMotorista.cnpj_prestador` é `NOT NULL UNIQUE` global
   (migration 0021) e `routes/hub-motoristas.js:988` já vincula por ele; o UUID
   EntreGô é `UNIQUE (id_empresa, id_externo)` (migration 0010), único só por
   empresa, logo inadequado como chave global.
5. ~~**Retroatividade**~~ → **RESOLVIDO**: vínculo de credencial retroativo
   (backfill por CNPJ); enriquecimento EntreGô sob demanda.
6. **Nomes reais de colunas/rotas** → continuam a sair do código, das migrations
   ou de resposta real observada; nunca de suposição. Em particular, **não há
   evidência de endpoint do BFF da EntreGô que devolva os dados de cadastro da
   pessoa entregadora** — o robô só usa `/operation/users/authentication/me` e
   `/operation/logistics-operator/reports/<tipo>/urls`. Consultar
   `docs/plans/robo-entrego/ACHADOS-PORTAL.md` (fonte única de seletores e
   endpoints) e, se não estiver lá, marcar como
   `[PROPOSTA — a validar na implementação]`.
7. **Semântica dos enums** (`SPOUSE`, `BICYCLE`, `FRANQUIA_MOVEE_SP`) — se
   traduzir para exibição e qual o conjunto completo de valores: não informado.
8. ~~**Dados pessoais sensíveis**~~ → **RESOLVIDO**: permissão dedicada,
   concedida somente a `admin_entidade` e `admin_plataforma`, no padrão granular
   de `motoristas.credencial` (migration 0044). Perfil `leitura` vê o motorista,
   mas não os dados pessoais.

---

## Evidências (fora do versionamento)

Em `arquivos_complementares/hub-motorista-360-evidencias/` — contêm PII visível
na imagem e por isso não são versionadas:

| Arquivo | O que mostra |
|---|---|
| `entrego-dados-pessoais-documentos.png` | Página "Dados da pessoa entregadora" — seções Dados pessoais e Documentos |
| `entrego-emergencia-entrega.png` | Mesma página — seções Contato de emergência e Informações de entrega |
| `hub-detalhe-motorista-atual.png` | Tela de detalhe do motorista no hub, hoje, com os dois cards de acesso vazios |
