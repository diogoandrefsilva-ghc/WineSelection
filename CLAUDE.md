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
- `verificar-vinhos.ts` — Edge Function irmã, a única pesquisa paga
  (Google real) para até 4 vinhos que o catálogo não conhece, escolhidos à
  mão na lista da carta; grava o que encontra no catálogo e volta a
  recomendar. Ver "A Edge Function `verificar-vinhos`" abaixo.
- `apple-touch-icon.png` / `icon-512.png` — gerados por um script Node
  descartável (encoder PNG à mão, sem dependências); não há fonte vetorial
  guardada no repo. Para os refazer/alterar, escreve outro script assim.

## O que a app faz, em duas frases
Upload/foto da carta → a Edge Function `sugerir-vinho` lê a imagem com o
Gemini (só visão, **sem** pesquisa), pergunta ao catálogo partilhado o que já
se sabe de cada vinho, e recomenda 0–3 **só entre os que se conhecem**
(priorizando vinhos portugueses). Os outros aparecem como "sem dados", e
quem quiser escolhe até 4 para a `verificar-vinhos` pesquisar a sério — o
que ela encontra fica no catálogo e a recomendação refaz-se. A app guarda
cada resultado em `wineselection.analises` (histórico) — **nunca guarda a
imagem em si**, só o JSON devolvido e o prato indicado.

## Ou sabemos ou não sabemos (setembro de 2026) — a regra que manda no resto
Até aqui a análise era UMA passagem cara e a adivinhar: ler a carta +
pesquisa Google + escolher, tudo junto, e a seguir uma segunda chamada a
estimar de memória a nota dos ~40 vinhos da carta (`pontuacaoAprox`, o "~"
cinzento). O til era honesto, mas o número estava lá, e era o que se lia à
mesa. **A estimativa acabou.** Agora são três passos e nenhum inventa uma
nota:
1. **Ler** (`sugerir-vinho`): visão com `response_mime_type:json` e
   `thinkingBudget:0` — sem pesquisa não há o conflito do 400. Pede também
   **produtor e ano**, que é com o que o catálogo acerta.
2. **O catálogo responde** (`procurar_lote`, uma ida só): nota, preço de
   loja, castas, harmonização. O "barato/justo/caro" é sempre uma CONTA em
   código (`avaliarPreco`, preço da carta ÷ preço de loja), nunca a opinião
   do modelo.
3. **Recomendar** (`recomendar`): uma chamada só de texto, no `flash-lite`,
   que escolhe POR ÍNDICE e só entre os CONHECIDOS — um índice que aponte
   para um desconhecido ou para fora da carta é deitado fora em código. O
   modelo devolve só a ordem e a frase da harmonização; a nota, o preço e a
   classificação do cartão montam-se a partir dos dados. A mesma chamada
   aponta até 4 desconhecidos que valia a pena pesquisar (`pesquisar`) —
   a app só os PRÉ-SELECCIONA, nunca os mostra como facto.

**Três correções da primeira carta a sério (24/09/2026):**
- **A pesquisa SOMA-SE, nunca substitui.** A segunda ronda de 4 vinhos
  apagava a primeira (`verificacao: null` no pendente) e recomendava só com
  o que a leitura sabia: quatro vinhos pagos desapareciam. Agora a
  `verificar-vinhos` lê a `verificacao` anterior, junta-a à carta, pergunta
  outra vez ao catálogo pela carta TODA (o que a leitura não conseguiu
  perguntar também conta) e grava a soma das rondas.
- **Ordenar, não escolher um.** A `recomendar` devolve o `ranking` de todos
  os conhecidos e marca 2–3 `recomendados`; a app mostra-os como caixa
  resumo (`wsSugDetHTML`, um `<details>` por vinho, só o primeiro aberto).
  Um vinho sem nota não passa à frente de um com nota — no prompt e, dentro
  dos recomendados, em código: a primeira carta recomendou o único vinho
  sem nota de quatro. A recomendação passou para o modelo que leu a carta
  com um tecto de pensamento (1024); o lite com `thinkingBudget:0` dava 400
  e, quando respondia, escolhia mal.
