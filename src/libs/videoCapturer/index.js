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

/* 最小超时 30s */
const FETCH_TIMEOUT_MIN = 30000
/* 时长未知（如直播）时的兜底超时 5 分钟 */
const FETCH_TIMEOUT_FALLBACK = 300000
/* 下载失败后的熔断冷却时长：5 分钟内不再重试同一源 */
const RETRY_COOLDOWN = 5 * 60 * 1000

/* 熔断错误：用于区分"可重试失败"与"被熔断拦截"，捕获后可据此提示用户 */
class CaptureFusedError extends Error {}

/* 记录最近一次失败的视频源（srcUrl -> 失败时间戳），用于冷却期内的熔断 */
const failedSrc = new Map()

/* 下载进度日志间隔：每 10s 打印一次已下载字节与预计剩余时间 */
const PROGRESS_LOG_INTERVAL = 10000

/* 将字节数格式化为易读的带单位字符串 */
function formatBytes (bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

/* 创建单次下载的进度记录器（闭包隔离并发下载），由 GM 的 onprogress 回调调用；
 * 每 PROGRESS_LOG_INTERVAL 打印一次 console 进度，并触发 videoCapturer.onProgress 供宿主提示 */
function createProgressLogger (url) {
  let last = { loaded: 0, time: Date.now() }
  return function (loaded, total) {
    const now = Date.now()
    if (now - last.time < PROGRESS_LOG_INTERVAL) return
    const deltaLoaded = loaded - last.loaded
    const deltaTime = now - last.time
    const percent = total > 0 ? (loaded / total * 100).toFixed(1) : '?'
    let remainText = '未知'
    const speed = deltaTime > 0 ? deltaLoaded / deltaTime : 0
    if (speed > 0 && total > 0 && loaded < total) {
      remainText = Math.ceil((total - loaded) / speed / 1000) + 's'
    }
    const loadedText = formatBytes(loaded)
    const totalText = formatBytes(total)
    console.info(`[videoCapturer] 下载进度 ${loadedText} / ${totalText} (${percent}%)，预计还需 ${remainText}`, url)
    if (typeof videoCapturer.onProgress === 'function') {
      videoCapturer.onProgress({ loadedText, totalText, percent, remainingText: remainText })
    }
    last = { loaded, time: now }
  }
}

/* 通过 GM_xmlhttpRequest 拉取跨域视频字节，返回 Blob；超时会真正 abort 请求并 reject */
function fetchVideoBlob (url, withCredentials, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const gm = window.GM_xmlhttpRequest
    if (typeof gm !== 'function') {
      return reject(new Error('GM_xmlhttpRequest 未注册'))
    }
    const timer = setTimeout(function () {
      /* 部分 GM 宿主无 abort() 或 gm() 返回 undefined，缺失时仅 reject（仍能靠熔断挡住后续请求） */
      if (gmRequest && typeof gmRequest.abort === 'function') gmRequest.abort()
      reject(new Error('Fetch timeout'))
    }, timeoutMs || FETCH_TIMEOUT_FALLBACK)
    const logProgress = createProgressLogger(url)
    const gmRequest = gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href },
      onprogress: (ev) => {
        if (ev && typeof ev.loaded === 'number') logProgress(ev.loaded, ev.total || 0)
      },
      onerror: (err) => {
        clearTimeout(timer)
        reject(err)
      },
      onload: (res) => {
        clearTimeout(timer)
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

/* 从 blob 前 128 字节嗅探容器扩展名；webm/mkv 同用 EBML，靠 DocType 字符串区分。
 * 嗅探不出时退回 blob.type，再退回 mp4。 */
async function sniffVideoExt (blob) {
  if (blob && blob.type) {
    const t = blob.type.split('/')[1]
    if (t && t !== 'octet-stream') return '.' + t
  }
  try {
    const buf = await blob.slice(0, 128).arrayBuffer()
    const text = new TextDecoder('latin1').decode(buf)
    if (text.indexOf('webm') !== -1) return '.webm'
    if (text.indexOf('matroska') !== -1) return '.mkv'
    if (text.indexOf('ftyp') !== -1) return '.mp4'
    if (text.indexOf('OggS') === 0) return '.ogv'
    if (text.indexOf('RIFF') === 0) return '.avi'
  } catch (e) {}
  return '.mp4'
}

function pad2 (n) { return n < 10 ? '0' + n : '' + n }

/* 文件名：优先使用页面标题（与截图命名规则一致，参考 "${document.title}_${currentTime}"），
 * 追加可读时间戳避免冲突，扩展名由 sniffVideoExt 嗅探得到 */
function getDownloadFileName (url, ext) {
  const title = (document.title || '').trim()
  const d = new Date()
  const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  const base = title || 'video_' + Date.now()
  return `${base}_${ts}${ext}`
}

/* 触发浏览器下载：把 blob 写成 objectUrl 后模拟点击 <a download>；需挂到 DOM 才在部分浏览器生效，
 * 点击后随即移除；稍后 revoke objectUrl */
async function saveBlobToLocal (blob, url) {
  const ext = await sniffVideoExt(blob)
  const objectUrl = URL.createObjectURL(blob)
  const el = document.createElement('a')
  el.href = objectUrl
  el.download = getDownloadFileName(url, ext)
  document.body.appendChild(el)
  el.click()
  el.remove()
  /* 延迟 revoke，确保浏览器已接管下载 */
  setTimeout(function () { URL.revokeObjectURL(objectUrl) }, 1000)
}

/* 缓存同一个视频源下载好的 blob 及其临时 video，保证一个影片只下载一次 */
const videoCache = new Map()

/* 大于 1G 的视频不缓存，避免内存占用过高 */
const MAX_CACHE_SIZE = 1024 * 1024 * 1024
/* 超过 4 小时没有再次截图，自动释放缓存 */
const CACHE_IDLE_TIMEOUT = 4 * 60 * 60 * 1000

/* 全量下载前探测视频大小：发 Range: bytes=0-0 请求，从 content-range 读取总大小；
 * 若服务器忽略 Range 返回完整 200，则直接复用响应体作为 blob，避免二次全量下载。
 * 返回 { size, blob }：size 为总大小（无法判断时为 0）；blob 非 null 表示已拿到完整内容。 */
function probeVideoSize (url, withCredentials) {
  return new Promise(function (resolve, reject) {
    const gm = window.GM_xmlhttpRequest
    if (typeof gm !== 'function') return resolve({ size: 0, blob: null })
    let gmRequest = null
    let timer = null
    const clearTimer = function () { if (timer) clearTimeout(timer) }
    const armTimer = function (ms) {
      clearTimer()
      timer = setTimeout(function () {
        if (gmRequest && typeof gmRequest.abort === 'function') gmRequest.abort()
        reject(new Error('Probe timeout'))
      }, ms)
    }
    armTimer(FETCH_TIMEOUT_MIN)
    gmRequest = gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href, Range: 'bytes=0-0' },
      /* 探测为 Range: bytes=0-0 的单字节请求，不挂 onprogress，避免误报"下载进度"提示 */
      onreadystatechange: function () {
        /* 服务器忽略 Range 返回完整 200 时，按 Content-Length 估算耗时并放宽超时，
         * 避免慢大文件在下载中途被 30s 超时 abort 后又要重下一次全量 GET */
        if (gmRequest && gmRequest.readyState >= 2 && gmRequest.status === 200) {
          const hdrs = typeof gmRequest.responseHeaders === 'string' ? gmRequest.responseHeaders : ''
          const lm = hdrs.toLowerCase().match(/content-length:\s*(\d+)/)
          if (lm) {
            const size = parseInt(lm[1], 10)
            const estMs = Math.max(FETCH_TIMEOUT_MIN, Math.min(Math.ceil(size / (100 * 1024)) * 1000, FETCH_TIMEOUT_FALLBACK))
            armTimer(estMs)
          }
        }
      },
      onerror: () => {
        clearTimer()
        resolve({ size: 0, blob: null })
      },
      onload: (res) => {
        clearTimer()
        if (res.status >= 400) return resolve({ size: 0, blob: null })
        const headers = typeof res.responseHeaders === 'string' ? res.responseHeaders : ''
        const lower = headers.toLowerCase()
        const rangeMatch = lower.match(/content-range:\s*bytes\s+0-0\/(\d+)/)
        if (rangeMatch) return resolve({ size: parseInt(rangeMatch[1], 10), blob: null })
        if (res.status === 200) {
          /* 服务器忽略 Range 返回完整响应：复用该响应体，不再发全量下载请求 */
          const blob = new Blob([res.response])
          return resolve({ size: blob.size, blob })
        }
        const lengthMatch = lower.match(/content-length:\s*(\d+)/)
        if (lengthMatch) return resolve({ size: parseInt(lengthMatch[1], 10), blob: null })
        resolve({ size: 0, blob: null })
      }
    })
  })
}

