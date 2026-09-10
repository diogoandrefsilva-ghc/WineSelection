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
    pontuacaoAprox: null as number | null,      // do catálogo, ou por pedirPontuacoesAprox()
    // De onde veio a nota acima: 'catalogo' é uma pesquisa a sério que
    // alguém já pagou (aqui ou na Garrafeira); 'estimativa' é o palpite de
    // memória do modelo. Continuam a ser coisas diferentes na mesma lista,
    // e a app tem de as poder separar.
    pontuacaoOrigem: null as string | null,
    pontuacaoAno: null as number | null,        // a colheita a que a nota pertence
    pontuacaoUrl: null as string | null,
  };
}

/* ── O QUE ISTO GASTOU ──
   A Garrafeira já contava os tokens de cada procura e esta app não contava
   nada — sendo a mais CARA das duas por chamada (fotos + pesquisa Google).
   Sem isto não há maneira de responder à única pergunta que interessa
   agora que existe o catálogo partilhado: está a poupar quanto?

   `usageMetadata` vem da própria API e é FACTO. A `sugerir-vinho` faz até
   duas chamadas por análise (a pesada e a leve das pontuações), por isso
   somam-se — uma só das duas contava metade da história. */
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
function somarUsage(total: UsageMetadata | null, add: UsageMetadata | null): UsageMetadata | null {
  if (!add) return total;
  if (!total) return { ...add };
  return {
    promptTokenCount: total.promptTokenCount + add.promptTokenCount,
    candidatesTokenCount: total.candidatesTokenCount + add.candidatesTokenCount,
    totalTokenCount: total.totalTokenCount + add.totalTokenCount,
  };
}

/* O CUSTO é uma estimativa GROSSEIRA e é preciso lê-la como tal: os tokens
   acima são facto, isto é um número redondo para dar ordem de grandeza no
   Diagnóstico. Não é um preço publicado que eu esteja a afirmar — a
   pesquisa Google é faturada À PARTE, por pedido, e o preço por token muda
   com o tempo. Se um dia isto passar de curiosidade a orçamento, calibra
   estes dois pela fatura real da Google. */
const CUSTO_ANALISE_EUR = 0.02;   // a pesada: fotos + grounding
const CUSTO_LEVE_EUR = 0.001;     // a das pontuações: só texto, sem pesquisa

/* ── O modelo da chamada LEVE ──
   A pesada precisa mesmo do `flash` (ler a fotografia de uma carta não é
   trabalho para o lite). A leve é só uma lista de nomes a pedir um número
   de 0 a 5 — e essa corria no mesmo modelo caro sem razão nenhuma. É o
   flash-lite que a Garrafeira usa como PRIMEIRA escolha em tudo.
   Se o lite falhar, repete-se no modelo que já respondeu: trocar de modelo
   não pode ser um caminho novo para ficar sem pontuações nenhumas. */
const MODELO_LEVE = Deno.env.get("GEMINI_CHEAP_MODEL") || "gemini-flash-lite-latest";

/* As fontes do grounding, sem repetidos. Era código solto dentro do
   `processarAnalise` e passou a função porque agora serve dois sítios: o
   resultado que se mostra e o que se grava no catálogo. */
function fontesParaCatalogo(cand: any): { titulo: string; url: string }[] {
  const out: { titulo: string; url: string }[] = [];
  (cand?.groundingMetadata?.groundingChunks ?? []).forEach((c: any) => {
    const w = c?.web;
    if (w?.uri && !out.some((f) => f.url === w.uri)) {
      out.push({ titulo: String(w.title ?? w.uri).slice(0, 80), url: String(w.uri) });
    }
  });
  return out;
}

/* ── CATÁLOGO PARTILHADO (schema `catalogo`) ──
   A memória comum desta app e da Garrafeira, no mesmo projeto Supabase.
   Serve duas perguntas que aqui se pagam caro:
   · a pontuação de um vinho da carta — que hoje sai de uma SEGUNDA chamada
     ao Gemini, de memória e sem pesquisa nenhuma (`pedirPontuacoesAprox`).
     Se alguém já pesquisou este vinho a sério — aqui ou na Garrafeira — a
     nota do catálogo é melhor do que essa estimativa E é de graça;
   · o preço de mercado, que é o que sustenta o "barato/justo/caro".

   Três regras que não são detalhe:
   · a CHAVE (o que faz dois vinhos serem o mesmo vinho) vive só no SQL:
     daqui vai o nome e o ano em cru. Ver a nota em `catalogo.chave()`;
   · a `pontuacaoAprox` NUNCA é escrita no catálogo. É uma estimativa de
     memória, e esta app inteira está construída à volta de não a disfarçar
     de verificação — espalhá-la pelas duas apps com ar de facto pesquisado
     era fazer pior do que isso. Só `sugestoes[].pontuacao` (que vem com
     pesquisa Google e fonte) e a `verificar-vinhos` é que escrevem;
   · nada disto pode deitar uma análise abaixo. É uma poupança, não uma
     dependência: se o RPC falhar, segue-se como sempre. */
