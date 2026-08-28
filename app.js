/* ── SESSÃO SUPABASE (mesmo projeto do FestasBV/Goals, schema `wineselection`) ──
   Mesmo padrão das outras apps: sessão em localStorage, refresh automático do
   access token (expira em ~1h), Accept/Content-Profile a escolher o schema —
   NUNCA no URL. */
const SB_URL='https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const ADMIN_EMAIL='diogo.andre.f.silva@gmail.com';
const SESSION_KEY='ws_sb_session';
let _sbSession=null;

function sbHeaders(extra={}){
  return Object.assign({
    'Content-Type':'application/json',
    'apikey':SB_KEY,
    'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`,
    'Accept-Profile':'wineselection',
    'Content-Profile':'wineselection'
  },extra);
}
function sbSaveSession(s){
  _sbSession=s;
  localStorage.setItem(SESSION_KEY,JSON.stringify(s));
}
let _refreshing=null;
async function sbRefresh(){
  if(!_sbSession||!_sbSession.refresh_token)return false;
  if(_refreshing)return _refreshing;
  _refreshing=(async()=>{
    try{
      const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
        method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:_sbSession.refresh_token})
      });
      if(!r.ok)return false;
      const d=await r.json();
      sbSaveSession({
        access_token:d.access_token,
        refresh_token:d.refresh_token||_sbSession.refresh_token,
        expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
        user:d.user||_sbSession.user
      });
      return true;
    }catch(e){return false;}
  })();
  const ok=await _refreshing;
  _refreshing=null;
  return ok;
}
function tokenQuaseExpirado(){
  if(!_sbSession)return false;
  if(!_sbSession.expires_at)return true;
  return (_sbSession.expires_at-Date.now()/1000)<120;
}
async function sbEnsureFresh(){
  if(_sbSession&&_sbSession.refresh_token&&tokenQuaseExpirado())await sbRefresh();
}
async function sbFetch(url,opt){
  await sbEnsureFresh();
  opt=opt||{};
  opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`});
  let r=await fetch(url,opt);
  if(r.status===401&&_sbSession&&_sbSession.refresh_token){
    if(await sbRefresh()){
      opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession.access_token}`});
      r=await fetch(url,opt);
    }
  }
  return r;
}
async function sbReq(method,path,body,extra){
  const opt={method,headers:sbHeaders(extra||{})};
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await sbFetch(`${SB_URL}/rest/v1/${path}`,opt);
  if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();m=j.message||m;}catch(_){}throw new Error(m);}
  const tx=await r.text();
  return tx?JSON.parse(tx):null;
}

function isAdmin(){return !!(_sbSession&&_sbSession.user&&_sbSession.user.email===ADMIN_EMAIL);}

/* ── TOAST ─────────────────────────────────── */
let _toastTimer=null;
function toast(msg,erro){
  const t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;
  t.classList.toggle('erro',!!erro);
  t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>t.classList.remove('on'),3200);
}

/* ── TABS ──────────────────────────────────── */
function itab(tab){
  document.querySelectorAll('#app-sec > .itabs > .it').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  document.querySelectorAll('#app-sec > .tp').forEach(p=>p.classList.remove('on'));
  const el=document.getElementById('t-'+tab);
  if(el)el.classList.add('on');
  try{localStorage.setItem('ws_tab',tab);}catch(e){}
  if(tab==='historico')wsCarregarHistorico();
}
function restaurarTab(){
  let tab=null;
  try{tab=localStorage.getItem('ws_tab');}catch(e){}
  if(!tab||!document.getElementById('t-'+tab))tab='sugerir';
  itab(tab);
}

/* ── IMAGEM DA CARTA ───────────────────────── */
let _wsImagem=null; // {base64, mime}

