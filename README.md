# atoolne storage · KV 版（免绑卡）

给 [atoolne](https://www.atoolne.com) 使用的私人文件仓库部署模板 —— **不需要银行卡的版本**。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fallhmhz/atoolne-storage-kv)

## 选哪个版本

| | R2 版 | **KV 版（这个）** |
|---|---|---|
| 开通要不要绑卡 | 要，而且得是能在境外网站付款的卡 | **不要** |
| 免费空间 | 10 GB | 1 GB |
| 单个文件 | 25 MB | 25 MB |

在 atoolne 里两者用法完全一样，分享出去的链接也一样。
有双币卡或 PayPal、想要更大空间，用 [R2 版](https://github.com/fallhmhz/atoolne-storage-template)；
没有，就用这个。

## KV 版的额度（Cloudflare 免费版）

- 总共 **1 GB**，单个文件最大 **25 MB**
- 每天最多 **1000 次上传**、**1000 次删除**、**10 万次读取**（北京时间每天早上 8 点重置）
- **刚上传的文件，在别的地区可能要等最多约 1 分钟才打得开。** 上传完马上点开偶尔会看到「文件不存在」，稍等一下就好

Cloudflare 的免费额度和计费规则可能变化，请以 Cloudflare 控制台当时显示的内容为准。

## 部署

1. 点击上面的 **Deploy to Cloudflare**。
2. 登录 Cloudflare 和 GitHub。Cloudflare 会从模板创建一份 Private 仓库。
3. `UPLOAD_KEY` 请自己填写一串足够长的随机口令，并先保存好。不要使用示例文字，也不要与别人共用。
4. KV 会自动新建，**不用选、也不用开通 R2**。
5. 等待部署完成后会得到类似这样的地址：
   `https://atoolne.你的名字.workers.dev`
6. 回到 atoolne 的「存储设置」，填入 Worker 地址和 `UPLOAD_KEY`，再点「测试连接」。

## 以后想换成 R2

不用搬文件。另外部署一个 R2 版，在 atoolne 里**添加第二个仓库**并设为默认就行。
已经传在 KV 里的文件会一直留在原来的仓库里，旧链接照常能打开。

## 文件链路

上传时，浏览器会把文件直接发送到你的 Worker，再写入你的私人 KV。atoolne 的服务器不接收文件字节，也拿不到明文 `UPLOAD_KEY`。

分享时，atoolne 统一生成 `https://file.atoolne.com/f/文件名`，从你的 Worker 读取文件并返回。分享者不会看到你的 Worker 地址。

## Worker 接口

| 接口 | 用途 |
|---|---|
| `GET /` | 检查 Worker 是否运行 |
| `GET /_ping` | 检查 `UPLOAD_KEY` 是否正确 |
| `GET /f/<名字>` | 公开读取 |
| `PUT /<名字>` | 上传，需要 `x-upload-key` |
| `DELETE /<名字>` | 删除，需要 `x-upload-key` |

## 忘记 UPLOAD_KEY

进入 Cloudflare 对应 Worker 的 **Settings → Variables and Secrets**，重新设置 `UPLOAD_KEY`，再回到 atoolne 更新仓库口令。不影响已经存的文件。
