# 学霸直聘 · 全系统说明

## 项目概述
家教撮合平台，家长发布需求直接对接高校学生，省掉中介费。包含前端原型 + 后端 API + 管理后台。

## 架构
- **前端**：`index.html` — 单页 HTML 原型，家长端 + 大学生端，接真实 API
- **后端**：`server/app.js` — Node.js + Express + SQLite，完整 CRUD API
- **管理后台**：`admin.html` — 管理员查看全量数据、统计、导出 CSV
- **部署**：`Dockerfile` + `docker-compose.yml` + `deploy.sh` — 一键部署到腾讯云

## 功能清单

### 家长端
- 身份选择 → 填昵称+城市注册 → 进入家长首页
- 发布需求：填标题、地区、年级、科目、课时费、上课地址（快捷标签）、学生情况、要求 → POST /api/needs
- 我的最新需求列表（GET /api/needs, 按 user_id 筛选）
- 个人中心：显示昵称、城市、需求统计
- 退出登录：清除 localStorage 回到身份选择页

### 大学生端
- 身份选择 → 填昵称+城市注册 → 进入找单首页
- 浏览需求列表（GET /api/needs?status=active），支持科目筛选
- 需求详情页（GET /api/needs/:id），动态渲染
- 申请试课（POST /api/applications），防重复申请
- 我的简历（POST /api/resumes），擅长科目标签多选
- 申请记录（GET /api/applications?user_id=X），4 种状态显示
- 个人中心：统计已申请/已被选中
- 退出登录：清除 localStorage 回到身份选择页

### 管理后台 (admin.html)
- 数据总览：4 项统计卡片（总用户/总需求/总申请/平均课时费）
- 分布图表：科目分布、年级分布、地区分布
- 需求列表：筛选+CSV 导出
- 申请列表：筛选+CSV 导出
- 用户列表：含简历摘要+CSV 导出
- 自动 30 秒刷新

## 已移除功能
- **地图选点**：改为纯地址文本输入 + 快捷标签
- **收入统计**：大学生端移除了「预估月收入」和「收入统计」菜单项

## 数据保存机制
- SQLite 数据库（data.db），自动创建 4 张表：users/needs/applications/resumes
- 所有用户操作通过 API 真实入库
- 管理员通过 admin.html 可查看全部数据
- 支持 CSV 导出

## API 配置
前端 `API_BASE` 支持三种配置方式：
1. URL 参数：`?api=https://your-server.com` — 优先级最高
2. 当前域名：`window.location.origin` — 默认值（前后端同域时自动生效）
3. 直接修改代码中的默认值

## 本地运行
```bash
cd tutor-parent-prototype/server
node app.js
# 打开 http://localhost:3000 → 前端
# 打开 http://localhost:3000/admin.html → 管理后台
```

## 云端部署（腾讯云 Lighthouse）

详见 `DEPLOY.md`，快速步骤：
1. 购买腾讯云轻量应用服务器（2核2G，¥50/月）
2. 上传项目文件到 `/opt/xueba/`
3. 运行 `bash deploy.sh`
4. 手机访问 `http://<服务器IP>:3000`

## 管理后台入口
admin.html 是公开页面，建议生产环境添加 PIN/密码保护。

## 项目文件结构
```
tutor-parent-prototype/
├── index.html          # 前端（家长端 + 大学生端）
├── admin.html          # 管理后台
├── server/
│   ├── app.js          # 后端 API 服务
│   ├── package.json    # Node.js 依赖
│   └── data.db         # SQLite 数据库（运行时自动创建）
├── Dockerfile          # Docker 镜像定义
├── docker-compose.yml  # Docker Compose 配置
├── deploy.sh           # 一键部署脚本
├── .dockerignore       # Docker 构建排除
├── nginx/
│   └── xueba.conf      # Nginx 反向代理配置模板
├── DEPLOY.md           # 部署指南（详细）
└── overview.md         # 本文件
```
