#!/bin/bash
# =============================================
# 学霸直聘 — 一键部署脚本
# 适用于腾讯云 Lighthouse / 任何 Linux 服务器
# =============================================

set -e

echo "🚀 学霸直聘 — 开始部署..."
echo ""

# 1. Check if Docker is installed
if ! command -v docker &> /dev/null; then
  echo "📦 Docker 未安装，正在安装..."
  # Ubuntu/Debian
  if command -v apt-get &> /dev/null; then
    apt-get update
    apt-get install -y docker.io docker-compose-plugin
    systemctl start docker
    systemctl enable docker
    echo "✅ Docker 已安装"
  # CentOS
  elif command -v yum &> /dev/null; then
    yum install -y docker docker-compose-plugin
    systemctl start docker
    systemctl enable docker
    echo "✅ Docker 已安装"
  else
    echo "❌ 无法自动安装 Docker，请手动安装后重新运行此脚本"
    exit 1
  fi
else
  echo "✅ Docker 已安装"
fi

# 2. Check if docker compose is available
if ! docker compose version &> /dev/null; then
  echo "📦 Docker Compose 未安装，正在安装..."
  if command -v apt-get &> /dev/null; then
    apt-get install -y docker-compose-plugin
  elif command -v yum &> /dev/null; then
    yum install -y docker-compose-plugin
  fi
fi
echo "✅ Docker Compose 已就绪"

# 3. Clone or upload project
PROJECT_DIR="/opt/xueba"
if [ ! -d "$PROJECT_DIR" ]; then
  echo "📂 创建项目目录: $PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
fi

# 4. Copy project files (assumes files are in current directory)
echo "📂 复制项目文件..."
cp -r . "$PROJECT_DIR/"
cd "$PROJECT_DIR"

# 5. Build and start
echo "🔨 构建 Docker 镜像..."
docker compose build

echo "🚀 启动服务..."
docker compose up -d

# 6. Wait for health check
echo "⏳ 等待服务启动..."
sleep 5

# 7. Check if service is running
if curl -s http://localhost:3000/api/admin/stats > /dev/null 2>&1; then
  echo ""
  echo "🎉 部署成功！"
  echo ""
  echo "============================================="
  echo "  用户端:  http://<服务器IP>:3000"
  echo "  管理后台: http://<服务器IP>:3000/admin.html"
  echo "============================================="
  echo ""
  echo "💡 手机访问: 把 <服务器IP> 替换为你的服务器公网 IP"
  echo "💡 安全建议: 建议配置 nginx 反向代理 + HTTPS"
  echo ""
else
  echo "❌ 服务启动失败，请检查日志："
  echo "   docker compose logs"
  exit 1
fi
