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
- `verificar-vinhos.ts` — Edge Function irmã, verificação a sério (pesquisa
  Google real) para até 5 vinhos escolhidos à mão na lista completa da
  carta. Ver "A Edge Function `verificar-vinhos`" abaixo.
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
  modelo. **Em `ESTAVEIS` só entram PONTEIROS (`-latest`)** — lá estiveram
  "gemini-2.5-flash" e "gemini-2.0-flash", e são exatamente os nomes que a
  Google reformou: respondem 404 "no longer available to new users".
  Ficavam por baixo do ponteiro (que responde primeiro), por isso não davam
  erro visível — só deixavam a escada com dois degraus podres para o dia em
  que o ponteiro desse 429.
- **`thinkingBudget:0` NUNCA com o tool `google_search`.** A API recusa as
  duas juntas com 400 ("Request contains an invalid argument"): a pesquisa
  precisa de pensar para decidir o que pesquisar. Era a PRIMEIRA variante
  tentada nas duas funções — não partia nada (o loop caía na seguinte), só
  deitava fora uma ida ao Gemini em cada análise e em cada verificação, sem
  nada no ecrã a dizê-lo. Na `sugerir-vinho` a trave é o `&& !v.search` no
  `chamarGemini`; na `verificar-vinhos`, onde a pesquisa está sempre
  ligada, a variante deixou simplesmente de existir.
- **Duas chamadas, DOIS modelos.** A pesada (fotos + grounding) precisa do
  `flash`; a leve (`pedirPontuacoesAprox`, só uma lista de nomes a pedir um
  número de 0 a 5) corre no `MODELO_LEVE` — o `flash-lite`, que é o que a
  Garrafeira usa como primeira escolha em tudo. Se o lite falhar repete-se
  no modelo que já respondeu: trocar de modelo não pode ser um caminho novo
  para ficar sem pontuações nenhumas.
- **Cada análise regista o que gastou** (`usageMetadata` somado das duas
  chamadas, `chamadas_gemini`, `custo_estimado_eur`) no `sync_log`, como já
  fazia a Garrafeira. Os TOKENS são facto — vêm da API; o EURO é uma
  estimativa grosseira (`CUSTO_ANALISE_EUR`/`CUSTO_LEVE_EUR`), não um preço
  publicado, e a pesquisa Google é faturada à parte por pedido. Sem isto
  não havia como responder à pergunta que o catálogo partilhado veio pôr:
  está a poupar quanto? Uma verificação servida só pelo catálogo regista
  `custo_estimado_eur: 0` — é esse o número que interessa ver a crescer.
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
- **Duas chamadas ao Gemini, não uma**: a pesada (imagens + pesquisa) só
  devolve `sugestoes` e `vinhosCarta` sem pontuação aproximada.
  `pontuacaoAprox` de cada vinho da carta vem de uma SEGUNDA chamada,
  `pedirPontuacoesAprox`, só texto (os nomes já lidos), sem imagens nem
  pesquisa, com o seu próprio limite de 15s. Pedir as duas coisas na mesma
  chamada (imagens + pesquisa + estimar ~20-40 vinhos um a um) esgotava
  sempre o tempo disponível, mesmo com `thinkingBudget:0`. Se a segunda
  chamada falhar, a análise principal segue à mesma, só sem `pontuacaoAprox`
  (fica `null`) — nunca deita tudo abaixo por isto.
- **Trabalho assíncrono (`EdgeRuntime.waitUntil`)** — a parte mais
  importante do desenho: a análise (imagens + pesquisa Google) pode
  legitimamente passar de um minuto (confirmado nos logs — é o próprio
  Gemini, não um bug). Um único pedido HTTP à espera desse tempo todo morre
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

## Coerência: a sugestão bate certo com a carta?
O modelo lê a carta E escolhe o vinho na mesma passagem — nada garante que o
vinho recomendado seja um dos que ele próprio transcreveu para `vinhosCarta`,
nem que o `precoCarta` anunciado seja o preço impresso. É a falha que custa
mais caro a quem está à mesa (pedir um vinho que não existe, ou contar com
24€ e ver 38€ na conta) e é a única que se confirma **sem gastar mais uma
chamada ao Gemini**: `verificarCoerencia` (em `sugerir-vinho.ts`) confronta
as duas metades da resposta uma com a outra, em código, e anota cada
sugestão com `coerencia:{naCarta,precoCartaLido}`.
- Emparelhamento por nome normalizado (sem acentos nem colheita, com
  `qta.`→`quinta`), por contenção de tokens — "Crasto" casa com "Quinta do
  Crasto Reserva", de propósito. Palavras genéricas (`quinta`, `herdade`,
  `reserva`, …) não chegam sozinhas para casar, senão "Quinta do Crasto"
  casava com "Quinta da Romaneira". Tipos conhecidos e diferentes nunca
  casam (o Papa Figos branco não é o tinto).
