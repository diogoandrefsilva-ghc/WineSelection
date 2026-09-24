// supabase/functions/sugerir-vinho/index.ts
// WineSelection — Lê a(s) fotografia(s) da carta de vinhos com o Gemini (até
// 6 — o menu nem sempre cabe numa só foto), pergunta ao catálogo partilhado o
// que já se SABE de cada vinho, e recomenda para o prato indicado — mas só
// entre os vinhos de que se sabe alguma coisa. Com prioridade para vinhos
// portugueses.
//
// ── OU SABEMOS OU NÃO SABEMOS (setembro de 2026) ──
// Até aqui isto era uma passagem só, cara e a adivinhar: ler a carta +
// pesquisa Google + escolher, tudo junto, e a seguir uma SEGUNDA chamada a
// estimar de memória a nota dos ~40 vinhos da carta (`pontuacaoAprox`, o "~"
// cinzento). Agora são três passos, e nenhum inventa uma nota:
//   1. LER a carta — só visão, SEM pesquisa (JSON direto, como a
//      `catalogo-foto` da WineCatalog). É uma transcrição, e custa uma
//      fração do que custava com a pesquisa ligada;
//   2. o CATÁLOGO responde por cada vinho que já conhece (uma ida só,
//      `procurar_lote`): nota, preço de mercado, castas, harmonização. O
//      "barato/justo/caro" é uma conta feita aqui (`avaliarPreco`), não a
//      opinião do modelo;
//   3. RECOMENDAR — uma chamada só de texto, sem pesquisa, que escolhe
//      APENAS entre os vinhos conhecidos e explica a harmonização. As notas e
//      os preços do cartão vêm dos dados, nunca do modelo. A mesma chamada
//      indica até 4 vinhos desconhecidos que valia a pena pesquisar — são só
//      pré-seleccionados no ecrã, nunca mostrados como facto.
// Os desconhecidos aparecem como tal. Quem quer saber mais escolhe até 4 e a
// `verificar-vinhos` pesquisa-os a sério — e isso fica no catálogo, que é o
// que faz a próxima carta com o mesmo vinho sair de graça.
//
// ── TRABALHO ASSÍNCRONO (EdgeRuntime.waitUntil) ──
// A análise podia legitimamente passar de um minuto quando levava a pesquisa
// Google — visto nos logs, era o próprio Gemini que demorava. Sem pesquisa é
// muito mais rápida, mas continua a ser a leitura de até 6 fotos.
// Um único pedido HTTP à espera desse tempo todo morre sempre que o
// telemóvel bloqueia o ecrã ou o browser passa para outra app (é o que
// causava tanto o "demasiado tempo" como o "erro de ligação" ao voltar à
// app). Por isso a função devolve já o `id` da análise (linha criada em
// `wineselection.analises`, estado 'pendente') e continua o trabalho a
// sério em segundo plano com `EdgeRuntime.waitUntil` — sobrevive ao pedido
// original terminar. A app (`app.js`) faz polling a essa linha até o estado
// mudar para 'concluido'/'erro', e retoma o polling sozinha ao voltar a
// ficar visível (ou mesmo depois de recarregar a página, via localStorage).
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `wineselection.allowed_users` — qualquer utilizador aprovado pode usar
// (não é uma função só de admin).
//
// Secrets necessários (Edge Functions -> Secrets, já existem no projecto):
//   GEMINI_API_KEY   chave do Google AI Studio (partilhada com as outras funções)
//   GEMINI_MODEL     (opcional) fixa um modelo; sem ele descobre o melhor flash
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy sugerir-vinho

// Só tipos — dá o global `EdgeRuntime` ao compilador (usado por processarAnalise).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Orçamento de tempo do trabalho em segundo plano (imagens + pesquisa) — já
// não está limitado pelo browser (o pedido original já respondeu há muito),
// só pelo teto de wall-clock do plano Supabase para a função. Generoso de
// propósito: a pesquisa Google com várias imagens é lenta e imprevisível.
const PROC_TIMEOUT_MS = 110_000;
// Limite curto só para a parte síncrona (autorizar + criar a linha) — esta
// sim tem de responder depressa ao browser.
const SYNC_TIMEOUT_MS = 10_000;

/* ── Escolha do modelo (mesma estratégia das funções irmãs) ── */
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100;
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0;
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      const r = await fetch(
        `${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`,
        { signal },
      );
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback (inclui abort do timeout) */ }
  return _models ?? [];
}
/* SÓ PONTEIROS ("-latest"), nunca nomes de versão fixos. "gemini-2.5-flash"
   e "gemini-2.0-flash" estavam aqui e são exatamente os que a Google
   reformou: respondem 404 "no longer available to new users". Ficavam por
   baixo do ponteiro, que responde primeiro — por isso ninguém dava por
   isso, até ao dia em que o ponteiro desse 429 e esta escada tivesse dois
   degraus podres antes da descoberta a salvar. Mesma lição que já custou
   um deploy de emergência ao `vinho-info` e ao `importar-vinhos` da
   Garrafeira.
   O flash-lite fica em último como cabo de vida: para ler a fotografia de
   uma carta é mais fraco, mas mais fraco é melhor do que nada. */
const ESTAVEIS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const descobertos = await descobrirFlash(signal);
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...descobertos]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIPOS = ["Tinto", "Branco", "Rosé", "Verde", "Espumante", "Doce", "Outro"];

