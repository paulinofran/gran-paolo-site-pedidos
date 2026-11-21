// ============================================================================
// whatsapp-robo  ·  Gran Paolo
// Ponte entre o WhatsApp (Meta Cloud API) e o banco (Supabase).
// Toda a "inteligencia" (o que responder) fica no banco, na Parte F.
// Este programa so: confere quem esta chamando, recebe, manda e anota.
//
// Segredos (Supabase > Edge Functions > Secrets):
//   WHATSAPP_TOKEN        token permanente da Meta
//   WHATSAPP_PHONE_ID     ID do numero (Phone number ID)
//   WHATSAPP_APP_SECRET   "Chave secreta do app" (confere se a mensagem veio da Meta)
//   WHATSAPP_VERIFY_TOKEN palavra que voce inventa e digita na Meta ao ligar o webhook
//   ROBO_CHAVE            senha para o banco acionar o envio dos avisos e das notas
//   FOCUS_TOKEN_HOMOLOGACAO  token de TESTE da Focus NFe (notas sem valor fiscal)
//   FOCUS_TOKEN_PRODUCAO     token de PRODUCAO da Focus NFe (so cadastre na virada)
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o Supabase ja entrega sozinho.)
// ============================================================================

const LOJA = 'gran-paolo';
const GRAPH = 'https://graph.facebook.com/v21.0';

const env = (k: string): string =>
  ((globalThis as any).Deno ? (globalThis as any).Deno.env.get(k) : (globalThis as any).process?.env?.[k]) || '';

const enc = new TextEncoder();

// ---------- seguranca ----------
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function assinaturaValida(corpo: string, cab: string | null): Promise<boolean> {
  const segredo = env('WHATSAPP_APP_SECRET');
  if (!segredo || !cab || !cab.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(corpo)));
  const hex = Array.from(mac).map((b) => b.toString(16).padStart(2, '0')).join('');
  return iguais(hex, cab.slice(7));
}

// ---------- banco ----------
async function rpc(nome: string, corpo: unknown): Promise<any> {
  const chave = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`banco (${nome}): ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// ---------- WhatsApp ----------
const paraE164 = (tel: string): string => {
  const d = String(tel).replace(/\D/g, '');
  return d.startsWith('55') && d.length >= 12 ? d : '55' + d;
};

type Envio = { ok: boolean; id?: string; erro?: string; semJanela?: boolean };

async function enviar(para: string, texto: string): Promise<Envio> {
  try {
    const r = await fetch(`${GRAPH}/${env('WHATSAPP_PHONE_ID')}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: paraE164(para), type: 'text', text: { preview_url: true, body: texto } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: j?.messages?.[0]?.id };
    const code = j?.error?.code;
    return { ok: false, erro: `${code ?? r.status}: ${j?.error?.message ?? ''}`.slice(0, 300), semJanela: code === 131047 };
  } catch (e) {
    return { ok: false, erro: 'rede: ' + String((e as Error).message).slice(0, 200) };
  }
}

