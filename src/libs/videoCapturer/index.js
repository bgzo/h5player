/*!
 * @name      videoCapturer.js
 * @version   0.0.1
 * @author    Blaze
 * @date      2019/9/21 12:03
 * @github    https://github.com/xxxily
 */

async function setClipboard (blob) {
  if (navigator.clipboard) {
    navigator.clipboard.write([
      // eslint-disable-next-line no-undef
      new ClipboardItem({
        [blob.type]: blob
      })
    ]).then(() => {
      console.info('[setClipboard] clipboard suc', blob.type)
    }).catch((e) => {
      console.error('[setClipboard] clipboard err', blob.type, e)
    })
  } else {
    console.error('当前网站不支持将数据写入到剪贴板里，见：\n https://developer.mozilla.org/en-US/docs/Web/API/Clipboard')
  }
}

/* 获取视频的跨域源地址，用于回退下载时重新拉取 */
function getVideoSourceUrl (video) {
  const src = video.currentSrc || video.src
  if (!src) return ''
  if (src.indexOf('//') === 0) return location.protocol + src
  return src
}

/* 通过 GM_xmlhttpRequest 拉取跨域视频字节，返回 Blob */
function fetchVideoBlob (url, withCredentials) {
  return new Promise(function (resolve, reject) {
    const gm = window.GM_xmlhttpRequest
    if (typeof gm !== 'function') {
      return reject(new Error('GM_xmlhttpRequest 未注册'))
    }
    gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href },
      onerror: (err) => reject(err),
      onload: (res) => {
        if (res.status >= 400) return reject(new Error('HTTP ' + res.status))
        /* 省略 type，交给浏览器按容器字节嗅探（mp4/webm 均可靠，避免硬编码误判） */
        const blob = new Blob([res.response])
        resolve(blob)
      }
    })
  })
}

function drawVideoToCanvas (video) {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas
}

/* 缓存同一个视频源下载好的 blob 及其临时 video，保证一个影片只下载一次 */
const videoCache = new Map()

/* 大于 1G 的视频不缓存，避免内存占用过高 */
const MAX_CACHE_SIZE = 1024 * 1024 * 1024
/* 超过 4 小时没有再次截图，自动释放缓存 */
const CACHE_IDLE_TIMEOUT = 4 * 60 * 60 * 1000

/* 全量下载前探测视频大小：发 Range: bytes=0-0 请求，从 content-range 读取总大小；无法判断时返回 0 */
function probeVideoSize (url, withCredentials) {
  return new Promise(function (resolve) {
    const gm = window.GM_xmlhttpRequest
    if (typeof gm !== 'function') return resolve(0)
    gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href, Range: 'bytes=0-0' },
      onerror: () => resolve(0),
      onload: (res) => {
        if (res.status >= 400) return resolve(0)
        const headers = typeof res.responseHeaders === 'string' ? res.responseHeaders : ''
        const lower = headers.toLowerCase()
        const rangeMatch = lower.match(/content-range:\s*bytes\s+0-0\/(\d+)/)
        if (rangeMatch) return resolve(parseInt(rangeMatch[1], 10))
        const lengthMatch = lower.match(/content-length:\s*(\d+)/)
        if (lengthMatch) return resolve(parseInt(lengthMatch[1], 10))
        resolve(0)
      }
    })
  })
}

/* 当切换到新视频源时，释放旧视频占用的内存，避免一个页面累计下载多部影片 */
function evictOtherVideos (keepUrl) {
  videoCache.forEach(function (record, key) {
    if (key !== keepUrl && record.objectUrl) {
      URL.revokeObjectURL(record.objectUrl)
      videoCache.delete(key)
    }
  })
}

/* 释放超过 CACHE_IDLE_TIMEOUT 未被使用的缓存记录 */
function evictExpiredCache () {
  const now = Date.now()
  videoCache.forEach(function (record, key) {
    if (now - record.lastUsed > CACHE_IDLE_TIMEOUT) {
      if (record.objectUrl) URL.revokeObjectURL(record.objectUrl)
      videoCache.delete(key)
    }
  })
}

function loadVideoFromBlob (blob) {
  return new Promise(function (resolve, reject) {
    const objectUrl = URL.createObjectURL(blob)
    const tempVideo = document.createElement('video')
    tempVideo.crossOrigin = 'anonymous'
    tempVideo.muted = true
    tempVideo.playsInline = true
    tempVideo.preload = 'auto'
    tempVideo.src = objectUrl
    tempVideo.addEventListener('loadeddata', function () {
      resolve({ videoEl: tempVideo, objectUrl })
    }, { once: true })
    tempVideo.addEventListener('error', function () {
      reject(new Error('视频解码失败'))
    }, { once: true })
  })
}

/* 获取（或下载并缓存）视频源对应的临时 video；options.cacheable 为 false 时不写入缓存 */
function getCachedVideo (srcUrl, options) {
  options = options || {}
  const cacheable = !!options.cacheable
  const cached = cacheable ? videoCache.get(srcUrl) : null
  if (cached) {
    cached.lastUsed = Date.now()
    return cached.promise || Promise.resolve(cached)
  }

  const record = { promise: null, videoEl: null, objectUrl: '', lastUsed: Date.now(), cacheable }
  if (cacheable) videoCache.set(srcUrl, record)
  record.promise = fetchVideoBlob(srcUrl, options.withCredentials)
    .then(loadVideoFromBlob)
    .then(function (loaded) {
      record.videoEl = loaded.videoEl
      record.objectUrl = loaded.objectUrl
      record.promise = null
      return record
    })
    .catch(function (err) {
      if (cacheable) videoCache.delete(srcUrl)
      throw err
    })
  return record.promise
}