/* ── PASSO 1: LER A CARTA — só visão, sem pesquisa ──
   Esta chamada não escolhe nada nem sabe nada sobre os vinhos: transcreve.
   Foi a separação que tornou o resto possível — enquanto ler e escolher
   eram a mesma passagem, a pesquisa Google tinha de estar ligada (para as
   notas) e com ela vinha o custo, o minuto de espera e a proibição de JSON
   direto. Sem pesquisa, pede-se `response_mime_type: json` e acabou-se a
   pesca de chavetas no texto.

   O PRODUTOR e o ANO pedem-se à parte porque é com eles que o catálogo
   acerta: "Reserva" sozinho não é identidade nenhuma, "Reserva" de "Quinta
   do Crasto" é. A chave junta os tokens do nome e do produtor no mesmo saco
   (ver `winecatalog.tokens`), por isso não faz mal o produtor vir TAMBÉM
   dentro do nome — só faz bem vir, quando a carta o escreve. */
const promptLeitura = (nImagens: number) => `${nImagens > 1
  ? `Aqui estão ${nImagens} fotografias que, juntas, mostram a carta de vinhos de um restaurante em Portugal (o menu não coube numa só foto — trata-as como páginas da MESMA carta).`
  : "Aqui está a fotografia de uma carta de vinhos de um restaurante em Portugal."}
Transcreve TODOS os vinhos legíveis (até 60). Se o mesmo vinho aparecer em
mais que uma foto, conta-o uma única vez. Não avalies nem recomendes nada —
só transcreve o que está impresso.

Devolve APENAS um objeto JSON com esta forma exata:
{"vinhosCarta": [{"nome": string, "produtor": string|null, "ano": number|null,
  "tipo": "Tinto"|"Branco"|"Rosé"|"Verde"|"Espumante"|"Doce"|"Outro"|null,
  "regiao": string|null, "preco": number|null}],
 "aviso": string|null}

Regras:
- "nome": o nome do vinho como está escrito na carta (sem o preço).
- "produtor": só se a carta o escrever (na mesma linha, ou num título de
  secção por produtor); null se não aparecer. Nunca o deduzas de memória.
- "ano": a colheita, só se estiver impressa; null caso contrário.
- "tipo": a cor/estilo — muitas cartas dizem-no pelo título da secção
  ("Tintos", "Brancos", "Espumantes"); null só se nada o deixar perceber.
- "regiao": só se a carta a indicar (na linha ou no título da secção).
- "preco": o preço da GARRAFA em euros; se só houver copo, null.
- "aviso": preenche só se as fotos estiverem ilegíveis ou sem vinhos —
  caso contrário null.
- Nunca inventes: na dúvida, null.`;

/* Já não é preciso com o JSON direto, mas fica: um modelo que embrulhe a
   resposta em ``` ou lhe junte uma frase não pode deitar a análise abaixo.
   (É a mesma função da calendario-sporting.) */
function extrairJson(txt: string): unknown | null {
  const s = String(txt || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* segue */ }
  const semFences = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(semFences); } catch (_) { /* segue */ }
  const ini = semFences.indexOf("{");
  if (ini < 0) return null;
  let nivel = 0, emString = false, escape = false;
  for (let i = ini; i < semFences.length; i++) {
    const c = semFences[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) {
        try { return JSON.parse(semFences.slice(ini, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/* ── Limpeza do que o modelo devolveu ── */
function s(v: unknown, max = 120): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
function numOrNull(v: unknown, min = 0, max = 100000): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
}
function anoOuNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
}
function normVinhoCarta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  return {
    nome,
    produtor: o.produtor ? s(o.produtor, 80) : null,
    // A carta nem sempre dá o ano num campo à parte ("Papa Figos 2020").
    ano: anoOuNull(o.ano) ?? anoDoNome(nome),
    tipo: TIPOS.includes(o.tipo) ? o.tipo : null,
    regiao: o.regiao ? s(o.regiao, 60) : null,
    preco: numOrNull(o.preco, 0, 5000),
    // O que o catálogo sabe deste vinho — ou null, e null quer dizer
    // "não se sabe", nunca "é fraco". Ver `conhecimentoDoCatalogo`.
    conhecido: null as Record<string, unknown> | null,
    precoAvaliacao: null as Record<string, unknown> | null,
  };
}

/* ── O QUE ISTO GASTOU ──
   `usageMetadata` vem da própria API e é FACTO. A análise faz até duas
   chamadas (ler + recomendar), por isso somam-se — uma só das duas contava
   metade da história. */
type UsageMetadata = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };

function usageMetadata(raw: any): UsageMetadata | null {
  const toInt = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const src = raw?.usageMetadata;
  if (!src || typeof src !== "object") return null;
  const out = {
    promptTokenCount: toInt(src.promptTokenCount),
    candidatesTokenCount: toInt(src.candidatesTokenCount),
    thoughtsTokenCount: toInt(src.thoughtsTokenCount),
    totalTokenCount: toInt(src.totalTokenCount),
  };
  return (out.promptTokenCount || out.candidatesTokenCount || out.totalTokenCount) ? out : null;
}
function somarUsage(total: UsageMetadata | null, add: UsageMetadata | null): UsageMetadata | null {
  if (!add) return total;
  if (!total) return { ...add };
  return {
    promptTokenCount: total.promptTokenCount + add.promptTokenCount,
    candidatesTokenCount: total.candidatesTokenCount + add.candidatesTokenCount,
    thoughtsTokenCount: total.thoughtsTokenCount + add.thoughtsTokenCount,
    totalTokenCount: total.totalTokenCount + add.totalTokenCount,
  };
}

/* O CUSTO é uma estimativa GROSSEIRA e é preciso lê-la como tal: os tokens
   acima são facto, isto é um número redondo para dar ordem de grandeza.
   Não é um preço publicado. Quando a leitura levava a pesquisa Google
   ligada isto era 0.02 (a pesquisa é faturada À PARTE, por pedido); sem
   ela é só visão + texto. Se um dia isto passar de curiosidade a
   orçamento, calibra pela fatura real da Google. */
const CUSTO_LEITURA_EUR = 0.003;      // fotos, sem pesquisa
const CUSTO_RECOMENDACAO_EUR = 0.001; // só texto, sem pesquisa

/* ── O modelo da RECOMENDAÇÃO ──
   Ler a fotografia de uma carta não é trabalho para o lite (vai o `flash`
   primeiro, pela `candidatosModelo`). Escolher entre factos já arrumados é:
   o que faz a recomendação acertar são as castas, a harmonização e a nota
   que o catálogo já tem, não o tamanho do modelo. Se o lite falhar, cai-se
   nos outros — trocar de modelo não pode ser um caminho novo para ficar
   sem recomendação. */
const MODELO_LEVE = Deno.env.get("GEMINI_CHEAP_MODEL") || "gemini-flash-lite-latest";

/* ── CATÁLOGO PARTILHADO (schema `winecatalog`) ──
   A memória comum desta app, da Garrafeira e da WineCatalog, no mesmo
   projeto Supabase. Aqui é a PRIMEIRA fonte de verdade de cada vinho da
   carta: o que lá está foi posto por uma pesquisa a sério ou por quem tem a
   garrafa em casa (a `winecatalog.forca()` não deixa entrar estimativas).

   Três regras que não são detalhe:
   · a CHAVE (o que faz dois vinhos serem o mesmo vinho) vive só no SQL:
     daqui vão o nome, o produtor e o ano em cru;
   · esta função NÃO escreve no catálogo. O que lê de uma carta (nome, cor,
     região) não foi confirmado por ninguém; quem escreve é a
     `verificar-vinhos`, com pesquisa a sério;
   · nada disto pode deitar uma análise abaixo. Se o RPC falhar, a carta
     aparece toda como "sem dados" — que é verdade — e segue-se. */
/* 180 dias e não 30. Os campos voláteis (nota, preço) mais velhos do que
   isto vêm de fora como se não estivessem lá. Com a estimativa de memória a
   tapar os buracos, 30 dias chegava; sem ela, a alternativa a uma nota do
   Vivino de há quatro meses é "sem dados" — e uma nota de há quatro meses
   é conhecimento, não palpite. A `verificar-vinhos` usa o mesmo número. */
const CATALOGO_IDADE_DIAS = 180;
// A Garrafeira tem seis cores e esta app tem sete rótulos que não são todos
// cores ("Verde" é estilo, "Doce" é doçura, "Outro" não é nada). Só estes
// quatro querem dizer o mesmo nas duas.
const TIPOS_PARTILHADOS = ["Tinto", "Branco", "Rosé", "Espumante"];

type Conhecido = {
  nome: string; produtor: string; ano: number | null;
  ficha: Record<string, unknown>; fontes: { titulo: string; url: string }[];
  exato: boolean; mesmoAno: boolean | null; atualizadoEm: string;
};

async function catalogoRpc(fn: string, corpo: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_SRV, Authorization: "Bearer " + SB_SRV,
      "Content-Type": "application/json",
      "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
    },
    body: JSON.stringify(corpo),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new Error(`winecatalog ${fn} ${r.status}`);
  return await r.json();
}

