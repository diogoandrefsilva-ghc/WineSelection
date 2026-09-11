// supabase/functions/verificar-vinhos/index.ts
// WineSelection — Verificação "a sério" (pesquisa Google real) para até 5
// vinhos escolhidos à mão pelo utilizador na lista completa da carta
// (`resultado.vinhosCarta`, que na análise principal só tem
// `pontuacaoAprox` de memória, sem pesquisa — ver sugerir-vinho.ts).
// Pedir isto para os 20-40 vinhos todos foi o que causava os timeouts que
// levaram a separar `pontuacaoAprox` numa 2ª chamada leve nessa função;
// isto dá ao utilizador a opção de pagar o custo da pesquisa real só para
// os poucos vinhos que ele escolhe, não para a carta toda.
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
// Sem imagens, só texto + pesquisa — mais leve que a análise principal, mas
// a pesquisa Google continua a ser lenta/imprevisível, por isso o mesmo
// tipo de orçamento generoso.
const PROC_TIMEOUT_MS = 90_000;
const SYNC_TIMEOUT_MS = 10_000;
const MAX_VINHOS = 5;

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

const CLASSIFICACOES = ["barato", "justo", "caro", "muito_caro", "desconhecido"];

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
function normPrecoAvaliacao(raw: unknown): Record<string, unknown> {
  const o = (raw && typeof raw === "object") ? raw as any : {};
  const classificacao = CLASSIFICACOES.includes(o.classificacao) ? o.classificacao : "desconhecido";
  return {
    classificacao,
    faixaMercado: o.faixaMercado ? s(o.faixaMercado, 40) : null,
    comentario: s(o.comentario, 320),
  };
}
function normResultadoVerif(raw: unknown, nomeEsperado: string): Record<string, unknown> {
  const o = (raw && typeof raw === "object") ? raw as any : {};
  return {
    nome: nomeEsperado,
    pontuacao: normPontuacao(o.pontuacao),
    precoAvaliacao: normPrecoAvaliacao(o.precoAvaliacao),
  };
}

/* ── O QUE ISTO GASTOU ──
   Duplicado da `sugerir-vinho.ts` de propósito — cada Edge Function deste
   projeto é auto-contida (mesma convenção da calendario-sporting). A
   Garrafeira já contava tokens e esta app não contava nada; sem isto não
   há como ver quanto é que o catálogo partilhado está a poupar aqui, que é
   onde a poupança é maior (esta é a chamada mais cara das três). */
type UsageMetadata = { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };

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
    totalTokenCount: toInt(src.totalTokenCount),
  };
  return (out.promptTokenCount || out.candidatesTokenCount || out.totalTokenCount) ? out : null;
}

/* Estimativa GROSSEIRA, como na irmã: os tokens são facto, o euro é um
   número redondo para dar ordem de grandeza. A pesquisa Google é faturada
   à parte, por pedido — calibra pela fatura real se isto passar de
   curiosidade a orçamento. Zero quando a resposta veio do catálogo: aí não
   se falou com o Gemini de todo, e é esse o número que interessa ver. */
const CUSTO_VERIFICACAO_EUR = 0.01;

/* ── CATÁLOGO PARTILHADO (schema `winecatalog`) ──
   Esta função é a mais cara das três (pesquisa Google a sério, pedida à
   mão) e por isso é a que mais ganha em não repetir trabalho: se alguém já
   verificou este vinho — aqui ou na Garrafeira — a resposta já existe.

   O QUE VEM DO CATÁLOGO E O QUE NÃO PODE VIR. A pontuação é do VINHO e
   viaja bem. A classificação do preço ("barato/justo/caro") NÃO é do
   vinho: é um juízo sobre A CARTA que está à frente, e o mesmo Papa Figos
   é barato a 22 € e caro a 45 €. Por isso o catálogo guarda o preço de
   MERCADO e a comparação com esta carta refaz-se sempre, aqui em código
   (`avaliarPreco`) — o que é, aliás, mais honesto do que a opinião do
   modelo: é uma conta que se mostra e que qualquer pessoa refaz à mesa.

   A trave: só se responde do catálogo quando lá estão AS DUAS COISAS (a
   nota pesquisada e o preço de mercado). Meia resposta seria pior do que
   pesquisar — quem escolheu estes cinco vinhos à mão escolheu-os porque
   quer saber, e "não sei o preço" não é o que veio buscar. */
