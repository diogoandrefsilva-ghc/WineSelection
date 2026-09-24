// supabase/functions/verificar-vinhos/index.ts
// WineSelection — Pesquisa "a sério" (Google real) para até 4 vinhos que o
// catálogo ainda não conhece, escolhidos à mão na carta já lida
// (`resultado.vinhosCarta`, pelo índice). É a ÚNICA pesquisa paga desta app
// desde que a `sugerir-vinho` deixou de pesquisar (ver "Ou sabemos ou não
// sabemos" no cabeçalho dela), e faz três coisas:
//   1. pesquisa nota, preço de loja, castas, região, cor e harmonização;
//   2. volta a RECOMENDAR sobre a carta inteira — o que já se sabia mais o
//      que acabou de chegar (a mesma `recomendar` da `sugerir-vinho`,
//      duplicada de propósito);
//   3. guarda o que encontrou no catálogo partilhado, que é o que faz a
//      próxima carta com estes vinhos — nesta app ou noutra — sair de graça.
//
// Mesma arquitetura assíncrona do sugerir-vinho.ts (EdgeRuntime.waitUntil +
// polling do lado do browser) — mexe na MESMA linha de
// `wineselection.analises` (a análise já tem de estar 'concluido'), só em
// três colunas à parte: `verificacao_estado` / `verificacao` /
// `verificacao_erro`. Nunca toca em `estado`/`resultado`.
//
// Autorização e descoberta de modelo iguais à sugerir-vinho.ts (duplicadas
// aqui de propósito — cada Edge Function deste projeto é auto-contida,
// mesma convenção da calendario-sporting/fatura-restaurante).
//
// Deploy: supabase functions deploy verificar-vinhos

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Sem imagens, só texto + pesquisa, mas a pesquisa Google é
// lenta/imprevisível — e a seguir ainda há a recomendação.
const PROC_TIMEOUT_MS = 90_000;
const SYNC_TIMEOUT_MS = 10_000;
const MAX_VINHOS = 4;

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

function s(v: unknown, max = 120): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}
function numOrNull(v: unknown, min = 0, max = 100000): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
}
function extrairJson(txt: string): unknown | null {
  const s2 = String(txt || "").trim();
  if (!s2) return null;
  try { return JSON.parse(s2); } catch (_) { /* segue */ }
  const semFences = s2.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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
function normPontuacao(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const p of raw as any[]) {
    if (!p || typeof p !== "object") continue;
    const fonte = s(p.fonte, 40);
    const escala = numOrNull(p.escala, 1, 100) ?? 5;
    const valor = numOrNull(p.valor, 0, escala);
    if (!fonte || valor == null) continue;
    let url: string | null = null;
    if (typeof p.url === "string" && /^https?:\/\//i.test(p.url)) url = p.url.slice(0, 300);
    out.push({ fonte, valor, escala, url });
    if (out.length >= 5) break;
  }
  return out;
}

/* ── O QUE ISTO GASTOU ──
   Duplicado da `sugerir-vinho.ts` de propósito — cada Edge Function deste
   projeto é auto-contida. Agora são até duas chamadas (pesquisar +
   recomendar), por isso somam-se. */
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

/* Estimativa GROSSEIRA, como na irmã: os tokens são facto, o euro é um
   número redondo para dar ordem de grandeza. A pesquisa Google é faturada
   à parte, por pedido — calibra pela fatura real se isto passar de
   curiosidade a orçamento. Zero quando a resposta veio toda do catálogo:
   aí não se falou com o Gemini para pesquisar, e é esse o número que
   interessa ver. */
const CUSTO_VERIFICACAO_EUR = 0.01;
const CUSTO_RECOMENDACAO_EUR = 0.002;
const MODELO_LEVE = Deno.env.get("GEMINI_CHEAP_MODEL") || "gemini-flash-lite-latest";

/* ── CATÁLOGO PARTILHADO (schema `winecatalog`) ──
   Esta é a função que ENCHE o catálogo a partir desta app. É a mais cara
   das duas (pesquisa Google a sério, pedida à mão) e por isso é a que mais
   ganha em não repetir trabalho: se alguém já pesquisou este vinho — aqui,
   na Garrafeira ou na WineCatalog — a resposta já existe e não se paga.

   O QUE VEM DO CATÁLOGO E O QUE NÃO PODE VIR. A pontuação é do VINHO e
   viaja bem. A classificação do preço ("barato/justo/caro") NÃO é do
   vinho: é um juízo sobre A CARTA que está à frente. Por isso o catálogo
   guarda o preço de MERCADO e a comparação com esta carta refaz-se sempre,
   aqui em código (`avaliarPreco`) — também para o que acabou de ser
   pesquisado: a opinião do modelo sobre o preço já não chega ao ecrã.

   A trave: só se responde do catálogo sem pesquisar quando lá estão AS
   DUAS COISAS (a nota e o preço de mercado). Quem escolheu estes vinhos à
   mão escolheu-os porque quer saber, e meia resposta não é o que veio
   buscar. Mesma janela de idade da `sugerir-vinho` (ver lá porquê). */
const CATALOGO_IDADE_DIAS = 180;
const TIPOS_PARTILHADOS = ["Tinto", "Branco", "Rosé", "Espumante"];

async function catalogoJuntar(
  nome: string, produtor: string | null, ano: number | null, ficha: Record<string, unknown>, signal?: AbortSignal,
) {
  try {
    if (!nome || !Object.keys(ficha).length) return;
    await catalogoRpc("juntar", {
      p_nome: nome, p_produtor: produtor || "", p_ano: ano,
      p_ficha: ficha, p_origem: "ws-verificacao", p_fontes: [],
    }, signal);
  } catch (_) { /* o catálogo nunca falha uma verificação */ }
}

/* "18-25 €" -> 21.5, para o catálogo. Um texto sem número nenhum não
   escreve nada: inventar um preço num catálogo partilhado era o pior que
   daqui podia sair. */
function precoMedioDeFaixa(txt: unknown): number | null {
  const nums = String(txt ?? "").replace(",", ".").match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(Number).filter((n) => isFinite(n) && n > 0 && n < 100000);
  if (!vals.length) return null;
  return Math.round(((Math.min(...vals) + Math.max(...vals)) / 2) * 100) / 100;
}

/* Castas: parte-se a lista e deitam-se fora as palavras que dizem a
   CONTAGEM das castas em vez de uma casta — senão nascia uma casta
   fantasma chamada "Blend" ao lado das verdadeiras. */
function castasDaLista(raw: unknown): string[] {
  const lista = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,;/]|\se\s/i);
  return [...new Set(lista
    .map((x) => x.replace(/\s*\(\d+%?\)\s*/g, " ").replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 2 && x.length <= 50)
    .filter((x) => !/^(blend|lote|v[aá]rias|diversas|field blend|castas?|misto|assemblage)$/i.test(x)))]
    .slice(0, 12);
}