// foto com legenda (o WhatsApp so aceita JPG ou PNG; o link precisa ser publico)
async function enviarImagem(para: string, url: string, legenda: string): Promise<Envio> {
  try {
    const r = await fetch(`${GRAPH}/${env('WHATSAPP_PHONE_ID')}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: paraE164(para), type: 'image', image: { link: url, caption: legenda.slice(0, 1000) } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: j?.messages?.[0]?.id };
    const code = j?.error?.code;
    return { ok: false, erro: `${code ?? r.status}: ${j?.error?.message ?? ''}`.slice(0, 300), semJanela: code === 131047 };
  } catch (e) {
    return { ok: false, erro: 'rede: ' + String((e as Error).message).slice(0, 200) };
  }
}

// ---------- foto / audio / video / arquivo do cliente ----------
// Baixa o arquivo da Meta e guarda no cofre privado (Storage: midias-whatsapp) para a equipe ver em Gestao > Robo.
const EXT_MIDIA: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf',
};
async function guardarMidia(msg: any): Promise<void> {
  const tipo = String(msg.type);
  const m = msg[tipo];
  if (!['image', 'audio', 'video', 'document'].includes(tipo) || !m?.id) return;
  const auth = { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}` };
  const meta = await fetch(`${GRAPH}/${m.id}`, { headers: auth });
  if (!meta.ok) throw new Error('meta midia ' + meta.status);
  const info = await meta.json();
  if (!info?.url) throw new Error('meta sem url da midia');
  const arq = await fetch(info.url, { headers: auth });
  if (!arq.ok) throw new Error('download midia ' + arq.status);
  const bytes = new Uint8Array(await arq.arrayBuffer());
  if (bytes.length > 15 * 1024 * 1024) throw new Error('midia grande demais (' + bytes.length + ')');
  const mime = String(info.mime_type || m.mime_type || 'application/octet-stream').split(';')[0].trim();
  const nomeArq = String(m.filename || '');
  const ext = EXT_MIDIA[mime] || (nomeArq.includes('.') ? nomeArq.split('.').pop()!.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : 'bin');
  const tel = String(msg.from).replace(/\D/g, '');
  const caminho = `${LOJA}/${tel}/${String(msg.id).replace(/[^A-Za-z0-9]/g, '')}.${ext}`;
  const chave = env('SUPABASE_SERVICE_ROLE_KEY');
  const up = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/midias-whatsapp/${caminho}`, {
    method: 'POST',
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!up.ok) throw new Error('storage ' + up.status + ' ' + (await up.text()).slice(0, 150));
  await rpc('bot_anexar_midia', { p_loja: LOJA, p_wa_id: msg.id, p_tipo: tipo, p_path: caminho, p_legenda: m.caption ?? null });
}

// ---------- AUDIO -> TEXTO (OpenAI) ----------
// Cliente mandou mensagem de voz: baixa da Meta, transcreve e entrega ao Paolito como se fosse texto.
// Segredo: OPENAI_API_KEY. Se faltar a chave ou algo falhar, devolve null e o Paolito pede para escrever.
async function transcreverAudio(msg: any): Promise<string | null> {
  try {
    const chaveAI = env('OPENAI_API_KEY');
    const m = msg.audio;
    if (!chaveAI || !m?.id) return null;
    const auth = { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}` };
    const meta = await fetch(`${GRAPH}/${m.id}`, { headers: auth });
    if (!meta.ok) throw new Error('meta audio ' + meta.status);
    const info = await meta.json();
    if (!info?.url) throw new Error('meta sem url do audio');
    const arq = await fetch(info.url, { headers: auth });
    if (!arq.ok) throw new Error('download audio ' + arq.status);
    const bytes = new Uint8Array(await arq.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) throw new Error('audio grande demais (' + bytes.length + ')');
    const mime = String(info.mime_type || m.mime_type || 'audio/ogg').split(';')[0].trim();
    const ext = EXT_MIDIA[mime] || 'ogg';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `audio.${ext}`);
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'pt');
    form.append('prompt', 'Pedido de pizzaria por WhatsApp. Sabores: marguerita, calabresa, portuguesa, frango com catupiry, frango ao milho, quatro queijos, camarao, morango com chocolate. Tamanhos: pequena, media, grande. Entrega, retirada ou drive-thru. Pix, cartao, dinheiro, troco. Confirmacoes curtas: sim, certinho, ta certinho, ok, okay, isso, isso mesmo, pode ser, ta certo, tudo certo, confirmo, fechado, beleza, pode mandar.');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${chaveAI}` }, body: form });
    if (!r.ok) throw new Error('openai ' + r.status + ' ' + (await r.text()).slice(0, 150));
    const j = await r.json();
    let t = String(j?.text ?? '').trim();
    // confirmacoes curtas faladas que a transcricao costuma errar (ex.: "certinho" virou "ativo")
    const so = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, '').trim();
    if (/^(ativo|ativa|certino|certinha|sertinho|sertino|certim|certinhu)$/.test(so)) t = 'certinho';
    if (/^(o k|o ke|oque|oquei|okey|okei|okay|oks|o kei|o quei|ok ok|o k o k)$/.test(so)) t = 'ok';
    if (/^(sin|sim sim|sins|sim senhor)$/.test(so)) t = 'sim';
    console.log('AUDIO transcrito', String(msg.from).slice(-4), bytes.length + 'B', t.length + ' letras');
    return t || null;
  } catch (e) { console.error('falha ao transcrever audio', String((e as Error).message).slice(0, 200)); return null; }
}

// ---------- PAOLITO (robo de pedidos com IA) ----------
// Pergunta ao Paolito se ele atende este numero. Se nao atende (desligado / fora da lista de teste / erro), devolve null
// e o robo de sempre segue normalmente.
async function tentarPaolito(msg: any, texto: string, nome: string | null, origem: string | null): Promise<string | null> {
  try {
    // registra a mensagem do cliente (abre a janela de 24h dos avisos e aparece no painel); se for repetida (o WhatsApp reenvia quando demora), ignora
    try {
      const nova = await rpc('paolito_registrar_entrada', { p_loja: LOJA, p_telefone: msg.from, p_texto: texto, p_wa_id: msg.id, p_nome: nome });
      if (nova === 'inativo') return null;                       // o Paolito nao atende este numero: segue o robo de sempre
      if (nova === 'repetida') { console.log('paolito: mensagem repetida ignorada', String(msg.id).slice(-8)); return 'paolito_repetida'; }
    } catch (e) { console.error('paolito_registrar_entrada falhou (segue sem registrar)', String((e as Error).message).slice(0, 150)); }
    // mensagem de voz: so transcreve se o Paolito atende este numero (nao gasta a toa); se falhar, o Paolito pede para escrever
    if (msg.type === 'audio') { const t = await transcreverAudio(msg); if (t) texto = t; }
    // PEDIU GENTE (texto ou audio ja transcrito): poe a conversa na fila do Painel (faixa + som), como o robo antigo fazia
    try {
      const tn = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/\b(atendente|atendimento|humano|reclam\w*|gerente|dono|falar com (uma )?(pessoa|alguem|gente|voces)|problema com (o |meu )?pedido)\b/.test(tn)) {
        await rpc('paolito_chamar_equipe', { p_loja: LOJA, p_telefone: msg.from, p_motivo: 'pediu atendente (Paolito)' });
        console.log('PAOLITO chamar equipe:', String(msg.from).slice(-4));
      }
    } catch (e) { console.error('paolito_chamar_equipe falhou (segue normal)', String((e as Error).message).slice(0, 150)); }
    const r = await fetch(`${env('SUPABASE_URL')}/functions/v1/paolito`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, 'x-robo-chave': env('ROBO_CHAVE') },
      body: JSON.stringify({ telefone: msg.from, texto, tipo: msg.type, nome, origem }),
    });
    if (!r.ok) { console.error('paolito http', r.status); return null; }
    const j = await r.json();
    if (!j?.ativo) return null;
    for (const m of (j.mensagens ?? []) as string[]) {
      if (!m) continue;
      const e = await enviar(msg.from, m);
      if (e.ok) await rpc('bot_registrar_saida', { p_loja: LOJA, p_telefone: msg.from, p_texto: m, p_wa_id: e.id ?? null, p_acao: j.acao ?? 'paolito' });
      else console.error('paolito: falha ao responder', e.erro);
    }
    return j.acao ?? 'paolito';
  } catch (e) { console.error('paolito falhou (segue com o robo de sempre)', String((e as Error).message).slice(0, 200)); return null; }
}

// ---------- mensagem de cliente ----------
async function tratarMensagem(msg: any, nome: string | null): Promise<string> {
  let texto = '';
  if (msg.type === 'text') texto = msg.text?.body ?? '';
  else if (msg.type === 'button') texto = msg.button?.text ?? '';
  else if (msg.type === 'interactive') texto = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '';
  else texto = `[${msg.type}]`;                       // audio, imagem, figurinha...

  // anuncio "enviar mensagem" da Meta: ela avisa de qual anuncio o cliente veio
  const ref = msg.referral;
  const origem = ref ? ['anuncio-meta', ref.source_type, ref.headline || ref.source_id].filter(Boolean).join(' / ') : null;

  // PAOLITO: se estiver ligado para este numero, ele cuida da conversa inteira
  { const pa = await tentarPaolito(msg, texto, nome, origem); if (pa) return pa; }

  // TRAVA (Parte BH): numero bloqueado (ex.: atendimento automatico da Claro) ou passou do limite de respostas do dia = o robo fica quieto
  try {
    const trava = await rpc('bot_trava', { p_loja: LOJA, p_telefone: msg.from, p_max: 15 });
    if (trava === 'bloqueado' || trava === 'limite') { console.log('TRAVA', trava, String(msg.from).slice(-4)); return 'trava_' + trava; }
  } catch (e) { console.error('falha na trava (segue sem ela)', String((e as Error).message).slice(0, 200)); }

  const r = await rpc('bot_processar_entrada', { p_loja: LOJA, p_telefone: msg.from, p_texto: texto, p_wa_id: msg.id, p_nome: nome, p_origem: origem });
  // guarda a foto/audio/arquivo do cliente para a equipe ver (se falhar, so anota no log: a resposta ao cliente segue)
  if (['image', 'audio', 'video', 'document'].includes(String(msg.type))) {
    try { await guardarMidia(msg); } catch (e) { console.error('falha ao guardar midia', String((e as Error).message).slice(0, 200)); }
  }
  // resposta com foto (ex.: preco de um sabor). Se a foto falhar, manda so o texto.
  if (r?.imagem?.url) {
    const legenda = String(r.imagem.legenda ?? '');
    let e = await enviarImagem(msg.from, String(r.imagem.url), legenda);
    if (!e.ok) { console.error('falha na foto, mandando so texto', e.erro); e = await enviar(msg.from, legenda); }
    if (e.ok) await rpc('bot_registrar_saida', { p_loja: LOJA, p_telefone: msg.from, p_texto: legenda, p_wa_id: e.id ?? null, p_acao: r.acao });
    else console.error('falha ao responder', e.erro);
  }
  for (const m of (r?.mensagens ?? []) as string[]) {
    if (!m) continue;
    const e = await enviar(msg.from, m);
    if (e.ok) await rpc('bot_registrar_saida', { p_loja: LOJA, p_telefone: msg.from, p_texto: m, p_wa_id: e.id ?? null, p_acao: r.acao });
    else console.error('falha ao responder', e.erro);
  }
  return r?.acao ?? '';
}

// ---------- aviso por MODELO aprovado (Utilidade): vale mesmo com a janela de 24h fechada ----------
// tipo da fila -> nome do modelo cadastrado na Meta. So envia se o modelo existir/estiver aprovado; senao cai em "sem janela" como antes.
const MODELO_AVISO: Record<string, string> = {
  confirmado: 'pedido_confirmado', pronto_retirar: 'pedido_pronto_retirada', pronto_drive: 'pedido_pronto_drive',
  saiu_entrega: 'pedido_saiu_entrega', cancelado: 'pedido_cancelado',
};
async function enviarModelo(para: string, modelo: string, textos: string[]): Promise<Envio> {
  try {
    const r = await fetch(`${GRAPH}/${env('WHATSAPP_PHONE_ID')}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: paraE164(para), type: 'template',
        template: { name: modelo, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: textos.map((t) => ({ type: 'text', text: String(t) })) }] } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: j?.messages?.[0]?.id };
    const code = j?.error?.code;
    return { ok: false, erro: `modelo ${modelo} ${code ?? r.status}: ${j?.error?.message ?? ''}`.slice(0, 300) };
  } catch (e) {
    return { ok: false, erro: 'rede: ' + String((e as Error).message).slice(0, 200) };
  }
}

