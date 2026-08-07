---
target: painel do hub (app/hub no frontend_v2) — rodada 4
total_score: 33
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-08-07T00-55-00Z
slug: app-homologacao-frontend-v2-app-hub
---
# Rodada 4 — Painel do Hub de Frota (registro pós-fix)

**O que este documento é:** registro da rodada 4 e da sua verificação viva. Como a rodada 3,
partiu dos resíduos já documentados (rodapé do registro anterior), **não** de uma crítica
dual-agent nova; a releitura de score é derivada do que mudou e foi medido.

⚠️ **Dívida de método**: o score não é medido por uma crítica independente desde o
critique #2 (2026-08-06). Duas rodadas derivando em cima de derivação. A rodada 5 deveria
ser uma crítica real antes de qualquer código — foi oferecido ao operador nesta rodada e
ele preferiu seguir com os fixes.

Escopo decidido com o operador: consistência + correção (A, B, C). O item D não estava no
escopo — apareceu durante a verificação.

## Releitura do Design Health Score — 33/40 (baseline: 30/40)

| # | Heurística | Score | O que mudou nesta rodada |
|---|-----------|-------|--------------------------|
| 1 | Visibilidade do status | 4 | — |
| 2 | Sistema ↔ mundo real | 4 (↑ de 3) | A paginação passou a dizer "Mostrando 21-40 de 156" em vez de "Página 2 de 8": o operador lê quantidade real, não coordenada interna. |
| 3 | Controle e liberdade | 4 (↑ de 3) | O Sheet de usuário parou de esconder que tem dois modos de persistência; alteração pendente é visível e o botão de sair diz que descarta. |
| 4 | Consistência | 5→ **cap 4** | Os dois idiomas de paginação viraram um: as 7 telas do hub usam o MESMO componente do painel legado. Fica em 4 porque o `envio_massa` segue com composição própria. |
| 5 | Prevenção de erro | 4 | — |
| 6 | Reconhecimento > memória | 4 (↑ de 3) | O último campo que exigia decorar ID (pessoa responsável) virou combobox por nome/e-mail na auditoria e nas importações. |
| 7 | Flexibilidade/eficiência | 3 | — (segue sem atalhos de teclado e sem "últimos filtros") |
| 8 | Estética/minimalismo | 3 | — (o cockpit do `envio_massa` continua aberto) |
| 9 | Recuperação de erros | 4 (↑ de 3) | O combobox de pessoa degrada sozinho no 403 em vez de quebrar o filtro de quem não tem permissão. |
| 10 | Ajuda e documentação | 3 | — |
| **Total** | | **33/40** | Trend: 25 → 26 → 30 → 33. |

## O que foi entregue

**A) Paginação com idioma único (h4, h2)** — **nenhum componente novo**. O
`PaginationControls` do painel legado já era o idioma rico (intervalo exibido, números de
página, `aria-current`, chevrons); só faltava o seletor de "N por página" ser opcional,
porque as telas do hub paginam server-side com `PAGE_SIZE` fixo. Uma prop opcional depois,
as 7 telas do hub (auditoria, importações, importações/[id], usuários, motoristas,
faturamento, performance) deixaram de reimplementar o próprio rodapé. A janela deslizante
de páginas saiu de dentro do componente para `janelaDePaginas()`, com teste — agora serve
9 telas.

**B) Persistência declarada no Sheet de usuário (h3/h9)** — os dois modos continuam
existindo (são rotas diferentes do backend); o que faltava era o painel dizer qual é qual.
"Dados do usuário" declara que valem no botão; "Vínculos" declara que valem no clique. Com
edição pendente, o rodapé avisa e o botão de sair passa a se chamar "Descartar e fechar".