/* ── A PESQUISA A SÉRIO ──
   Mais do que a nota e o preço: as castas, a região, a cor e a
   harmonização. É o que a recomendação a seguir precisa para escolher com
   fundamento, e é o que faz o catálogo servir a próxima carta — pagar uma
   pesquisa e guardar só metade do que ela encontrou era pagar a outra
   metade da próxima vez. */
type VinhoPedido = {
  i: number; nome: string; produtor: string | null; ano: number | null;
  tipo: string | null; regiao: string | null; preco: number | null;
};

const promptVerificacao = (vinhos: VinhoPedido[]) => {
  const lista = vinhos.map((v, k) =>
    `${k + 1}. ${v.nome}${v.produtor ? ` — produtor: ${v.produtor}` : ""}${v.ano ? ` — colheita ${v.ano}` : ""}${v.tipo ? ` — ${v.tipo}` : ""}${v.regiao ? ` (${v.regiao})` : ""}`
  ).join("\n");
  return `Estes são vinhos específicos de uma carta de restaurante em Portugal.
Para CADA UM, usa PESQUISA GOOGLE para confirmar:
- a pontuação em sites de referência (sobretudo Vivino, escala de 5; outros
  como Wine-Searcher também servem);
- o preço de RETALHO em Portugal (loja ou venda direta do produtor);
- as castas, a região, a cor e com que pratos harmoniza (do produtor ou de
  uma loja séria).

${lista}

Devolve APENAS um objeto JSON com esta forma exata:
{"resultados": [{"n": number,
  "pontuacao": [{"fonte": string, "valor": number, "escala": number, "url": string|null}],
  "faixaMercado": string|null,
  "tipo": "Tinto"|"Branco"|"Rosé"|"Verde"|"Espumante"|"Doce"|"Outro"|null,
  "regiao": string|null, "castas": [string], "harmonizacao": string|null}]}

Regras:
- Um objeto por vinho pedido; "n" é o número dele na lista acima (1 a ${vinhos.length}).
- "pontuacao": só fontes que tenhas mesmo confirmado pela pesquisa — nunca
  adivinhes uma nota. Sem confirmação fiável, [].
- "faixaMercado": preço de RETALHO em euros (ex.: "6-9€"), não o do
  restaurante; null se não encontrares um fiável.
- "castas", "regiao", "tipo", "harmonizacao": só o que
  encontraste; na dúvida [] ou null. Nunca inventes castas.
Responde só com o JSON, sem texto à volta e sem blocos de código.`;
};

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
   · o modelo ORDENA todos os vinhos conhecidos por ÍNDICE (`ranking`) e
     marca os 2 ou 3 que recomenda de facto (`recomendados`). Um índice que
     não exista, ou que aponte para um desconhecido, é deitado fora aqui —
     um vinho que não está na carta, ou de que não se sabe nada, não pode
     ser recomendado nem por engano;
   · o modelo devolve só a ORDEM e a frase da harmonização. A nota, o preço
     da carta e o "barato/justo/caro" de cada cartão montam-se aqui, a
     partir dos dados — nunca do texto do modelo;
   · um vinho SEM nota não passa à frente de um COM nota dentro dos
     recomendados — dito no prompt e garantido em código, a seguir. Foi o
     que aconteceu na primeira carta a sério (24/09/2026): três vinhos com
     boa nota no Vivino e a recomendação no único que não tinha nenhuma;
   · `pesquisar` são desconhecidos que, pela cor, região e preço, valia a
     pena pesquisar para este prato. É uma sugestão de onde gastar a
     pesquisa, não um facto: a app só os pré-selecciona. */