const CATALOGO_IDADE_DIAS = 30;
// A Garrafeira tem seis cores e esta app tem sete rótulos que não são todos
// cores ("Verde" é estilo, "Doce" é doçura, "Outro" não é nada). Só estes
// quatro querem dizer o mesmo nas duas — o resto não se escreve, que um
// vocabulário mal traduzido enche os filtros da outra app de sinónimos.
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
      "Content-Profile": "catalogo", "Accept-Profile": "catalogo",
    },
    body: JSON.stringify(corpo),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) throw new Error(`catalogo ${fn} ${r.status}`);
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
  pedidos: { nome: string; ano: number | null }[], signal?: AbortSignal,
): Promise<(Conhecido | null)[]> {
  if (!pedidos.length) return [];
  try {
    const d = await catalogoRpc("procurar_lote", {
      p_pedidos: pedidos.map((p) => ({ nome: p.nome, produtor: "", ano: p.ano })),
      p_idade_dias: CATALOGO_IDADE_DIAS,
    }, signal);
    if (!Array.isArray(d)) return pedidos.map(() => null);
    return pedidos.map((_, i) => normConhecido(d[i]));
  } catch (_) { return pedidos.map(() => null); }
}

async function catalogoJuntar(
  nome: string, ano: number | null, ficha: Record<string, unknown>,
  origem: string, fontes: { titulo: string; url: string }[], signal?: AbortSignal,
) {
  try {
    if (!nome || !Object.keys(ficha).length) return;
    await catalogoRpc("juntar", {
      p_nome: nome, p_produtor: "", p_ano: ano,
      p_ficha: ficha, p_origem: origem, p_fontes: (fontes || []).slice(0, 8),
    }, signal);
  } catch (_) { /* o catálogo nunca falha uma análise */ }
}

/* A colheita, quando a carta a escreve ("Papa Figos 2020"). Vale a pena
   tirá-la: com ano, o catálogo responde com a nota DAQUELA colheita; sem
   ele, responde com a de uma recente e diz qual (ver `catalogo.procurar`). */
function anoDoNome(nome: string): number | null {
  const m = String(nome || "").match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
}

/* A nota do Vivino que o catálogo tem, se tiver. Só a do Vivino e só na
   escala de 5: uma nota de 92/100 de um crítico não é a mesma coisa e não
   se converte — dividir por 20 dava um número que ninguém publicou. */
