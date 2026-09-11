/**
 * 納品システム Worker v4.0
 * 追加: 選定機能 / 動画対応 / システム設定
 */

// ─── Google Drive ────────────────────────────────────

async function getAccessToken(env, readonly=false) {
  const cacheKey=`gtoken:${readonly?'ro':'rw'}`
  try{const c=await env.ALBUMS.get(cacheKey,'json');if(c&&c.exp>Date.now()+60000)return c.tok}catch{}
  const scope=readonly?'https://www.googleapis.com/auth/drive.readonly':'https://www.googleapis.com/auth/drive'
  const now=Math.floor(Date.now()/1000)
  const b64=o=>btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
  const hdr={alg:'RS256',typ:'JWT'},pay={iss:env.GD_CLIENT_EMAIL,scope,aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}
  const unsigned=`${b64(hdr)}.${b64(pay)}`
  const pem=env.GD_PRIVATE_KEY.replace(/\\n/g,'\n')
  const body=pem.replace(/-----BEGIN.*?-----/g,'').replace(/-----END.*?-----/g,'').replace(/\s/g,'')
  const der=Uint8Array.from(atob(body),c=>c.charCodeAt(0))
  const key=await crypto.subtle.importKey('pkcs8',der.buffer,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign'])
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned))
  const sigB64=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
  const jwt=`${unsigned}.${sigB64}`
  const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`})
  const d=await res.json()
  if(!d.access_token)throw new Error(`Token: ${JSON.stringify(d)}`)
  await env.ALBUMS.put(cacheKey,JSON.stringify({tok:d.access_token,exp:Date.now()+50*60*1000}),{expirationTtl:3000})
  return d.access_token
}

async function driveReq(path,token){
  const sep=path.includes('?')?'&':'?'
  const res=await fetch(`https://www.googleapis.com/drive/v3${path}${sep}supportsAllDrives=true&includeItemsFromAllDrives=true`,{headers:{Authorization:`Bearer ${token}`}})
  if(!res.ok)throw new Error(`Drive ${res.status}: ${await res.text()}`)
  return res.json()
}

// Drive files.list はnextPageTokenが続く限り1ページ（最大1000件）ずつしか返さないため、
// 全件取得したい呼び出し元はこの関数を通す。fieldsにnextPageTokenを含め忘れると
// 次ページの合図が返らず1ページで止まるので、必ずfields側でも付与する。
async function driveListAllPages(q,fields,token){
  const fieldsWithPageToken=fields.includes('nextPageToken')?fields:`nextPageToken,${fields}`
  let files=[],pageToken=null
  for(let i=0;i<50;i++){
    const pt=pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:''
    const d=await driveReq(`/files?q=${q}&fields=${encodeURIComponent(fieldsWithPageToken)}&orderBy=name&pageSize=1000${pt}`,token)
    files=files.concat(d.files||[])
    pageToken=d.nextPageToken||null
    if(!pageToken)return files
  }
  throw new Error('Drive pagination exceeded 50 pages')
}

async function listPhotos(folderId,token){
  const q=encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`)
  const f='files(id,name,size,thumbnailLink,createdTime,imageMediaMetadata(width,height,time))'
  return await driveListAllPages(q,f,token)
}

async function listVideos(folderId,token){
  const mimes=['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/x-matroska']
  const mimeQ=mimes.map(m=>`mimeType='${m}'`).join(' or ')
  const q=encodeURIComponent(`'${folderId}' in parents and (${mimeQ}) and trashed = false`)
  const f='files(id,name,size,mimeType,thumbnailLink,webViewLink)'
  return await driveListAllPages(q,f,token)
}

async function createFolder(name,parentId,token){
  const res=await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]})})
  if(!res.ok)throw new Error(`CreateFolder: ${await res.text()}`)
  return res.json()
}

async function deleteFile(fileId,token){
  const res=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})
  if(!res.ok){const body=await res.text().catch(()=>'');const e=new Error(`Delete: ${res.status} ${body}`);e.status=res.status;throw e}
}

// ─── 動画権限管理 ───────────────────────────────────

async function grantAnyoneRead(fileId,token){
  try{await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:'anyone',role:'reader'})})}catch{}
}

async function revokeAnyoneRead(fileId,token){
  try{
    const d=await driveReq(`/files/${fileId}/permissions?fields=permissions(id,type)`,token)
    const p=(d.permissions||[]).find(p=>p.type==='anyone')
    if(!p)return
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${p.id}?supportsAllDrives=true`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})
  }catch{}
}

async function syncVideoPerms(folderId,grant,token){
  const videos=await listVideos(folderId,token)
  await Promise.all(videos.map(v=>grant?grantAnyoneRead(v.id,token):revokeAnyoneRead(v.id,token)))
}

