// supabase/functions/sugerir-vinho/index.ts
// WineSelection — Lê a(s) fotografia(s) da carta de vinhos com o Gemini (até
// 6 — o menu nem sempre cabe numa só foto), cruza com pesquisa Google (Vivino
// e afins, para pontuação e preço de mercado) e devolve uma sugestão de vinho
// para o prato indicado, com prioridade para vinhos portugueses.
//
// É prima da `calendario-sporting` (Goals) e da `fatura-restaurante`
// (SplitBill) — mesmo projeto Supabase, mesma descoberta de modelo/fallback —
// e junta as duas técnicas: imagem inline (como a fatura) + grounding com
// pesquisa Google (como o calendário), porque aqui precisamos das DUAS coisas
// ao mesmo tempo — ler a carta E saber a pontuação/preço actuais. Com o tool
// de pesquisa ligado a API recusa response_mime_type=json, por isso o JSON
// vem em texto e é extraído aqui (extrairJson).
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

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Abaixo dos ~60s a que o Safari/iOS mata o pedido. Mais folgado que uma
// leitura simples porque aqui há pesquisa Google pelo meio de uma ou mais
// imagens — mas o essencial da margem vem de desligar o "thinking" (ver
// chamarGemini), não deste número.
const TIMEOUT_MS = 58_000;

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

const TIPOS = ["Tinto", "Branco", "Rosé", "Verde", "Espumante", "Doce", "Outro"];
const CLASSIFICACOES = ["barato", "justo", "caro", "muito_caro", "desconhecido"];

const prompt = (prato: string, nImagens: number) => `${nImagens > 1
  ? `Aqui estão ${nImagens} fotografias que, juntas, mostram a carta de vinhos de um restaurante em Portugal (o menu não coube numa só foto — trata-as como páginas da MESMA carta).`
  : "Aqui está a fotografia de uma carta de vinhos de um restaurante em Portugal."}
Lê todos os vinhos legíveis em todas as fotos, com preço quando estiver
impresso. Se o mesmo vinho aparecer em mais que uma foto, conta-o uma única
vez.

${prato ? `O prato a acompanhar é: "${prato}".` : "Não foi indicado nenhum prato específico — sugere vinhos versáteis e bem avaliados da carta."}

Usa PESQUISA GOOGLE para confirmar, para os vinhos que consideres candidatos
fortes, a pontuação em sites de referência (sobretudo Vivino, mas outros como
Wine-Searcher também servem) e uma noção do preço de RETALHO em Portugal
(loja/venda direta do produtor), para avaliar se o preço da carta é justo —
tendo em conta que é NORMAL um restaurante cobrar 2 a 3 vezes o preço de
retalho; não classifiques como "caro" só por ser mais caro que a loja.

Dá prioridade a vinhos PORTUGUESES sempre que exista uma opção portuguesa
razoável na carta que combine bem com o prato — só recomendes um vinho
estrangeiro se for claramente a melhor opção disponível.

Devolve APENAS um objeto JSON com esta forma exata:
{"sugestoes": [{"nome": string, "tipo": "Tinto"|"Branco"|"Rosé"|"Verde"|"Espumante"|"Doce"|"Outro",
  "regiao": string|null, "casta": string|null, "precoCarta": number|null,
  "pontuacao": [{"fonte": string, "valor": number, "escala": number, "url": string|null}],
  "precoAvaliacao": {"classificacao": "barato"|"justo"|"caro"|"muito_caro"|"desconhecido",
    "faixaMercado": string|null, "comentario": string},
  "combinacao": string}],
 "vinhosCarta": [{"nome": string, "tipo": string|null, "regiao": string|null, "preco": number|null}],
 "aviso": string|null}

Regras:
- "sugestoes": entre 1 e 3 vinhos, ordenados do melhor para o pior, SÓ vinhos
  que estejam mesmo legíveis nesta carta — nunca inventes um vinho que não vês
  na foto.
- "pontuacao": só inclui fontes que tenhas mesmo confirmado pela pesquisa —
  nunca adivinhes uma nota. Sem confirmação fiável, "pontuacao" fica [].
- "precoAvaliacao.faixaMercado": referência de preço de RETALHO em euros
  (ex.: "6-9€"), não o preço do restaurante.
- "combinacao": frase curta e concreta de porque combina com o prato indicado
  (corpo, acidez, taninos, sabores) — sem prato indicado, explica porque é
  uma boa escolha geral.
- "vinhosCarta": TODOS os vinhos que consigas ler na carta (até 40), mesmo os
  que não estão nas sugestões — nome e preço; usa null no que não leres.
- "aviso": preenche só se a foto estiver ilegível, sem vinhos, ou sem preços
  visíveis — caso contrário null.
- Nunca inventes preços nem pontuações — usa null / [] na dúvida.
Responde só com o JSON, sem texto à volta e sem blocos de código.`;