const MAX_PESQUISAR = 4;
const MAX_RANKING = 10;

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
      notas || "SEM NOTA",
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
${orcamento ? `Orçamento máximo: ${orcamento}€ por garrafa (preço na carta). Um vinho acima do orçamento só entra nos recomendados se NENHUM conhecido o cumprir, e di-lo na "razao".` : ""}

Devolve APENAS um objeto JSON com esta forma exata:
{"ranking": [{"i": number, "razao": string}], "recomendados": [number], "pesquisar": [number]}

Regras:
- "ranking": TODOS os vinhos marcados CONHECIDO (até ${MAX_RANKING}), do melhor para o
  pior para este prato. Nunca incluas um DESCONHECIDO.
- Critérios, por esta ordem:
  1. harmonização com o prato (corpo, acidez, taninos, castas, o que o
     vinho diz harmonizar) — um vinho que não combina fica sempre atrás;
  2. entre os que combinam, a NOTA: um vinho com nota alta fica à frente
     de um com nota baixa, e um vinho "SEM NOTA" NUNCA fica à frente de um
     que combine e tenha nota de 3.8 ou mais;
  3. a relação entre o preço na carta e o preço de loja (2 a 3 vezes é o
     normal num restaurante);
  4. em igualdade, dá prioridade aos PORTUGUESES.
- "recomendados": os 2 ou 3 primeiros do ranking que recomendarias mesmo a
  quem está à mesa (só 1 se só um combinar; [] se nenhum combinar).
- "razao": uma a duas frases concretas sobre porque está nessa posição
  para este prato, apoiadas nos factos dados. Não cites notas nem preços
  que não estejam na lista, e não inventes castas nem características.
- "pesquisar": até ${MAX_PESQUISAR} índices de vinhos DESCONHECIDOS que, pelo tipo, região e
  preço, seriam bons candidatos para este prato${orcamento ? " e orçamento" : ""} — os que valeria a pena
  pesquisar. [] se não houver desconhecidos ou nenhum fizer sentido.