/* 当切换到新视频源时，释放旧视频占用的内存，避免一个页面累计下载多部影片；
 * 在途下载（record.promise 仍 pending）的记录不驱逐，避免其完成后 objectUrl/blob 泄漏 */
function evictOtherVideos (keepUrl) {
  videoCache.forEach(function (record, key) {
    if (key !== keepUrl && record.promise === null && record.objectUrl && !record.inUse) {
      URL.revokeObjectURL(record.objectUrl)
      videoCache.delete(key)
    }
  })
}

/* 释放超过 CACHE_IDLE_TIMEOUT 未被使用的缓存记录 */
function evictExpiredCache () {
  const now = Date.now()
  videoCache.forEach(function (record, key) {
    if (now - record.lastUsed > CACHE_IDLE_TIMEOUT && !record.inUse) {
      if (record.objectUrl) URL.revokeObjectURL(record.objectUrl)
      videoCache.delete(key)
    }
  })
  /* 顺带清掉已过冷却期的失败源记录，避免 failedSrc 无界增长 */
  failedSrc.forEach(function (ts, key) {
    if (now - ts >= RETRY_COOLDOWN) failedSrc.delete(key)
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
      URL.revokeObjectURL(objectUrl)
      reject(new Error('视频解码失败'))
    }, { once: true })
  })
}