function normConhecido(d: any): Conhecido | null {
  if (!d || typeof d !== "object" || !d.ficha) return null;
  return {
    nome: String(d.nome || ""), produtor: String(d.produtor || ""),
    ano: typeof d.ano === "number" ? d.ano : null,
    ficha: (d.ficha && typeof d.ficha === "object") ? d.ficha : {},
    fontes: Array.isArray(d.fontes) ? d.fontes.slice(0, 8) : [],
    exato: d.exato === true,
    mesmoAno: (d.mesmoAno === null || d.mesmoAno === undefined) ? null : d.mesmoAno === true,
    atualizadoEm: String(d.atualizadoEm || ""),
  };
}

/* Uma carta inteira de uma vez. Quarenta idas ao PostgREST era trocar uma
   chamada cara ao Gemini por quarenta baratas — e essa troca faz-se uma vez
   só, aqui. A ordem da resposta é a do pedido, com `null` onde não se sabe. */
async function catalogoProcurarLote(
  pedidos: { nome: string; produtor: string | null; ano: number | null }[], signal?: AbortSignal,
): Promise<{ lista: (Conhecido | null)[]; falhou: boolean }> {
  if (!pedidos.length) return { lista: [], falhou: false };
  try {
    const d = await catalogoRpc("procurar_lote", {
      p_pedidos: pedidos.map((p) => ({ nome: p.nome, produtor: p.produtor || "", ano: p.ano })),
      p_idade_dias: CATALOGO_IDADE_DIAS,
    }, signal);
    if (!Array.isArray(d)) return { lista: pedidos.map(() => null), falhou: true };
    return { lista: pedidos.map((_, i) => normConhecido(d[i])), falhou: false };
  } catch (_) { return { lista: pedidos.map(() => null), falhou: true }; }
}

/* A colheita, quando a carta a escreve ("Papa Figos 2020"). Vale a pena
   tirá-la: com ano, o catálogo responde com a nota DAQUELA colheita; sem
   ele, responde com a de uma recente e diz qual (ver `winecatalog.procurar`). */
function anoDoNome(nome: string): number | null {
  const m = String(nome || "").match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
}

/* O que do catálogo interessa À MESA, numa forma só — é a mesma que a
   `verificar-vinhos` produz depois de pesquisar (com `origem:'pesquisa'`),
   e a app desenha as duas da mesma maneira.
   · a nota é só a do Vivino e só na escala de 5: uma nota de 92/100 de um
     crítico não é a mesma coisa e não se converte;
   · `notaAno` diz de que colheita é a nota — a carta muitas vezes não dá o
     ano, e quem está à mesa merece saber a que garrafa ela pertence.
   Devolve null se o catálogo tiver a linha mas nada que sirva: uma linha
   vazia não é conhecer o vinho. */
