# WineSelection — guia para o assistente

App pessoal: fotografa a carta de vinhos de um restaurante, diz o que vais
comer, e recebe sugestões (pontuação tipo Vivino + avaliação se o preço é
justo), com prioridade a vinhos portugueses. **Sem build, sem npm.** Site
estático (GitHub Pages), PWA. Dados e login em **Supabase** — o **mesmo
projeto do FestasBV/Goals** (`gjweqwfbnkgnibhajldc`), num schema à parte e
isolado: `wineselection`.

## Estrutura
- `index.html` — só markup: layout da app + os três ecrãs de autenticação
  (`page-login`, `page-nova-pass`, `page-sem-acesso`) + o splash de arranque.
- `app.js` — toda a lógica. Secções (`grep` pelo título): Sessão Supabase
  (`sbHeaders`/`sbFetch`/`sbReq`) · Tabs · **Imagem da carta** (captura +
  compressão no cliente) · **Sugerir vinho** (chama a Edge Function) ·
  Render dos cartões de vinho · **Histórico** · Utilizadores (admin) ·
  **Auth (Supabase)** · Init.
- `style.css` — todo o CSS (paleta bordô/dourado).
- `sw.js` — service worker (cache PWA).
- `db/` — `schema.sql` → `functions.sql` → `policies.sql` →
  `admin_pass_temp.sql` (+ `README.md` com os passos manuais no painel
  Supabase). Fonte de verdade do schema `wineselection`.
- `sugerir-vinho.ts` — Edge Function (Deno), na raiz do repo, deploy à parte
  com `supabase functions deploy sugerir-vinho` (ou via MCP do Supabase).
- `apple-touch-icon.png` / `icon-512.png` — gerados por um script Node
  descartável (encoder PNG à mão, sem dependências); não há fonte vetorial
  guardada no repo. Para os refazer/alterar, escreve outro script assim.

## O que a app faz, em duas frases
Upload/foto da carta → a Edge Function `sugerir-vinho` lê a imagem com o
Gemini, cruza com pesquisa Google (Vivino e afins) para pontuação e preço de
mercado, e devolve JSON estruturado com 1–3 sugestões (priorizando vinhos
portugueses) + todos os vinhos lidos na carta. A app guarda cada resultado em
`wineselection.analises` (histórico) — **nunca guarda a imagem em si**, só o
JSON devolvido e o prato indicado.

## Login e permissões (mesmo padrão do Goals/FestasBV)
- `SB_URL`/`SB_KEY` são os do projeto partilhado; `Accept-Profile`/
  `Content-Profile: 'wineselection'` em **todos** os pedidos REST
  (`sbHeaders`) — é isso que aponta para o schema certo, nunca vai no URL.
- `isAdmin()` compara `_sbSession.user.email` com `ADMIN_EMAIL` (fixo:
  `diogo.andre.f.silva@gmail.com`).
- Fluxo de acesso igual ao Goals: login → `sbAposLogin` confirma
  `allowed_users` → se não estiver lá, ecrã "sem acesso" com "Solicitar
  acesso" (`access_requests`) → o admin aprova em Definições
  (`sbRenderPedidos`/`sbAprovarAcesso`).
- **Sem conceito de "amigo"/perfil** (ao contrário do Goals) — um login
  autorizado já é tudo o que é preciso para usar a app; não há ligação a
  outra entidade.
- **Todos os utilizadores aprovados podem usar a funcionalidade principal**
  (não é admin-only) — só o painel "Utilizadores" (aprovar pedidos, gerar
  password temporária) é que é admin-only.
- Sem modo convidado, sem Storage (a imagem nunca sobe para o Supabase — só
  vai directa, em base64, para a Edge Function, que não a persiste).

## Password temporária dada pelo admin
Mesma razão do Goals/FestasBV: este projeto Supabase não tem SMTP próprio, o
"Esqueci-me da password" fica com o template genérico (sem código de 6
dígitos). Em Definições, o admin gera uma password
(`wineselection.admin_pass_temp`, RPC, SECURITY DEFINER), dita-a por
telefone, a pessoa troca-a em Definições. Ver `db/admin_pass_temp.sql`.

