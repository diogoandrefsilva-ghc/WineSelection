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
// ── TRABALHO ASSÍNCRONO (EdgeRuntime.waitUntil) ──
// A análise em si (imagens + pesquisa Google) pode legitimamente passar de um
// minuto — visto nos logs, é o próprio Gemini que demora, não um bug nosso.
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

const prompt = (prato: string, nImagens: number, orcamento: number | null) => `${nImagens > 1
  ? `Aqui estão ${nImagens} fotografias que, juntas, mostram a carta de vinhos de um restaurante em Portugal (o menu não coube numa só foto — trata-as como páginas da MESMA carta).`
  : "Aqui está a fotografia de uma carta de vinhos de um restaurante em Portugal."}
Lê todos os vinhos legíveis em todas as fotos, com preço quando estiver
impresso. Se o mesmo vinho aparecer em mais que uma foto, conta-o uma única
vez.

${prato ? `O prato a acompanhar é: "${prato}".` : "Não foi indicado nenhum prato específico — sugere vinhos versáteis e bem avaliados da carta."}
${orcamento ? `O orçamento máximo é ${orcamento}€ por garrafa — as entradas em "sugestoes" têm de ter "precoCarta" dentro desse valor. Só saias desse limite se NENHUM vinho da carta o cumprir; nesse caso escolhe a opção mais próxima e explica isso claramente em "combinacao".` : ""}

Usa PESQUISA GOOGLE para confirmar, para os vinhos que consideres candidatos
fortes (as tuas "sugestoes"), a pontuação em sites de referência (sobretudo
Vivino, mas outros como Wine-Searcher também servem) e uma noção do preço de
RETALHO em Portugal (loja/venda direta do produtor), para avaliar se o preço
da carta é justo — tendo em conta que é NORMAL um restaurante cobrar 2 a 3
vezes o preço de retalho; não classifiques como "caro" só por ser mais caro
que a loja.

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
 "vinhosCarta": [{"nome": string, "tipo": "Tinto"|"Branco"|"Rosé"|"Verde"|"Espumante"|"Doce"|"Outro"|null,
  "regiao": string|null, "preco": number|null}],
 "aviso": string|null}

Regras:
- "sugestoes": entre 1 e 3 vinhos, ordenados do melhor para o pior, SÓ vinhos
  que estejam mesmo legíveis nesta carta — nunca inventes um vinho que não vês
  na foto.
- "pontuacao" (dentro de "sugestoes"): só inclui fontes que tenhas mesmo
  confirmado pela pesquisa — nunca adivinhes uma nota. Sem confirmação
  fiável, "pontuacao" fica [].
- "precoAvaliacao.faixaMercado": referência de preço de RETALHO em euros
  (ex.: "6-9€"), não o preço do restaurante.
- "combinacao": frase curta e concreta de porque combina com o prato indicado
  (corpo, acidez, taninos, sabores) — sem prato indicado, explica porque é
  uma boa escolha geral.
- "vinhosCarta": TODOS os vinhos que consigas ler na carta (até 40), mesmo os
  que não estão nas sugestões — nome e preço; usa null no que não leres.
- "vinhosCarta[].tipo": mesmo conjunto de valores que "sugestoes[].tipo"
  (Tinto/Branco/Rosé/Verde/Espumante/Doce/Outro) — é o que permite distinguir
  brancos de tintos na lista; usa null só se a carta não deixar perceber nem
  isso.
- "aviso": preenche só se a foto estiver ilegível, sem vinhos, ou sem preços
  visíveis — caso contrário null.
- Nunca inventes preços — usa null na dúvida.
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
    coerencia: null as Record<string, unknown> | null, // preenchido por verificarCoerencia()
  };
}
function normVinhoCarta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  return {
    nome,
    tipo: TIPOS.includes(o.tipo) ? o.tipo : null,
    regiao: o.regiao ? s(o.regiao, 60) : null,
    preco: numOrNull(o.preco, 0, 5000),
    pontuacaoAprox: null as number | null, // preenchido depois por pedirPontuacoesAprox()
  };
}

/* ── Coerência entre a sugestão e a carta que o modelo leu ──
   O modelo lê a carta E escolhe o vinho na mesma passagem: nada garante que
   o vinho recomendado seja um dos que ele próprio transcreveu para
   `vinhosCarta`, nem que o `precoCarta` que anuncia seja o preço que está
   impresso. É a falha que custa mais caro à mesa — pedir um vinho que não
   existe na carta, ou contar com 24€ e ver 38€ na conta — e é a única que se
   confirma sem gastar nem mais uma chamada ao Gemini: basta comparar as duas
   partes da resposta uma com a outra, aqui, em código.

   Não se apaga nenhuma sugestão por falhar isto: o emparelhamento é por
   nome, aproximado, e um falso negativo nosso a esconder o melhor vinho da
   carta seria pior do que o aviso. Marca-se, e quem está à mesa tem o menu
   na mão para confirmar num segundo. */
const ABREVIATURAS: Record<string, string> = {
  qta: "quinta", qtas: "quintas", hrd: "herdade", sto: "santo", sta: "santa",
};
// Sem valor para distinguir vinhos — "Quinta do X" e "Quinta do Y" não são o
// mesmo vinho só por partilharem "quinta".
const VAZIAS = new Set([
  "de", "do", "da", "dos", "das", "e", "o", "a", "os", "as", "um", "uma",
  "vinho", "vinhos", "wine",
]);
const GENERICAS = new Set([
  "quinta", "herdade", "casa", "adega", "monte", "vinha", "vinhas", "conde",
  "dom", "reserva", "colheita", "grande", "velhas", "regional", "doc",
]);

function tokensNome(n: unknown): string[] {
  return String(n ?? "")
    .normalize("NFD").replace(/\p{M}/gu, "")   // NFD + tira as marcas -> "é" fica "e"
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")                // a colheita não distingue aqui
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((t) => ABREVIATURAS[t] ?? t)
    .filter((t) => t && !VAZIAS.has(t));
}

function precoIgual(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.5;
}

/* Emparelha uma sugestão com a entrada da carta a que corresponde. Devolve
   também a confiança (0-1) e se o emparelhamento foi ambíguo — só um
   emparelhamento forte E único autoriza usar o preço lido para preencher um
   `precoCarta` em falta. */
function encontrarNaCarta(
  sug: Record<string, unknown>,
  vinhos: Record<string, unknown>[],
): { vinho: Record<string, unknown>; conf: number; ambiguo: boolean } | null {
  const ts = tokensNome(sug.nome);
  if (!ts.length) return null;
  const cands: { vinho: Record<string, unknown>; conf: number }[] = [];

  for (const v of vinhos) {
    // Tipos conhecidos e diferentes: o Papa Figos branco não é o tinto.
    // "Outro" (e null) é ausência de informação, não um tipo em conflito.
    const tipoSug = sug.tipo === "Outro" ? null : sug.tipo;
    const tipoV = v.tipo === "Outro" ? null : v.tipo;
    if (tipoSug && tipoV && tipoSug !== tipoV) continue;
    const tv = tokensNome(v.nome);
    if (!tv.length) continue;
    const comuns = ts.filter((t) => tv.includes(t));
    // Um único token em comum só chega se for um nome próprio — caso
    // contrário "Quinta do Crasto" casava com "Quinta da Romaneira".
    const especifico = comuns.length === 1 && comuns[0].length >= 5 && !GENERICAS.has(comuns[0]);
    if (comuns.length < 2 && !especifico) continue;
    // Contenção, não Jaccard: "Crasto" está contido em "Quinta do Crasto
    // Reserva" e é de propósito que isso conta como emparelhamento.
    const conf = comuns.length / Math.min(ts.length, tv.length);
    if (conf < 0.6) continue;
    cands.push({ vinho: v, conf });
  }
  if (!cands.length) return null;

  cands.sort((x, y) => y.conf - x.conf);
  const topo = cands.filter((c) => c.conf >= cands[0].conf - 0.001);
  // Empate (ex.: "Quinta do Crasto" com a gama base E a Reserva na mesma
  // carta): o preço desempata melhor do que a ordem em que vieram. Se nem o
  // preço desempatar, fica marcado ambíguo — escolhe-se um para poder dizer
  // que o vinho existe na carta, mas nada dali serve para preencher preços.
  const porPreco = topo.find((c) => precoIgual(c.vinho.preco, sug.precoCarta));
  const escolhido = porPreco ?? topo[0];
  return { ...escolhido, ambiguo: !porPreco && topo.length > 1 };
}

/* Anota cada sugestão com o que se conseguiu confirmar contra a carta lida.
   `naCarta: null` = não havia carta contra que verificar (não é o mesmo que
   "não está lá"). `precoCartaLido` só vem preenchido quando DISCORDA do
   `precoCarta` anunciado — é um aviso, não um dado a mostrar sempre. */
function verificarCoerencia(
  sugestoes: Record<string, unknown>[],
  vinhosCarta: Record<string, unknown>[],
): { semCarta: number; precoErrado: number; precoPreenchido: number } {
  const contas = { semCarta: 0, precoErrado: 0, precoPreenchido: 0 };
  for (const sug of sugestoes) {
    if (!vinhosCarta.length) {
      sug.coerencia = { naCarta: null, precoCartaLido: null };
      continue;
    }
    const m = encontrarNaCarta(sug, vinhosCarta);
    if (!m) {
      contas.semCarta++;
      sug.coerencia = { naCarta: false, precoCartaLido: null };
      continue;
    }
    const lido = typeof m.vinho.preco === "number" ? m.vinho.preco as number : null;
    let precoCartaLido: number | null = null;
    if (lido != null) {
      if (sug.precoCarta == null) {
        // O preço estava em falta na sugestão mas foi lido na carta — só se
        // aproveita com um emparelhamento forte e sem empate, senão é melhor
        // ficar "—" do que arriscar mostrar o preço da gama errada.
        if (m.conf >= 0.9 && !m.ambiguo) { sug.precoCarta = lido; contas.precoPreenchido++; }
      } else if (!precoIgual(lido, sug.precoCarta)) {
        precoCartaLido = lido;
        contas.precoErrado++;
      }
    }
    sug.coerencia = { naCarta: true, precoCartaLido };
  }
  return contas;
}

/* Segunda chamada, leve e SEM imagens nem pesquisa — só texto com os nomes já
   lidos na primeira. É o que permite dar uma pontuação aproximada a TODA a
   carta (não só as sugestões) sem repetir o custo caro de ler imagens +
   grounding por cada um dos até 40 vinhos. Corre com um limite de tempo
   próprio, curto, e nunca derruba a análise principal se falhar — fica só
   sem pontuação aproximada. */
async function pedirPontuacoesAprox(
  nomes: string[],
  model: string,
  parentSignal: AbortSignal,
): Promise<(number | null)[]> {
  const vazio = () => nomes.map(() => null);
  if (!nomes.length) return [];
  const lista = nomes.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const texto = `Para cada um destes vinhos, dá a tua estimativa geral de
