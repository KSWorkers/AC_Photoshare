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

async function listPhotos(folderId,token){
  const q=encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`)
  const f=encodeURIComponent('files(id,name,size,thumbnailLink,imageMediaMetadata(width,height))')
  const d=await driveReq(`/files?q=${q}&fields=${f}&orderBy=name&pageSize=500`,token)
  return d.files||[]
}

async function listVideos(folderId,token){
  const mimes=['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/x-matroska']
  const mimeQ=mimes.map(m=>`mimeType='${m}'`).join(' or ')
  const q=encodeURIComponent(`'${folderId}' in parents and (${mimeQ}) and trashed = false`)
  const f=encodeURIComponent('files(id,name,size,mimeType,thumbnailLink,webViewLink)')
  const d=await driveReq(`/files?q=${q}&fields=${f}&orderBy=name&pageSize=100`,token)
  return d.files||[]
}

async function createFolder(name,parentId,token){
  const res=await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]})})
  if(!res.ok)throw new Error(`CreateFolder: ${await res.text()}`)
  return res.json()
}

async function deleteFile(fileId,token){
  const res=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})
  if(!res.ok&&res.status!==404)throw new Error(`Delete: ${res.status}`)
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

async function getSystemSettings(env){
  const s=await env.ALBUMS.get('system:settings','json')
  return s||{flagDefs:DEFAULT_FLAG_DEFS}
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
function buildFolderName(name){const d=new Date();return`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${name}`}
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
const getSelect=(env,t)=>env.ALBUMS.get(`select:${t}`,'json')
const saveSelect=(env,t,d)=>env.ALBUMS.put(`select:${t}`,JSON.stringify(d))

// ─── レスポンス ─────────────────────────────────────

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}
const jsonR=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json',...CORS}})
const errR=(m,s=400)=>jsonR({error:m},s)

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
        const albumUrl=`${env.SITE_URL}/album.html?token=${t}`,title=album?album.name:'フォトギャラリー'
        const imageUrl=album?.coverId?`${env.SITE_URL}/api/og-image/${t}`:''
        const ogImage=imageUrl?`<meta property="og:image" content="${imageUrl}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${imageUrl}">`:'<meta name="twitter:card" content="summary">'
        const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} | Alcyone PhotoShare</title><meta property="og:title" content="${title}"><meta property="og:type" content="website"><meta property="og:url" content="${albumUrl}"><meta property="og:site_name" content="Alcyone PhotoShare"><meta name="twitter:title" content="${title}">${ogImage}<meta http-equiv="refresh" content="0;url=${albumUrl}"></head><body><script>location.replace("${albumUrl}")</script></body></html>`
        return new Response(html,{headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-cache',...CORS}})
      }

      // OGP画像
      const ogImageMatch=path.match(/^\/api\/og-image\/([a-z0-9]+)$/)
      if(ogImageMatch&&req.method==='GET'){
        const t=ogImageMatch[1],album=await getAlbum(env,t)
        if(!album?.coverId)return errR('No image',404)
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
        const at=await getAccessToken(env,true)
        const enriched=await Promise.all(albums.map(async a=>{
          try{const photos=await listPhotos(a.folderId,at);const totalSize=photos.reduce((s,f)=>s+parseInt(f.size||0),0);return{...a,count:photos.length,totalSize,totalSizeLabel:fmtSize(totalSize),coverId:a.coverId||photos[0]?.id||null}}
          catch{return{...a,count:0,totalSize:0,totalSizeLabel:'0 B',coverId:null}}
        }))
        return jsonR({albums:enriched})
      }

      if(path==='/api/admin/albums'&&req.method==='POST'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const{name,expiresAt,password}=await req.json()
        if(!name)return errR('name required')
        const token=genToken()
        const at=await getAccessToken(env,false)
        const folder=await createFolder(buildFolderName(name),env.DRIVE_ROOT_FOLDER_ID,at)
        const album={name,folderId:folder.id,createdAt:new Date().toISOString(),expiresAt:normalizeExpiresAt(expiresAt),password:password?await hashPassword(password):null,published:true,heroText:'Photography',heroFont:'josefin'}
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
          updatedAt:new Date().toISOString(),
        }
        // 動画権限を同期
        const wasActive=isAlbumActive(album),willBeActive=isAlbumActive(updated)
        if(wasActive!==willBeActive){const _p=getAccessToken(env,false).then(at=>syncVideoPerms(updated.folderId,willBeActive,at)).catch(()=>{});ctx.waitUntil(_p)}
        await saveAlbum(env,t,updated)
        return jsonR({ok:true,album:updated})
      }

      if(albumTokenMatch&&req.method==='DELETE'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const t=albumTokenMatch[1]
        if(url.searchParams.get('deleteDrive')==='true'){const album=await getAlbum(env,t);if(album?.folderId){const at=await getAccessToken(env,false);await deleteFile(album.folderId,at).catch(()=>{})}}
        await env.ALBUMS.delete(`album:${t}`)
        return jsonR({ok:true})
      }

      if(path==='/api/admin/albums'&&req.method==='DELETE'){
        if(!await isAdmin(req,env))return errR('Unauthorized',401)
        const{tokens,deleteDrive}=await req.json()
        if(deleteDrive){const at=await getAccessToken(env,false);await Promise.all(tokens.map(async t=>{const album=await getAlbum(env,t);if(album?.folderId)await deleteFile(album.folderId,at).catch(()=>{})}))}
        await Promise.all(tokens.map(t=>env.ALBUMS.delete(`album:${t}`)))
        return jsonR({ok:true,deleted:tokens.length})
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
        await saveSelect(env,selectToken,{albumToken:t,createdAt:new Date().toISOString(),submitted:false,submittedAt:null,flagDefs,selections:{}})
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
        return jsonR({name:album.name,expiresAt:album.expiresAt,flagDefs:selectData.flagDefs,submitted:selectData.submitted,submittedAt:selectData.submittedAt,selections:selectData.selections||{},photos})
      }

      if(selectMatch&&req.method==='POST'){
        const st=selectMatch[1]
        const selectData=await getSelect(env,st)
        if(!selectData)return errR('Not found',404)
        const album=await getAlbum(env,selectData.albumToken)
        if(!album||album.published===false)return errR('Unauthorized',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date())return errR('Expired',410)
        const body=await req.json()
        const updated={...selectData,selections:body.selections??selectData.selections}
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
        return jsonR({ok:true,submitted:updated.submitted})
      }

      // ══ 公開アルバムAPI ════════════════════════════

      const pubAlbumMatch=path.match(/^\/api\/album\/([a-z0-9]+)$/)
      if(pubAlbumMatch&&req.method==='GET'){
        const t=pubAlbumMatch[1],album=await getAlbum(env,t)
        if(!album)return errR('Not found',404)
        if(album.published===false)return errR('Not published',403)
        if(album.expiresAt&&new Date(album.expiresAt)<new Date()){
          // 期限切れ時は動画権限を取り消す
          ctx.waitUntil(getAccessToken(env,false).then(at=>syncVideoPerms(album.folderId,false,at)).catch(()=>{}))
          return errR('Expired',410)
        }
        if(album.password){const pw=url.searchParams.get('pw');if(!pw||!await verifyPassword(pw,album.password))return jsonR({requirePassword:true,name:album.name})}
        const at=await getAccessToken(env,true)
        const files=await listPhotos(album.folderId,at)
        const totalSize=files.reduce((s,f)=>s+parseInt(f.size||0),0)
        const photos=files.map(f=>({id:f.id,name:f.name,thumb:f.thumbnailLink?.replace('=s220','=s800')||null,width:f.imageMediaMetadata?.width||1200,height:f.imageMediaMetadata?.height||800,size:parseInt(f.size||0)}))
        // 動画（初回アクセス時に権限を付与）
        const videoFiles=await listVideos(album.folderId,at)
        if(videoFiles.length>0){ctx.waitUntil(getAccessToken(env,false).then(rwAt=>Promise.all(videoFiles.map(v=>grantAnyoneRead(v.id,rwAt)))).catch(()=>{}))}
        const videos=videoFiles.map(v=>({id:v.id,name:v.name,thumb:v.thumbnailLink?.replace('=s220','=s400')||null,viewLink:v.webViewLink,size:parseInt(v.size||0)}))
        return jsonR({name:album.name,expiresAt:album.expiresAt,count:photos.length,totalSize,totalSizeLabel:fmtSize(totalSize),heroText:album.heroText||'Photography',heroFont:album.heroFont||'josefin',coverId:album.coverId||null,coverIdMobile:album.coverIdMobile||null,selectToken:album.selectToken||null,allowCustomerUpload:album.allowCustomerUpload||false,photos,videos})
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
        let imgRes
        if(size==='full'){imgRes=await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,{headers:{Authorization:`Bearer ${at}`}})}
        else{const meta=await driveReq(`/files/${fileId}?fields=thumbnailLink`,at);const s=size==='medium'?'s2400':'s1200';const thumbUrl=meta.thumbnailLink?.replace('=s220',`=${s}`);if(!thumbUrl)return errR('No thumbnail',404);imgRes=await fetch(thumbUrl)}
        const blob=await imgRes.blob()
        const disp=size==='full'?`attachment; filename="${fname}"`:`attachment; filename="${size}_${fname}"`
        return new Response(blob,{headers:{'Content-Type':imgRes.headers.get('Content-Type')||'image/jpeg','Content-Disposition':disp,'Cache-Control':'private, max-age=3600',...CORS}})
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

      return errR('Not found',404)
    }catch(e){console.error(e);return errR(`Error: ${e.message}`,500)}
  }
}
