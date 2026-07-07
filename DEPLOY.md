# 学霸直聘 — 部署指南

## 方案对比

| 方案 | 成本 | 部署难度 | 延迟(国内) | 推荐指数 |
|------|------|----------|-----------|---------|
| **腾讯云 Lighthouse** | ¥50/月起 | ⭐ 简单 | 低 | ⭐⭐⭐⭐⭐ |
| **腾讯云 CVM** | ¥100/月起 | ⭐⭐ 中等 | 低 | ⭐⭐⭐⭐ |
| **腾讯云 CloudBase** | 有免费额度 | ⭐⭐⭐ 需改造代码 | 低 | ⭐⭐⭐ |
| **Render.com** | 免费额度 | ⭐ 简单 | 较高(海外) | ⭐⭐ |
| **Railway.app** | 免费试用 | ⭐ 简单 | 较高(海外) | ⭐⭐ |

> **强烈推荐腾讯云 Lighthouse** — 国内延迟最低、成本最低、微信生态天然集成。

---

## 方案 A：腾讯云 Lighthouse（推荐）

### 步骤 1：购买轻量应用服务器

1. 登录 [腾讯云控制台](https://console.cloud.tencent.com/lighthouse)
2. 点击「新建」创建轻量应用服务器
3. 选择配置：
   - **地域**：北京/上海/广州（选离你最近的）
   - **镜像**：Ubuntu 22.04 或 Docker 镜像
   - **套餐**：2核2G（¥50/月）足够运行本项目
4. 创建完成后记下 **公网 IP**（如 `43.136.xxx.xxx`）

### 步骤 2：上传项目文件

方式一：通过 SCP 上传（推荐）
```bash
# 在你的电脑上运行
scp -r tutor-parent-prototype/* root@<服务器IP>:/opt/xueba/
```

方式二：通过 SSH + Git
```bash
ssh root@<服务器IP>
# 如果项目在 GitHub/Gitee 上
git clone <你的仓库地址> /opt/xueba
```

方式三：通过腾讯云 OrcaTerm（Web 终端）
1. 在 Lighthouse 控制台点击「登录」
2. 使用 Web 终端手动上传文件

### 步骤 3：一键部署

```bash
ssh root@<服务器IP>
cd /opt/xueba
bash deploy.sh
```

脚本会自动：
- 安装 Docker（如果未安装）
- 构建项目镜像
- 启动服务
- 验证运行状态

### 步骤 4：手机访问

直接打开浏览器访问：
```
http://<服务器公网IP>:3000
```

管理后台：
```
http://<服务器公网IP>:3000/admin.html
```

### 步骤 5（可选）：配置域名 + HTTPS

1. 在腾讯云购买域名（如 `xueba.cn`）
2. 在 DNS 解析中添加 A 记录指向服务器 IP
3. 申请 [腾讯云免费 SSL 证书](https://console.cloud.tencent.com/ssl)
4. 在服务器上安装 nginx：
   ```bash
   apt install nginx
   cp nginx/xueba.conf /etc/nginx/sites-available/
   ln -s /etc/nginx/sites-available/xueba.conf /etc/nginx/sites-enabled/
   # 修改配置中的域名和证书路径
   nginx -t && systemctl reload nginx
   ```
5. 配置完成后访问：`https://xueba.cn`

### 防火墙配置

在 Lighthouse 控制台的「防火墙」中添加规则：
- TCP 3000 端口（直接访问）
- 或 TCP 80/443 端口（nginx 代理后）

---

## 方案 B：Render.com（免费快速测试）

适合临时测试，海外服务器国内延迟较高。

### 步骤

1. 将项目推到 GitHub
2. 登录 [Render.com](https://render.com)
3. 点击「New → Web Service」
4. 连接 GitHub 仓库
5. 配置：
   - **Build Command**: `cd server && npm install`
   - **Start Command**: `cd server && node app.js`
   - **Environment**: `PORT=3000`
6. 部署完成后获得 URL（如 `https://xueba.onrender.com`）

### 前端 API 配置

由于前端和后端在同一个 Render 服务上，`API_BASE = window.location.origin` 自动生效。

---

## 方案 C：腾讯云 CloudBase（长期方案）

适合正式上线后对接微信小程序。需要改造代码。

### 需要的改造

1. Express 路由拆分为独立云函数
2. SQLite → CloudBase 云数据库（MongoDB 兼容）
3. 前端引入 CloudBase JS SDK

> 这部分改动较大，建议在原型验证完成后再进行。

---

## 数据备份

SQLite 数据库文件位于 Docker 容器的 `/app/data/data.db`。

### 手动备份
```bash
# 从容器中复制数据库
docker cp xueba-server:/app/data/data.db ./backup-$(date +%Y%m%d).db
```

### 定时备份（可选）
```bash
# 添加 cron 任务，每天凌晨3点备份
echo "0 3 * * * docker cp xueba-server:/app/data/data.db /opt/xueba/backup-\$(date +\%Y\%m\%d).db" | crontab -
```

---

## 运维命令

```bash
# 查看日志
docker compose logs -f

# 重启服务
docker compose restart

# 更新代码后重建
docker compose down
docker compose build
docker compose up -d

# 查看数据库数据
docker exec xueba-server node -e "
  const db = require('better-sqlite3')('/app/data/data.db');
  console.log('用户:', db.prepare('SELECT count(*) as c FROM users').get());
  console.log('需求:', db.prepare('SELECT count(*) as c FROM needs').get());
  console.log('申请:', db.prepare('SELECT count(*) as c FROM applications').get());
"
```