// ---------- avisos do pedido (fila) ----------
async function processarFila(): Promise<{ enviados: number; sem_janela: number; falhas: number }> {
  const out = { enviados: 0, sem_janela: 0, falhas: 0 };
  const itens: any[] = (await rpc('bot_pegar_fila', { p_limite: 20 })) ?? [];
  for (const it of itens) {
    let e: Envio;
    if (!it.janela_aberta) {
      const modelo = MODELO_AVISO[it.tipo];
      if (!modelo || !it.numero) {
        await rpc('bot_fila_resultado', { p_id: it.id, p_ok: false, p_erro: 'cliente sem janela de 24h', p_sem_janela: true });
        out.sem_janela++;
        continue;
      }
      const nome = String(it.nome || '').trim() || 'cliente';
      e = await enviarModelo(it.telefone, modelo, [nome, String(it.numero)]);
      if (!e.ok) {   // modelo ainda nao aprovado / erro: fica como "sem janela" (como era antes), sem derrubar nada
        await rpc('bot_fila_resultado', { p_id: it.id, p_ok: false, p_erro: e.erro ?? 'erro no modelo', p_sem_janela: true });
        out.sem_janela++;
        continue;
      }
    } else {
      e = await enviar(it.telefone, it.texto);
    }
    if (e.ok) {
      await rpc('bot_registrar_saida', { p_loja: it.loja_id, p_telefone: it.telefone, p_texto: it.texto, p_wa_id: e.id ?? null, p_acao: 'aviso_' + it.tipo });
      await rpc('bot_fila_resultado', { p_id: it.id, p_ok: true });
      out.enviados++;
    } else {
      await rpc('bot_fila_resultado', { p_id: it.id, p_ok: false, p_erro: e.erro ?? 'erro', p_sem_janela: !!e.semJanela });
      if (e.semJanela) out.sem_janela++; else out.falhas++;
    }
  }
  return out;
}

