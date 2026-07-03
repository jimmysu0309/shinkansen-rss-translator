# Shinkansen RSS Translator — 多階段建置
# builder 階段裝原生模組編譯工具(better-sqlite3),runtime 階段只留成品 → image 較小。

# ---- builder ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 原生編譯需要 python3 / make / g++(若 npm 抓到 prebuilt 就不會用到,留著保險)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# 原生模組在 builder 編好,直接搬(base 相同、glibc 相容)
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY vendor ./vendor
RUN mkdir -p /app/data
EXPOSE 8088
CMD ["node", "src/server.js"]