- Empate (a gama base E a Reserva do mesmo produtor na carta) desempata-se
  pelo preço; se nem o preço desempatar fica `ambiguo` e daí não se aproveita
  preço nenhum.
- **Nunca se apaga uma sugestão por falhar isto** — o emparelhamento é
  aproximado e um falso negativo a esconder o melhor vinho da carta seria
  pior do que o aviso. Marca-se, e a app mostra um aviso no cartão
  (`wsCoerenciaHTML`); quem está à mesa tem o menu na mão para confirmar.
- `naCarta:null` significa "não havia carta contra que verificar", que não é
  o mesmo que "não está lá".
- Bónus: se a sugestão vier sem `precoCarta` mas o vinho for encontrado na
  carta com preço, o preço é preenchido — mas só com emparelhamento forte
  (≥0.9) e sem ambiguidade.
- As contas de cada análise ficam no `sync_log`
  (`coerencia_sem_carta`/`coerencia_preco_errado`/`coerencia_preco_preenchido`)
  — é por aí que se vê se isto é um problema frequente ou raro.

## A Edge Function `verificar-vinhos`
Nasceu de uma limitação conhecida: `vinhosCarta[].pontuacaoAprox` (todos os
vinhos da carta, não só as sugestões) é uma estimativa de memória do
Gemini, sem pesquisa — pedir pesquisa real para os ~40 vinhos todos foi o
que causava os timeouts que levaram a separar essa estimativa numa 2ª
chamada leve (ver acima). Em vez de resolver isso "à bruta", esta função dá
ao utilizador a opção de pagar o custo da pesquisa real só para os vinhos
que ele escolher à mão na lista (até 5) — o resto da carta continua a usar
só a estimativa aproximada.
- **O catálogo partilhado responde primeiro** (ver a secção própria): os
  vinhos que já lá estão COMPLETOS (nota pesquisada **e** preço de mercado)
  saem sem Gemini nenhum. Exige-se as duas coisas de propósito — meia
  resposta era pior do que pesquisar, que quem escolheu estes cinco vinhos
  à mão escolheu-os porque quer saber. Continua a ser verificação a sério:
  o que está no catálogo foi lá posto por uma pesquisa a sério, e a
  `winecatalog.forca()` não deixa entrar estimativas de memória. O resultado
  traz `origem:'catalogo'` e a data, e a app diz-o.
- Mesma arquitetura assíncrona da `sugerir-vinho` (`EdgeRuntime.waitUntil` +
  polling), mas mexe na MESMA linha de `wineselection.analises` — só em
  três colunas à parte: `verificacao_estado`/`verificacao`/
  `verificacao_erro`. Nunca toca em `estado`/`resultado`. A análise já tem
  de estar `'concluido'` (confirmado com o JWT do próprio utilizador, a RLS
  de `analises_sel` é que garante que só vê a sua).
- Só texto + pesquisa Google, sem imagens — mais leve que a análise
  principal, mas continua a usar `EdgeRuntime.waitUntil` porque a pesquisa
  em si é imprevisível.
- **Sem fallback "sem pesquisa"** (ao contrário da `sugerir-vinho`) — se
  todos os modelos falharem com pesquisa ligada, a função devolve erro em
  vez de responder com uma estimativa de memória disfarçada de
  "verificação a sério". É a única razão de a função existir; fingir que
  verificou sem pesquisar seria pior do que não ter esta funcionalidade.
- Duplica (não importa) a descoberta de modelo/normalizadores da
  `sugerir-vinho.ts` — mesma convenção das outras Edge Functions
  irmãs deste projeto (cada uma auto-contida).

Pedido: `POST /functions/v1/verificar-vinhos` com
`{analiseId, vinhos:[{nome,regiao,preco}]}` (1 a 5 vinhos, tirados de
`resultado.vinhosCarta` da análise já concluída). Resposta também é só
`{estado:'pendente'}` (202) — `app.js` (`wsVerificar`/`wsVerifPollTick`)
sonda a mesma linha de `analises` até `verificacao_estado` mudar para
`'concluido'` (lê `verificacao`, um array `[{nome,pontuacao,precoAvaliacao}]`
na MESMA forma de `sugestoes[].pontuacao`/`precoAvaliacao`) ou `'erro'`
(lê `verificacao_erro`).

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

- **`sugerir-vinho`** — a `pontuacaoAprox` de toda a carta era sempre uma
  SEGUNDA chamada ao Gemini, a estimar ~40 vinhos de memória. Agora
  pergunta-se primeiro ao catálogo (`winecatalog.procurar_lote`, **uma** ida ao
  PostgREST para a carta toda): os vinhos que alguém já pesquisou a sério
  respondem já, e ao Gemini vão só os que sobram. Quando não sobra nenhum,
  essa chamada não acontece.