// ---------- nota fiscal (Focus NFe) ----------
const FOCUS_BASE: Record<string, string> = { homologacao: 'https://homologacao.focusnfe.com.br', producao: 'https://api.focusnfe.com.br' };
const focusToken = (amb: string): string => (amb === 'producao' ? env('FOCUS_TOKEN_PRODUCAO') : env('FOCUS_TOKEN_HOMOLOGACAO'));

type RespostaFocus = { http: number; j: any };
async function focusChamar(base: string, metodo: string, caminho: string, token: string, corpo?: unknown): Promise<RespostaFocus> {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { Authorization: 'Basic ' + btoa(token + ':'), 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = { mensagem: t.slice(0, 200) }; }
  return { http: r.status, j };
}

type ResultadoNota = { status: 'autorizada' | 'erro' | 'pendente' | 'cancelada'; numero?: string; serie?: string; chave?: string; url_danfe?: string; url_xml?: string; qrcode?: string; consulta?: string; protocolo?: string; mensagem?: string };

function msgErro(j: any, http: number): string {
  const lista = Array.isArray(j?.erros) ? j.erros.map((e: any) => e?.mensagem).filter(Boolean).join('; ') : '';
  return String(j?.mensagem || j?.mensagem_sefaz || lista || ('erro ' + http)).slice(0, 400);
}