function conhecimentoDoCatalogo(c: Conhecido | null): Record<string, unknown> | null {
  if (!c) return null;
  const f = c.ficha as any;
  const nota = numOrNull(f.vivino_nota, 0, 5);
  const u = f.vivino_url;
  const castas = Array.isArray(f.castas) ? f.castas.map((x: unknown) => s(x, 40)).filter(Boolean).slice(0, 8) : [];
  const notaUrl = (nota != null && typeof u === "string" && /^https?:\/\//i.test(u)) ? u.slice(0, 300) : null;
  const out: Record<string, unknown> = {
    nota,
    notaUrl,
    notaAno: nota != null ? c.ano : null,
    pontuacao: nota != null ? [{ fonte: "Vivino", valor: nota, escala: 5, url: notaUrl }] : [],
    precoMercado: numOrNull(f.preco_medio, 0.5, 100000),
    castas,
    regiao: f.regiao ? s(f.regiao, 60) : null,
    tipo: f.tipo ? s(f.tipo, 20) : null,
    estilo: f.estilo ? s(f.estilo, 40) : null,
    harmonizacao: f.harmonizacao ? s(f.harmonizacao, 240) : null,
    notasProva: f.notas_prova ? s(f.notas_prova, 240) : null,
    produtor: c.produtor || null,
    origem: "catalogo",
    origemEm: c.atualizadoEm || null,
  };
  const temAlgo = out.nota != null || out.precoMercado != null || castas.length || out.harmonizacao || out.notasProva;
  return temAlgo ? out : null;
}

/* A conta que substitui a opinião do modelo sobre o preço. Os cortes não
   são ciência — são o que se diz em qualquer restaurante sobre a margem da
   garrafa: 2 a 3 vezes o preço de loja é o normal, abaixo disso é um achado,
   muito acima é abuso. Ficam escritos aqui e no COMENTÁRIO que vai para o
   ecrã: quem está à mesa vê a conta e discorda dela se quiser.
   DUPLICADA de propósito na `verificar-vinhos.ts` (cada Edge Function é
   auto-contida) — se mexeres nos cortes de uma, mexe na outra. */
function avaliarPreco(precoCarta: number | null, precoMercado: number | null): Record<string, unknown> | null {
  if (precoMercado == null || precoMercado <= 0) return null;
  const faixa = `~${precoMercado.toFixed(precoMercado < 20 ? 2 : 0).replace(".", ",")} € em loja`;
  if (precoCarta == null || precoCarta <= 0) {
    return {
      classificacao: "desconhecido", faixaMercado: faixa,
      comentario: "Não li o preço deste vinho na carta, por isso não dá para dizer se está bem de preço.",
    };
  }
  const r = precoCarta / precoMercado;
  const classificacao = r <= 2 ? "barato" : r <= 3 ? "justo" : r <= 4.5 ? "caro" : "muito_caro";
  const rTxt = r.toFixed(1).replace(".", ",");
  const extra = classificacao === "barato"
    ? "abaixo do que é habitual num restaurante (2 a 3 vezes o preço de loja)."
    : classificacao === "justo"
    ? "dentro do habitual num restaurante (2 a 3 vezes o preço de loja)."
    : classificacao === "caro"
    ? "acima do habitual num restaurante (2 a 3 vezes o preço de loja)."
    : "muito acima do habitual num restaurante (2 a 3 vezes o preço de loja).";
  return {
    classificacao, faixaMercado: faixa,
    comentario: `Custa cerca de ${precoMercado.toFixed(precoMercado < 20 ? 2 : 0).replace(".", ",")} € numa loja e ${precoCarta.toFixed(2).replace(".", ",")} € nesta carta — ${rTxt}×, ${extra}`,
  };
}

/* ── PASSO 3: RECOMENDAR, só com o que se sabe ──
   DUPLICADO de propósito na `verificar-vinhos.ts`, que recomenda outra vez
   depois de pesquisar (cada Edge Function deste projeto é auto-contida). Se
   mexeres no prompt ou nas regras de uma, mexe na outra no MESMO dia.

   O desenho que torna isto "assertivo" em vez de "adivinhado":
   · o modelo escolhe por ÍNDICE, e só entre os vinhos marcados CONHECIDO.
     Um índice que não exista, ou que aponte para um desconhecido, é
     deitado fora aqui — um vinho que não está na carta, ou de que não se
     sabe nada, não pode ser recomendado nem por engano;
   · o modelo devolve só a ORDEM e a frase da harmonização. A nota, o preço
     da carta e o "barato/justo/caro" do cartão montam-se aqui, a partir
     dos dados — nunca do texto do modelo;
   · `pesquisar` são desconhecidos que, pela cor, região e preço, valia a
     pena pesquisar para este prato. É uma sugestão de onde gastar a
     pesquisa, não um facto: a app só os pré-selecciona. */
const MAX_PESQUISAR = 4;

const promptRecomendacao = (
  vinhos: Record<string, unknown>[], prato: string, orcamento: number | null,
) => {
  const linhas = vinhos.map((v, i) => {
    const k = v.conhecido as any;
    const base = [
      `[${i}] ${v.nome}`,
      v.produtor ? `produtor: ${v.produtor}` : "",
      v.ano ? `colheita: ${v.ano}` : "",
      v.tipo ? `tipo: ${v.tipo}` : (k?.tipo ? `tipo: ${k.tipo}` : ""),
      (v.regiao || k?.regiao) ? `região: ${v.regiao || k.regiao}` : "",
      v.preco != null ? `preço na carta: ${v.preco}€` : "preço na carta: ?",
    ].filter(Boolean).join(" | ");
    if (!k) return `${base} | DESCONHECIDO`;
    const notas = (Array.isArray(k.pontuacao) ? k.pontuacao : [])
      .map((p: any) => `${p.fonte} ${p.valor}/${p.escala}`).join(", ");
    const factos = [
      notas,
      k.precoMercado != null ? `loja ~${k.precoMercado}€` : "",
      k.castas?.length ? `castas: ${k.castas.join(", ")}` : "",
      k.estilo ? `estilo: ${k.estilo}` : "",
      k.harmonizacao ? `harmoniza com: ${k.harmonizacao}` : "",
      k.notasProva ? `prova: ${k.notasProva}` : "",
    ].filter(Boolean).join(" | ");
    return `${base} | CONHECIDO | ${factos}`;
  }).join("\n");

  return `És um escanção num restaurante em Portugal. Esta é a carta de vinhos,
com o que se SABE de cada vinho (marcado CONHECIDO, com os factos à frente)
ou DESCONHECIDO (não temos dados fiáveis sobre ele).

${linhas}

${prato ? `O prato a acompanhar é: "${prato}".` : "Não foi indicado nenhum prato — escolhe vinhos versáteis e bem avaliados."}
${orcamento ? `Orçamento máximo: ${orcamento}€ por garrafa (preço na carta). Só saias dele se NENHUM vinho CONHECIDO o cumprir, e di-lo na "combinacao".` : ""}

Devolve APENAS um objeto JSON com esta forma exata:
{"sugestoes": [{"i": number, "combinacao": string}], "pesquisar": [number]}

Regras:
- "sugestoes": 0 a 3 vinhos, do melhor para o pior, escolhidos SÓ entre os
  marcados CONHECIDO. Nunca escolhas um DESCONHECIDO. Se nenhum CONHECIDO
  servir, devolve [].
- Pesa a harmonização com o prato (corpo, acidez, taninos, castas, o que o
  vinho diz harmonizar), depois a nota do Vivino, depois a relação entre o
  preço na carta e o preço de loja (2 a 3 vezes é o normal num restaurante).
  Dá prioridade a vinhos PORTUGUESES quando houver um bom.
- "combinacao": uma a duas frases concretas sobre porque combina com o
  prato, apoiadas nos factos dados. Não cites notas nem preços que não
  estejam na lista, e não inventes castas nem características.
- "pesquisar": até ${MAX_PESQUISAR} índices de vinhos DESCONHECIDOS que, pelo tipo, região e
  preço, seriam bons candidatos para este prato${orcamento ? " e orçamento" : ""} — os que valeria a pena
  pesquisar. [] se não houver desconhecidos ou nenhum fizer sentido.
Responde só com o JSON.`;
};

/* Monta o cartão de uma sugestão a partir dos DADOS (ver o bloco acima).
   A forma é a mesma que as sugestões sempre tiveram, para a app e o
   histórico continuarem a desenhá-las com o mesmo código. */
function sugestaoDe(v: Record<string, unknown>, i: number, combinacao: string): Record<string, unknown> {
  const k = (v.conhecido ?? {}) as any;
  return {
    i,
    nome: v.nome,
    produtor: v.produtor ?? k.produtor ?? null,
    tipo: v.tipo ?? k.tipo ?? "Outro",
    regiao: v.regiao ?? k.regiao ?? null,
    casta: Array.isArray(k.castas) && k.castas.length ? k.castas.join(", ") : null,
    precoCarta: v.preco ?? null,
    pontuacao: Array.isArray(k.pontuacao) ? k.pontuacao : [],
    notaAno: k.notaAno ?? null,
    precoAvaliacao: v.precoAvaliacao ?? { classificacao: "desconhecido", faixaMercado: null, comentario: "" },
    combinacao: s(combinacao, 400),
    origem: k.origem ?? null,
  };
}

async function recomendar(
  vinhos: Record<string, unknown>[], prato: string, orcamento: number | null,
  modeloPesado: string, parentSignal: AbortSignal,
): Promise<{ sugestoes: Record<string, unknown>[]; pesquisar: number[]; usage: UsageMetadata | null; modelo: string; falhou: boolean; motivo: string }> {
  const out = { sugestoes: [] as Record<string, unknown>[], pesquisar: [] as number[], usage: null as UsageMetadata | null, modelo: "", falhou: false, motivo: "" };
  if (!vinhos.length) return out;

  const ctrl2 = new AbortController();
  const onAbort = () => ctrl2.abort();
  parentSignal.addEventListener("abort", onAbort);
  const subTimer = setTimeout(() => ctrl2.abort(), 25_000);
  const texto = promptRecomendacao(vinhos, prato, orcamento);

  const tentar = async (m: string): Promise<any | null> => {
    const r = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl2.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: texto }] }],
        generationConfig: {
          temperature: 0,
          response_mime_type: "application/json",
          // Sem pesquisa ligada aqui, por isso o thinkingBudget:0 é seguro
          // (é com o google_search que ele dá 400).
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!r.ok) { out.motivo = `HTTP ${r.status} (${m})`; return null; }
    const d = await r.json();
    out.usage = somarUsage(out.usage, usageMetadata(d));
    const cand = d?.candidates?.[0];
    const txt = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    // Um 200 vazio não é "não há nada a recomendar" — passa ao seguinte.
    if (!txt) { out.motivo = `${cand?.finishReason || "vazio"} (${m})`; return null; }
    const j = extrairJson(txt);
    if (!j || typeof j !== "object") { out.motivo = `ilegível (${m})`; return null; }
    out.modelo = m;
    return j;
  };

  try {
    const vistos = new Set<string>();
    const ordem = [MODELO_LEVE, modeloPesado].filter((m) => m && (vistos.has(m) ? false : vistos.add(m)));
    let j: any = null;
    for (const m of ordem) {
      if (ctrl2.signal.aborted) break;
      j = await tentar(m);
      if (j) break;
    }
    if (!j) { out.falhou = true; return out; }

    const conhecido = (i: number) => Number.isInteger(i) && i >= 0 && i < vinhos.length && !!vinhos[i].conhecido;
    const usados = new Set<number>();
    for (const x of Array.isArray(j.sugestoes) ? j.sugestoes : []) {
      const i = Number(x?.i);
      if (!conhecido(i) || usados.has(i)) continue;
      usados.add(i);
      out.sugestoes.push(sugestaoDe(vinhos[i], i, String(x?.combinacao ?? "")));
      if (out.sugestoes.length >= 3) break;
    }
    const pesq = new Set<number>();
    for (const x of Array.isArray(j.pesquisar) ? j.pesquisar : []) {
      const i = Number(x);
      if (!Number.isInteger(i) || i < 0 || i >= vinhos.length || vinhos[i].conhecido) continue;
      pesq.add(i);
      if (pesq.size >= MAX_PESQUISAR) break;
    }
    out.pesquisar = [...pesq];
    return out;
  } catch (e) {
    out.falhou = true;
    out.motivo = String((e as Error).message || e).slice(0, 120);
    return out;
  } finally {
    clearTimeout(subTimer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

async function emailAutorizado(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
    signal,
  });
  if (!u.ok) {
    console.log("SUGERIR-VINHO /user erro:", u.status, (await u.text().catch(() => "")).slice(0, 300));
    return { ok: false, email: null };
  }
  const uj = await u.json();
  const email = String(uj.email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null };
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    {
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Accept-Profile": "wineselection",
      },
      signal,
    },
  );
  if (!r.ok) return { ok: false, email };
  const rows = await r.json();
  return { ok: Array.isArray(rows) && rows.length > 0, email };
}

