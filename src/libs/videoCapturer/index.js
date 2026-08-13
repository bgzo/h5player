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

/* 通过 GM_xmlhttpRequest 拉取跨域视频字节，返回 Blob；超时会真正 abort 请求并 reject */
function fetchVideoBlob (url, withCredentials, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const gm = window.GM_xmlhttpRequest
    if (typeof gm !== 'function') {
      return reject(new Error('GM_xmlhttpRequest 未注册'))
    }
    const timer = setTimeout(function () {
      /* 部分 GM 宿主无 abort()，缺失时仅 reject（仍能靠熔断挡住后续请求） */
      if (typeof gmRequest.abort === 'function') gmRequest.abort()
      reject(new Error('Fetch timeout'))
    }, timeoutMs || FETCH_TIMEOUT_FALLBACK)
    const gmRequest = gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href },
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
    const timer = setTimeout(function () {
      if (typeof gmRequest.abort === 'function') gmRequest.abort()
      reject(new Error('Probe timeout'))
    }, FETCH_TIMEOUT_MIN)
    const gmRequest = gm({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      withCredentials,
      headers: { Referer: location.href, Range: 'bytes=0-0' },
      onerror: () => {
        clearTimeout(timer)
        resolve({ size: 0, blob: null })
      },
      onload: (res) => {
        clearTimeout(timer)
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
    if (key !== keepUrl && record.promise === null && record.objectUrl) {
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

  const record = { promise: null, videoEl: null, objectUrl: '', lastUsed: Date.now(), cacheable }
  videoCache.set(srcUrl, record)
  record.promise = (options.existingBlob
    ? Promise.resolve(options.existingBlob)
    : fetchVideoBlob(srcUrl, options.withCredentials, options.timeoutMs))
    .then(loadVideoFromBlob)
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
  if (cached) {
    cacheable = cached.cacheable
  } else {
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
  await seekVideo(record.videoEl, video.currentTime || 0)
  const canvas = drawVideoToCanvas(record.videoEl)
  return { canvas, title }
}

var videoCapturer = {
  /* 熔断提示钩子：被熔断拦截时由宿主注入提示逻辑（如 tips 弹窗） */
  onFused: null,
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