async function wsProcessarImagem(file){
  const MAX=1600;
  try{
    const bitmap=await createImageBitmap(file);
    let{width,height}=bitmap;
    if(width>MAX||height>MAX){
      const scale=MAX/Math.max(width,height);
      width=Math.round(width*scale);height=Math.round(height*scale);
    }
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');
    ctx.drawImage(bitmap,0,0,width,height);
    const dataUrl=canvas.toDataURL('image/jpeg',0.82);
    return{base64:dataUrl.split(',')[1],mime:'image/jpeg'};
  }catch(e){
    // Fallback (ex: formato que o canvas não decodifica): manda o ficheiro tal qual.
    const dataUrl=await new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=()=>res(r.result);
      r.onerror=rej;
      r.readAsDataURL(file);
    });
    return{base64:dataUrl.split(',')[1],mime:file.type||'image/jpeg'};
  }
}

async function wsImagemEscolhida(event){
  const file=event.target.files&&event.target.files[0];
  if(!file)return;
  const statusEl=document.getElementById('img-status');
  statusEl.style.display='block';statusEl.style.color='var(--mu)';statusEl.textContent='A preparar imagem…';
  try{
    const{base64,mime}=await wsProcessarImagem(file);
    _wsImagem={base64,mime};
    const preview=document.getElementById('img-preview');
    preview.src=`data:${mime};base64,${base64}`;
    preview.style.display='block';
    document.getElementById('img-drop-empty').style.display='none';
    statusEl.style.display='none';
    document.getElementById('btn-sugerir').disabled=false;
  }catch(e){
    statusEl.style.color='var(--dg)';
    statusEl.textContent='Não consegui ler esta imagem — tenta outra foto.';
  }
}