/* Rasto de cada chamada em `wineselection.sync_log` (migração db/sync-log
   está dentro do schema.sql). Nunca deita a resposta abaixo por isto falhar. */
async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Content-Type": "application/json",
        "Content-Profile": "wineselection",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ acao: "sugerir_vinho", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("SUGERIR-VINHO sync_log falhou:", r.status);
  } catch (e) {
    console.log("SUGERIR-VINHO sync_log erro:", String((e as Error).message).slice(0, 200));
  }
  await registarIaUso("sugerir-vinho", estado, detalhe, quem);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps que chamam o Gemini (ver o CLAUDE.md da
   WineCatalog, "O registo central de acessos ao Gemini"). O MESMO `detalhe`
   de cima, com tokens/modelo/custo também promovidos a colunas, para uma
   tabela que soma o gasto do Gemini ao todo em vez de app a app. Nunca deita
   a resposta abaixo por isto falhar — mesma regra do `registar()` local. */
async function registarIaUso(funcao: string, estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const usage = (detalhe.usageMetadata ?? null) as
      | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number }
      | null;
    const pesquisa = detalhe.pesquisa as unknown;
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Content-Type": "application/json",
        "Content-Profile": "ia_uso",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        app: "wineselection", funcao,
        estado: estado === "pedido" || estado === "erro" ? estado : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null,
        pesquisa_web: typeof pesquisa === "boolean" ? pesquisa : (typeof pesquisa === "string" ? pesquisa.length > 0 : null),
        tokens_entrada: usage?.promptTokenCount ?? null,
        tokens_saida: usage?.candidatesTokenCount ?? null,
        tokens_pensamento: usage?.thoughtsTokenCount ?? null,
        tokens_total: usage?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null,
        quem,
        erro: estado === "erro"
          ? (String((detalhe.erro as string | undefined) ?? (detalhe.passo as string | undefined) ?? "").slice(0, 500) || null)
          : null,
        detalhe,
      }),
    });
  } catch (_e) {
    // nunca deita a chamada principal abaixo
  }
}