function notaDoCatalogo(c: Conhecido | null): { valor: number; url: string | null; ano: number | null } | null {
  if (!c) return null;
  const v = numOrNull((c.ficha as any).vivino_nota, 0, 5);
  if (v == null) return null;
  const u = (c.ficha as any).vivino_url;
  return { valor: v, url: (typeof u === "string" && /^https?:\/\//i.test(u)) ? u.slice(0, 300) : null, ano: c.ano };
}

/* "18-25 €" -> 21.5. O ponto médio de uma faixa é o melhor número que dali
   se tira, e é o que a Garrafeira guarda como `preco_medio`. Um texto de
   que não saia número nenhum não escreve nada — inventar um preço era o
   pior que se podia deixar entrar num catálogo partilhado. */
function precoMedioDeFaixa(txt: unknown): number | null {
  const nums = String(txt ?? "").replace(",", ".").match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(Number).filter((n) => isFinite(n) && n > 0 && n < 100000);
  if (!vals.length) return null;
  const m = (Math.min(...vals) + Math.max(...vals)) / 2;
  return Math.round(m * 100) / 100;
}

/* Castas: o campo `casta` desta app é texto livre e às vezes traz a lista
   toda ("Touriga Nacional, Tinta Roriz"). Parte-se, e deitam-se fora as
   palavras que dizem a CONTAGEM das castas em vez de uma casta — mesma
   limpeza que a `vinho-info` da Garrafeira faz ao ler o Gemini, senão
   nascia uma casta fantasma chamada "Blend" ao lado das verdadeiras. */
function castasDoTexto(txt: unknown): string[] {
  return [...new Set(String(txt ?? "").split(/[,;/]|\se\s/i)
    .map((x) => x.replace(/\s*\(\d+%?\)\s*/g, " ").replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 2 && x.length <= 50)
    .filter((x) => !/^(blend|lote|v[aá]rias|diversas|field blend|castas?|misto|assemblage)$/i.test(x)))]
    .slice(0, 12);
}

/* O que de uma sugestão é FACTO SOBRE O VINHO, e por isso pode ser
   partilhado. Fica de fora tudo o que é sobre esta mesa: a `combinacao`
   (é sobre o prato que se pediu hoje), o `precoCarta` (é o preço deste
   restaurante) e a classificação "barato/justo/caro" — essa é um juízo
   sobre uma carta, não sobre o vinho, e o mesmo vinho é barato numa e caro
   noutra. Do preço só passa a FAIXA DE MERCADO, que é do vinho. */
function fichaDaSugestao(sug: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (TIPOS_PARTILHADOS.includes(String(sug.tipo))) out.tipo = sug.tipo;
  if (sug.regiao) out.regiao = s(sug.regiao, 60);
  const castas = castasDoTexto(sug.casta);
  if (castas.length) out.castas = castas;

  const pts = Array.isArray(sug.pontuacao) ? sug.pontuacao as any[] : [];
  const viv = pts.find((p) => /vivino/i.test(String(p?.fonte || "")) && Number(p?.escala) === 5);
  if (viv) {
    const n = numOrNull(viv.valor, 0, 5);
    if (n != null) out.vivino_nota = n;
    if (typeof viv.url === "string" && /vivino\.com/i.test(viv.url)) out.vivino_url = viv.url.slice(0, 300);
  }
  const pm = precoMedioDeFaixa((sug.precoAvaliacao as any)?.faixaMercado);
  if (pm != null) out.preco_medio = pm;
  return out;
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
): Promise<{ notas: (number | null)[]; usage: UsageMetadata | null; modelo: string }> {
  const vazio = () => ({ notas: nomes.map(() => null), usage: null, modelo: "" });
  if (!nomes.length) return { notas: [], usage: null, modelo: "" };
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

  const tentar = async (m: string) => {
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
          // (é com o google_search que ele dá 400 — ver as variantes).
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const txt = (d?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
    const arr = extrairJson(txt);
    if (!Array.isArray(arr)) return null;
    return {
      notas: nomes.map((_, i) => numOrNull(arr[i], 0, 5)),
      usage: usageMetadata(d),
      modelo: m,
    };
  };

  try {
    // O barato primeiro; o que já respondeu como rede. Nunca ficar sem
    // pontuações só por ter mudado de modelo.
    const leve = await tentar(MODELO_LEVE);
    if (leve) return leve;
    if (ctrl2.signal.aborted || MODELO_LEVE === model) return vazio();
    console.log("SUGERIR-VINHO pontuacoes: lite falhou, repete em", model);
    return (await tentar(model)) ?? vazio();
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
  // O que esta análise gastou, somado ao longo das (até) duas chamadas.
  let usageTotal: UsageMetadata | null = null;
  let chamadas = 0;
  let modeloLeve = "";

  try {
    const texto = prompt(pratoLimpo, nImagens, orcamentoNum);
    const parts: unknown[] = [...partsImg, { text: texto }];

    /* Cada variante é uma forma de pedir a mesma coisa. Ordem por velocidade
       esperada, não por qualidade — com imagens (1 a 6) + grounding, o
       "thinking" por omissão dos modelos 2.5 é um custo de latência grande,
       por isso a 1ª tentativa já vem sempre com thinkingBudget:0. */
    /* A 1ª variante era `pesquisa + thinkingBudget:0` e foi-se embora: pedir
       para não pensar AO MESMO TEMPO que se liga o tool `google_search`
       passou a ser recusado com 400 ("Request contains an invalid
       argument") pelos modelos que ficaram por trás dos ponteiros
       "-latest". A pesquisa precisa de pensar para decidir o que
       pesquisar, e a API deixou de aceitar as duas coisas juntas.

       Não estava PARTIDO — o loop caía na variante seguinte e a análise
       saía na mesma. Estava a pagar uma ida ao Gemini inútil em todas as
       análises, e a única maneira de dar por isso era ir ver o sync_log da
       outra app. Mesma correção que já está no `chamarGemini` do
       `vinho-info` da Garrafeira. */
    type Variante = { search: boolean; semThinking: boolean; label: string };
    const variantes: Variante[] = [
      { search: true, semThinking: false, label: "pesquisa" },
      // Sem pesquisa não há conflito nenhum: aqui o thinkingBudget:0 é o
      // que torna a última hipótese rápida em vez de só barata.
      { search: false, semThinking: true, label: "sem-pesquisa" },
    ];
    const chamarGemini = (m: string, v: Variante) => {
      const generationConfig: Record<string, unknown> = v.search
        ? { temperature: 0 }
        : { temperature: 0, response_mime_type: "application/json" };
      // `&& !v.search` é a trave, não um detalhe: as duas coisas juntas dão
      // 400 (ver a nota nas variantes). Fica aqui para que uma variante
      // nova mal combinada não volte a reabrir o mesmo buraco.
      if (v.semThinking && !v.search) generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
    usageTotal = somarUsage(usageTotal, usageMetadata(gd));
    chamadas++;
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

    /* ── As pontuações da lista: primeiro o que já se sabe, e só depois a IA
       Era sempre uma segunda chamada ao Gemini, a estimar ~40 vinhos de
       memória. Agora pergunta-se antes ao catálogo partilhado: um vinho que
       alguém já pesquisou a sério (aqui ou na Garrafeira), ou que alguém
       tem em casa com a ficha feita, responde já — e responde MELHOR, que
       uma nota pesquisada vale mais do que uma estimativa. A chamada ao
       Gemini fica só para os que sobram, e quando não sobra nenhum não há
       chamada nenhuma.

       `pontuacaoOrigem` é o que impede isto de virar uma mentira cómoda:
       a app tem de poder dizer quais são pesquisadas e quais são palpite,
       porque continuam a ser coisas diferentes na mesma lista. */
    let doCatalogo = 0;
    if (vinhosCarta.length && !ctrl.signal.aborted) {
      const conhecidos = await catalogoProcurarLote(
        vinhosCarta.map((v) => ({ nome: String(v.nome), ano: anoDoNome(String(v.nome)) })),
        ctrl.signal,
      );
      vinhosCarta.forEach((v, i) => {
        const n = notaDoCatalogo(conhecidos[i]);
        if (n) {
          v.pontuacaoAprox = n.valor;
          v.pontuacaoOrigem = "catalogo";
          // De que colheita é a nota: a carta muitas vezes não diz o ano, e
          // quem está à mesa merece saber a que garrafa é que ela pertence.
          v.pontuacaoAno = n.ano;
          v.pontuacaoUrl = n.url;
          doCatalogo++;
        } else {
          v.pontuacaoOrigem = "estimativa";
          v.pontuacaoAno = null;
          v.pontuacaoUrl = null;
        }
      });

      const faltam = vinhosCarta.filter((v) => v.pontuacaoOrigem === "estimativa");
      // Chamada leve à parte, só texto — nunca falha a análise principal (ver
      // pedirPontuacoesAprox), só fica sem pontuação aproximada se correr mal.
      if (faltam.length && !ctrl.signal.aborted) {
        const r2 = await pedirPontuacoesAprox(
          faltam.map((v) => String(v.nome)),
          model,
          ctrl.signal,
        );
        faltam.forEach((v, i) => { v.pontuacaoAprox = r2.notas[i] ?? null; });
        usageTotal = somarUsage(usageTotal, r2.usage);
        if (r2.modelo) { modeloLeve = r2.modelo; chamadas++; }
      }
    }

    const fontes = fontesParaCatalogo(cand);

    console.log("SUGERIR-VINHO sugestoes:", sugestoes.length, "vinhosCarta:", vinhosCarta.length, "pesquisa:", comPesquisa);
    await registar("ok", {
      sugestoes: sugestoes.length, vinhos_carta: vinhosCarta.length, modelo: model,
      pesquisa: comPesquisa, prato: pratoLimpo, fotos: nImagens, orcamento: orcamentoNum,
      pontuacoes_aprox: vinhosCarta.filter((v) => v.pontuacaoAprox != null).length,
      // Quantas notas vieram do catálogo (grátis) e quantas foram estimadas
      // pelo modelo: é por aqui que se vê se a partilha está a valer a pena.
      pontuacoes_catalogo: doCatalogo,
      // O que isto custou: os tokens são facto (vêm da API), o euro é a
      // estimativa grosseira dos CUSTO_*_EUR lá em cima.
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      chamadas_gemini: chamadas,
      ...(modeloLeve ? { modelo_leve: modeloLeve } : {}),
      custo_estimado_eur: Number(
        (CUSTO_ANALISE_EUR + (modeloLeve ? CUSTO_LEVE_EUR : 0)).toFixed(4),
      ),
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

    /* Só DEPOIS de a análise estar fechada: o que esta pesquisa descobriu
       vai para o catálogo partilhado, e é isso que faz a próxima pergunta —
       nesta app ou na Garrafeira — não a voltar a pagar. Fica para o fim de
       propósito: quem está à espera do resultado não tem de esperar por
       isto, e se falhar não estraga nada que já esteja feito.

       Só as SUGESTÕES, que são as únicas que vêm com pesquisa e fonte. A
       lista da carta não entra — ver a regra no bloco do catálogo. */
    if (comPesquisa) {
      for (const sug of sugestoes) {
        const ficha = fichaDaSugestao(sug);
        if (!Object.keys(ficha).length) continue;
        await catalogoJuntar(
          String(sug.nome), anoDoNome(String(sug.nome)), ficha,
          "ws-sugestao", fontes, ctrl.signal,
        );
      }
    }
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
