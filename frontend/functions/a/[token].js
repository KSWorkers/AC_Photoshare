// Cloudflare Pages Function: /a/:token
// LINEなどのSNS共有用OGPラッパー

export async function onRequestGet({ params }) {
  const token = params.token
  const WORKER = 'https://ac-photoshare.nikkomaedori.workers.dev'
  const SITE = 'YOUR_PAGES_URL_HERE'

  let albumName = 'フォトギャラリー'
  let hasCover = false

  try {
    const res = await fetch(`${WORKER}/api/album/${token}`)
    if (res.ok) {
      const d = await res.json()
      if (!d.requirePassword && d.name) {
        albumName = d.name
        hasCover = !!d.coverId
      }
    }
  } catch {}

  const albumUrl = `${SITE}/album.html?token=${token}`
  const imageUrl = `${WORKER}/api/og-image/${token}`

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