pontuação (0 a 5, com casas decimais, ex.: 3.8) com base no que já sabes —
NÃO precisas de pesquisar nada, é só memória. Usa null se não reconheceres
o vinho de todo.

${lista}

Devolve APENAS um array JSON com ${nomes.length} números (ou null), na
MESMA ordem da lista acima — nada mais, sem texto à volta.`;

  const ctrl2 = new AbortController();
  const onAbort = () => ctrl2.abort();
  parentSignal.addEventListener("abort", onAbort);
  const subTimer = setTimeout(() => ctrl2.abort(), 15_000);
  try {
    const r = await fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl2.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: texto }] }],
        generationConfig: {
          temperature: 0,
          response_mime_type: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!r.ok) return vazio();
    const d = await r.json();
    const txt = (d?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
    const arr = extrairJson(txt);
    if (!Array.isArray(arr)) return vazio();
    return nomes.map((_, i) => numOrNull(arr[i], 0, 5));
  } catch (_) {
    return vazio();
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
  let model = "gemini-flash-latest";
  let comPesquisa = true;

  try {
    const texto = prompt(pratoLimpo, nImagens, orcamentoNum);
    const parts: unknown[] = [...partsImg, { text: texto }];

    /* Cada variante é uma forma de pedir a mesma coisa. Ordem por velocidade
       esperada, não por qualidade — com imagens (1 a 6) + grounding, o
       "thinking" por omissão dos modelos 2.5 é um custo de latência grande,
       por isso a 1ª tentativa já vem sempre com thinkingBudget:0. */
    type Variante = { search: boolean; semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { search: true, semThinking: true, label: "pesquisa+sem-pensar" },
      { search: true, semThinking: false, label: "pesquisa" },
      { search: false, semThinking: false, label: "sem-pesquisa" },
    ];
    const chamarGemini = (m: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = v.search
        ? { temperature: 0 }
        : { temperature: 0, response_mime_type: "application/json" };
      if (v.semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const corpo: Record<string, unknown> = { contents: [{ role: "user", parts }], generationConfig };
      if (v.search) corpo.tools = [{ google_search: {} }];
      return fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
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
    let g: Response | null = null;

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
      const erroUtilizador = transitorio(status)
        ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez"
        : `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}`;
      await atualizarAnalise(analiseId, quem, { estado: "erro", erro: erroUtilizador });
      return;
    }

    const gd = await g.json();
    const cand = gd?.candidates?.[0];
    const texto2 = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
    const parsed: any = extrairJson(texto2);
    if (!parsed) {
      console.error("SUGERIR-VINHO resposta ilegível:", texto2.slice(0, 400));
      await registar("erro", { passo: "json", modelo: model, pesquisa: comPesquisa, amostra: texto2.slice(0, 800) }, quem);
      await atualizarAnalise(analiseId, quem, {
        estado: "erro",
        erro: "resposta ilegível do modelo — tenta uma foto mais nítida",
      });
      return;
    }

    const sugestoes = (Array.isArray(parsed.sugestoes) ? parsed.sugestoes : [])
      .map(normSugestao).filter(Boolean).slice(0, 5) as Record<string, unknown>[];
    const vinhosCarta = (Array.isArray(parsed.vinhosCarta) ? parsed.vinhosCarta : [])
      .map(normVinhoCarta).filter(Boolean).slice(0, 60) as Record<string, unknown>[];
    const aviso = parsed.aviso ? s(parsed.aviso, 200) : null;

    // Confronta o que foi recomendado com o que foi lido — em código, sem
    // mais nenhuma chamada ao modelo (ver verificarCoerencia).
    const coerencia = verificarCoerencia(sugestoes, vinhosCarta);

    // Chamada leve à parte, só texto — nunca falha a análise principal (ver
    // pedirPontuacoesAprox), só fica sem pontuação aproximada se correr mal.
    if (vinhosCarta.length && !ctrl.signal.aborted) {
      const pontuacoes = await pedirPontuacoesAprox(
        vinhosCarta.map((v) => String(v.nome)),
        model,
        ctrl.signal,
      );
      vinhosCarta.forEach((v, i) => { v.pontuacaoAprox = pontuacoes[i] ?? null; });
    }

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
      pesquisa: comPesquisa, prato: pratoLimpo, fotos: nImagens, orcamento: orcamentoNum,
      pontuacoes_aprox: vinhosCarta.filter((v) => v.pontuacaoAprox != null).length,
      coerencia_sem_carta: coerencia.semCarta,
      coerencia_preco_errado: coerencia.precoErrado,
      coerencia_preco_preenchido: coerencia.precoPreenchido,
      fontes: fontes.map((f) => f.url).slice(0, 8),
    }, quem);

    const resultado = {
      prato: pratoLimpo,
      orcamento: orcamentoNum,
      sugestoes,
      vinhosCarta,
      aviso,
      fontes: fontes.slice(0, 8),
      pesquisa: comPesquisa,
      modelo: model,
      geradoEm: new Date().toISOString(),
    };
    await atualizarAnalise(analiseId, quem, { estado: "concluido", resultado });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
    await atualizarAnalise(analiseId, quem, {
      estado: "erro",
      erro: timeout
        ? "o modelo demorou demasiado a analisar a carta — tenta outra vez, ou uma foto mais nítida"
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