function interpretarNota(base: string, j: any): ResultadoNota {
  const abs = (c?: string) => (c ? (c.startsWith('/') ? base + c : c) : undefined);
  switch (j?.status) {
    case 'autorizado':
      console.log('FOCUS campos da nota autorizada: ' + Object.keys(j).join(','));
      return { status: 'autorizada', numero: j.numero ? String(j.numero) : undefined, serie: j.serie ? String(j.serie) : undefined, chave: j.chave_nfe,
               url_danfe: abs(j.caminho_danfe || j.url_danfe), url_xml: abs(j.caminho_xml_nota_fiscal), mensagem: j.mensagem_sefaz || 'Autorizada',
               qrcode: j.qrcode_url ? String(j.qrcode_url) : undefined, consulta: (j.url_consulta_nf || j.url_consulta) ? String(j.url_consulta_nf || j.url_consulta) : undefined,
               protocolo: (j.protocolo || j.numero_protocolo || j.protocolo_nfe) ? String(j.protocolo || j.numero_protocolo || j.protocolo_nfe) : undefined };
    case 'cancelado': return { status: 'cancelada', mensagem: 'Nota cancelada' };
    case 'erro_autorizacao': case 'denegado':
      return { status: 'erro', mensagem: [j.status_sefaz, j.mensagem_sefaz].filter(Boolean).join(' ').slice(0, 400) || 'A SEFAZ recusou a nota' };
    default: return { status: 'pendente', mensagem: 'Focus ainda processando (' + (j?.status ?? '?') + ')' };
  }
}

// Envia a nota. Se a resposta se perder (rede, "referencia ja usada"), PERGUNTA a Focus antes de tentar de novo:
// assim uma nota ja autorizada nunca vira duas.
async function emitirNaFocus(amb: string, ref: string, payload: unknown, token: string): Promise<ResultadoNota> {
  const base = FOCUS_BASE[amb];
  let resp: RespostaFocus | null = null;
  try { resp = await focusChamar(base, 'POST', `/v2/nfce?ref=${encodeURIComponent(ref)}`, token, payload); } catch { resp = null; }
  if (resp && resp.http >= 200 && resp.http < 300 && resp.j?.status) return interpretarNota(base, resp.j);
  if (resp && (resp.http === 401 || resp.http === 403)) return { status: 'erro', mensagem: 'A Focus recusou o token (confira o segredo e o ambiente)' };
  let cons: RespostaFocus | null = null;
  try { cons = await focusChamar(base, 'GET', `/v2/nfce/${encodeURIComponent(ref)}`, token); } catch { cons = null; }
  if (cons && cons.http === 200 && cons.j?.status) return interpretarNota(base, cons.j);
  if (resp && resp.http >= 400 && resp.http < 500) return { status: 'erro', mensagem: msgErro(resp.j, resp.http) };
  return { status: 'pendente', mensagem: 'Sem resposta da Focus, vou tentar de novo' };
}