/* Com o tool de pesquisa ligado a API recusa response_mime_type=json, por isso
   a resposta vem em texto: pode trazer blocos ``` e frases à volta. Aqui
   apanha-se o primeiro objeto JSON equilibrado do texto (igual à calendario-sporting). */
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
function normSugestao(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  return {
    nome,
    tipo: TIPOS.includes(o.tipo) ? o.tipo : "Outro",
    regiao: o.regiao ? s(o.regiao, 60) : null,
    casta: o.casta ? s(o.casta, 60) : null,
    precoCarta: numOrNull(o.precoCarta, 0, 5000),
    pontuacao: normPontuacao(o.pontuacao),
    precoAvaliacao: normPrecoAvaliacao(o.precoAvaliacao),
    combinacao: s(o.combinacao, 400),
  };
}
function normVinhoCarta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  return {
    nome,
    tipo: o.tipo ? s(o.tipo, 30) : null,
    regiao: o.regiao ? s(o.regiao, 60) : null,
    preco: numOrNull(o.preco, 0, 5000),
  };
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
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let quem: string | null = null;

  try {
    console.log("SUGERIR-VINHO start");
    const auth = await emailAutorizado(req.headers.get("Authorization") ?? "", ctrl.signal);
    quem = auth.email;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "não autorizado" }, 403);
    }

    const { imagens, prato } = await req.json().catch(() => ({}) as any);
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
    const texto = prompt(pratoLimpo, imagens.length);
    const parts: unknown[] = [...partsImg, { text: texto }];

    /* Cada variante é uma forma de pedir a mesma coisa. Ordem por velocidade
       esperada, não por qualidade — com imagens (1 a 6) + grounding, o
       "thinking" por omissão dos modelos 2.5 é o maior custo de latência
       (mais do que a pesquisa em si), por isso a 1ª tentativa já vem sempre
       com thinkingBudget:0. Sem isto, um pedido com 2+ fotos passa
       facilmente dos 55s e nunca chega a responder (visto nos logs: o fetch
       ao Gemini ficava pendurado até o AbortController disparar, sem sequer
       imprimir a linha "tentativa"). */
    type Variante = { search: boolean; semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { search: true, semThinking: true, label: "pesquisa+sem-pensar" },
      { search: true, semThinking: false, label: "pesquisa" },
      { search: false, semThinking: false, label: "sem-pesquisa" },
    ];
    const chamarGemini = (model: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = v.search
        ? { temperature: 0 }
        : { temperature: 0, response_mime_type: "application/json" };
      if (v.semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const corpo: Record<string, unknown> = { contents: [{ role: "user", parts }], generationConfig };
      if (v.search) corpo.tools = [{ google_search: {} }];
      return fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify(corpo),
      });
    };

    const transitorio = (st: number) => st === 429 || st === 500 || st === 503;

    const candidatos = await candidatosModelo(ctrl.signal);
    if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
    console.log("SUGERIR-VINHO candidatos:", candidatos.join(", "));
    let model = candidatos[0] ?? "gemini-flash-latest";
    let comPesquisa = true;
    let g: Response | null = null;

    // Sem espera com backoff entre tentativas aqui de propósito — o
    // orçamento de tempo é apertado (Safari/iOS mata o pedido perto dos
    // 60s), por isso um 429/500/503 salta logo para o modelo seguinte da
    // lista em vez de esperar e repetir o mesmo.
    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];
      for (let vi = 0; vi < variantes.length && !ctrl.signal.aborted; vi++) {
        const v = variantes[vi];
        comPesquisa = v.search;
        g = await chamarGemini(model, v);
        console.log("SUGERIR-VINHO tentativa:", model, v.label, "->", g.status);
        if (g.status === 400) continue; // esta variante não é aceite por este modelo — tenta a seguinte
        break; // sucesso, ou erro definitivo — não continua a testar variantes deste modelo
      }
      if (g && g.ok) break;
      if (g && g.status === 404) { _models = null; continue; } // saiu do catálogo — tenta o modelo seguinte
      if (g && !transitorio(g.status)) break; // erro definitivo (ex: 400 em todas as variantes) — não vale a pena continuar
      // transitório (429/500/503): tenta já o modelo seguinte, sem esperar
    }

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      console.error("gemini", model, status, detail.slice(0, 500));
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      await registar("erro", {
        passo: "gemini", status, modelo: model, pesquisa: comPesquisa,
        erro: (msg || detail).slice(0, 800),
      }, quem);
      if (transitorio(status)) {
        return json({
          error: "o serviço está com muita procura agora — espera um minuto e tenta outra vez",
        }, 503);
      }
      return json({ error: `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}` }, 502);
    }

    const gd = await g.json();
    const cand = gd?.candidates?.[0];
    const texto2 = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    const parsed: any = extrairJson(texto2);
    if (!parsed) {
      console.error("SUGERIR-VINHO resposta ilegível:", texto2.slice(0, 400));
      await registar("erro", { passo: "json", modelo: model, pesquisa: comPesquisa, amostra: texto2.slice(0, 800) }, quem);
      return json({ error: "resposta ilegível do modelo — tenta uma foto mais nítida" }, 502);
    }

    const sugestoes = (Array.isArray(parsed.sugestoes) ? parsed.sugestoes : [])
      .map(normSugestao).filter(Boolean).slice(0, 5);
    const vinhosCarta = (Array.isArray(parsed.vinhosCarta) ? parsed.vinhosCarta : [])
      .map(normVinhoCarta).filter(Boolean).slice(0, 60);
    const aviso = parsed.aviso ? s(parsed.aviso, 200) : null;

    const fontes: { titulo: string; url: string }[] = [];
    (cand?.groundingMetadata?.groundingChunks ?? []).forEach((c: any) => {
      const w = c?.web;
      if (w?.uri && !fontes.some((f) => f.url === w.uri)) {
        fontes.push({ titulo: String(w.title ?? w.uri).slice(0, 80), url: String(w.uri) });
      }
    });

    console.log("SUGERIR-VINHO sugestoes:", sugestoes.length, "vinhosCarta:", vinhosCarta.length, "pesquisa:", comPesquisa);
    await registar("ok", {
      sugestoes: sugestoes.length, vinhos_carta: vinhosCarta.length, modelo: model,
      pesquisa: comPesquisa, prato: pratoLimpo, fotos: imagens.length,
      fontes: fontes.map((f) => f.url).slice(0, 8),
    }, quem);

    return json({
      prato: pratoLimpo,
      sugestoes,
      vinhosCarta,
      aviso,
      fontes: fontes.slice(0, 8),
      pesquisa: comPesquisa,
      modelo: model,
      geradoEm: new Date().toISOString(),
    });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
    if (timeout) {
      return json({
        error: "o modelo demorou demasiado a analisar a carta — tenta outra vez, ou uma foto mais nítida",
      }, 504);
    }
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