/* 获取（或下载并缓存）视频源对应的临时 video；统一写入 videoCache 用于并发去重，
 * record.cacheable 标记是否长期驻留，非缓存记录同样驻留至 evictOtherVideos/evictExpiredCache/pagehide 清理 */
function getCachedVideo (srcUrl, options) {
  options = options || {}
  const cacheable = !!options.cacheable
  const cached = videoCache.get(srcUrl)
  if (cached) {
    cached.lastUsed = Date.now()
    return cached.promise || Promise.resolve(cached)
  }

  const record = { promise: null, blob: null, videoEl: null, objectUrl: '', lastUsed: Date.now(), cacheable, inUse: 0, saved: false }
  videoCache.set(srcUrl, record)
  record.promise = (options.existingBlob
    ? Promise.resolve(options.existingBlob)
    : fetchVideoBlob(srcUrl, options.withCredentials, options.timeoutMs))
    .then(function (blob) {
      record.blob = blob
      return loadVideoFromBlob(blob)
    })
    .then(function (loaded) {
      record.videoEl = loaded.videoEl
      record.objectUrl = loaded.objectUrl
      record.promise = null
      failedSrc.delete(srcUrl)
      return record
    })
    .catch(function (err) {
      failedSrc.set(srcUrl, Date.now())
      videoCache.delete(srcUrl)
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
async function captureViaBlob (video, title, enableCrossOriginCapture, withCredentials) {
  const srcUrl = getVideoSourceUrl(video)
  /* HLS/MSE/DASH 等非直链源无法通过重拉 blob 绕过 CORS（m3u8 为播放列表文本，
   * 拉回后无法解码），且重拉会造成无谓的全量下载与解码报错，故直接短路退回预览 */
  if (!srcUrl) return null
  if (!/^https?:/i.test(srcUrl)) return null
  if (/\.m3u8($|\?)/i.test(srcUrl)) return null

  /* 熔断：冷却期内同一源不再重试，避免反复重试浪费流量 */
  if (failedSrc.has(srcUrl) && (Date.now() - failedSrc.get(srcUrl)) < RETRY_COOLDOWN) {
    console.warn('[captureViaBlob] fused source, skip until cooldown', srcUrl)
    const fusedErr = new CaptureFusedError()
    fusedErr.fused = true
    throw fusedErr
  }

  evictExpiredCache()
  evictOtherVideos(srcUrl)

  /* 仅缓存未命中时才探测大小：命中（含仍 pending 的在途记录）直接复用，避免每次截图多打一次 Range 请求；
   * 超 1G 或无法探测大小的视频不缓存 */
  const cached = videoCache.get(srcUrl)
  let probedBlob = null
  let cacheable = false
  /* cacheable 仅未命中时生效：getCachedVideo 命中分支早返回并忽略 options.cacheable */
  if (!cached) {
    const probe = await probeVideoSize(srcUrl, withCredentials)
    probedBlob = probe.blob
    cacheable = probe.size > 0 && probe.size <= MAX_CACHE_SIZE
  }

  /* 超时随视频时长动态调整：max(30s, 时长/2)，时长未知时退回 5 分钟 */
  const duration = video.duration
  const timeoutMs = Math.max(FETCH_TIMEOUT_MIN, (isFinite(duration) && duration > 0) ? duration * 1000 / 2 : FETCH_TIMEOUT_FALLBACK)

  const record = await getCachedVideo(srcUrl, { withCredentials, cacheable, timeoutMs, existingBlob: probedBlob })
  /* 下载成功后驱逐其它已落定的旧视频，避开在途记录，避免被驱逐后仍完成下载造成泄漏 */
  evictOtherVideos(srcUrl)
  /* 绘制期间自增 inUse，阻止其它 URL 的并发截图驱逐本记录 objectUrl，绘制完成后再放行 */
  record.inUse = (record.inUse || 0) + 1
  try {
    await seekVideo(record.videoEl, video.currentTime || 0)
    const canvas = drawVideoToCanvas(record.videoEl)
    /* 自动保存：开启 autoDownloadCachedVideo 且该视频尚未保存过时，才把视频保存到本地；
     * 已缓存且已保存的记录，后续截图只截画面，不再重复下载视频 */
    if (videoCapturer.autoDownloadCachedVideo && record.blob && !record.saved) {
      saveBlobToLocal(record.blob, srcUrl)
      record.saved = true
    }
    return { canvas, title }
  } finally {
    record.inUse = Math.max(0, (record.inUse || 0) - 1)
  }
}

const videoCapturer = {
  /* 熔断提示钩子：被熔断拦截时由宿主注入提示逻辑（如 tips 弹窗） */
  onFused: null,
  /* 下载进度钩子：由宿主注入，接收 { loadedText, totalText, percent, remainingText } */
  onProgress: null,
  /* 跨CORS拉取完成后是否自动把视频保存到本地（由宿主根据配置注入，默认关闭，避免截图意外下载整个视频） */
  autoDownloadCachedVideo: false,
  /**
   * 进行截图操作
   * @param video {dom} -必选 video dom 标签
   * @param download {boolean} -是否下载截图
   * @param title {string} -截图标题
   * @param enableCrossOriginCapture {boolean} -canvas被CORS污染时，是否重拉视频源绕开限制下载
   * @param withCredentials {boolean} -重拉视频源时是否携带 Cookie 凭据
   * @returns {boolean}
   */
  capture (video, download, title, enableCrossOriginCapture, withCredentials) {
    if (!video) return false
    const t = this
    const currentTime = `${Math.floor(video.currentTime / 60)}'${(video.currentTime % 60).toFixed(3)}''`
    const captureTitle = title || `${document.title}_${currentTime}`

    /* 截图核心逻辑
     * 注意：不再对 video 设置 crossorigin="anonymous"——视频加载完成后设置该属性
     * 只会强制视频以 CORS 模式重载，导致跨域源（如 anime1）反复报错并中断播放，
     * 且对已污染的 canvas 无效（见 PR #1 审查） */
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    if (download) {
      t.download(canvas, captureTitle, video, false, enableCrossOriginCapture, withCredentials)
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
  download (canvas, title, video, noFallback, enableCrossOriginCapture, withCredentials) {
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
        captureViaBlob(video, title, enableCrossOriginCapture, withCredentials)
          .then(function (result) {
            if (!result) return videoCapturer.previe(canvas, title)
            videoCapturer.download(result.canvas, result.title, video, true, enableCrossOriginCapture, withCredentials)
          })
          .catch(function (err) {
            if (err && err.fused && typeof videoCapturer.onFused === 'function') {
              videoCapturer.onFused()
            }
            console.error('重拉视频源失败，退回预览。', err)
            videoCapturer.previe(canvas, title)
          })
      } else {
        videoCapturer.previe(canvas, title)
      }
    }
  },
  /**
   * 把已载入内存（videoCache）的视频源下载到本地，命中缓存直接复用 blob（不重新请求）。
   * @param video {dom} -必选 video dom 标签
   * @param onlyIfCached {boolean} -为 true 时仅在已缓存（已 fetch）的情况下下载，未缓存则不拉取
   * @param withCredentials {boolean} -拉取时是否携带 Cookie 凭据，与截图路径 enhance.captureWithCredentials 保持一致
   * @returns {boolean} 是否成功触发（仅判断缓存命中与否，异步下载结果见控制台）
   */
  downloadVideo (video, onlyIfCached, withCredentials) {
    const srcUrl = getVideoSourceUrl(video)
    if (!srcUrl) return false
    if (!/^https?:/i.test(srcUrl)) return false
    if (/\.m3u8($|\?)/i.test(srcUrl)) return false

    const cached = videoCache.get(srcUrl)
    if (cached && cached.blob) {
      saveBlobToLocal(cached.blob, srcUrl)
      cached.saved = true
      return true
    }
    if (onlyIfCached) return false
    /* 用户显式发起的下载：有意绕过 MAX_CACHE_SIZE 守卫（截图路径才拒绝缓存超大源），
     * 超时随视频时长动态调整（与 captureViaBlob 一致） */
    const duration = video.duration
    const timeoutMs = Math.max(FETCH_TIMEOUT_MIN, (isFinite(duration) && duration > 0) ? duration * 1000 / 2 : FETCH_TIMEOUT_FALLBACK)
    getCachedVideo(srcUrl, { withCredentials: !!withCredentials, cacheable: true, timeoutMs })
      .then(function (record) {
        if (record.blob) {
          saveBlobToLocal(record.blob, srcUrl)
          record.saved = true
        }
      })
      .catch(function (err) {
        console.error('[videoCapturer] 下载视频失败。', err)
      })
    return true
  }
}

/* 页面卸载时释放所有缓存：revoke objectURL、清空临时 video 解码、清空缓存 */
window.addEventListener('pagehide', function () {
  videoCache.forEach(function (record) {
    if (record.objectUrl) URL.revokeObjectURL(record.objectUrl)
    if (record.videoEl) {
      record.videoEl.src = ''
      record.videoEl.load()
    }
  })
  videoCache.clear()
  failedSrc.clear()
}, { once: true })

export default videoCapturer