/* Cria a linha em `wineselection.analises` (estado 'pendente' por omissão)
   usando o PRÓPRIO JWT do utilizador (pass-through do header Authorization,
   igual ao que já se faz em emailAutorizado para /auth/v1/user) — assim a
   RLS e o trigger `analises_guard_ins` correm normalmente e o `user_email`
   fica certo, sem ser preciso confiar em nada que o cliente mande. */
async function criarAnaliseRegisto(auth: string, prato: string, signal: AbortSignal): Promise<number | null> {
  const r = await fetch(`${SB_URL}/rest/v1/analises`, {
    method: "POST",
    headers: {
      apikey: SB_SRV,
      Authorization: auth,
      "Content-Type": "application/json",
      "Content-Profile": "wineselection",
      Prefer: "return=representation",
    },
    signal,
    body: JSON.stringify({ prato }),
  });
  if (!r.ok) {
    console.log("SUGERIR-VINHO criar registo erro:", r.status, (await r.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const rows = await r.json();
  const id = rows?.[0]?.id;
  return typeof id === "number" ? id : null;
}

/* Fecha a linha (concluído ou erro) — SERVICE ROLE porque isto corre em
   segundo plano, depois do pedido original (e do seu JWT) já ter respondido.
   `user_email=eq.` no WHERE garante que só mexe na linha do próprio dono,
   mesmo a service role tendo acesso a tudo — não confia só no `id`. */
async function atualizarAnalise(id: number, quem: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/analises?id=eq.${id}&user_email=eq.${encodeURIComponent(quem)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SB_SRV,
          Authorization: `Bearer ${SB_SRV}`,
          "Content-Type": "application/json",
          "Content-Profile": "wineselection",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(patch),
      },
    );
    if (!r.ok) console.log("SUGERIR-VINHO atualizar registo falhou:", r.status);
  } catch (e) {
    console.log("SUGERIR-VINHO atualizar registo erro:", String((e as Error).message).slice(0, 200));
  }
}

/* O trabalho a sério — chamado via EdgeRuntime.waitUntil, corre depois de já
   se ter respondido ao browser. Nunca deixa a linha presa em 'pendente':
   ou fecha 'concluido' com o resultado, ou 'erro' com uma mensagem legível. */
async function processarAnalise(
  partsImg: unknown[],
  pratoLimpo: string,
  nImagens: number,
  orcamentoNum: number | null,
  quem: string,
  analiseId: number,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
  let model = "gemini-flash-latest";
  // O que esta análise gastou, somado ao longo das (até) duas chamadas.
  let usageTotal: UsageMetadata | null = null;
  let chamadas = 0;

  try {
    const parts: unknown[] = [...partsImg, { text: promptLeitura(nImagens) }];

    /* Sem pesquisa, por isso sem o conflito do `thinkingBudget:0` com o
       `google_search` (ver o CLAUDE.md). Transcrever uma carta não precisa
       de pensar, e pensar é o que gastava o orçamento todo e devolvia o
       "200 vazio". A segunda variante (sem mexer no pensamento) é só para
       um modelo que um dia recuse o `thinkingConfig` com 400. */
    type Variante = { semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { semThinking: true, label: "leitura" },
      { semThinking: false, label: "leitura-com-pensamento" },
    ];
    const chamarGemini = (m: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = { temperature: 0, response_mime_type: "application/json" };
      if (v.semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      });
    };

    const transitorio = (st: number) => st === 429 || st === 500 || st === 503;

    const candidatos = await candidatosModelo(ctrl.signal);
    if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
    console.log("SUGERIR-VINHO candidatos:", candidatos.join(", "));
    let g: Response | null = null;
    let gd: any = null;
    let textoResp = "";
    let vazioMotivo = "";

    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];
      for (let vi = 0; vi < variantes.length && !ctrl.signal.aborted; vi++) {
        const v = variantes[vi];
        g = await chamarGemini(model, v);
        console.log("SUGERIR-VINHO tentativa:", model, v.label, "->", g.status);
        if (g.status === 400) continue; // esta variante não é aceite por este modelo — tenta a seguinte
        break; // sucesso, ou erro definitivo — não continua a testar variantes deste modelo
      }
      /* Um 200 com o corpo VAZIO não é resposta. Lê-se o corpo AQUI para se
         poder passar ao modelo seguinte. Ver o CLAUDE.md da WineCatalog,
         "O 200 vazio". */
      if (g && g.ok) {
        gd = await g.json();
        const cand0 = gd?.candidates?.[0];
        vazioMotivo = String(cand0?.finishReason ?? "") || "resposta vazia";
        textoResp = (cand0?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
        console.log("SUGERIR-VINHO resposta:", model, "finishReason:", vazioMotivo,
                    "texto:", textoResp.length, "tokens saída:", gd?.usageMetadata?.candidatesTokenCount ?? 0);
        usageTotal = somarUsage(usageTotal, usageMetadata(gd));
        chamadas++;
        if (textoResp) break;
        g = null;
        continue;
      }
      if (g && g.status === 404) { _models = null; continue; } // saiu do catálogo — tenta o modelo seguinte
      if (g && !transitorio(g.status)) break; // erro definitivo — não vale a pena continuar
      // transitório (429/500/503): tenta já o modelo seguinte, sem esperar
    }

    if (g && !g.ok) {
      const status = g.status;
      const detail = await g.text();
      console.error("gemini", model, status, detail.slice(0, 500));
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      await registar("erro", {
        passo: "gemini", status, modelo: model, pesquisa: false,
        erro: (msg || detail).slice(0, 800), ms: Date.now() - t0,
      }, quem);
      const erroUtilizador = transitorio(status)
        ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez"
        : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`;
      await atualizarAnalise(analiseId, quem, { estado: "erro", erro: erroUtilizador });
      return;
    }

    /* Nenhum modelo escreveu uma letra. Não é o mesmo que "resposta
       ilegível" — ali havia texto e não se entendeu; aqui não houve. */
    if (!g || !textoResp) {
      await registar("erro", {
        passo: g ? "gemini_vazio" : "sem-resposta", modelo: model, pesquisa: false,
        finishReason: vazioMotivo || null, ms: Date.now() - t0,
        ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      }, quem);
      await atualizarAnalise(analiseId, quem, {
        estado: "erro",
        erro: `o modelo não devolveu resposta (${vazioMotivo || "vazia"}) — tenta outra vez`,
      });
      return;
    }

    const parsed: any = extrairJson(textoResp);
    if (!parsed) {
      console.error("SUGERIR-VINHO resposta ilegível:", textoResp.slice(0, 400));
      await registar("erro", { passo: "json", modelo: model, pesquisa: false, amostra: textoResp.slice(0, 800), ms: Date.now() - t0 }, quem);
      await atualizarAnalise(analiseId, quem, {
        estado: "erro",
        erro: "resposta ilegível do modelo — tenta uma foto mais nítida",
      });
      return;
    }

    const vinhosCarta = (Array.isArray(parsed.vinhosCarta) ? parsed.vinhosCarta : [])
      .map(normVinhoCarta).filter(Boolean).slice(0, 60) as Record<string, unknown>[];
    const aviso = parsed.aviso ? s(parsed.aviso, 200) : null;

    /* ── PASSO 2: o que já se sabe ──
       Uma ida só ao catálogo, pela carta toda. O que vier é facto (com a
       origem e a data); o que não vier fica "sem dados" — e é isso que se
       mostra, em vez de um palpite. */
    let doCatalogo = 0;
    let catalogoFalhou = false;
    if (vinhosCarta.length && !ctrl.signal.aborted) {
      const r = await catalogoProcurarLote(
        vinhosCarta.map((v) => ({ nome: String(v.nome), produtor: (v.produtor as string | null) ?? null, ano: v.ano as number | null })),
        ctrl.signal,
      );
      catalogoFalhou = r.falhou;
      vinhosCarta.forEach((v, i) => {
        const k = conhecimentoDoCatalogo(r.lista[i]);
        if (!k) return;
        v.conhecido = k;
        v.precoAvaliacao = avaliarPreco(v.preco as number | null, k.precoMercado as number | null);
        doCatalogo++;
      });
    }

    /* ── PASSO 3: recomendar entre os conhecidos ──
       Nunca deita a análise abaixo: se falhar, a lista com o que se sabe
       continua lá, e a app diz que não houve recomendação (`recomendacao`)
       em vez de fingir que não havia nada a recomendar. */
    let rec = { sugestoes: [] as Record<string, unknown>[], pesquisar: [] as number[], usage: null as UsageMetadata | null, modelo: "", falhou: false, motivo: "" };
    if (vinhosCarta.length && !ctrl.signal.aborted) {
      rec = await recomendar(vinhosCarta, pratoLimpo, orcamentoNum, model, ctrl.signal);
      usageTotal = somarUsage(usageTotal, rec.usage);
      if (rec.modelo || rec.usage) chamadas++;
    }
    const recomendacao = !vinhosCarta.length ? "sem-carta"
      : rec.falhou ? "falhou"
      : !doCatalogo ? "sem-conhecidos"
      : "ok";

    console.log("SUGERIR-VINHO vinhosCarta:", vinhosCarta.length, "catalogo:", doCatalogo,
                "sugestoes:", rec.sugestoes.length, "recomendacao:", recomendacao);
    await registar("ok", {
      vinhos_carta: vinhosCarta.length, modelo: model, pesquisa: false,
      prato: pratoLimpo, fotos: nImagens, orcamento: orcamentoNum,
      // Quantos vinhos da carta o catálogo já conhecia: é por aqui que se
      // vê se a partilha está a valer a pena — e é o número que devia subir.
      catalogo_conhecidos: doCatalogo,
      catalogo_falhou: catalogoFalhou,
      sugestoes: rec.sugestoes.length,
      recomendacao,
      ...(rec.motivo ? { recomendacao_motivo: rec.motivo } : {}),
      ...(rec.modelo ? { modelo_leve: rec.modelo } : {}),
      pesquisar_sugeridos: rec.pesquisar.length,
      // O que isto custou: os tokens são facto (vêm da API), o euro é a
      // estimativa grosseira dos CUSTO_*_EUR lá em cima.
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      chamadas_gemini: chamadas,
      custo_estimado_eur: Number(
        (CUSTO_LEITURA_EUR + (rec.modelo ? CUSTO_RECOMENDACAO_EUR : 0)).toFixed(4),
      ),
      ms: Date.now() - t0,
    }, quem);

    const resultado = {
      // 2 = o desenho "ou sabemos ou não sabemos": `vinhosCarta[].conhecido`
      // em vez de `pontuacaoAprox`. A app usa isto para desenhar os
      // resultados antigos do histórico como eram.
      versao: 2,
      prato: pratoLimpo,
      orcamento: orcamentoNum,
      sugestoes: rec.sugestoes,
      recomendacao,
      pesquisar: rec.pesquisar,
      vinhosCarta,
      aviso,
      pesquisa: false,
      modelo: model,
      geradoEm: new Date().toISOString(),
    };
    await atualizarAnalise(analiseId, quem, { estado: "concluido", resultado });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500), ms: Date.now() - t0 }, quem);
    await atualizarAnalise(analiseId, quem, {
      estado: "erro",
      erro: timeout
        ? "o modelo demorou demasiado a ler a carta — tenta outra vez, ou uma foto mais nítida"
        : (err.message || "erro inesperado"),
    });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization") ?? "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  let quem: string | null = null;

  try {
    console.log("SUGERIR-VINHO start");
    const auth = await emailAutorizado(authHeader, ctrl.signal);
    quem = auth.email;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "não autorizado" }, 403);
    }

    const { imagens, prato, orcamento } = await req.json().catch(() => ({}) as any);
    if (!Array.isArray(imagens) || imagens.length === 0 || imagens.length > 6) {
      await registar("erro", { passo: "imagens", count: Array.isArray(imagens) ? imagens.length : null }, quem);
      return json({ error: "envia entre 1 e 6 fotos da carta" }, 400);
    }
    let totalLen = 0;
    const partsImg: unknown[] = [];
    for (const img of imagens) {
      const data = img && typeof img.data === "string" ? img.data : null;
      if (!data || data.length > 6_000_000) {
        await registar("erro", { passo: "imagem_individual" }, quem);
        return json({ error: "uma das fotos está em falta ou é demasiado grande" }, 400);
      }
      totalLen += data.length;
      if (totalLen > 20_000_000) {
        await registar("erro", { passo: "imagens_total", total: totalLen }, quem);
        return json({ error: "fotos demasiado grandes no total — tenta menos fotos ou mais comprimidas" }, 400);
      }
      partsImg.push({ inline_data: { mime_type: (img.mime as string) || "image/jpeg", data } });
    }
    const pratoLimpo = s(prato, 200);
    const orcamentoNum = numOrNull(orcamento, 1, 10000);

    const analiseId = await criarAnaliseRegisto(authHeader, pratoLimpo, ctrl.signal);
    if (analiseId == null) {
      await registar("erro", { passo: "criar_registo" }, quem);
      return json({ error: "não consegui iniciar a análise — tenta outra vez" }, 502);
    }

    // NÃO faz await — o trabalho pesado continua depois de já se ter
    // respondido, e sobrevive ao pedido original terminar (ver o comentário
    // no topo do ficheiro).
    EdgeRuntime.waitUntil(
      processarAnalise(partsImg, pratoLimpo, imagens.length, orcamentoNum, quem!, analiseId),
    );

    return json({ id: analiseId, estado: "pendente" }, 202);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 500) }, quem);
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