const CATALOGO_IDADE_DIAS = 30;

type Conhecido = {
  nome: string; ano: number | null; ficha: Record<string, unknown>;
  fontes: { titulo: string; url: string }[]; atualizadoEm: string;
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

async function catalogoProcurarLote(
  pedidos: { nome: string; ano: number | null }[], signal?: AbortSignal,
): Promise<(Conhecido | null)[]> {
  if (!pedidos.length) return [];
  try {
    const d = await catalogoRpc("procurar_lote", {
      p_pedidos: pedidos.map((p) => ({ nome: p.nome, produtor: "", ano: p.ano })),
      p_idade_dias: CATALOGO_IDADE_DIAS,
    }, signal);
    if (!Array.isArray(d)) return pedidos.map(() => null);
    return pedidos.map((_, i) => {
      const x = d[i];
      if (!x || typeof x !== "object" || !x.ficha) return null;
      return {
        nome: String(x.nome || ""),
        ano: typeof x.ano === "number" ? x.ano : null,
        ficha: (x.ficha && typeof x.ficha === "object") ? x.ficha : {},
        fontes: Array.isArray(x.fontes) ? x.fontes.slice(0, 8) : [],
        atualizadoEm: String(x.atualizadoEm || ""),
      };
    });
  } catch (_) { return pedidos.map(() => null); }
}

async function catalogoJuntar(
  nome: string, ano: number | null, ficha: Record<string, unknown>, signal?: AbortSignal,
) {
  try {
    if (!nome || !Object.keys(ficha).length) return;
    await catalogoRpc("juntar", {
      p_nome: nome, p_produtor: "", p_ano: ano,
      p_ficha: ficha, p_origem: "ws-verificacao", p_fontes: [],
    }, signal);
  } catch (_) { /* o catálogo nunca falha uma verificação */ }
}

function anoDoNome(nome: string): number | null {
  const m = String(nome || "").match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
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

/* A conta que substitui a opinião do modelo quando o preço de mercado já é
   conhecido. Os cortes não são ciência — são o que se diz em qualquer
   restaurante sobre a margem da garrafa: 2 a 3 vezes o preço de loja é o
   normal, abaixo disso é um achado, muito acima é abuso. Ficam escritos
   aqui e ficam escritos no COMENTÁRIO que vai para o ecrã: quem está à
   mesa vê a conta e discorda dela se quiser, que é mais do que alguma vez
   pôde fazer com um "caro" dito pelo modelo. */
function avaliarPreco(precoCarta: number | null, precoMercado: number): Record<string, unknown> {
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

/* A resposta que o catálogo consegue dar a um vinho, ou null se não
   conseguir dar a resposta INTEIRA (ver a trave, no topo deste bloco). */
function verificacaoDoCatalogo(
  c: Conhecido | null, nome: string, precoCarta: number | null,
): Record<string, unknown> | null {
  if (!c) return null;
  const nota = numOrNull((c.ficha as any).vivino_nota, 0, 5);
  const mercado = numOrNull((c.ficha as any).preco_medio, 0.5, 100000);
  if (nota == null || mercado == null) return null;
  const url = (c.ficha as any).vivino_url;
  return {
    nome,
    pontuacao: [{
      fonte: "Vivino", valor: nota, escala: 5,
      url: (typeof url === "string" && /^https?:\/\//i.test(url)) ? url.slice(0, 300) : null,
    }],
    precoAvaliacao: avaliarPreco(precoCarta, mercado),
    // A app diz isto a quem pediu: uma verificação instantânea merece
    // explicar-se, senão parece que ninguém foi pesquisar nada.
    origem: "catalogo",
    origemEm: c.atualizadoEm,
    origemAno: c.ano,
  };
}

type VinhoPedido = { nome: string; regiao: string | null; preco: number | null };

const promptVerificacao = (vinhos: VinhoPedido[]) => {
  const lista = vinhos.map((v, i) =>
    `${i + 1}. ${v.nome}${v.regiao ? ` (${v.regiao})` : ""}${v.preco != null ? ` — preço na carta: ${v.preco}€` : ""}`
  ).join("\n");
  return `Estes são vinhos específicos, escolhidos à mão por um utilizador de
uma carta de restaurante em Portugal. Para CADA UM, usa PESQUISA GOOGLE para
confirmar a pontuação em sites de referência (sobretudo Vivino, mas
Wine-Searcher e outros também servem) e uma noção do preço de RETALHO em
Portugal, para avaliar se o preço da carta é justo — tendo em conta que é
NORMAL um restaurante cobrar 2 a 3 vezes o preço de retalho; não
classifiques como "caro" só por ser mais caro que a loja.

${lista}

Devolve APENAS um objeto JSON com esta forma exata:
{"resultados": [{"pontuacao": [{"fonte": string, "valor": number, "escala": number, "url": string|null}],
  "precoAvaliacao": {"classificacao": "barato"|"justo"|"caro"|"muito_caro"|"desconhecido",
    "faixaMercado": string|null, "comentario": string}}]}

Regras:
- Um objeto por vinho pedido, pela MESMA ordem da lista acima (${vinhos.length} no total).
- "pontuacao": só inclui fontes que tenhas mesmo confirmado pela pesquisa —
  nunca adivinhes uma nota. Sem confirmação fiável, "pontuacao" fica [].
- "precoAvaliacao.faixaMercado": referência de preço de RETALHO em euros
  (ex.: "6-9€"), não o preço do restaurante. Usa "desconhecido" se não
  encontrares preço de retalho fiável.
- Nunca inventes.
Responde só com o JSON, sem texto à volta e sem blocos de código.`;
};

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
}

/* Confirma que a análise existe, é do próprio (JWT pass-through — a RLS de
   `analises_sel` já só deixa ver a própria, admin incluído) e já está
   'concluido' (só faz sentido verificar vinhos de uma carta já lida). */
async function buscarAnaliseDoDono(
  auth: string,
  id: number,
  signal: AbortSignal,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `${SB_URL}/rest/v1/analises?id=eq.${id}&select=id,estado`,
    {
      headers: { apikey: SB_SRV, Authorization: auth, "Accept-Profile": "wineselection" },
      signal,
    },
  );
  if (!r.ok) return { ok: false };
  const rows = await r.json();
  const row = rows?.[0];
  return { ok: !!row && row.estado === "concluido" };
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

/* O trabalho a sério — chamado via EdgeRuntime.waitUntil. Nunca deixa a
   verificação presa em 'pendente'. Sem imagens, só texto + pesquisa; SEM
   fallback "sem-pesquisa" de propósito — sem pesquisa isto seria só mais
   uma estimativa de memória, exatamente o que o utilizador está a tentar
   fugir ao pedir uma verificação "a sério". Falha limpa em vez disso. */
async function processarVerificacao(
  vinhos: VinhoPedido[],
  quem: string,
  analiseId: number,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  let model = "gemini-flash-latest";

  try {
    /* ── Primeiro o que já se sabe ──
       Cada um destes vinhos é uma pesquisa Google paga. Os que já estão no
       catálogo partilhado com a ficha COMPLETA (nota pesquisada + preço de
       mercado) respondem já; ao Gemini vão só os que sobram. Quando não
       sobra nenhum, esta função não chega a falar com o Gemini — e continua
       a ser verificação a sério, porque o que está no catálogo foi lá posto
       por uma pesquisa a sério (a `winecatalog.forca` não deixa entrar
       estimativas de memória). */
    const conhecidos = await catalogoProcurarLote(
      vinhos.map((v) => ({ nome: v.nome, ano: anoDoNome(v.nome) })),
      ctrl.signal,
    );
    const doCatalogo: (Record<string, unknown> | null)[] = vinhos.map((v, i) =>
      verificacaoDoCatalogo(conhecidos[i], v.nome, v.preco)
    );
    const paraIA = vinhos.filter((_, i) => !doCatalogo[i]);

    if (!paraIA.length) {
      const verificacao = doCatalogo as Record<string, unknown>[];
      await registar("ok", {
        modelo: "catalogo", vinhos: vinhos.length, catalogo: vinhos.length,
        gemini: 0, chamadas_gemini: 0, custo_estimado_eur: 0,
      }, quem);
      await atualizarAnalise(analiseId, quem, { verificacao_estado: "concluido", verificacao });
      return;
    }

    const texto = promptVerificacao(paraIA);
    const parts = [{ text: texto }];

    /* Aqui o `google_search` está SEMPRE ligado (é a razão de esta função
       existir — ver o cabeçalho), por isso a variante "sem-pensar" era um
       400 garantido: pedir thinkingBudget:0 com o tool de pesquisa passou
       a ser recusado ("Request contains an invalid argument"). Gastava-se
       uma ida ao Gemini a cada verificação para depois cair nesta, que é a
       única que a API aceita. Sobra uma só, e é a certa. */
    type Variante = { semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { semThinking: false, label: "pesquisa" },
    ];
    const chamarGemini = (m: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = { temperature: 0 };
      // Nunca com pesquisa ligada — e aqui ela está sempre. A trave fica
      // para o caso de um dia alguém acrescentar uma variante sem tool.
      if (v.semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig,
          tools: [{ google_search: {} }],
        }),
      });
    };

    const transitorio = (st: number) => st === 429 || st === 500 || st === 503;
    const candidatos = await candidatosModelo(ctrl.signal);
    if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
    console.log("VERIFICAR-VINHOS candidatos:", candidatos.join(", "));
    let g: Response | null = null;

    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];
      for (let vi = 0; vi < variantes.length && !ctrl.signal.aborted; vi++) {
        const v = variantes[vi];
        g = await chamarGemini(model, v);
        console.log("VERIFICAR-VINHOS tentativa:", model, v.label, "->", g.status);
        if (g.status === 400) continue;
        break;
      }
      if (g && g.ok) break;
      if (g && g.status === 404) { _models = null; continue; }
      if (g && !transitorio(g.status)) break;
    }

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      await registar("erro", { passo: "gemini", status, modelo: model, erro: (msg || detail).slice(0, 800) }, quem);
      const erroUtilizador = transitorio(status)
        ? "o serviço está com muita procura agora — tenta outra vez"
        : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`;
      await atualizarAnalise(analiseId, quem, { verificacao_estado: "erro", verificacao_erro: erroUtilizador });
      return;
    }

    const gd = await g.json();
    const usage = usageMetadata(gd);
    const texto2 = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    const parsed: any = extrairJson(texto2);
    const brutos = Array.isArray(parsed?.resultados) ? parsed.resultados : [];
    const daIA = paraIA.map((v, i) => normResultadoVerif(brutos[i], v.nome));

    // Volta a juntar os dois lados pela ORDEM ORIGINAL: quem escolheu cinco
    // vinhos na lista espera-os de volta na ordem em que os escolheu, e não
    // primeiro os que por acaso já se sabiam.
    let ia = 0;
    const verificacao = vinhos.map((_, i) => doCatalogo[i] ?? daIA[ia++]);

    console.log("VERIFICAR-VINHOS ok:", verificacao.length, "modelo:", model,
                "catalogo:", vinhos.length - paraIA.length);
    await registar("ok", {
      modelo: model, vinhos: vinhos.length,
      catalogo: vinhos.length - paraIA.length, gemini: paraIA.length,
      ...(usage ? { usageMetadata: usage } : {}),
      chamadas_gemini: 1,
      custo_estimado_eur: CUSTO_VERIFICACAO_EUR,
    }, quem);
    await atualizarAnalise(analiseId, quem, { verificacao_estado: "concluido", verificacao });

    /* E o que se acabou de pesquisar vai para o catálogo — é uma pesquisa
       Google a sério, a mais forte que aqui se produz (ver `winecatalog.forca`),
       e é o que faz a Garrafeira não voltar a pagar por este mesmo vinho.
       Depois de a verificação estar fechada: quem está à espera não espera
       por isto. */
    for (let i = 0; i < paraIA.length; i++) {
      const r = daIA[i] as any;
      const nota = numOrNull(r?.pontuacao?.[0]?.valor, 0, 5);
      const escala = Number(r?.pontuacao?.[0]?.escala);
      const ficha: Record<string, unknown> = {};
      // Só a do Vivino e só na escala de 5 — uma nota de 92/100 não é a
      // mesma coisa e não se converte dividindo por 20.
      if (nota != null && escala === 5 && /vivino/i.test(String(r?.pontuacao?.[0]?.fonte || ""))) {
        ficha.vivino_nota = nota;
        const u = r?.pontuacao?.[0]?.url;
        if (typeof u === "string" && /vivino\.com/i.test(u)) ficha.vivino_url = u.slice(0, 300);
      }
      const pm = precoMedioDeFaixa(r?.precoAvaliacao?.faixaMercado);
      if (pm != null) ficha.preco_medio = pm;
      if (paraIA[i].regiao) ficha.regiao = s(paraIA[i].regiao, 60);
      await catalogoJuntar(paraIA[i].nome, anoDoNome(paraIA[i].nome), ficha, ctrl.signal);
    }
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
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

    const { analiseId, vinhos } = await req.json().catch(() => ({}) as any);
    const id = typeof analiseId === "number" ? analiseId : parseInt(String(analiseId), 10);
    if (!Number.isFinite(id)) {
      await registar("erro", { passo: "analiseId" }, quem);
      return json({ error: "análise inválida" }, 400);
    }
    if (!Array.isArray(vinhos) || vinhos.length === 0 || vinhos.length > MAX_VINHOS) {
      await registar("erro", { passo: "vinhos", count: Array.isArray(vinhos) ? vinhos.length : null }, quem);
      return json({ error: `escolhe entre 1 e ${MAX_VINHOS} vinhos` }, 400);
    }
    const limpos: VinhoPedido[] = vinhos.slice(0, MAX_VINHOS)
      .map((v: any) => ({
        nome: s(v?.nome, 100),
        regiao: v?.regiao ? s(v.regiao, 60) : null,
        preco: numOrNull(v?.preco, 0, 5000),
      }))
      .filter((v: VinhoPedido) => v.nome);
    if (!limpos.length) {
      await registar("erro", { passo: "vinhos_vazios" }, quem);
      return json({ error: "vinhos inválidos" }, 400);
    }

    const dona = await buscarAnaliseDoDono(authHeader, id, ctrl.signal);
    if (!dona.ok) {
      await registar("erro", { passo: "analise_nao_encontrada", analiseId: id }, quem);
      return json({ error: "análise não encontrada" }, 404);
    }

    await atualizarAnalise(id, quem!, { verificacao_estado: "pendente", verificacao: null, verificacao_erro: null });

    // NÃO faz await — mesma razão da sugerir-vinho.ts: a pesquisa Google
    // pode demorar, e isto sobrevive ao pedido original terminar.
    EdgeRuntime.waitUntil(processarVerificacao(limpos, quem!, id));

    return json({ estado: "pendente" }, 202);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 500) }, quem);
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
