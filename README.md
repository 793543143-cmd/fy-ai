# FYAI 视频工作台

这是一个内部视频生成工作台，支持 PoYo / Sora 2 和火山 / Seedance 2.0，并带有任务流水、用量统计、下载记录和账号审批。

## 本地启动

1. 复制 `.env.example` 为 `.env.local`
2. 在 `.env.local` 里填入至少一个模型密钥
3. 运行：

```bash
npm start
```

打开：

```text
http://localhost:4173
```

## 公网部署前要改的地方

如果要部署到 GitHub + 云平台，不要直接照搬本地模式，至少先设置这些环境变量：

```bash
APP_ENV=production
FYAI_ADMIN_PASSWORD=你自己的管理员密码
FYAI_ALLOW_LOCAL_ADMIN=false
FYAI_ALLOW_RUNTIME_KEY_WRITE=false
FYAI_SAVE_OUTPUTS=false
FYAI_COOKIE_SECURE=true
```

说明：

- `FYAI_ALLOW_LOCAL_ADMIN=false`
  关闭“本机免登录”，避免公网实例直接绕过登录。
- `FYAI_ALLOW_RUNTIME_KEY_WRITE=false`
  关闭网页里直接改密钥，改为在部署平台环境变量里管理。
- `FYAI_SAVE_OUTPUTS=false`
  云端通常不适合长期保存本地视频文件，建议让用户直接下载到自己的电脑。
- `FYAI_ADMIN_PASSWORD`
  生产环境必须显式设置，不再建议使用默认管理员密码。
- `FYAI_DATA_DIR`
  如果你的部署平台支持持久磁盘，把它指向持久目录，避免重启后账号、任务、审批记录丢失。

## 当前存储方式

- 用户、任务、审批、下载记录：保存在 `data/store.json`
- 本地缓存视频：保存在 `outputs/`

如果是正式公网多人使用，下一步建议把 `store.json` 换成数据库。

## 使用方式

- 直接在“视频提示词”里填写 prompt
- 选择模型、秒数、尺寸、清晰度、一次生成数量
- 可选上传参考图；火山支持多图引用，PoYo 按接口能力降级处理
- 任务会进入统一流水表，同时保留批次号。你可以看总数，也可以按批次、提示词筛选统计。

## 条数和积分

- “一次生成数量”表示当前提示词一次要生成几条。
- 页面会实时显示本批条数、单条预计积分、本批预计积分。
- 点“同步积分”可以通过 PoYo 的 `/api/user/balance` 读取账户余额；真实提交前后端也会再校验一次预计积分。
- PoYo 文档说明任务 `finished` 后才扣积分，失败任务不扣积分。

## PoYo 模型

常用模型：

- `sora-2-official`
- `sora-2-pro-official`

Pro 模型支持 `720p`、`1024p`、`1080p`。工具里会按公开价格做积分估算，实际扣费以 PoYo 后台为准。

## 下载与保存

任务完成后点“保存”，视频会直接下载到使用者自己的电脑。

如果 `FYAI_SAVE_OUTPUTS=true`，服务端也会额外缓存到 `outputs/` 目录；
如果 `FYAI_SAVE_OUTPUTS=false`，只保留下载记录，不在服务器落地视频文件。