- **`verificar-vinhos`** — a mais cara das três (pesquisa Google a sério).
  Os vinhos que o catálogo já tem COMPLETOS respondem sem Gemini nenhum.
- as duas **escrevem** o que descobrem, no fim e depois de a linha de
  `analises` estar fechada: quem está à espera não espera pelo catálogo, e
  se ele falhar não estraga nada. **Nada disto pode deitar uma análise
  abaixo** — é uma poupança, não uma dependência, e daí os `try/catch` a
  engolir tudo.

**A `pontuacaoAprox` NUNCA entra no catálogo.** É a regra que segura o
resto. Ela é uma estimativa de memória, sem pesquisa, e esta app inteira
está construída à volta de não a disfarçar de verificação — deixá-la entrar
aqui era pior do que isso: era espalhá-la pelas duas apps com ar de facto
pesquisado, e depois já ninguém sabia de onde tinha vindo. A
`winecatalog.forca()` do lado do SQL recusa-a mesmo que um dia alguém tente
mandá-la. Só `sugestoes[].pontuacao` (que vem com pesquisa e fonte) e a
`verificar-vinhos` é que escrevem.

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
comparação com a carta refaz-se sempre em código — `avaliarPreco` em
`verificar-vinhos.ts`, com os cortes escritos à vista (2 a 3 vezes o preço
de loja é o normal num restaurante) e a conta no próprio comentário que vai
para o ecrã. É mais honesto do que a opinião do modelo: quem está à mesa vê
a conta e discorda dela se quiser.

**A chave (o que faz dois vinhos serem o mesmo vinho) vive só no SQL.**
Daqui vai o nome e o ano em cru. Chegou a estar repetida em TypeScript nas
três Edge Functions com um aviso a dizer para as manter iguais — e um aviso
desses é uma dívida à espera: no dia em que uma divergisse, o catálogo
partia-se em dois em silêncio e a única coisa que se notava era a conta a
não descer. Uma cópia só não pode divergir.

`anoDoNome()` é o que tira a colheita de "Papa Figos 2020": com ano, a
resposta é a nota DAQUELA colheita; sem ele, é a de uma recente e o
catálogo diz qual — a app mostra-o (`.carta-ano`), que sem isso era dar uma
nota sem se saber de que garrafa é.

**Na UI, uma nota pesquisada e um palpite não podem parecer a mesma coisa**
(`pontuacaoOrigem`, `wsScoreTxt`, `wsNotaDaLista`): a do catálogo fica
dourada e com a colheita ao lado, a estimativa fica cinzenta e com um `~` à
frente. E uma verificação que volta num instante ganha uma linha a dizer
porquê (`wsVerifOrigemHTML`) — sem ela parece uma resposta a fingir, e não
é: já tinha sido paga.

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

Por isso: quando mexeres na escolha de modelo, nos parâmetros da chamada ou
no tratamento de erros do Gemini de UM lado, vai ver o outro no MESMO dia.
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

A forma de `resultado` (a coluna jsonb, dentro da linha de `analises`):
```
{ prato, orcamento, sugestoes:[{nome,tipo,regiao,casta,precoCarta,
    pontuacao:[{fonte,valor,escala,url}],
    precoAvaliacao:{classificacao,faixaMercado,comentario}, combinacao,
    coerencia:{naCarta,precoCartaLido}}],
  vinhosCarta:[{nome,tipo,regiao,preco,pontuacaoAprox,
    pontuacaoOrigem,pontuacaoAno,pontuacaoUrl}], aviso,
  fontes:[{titulo,url}], pesquisa, modelo, geradoEm }
```
`sugestoes[].pontuacao` é sempre confirmada por pesquisa Google (fonte real,
com URL) — é o que sustenta a avaliação de preço. Já
`vinhosCarta[].pontuacaoAprox` tem DUAS origens possíveis, e é o
`pontuacaoOrigem` que diz qual: `'catalogo'` é uma nota pesquisada a sério
que já existia (ver o catálogo partilhado, acima) e vem com `pontuacaoAno`
(a colheita a que pertence) e `pontuacaoUrl`; `'estimativa'` é o palpite
geral do modelo, de memória, sem pesquisa vinho a vinho — de propósito mais
leve, para não voltar a estourar o tempo de resposta com cartas grandes. Um
resultado antigo, de antes disto, não tem `pontuacaoOrigem` — e a app trata
a ausência como estimativa, que é o que era. Se mexeres neste contrato, mexe em três
sítios (`sugerir-vinho.ts`, `wsResultadoHTML`/`wsVinhoCardHTML` em `app.js`,
e o `resultado jsonb` de `db/schema.sql`).

`sugestoes[].coerencia` não vem do Gemini — é calculada em código pela
própria função (`verificarCoerencia`), ver abaixo.

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