function seekVideo (videoEl, targetTime) {
  if (!targetTime || targetTime <= 0 || !videoEl.duration) return Promise.resolve()
  return new Promise(function (resolve, reject) {
    const onSeeked = function () {
      /* seeked 后若首帧数据尚未就绪（readyState < HAVE_CURRENT_DATA），
       * 需等 loadeddata 再绘制，避免截到黑帧 */
      if (videoEl.readyState >= 2) return resolve()
      videoEl.addEventListener('loadeddata', resolve, { once: true })
    }
    videoEl.addEventListener('seeked', onSeeked, { once: true })
    videoEl.addEventListener('error', reject, { once: true })
    videoEl.currentTime = Math.min(targetTime, videoEl.duration)
  })
}

/* 方案2：重拉视频源为 blob 后，重新绘制一次，绕开 CORS 污染；同一视频源只下载一次 */
async function captureViaBlob (video, title, enableCrossOriginCapture) {
  const srcUrl = getVideoSourceUrl(video)
  /* HLS/MSE/DASH 等非直链源无法通过重拉 blob 绕过 CORS（m3u8 为播放列表文本，
   * 拉回后无法解码），且重拉会造成无谓的全量下载与解码报错，故直接短路退回预览 */
  if (!srcUrl) return null
  if (!/^https?:/i.test(srcUrl)) return null
  if (/\.m3u8($|\?)/i.test(srcUrl)) return null

  evictExpiredCache()
  evictOtherVideos(srcUrl)

  /* 全量下载前探测大小，超过 1G 或无法探测大小的视频不缓存，避免内存占用过高 */
  const size = await probeVideoSize(srcUrl, !!enableCrossOriginCapture)
  const cacheable = size > 0 && size <= MAX_CACHE_SIZE

  const record = await getCachedVideo(srcUrl, { withCredentials: !!enableCrossOriginCapture, cacheable })
  await seekVideo(record.videoEl, video.currentTime || 0)

  const canvas = drawVideoToCanvas(record.videoEl)
  if (!record.cacheable && record.objectUrl) {
    URL.revokeObjectURL(record.objectUrl)
    record.objectUrl = ''
  }
  return { canvas, title }
}

var videoCapturer = {
  /**
   * 进行截图操作
   * @param video {dom} -必选 video dom 标签
   * @param download {boolean} -是否下载截图
   * @param title {string} -截图标题
   * @param enableCrossOriginCapture {boolean} -canvas被CORS污染时，是否重拉视频源绕开限制下载
   * @returns {boolean}
   */
  capture (video, download, title, enableCrossOriginCapture) {
    if (!video) return false
    const t = this
    const currentTime = `${Math.floor(video.currentTime / 60)}'${(video.currentTime % 60).toFixed(3)}''`
    const captureTitle = title || `${document.title}_${currentTime}`

    /* 截图核心逻辑 */
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    if (download) {
      t.download(canvas, captureTitle, video, false, enableCrossOriginCapture)
    } else {
      t.previe(canvas, captureTitle)
    }

    return canvas
  },
  /**
   * 预览截取到的画面内容
   * @param canvas
   */
  previe (canvas, title) {
    canvas.style = 'max-width:100%'
    const previewPage = window.open('', '_blank')
    previewPage.document.title = `capture previe - ${title || 'Untitled'}`
    previewPage.document.body.style.textAlign = 'center'
    previewPage.document.body.style.background = '#000'
    previewPage.document.body.appendChild(canvas)
  },
  /**
   * canvas 下载截取到的内容
   * @param canvas
   */
  download (canvas, title, video, noFallback, enableCrossOriginCapture) {
    title = title || 'videoCapturer_' + Date.now()

    try {
      /**
       * 尝试复制到剪贴板
       * 注意部分浏览器不支持将'image/jpeg'类型的数据写入到剪贴板，image/jpg可以，但会导致toBlob的结果为png的数据，
       * 所以这里新起了'image/png'来尝试复制到剪贴板，而不能将setClipboard(blob)放到下面的try里
       * 另外由于下面的自动下载截图会导致页面失焦，也会造成复制到剪贴板失败，所以这里先复制到剪贴板，再进行下载
       */
      canvas.toBlob(function (blob) {
        setClipboard(blob)
      }, 'image/png', 0.99)
    } catch (e) {
      console.error('无法将截图复制到剪贴板。', e)
    }

    try {
      canvas.toBlob(function (blob) {
        const el = document.createElement('a')
        el.download = `${title}.jpg`
        el.href = URL.createObjectURL(blob)
        el.click()
      }, 'image/jpeg', 0.99)
    } catch (e) {
      console.error('视频源受CORS标识限制，无法直接下载截图，将尝试重拉视频源，见：\n https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS')
      console.error(video, e)

      // 方案2：重拉视频源为 blob 后重新下载，替代原 newtab 预览（需在设置中开启）
      if (enableCrossOriginCapture && !noFallback) {
        captureViaBlob(video, title, enableCrossOriginCapture)
          .then(function (result) {
            if (!result) return videoCapturer.previe(canvas, title)
            videoCapturer.download(result.canvas, result.title, video, true, enableCrossOriginCapture)
          })
          .catch(function (err) {
            console.error('重拉视频源失败，退回预览。', err)
            videoCapturer.previe(canvas, title)
          })
      } else {
        videoCapturer.previe(canvas, title)
      }
    }
  }
}

export default videoCapturer