async function processarFiscal(): Promise<{ autorizadas: number; erros: number; pendentes: number; aguardando: number }> {
  const out = { autorizadas: 0, erros: 0, pendentes: 0, aguardando: 0 };
  const itens: any[] = (await rpc('fiscal_pegar_pendentes', { p_limite: 10 })) ?? [];
  for (const it of itens) {
    const m = await rpc('fiscal_montar_payload', { p_nota_id: it.id });
    if (!m?.ok) {
      if (m?.aguardando) { await rpc('fiscal_resultado', { p_id: it.id, p_status: 'aguardando', p_mensagem: m.erro }); out.aguardando++; }
      else { await rpc('fiscal_resultado', { p_id: it.id, p_status: 'erro', p_mensagem: m?.erro ?? 'Nao consegui montar a nota' }); out.erros++; }
      continue;
    }
    const token = focusToken(m.ambiente);
    if (!token) {
      await rpc('fiscal_resultado', { p_id: it.id, p_status: 'erro', p_mensagem: `Falta cadastrar o token da Focus (${m.ambiente}) nos segredos do Supabase` });
      out.erros++; continue;
    }
    const r = await emitirNaFocus(m.ambiente, m.ref, m.payload, token);
    await rpc('fiscal_resultado', { p_id: it.id, p_status: r.status, p_numero: r.numero ?? null, p_serie: r.serie ?? null, p_chave: r.chave ?? null,
                                    p_url_danfe: r.url_danfe ?? null, p_url_xml: r.url_xml ?? null, p_mensagem: r.mensagem ?? null, p_payload: m.payload });
    if (r.status === 'autorizada') {
      // dados do QR Code para o cupom impresso no caixa (se a Parte BS ainda nao foi instalada, so avisa no log)
      try { await rpc('fiscal_guardar_extra', { p_id: it.id, p_qrcode: r.qrcode ?? null, p_consulta: r.consulta ?? null, p_protocolo: r.protocolo ?? null }); }
      catch (e) { console.error('fiscal_guardar_extra falhou (Parte BS instalada?)', e); }
    }
    if (r.status === 'autorizada') out.autorizadas++; else if (r.status === 'erro') out.erros++; else out.pendentes++;
  }
  return out;
}