// ─── 期限切れ・非公開アルバムの動画アクセス取り消し ──────────────
// 動画1本の公開を取り消す。成功/失敗と、消費したDrive呼び出し回数を返す（エラーはログに残す）
async function revokeVideoAccess(fileId,token){
  let callsUsed=0
  try{
    const d=await driveReq(`/files/${fileId}/permissions?fields=permissions(id,type)`,token)
    callsUsed++
    const p=(d.permissions||[]).find(p=>p.type==='anyone')
    if(!p)return{ok:true,callsUsed}
    const res=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${p.id}?supportsAllDrives=true`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})
    callsUsed++
    if(!res.ok)throw new Error(`revoke delete failed: ${res.status} ${await res.text()}`)
    return{ok:true,callsUsed}
  }catch(e){
    console.error(`revokeVideoAccess failed for ${fileId}`,e)
    return{ok:false,callsUsed}
  }
}

// アルバム1件ぶんの動画公開を、控え（gv:トークン:ファイルID）を頼りに取り消す。
// Driveへの呼び出し回数は呼び出し元と共有するbudgetオブジェクトで管理し、
// 予算が尽きたら取り消しきれなかった分の控えを残したまま打ち切る（次回の巡回で拾われる）。
// 戻り値のallClearは「このアルバムの動画公開を確認できる範囲で全部取り消せたか」を示す
// （アルバム削除など、取り消し切るまで先に進んではいけない処理から使う）。
const VIDEO_MIMES=['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/x-matroska']
async function sweepAlbumVideoGrants(env,token,folderId,at,budget){
  const prefix=`gv:${token}:`
  let fileIds
  try{
    const listed=await env.ALBUMS.list({prefix})
    fileIds=listed.keys.map(k=>k.name.slice(prefix.length))
  }catch(e){console.error(`list gv markers failed for ${token}`,e);return{allClear:false}}

  // 控えが1件も無い場合は、控えの仕組みより前から公開されたままの動画が無いか、
  // 一度だけDriveに直接問い合わせて確認する（fields内のpermissionsを使い、動画1本ずつの個別確認は行わない）
  if(fileIds.length===0){
    if(budget.remaining<1)return{allClear:false}
    let videos
    try{
      const mimeQ=VIDEO_MIMES.map(m=>`mimeType='${m}'`).join(' or ')
      const q=encodeURIComponent(`'${folderId}' in parents and (${mimeQ}) and trashed = false`)
      videos=await driveListAllPages(q,'files(id,permissions(type))',at)
      budget.remaining--
    }catch(e){console.error(`backfill video list failed for ${token}`,e);return{allClear:false}}
    const publicIds=videos.filter(v=>(v.permissions||[]).some(p=>p.type==='anyone')).map(v=>v.id)
    if(publicIds.length===0)return{allClear:true}
    // 控えを全部書けたときだけ先へ進む。一部しか書けなければ何もせず次回に委ねる
    let allWritten=true
    for(const id of publicIds){
      try{await env.ALBUMS.put(`gv:${token}:${id}`,JSON.stringify({grantedAt:new Date().toISOString(),backfilled:true}))}
      catch(e){console.error(`backfill marker write failed ${token}:${id}`,e);allWritten=false;break}
    }
    if(!allWritten)return{allClear:false}
    fileIds=publicIds
  }

  let allClear=true
  for(const fileId of fileIds){
    if(budget.remaining<2){allClear=false;break} // 1本あたり最大2回分の余裕が無ければ打ち切り。控えは残る
    const{ok,callsUsed}=await revokeVideoAccess(fileId,at)
    budget.remaining-=callsUsed
    if(ok){
      try{await env.ALBUMS.delete(`gv:${token}:${fileId}`)}
      catch(e){console.error(`gv marker delete failed ${token}:${fileId}`,e);allClear=false}
    }else{
      allClear=false
      // 失敗した場合は控えをそのまま残す（次回の巡回で再試行される）
    }
  }
  return{allClear}
}

function isAlbumActive(album){
  if(album.published===false)return false
  if(album.expiresAt&&new Date(album.expiresAt)<new Date())return false
  return true
}

// ─── システム設定・フラグ定義 ────────────────────────

const DEFAULT_FLAG_DEFS=[
  {key:'favorite',label:'⭐ お気に入り',max:0},
  {key:'cover',label:'📖 表紙',max:1},
  {key:'page',label:'📄 中ページ',max:10}
]

const DEFAULT_SYSTEM_SETTINGS={flagDefs:DEFAULT_FLAG_DEFS,venueName:'ALCYONE COURT. SANO',accentColor:'#8b7a38',wifiSsid:'',wifiPassword:''}
async function getSystemSettings(env){
  const s=await env.ALBUMS.get('system:settings','json')
  return{...DEFAULT_SYSTEM_SETTINGS,...s}
}

async function getEffectiveFlagDefs(env,album){
  if(album?.flagDefs)return album.flagDefs
  const sys=await getSystemSettings(env)
  return sys.flagDefs||DEFAULT_FLAG_DEFS
}

// ─── ユーティリティ ─────────────────────────────────

function genToken(n=8){const c='abcdefghijkmnpqrstuvwxyz23456789';return Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b=>c[b%c.length]).join('')}
function genSessionToken(){return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('')}
function genSelectToken(){return'sel_'+Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b=>'abcdefghijkmnpqrstuvwxyz23456789'[b%32]).join('')}
function fmtSize(b){if(!b)return'0 B';if(b>=1e9)return`${(b/1e9).toFixed(1)} GB`;if(b>=1e6)return`${(b/1e6).toFixed(1)} MB`;return`${(b/1e3).toFixed(0)} KB`}
function buildFolderName(name){return name}
function normalizeExpiresAt(dateStr){if(!dateStr)return null;if(dateStr.includes('T'))return dateStr;return`${dateStr}T23:59:59+09:00`}
async function sha256hex(str){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')}
async function hashPassword(password){const salt=Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('');const hash=await sha256hex(salt+password);return`${salt}:${hash}`}
async function verifyPassword(input,stored){if(!stored)return false;if(stored.includes(':')){const[salt,hash]=stored.split(':');return await sha256hex(salt+input)===hash};if(stored.length===64&&/^[0-9a-f]+$/.test(stored))return await sha256hex(input)===stored;return input===stored}

// ─── セッション管理 ─────────────────────────────────

const SESSION_TTL=24*60*60
async function createSession(env){const t=genSessionToken();await env.ALBUMS.put(`session:${t}`,JSON.stringify({expiresAt:Date.now()+SESSION_TTL*1000}),{expirationTtl:SESSION_TTL});return t}
async function validateSession(env,token){if(!token)return false;const d=await env.ALBUMS.get(`session:${token}`,'json');return d&&Date.now()<=d.expiresAt}
function getSessionToken(req){const auth=req.headers.get('Authorization')||'';if(auth.startsWith('Bearer '))return auth.slice(7);return new URL(req.url).searchParams.get('session')||null}
const isAdmin=async(req,env)=>validateSession(env,getSessionToken(req))

// ─── レート制限 ─────────────────────────────────────

const RATE_MAX=5,RATE_WINDOW=15*60*1000,RATE_TTL=15*60
async function checkRateLimit(env,ip){const d=await env.ALBUMS.get(`ratelimit:${ip}`,'json');if(!d||Date.now()-d.firstAt>RATE_WINDOW)return{limited:false};return{limited:d.count>=RATE_MAX}}
async function recordFailedLogin(env,ip){const key=`ratelimit:${ip}`;const d=await env.ALBUMS.get(key,'json');if(!d||Date.now()-d.firstAt>RATE_WINDOW){await env.ALBUMS.put(key,JSON.stringify({count:1,firstAt:Date.now()}),{expirationTtl:RATE_TTL})}else{await env.ALBUMS.put(key,JSON.stringify({count:d.count+1,firstAt:d.firstAt}),{expirationTtl:RATE_TTL})}}

// ─── KV ヘルパー ─────────────────────────────────────

const getAlbum=(env,t)=>env.ALBUMS.get(`album:${t}`,'json')
const saveAlbum=(env,t,a)=>env.ALBUMS.put(`album:${t}`,JSON.stringify(a))
async function listAlbums(env){const l=await env.ALBUMS.list({prefix:'album:'});return Promise.all(l.keys.map(async k=>{const d=await env.ALBUMS.get(k.name,'json');return{token:k.name.replace('album:',''),...d}}))}

// アルバム削除の実処理（単体削除・一括削除で共通。以前は同じ処理が2か所に書かれていた）。
// deleteDriveがtrueのときだけDrive側を触る：動画の共有取り消しが「取り消せたと確認できる」まで終わらせ、
// 続けてDriveのフォルダ削除が成功（またはすでに無い＝404）したことを確かめてから、
// アルバムの記録とそれに紐づく他の記録（選定など）を消す。どちらか確認できなければ記録は残し、
// 失敗として返す（控え・記録が残っているので次回また続きから試せる）。
// Driveへの呼び出し回数はatとbudgetを呼び出し元と共有し、単体・一括どちらでも上限を超えないようにする。
async function deleteAlbumFully(env,token,deleteDrive,at,budget){
  const album=await getAlbum(env,token)
  if(!album)return{ok:true} // 既に存在しない場合は成功扱い（べき等）
  if(deleteDrive&&album.folderId){
    const{allClear}=await sweepAlbumVideoGrants(env,token,album.folderId,at,budget)
    if(!allClear)return{ok:false,name:album.name,reason:'動画の共有取り消しを確認できませんでした。もう一度お試しください。'}
    try{
      await deleteFile(album.folderId,at)
    }catch(e){
      if(e.status!==404){
        console.error(`album folder delete failed ${token}`,e)
        return{ok:false,name:album.name,reason:'Driveのフォルダ削除に失敗しました。もう一度お試しください。'}
      }
      // 404 = すでにDrive側に無い。成功として扱う
    }
  }
  if(album.selectToken)await env.ALBUMS.delete(`select:${album.selectToken}`)
  await env.ALBUMS.delete(`album:${token}`)
  return{ok:true}
}

// ─── アルバム枚数・容量の記録（Driveへ都度問い合わせずに一覧表示するためのキャッシュ） ───
// 表紙未設定時の1枚目はlistPhotosの並び順（=一覧・管理画面での表示順）で決める
function computeAlbumCounts(photos){
  const totalSize=photos.reduce((s,f)=>s+parseInt(f.size||0),0)
  return{photoCount:photos.length,totalSize,coverFallbackId:photos[0]?.id||null}
}
// 書き戻し直前にアルバムを再読込し、数えた4項目だけを重ねる（他タブでの編集を巻き戻さないため）
async function persistAlbumCounts(env,token,counts){
  const fresh=await getAlbum(env,token)
  if(!fresh)return
  await saveAlbum(env,token,{...fresh,photoCount:counts.photoCount,totalSize:counts.totalSize,coverFallbackId:counts.coverFallbackId,countedAt:new Date().toISOString()})
}
// カバー写真の参照切れ自己修復（削除済みファイルを指したままにしない）。カウント項目とは別の独立した書き込みとして行う
async function healDanglingCover(env,token,album,photos){
  const coverValid=!album.coverId||photos.some(p=>p.id===album.coverId)
  const coverMobileValid=!album.coverIdMobile||photos.some(p=>p.id===album.coverIdMobile)
  if(coverValid&&coverMobileValid)return{coverId:album.coverId||null,coverIdMobile:album.coverIdMobile||null}
  const fresh=await getAlbum(env,token)
  const coverId=coverValid?(fresh?fresh.coverId:album.coverId)||null:null
  const coverIdMobile=coverMobileValid?(fresh?fresh.coverIdMobile:album.coverIdMobile)||null:null
  if(fresh)await saveAlbum(env,token,{...fresh,coverId,coverIdMobile})
  return{coverId,coverIdMobile}
}
// アルバム1件をDriveから数え直して記録を更新する（一覧のstale分・個別オープン時の両方から呼ばれる）
async function recountAlbum(env,token,at){
  const album=await getAlbum(env,token)
  if(!album)return null
  const photos=await listPhotos(album.folderId,at)
  const counts=computeAlbumCounts(photos)
  await persistAlbumCounts(env,token,counts)
  const cover=await healDanglingCover(env,token,album,photos)
  return{...counts,...cover}
}
const getSelect=(env,t)=>env.ALBUMS.get(`select:${t}`,'json')
const saveSelect=(env,t,d)=>env.ALBUMS.put(`select:${t}`,JSON.stringify(d))

// ─── レスポンス ─────────────────────────────────────

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}
const jsonR=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}})
const errR=(m,s=400)=>jsonR({error:m},s)
// HTMLに直接埋め込む値のエスケープ（アルバム名などに &<>"' が含まれても表示が崩れないように）
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// お客様ページに出すURLの検証。javascript: 等が混ざらないよう、安全なスキームだけ通す
function safePublicUrl(u){
  const v=(u||'').trim()
  if(!v)return ''
  return /^(https?:\/\/|mailto:|tel:)/i.test(v)?v:''
}

// ─── メインハンドラ ──────────────────────────────────

export default {
  async fetch(req,env,ctx){
    const url=new URL(req.url),path=url.pathname
    if(req.method==='OPTIONS')return new Response(null,{headers:CORS})
    const clientIP=req.headers.get('CF-Connecting-IP')||'unknown'

    try{
      // OGP共有URL
      const shareMatch=path.match(/^\/a\/([a-z0-9]+)$/)
      if(shareMatch&&req.method==='GET'){
        const t=shareMatch[1],album=await getAlbum(env,t)
        const active=!!album&&isAlbumActive(album)
        // 期限切れ・非公開なら画像も名前も出さない。パスワード付きアルバムはさらに名前も出さない
        const showName=active&&!album.password
        const albumUrl=escapeHtml(`${env.SITE_URL}/album.html?token=${t}`),title=escapeHtml(showName?album.name:'フォトギャラリー')
        const imageUrl=escapeHtml(active&&album.coverId?`${env.SITE_URL}/api/og-image/${t}`:'')
        const ogImage=imageUrl?`<meta property="og:image" content="${imageUrl}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${imageUrl}">`:'<meta name="twitter:card" content="summary">'
        const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} | Alcyone PhotoShare</title><meta property="og:title" content="${title}"><meta property="og:type" content="website"><meta property="og:url" content="${albumUrl}"><meta property="og:site_name" content="Alcyone PhotoShare"><meta name="twitter:title" content="${title}">${ogImage}<meta http-equiv="refresh" content="0;url=${albumUrl}"></head><body><script>location.replace("${albumUrl}")</script></body></html>`
        return new Response(html,{headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-cache',...CORS}})
      }

      // OGP画像
      const ogImageMatch=path.match(/^\/api\/og-image\/([a-z0-9]+)$/)
      if(ogImageMatch&&req.method==='GET'){
        const t=ogImageMatch[1],album=await getAlbum(env,t)
        if(!album||!isAlbumActive(album))return errR('No image',404)
        if(!album.coverId)return errR('No image',404)
        const at=await getAccessToken(env,true)
        const meta=await driveReq(`/files/${album.coverId}?fields=thumbnailLink`,at)
        const thumbUrl=meta.thumbnailLink?.replace('=s220','=s1200')
        if(!thumbUrl)return errR('No thumbnail',404)
        const res=await fetch(thumbUrl),blob=await res.blob()
        return new Response(blob,{headers:{'Content-Type':res.headers.get('Content-Type')||'image/jpeg','Cache-Control':'public, max-age=86400',...CORS}})
      }

      // ログイン・ログアウト
      if(path==='/api/admin/login'&&req.method==='POST'){
        const{limited}=await checkRateLimit(env,clientIP)
        if(limited)return errR('Too many attempts. Wait 15 minutes.',429)
        const{token:inputToken}=await req.json()
        if(inputToken===env.ADMIN_SECRET){await env.ALBUMS.delete(`ratelimit:${clientIP}`);return jsonR({ok:true,session:await createSession(env)})}
        await recordFailedLogin(env,clientIP);return errR('Invalid token',401)
      }
      if(path==='/api/admin/logout'&&req.method==='POST'){const t=getSessionToken(req);if(t)await env.ALBUMS.delete(`session:${t}`);return jsonR({ok:true})}

      // ══ システム設定 ══════════════════════════════

      if(path==='/api/admin/settings'&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        return jsonR(await getSystemSettings(env))
      }
      if(path==='/api/admin/settings'&&req.method==='PATCH'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const body=await req.json()
        const current=await getSystemSettings(env)
        const updated={...current,...body}
        await env.ALBUMS.put('system:settings',JSON.stringify(updated))
        return jsonR({ok:true,settings:updated})
      }

      // ══ 管理者アルバムAPI ═════════════════════════

      if(path==='/api/admin/albums'&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const albums=await listAlbums(env)
        // 一覧表示はDriveへ問い合わせず、各アルバムに記録済みの枚数・容量・表紙候補をそのまま返す。
        // Cloudflareの1リクエストあたりのサブリクエスト上限に当たらないよう、アルバム件数分のDrive呼び出しはしない。
        const STALE_MS=6*60*60*1000,MAX_RECOUNT=8
        const now=Date.now()
        const stale=albums
          .filter(a=>!a.countedAt||now-new Date(a.countedAt).getTime()>STALE_MS)
          .sort((a,b)=>(a.countedAt?new Date(a.countedAt).getTime():0)-(b.countedAt?new Date(b.countedAt).getTime():0))
          .slice(0,MAX_RECOUNT)
        const recounted=new Map()
        if(stale.length){
          let at=null
          try{at=await getAccessToken(env,true)}catch(e){console.error('getAccessToken failed',e)}
          if(at){
            await Promise.all(stale.map(async a=>{
              try{recounted.set(a.token,await recountAlbum(env,a.token,at))}
              catch(e){console.error(`recount album ${a.token} failed`,e)}
            }))
          }
        }
        // ① 期限切れなのにまだ公開中のアルバムを閉じ、動画の公開も取り消す
        // ② 非公開・期限切れなのに動画の公開が残っているアルバムを片付ける（①で予算切れになった分の受け皿）
        // Driveへの呼び出しは①②合わせて上限を設け、上のカウント数え直し分の余地を残す。
        const REVOKE_BUDGET=40
        const budget={remaining:REVOKE_BUDGET}
        const toAutoClose=albums.filter(a=>a.published!==false&&a.expiresAt&&new Date(a.expiresAt)<new Date())
        const alreadyInactive=albums.filter(a=>!toAutoClose.includes(a)&&!isAlbumActive(a))
        const closedTokens=new Set()
        // 動画の取り消しにはDriveの書き込みトークンが要るが、取得に失敗してもアルバムを
        // 閉じる処理（KV書き込みのみ）自体は続行する。取り消しだけをスキップする。
        let videoAt=null
        if(toAutoClose.length||alreadyInactive.length){
          try{videoAt=await getAccessToken(env,false)}catch(e){console.error('getAccessToken (video revoke) failed',e)}
        }
        for(const a of toAutoClose){
          try{
            // 閉じる直前にもう一度読み直し、既に非公開・期限延長されていないか確かめる
            // （読んでいる間に別タブで期限が延ばされていた場合、古い内容で上書きしないため）
            const fresh=await getAlbum(env,a.token)
            if(!fresh)continue
            const stillExpired=fresh.published!==false&&fresh.expiresAt&&new Date(fresh.expiresAt)<new Date()
            if(!stillExpired)continue
            await saveAlbum(env,a.token,{...fresh,published:false,updatedAt:new Date().toISOString()})
            closedTokens.add(a.token)
          }catch(e){console.error(`auto-close album ${a.token} failed`,e);continue}
          if(videoAt&&budget.remaining>=1)await sweepAlbumVideoGrants(env,a.token,a.folderId,videoAt,budget)
        }
        if(videoAt){
          for(const a of alreadyInactive){
            if(budget.remaining<1)break
            await sweepAlbumVideoGrants(env,a.token,a.folderId,videoAt,budget)
          }
        }
        const enriched=albums.map(a=>{
          const r=recounted.get(a.token)
          const photoCount=r?r.photoCount:(a.photoCount??0)
          const totalSize=r?r.totalSize:(a.totalSize??0)
          const coverFallbackId=r?r.coverFallbackId:(a.coverFallbackId??null)
          const coverId=r?r.coverId:a.coverId
          const coverIdMobile=r?r.coverIdMobile:a.coverIdMobile
          const published=closedTokens.has(a.token)?false:a.published
          return{...a,published,count:photoCount,totalSize,totalSizeLabel:fmtSize(totalSize),coverId:coverId||coverFallbackId||null,coverIdMobile:coverIdMobile||null}
        })
        return jsonR({albums:enriched})
      }

      if(path==='/api/admin/albums'&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const{name,expiresAt,password,heroText,heroFont,allowCustomerUpload,allowVideoUpload,lang,siteTitle}=await req.json()
        if(!name)return errR('name required')
        const token=genToken()
        const at=await getAccessToken(env,false)
        const folder=await createFolder(buildFolderName(name),env.DRIVE_ROOT_FOLDER_ID,at)
        const album={name,folderId:folder.id,createdAt:new Date().toISOString(),expiresAt:normalizeExpiresAt(expiresAt),password:password?await hashPassword(password):null,published:true,heroText:heroText||'Photography',heroFont:heroFont||'josefin',allowCustomerUpload:!!allowCustomerUpload,allowVideoUpload:!!allowVideoUpload,lang:lang||'ja',siteTitle:siteTitle||null,photoCount:0,totalSize:0,coverFallbackId:null,countedAt:new Date().toISOString()}
        await saveAlbum(env,token,album)
        return jsonR({token,url:`${env.SITE_URL}/album.html?token=${token}`,folderId:folder.id,album})
      }

      const albumTokenMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)$/)

      if(albumTokenMatch&&req.method==='PATCH'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=albumTokenMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const body=await req.json()
        const updated={
          ...album,
          name:body.name??album.name,
          expiresAt:'expiresAt'in body?normalizeExpiresAt(body.expiresAt):album.expiresAt,
          password:'password'in body?(body.password?await hashPassword(body.password):null):album.password,
          published:'published'in body?body.published:(album.published??true),
          coverId:'coverId'in body?body.coverId:album.coverId,
          coverIdMobile:'coverIdMobile'in body?body.coverIdMobile:album.coverIdMobile,
          heroText:'heroText'in body?body.heroText:(album.heroText??'Photography'),
          heroFont:'heroFont'in body?body.heroFont:(album.heroFont??'josefin'),
          flagDefs:'flagDefs'in body?body.flagDefs:album.flagDefs,
          allowCustomerUpload:'allowCustomerUpload'in body?body.allowCustomerUpload:album.allowCustomerUpload,
          allowVideoUpload:'allowVideoUpload'in body?body.allowVideoUpload:album.allowVideoUpload,
          siteTitle:'siteTitle'in body?body.siteTitle:(album.siteTitle||null),
          lang:'lang'in body?body.lang:(album.lang||'ja'),
          updatedAt:new Date().toISOString(),
        }
        // Driveフォルダ名をリネーム
        if(body.name&&body.name!==album.name&&album.folderId){
          const _r=getAccessToken(env,false).then(at=>fetch(`https://www.googleapis.com/drive/v3/files/${album.folderId}?supportsAllDrives=true`,{method:'PATCH',headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json'},body:JSON.stringify({name:body.name})})).catch(()=>{})
          ctx.waitUntil(_r)
        }
        // 動画権限: 非公開・期限切れへ変わったときだけ、控え(gv:)を元に個別の公開を取り消す。
        // 公開・期限延長側では何もしない（動画は再生時に個別公開する方式のため、まとめて公開し直す必要は無い）
        const wasActive=isAlbumActive(album),willBeActive=isAlbumActive(updated)
        if(wasActive&&!willBeActive){
          const _p=(async()=>{
            try{
              const at=await getAccessToken(env,false)
              await sweepAlbumVideoGrants(env,t,updated.folderId,at,{remaining:40})
            }catch(e){console.error(`revoke video grants on publish/expiry change failed ${t}`,e)}
          })()
          ctx.waitUntil(_p)
        }
        await saveAlbum(env,t,updated)
        return jsonR({ok:true,album:updated})
      }

      if(albumTokenMatch&&req.method==='DELETE'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=albumTokenMatch[1]
        const deleteDrive=url.searchParams.get('deleteDrive')==='true'
        const at=deleteDrive?await getAccessToken(env,false):null
        const result=await deleteAlbumFully(env,t,deleteDrive,at,{remaining:40})
        return jsonR(result)
      }

      if(path==='/api/admin/albums'&&req.method==='DELETE'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const{tokens,deleteDrive}=await req.json()
        const at=deleteDrive?await getAccessToken(env,false):null
        const budget={remaining:40}
        const failed=[]
        let deletedCount=0
        // budgetを共有するため、1件ずつ順番に処理する（並行だと呼び出し回数の管理が競合する）
        for(const t of tokens){
          const result=await deleteAlbumFully(env,t,deleteDrive,at,budget)
          if(result.ok)deletedCount++
          else failed.push({token:t,name:result.name,reason:result.reason})
        }
        return jsonR({ok:failed.length===0,deleted:deletedCount,failed})
      }

      // ログ追記（ダウンロード記録など）
      const selectLogMatch = path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/select\/log$/)
      if (selectLogMatch && req.method === 'POST') {
        if (!await isAdmin(req, env)) return errR('Unauthorized', 401)
        const t = selectLogMatch[1]
        const album = await getAlbum(env, t)
        if (!album?.selectToken) return errR('No select', 404)
        const body = await req.json()
        const selectData = await getSelect(env, album.selectToken)
        if (!selectData) return errR('Not found', 404)
        const log = selectData.activityLog || []
        log.push({...body, at: new Date().toISOString()})
        await saveSelect(env, album.selectToken, {...selectData, activityLog: log})
        return jsonR({ok: true})
      }

      // ══ 選定URL管理 ══════════════════════════════

      const albumSelectMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/select$/)
      if(albumSelectMatch&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=albumSelectMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        // 既存のselect URLを返す or 新規生成
        if(album.selectToken){return jsonR({selectToken:album.selectToken,url:`${env.SITE_URL}/select.html?token=${album.selectToken}`})}
        const selectToken=genSelectToken()
        const flagDefs=await getEffectiveFlagDefs(env,album)
        await saveSelect(env,selectToken,{albumToken:t,createdAt:new Date().toISOString(),submitted:false,submittedAt:null,flagDefs,selections:{},rev:0})
        await saveAlbum(env,t,{...album,selectToken,updatedAt:new Date().toISOString()})
        return jsonR({selectToken,url:`${env.SITE_URL}/select.html?token=${selectToken}`})
      }

      if(albumSelectMatch&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=albumSelectMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(!album.selectToken)return jsonR({hasSelect:false})
        const selectData=await getSelect(env,album.selectToken)
        if(!selectData)return jsonR({hasSelect:false})
        // 写真情報を付与
        const at=await getAccessToken(env,true)
        const photos=await listPhotos(album.folderId,at)
        const photoMap=Object.fromEntries(photos.map(p=>[p.id,p]))
        const selections=selectData.selections||{}
        const byFlag={}
        for(const[photoId,flags]of Object.entries(selections)){
          for(const flag of flags){if(!byFlag[flag])byFlag[flag]=[];byFlag[flag].push({...photoMap[photoId]||{id:photoId}})}
        }
        return jsonR({hasSelect:true,submitted:selectData.submitted,submittedAt:selectData.submittedAt,flagDefs:selectData.flagDefs,selections,byFlag,activityLog:selectData.activityLog||[],photoMap:Object.fromEntries(Object.entries(photoMap).map(([k,v])=>([k,{id:v.id,name:v.name,thumb:v.thumbnailLink?.replace('=s220','=s400')||null}])))})
      }

      // 写真一覧（サムネイル選択用）
      const adminPhotosMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/photos$/)
      if(adminPhotosMatch&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=adminPhotosMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const at=await getAccessToken(env,true)
        const files=await listPhotos(album.folderId,at)
        // アルバムを個別に開いたタイミングで必ず数え直す（一覧はDriveに問い合わせないため、ここで記録を最新化する）
        ctx.waitUntil((async()=>{
          try{await persistAlbumCounts(env,t,computeAlbumCounts(files));await healDanglingCover(env,t,album,files)}
          catch(e){console.error(`recount on open (photos) ${t} failed`,e)}
        })())
        return jsonR({photos:files.map(f=>({id:f.id,name:f.name,thumb:f.thumbnailLink?.replace('=s220','=s400')||null,width:f.imageMediaMetadata?.width||1200,height:f.imageMediaMetadata?.height||800}))})
      }

      // サムネイルプロキシ
      const thumbMatch=path.match(/^\/api\/admin\/thumb\/([^/]+)$/)
      if(thumbMatch&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const at=await getAccessToken(env,true)
        const meta=await driveReq(`/files/${thumbMatch[1]}?fields=thumbnailLink`,at)
        const thumbUrl=meta.thumbnailLink?.replace('=s220','=s400')
        if(!thumbUrl)return errR('No thumbnail',404)
        const res=await fetch(thumbUrl),blob=await res.blob()
        return new Response(blob,{headers:{'Content-Type':res.headers.get('Content-Type')||'image/jpeg','Cache-Control':'private, max-age=3600',...CORS}})
      }

      if(path==='/api/test'&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const at=await getAccessToken(env,true)
        const d=await driveReq(`/files?q=${encodeURIComponent(`'${env.DRIVE_ROOT_FOLDER_ID}' in parents and trashed=false`)}&fields=files(id,name,mimeType)&pageSize=5`,at)
        return jsonR({ok:true,files:d.files})
      }

      // ══ 選定ページAPI（公開）══════════════════════

      const selectMatch=path.match(/^\/api\/select\/([a-z0-9_]+)$/)
      if(selectMatch&&req.method==='GET'){
        const st=selectMatch[1]
        const selectData=await getSelect(env,st)
        if(!selectData)return errR('Not found',404)
        const album=await getAlbum(env,selectData.albumToken)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        const at=await getAccessToken(env,true)
        const files=await listPhotos(album.folderId,at)
        const photos=files.map(f=>({id:f.id,name:f.name,thumb:f.thumbnailLink?.replace('=s220','=s800')||null,width:f.imageMediaMetadata?.width||1200,height:f.imageMediaMetadata?.height||800}))
        return jsonR({name:album.name,expiresAt:album.expiresAt,flagDefs:selectData.flagDefs,submitted:selectData.submitted,submittedAt:selectData.submittedAt,selections:selectData.selections||{},rev:selectData.rev||0,photos})
      }

      if(selectMatch&&req.method==='POST'){
        const st=selectMatch[1]
        const selectData=await getSelect(env,st)
        if(!selectData)return errR('Not found',404)
        const album=await getAlbum(env,selectData.albumToken)
        if(!album||album.published===false)return errR('Unauthorized',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        const body=await req.json()
        const currentRev=selectData.rev||0
        // 別端末との食い違い検出：forceが無ければ、送られてきたrevと保存済みrevが一致することを確認してから上書きする
        if(!body.force&&(body.rev??0)!==currentRev){
          return jsonR({error:'Conflict',rev:currentRev,selections:selectData.selections||{},submitted:selectData.submitted,submittedAt:selectData.submittedAt},409)
        }
        const updated={...selectData,selections:body.selections??selectData.selections,rev:currentRev+1}
        if(body.submitted){
          updated.submitted=true;updated.submittedAt=new Date().toISOString()
          const log = updated.activityLog || []
          log.push({type:'submitted', at:updated.submittedAt})
          updated.activityLog = log
          // アルバムに送信通知フラグを立てる
          const album=await getAlbum(env,selectData.albumToken)
          if(album){await saveAlbum(env,selectData.albumToken,{...album,selectSubmitted:true,updatedAt:new Date().toISOString()})}
        }
        await saveSelect(env,st,updated)
        return jsonR({ok:true,submitted:updated.submitted,rev:updated.rev})
      }

      // ══ 公開アルバムAPI ════════════════════════════

      const pubAlbumMatch=path.match(/^\/api\/album\/([a-z0-9]+)$/)
      if(pubAlbumMatch&&req.method==='GET'){
        const t=pubAlbumMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date()){
          // 期限切れ時は動画の公開を取り消す（控えを元に、失敗はログに残す）
          const _p=(async()=>{
            try{
              const at=await getAccessToken(env,false)
              await sweepAlbumVideoGrants(env,t,album.folderId,at,{remaining:40})
            }catch(e){console.error(`revoke video grants on expired view failed ${t}`,e)}
          })()
          ctx.waitUntil(_p)
          return errR('Expired',410)
        }
        if(album.password){const pw=url.searchParams.get('pw');if(!pw||!await verifyPassword(pw,album.password))return jsonR({requirePassword:true,name:album.name})}
        ctx.waitUntil(saveAlbum(env,t,{...album,viewCount:(album.viewCount||0)+1}).catch(()=>{}))
        const at=await getAccessToken(env,true)
        const files=await listPhotos(album.folderId,at)
        const totalSize=files.reduce((s,f)=>s+parseInt(f.size||0),0)
        const photos=files.map(f=>({id:f.id,name:f.name,thumb:f.thumbnailLink?.replace('=s220','=s800')||null,width:f.imageMediaMetadata?.width||1200,height:f.imageMediaMetadata?.height||800,size:parseInt(f.size||0),createdTime:f.createdTime||null,captureTime:f.imageMediaMetadata?.time||null}))
        // 動画一覧はサムネイル・名前・サイズの表示のみ。公開設定は写真と同様に不要（再生時に/api/video-openで個別に公開する）
        const videoFiles=await listVideos(album.folderId,at)
        const videos=videoFiles.map(v=>({id:v.id,name:v.name,thumb:v.thumbnailLink?.replace('=s220','=s400')||null,viewLink:v.webViewLink,size:parseInt(v.size||0)}))
        return jsonR({name:album.name,expiresAt:album.expiresAt,count:photos.length,totalSize,totalSizeLabel:fmtSize(totalSize),heroText:album.heroText||'Photography',heroFont:album.heroFont||'josefin',coverId:album.coverId||null,coverIdMobile:album.coverIdMobile||null,selectToken:album.selectToken||null,allowCustomerUpload:album.allowCustomerUpload||false,allowVideoUpload:album.allowVideoUpload||false,lang:album.lang||'ja',siteTitle:album.siteTitle||null,photos,videos})
      }

      // 動画の個別公開（再生ボタンが押されたときだけ、その動画1本をDrive上で公開する）
      const videoOpenMatch=path.match(/^\/api\/video-open\/([^/]+)$/)
      if(videoOpenMatch&&req.method==='POST'){
        const fileId=videoOpenMatch[1]
        const t=url.searchParams.get('token')
        if(!t)return errR('token required',400)
        const album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(album.password){
          const pw=url.searchParams.get('pw')
          if(!pw||!await verifyPassword(pw,album.password))return errR('Unauthorized',401)
        }
        const at=await getAccessToken(env,false)
        // 指定ファイルが本当にこのアルバムのフォルダに属し、かつ動画であることを確認する
        // （所属確認が無いと、有効なアルバムURLを1つ持っているだけで別アルバムの動画を公開させられてしまう）
        let meta
        try{meta=await driveReq(`/files/${fileId}?fields=parents,mimeType`,at)}
        catch(e){return errR('Not found',404)}
        if(!meta.parents?.includes(album.folderId))return errR('Forbidden',403)
        if(!meta.mimeType?.startsWith('video/'))return errR('Not a video',400)

        const kvKey=`gv:${t}:${fileId}`
        // 控えがあっても素通りさせず、毎回Driveに直接聞く（Drive側の設定はこちらを介さず変更され得るため）
        let alreadyPublic=false
        try{
          const permData=await driveReq(`/files/${fileId}/permissions?fields=permissions(id,type)`,at)
          alreadyPublic=(permData.permissions||[]).some(p=>p.type==='anyone')
        }catch(e){console.error(`video-open permission check failed ${t}:${fileId}`,e);return errR('Failed to open video',502)}

        if(!alreadyPublic){
          try{
            const res=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`,{method:'POST',headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json'},body:JSON.stringify({type:'anyone',role:'reader'})})
            if(!res.ok)throw new Error(`grant failed: ${res.status} ${await res.text()}`)
          }catch(e){console.error(`video-open grant failed ${t}:${fileId}`,e);return errR('Failed to open video',502)}
        }

        // 公開できたら控えを書く。動画1本ごとに独立したKVキーにする
        // （アルバムの記録内に配列で持つと、複数動画を同時に開いたときに読み込み-追加-書き戻しの競合で片方の控えが消える）
        try{
          await env.ALBUMS.put(kvKey,JSON.stringify({grantedAt:new Date().toISOString()}))
        }catch(e){
          // 控えを書けなかった場合は公開したままにしない。その場で公開を取り消す
          console.error(`video-open record failed ${t}:${fileId}`,e)
          await revokeAnyoneRead(fileId,at).catch(()=>{})
          return errR('Failed to open video',502)
        }
        return jsonR({ok:true})
      }

      // 写真DL（認証付き）
      const photoMatch=path.match(/^\/api\/photo\/([^/]+)$/)
      if(photoMatch&&req.method==='GET'){
        const fileId=photoMatch[1],size=url.searchParams.get('size')||'full',fname=url.searchParams.get('name')||`${fileId}.jpg`
        const albumToken=url.searchParams.get('token')
        if(!albumToken)return errR('Album token required',401)
        const album=await getAlbum(env,albumToken)
        if(!album)return errR('Invalid album token',403)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(album.password){const pw=url.searchParams.get('pw');if(!pw||!await verifyPassword(pw,album.password))return errR('Unauthorized',401)}
        const at=await getAccessToken(env,size!=='full')
        // このファイルが本当にこのアルバムのフォルダに入っているかを確認する。
        // これが無いと、有効なアルバムトークンさえあれば、fileIdを知るだけで
        // 別のアルバム（期限切れにしたものも含む）の写真を取得できてしまう。
        // サムネイル用のthumbnailLinkも同じ1回の問い合わせで受け取り、Drive呼び出しを増やさない。
        // ここはKVでキャッシュしない：写真の出し入れはドライブ側で直接行われるため、
        // キャッシュを捨てるきっかけが無く、アルバムから外した写真がキャッシュ時間分だけ
        // 取得できてしまう状態になる
        const meta=await driveReq(`/files/${fileId}?fields=parents,trashed${size!=='full'?',thumbnailLink':''}`,at).catch(()=>null)
        if(!meta||meta.trashed||!Array.isArray(meta.parents)||!meta.parents.includes(album.folderId))return errR('Not in this album',403)
        let imgRes
        if(size==='full'){imgRes=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,{headers:{Authorization:`Bearer ${at}`}})}
        else{const s=size==='medium'?'s2400':'s1200';const thumbUrl=meta.thumbnailLink?.replace('=s220',`=${s}`);if(!thumbUrl)return errR('No thumbnail',404);imgRes=await fetch(thumbUrl)}
        const blob=await imgRes.blob()
        const disp=size==='full'?`inline; filename="${fname}"`:`inline; filename="${size}_${fname}"`
        return new Response(blob,{headers:{'Content-Type':imgRes.headers.get('Content-Type')||'image/jpeg','Content-Disposition':disp,'Cache-Control':'private, max-age=3600',...CORS}})
      }

      // ══ お客さんアップロード チャンク転送（大容量動画用）══
      const pubChunkMatch=path.match(/^\/api\/album\/([a-z0-9]+)\/upload\/chunk$/)
      if(pubChunkMatch&&req.method==='POST'){
        const t=pubChunkMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(!album.allowCustomerUpload)return errR('Upload not allowed',403)
        const sessionUri=req.headers.get('X-Session-Uri')
        const contentRange=req.headers.get('X-Content-Range')
        const mimeType=req.headers.get('Content-Type')||'application/octet-stream'
        if(!sessionUri||!contentRange)return errR('Missing headers',400)
        const contentLength=req.headers.get('Content-Length')||'0'
        const chunkRes=await fetch(sessionUri,{method:'PUT',headers:{'Content-Range':contentRange,'Content-Type':mimeType,'Content-Length':contentLength},body:req.body,duplex:'half'})
        if(chunkRes.status===308)return jsonR({status:'continue'})
        if(chunkRes.status===200||chunkRes.status===201){const r=await chunkRes.json();return jsonR({status:'complete',id:r.id,name:r.name})}
        throw new Error(`Chunk: ${chunkRes.status} ${await chunkRes.text()}`)
      }

      // ══ お客さんアップロード セッション開始 ══
      const pubSessionMatch2=path.match(/^\/api\/album\/([a-z0-9]+)\/upload\/session$/)
      if(pubSessionMatch2&&req.method==='POST'){
        const t=pubSessionMatch2[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(!album.allowCustomerUpload)return errR('Upload not allowed',403)
        const{name,mimeType,size}=await req.json()
        if(mimeType&&mimeType.startsWith('video/')&&!album.allowVideoUpload)return errR('Video upload not allowed',403)
        const at=await getAccessToken(env,false)
        const sesRes=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',{
          method:'POST',
          headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(size)},
          body:JSON.stringify({name,parents:[album.folderId]})
        })
        if(!sesRes.ok)throw new Error(`Session: ${await sesRes.text()}`)
        return jsonR({sessionUri:sesRes.headers.get('Location')})
      }

      // ══ お客さんファイル削除 ══
      // ══ アップロード後ファイルID照合 ══
      const pubLookupMatch=path.match(/^\/api\/album\/([a-z0-9]+)\/upload\/lookup$/)
      if(pubLookupMatch&&req.method==='POST'){
        const t=pubLookupMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(!album.allowCustomerUpload)return errR('Upload not allowed',403)
        const{name,size}=await req.json()
        if(!name)return errR('name required',400)
        const at=await getAccessToken(env,false)
        // 複数人が同時にアップロードすると同名だが別内容のファイルが並ぶことがあるため、
        // 直近の候補を複数取得しファイルサイズが一致するものを優先して特定する（誤って他人のファイルIDを掴まないように）
        const q=encodeURIComponent(`'${album.folderId}' in parents and name='${name.replace(/'/g,"\\'")}' and trashed=false`)
        const r=await driveReq(`/files?q=${q}&fields=files(id,name,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime desc&pageSize=5`,at)
        const files=r.files||[]
        const file=(size!=null?files.find(f=>String(f.size)===String(size)):null)||files[0]
        if(!file)return errR('Not found',404)
        return jsonR({id:file.id,name:file.name})
      }

      const pubDelFileMatch=path.match(/^\/api\/album\/([a-z0-9]+)\/files\/([^/]+)$/)
      if(pubDelFileMatch&&req.method==='DELETE'){
        const t=pubDelFileMatch[1],fileId=pubDelFileMatch[2]
        const album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        const at=await getAccessToken(env,false)
        const info=await driveReq(`/files/${fileId}?fields=parents&supportsAllDrives=true`,at)
        if(!info.parents?.includes(album.folderId))return errR('Forbidden',403)
        await deleteFile(fileId,at)
        if(album.coverId===fileId||album.coverIdMobile===fileId){
          await saveAlbum(env,t,{...album,coverId:album.coverId===fileId?null:album.coverId,coverIdMobile:album.coverIdMobile===fileId?null:album.coverIdMobile})
        }
        return jsonR({ok:true})
      }

      // ══ 管理者アップロード チャンク転送 ══
      const adminChunkMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/upload\/chunk$/)
      if(adminChunkMatch&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const sessionUri=req.headers.get('X-Session-Uri')
        const contentRange=req.headers.get('X-Content-Range')
        const mimeType=req.headers.get('Content-Type')||'application/octet-stream'
        if(!sessionUri||!contentRange)return errR('Missing headers',400)
        const contentLength=req.headers.get('Content-Length')||'0'
        const chunkRes=await fetch(sessionUri,{method:'PUT',headers:{'Content-Range':contentRange,'Content-Type':mimeType,'Content-Length':contentLength},body:req.body,duplex:'half'})
        if(chunkRes.status===308)return jsonR({status:'continue'})
        if(chunkRes.status===200||chunkRes.status===201){const r=await chunkRes.json();return jsonR({status:'complete',id:r.id,name:r.name})}
        throw new Error(`Chunk: ${chunkRes.status} ${await chunkRes.text()}`)
      }

      // ══ 管理者アップロード セッション開始 ══
      const adminSessionMatch2=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/upload\/session$/)
      if(adminSessionMatch2&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=adminSessionMatch2[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const{name,mimeType,size}=await req.json()
        const at=await getAccessToken(env,false)
        const sesRes=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',{
          method:'POST',
          headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(size)},
          body:JSON.stringify({name,parents:[album.folderId]})
        })
        if(!sesRes.ok)throw new Error(`Session: ${await sesRes.text()}`)
        return jsonR({sessionUri:sesRes.headers.get('Location')})
      }

      // ══ 管理者ファイル一覧 ══
      const adminFilesMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/files$/)
      if(adminFilesMatch&&req.method==='GET'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=adminFilesMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const at=await getAccessToken(env,false)
        const[photos,videos]=await Promise.all([listPhotos(album.folderId,at),listVideos(album.folderId,at)])
        // アルバムを個別に開いたタイミングで必ず数え直す（一覧はDriveに問い合わせないため、ここで記録を最新化する）
        ctx.waitUntil((async()=>{
          try{await persistAlbumCounts(env,t,computeAlbumCounts(photos));await healDanglingCover(env,t,album,photos)}
          catch(e){console.error(`recount on open (files) ${t} failed`,e)}
        })())
        return jsonR({photos,videos})
      }

      // ══ 管理者ファイル削除 ══
      const adminDelFileMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/files\/([^/]+)$/)
      if(adminDelFileMatch&&req.method==='DELETE'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=adminDelFileMatch[1],fileId=adminDelFileMatch[2]
        const at=await getAccessToken(env,false)
        await deleteFile(fileId,at)
        const album=await getAlbum(env,t)
        if(album&&(album.coverId===fileId||album.coverIdMobile===fileId)){
          await saveAlbum(env,t,{...album,coverId:album.coverId===fileId?null:album.coverId,coverIdMobile:album.coverIdMobile===fileId?null:album.coverIdMobile})
        }
        return jsonR({ok:true})
      }

      // ══ お客さんアップロード（公開）══════════════════
      const pubUploadMatch=path.match(/^\/api\/album\/([a-z0-9]+)\/upload$/)
      if(pubUploadMatch&&req.method==='POST'){
        const t=pubUploadMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(!album.allowCustomerUpload)return errR('Upload not allowed',403)
        const fd=await req.formData()
        const file=fd.get('file')
        if(!file)return errR('No file',400)
        if(file.type&&file.type.startsWith('video/')&&!album.allowVideoUpload)return errR('Video upload not allowed',403)
        const at=await getAccessToken(env,false)
        const boundary='-------314159265358979323846'
        const meta=JSON.stringify({name:file.name,parents:[album.folderId]})
        const buf=await file.arrayBuffer()
        const enc=new TextEncoder()
        const head=enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.type||'application/octet-stream'}\r\n\r\n`)
        const foot=enc.encode(`\r\n--${boundary}--`)
        const body=new Uint8Array(head.length+buf.byteLength+foot.length)
        body.set(head,0);body.set(new Uint8Array(buf),head.length);body.set(foot,head.length+buf.byteLength)
        const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',{method:'POST',headers:{Authorization:`Bearer ${at}`,'Content-Type':`multipart/related; boundary="${boundary}"`},body})
        if(!res.ok)throw new Error(`Drive upload: ${await res.text()}`)
        const r=await res.json()
        return jsonR({ok:true,id:r.id,name:r.name})
      }

      // ══ お客さんアップロード Resumableセッション開始 ══
      const pubSessionMatch=path.match(/^\/api\/album\/([a-z0-9]+)\/upload\/session$/)
      if(pubSessionMatch&&req.method==='POST'){
        const t=pubSessionMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        if(!album.allowCustomerUpload)return errR('Upload not allowed',403)
        const{name,mimeType,size}=await req.json()
        if(mimeType&&mimeType.startsWith('video/')&&!album.allowVideoUpload)return errR('Video upload not allowed',403)
        const at=await getAccessToken(env,false)
        const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',{
          method:'POST',
          headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(size)},
          body:JSON.stringify({name,parents:[album.folderId]})
        })
        if(!res.ok)throw new Error(`Session: ${await res.text()}`)
        return jsonR({sessionUri:res.headers.get('Location')})
      }

      // ══ アップロード ══════════════════════════════════
      const uploadMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/upload$/)
      if(uploadMatch&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=uploadMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const fd=await req.formData()
        const file=fd.get('file')
        if(!file)return errR('No file',400)
        const at=await getAccessToken(env,false)
        const boundary='-------314159265358979323846'
        const meta=JSON.stringify({name:file.name,parents:[album.folderId]})
        const buf=await file.arrayBuffer()
        const enc=new TextEncoder()
        const head=enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.type||'application/octet-stream'}\r\n\r\n`)
        const foot=enc.encode(`\r\n--${boundary}--`)
        const body=new Uint8Array(head.length+buf.byteLength+foot.length)
        body.set(head,0);body.set(new Uint8Array(buf),head.length);body.set(foot,head.length+buf.byteLength)
        const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',{method:'POST',headers:{Authorization:`Bearer ${at}`,'Content-Type':`multipart/related; boundary="${boundary}"`},body})
        if(!res.ok)throw new Error(`Drive upload: ${await res.text()}`)
        const r=await res.json()
        return jsonR({ok:true,id:r.id,name:r.name})
      }

      // ══ 管理者アップロード Resumableセッション開始 ══
      const adminSessionMatch=path.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/upload\/session$/)
      if(adminSessionMatch&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=adminSessionMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        const{name,mimeType,size}=await req.json()
        const at=await getAccessToken(env,false)
        const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',{
          method:'POST',
          headers:{Authorization:`Bearer ${at}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(size)},
          body:JSON.stringify({name,parents:[album.folderId]})
        })
        if(!res.ok)throw new Error(`Session: ${await res.text()}`)
        return jsonR({sessionUri:res.headers.get('Location')})
      }

      return errR('Not found',404)
    }catch(e){console.error(e);return errR(`Error: ${e.message}`,500)}
  }
}