**C) Combobox de pessoa com degradação (h6, h9)** — `GET /usuarios` exige
`usuarios.gerenciar`: garantido na auditoria, **ausente** para o papel `operador` nas
importações. Em vez de o chamador ter que saber disso, o componente detecta o 403 e vira o
campo de ID numérico de antes, com o mesmo contrato. Os dois chamadores ficam idênticos.
Deliberadamente **não** reusa o `EntregadorCombobox`: aquele resolve busca server-side com
debounce e descarte de resposta fora de ordem, para milhares de entregadores; usuários de
uma entidade são dezenas e cabem numa carga só.

**D) Rolagem horizontal do shell no celular** — fora do escopo combinado, encontrado na
verificação (ver abaixo).

## Verificação

- **Unit:** vitest 350/350 (era 336; +13 de `pagination-controls`, +6 do empate de presets,
  +8 do `UsuarioCombobox`). `tsc` limpo. `next build` verde.
- **Detector mecânico:** 0 achados nos 11 arquivos alterados.
- **E2E vivo:** **62/62** no hub-homolog rebuildado, via container oficial.
- **Lint:** os 5 erros restantes são pré-existentes no painel legado
  (`configuracoes/aparencia`, `configuracoes/grupo`, `empresa-selector`) — mesma linha de
  base da rodada 3, nenhum arquivo desta rodada.

### Dois achados da verificação viva que mudaram o produto

1. **Empate de presets de período (regressão latente da rodada 3).** O E2E rodou num dia 7
   e quebrou: quem clicava em "Este mês" via **"7 dias"** acender. Causa real — no dia 7,
   os dois presets produzem exatamente o mesmo intervalo (01..07), e a rodada 3 DERIVA o
   chip aceso a partir do par `de`/`ate`, devolvendo o primeiro que casa. Acontece também
   no dia 1º (Hoje × Este mês) e no dia 30 (30 dias × Este mês) — cerca de 3 dias por mês,
   em produção, desde a rodada 3. Corrigido com desempate pelo último chip clicado, que
   só vale enquanto ainda descreve o intervalo (nada é persistido). 6 testes novos.

2. **O shell rolava na horizontal em 390px.** O teste de mobile apontou 4px de estouro e a
   leitura fácil seria culpar a paginação nova. Medindo o DOM elemento a elemento, o
   culpado era o `#entity-switcher-trigger` do header — e reproduzia em `/hub/dashboard` e
   `/hub/dashboard/perfil`, telas que esta rodada não tocou. Defeito **pré-existente do
   shell**, não da rodada: faltava `min-w-0` no grupo do header e na raiz do
   `EntitySwitcher` (`min-width:auto` do flexbox impedindo o item de encolher). Corrigido,
   com teste que assere a causa (posição do switcher), não só o sintoma.

### Testes que precisaram mudar

`importacoes/page.test.tsx` e `motoristas/page.test.tsx` assertavam nos botões de TEXTO
"Anterior"/"Próxima". Agora são botões de ícone com rótulo acessível ("Página anterior"/
"Próxima página") — comportamento asserido idêntico, locator atualizado.

E um teste MEU da rodada 4 nasceu errado: assumia paginação nas 7 telas, mas as entidades
sintéticas do driver não têm importações/motoristas/lançamentos/turnos, então essas telas
mostram estado vazio e não paginam. Reescrito para asserir "existe paginação" só onde há
dados e "o idioma antigo sumiu" em todas.

## Candidatos à rodada 5

1. **Uma crítica dual-agent de verdade**, antes de código — ver a dívida de método acima.
2. **h7 (3/4):** zero atalhos de teclado; nenhum "caminho de ontem" (últimos filtros).
3. **h8 (3/4):** o cockpit de 6 zonas do `envio_massa` — o maior item aberto, e o único que
   mexe na tela de disparo real para motoristas.
4. **h10 (3/4):** ajuda contextual DENTRO dos módulos, não só no launcher.
5. `.text-gradient-warm*` mortas em `globals.css` — segue fora de rodada de UX; é
   `ponytail-audit`.