/* ── SUGERIR VINHO (chama a Edge Function) ────── */
async function wsSugerir(){
  if(!_wsImagem){toast('Escolhe primeiro uma foto da carta',1);return;}
  const prato=document.getElementById('in-prato').value.trim();
  const btn=document.getElementById('btn-sugerir');
  const status=document.getElementById('sugerir-status');
  btn.disabled=true;const btnTxtOrig=btn.textContent;btn.textContent='A analisar a carta…';
  status.style.display='block';status.style.color='var(--mu)';
  status.textContent='A ler a carta e a procurar avaliações e preços de referência — pode demorar até um minuto…';
  document.getElementById('resultado-box').innerHTML='';
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/sugerir-vinho`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({imagem:_wsImagem.base64,mime:_wsImagem.mime,prato})
    });
    let d={};try{d=await r.json();}catch(_){}
    if(!r.ok){
      status.style.color='var(--dg)';
      status.textContent=d.error||('Erro HTTP '+r.status+' — tenta outra vez.');
      return;
    }
    status.style.display='none';
    document.getElementById('resultado-box').innerHTML=wsResultadoHTML(d);
    wsGuardarHistorico(prato,d);
  }catch(e){
    status.style.color='var(--dg)';
    status.textContent='Erro de ligação — tenta outra vez.';
  }finally{
    btn.disabled=false;btn.textContent=btnTxtOrig;
  }
}

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtEur(v){return typeof v==='number'&&isFinite(v)?v.toFixed(2).replace('.',',')+' €':'—';}

const PRECO_INFO={
  barato:{cls:'bg-ok',txt:'Preço abaixo do mercado'},
  justo:{cls:'bg-ok',txt:'Preço justo'},
  caro:{cls:'bg-warn',txt:'Um pouco caro'},
  muito_caro:{cls:'bg-bad',txt:'Preço exagerado'},
  desconhecido:{cls:'bg-mu',txt:'Sem dados de preço'}
};

function wsPontuacaoHTML(pontuacao){
  if(!Array.isArray(pontuacao)||!pontuacao.length)return '';
  return `<div class="pont-row">${pontuacao.map(p=>{
    const valor=typeof p.valor==='number'?p.valor.toFixed(1):'?';
    const escala=p.escala||5;
    const corpo=`⭐ ${valor}/${escala} <span class="pont-fonte">${esc(p.fonte||'')}</span>`;
    return p.url
      ?`<a class="pont-badge" href="${esc(p.url)}" target="_blank" rel="noopener">${corpo}</a>`
      :`<span class="pont-badge">${corpo}</span>`;
  }).join('')}</div>`;
}

function wsVinhoCardHTML(v,destaque){
  const pi=PRECO_INFO[(v.precoAvaliacao&&v.precoAvaliacao.classificacao)||'desconhecido']||PRECO_INFO.desconhecido;
  const sub=[v.tipo,v.regiao,v.casta].filter(Boolean).map(esc).join(' · ');
  return `<div class="vinho-card${destaque?' destaque':''}">
    ${destaque?'<div class="vinho-ribbon">🏆 Melhor escolha</div>':''}
    <div class="vinho-head">
      <div>
        <div class="vinho-nome">${esc(v.nome||'Vinho')}</div>
        ${sub?`<div class="vinho-sub">${sub}</div>`:''}
      </div>
      <div class="vinho-preco">${fmtEur(v.precoCarta)}</div>
    </div>
    ${wsPontuacaoHTML(v.pontuacao)}
    <div class="preco-badge ${pi.cls}">${pi.txt}${v.precoAvaliacao&&v.precoAvaliacao.faixaMercado?` · ref. ${esc(v.precoAvaliacao.faixaMercado)}`:''}</div>
    ${v.precoAvaliacao&&v.precoAvaliacao.comentario?`<p class="vinho-txt">${esc(v.precoAvaliacao.comentario)}</p>`:''}
    ${v.combinacao?`<p class="vinho-txt"><strong>Porque combina:</strong> ${esc(v.combinacao)}</p>`:''}
  </div>`;
}

function wsResultadoHTML(d){
  const sug=Array.isArray(d.sugestoes)?d.sugestoes:[];
  if(!sug.length){
    return `<div class="ws-card"><p class="ws-note">${esc(d.aviso||'Não encontrei sugestões claras nesta carta — tenta uma foto mais nítida.')}</p></div>`;
  }
  let html=sug.map((v,i)=>wsVinhoCardHTML(v,i===0)).join('');
  if(Array.isArray(d.vinhosCarta)&&d.vinhosCarta.length){
    html+=`<div class="ws-card">
      <div class="ws-card-label">Vinhos lidos na carta (${d.vinhosCarta.length})</div>
      <div class="carta-list">${d.vinhosCarta.map(v=>`<div class="carta-item"><span>${esc(v.nome||'')}</span><span class="carta-preco">${fmtEur(v.preco)}</span></div>`).join('')}</div>
    </div>`;
  }
  if(Array.isArray(d.fontes)&&d.fontes.length){
    html+=`<div class="ws-fontes">Fontes: ${d.fontes.map(f=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo||f.url)}</a>`).join(' · ')}</div>`;
  }
  return html;
}

/* ── HISTÓRICO ─────────────────────────────── */
async function wsGuardarHistorico(prato,resultado){
  try{
    await sbReq('POST','analises',{prato,resultado},{Prefer:'return=minimal'});
  }catch(e){/* não bloqueia a UI por causa disto */}
}
async function wsCarregarHistorico(){
  const box=document.getElementById('historico-list');
  box.innerHTML='<p class="ws-note">A carregar…</p>';
  try{
    const rows=await sbReq('GET','analises?select=id,prato,resultado,criado_em&order=criado_em.desc&limit=30');
    if(!rows||!rows.length){box.innerHTML='<p class="ws-note">Ainda não fizeste nenhuma pesquisa.</p>';return;}
    box.innerHTML=rows.map(r=>wsHistItemHTML(r)).join('');
  }catch(e){box.innerHTML='<p class="ws-note">Erro a carregar histórico.</p>';}
}
function wsHistItemHTML(r){
  const sug=(r.resultado&&Array.isArray(r.resultado.sugestoes))?r.resultado.sugestoes:[];
  const top=sug[0]||null;
  const data=new Date(r.criado_em);
  const dataFmt=isNaN(data)?'':data.toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'});
  return `<div class="hist-item">
    <div class="hist-head" onclick="wsToggleHist(${r.id})">
      <div>
        <div class="hist-prato">${esc(r.prato||'(sem prato indicado)')}</div>
        <div class="hist-top">${top?('🍷 '+esc(top.nome)):'sem sugestões'}</div>
      </div>
      <div class="hist-data">${dataFmt}</div>
    </div>
    <div class="hist-body" id="hist-body-${r.id}" style="display:none">${wsResultadoHTML(r.resultado||{})}</div>
  </div>`;
}
function wsToggleHist(id){
  const el=document.getElementById('hist-body-'+id);
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}

