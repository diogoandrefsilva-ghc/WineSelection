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
const ESTAVEIS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
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
    const texto = promptVerificacao(vinhos);
    const parts = [{ text: texto }];

    type Variante = { semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { semThinking: true, label: "sem-pensar" },
      { semThinking: false, label: "normal" },
    ];
    const chamarGemini = (m: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = { temperature: 0 };
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
    const texto2 = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    const parsed: any = extrairJson(texto2);
    const brutos = Array.isArray(parsed?.resultados) ? parsed.resultados : [];
    const verificacao = vinhos.map((v, i) => normResultadoVerif(brutos[i], v.nome));

    console.log("VERIFICAR-VINHOS ok:", verificacao.length, "modelo:", model);
    await registar("ok", { modelo: model, vinhos: vinhos.length }, quem);
    await atualizarAnalise(analiseId, quem, { verificacao_estado: "concluido", verificacao });
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
