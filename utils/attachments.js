/**
 * 待办附件：图片 + 位置。
 *
 * 图片走云开发存储：wx.chooseMedia 选图 → wx.cloud.uploadFile 上传 →
 * 只把返回的 fileID 存进 todo.images。fileID 是永久地址，
 * <image src="{{fileID}}"> 可直接渲染，不用再换临时链接。
 *
 * 位置用 wx.chooseLocation 选点，存 { name, address, latitude, longitude }，
 * 点击时用 wx.openLocation 打开地图。
 *
 * 注意：这两个能力都属于微信**隐私接口**，必须在公众平台
 * 「服务内容声明 → 用户隐私保护指引」里声明后才能调用，否则真机上会直接失败。
 */
const { cloud } = require('./cloud')

/** 单条待办最多几张图 */
const MAX_IMAGES = 9

/** 从临时路径取扩展名，取不到就当 png */
function extOf(filePath) {
  const parts = String(filePath || '').split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'png'
}

/** 云端路径：按时间戳+随机串命名，避免多用户互相覆盖 */
function cloudPathOf(filePath) {
  const rand = Math.random().toString(36).slice(2, 10)
  return 'kiwi-todo/' + Date.now() + '-' + rand + '.' + extOf(filePath)
}

/**
 * 选择图片并上传到云存储。
 * @param {Array<string>} current 已有的 fileID 列表
 * @returns {Promise<Array<string>>} 追加后的 fileID 列表
 */
async function chooseAndUpload(current) {
  const list = Array.isArray(current) ? current : []
  const remain = MAX_IMAGES - list.length
  if (remain <= 0) {
    throw new Error('最多添加 ' + MAX_IMAGES + ' 张图片')
  }

  const picked = await new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: resolve,
      fail: reject,
    })
  })

  const files = picked.tempFiles || []
  const ids = []
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i].tempFilePath
    // 单张失败不拖累其他张
    try {
      const up = await cloud.uploadFile({
        cloudPath: cloudPathOf(filePath),
        filePath: filePath,
      })
      if (up && up.fileID) ids.push(up.fileID)
    } catch (e) {
      console.error('[attachments] 上传失败：', e)
    }
  }

  if (ids.length === 0 && files.length > 0) {
    throw new Error('图片上传失败，请检查云存储权限后重试')
  }
  return list.concat(ids)
}

/** 全屏预览图片 */
function previewImage(urls, current) {
  if (!urls || !urls.length) return
  wx.previewImage({ urls: urls, current: current || urls[0] })
}

/**
 * 选择位置。用户取消会 reject（fail 回调），调用方要区分处理。
 * @returns {Promise<{name:string,address:string,latitude:number,longitude:number}>}
 */
function chooseLocation() {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({ success: resolve, fail: reject })
  })
}

/** 打开地图查看位置 */
function openLocation(loc) {
  if (!loc) return
  wx.openLocation({
    latitude: Number(loc.latitude),
    longitude: Number(loc.longitude),
    name: String(loc.name || '待办位置'),
    address: String(loc.address || ''),
    scale: 18,
  })
}

module.exports = {
  MAX_IMAGES: MAX_IMAGES,
  chooseAndUpload: chooseAndUpload,
  previewImage: previewImage,
  chooseLocation: chooseLocation,
  openLocation: openLocation,
}