/* ── UTILIZADORES (admin) ─────────────────────── */
async function sbRenderPedidos(){
  const box=document.getElementById('adm-pedidos-list');
  if(!box)return;
  try{
    const reqs=await sbReq('GET','access_requests?select=email,requested_at&order=requested_at.asc');
    if(!reqs||!reqs.length){box.innerHTML='<div class="ws-note">Sem pedidos pendentes.</div>';return;}
    box.innerHTML=reqs.map(r=>`
      <div class="ua-row">
        <span>${esc(r.email)}</span>
        <button class="jdel ok" title="Aprovar" onclick="sbAprovarAcesso('${r.email.replace(/'/g,"\\'")}')">✓</button>
        <button class="jdel" title="Recusar" onclick="sbRecusarAcesso('${r.email.replace(/'/g,"\\'")}')">✕</button>
      </div>`).join('');
  }catch(e){box.innerHTML='<div class="ws-note">Erro a carregar pedidos.</div>';}
}
async function sbAprovarAcesso(email){
  try{
    await sbReq('POST','allowed_users',{email},{Prefer:'resolution=merge-duplicates'});
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Acesso aprovado ✓');
    sbRenderPedidos();
    sbRenderPassTemp();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function sbRecusarAcesso(email){
  try{
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Pedido removido');
    sbRenderPedidos();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function sbRenderPassTemp(){
  const sel=document.getElementById('adm-pt-email');
  if(!sel)return;
  try{
    const rows=await sbReq('GET','allowed_users?select=email&order=email.asc');
    const opts=(rows||[]).filter(r=>r.email!==ADMIN_EMAIL);
    sel.innerHTML=opts.length
      ?opts.map(r=>`<option value="${esc(r.email)}">${esc(r.email)}</option>`).join('')
      :'<option value="">(sem outros utilizadores)</option>';
  }catch(e){sel.innerHTML='<option value="">(erro a carregar)</option>';}
}
async function admGerarPassTemp(){
  const sel=document.getElementById('adm-pt-email');
  const out=document.getElementById('adm-pt-out');
  const email=sel&&sel.value;
  if(!email){toast('Escolhe um utilizador',1);return;}
  const pass='vinho-'+Math.floor(1000+Math.random()*9000);
  const btn=document.getElementById('adm-pt-btn');
  btn.disabled=true;btn.textContent='A gerar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/rpc/admin_pass_temp`,{
      method:'POST',headers:sbHeaders(),body:JSON.stringify({p_email:email,p_password:pass})
    });
    const tx=await r.text();
    if(!r.ok){
      let msg=tx;try{msg=JSON.parse(tx).message||msg;}catch(_){}
      if(/does not exist|schema cache/i.test(msg)){
        out.innerHTML='<p class="ws-note" style="color:var(--dg)">Falta correr db/admin_pass_temp.sql no Supabase.</p>';
      }else{
        out.innerHTML=`<p class="ws-note" style="color:var(--dg)">Erro: ${esc(msg)}</p>`;
      }
      return;
    }
    out.innerHTML=`<p class="ws-note" style="color:var(--vd)">Password para <strong>${esc(email)}</strong>: <code>${esc(pass)}</code><br>Dita-a por telefone — a pessoa troca-a em Definições.</p>`;
  }catch(e){
    out.innerHTML='<p class="ws-note" style="color:var(--dg)">Erro de ligação.</p>';
  }finally{
    btn.disabled=false;btn.textContent='Gerar';
  }
}

/* ── AUTH (Supabase) ─────────────────────────── */
function sbRedirectUrl(){return window.location.href.split('#')[0].split('?')[0];}
function sbLimparHash(){window.history.replaceState({},document.title,window.location.pathname);}
function sbAuthStatus(id,txt,cor){
  const s=document.getElementById(id);if(!s)return;
  s.style.display='block';s.textContent=txt;s.style.color=cor||'var(--mu)';
}
function sbLinkFalhou(motivo){
  sbLimparHash();sbMostrarLogin();
  sbAuthStatus('login-status','O link já expirou ou já tinha sido aberto'+(motivo?' ('+motivo+')':'')+'. Escreve antes o código de 6 dígitos que vem no mesmo email.','var(--dg)');
  sbMostrarCaixaCodigo();
}
async function sbTratarHashAuth(){
  const hs=new URLSearchParams((window.location.hash||'').substring(1));
  const qs=new URLSearchParams(window.location.search||'');
  const g=k=>hs.get(k)||qs.get(k);
  const recovery=g('type')==='recovery';

  if(g('error')||g('error_code')){
    const cod=(g('error_code')||'')+' '+(g('error_description')||'');
    if(/expired|invalid|used/i.test(cod)){sbLinkFalhou(g('error_code')||'');return true;}
    sbLimparHash();sbMostrarLogin();
    sbAuthStatus('login-status',g('error_description')||'Não foi possível concluir a autenticação.','var(--dg)');
    return true;
  }

  const token_hash=g('token_hash');
  if(token_hash){
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:g('type')||'recovery',token_hash})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbLinkFalhou(d.error_code||d.msg||('HTTP '+r.status));return true;
    }
    const d=await r.json();
    sbGuardarSessaoDeVerify(d);
    sbLimparHash();
    if(recovery){sbMostrarNovaPass();return true;}
    await sbAposLogin();
    return true;
  }

  const access_token=g('access_token');
  if(!access_token)return false;
  const refresh_token=g('refresh_token');
  const expires_at=parseInt(g('expires_at'))||Math.floor(Date.now()/1000)+(parseInt(g('expires_in'))||3600);
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${access_token}`}});
  if(!r.ok){sbLinkFalhou('HTTP '+r.status);return true;}
  const u=await r.json();
  sbSaveSession({access_token,refresh_token,expires_at,user:u});
  sbLimparHash();
  if(recovery){sbMostrarNovaPass();return true;}
  await sbAposLogin();
  return true;
}
function sbGuardarSessaoDeVerify(d){
  sbSaveSession({
    access_token:d.access_token,
    refresh_token:d.refresh_token,
    expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
    user:d.user
  });
}
async function sbInit(){
  try{
    if(await sbTratarHashAuth())return;
  }catch(e){
    if(window.location.hash.length>1||window.location.search.length>1){
      sbLimparHash();sbMostrarLogin();
      sbAuthStatus('login-status','Não foi possível validar o link — sem ligação. Tenta outra vez.','var(--dg)');
      return;
    }
  }
  const stored=localStorage.getItem(SESSION_KEY);
  if(stored){
    try{
      const s=JSON.parse(stored);
      _sbSession=s;
      if(tokenQuaseExpirado())await sbRefresh();
      let r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      if(!r.ok&&_sbSession.refresh_token){
        if(await sbRefresh())
          r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      }
      if(r.ok){const u=await r.json();sbSaveSession({..._sbSession,user:u});await sbAposLogin();return;}
    }catch(e){}
    _sbSession=null;
    localStorage.removeItem(SESSION_KEY);
  }
  sbMostrarLogin();
}
function sbMostrarLogin(){
  document.getElementById('page-login').style.display='flex';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  if(window.wsEsconderSplash)window.wsEsconderSplash();
}
async function sbAposLogin(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  const email=_sbSession.user.email;
  let data=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,{headers:sbHeaders()});
    if(r.ok)data=await r.json();
  }catch(e){}
  if(!Array.isArray(data)||data.length===0){
    document.getElementById('page-sem-acesso').style.display='flex';
    document.getElementById('sem-acesso-email').textContent=`Sessão iniciada como ${email}. Esta conta não tem acesso à app.`;
    if(window.wsEsconderSplash)window.wsEsconderSplash();
    return;
  }
  document.getElementById('page-sem-acesso').style.display='none';
  const contaEmailEl=document.getElementById('conta-email');
  if(contaEmailEl)contaEmailEl.textContent=`Sessão iniciada como ${email}`;
  document.getElementById('fcard-utilizadores').style.display=isAdmin()?'':'none';
  restaurarTab();
  if(isAdmin()){sbRenderPedidos();sbRenderPassTemp();}
  if(window.wsEsconderSplash)window.wsEsconderSplash();
}
async function sbLoginGoogle(){
  window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(sbRedirectUrl())}`;
}
async function sbRecuperarPassword(){
  const email=document.getElementById('login-email').value.trim();
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve primeiro o teu email aqui em cima e volta a tocar.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  sbAuthStatus('login-status','A enviar email…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(sbRedirectUrl())}`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email})
    });
    if(r.status===429){sbAuthStatus('login-status','Já foi pedido um email há pouco. Espera uns minutos e tenta outra vez.','var(--dg)');return;}
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbAuthStatus('login-status',d.error_description||d.msg||d.message||'Não foi possível enviar o email.','var(--dg)');return;
    }
    sbAuthStatus('login-status','Se houver conta com esse email, chega já o link e o código para definires uma password nova. Vê também o spam.','var(--vd)');
    sbMostrarCaixaCodigo();
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}
function sbMostrarCaixaCodigo(){
  const box=document.getElementById('login-codigo');
  if(box)box.style.display='';
}
async function sbVerificarCodigo(){
  const email=document.getElementById('login-email').value.trim();
  const token=document.getElementById('login-cod').value.replace(/\s/g,'');
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve também o teu email aqui em cima — o código é confirmado com ele.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  if(!token){sbAuthStatus('login-status','Escreve o código que veio no email.','var(--dg)');return;}
  const btn=document.getElementById('btn-login-cod');
  btn.disabled=true;btn.textContent='A confirmar…';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:'recovery',email,token})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      const msg=d.error_description||d.msg||d.message||'';
      sbAuthStatus('login-status',(!msg||/expired|invalid|token/i.test(msg))
        ?'Código errado ou já expirado. Confirma os dígitos ou pede outro email.':msg,'var(--dg)');
      btn.disabled=false;btn.textContent='Confirmar código';return;
    }
    sbGuardarSessaoDeVerify(await r.json());
    document.getElementById('login-cod').value='';
    btn.disabled=false;btn.textContent='Confirmar código';
    sbMostrarNovaPass();
  }catch(e){
    sbAuthStatus('login-status','Erro de ligação.','var(--dg)');
    btn.disabled=false;btn.textContent='Confirmar código';
  }
}
function sbMostrarNovaPass(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='flex';
  const sub=document.getElementById('nova-pass-sub');
  if(sub&&_sbSession&&_sbSession.user)sub.textContent=`Escolhe uma password nova para ${_sbSession.user.email}.`;
  if(window.wsEsconderSplash)window.wsEsconderSplash();
}
function sbValidarPass(p1,p2){
  if(p1.length<6)return 'A password tem de ter pelo menos 6 caracteres.';
  if(p1!==p2)return 'As duas passwords não são iguais.';
  return '';
}
async function sbTrocarPassword(password){
  let r;
  try{
    r=await sbFetch(`${SB_URL}/auth/v1/user`,{
      method:'PUT',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({password})
    });
  }catch(e){return 'Erro de ligação — tenta outra vez.';}
  if(r.ok)return '';
  let d={};try{d=await r.json();}catch(_){}
  const msg=d.error_description||d.msg||d.message||('HTTP '+r.status);
  if(/should be different/i.test(msg))return 'Essa já é a password atual — escolhe outra.';
  if(r.status===401||r.status===403)return 'A sessão do link já expirou. Pede outro email de recuperação.';
  return msg;
}
async function sbDefinirNovaPassword(){
  const p1=document.getElementById('nova-pass-1').value;
  const p2=document.getElementById('nova-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){sbAuthStatus('nova-pass-status',erro,'var(--dg)');return;}
  const btn=document.getElementById('btn-nova-pass');
  btn.disabled=true;btn.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){
    sbAuthStatus('nova-pass-status',falha,'var(--dg)');
    btn.disabled=false;btn.textContent='Guardar password';return;
  }
  document.getElementById('nova-pass-1').value='';
  document.getElementById('nova-pass-2').value='';
  document.getElementById('nova-pass-campos').style.display='none';
  document.getElementById('btn-nova-pass-entrar').style.display='';
  sbAuthStatus('nova-pass-status','Password alterada ✓ Se abriste este link fora da app, volta a abrir a app instalada e entra com o email e a password nova.','var(--vd)');
}
function toggleAdmPass(){
  const box=document.getElementById('adm-pass-box');
  if(!box)return;
  box.style.display=box.style.display==='none'?'':'none';
  const st=document.getElementById('adm-pass-status');
  if(st)st.textContent='';
}
async function sbAlterarPassword(){
  const st=document.getElementById('adm-pass-status');
  const p1=document.getElementById('adm-pass-1').value;
  const p2=document.getElementById('adm-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){st.style.color='var(--dg)';st.textContent=erro;return;}
  st.style.color='var(--mu)';st.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){st.style.color='var(--dg)';st.textContent=falha;return;}
  document.getElementById('adm-pass-1').value='';
  document.getElementById('adm-pass-2').value='';
  st.style.color='var(--vd)';st.textContent='Password alterada ✓';
  toast('Password alterada ✓');
}
async function sbLoginEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A entrar…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao entrar.';return;}
    sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
    await sbAposLogin();
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}
async function sbRegistarEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A criar conta…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao criar conta.';return;}
    // Login (auth.users) é partilhado por todo o projeto Supabase (FestasBV/Goals/SplitBill/…).
    // Email já registado noutra app: o GoTrue devolve 200 sem enviar confirmação, mas com identities:[].
    if(d.user&&Array.isArray(d.user.identities)&&d.user.identities.length===0){
      status.style.color='var(--dg)';status.textContent='Esta conta já existe (ex.: já criaste login noutra app). Não é preciso criar de novo — carrega em "Entrar" com o mesmo email e password.';
      return;
    }
    status.style.color='var(--vd)';status.textContent='Conta criada! Confirma o email e volta a entrar.';
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}
async function sbSolicitarAcesso(){
  if(!_sbSession)return;
  const btn=document.getElementById('btn-solicitar');
  const btnV=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A enviar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/access_requests`,{
      method:'POST',
      headers:sbHeaders({'Prefer':'return=minimal'}),
      body:JSON.stringify({email:_sbSession.user.email})
    });
    if(r.ok||r.status===409){
      status.style.display='block';status.style.color='var(--vd)';
      status.textContent=r.status===409?'✓ O pedido já estava registado. Aguarda aprovação.':'✓ Pedido enviado! Aguarda aprovação.';
      btn.style.display='none';
      btnV.style.display='';
      return;
    }
    let msg='HTTP '+r.status;
    try{const j=await r.json();msg=j.message||msg;}catch(_){}
    if(r.status===401)msg='Sessão expirada — sai e volta a entrar.';
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro ao enviar pedido: '+msg;
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }catch(e){
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro de ligação — tenta novamente.';
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }
}
async function sbVerificarAcesso(){
  const btn=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A verificar…';
  await sbAposLogin();
  btn.disabled=false;btn.textContent='🔄 Verificar acesso';
  status.style.display='block';status.style.color='var(--mu)';
  status.textContent='Acesso ainda não aprovado. Tenta mais tarde.';
}
function sbLogout(){
  localStorage.removeItem(SESSION_KEY);
  _sbSession=null;
  window.location.reload();
}

/* ── INIT ──────────────────────────────────── */
document.addEventListener('DOMContentLoaded',sbInit);