Responde só com o JSON.`;
};

/* Monta o cartão de uma sugestão a partir dos DADOS (ver o bloco acima).
   A forma é a mesma que as sugestões sempre tiveram, para a app e o
   histórico continuarem a desenhá-las com o mesmo código. */
function sugestaoDe(v: Record<string, unknown>, i: number, combinacao: string, recomendado: boolean): Record<string, unknown> {
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
    recomendado,
    origem: k.origem ?? null,
  };
}

const temNota = (v: Record<string, unknown>) =>
  Array.isArray((v.conhecido as any)?.pontuacao) && (v.conhecido as any).pontuacao.length > 0;

async function recomendar(
  vinhos: Record<string, unknown>[], prato: string, orcamento: number | null,
  modeloPesado: string, parentSignal: AbortSignal,
): Promise<{ sugestoes: Record<string, unknown>[]; pesquisar: number[]; usage: UsageMetadata | null; modelo: string; falhou: boolean; motivo: string }> {
  const out = { sugestoes: [] as Record<string, unknown>[], pesquisar: [] as number[], usage: null as UsageMetadata | null, modelo: "", falhou: false, motivo: "" };
  if (!vinhos.length) return out;

  const ctrl2 = new AbortController();
  const onAbort = () => ctrl2.abort();
  parentSignal.addEventListener("abort", onAbort);
  const subTimer = setTimeout(() => ctrl2.abort(), 40_000);
  const texto = promptRecomendacao(vinhos, prato, orcamento);

  /* Ordenar oito vinhos por harmonização E nota é raciocínio a sério, e o
     `thinkingBudget:0` do lite fazia-o mal (foi ele que pôs o vinho sem nota
     à frente). Vai o modelo que leu a carta, com um tecto POSITIVO de
     pensamento — nunca ilimitado, que é o caminho para o "200 vazio". O
     lite fica de rede. Num 400 (um modelo que recuse o `thinkingConfig`,
     como o lite recusou o 0 em produção a 24/09/2026) repete-se sem ele. */
  const tentar = async (m: string, pensar: number | null): Promise<any | null> => {
    const generationConfig: Record<string, unknown> = { temperature: 0, response_mime_type: "application/json" };
    if (pensar != null) generationConfig.thinkingConfig = { thinkingBudget: pensar };
    const r = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl2.signal,
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: texto }] }], generationConfig }),
    });
    if (r.status === 400 && pensar != null) return await tentar(m, null);
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
    const tentativas: [string, number | null][] = [[modeloPesado, 1024], [MODELO_LEVE, 0]];
    const vistos = new Set<string>();
    let j: any = null;
    for (const [m, pensar] of tentativas) {
      if (!m || vistos.has(m) || ctrl2.signal.aborted) continue;
      vistos.add(m);
      j = await tentar(m, pensar);
      if (j) break;
    }
    if (!j) { out.falhou = true; return out; }

    const conhecido = (i: number) => Number.isInteger(i) && i >= 0 && i < vinhos.length && !!vinhos[i].conhecido;
    const ranking: { i: number; razao: string }[] = [];
    const vistosI = new Set<number>();
    for (const x of Array.isArray(j.ranking) ? j.ranking : []) {
      const i = Number(x?.i);
      if (!conhecido(i) || vistosI.has(i)) continue;
      vistosI.add(i);
      ranking.push({ i, razao: String(x?.razao ?? "") });
      if (ranking.length >= MAX_RANKING) break;
    }
    const recs: number[] = [];
    for (const x of Array.isArray(j.recomendados) ? j.recomendados : []) {
      const i = Number(x);
      if (vistosI.has(i) && !recs.includes(i)) recs.push(i);
      if (recs.length >= 3) break;
    }
    if (!recs.length && ranking.length) recs.push(ranking[0].i);
    // A trave em código: dentro dos recomendados, os que têm nota vêm à
    // frente dos que não têm (ordem do modelo em tudo o resto).
    recs.sort((a, b) => Number(temNota(vinhos[b])) - Number(temNota(vinhos[a])));
    const ordem = [...recs, ...ranking.map((r) => r.i).filter((i) => !recs.includes(i))];
    out.sugestoes = ordem.map((i) =>
      sugestaoDe(vinhos[i], i, ranking.find((r) => r.i === i)?.razao ?? "", recs.includes(i))
    );

    const pesq = new Set<number>();
    for (const x of Array.isArray(j.pesquisar) ? j.pesquisar : []) {
      const i = Number(x);
      if (!Number.isInteger(i) || i < 0 || i >= vinhos.length || vinhos[i].conhecido || vinhos[i].naoEncontrado) continue;
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
  if (!u.ok) return { ok: false, email: null };
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
      body: JSON.stringify({ acao: "verificar_vinhos", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("VERIFICAR-VINHOS sync_log falhou:", r.status);
  } catch (e) {
    console.log("VERIFICAR-VINHOS sync_log erro:", String((e as Error).message).slice(0, 200));
  }
  await registarIaUso("verificar-vinhos", estado, detalhe, quem);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps que chamam o Gemini (ver o CLAUDE.md da
   WineCatalog, "O registo central de acessos ao Gemini"). Mesmo `detalhe`,
   com tokens/modelo/custo também em colunas. Nunca deita a resposta abaixo
   por isto falhar. */
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

/* Confirma que a análise existe, é do próprio (JWT pass-through — a RLS de
   `analises_sel` já só deixa ver a própria, admin incluído) e já está
   'concluido' (só faz sentido verificar vinhos de uma carta já lida). Traz
   o `resultado` porque é dele que saem os vinhos a pesquisar (pelo índice)
   e o que já se sabia dos outros — a recomendação refaz-se sobre a carta
   TODA, não só sobre os que se pesquisaram agora. */
async function buscarAnaliseDoDono(
  auth: string,
  id: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; resultado: any; prato: string; anterior: any }> {
  const r = await fetch(
    `${SB_URL}/rest/v1/analises?id=eq.${id}&select=id,estado,resultado,prato,verificacao`,
    {
      headers: { apikey: SB_SRV, Authorization: auth, "Accept-Profile": "wineselection" },
      signal,
    },
  );
  if (!r.ok) return { ok: false, resultado: null, prato: "", anterior: null };
  const rows = await r.json();
  const row = rows?.[0];
  const ok = !!row && row.estado === "concluido" && Array.isArray(row.resultado?.vinhosCarta);
  // A pesquisa anterior desta mesma carta: a nova SOMA-se a ela, nunca a
  // substitui (ver `processarVerificacao`). Uma antiga em forma de array
  // (antes da versão 2) não tem índices e fica de fora.
  const anterior = (ok && row.verificacao && !Array.isArray(row.verificacao) && Array.isArray(row.verificacao.vinhos))
    ? row.verificacao : null;
  return { ok, resultado: ok ? row.resultado : null, prato: String(row?.prato ?? ""), anterior };
}

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
    if (!r.ok) console.log("VERIFICAR-VINHOS atualizar registo falhou:", r.status);
  } catch (e) {
    console.log("VERIFICAR-VINHOS atualizar registo erro:", String((e as Error).message).slice(0, 200));
  }
}

/* A carta como a `sugerir-vinho` a deixou, pronta para a `recomendar`.
   Um resultado antigo (antes da versão 2) não tem `conhecido` nem
   `produtor` — os vinhos dele entram como desconhecidos, que é o que eram:
   a `pontuacaoAprox` que lá está é uma estimativa e NÃO passa a facto. */
function cartaDoResultado(resultado: any): Record<string, unknown>[] {
  return (Array.isArray(resultado?.vinhosCarta) ? resultado.vinhosCarta : []).map((v: any) => {
    const conhecido = (v?.conhecido && typeof v.conhecido === "object") ? v.conhecido : null;
    const preco = numOrNull(v?.preco, 0, 5000);
    return {
      nome: s(v?.nome, 100),
      produtor: v?.produtor ? s(v.produtor, 80) : null,
      ano: typeof v?.ano === "number" ? v.ano : anoDoNome(String(v?.nome ?? "")),
      tipo: TIPOS.includes(v?.tipo) ? v.tipo : null,
      regiao: v?.regiao ? s(v.regiao, 60) : null,
      preco,
      conhecido,
      precoAvaliacao: conhecido ? avaliarPreco(preco, numOrNull(conhecido.precoMercado, 0.5, 100000)) : null,
    };
  });
}

/* O trabalho a sério — chamado via EdgeRuntime.waitUntil. Nunca deixa a
   verificação presa em 'pendente'. Sem imagens, só texto + pesquisa; SEM
   fallback "sem-pesquisa" de propósito — sem pesquisa isto seria só mais
   uma estimativa de memória, exatamente o que o utilizador está a tentar
   fugir ao pedir uma verificação "a sério". Falha limpa em vez disso. */
async function processarVerificacao(
  indices: number[],
  resultado: any,
  anterior: any,
  prato: string,
  quem: string,
  analiseId: number,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
  let model = "gemini-flash-latest";
  let usageTotal: UsageMetadata | null = null;
  let chamadas = 0;

  try {
    const carta = cartaDoResultado(resultado);
    /* O QUE SE PESQUISOU ANTES NESTA CARTA CONTA. A primeira versão
       recomendava só com o que a leitura sabia mais o que acabava de chegar,
       e gravava por cima da pesquisa anterior: quatro vinhos pesquisados e
       pagos, e à segunda ronda era como se nunca tivessem existido
       (24/09/2026). Agora a carta leva o que as pesquisas anteriores
       encontraram, e a verificação que se grava é a SOMA das rondas. */
    const anteriores: any[] = Array.isArray(anterior?.vinhos) ? anterior.vinhos : [];
    for (const x of anteriores) {
      const v = carta[Number(x?.i)];
      if (!v) continue;
      if (x.conhecido && typeof x.conhecido === "object") {
        v.conhecido = x.conhecido;
        v.precoAvaliacao = avaliarPreco(v.preco as number | null, numOrNull(x.conhecido.precoMercado, 0.5, 100000));
      } else if (x.naoEncontrado && !v.conhecido) {
        v.naoEncontrado = true;
      }
    }
    const vinhos: VinhoPedido[] = indices.map((i) => {
      const v = carta[i] as any;
      return { i, nome: v.nome, produtor: v.produtor, ano: v.ano, tipo: v.tipo, regiao: v.regiao, preco: v.preco };
    });

    /* ── Primeiro o que já se sabe — da carta TODA ──
       Pergunta-se ao catálogo por todos os vinhos da carta que ainda estão
       sem dados, não só pelos escolhidos: alguém pode tê-los pesquisado
       entretanto (aqui, na Garrafeira, na WineCatalog), e a leitura pode
       não ter conseguido perguntar (`recomendacao:'catalogo-falhou'`). O
       que aparecer entra na recomendação e volta para a app em
       `vinhos` — um vinho já pago não fica de fora por nenhuma das duas
       razões. Dos escolhidos, os que estão COMPLETOS (nota + preço de
       mercado) respondem daqui; ao Gemini vão só os que sobram. */
    const semDados = carta.map((_, i) => i).filter((i) => !carta[i].conhecido);
    const cat = await catalogoProcurarLote(
      semDados.map((i) => ({ nome: String(carta[i].nome), produtor: (carta[i].produtor as string | null) ?? null, ano: carta[i].ano as number | null })),
      ctrl.signal,
    );
    const doCatalogo = new Set<number>();
    semDados.forEach((i, k) => {
      const c = conhecimentoDoCatalogo(cat.lista[k]);
      if (!c) return;
      carta[i].conhecido = c;
      carta[i].precoAvaliacao = avaliarPreco(carta[i].preco as number | null, c.precoMercado as number | null);
      carta[i].naoEncontrado = false;
      doCatalogo.add(i);
    });
    const novos: (Record<string, unknown> | null)[] = vinhos.map((v) => {
      const c = carta[v.i].conhecido as any;
      return (c && c.nota != null && c.precoMercado != null) ? c : null;
    });
    const paraIA = vinhos.filter((_, k) => !novos[k]);
    let fontesN: number | null = null;

    if (paraIA.length) {
      const parts = [{ text: promptVerificacao(paraIA) }];
      /* Aqui o `google_search` está SEMPRE ligado (é a razão de esta função
         existir), por isso não há variante "sem pensar": pedir
         thinkingBudget:0 com o tool de pesquisa dá 400. */
      const chamarGemini = (m: string) => fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0 },
          tools: [{ google_search: {} }],
        }),
      });

      const transitorio = (st: number) => st === 429 || st === 500 || st === 503;
      const candidatos = await candidatosModelo(ctrl.signal);
      if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
      console.log("VERIFICAR-VINHOS candidatos:", candidatos.join(", "));
      let g: Response | null = null;
      let gd: any = null;
      let texto2 = "";
      let vazioMotivo = "";

      for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
        model = candidatos[ci];
        g = await chamarGemini(model);
        console.log("VERIFICAR-VINHOS tentativa:", model, "->", g.status);
        /* Um 200 com o corpo VAZIO não é resposta. Lê-se o corpo AQUI para
           se poder passar ao modelo seguinte, e sobretudo para isto NÃO
           fechar como uma verificação concluída sem um único resultado.
           Ver o CLAUDE.md da WineCatalog, "O 200 vazio". */
        if (g.ok) {
          gd = await g.json();
          usageTotal = somarUsage(usageTotal, usageMetadata(gd));
          chamadas++;
          const cand = gd?.candidates?.[0];
          vazioMotivo = String(cand?.finishReason ?? "") || "resposta vazia";
          texto2 = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
          console.log("VERIFICAR-VINHOS resposta:", model, "finishReason:", vazioMotivo,
                      "texto:", texto2.length, "tokens saída:", gd?.usageMetadata?.candidatesTokenCount ?? 0);
          if (texto2) break;
          g = null;
          continue;
        }
        if (g.status === 404) { _models = null; continue; }
        if (!transitorio(g.status)) break;
      }

      if (g && !g.ok) {
        const status = g.status;
        const detail = await g.text();
        let msg = "";
        try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
        await registar("erro", { passo: "gemini", status, modelo: model, pesquisa: true, erro: (msg || detail).slice(0, 800), ms: Date.now() - t0 }, quem);
        const erroUtilizador = transitorio(status)
          ? "o serviço está com muita procura agora — tenta outra vez"
          : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`;
        await atualizarAnalise(analiseId, quem, { verificacao_estado: "erro", verificacao_erro: erroUtilizador });
        return;
      }

      /* Nenhum modelo escreveu uma letra. Isto NUNCA pode fechar como
         "concluido": esta função existe precisamente para não fingir que
         pesquisou. */
      if (!texto2) {
        await registar("erro", {
          passo: "gemini_vazio", modelo: model, pesquisa: true, finishReason: vazioMotivo || null,
          ...(usageTotal ? { usageMetadata: usageTotal } : {}), ms: Date.now() - t0,
        }, quem);
        await atualizarAnalise(analiseId, quem, {
          verificacao_estado: "erro",
          verificacao_erro: `o modelo não devolveu resposta (${vazioMotivo || "vazia"}) — tenta outra vez`,
        });
        return;
      }

      fontesN = (gd?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).length;
      const parsed: any = extrairJson(texto2);
      const brutos: any[] = Array.isArray(parsed?.resultados) ? parsed.resultados : [];
      // Pelo "n" que o modelo devolveu; pela ordem só se não o devolver.
      const porN = (k: number) => brutos.find((b) => Number(b?.n) === k + 1) ?? (brutos.every((b) => b?.n == null) ? brutos[k] : null);

      for (let k = 0; k < paraIA.length; k++) {
        const v = paraIA[k];
        const b = porN(k) ?? {};
        const pontuacao = normPontuacao(b.pontuacao);
        const viv = pontuacao.find((p) => /vivino/i.test(String(p.fonte)) && Number(p.escala) === 5);
        const precoMercado = precoMedioDeFaixa(b.faixaMercado);
        const castas = castasDaLista(b.castas);
        const conhecido: Record<string, unknown> = {
          nota: viv ? viv.valor : null,
          notaUrl: viv && typeof viv.url === "string" && /vivino\.com/i.test(viv.url as string) ? viv.url : null,
          notaAno: viv ? v.ano : null,
          pontuacao,
          precoMercado,
          castas,
          regiao: b.regiao ? s(b.regiao, 60) : v.regiao,
          tipo: TIPOS.includes(b.tipo) ? b.tipo : v.tipo,
          estilo: null,
          harmonizacao: b.harmonizacao ? s(b.harmonizacao, 240) : null,
          notasProva: null,
          produtor: v.produtor,
          origem: "pesquisa",
          origemEm: new Date().toISOString(),
        };
        const achou = pontuacao.length || precoMercado != null || castas.length || conhecido.harmonizacao;
        novos[vinhos.indexOf(v)] = achou ? conhecido : { naoEncontrado: true, origem: "pesquisa" };
      }
    }

    /* A carta com o que se sabe AGORA: o que já se sabia na leitura + o que
       acabou de chegar. É sobre esta que se recomenda outra vez. */
    const vinhosResultado = vinhos.map((v, k) => {
      const n = novos[k] as any;
      const conhecido = n && !n.naoEncontrado ? n : null;
      if (conhecido) {
        carta[v.i].conhecido = conhecido;
        carta[v.i].precoAvaliacao = avaliarPreco(v.preco, conhecido.precoMercado);
      }
      return {
        i: v.i, nome: v.nome,
        conhecido,
        precoAvaliacao: conhecido ? carta[v.i].precoAvaliacao : null,
        naoEncontrado: !conhecido,
      };
    });

    const rec = await recomendar(carta, prato, numOrNull(resultado?.orcamento, 1, 10000), model, ctrl.signal);
    usageTotal = somarUsage(usageTotal, rec.usage);
    if (rec.modelo) chamadas++;
    const temConhecidos = carta.some((v) => v.conhecido);
    const recomendacao = rec.falhou ? "falhou" : !temConhecidos ? "sem-conhecidos" : "ok";

    const verificacao = {
      // 2 = objeto (antes era só o array de resultados). A app lê as duas.
      versao: 2,
      // A soma das rondas: as anteriores que esta não voltou a pesquisar,
      // os que o catálogo acabou de reconhecer na carta, e os desta.
      vinhos: [
        ...anteriores.filter((x) => !vinhosResultado.some((n) => n.i === Number(x?.i)) && !doCatalogo.has(Number(x?.i))),
        ...[...doCatalogo].filter((i) => !vinhosResultado.some((n) => n.i === i)).map((i) => ({
          i, nome: carta[i].nome, conhecido: carta[i].conhecido,
          precoAvaliacao: carta[i].precoAvaliacao, naoEncontrado: false,
        })),
        ...vinhosResultado,
      ],
      sugestoes: rec.sugestoes,
      recomendacao,
      pesquisar: rec.pesquisar,
    };

    console.log("VERIFICAR-VINHOS ok:", vinhos.length, "modelo:", model, "catalogo:", vinhos.length - paraIA.length,
                "sugestoes:", rec.sugestoes.length);
    await registar("ok", {
      modelo: paraIA.length ? model : "catalogo", vinhos: vinhos.length,
      catalogo: vinhos.length - paraIA.length, gemini: paraIA.length,
      pesquisa: paraIA.length > 0,
      nao_encontrados: vinhosResultado.filter((v) => v.naoEncontrado).length,
      // Ver o CLAUDE.md da WineCatalog: uma pesquisa com ZERO fontes pode ter
      // sido respondida de memória. Conta-se aqui para se poder decidir com
      // números se se recusa a escrita sem grounding.
      ...(fontesN != null ? { fontes: fontesN } : {}),
      recomendacao,
      ...(rec.motivo ? { recomendacao_motivo: rec.motivo } : {}),
      ...(rec.modelo ? { modelo_leve: rec.modelo } : {}),
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      chamadas_gemini: chamadas,
      custo_estimado_eur: Number(
        ((paraIA.length ? CUSTO_VERIFICACAO_EUR : 0) + (rec.modelo ? CUSTO_RECOMENDACAO_EUR : 0)).toFixed(4),
      ),
      ms: Date.now() - t0,
    }, quem);
    await atualizarAnalise(analiseId, quem, { verificacao_estado: "concluido", verificacao });

    /* E o que se acabou de pesquisar vai para o catálogo — é uma pesquisa
       Google a sério, a mais forte que aqui se produz (ver
       `winecatalog.forca`), e é o que faz a próxima carta com este vinho —
       nesta app ou na Garrafeira — sair de graça. Depois de a verificação
       estar fechada: quem está à espera não espera por isto.
       Só o que é do VINHO: nunca o preço desta carta nem o "barato/caro". */
    for (const v of paraIA) {
      const k = novos[vinhos.indexOf(v)] as any;
      if (!k || k.naoEncontrado) continue;
      const ficha: Record<string, unknown> = {};
      if (k.nota != null) ficha.vivino_nota = k.nota;
      if (k.notaUrl) ficha.vivino_url = k.notaUrl;
      if (k.precoMercado != null) ficha.preco_medio = k.precoMercado;
      if (Array.isArray(k.castas) && k.castas.length) ficha.castas = k.castas;
      if (k.regiao) ficha.regiao = k.regiao;
      if (TIPOS_PARTILHADOS.includes(String(k.tipo))) ficha.tipo = k.tipo;
      if (k.harmonizacao) ficha.harmonizacao = k.harmonizacao;
      await catalogoJuntar(v.nome, v.produtor, v.ano, ficha, ctrl.signal);
    }
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500), ms: Date.now() - t0 }, quem);
    await atualizarAnalise(analiseId, quem, {
      verificacao_estado: "erro",
      verificacao_erro: timeout
        ? "demorou demasiado a pesquisar — tenta outra vez com menos vinhos"
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
    const auth = await emailAutorizado(authHeader, ctrl.signal);
    quem = auth.email;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "não autorizado" }, 403);
    }

    const { analiseId, indices, vinhos } = await req.json().catch(() => ({}) as any);
    const id = typeof analiseId === "number" ? analiseId : parseInt(String(analiseId), 10);
    if (!Number.isFinite(id)) {
      await registar("erro", { passo: "analiseId" }, quem);
      return json({ error: "análise inválida" }, 400);
    }

    const dona = await buscarAnaliseDoDono(authHeader, id, ctrl.signal);
    if (!dona.ok) {
      await registar("erro", { passo: "analise_nao_encontrada", analiseId: id }, quem);
      return json({ error: "análise não encontrada" }, 404);
    }

    /* Os vinhos vão pelo ÍNDICE na carta lida (`indices`). Uma app antiga
       ainda em cache manda `vinhos:[{nome}]` — casa-se pelo nome, para
       ninguém ficar com o botão partido entre dois deploys. */
    const carta: any[] = dona.resultado.vinhosCarta;
    let pedidos: number[] = [];
    if (Array.isArray(indices)) {
      pedidos = indices.map((x: unknown) => Number(x));
    } else if (Array.isArray(vinhos)) {
      pedidos = vinhos.map((v: any) => carta.findIndex((c) => c?.nome === v?.nome));
    }
    pedidos = [...new Set(pedidos.filter((i) => Number.isInteger(i) && i >= 0 && i < carta.length))];
    if (pedidos.length === 0 || pedidos.length > MAX_VINHOS) {
      await registar("erro", { passo: "vinhos", count: pedidos.length }, quem);
      return json({ error: `escolhe entre 1 e ${MAX_VINHOS} vinhos` }, 400);
    }

    // A `verificacao` anterior NÃO se apaga aqui: é a base da ronda nova, e
    // se esta falhar a anterior continua a ser o que se sabe.
    await atualizarAnalise(id, quem!, { verificacao_estado: "pendente", verificacao_erro: null });

    // NÃO faz await — mesma razão da sugerir-vinho.ts: a pesquisa Google
    // pode demorar, e isto sobrevive ao pedido original terminar.
    EdgeRuntime.waitUntil(processarVerificacao(pedidos, dona.resultado, dona.anterior, dona.prato, quem!, id));

    return json({ estado: "pendente" }, 202);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 500) }, quem);
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