- **"Não consegui perguntar" não é "não conheço".** Se o `procurar_lote`
  falhar (tenta duas vezes), `recomendacao:'catalogo-falhou'` e a app di-lo
  — nunca "não conheço nenhum". A causa desse dia estava no SQL (a `achar`
  levava ~1 s por vinho; ver o `CLAUDE.md` da WineCatalog), mas a app não
  pode voltar a transformar uma avaria em "sem dados".

A pesquisa paga passou a acontecer só quando alguém a pede, só para os
vinhos que escolheu, e só UMA vez por vinho em todo o projeto: a
`verificar-vinhos` grava no catálogo, e a próxima carta com aquele vinho —
aqui ou na Garrafeira — sai de graça.

**Porque não um OCR no browser (Tesseract.js) em vez do Gemini a ler a
foto:** foi a primeira pergunta, e a resposta foi que ler a imagem nunca
foi o que custava — sem pesquisa, a leitura é uma fração de cêntimo. Um OCR
local descarrega vários MB para o telemóvel à mesa, é lento, erra com cartas
a duas colunas e letra decorativa, e devolve LINHAS, não
`{nome, produtor, ano, preço}`. Se os números um dia disserem o contrário,
entra como primeira tentativa com o Gemini como rede.

**`recomendar`, `avaliarPreco` e `conhecimentoDoCatalogo` estão duplicadas
nas duas Edge Functions** (cada uma é auto-contida, como tudo neste
projeto): a `verificar-vinhos` volta a recomendar depois de pesquisar. Se
mexeres no prompt, nas regras ou nos cortes de preço de uma, mexe na outra
no MESMO dia.

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
- **Imagem inline** (`inline_data` no `parts`), como a `fatura-restaurante`
  do SplitBill — e desde setembro de 2026 **sem** pesquisa Google (ver "Ou
  sabemos ou não sabemos"). Sem o tool de pesquisa a API aceita
  `response_mime_type: json`; o `extrairJson` fica como rede para um modelo
  que embrulhe a resposta.
- **Descoberta de modelo com fallback** (mesma estratégia das três funções
  irmãs): pergunta-se à API que "flash" a chave tem disponíveis, tenta-se
  por ordem, com retry em erros transitórios (429/500/503) e um 400 (nome de
  campo recusado) tenta-se sem pesquisa uma vez antes de desistir desse
  modelo. **Em `ESTAVEIS` só entram PONTEIROS (`-latest`)** — lá estiveram
  "gemini-2.5-flash" e "gemini-2.0-flash", e são exatamente os nomes que a
  Google reformou: respondem 404 "no longer available to new users".
  Ficavam por baixo do ponteiro (que responde primeiro), por isso não davam
  erro visível — só deixavam a escada com dois degraus podres para o dia em
  que o ponteiro desse 429.
- **`thinkingBudget:0` NUNCA com o tool `google_search`.** A API recusa as
  duas juntas com 400 ("Request contains an invalid argument"): a pesquisa
  precisa de pensar para decidir o que pesquisar. Na `sugerir-vinho` já não
  há pesquisa, e o `thinkingBudget:0` é a primeira variante (transcrever
  não precisa de pensar, e pensar era o que dava o "200 vazio"); na
  `verificar-vinhos`, onde a pesquisa está sempre ligada, a variante não
  existe — e a `recomendar` que lá corre depois é outra chamada, sem tool.
- **Duas chamadas, DOIS modelos.** A leitura das fotos precisa do `flash`;
  a recomendação (`recomendar`, só texto e factos já arrumados) corre no
  `MODELO_LEVE` — o `flash-lite`. Se o lite falhar repete-se no modelo que
  já respondeu. Se falharem os dois, a análise fecha na mesma com a lista
  e `recomendacao:'falhou'` — a app di-lo, em vez de fingir que não havia
  nada a recomendar.
- **Cada análise regista o que gastou** (`usageMetadata` somado das duas
  chamadas, `chamadas_gemini`, `custo_estimado_eur`, e
  `catalogo_conhecidos` — quantos vinhos da carta o catálogo já conhecia,
  que é o número que devia subir com o tempo) no `sync_log`. Os TOKENS são
  facto — vêm da API; o EURO é uma estimativa grosseira
  (`CUSTO_LEITURA_EUR`/`CUSTO_RECOMENDACAO_EUR`/`CUSTO_VERIFICACAO_EUR`),
  não um preço publicado, e a pesquisa Google é faturada à parte por
  pedido. Uma pesquisa servida só pelo catálogo regista a parte da
  pesquisa a 0.
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
- **Trabalho assíncrono (`EdgeRuntime.waitUntil`)** — a parte mais
  importante do desenho: a análise podia legitimamente passar de um minuto
  quando levava a pesquisa Google (confirmado nos logs — era o próprio
  Gemini, não um bug); sem ela é mais rápida, mas continua a ser a leitura
  de até 6 fotos. Um único pedido HTTP à espera desse tempo todo morre
  sempre que o telemóvel bloqueia o ecrã ou o browser troca de app — era
  isso que causava tanto o erro de "demasiado tempo" como o "erro de
  ligação" ao voltar à app. A função por isso:
  1. valida o pedido e cria já a linha em `wineselection.analises` (estado
     `'pendente'`), usando o **próprio JWT do utilizador** (pass-through do
     header `Authorization`, não a service role) para a RLS/trigger
     correrem normalmente;
  2. responde já ao browser com `{id, estado:'pendente'}` (202);
  3. só DEPOIS de responder é que faz o trabalho a sério, com
     `EdgeRuntime.waitUntil(processarAnalise(...))` — isto sobrevive ao
     pedido original terminar, ligação incluída.
  `processarAnalise` fecha sempre a linha no fim, por `PATCH` com a service
  role (`estado:'concluido'`+`resultado`, ou `estado:'erro'`+`erro`) — nunca
  a deixa presa em `'pendente'`. O `WHERE` do PATCH inclui sempre
  `user_email=eq.<quem>`, mesmo a service role tendo acesso a tudo, para só
  poder mexer na linha do próprio dono.

## Coerência: a sugestão bate certo com a carta? (resolvida pelo desenho)
Enquanto o modelo lia a carta E escolhia o vinho na mesma passagem, nada
garantia que o recomendado fosse um dos que ele próprio tinha transcrito,
nem que o `precoCarta` fosse o impresso — e existia uma
`verificarCoerencia` a confrontar as duas metades em código. **Desde a
versão 2 isto já não pode acontecer**: a recomendação escolhe POR ÍNDICE
dentro de `vinhosCarta`, e o nome e o preço do cartão são os da própria
linha lida. A função saiu. `wsCoerenciaHTML` fica na app só para desenhar os
avisos dos resultados antigos do histórico.

## A Edge Function `verificar-vinhos`
É a ÚNICA pesquisa paga desta app: até **4** vinhos que o catálogo ainda
não conhece (um vinho já conhecido, mesmo sem nota, não volta a ter visto:
essa pesquisa já foi feita), escolhidos à mão na lista — a
app pré-selecciona os que a recomendação apontou em `pesquisar`.
- **O catálogo responde primeiro**: alguém pode tê-los pesquisado entretanto
  (aqui, na Garrafeira, na WineCatalog). Os que já lá estão COMPLETOS (nota
  **e** preço de mercado) saem sem Gemini nenhum.
- A pesquisa pede mais do que nota e preço: **castas, região, cor e
  harmonização** — é o que a recomendação precisa para escolher com
  fundamento, e o que faz o catálogo servir a próxima carta. O
  "barato/justo/caro" é a mesma conta em código da `sugerir-vinho`
  (`avaliarPreco`); a opinião do modelo sobre o preço já não chega ao ecrã.
- Um vinho que a pesquisa não conseguiu confirmar volta como
  `naoEncontrado` e a app diz "não encontrado" — não é o mesmo que "sem
  dados" (ninguém procurou) e não se volta a oferecer para pesquisa.
- Depois de pesquisar, **volta a RECOMENDAR sobre a carta inteira** (a
  mesma `recomendar`, duplicada): o que já se sabia na leitura mais o que
  acabou de chegar.
- **Grava no catálogo** (`juntar`, origem `ws-verificacao`, força 3) com o
  nome, o PRODUTOR (só o que a carta dizia — um produtor achado pela
  pesquisa não mexe na identidade) e o ano. Só o que é do VINHO: nunca o
  preço da carta nem o "barato/caro".
- Conta as fontes do grounding (`fontes: N`) e regista o `grounding` (se
  houve pesquisa, que termos, quantos chunks). Sem fontes **não se
  recusa** — decidido a 24/09/2026, igual em todas as apps; ver o
  `CLAUDE.md` da WineCatalog, "ZERO fontes".
- **De memória ou pesquisado (24/09/2026).** O Gemini decide sozinho se
  usa a pesquisa Google, e nos registos nunca a usou: respondeu com o que
  aprendeu no treino. Para toda a gente fica assim. Cada vinho pesquisado
  leva `pesquisaWeb`; ao admin (`ADMIN_EMAIL`, confirmado também na
  função) os de memória aparecem com 🧠 e há o botão **🔬 Pesquisa
  profunda**, que manda `profunda:true`: o prompt exige a pesquisa, uma
  resposta sem ela passa ao modelo seguinte, e pesquisa os escolhidos
  TODOS (mesmo os que o catálogo já tinha completos — podem ter lá chegado
  de memória). As fontes, quando as há, vão para o catálogo. Mesmo
  critério nas quatro apps — ver o `CLAUDE.md` da WineCatalog, "De memória
  ou pesquisado".
- Mesma arquitetura assíncrona da `sugerir-vinho` (`EdgeRuntime.waitUntil` +
  polling), na MESMA linha de `wineselection.analises` — só nas colunas
  `verificacao_estado`/`verificacao`/`verificacao_erro`. Nunca toca em
  `estado`/`resultado`. A análise já tem de estar `'concluido'` (confirmado
  com o JWT do próprio utilizador).
- **Sem fallback "sem pesquisa"** — se todos os modelos falharem com
  pesquisa ligada, a função devolve erro em vez de responder com uma
  estimativa de memória disfarçada de "pesquisa a sério". É a única razão
  de a função existir.

Pedido: `POST /functions/v1/verificar-vinhos` com
`{analiseId, indices:[i,…]}` (1 a 4 índices em `resultado.vinhosCarta`).
Uma app antiga em cache ainda manda `vinhos:[{nome}]` — casa-se pelo nome.
Resposta: `{estado:'pendente'}` (202); `app.js` (`wsVerificar`/
`wsVerifPollTick`) sonda até `verificacao_estado` mudar. `verificacao` é
`{versao:2, vinhos:[{i,nome,conhecido,precoAvaliacao,naoEncontrado}],
sugestoes, recomendacao, pesquisar}`; a app junta-a ao `resultado`
(`wsMesclar`) e redesenha. As antigas eram só um array
`[{nome,pontuacao,precoAvaliacao}]` e o histórico ainda as desenha.

## O catálogo partilhado com a Garrafeira (não pagar duas vezes o mesmo)
Há uma segunda app de vinhos no mesmo projeto Supabase — a **Garrafeira** —
e as duas faziam a mesma pergunta ao Gemini sobre os mesmos vinhos, cada uma
por sua conta. O schema **`winecatalog`** é a memória comum: o que já se
pesquisou (nas duas apps) e o que alguém já confirmou por ter a garrafa em
casa. **Fonte de verdade: `db/catalogo.sql` no repo WineCatalog** — não há
cópia aqui de propósito (ver `db/README.md`).

**Chamou-se `catalogo` até setembro de 2026**, num schema só dele e com a
definição dentro do repo Garrafeira. Mudou-se de casa porque não era de
ninguém: passou a ter uma app própria (a WineCatalog), um dono próprio
(`winecatalog.config.admin_email`, que não é o admin desta app nem o da
Garrafeira) e um ecrã onde se vê o que lá está. Para esta app mudou uma
linha em cada Edge Function — o `Accept-Profile`/`Content-Profile`. Os
nomes das funções e as respostas são os mesmos.

Onde é que isto entra nesta app, e o que muda:

- **`sugerir-vinho`** — o catálogo é a PRIMEIRA fonte de verdade de cada
  vinho da carta (`winecatalog.procurar_lote`, **uma** ida ao PostgREST para
  a carta toda, com nome, produtor e ano). O que ele não sabe fica "sem
  dados" — já não há estimativa de memória a tapar o buraco. Esta função
  **não escreve** no catálogo: o que lê de uma carta não foi confirmado por
  ninguém. Janela de 180 dias para os campos voláteis (era 30 quando a
  estimativa tapava os buracos; sem ela, uma nota de há quatro meses é
  conhecimento, e a alternativa é "sem dados").
- **`verificar-vinhos`** — a única pesquisa paga. Os vinhos que o catálogo
  já tem COMPLETOS respondem sem Gemini nenhum; o que pesquisa (nota,
  preço, castas, região, cor, harmonização) **escreve-o** no catálogo, no
  fim e depois de a linha de `analises` estar fechada: quem está à espera
  não espera pelo catálogo, e se ele falhar não estraga nada.
- **Nada disto pode deitar uma análise abaixo** — é uma poupança, não uma
  dependência, e daí os `try/catch` a engolir tudo. Se o catálogo não
  responder, a carta aparece toda "sem dados", que é verdade.

**A `pontuacaoAprox` NUNCA entra no catálogo.** É a regra que segura o
resto. Ela é uma estimativa de memória, sem pesquisa, e esta app inteira
está construída à volta de não a disfarçar de verificação — deixá-la entrar
aqui era pior do que isso: era espalhá-la pelas duas apps com ar de facto
pesquisado, e depois já ninguém sabia de onde tinha vindo. A
`winecatalog.forca()` do lado do SQL recusa-a mesmo que um dia alguém tente
mandá-la. Desde setembro de 2026 ela nem sequer existe; só a
`verificar-vinhos` (pesquisa a sério) é que escreve.

**E uma nota escrita à mão numa garrafeira também não vale o que vale a
`verificar-vinhos`.** A Garrafeira deixa cada um escrever o que quiser nos
campos do seu vinho, e o trigger dela leva isso para o catálogo — durante
umas semanas TODAS as notas do Vivino e TODOS os preços de mercado que lá
estavam tinham vindo daí, com a mesma força de uma pesquisa Google a
sério, e portanto a tapá-la. A `winecatalog.forca()` passou a olhar para o
CAMPO e não só para a origem: o que se lê no rótulo (castas, cor, teor,
região) vindo de uma garrafeira continua a valer 3 — quem tem a garrafa na
mão sabe melhor —, mas a nota e o preço vindos de lá valem 2, abaixo desta
função. Interessa-nos diretamente: é o que garante que uma verificação
paga aqui não é apagada amanhã por um número que alguém copiou à pressa
para a sua garrafeira. Fonte de verdade: `db/catalogo.sql` no repo
WineCatalog.

**O "barato/justo/caro" também não entra, e por outra razão:** não é do
vinho, é de uma CARTA. O mesmo Papa Figos é barato a 22 € e caro a 45 €, e
nem o vinho mudou. O que atravessa é o preço de MERCADO (`preco_medio`), e a
comparação com a carta refaz-se sempre em código — `avaliarPreco`, nas duas
Edge Functions (duplicada), com os cortes escritos à vista (2 a 3 vezes o preço
de loja é o normal num restaurante) e a conta no próprio comentário que vai
para o ecrã. É mais honesto do que a opinião do modelo: quem está à mesa vê
a conta e discorda dela se quiser.

**A chave (o que faz dois vinhos serem o mesmo vinho) vive só no SQL.**
Daqui vão o nome, o produtor (só quando a carta o escreve) e o ano em cru. Chegou a estar repetida em TypeScript nas
três Edge Functions com um aviso a dizer para as manter iguais — e um aviso
desses é uma dívida à espera: no dia em que uma divergisse, o catálogo
partia-se em dois em silêncio e a única coisa que se notava era a conta a
não descer. Uma cópia só não pode divergir.

`anoDoNome()` é o que tira a colheita de "Papa Figos 2020": com ano, a
resposta é a nota DAQUELA colheita; sem ele, é a de uma recente e o
catálogo diz qual — a app mostra-o (`.carta-ano`), que sem isso era dar uma
nota sem se saber de que garrafa é.

**Na UI, ou sabemos ou não sabemos** (`wsCartaItemV2HTML`): uma nota com
fonte fica dourada e com a colheita ao lado; um vinho sem dados diz "sem
dados" — nunca um número. O preço da carta ganha a cor do
"barato/justo/caro" (a conta). E cada sugestão diz de onde vieram os
factos (`wsSugOrigemHTML`: "do catálogo — não foi preciso pesquisar" ou
"pesquisado agora — ficou guardado") — sem isso uma resposta instantânea
parece a fingir, e não é: já tinha sido paga.

## As lições da Garrafeira têm de atravessar para cá
As duas apps falam com a MESMA API, com a MESMA chave, e cada Edge Function
deste projeto é auto-contida de propósito (ver a convenção acima). A
duplicação é intencional; o que não pode ser é o CONHECIMENTO ficar só de
um lado.

Aconteceu duas vezes seguidas: a Garrafeira apanhou os 404 dos nomes fixos
(1 de setembro) e os 400 do `thinkingBudget:0` com pesquisa (10 de
setembro), corrigiu-se, e a WineSelection ficou com as duas avarias
intactas durante semanas. Nenhuma dava erro visível — e a WineSelection não
corria desde 29 de agosto, por isso o log dela estava limpo. **Um log limpo
numa app que não corre não é saúde, é desuso**, e foi só por isso que
ninguém deu por nada.

Aconteceu uma terceira vez, em setembro, e desta já não foi no Gemini: o
`search_path` fixo nas funções SQL. Todas as da Garrafeira o têm desde
sempre; as daqui (`is_admin`, `is_allowed`) não tinham nenhuma. Foi o linter
do Supabase que o apontou. O risco concreto era pequeno — nenhuma é
SECURITY DEFINER — mas o padrão é o mesmo: **a regra existia num repo e não
no outro.**

Por isso: quando mexeres na escolha de modelo, nos parâmetros da chamada ou
no tratamento de erros do Gemini de UM lado, vai ver o outro no MESMO dia.
E vale para mais do que o Gemini — corre o linter do Supabase de vez em
quando e olha para os dois schemas, não só para aquele em que estás.
O `sync_log` das duas apps é o sítio onde isso se confirma — compara a
última chamada de cada uma antes de assumir que a que está calada está bem.

## Contrato do pedido e da resposta (o que `app.js` envia/espera)
Pedido: `POST /functions/v1/sugerir-vinho` com
`{imagens:[{data,mime}], prato, orcamento}` — `orcamento` é o preço máximo
por garrafa que o utilizador está disposto a pagar (número em euros,
opcional, `null` se não indicado); a função só o usa para condicionar as
`sugestoes`, nunca filtra `vinhosCarta` por causa dele.

**A resposta do pedido não é o resultado** — é só `{id, estado:'pendente'}`
(202). `app.js` (`wsIniciarPolling`/`wsPollTick`) sonda
`wineselection.analises?id=eq.<id>` de 3 em 3 segundos até `estado` mudar
para `'concluido'` (lê `resultado`) ou `'erro'` (lê `erro`) — com um limite
de 3 minutos antes de desistir. Retoma o polling sozinho ao voltar a ficar
visível (`visibilitychange`) e mesmo depois de recarregar a página
(`wsRetomarPendente`, chamado em `sbAposLogin`, via o `id` guardado em
`localStorage['ws_pendente_id']`).

A forma de `resultado` (a coluna jsonb, dentro da linha de `analises`),
**versão 2**:
```
{ versao:2, prato, orcamento,
  recomendacao:'ok'|'sem-conhecidos'|'falhou'|'catalogo-falhou'|'sem-carta',
  sugestoes:[{i,nome,produtor,tipo,regiao,casta,precoCarta,
    pontuacao:[{fonte,valor,escala,url}], notaAno,
    precoAvaliacao:{classificacao,faixaMercado,comentario}, combinacao,
    recomendado, origem:'catalogo'|'pesquisa'}],   // o ranking, recomendados primeiro
  pesquisar:[i,…],
  vinhosCarta:[{nome,produtor,ano,tipo,regiao,preco,
    conhecido:null|{nota,notaUrl,notaAno,pontuacao,precoMercado,castas,
      regiao,tipo,estilo,harmonizacao,notasProva,produtor,origem,origemEm},
    precoAvaliacao}],
  aviso, pesquisa:false, modelo, geradoEm }
```
`conhecido:null` quer dizer **não se sabe** — nunca "é fraco". Cada nota e
cada preço de `sugestoes` vêm de `conhecido` (catálogo ou pesquisa), nunca
do texto do modelo; `sugestoes[].i` é o índice em `vinhosCarta`.

Um resultado **antigo** (sem `versao`) tem `vinhosCarta[].pontuacaoAprox`/
`pontuacaoOrigem` e `sugestoes[].coerencia`. A app desenha-o pelo caminho
antigo (`wsResultadoLegadoHTML`), mas a estimativa (`pontuacaoOrigem`
`'estimativa'`, ou sem origem) aparece como "—": ou sabemos ou não sabemos.
Se mexeres neste contrato, mexe em três sítios (`sugerir-vinho.ts` +
`verificar-vinhos.ts`, `wsResultadoV2HTML`/`wsMesclar` em `app.js`, e o
comentário do `resultado jsonb` em `db/schema.sql`).

## O registo central de acessos ao Gemini (schema `ia_uso`)
São **seis** apps neste projeto Supabase a chamar o Gemini, por nove Edge
Functions, e cada uma tinha só o seu `sync_log` — a pergunta *"quanto é que
isto custa ao todo?"* não tinha onde ser respondida. O schema **`ia_uso`**
é uma linha por chamada (app, função, modelo, tokens, custo estimado,
duração, quem, erro).

**A secção canónica é a do `CLAUDE.md` da WineCatalog** — a fonte de
verdade do schema é o `db/ia_uso.sql` desse repo. Aqui fica só o que é
preciso saber para não partir nada:

- **Um 200 com o corpo VAZIO não é resposta, e não pode passar por
  sucesso.** O modelo gasta o orçamento a pensar e não escreve uma letra —
  HTTP 200, `candidatesTokenCount: 0`. A `verificar-vinhos` fechava a análise em `concluido` com a verificação VAZIA — precisamente a função cuja razão de existir é não fingir que verificou (ver acima, "Sem fallback sem pesquisa"); a `sugerir-vinho` já dava erro, mas nunca tentava o modelo seguinte. Agora o corpo lê-se DENTRO do
  ciclo dos modelos (um vazio passa ao seguinte) e, se nenhum escrever,
  fecha em **erro** com o `finishReason` à frente. A lição inteira, com o
  caso que a pagou, está no `CLAUDE.md` da WineCatalog ("O 200 vazio").
- **Daqui escrevem duas funções**: `sugerir-vinho.ts` e
  `verificar-vinhos.ts`, as duas com `app: "wineselection"`. A
  `registarIaUso()` é chamada no fim do `registar()` local — o mesmo
  `detalhe` do `wineselection.sync_log`, com tokens/modelo/custo também em
  colunas, num `POST` para outro schema (`Content-Profile: ia_uso`).
- **É aqui que isto vale mais**, e é a razão pela qual a invariante do "log
  limpo numa app que não corre não é saúde, é desuso" continua a valer: com
  as cinco apps na mesma tabela, uma que esteja calada vê-se ao lado das
  outras em vez de se ter de ir espreitar o `sync_log` dela.

- **Nunca deita abaixo o trabalho que estava a ser feito**: vive num
  `try/catch` que engole tudo — é registo, não é o trabalho.
- **E é essa mesma regra que o faz falhar em SILÊNCIO quando está mal
  configurado.** Já aconteceu: sem os GRANTs do `db/ia_uso.sql`, os INSERTs
  levavam 403 e a tabela ficava a zero linhas sem um erro em lado nenhum.
  Se `ia_uso.registos` estiver vazia, confere **(1)** se `ia_uso` está nos
  *Exposed schemas* do painel e **(2)** se o bloco de GRANTs correu — só
  depois desconfia do código.
- **Não há migração a correr deste lado** e nada aqui depende disto: se o
  schema `ia_uso` não existir, estas funções comportam-se exatamente como
  antes.

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
- A app aceita **até 6 fotos** da carta por pedido (`_wsImagens`, grelha de
  miniaturas em `#img-grid`) — o menu de vinhos raramente cabe numa só foto.
  O `<input>` não tem `capture="environment"` de propósito: com esse atributo
  o telemóvel salta a escolha "Câmara vs. Ficheiros" e vai direto à câmara,
  sempre — sem ele o browser mostra o seletor nativo e o utilizador escolhe.
  Cada imagem é comprimida no cliente antes de seguir (`wsProcessarImagem`,
  canvas, máx. 1280px, JPEG q0.82) — mantém os pedidos rápidos e dentro do
  limite de 6MB de base64 por imagem (20MB no total) que a função aceita. Há
  fallback para mandar o ficheiro tal qual se o `createImageBitmap` falhar
  (ex.: formato exótico).

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
Edge Function: `supabase functions deploy sugerir-vinho` (ou
`mcp__Supabase__deploy_edge_function`).