// ---------- resposta de uma pessoa, pelo painel ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const jsonCors = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// chama uma funcao do banco COMO a pessoa logada (o banco confere se ela e da loja)
async function rpcComoUsuario(nome: string, corpo: unknown, jwt: string): Promise<any> {
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`banco (${nome}): ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function responderPeloPainel(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return jsonCors({ ok: false, erro: 'Entre de novo no painel.' }, 401);
  let b: any;
  try { b = await req.json(); } catch { return jsonCors({ ok: false, erro: 'Pedido inválido.' }, 400); }
  const texto = String(b?.texto ?? '').trim();
  const tel = String(b?.telefone ?? '');
  if (!tel || !texto || texto.length > 1500) return jsonCors({ ok: false, erro: 'Escreva a mensagem (até 1500 letras).' }, 400);

  let prep: any;
  try { prep = await rpcComoUsuario('bot_preparar_resposta', { p_loja: LOJA, p_telefone: tel }, jwt); }
  catch (e) { console.error('painel: sem permissao', (e as Error).message); return jsonCors({ ok: false, erro: 'Sem permissão. Entre de novo no painel.' }, 403); }
  if (!prep?.ok) return jsonCors({ ok: false, erro: prep?.erro ?? 'Conversa não encontrada.' }, 404);
  if (!prep.janela_aberta) {
    return jsonCors({ ok: false, sem_janela: true, erro: 'Já passaram 24 horas desde a última mensagem do cliente. O WhatsApp só deixa responder quando ele escreve de novo.' }, 409);
  }

  const e = await enviar(prep.telefone, texto);
  if (!e.ok) {
    console.error('painel: falha ao enviar', e.erro);
    return jsonCors({ ok: false, sem_janela: !!e.semJanela, erro: e.semJanela ? 'O WhatsApp não deixou enviar: passou das 24 horas.' : 'O WhatsApp recusou o envio. Tente de novo em instantes.' }, 502);
  }
  try {
    await rpc('bot_registrar_saida', { p_loja: LOJA, p_telefone: prep.telefone, p_texto: texto, p_wa_id: e.id ?? null, p_acao: 'humano_painel' });
    await rpc('bot_humano_respondeu', { p_loja: LOJA, p_telefone: prep.telefone });
  } catch (err) { console.error('painel: enviou, mas nao anotou', (err as Error).message); }
  return jsonCors({ ok: true });
}

// ---------- porta de entrada ----------
export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 0) a equipe respondendo um cliente pelo painel (login da equipe; nada a ver com a Meta)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'POST' && url.searchParams.get('acao') === 'responder' && !req.headers.get('x-hub-signature-256')) {
    return responderPeloPainel(req);
  }

  // 1) o banco / agendador pedindo para enviar os avisos pendentes
  const chaveRobo = req.headers.get('x-robo-chave');
  if (chaveRobo !== null) {
    const esperada = env('ROBO_CHAVE');
    if (!esperada || !iguais(chaveRobo, esperada)) return new Response('nao autorizado', { status: 401 });
    let acao = url.searchParams.get('acao') ?? '';
    if (!acao) { try { const b: any = await req.clone().json(); acao = b?.table === 'notas_fiscais' ? 'fiscal' : b?.table === 'bot_fila' ? 'fila' : ''; } catch { /* sem corpo */ } }
    const res: any = { ok: true };
    let falhou = false;
    if (acao === '' || acao === 'fila' || acao === 'tudo') { try { Object.assign(res, await processarFila()); } catch (e) { falhou = true; console.error(e); } }
    if (acao === '' || acao === 'fiscal' || acao === 'tudo') { try { res.fiscal = await processarFiscal(); } catch (e) { falhou = true; console.error(e); } }
    return falhou ? new Response('erro', { status: 500 }) : Response.json(res);
  }

  // 2) a Meta confirmando o endereco (so na hora de ligar o webhook)
  if (req.method === 'GET') {
    const modo = url.searchParams.get('hub.mode');
    if (modo === 'subscribe') {
      const tok = url.searchParams.get('hub.verify_token') ?? '';
      const esperado = env('WHATSAPP_VERIFY_TOKEN');
      if (esperado && iguais(tok, esperado)) return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
      return new Response('token invalido', { status: 403 });
    }
    return Response.json({ ok: true, servico: 'whatsapp-robo gran-paolo' });
  }

  // 3) mensagens de clientes (a Meta assina cada chamada)
  if (req.method === 'POST') {
    const corpo = await req.text();
    if (!(await assinaturaValida(corpo, req.headers.get('x-hub-signature-256')))) return new Response('assinatura invalida', { status: 401 });
    let j: any;
    try { j = JSON.parse(corpo); } catch { return new Response('json invalido', { status: 400 }); }
    let falhou = false;
    for (const entry of j?.entry ?? []) {
      for (const ch of entry?.changes ?? []) {
        const v = ch?.value;
        for (const st of v?.statuses ?? []) {                              // recibos de entrega: anota so os que falharam (aparece em Logs)
          if (st?.status === 'failed') console.error('ENTREGA FALHOU', st?.recipient_id, JSON.stringify(st?.errors ?? []).slice(0, 400));
        }
        if (!v?.messages) continue;                                        // recibos de entrega etc.
        if (env('WHATSAPP_PHONE_ID') && v?.metadata?.phone_number_id !== env('WHATSAPP_PHONE_ID')) continue;
        const nomes: Record<string, string> = {};
        for (const c of v.contacts ?? []) if (c?.wa_id) nomes[c.wa_id] = c?.profile?.name ?? '';
        for (const msg of v.messages) {
          try { await tratarMensagem(msg, nomes[msg.from] || null); }
          catch (e) { falhou = true; console.error('erro na mensagem', msg?.id, (e as Error).message); }
        }
      }
    }
    return new Response(falhou ? 'erro' : 'ok', { status: falhou ? 500 : 200 });   // 500 = a Meta tenta de novo
  }
  return new Response('metodo nao permitido', { status: 405 });
}

if ((globalThis as any).Deno?.serve) (globalThis as any).Deno.serve(handler);