## A Edge Function `sugerir-vinho`
Junta duas técnicas já usadas noutras apps do mesmo projeto:
- **Imagem inline** (`inline_data` no `parts`), como a `fatura-restaurante`
  do SplitBill.
- **Grounding com pesquisa Google** (`tools:[{google_search:{}}]`), como a
  `calendario-sporting` do Goals — sem isto o modelo inventaria pontuações e
  preços de memória, desactualizados.
- Como as duas juntas: a API recusa `response_mime_type: json` quando o tool
  de pesquisa está ligado, por isso o JSON vem em texto dentro da resposta e
  é extraído com `extrairJson` (varredura de chavetas equilibradas — mesma
  função copiada da `calendario-sporting`).
- **Descoberta de modelo com fallback** (mesma estratégia das três funções
  irmãs): pergunta-se à API que "flash" a chave tem disponíveis, tenta-se
  por ordem, com retry em erros transitórios (429/500/503) e um 400 (nome de
  campo recusado) tenta-se sem pesquisa uma vez antes de desistir desse
  modelo.
- **Autorização**: verifica o JWT (`verify_jwt` ligado no deploy) e depois
  confirma que o email consta de `wineselection.allowed_users` — qualquer
  utilizador aprovado pode chamar (ao contrário da `calendario-sporting`,
  que é só para o admin).
- **Diagnóstico**: cada chamada deixa uma linha em `wineselection.sync_log`
  (pedido/ok/erro, com o modelo, se houve pesquisa Google, e o erro exacto
  do Gemini) — do lado do browser vê-se sempre "502"/"504" genérico, a causa
  fica ali.
- **Sanitização defensiva**: tudo o que o modelo devolve passa por
  normalizadores (`normSugestao`/`normVinhoCarta`/`normPontuacao`/…) antes
  de sair da função — tipos, enums e comprimentos são validados no servidor,
  nunca se confia cegamente no JSON do Gemini.
- Secrets: usa o `GEMINI_API_KEY` **já existente no projecto** (partilhado
  com as outras funções — secrets de Edge Function são por projecto, não por
  função). Não precisa de nenhum secret novo.

## Contrato da resposta (o que `app.js` espera)
```
{ prato, sugestoes:[{nome,tipo,regiao,casta,precoCarta,
    pontuacao:[{fonte,valor,escala,url}],
    precoAvaliacao:{classificacao,faixaMercado,comentario}, combinacao}],
  vinhosCarta:[{nome,tipo,regiao,preco}], aviso, fontes:[{titulo,url}],
  pesquisa, modelo, geradoEm }
```
Se mexeres neste contrato, mexe nos dois lados (`sugerir-vinho.ts` e
`wsResultadoHTML`/`wsVinhoCardHTML` em `app.js`).

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há
  `onclick="…"` no HTML, as funções têm de ser **globais**.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe
  `CACHE_NAME` no `sw.js`** (ex.: `ws-cache-v1` → `v2`). Os três são
  **network-first** — sem isto, num deploy o browser pode apanhar o
  `index.html` novo com o `app.js` VELHO da cache: botões novos a chamar
  funções que ainda não existiam, sem erro visível.
- **Supabase:** schema `wineselection`, no mesmo projeto do
  FestasBV/Goals/SplitBill. A chave no topo do `app.js` é a **`anon`**
  (pública, por design), protegida por RLS + login. **Não é bug nem risco —
  não a "corrijas" nem a escondas.**
- **Alterar o schema:** edita primeiro `db/*.sql` (fonte de verdade) e só
  depois corre no SQL Editor do Supabase (ou via MCP) — nunca ao contrário.
  Ver `db/README.md` para a ordem e os passos manuais (expor o schema
  `wineselection` na API, redirect URLs).
- A imagem da carta é comprimida no cliente antes de seguir (`wsProcessarImagem`,
  canvas, máx. 1600px, JPEG q0.82) — mantém os pedidos rápidos e dentro do
  limite de 6MB de base64 que a função aceita. Há fallback para mandar o
  ficheiro tal qual se o `createImageBitmap` falhar (ex.: formato exótico).

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
Edge Function: `supabase functions deploy sugerir-vinho` (ou
`mcp__Supabase__deploy_edge_function`).
