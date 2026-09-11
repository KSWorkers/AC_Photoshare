// Cloudflare Pages Function: /a/:token
// LINEなどのSNS共有用OGPラッパー

// HTMLに直接埋め込む値のエスケープ（アルバム名などに &<>"' が含まれても表示が崩れないように）
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

export async function onRequestGet({ params }) {
  const token = params.token
  const WORKER = 'https://ac-photoshare.nikkomaedori.workers.dev'
  const SITE = 'https://ac-photoshare.pages.dev'

  let albumName = 'フォトギャラリー'
  let hasCover = false

  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${WORKER}/api/album/${token}`, { signal: controller.signal })
    clearTimeout(tid)
    if (res.ok) {
      const d = await res.json()
      if (!d.requirePassword && d.name) {
        albumName = d.name
        hasCover = !!d.coverId
      }
    }
  } catch {}

  albumName = escapeHtml(albumName)
  const albumUrl = escapeHtml(`${SITE}/album.html?token=${token}`)
  const imageUrl = escapeHtml(`${WORKER}/api/og-image/${token}`)

  const ogImage = hasCover ? `
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imageUrl}">` : `
<meta name="twitter:card" content="summary">`

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${albumName} | Alcyone PhotoShare</title>
<meta property="og:title" content="${albumName}">
<meta property="og:type" content="website">
<meta property="og:url" content="${albumUrl}">
<meta property="og:site_name" content="Alcyone PhotoShare">${ogImage}
<meta http-equiv="refresh" content="0;url=${albumUrl}">
</head><body>
<script>location.replace("${albumUrl}")</script>
</body></html>`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-cache',
    }
  })
}
