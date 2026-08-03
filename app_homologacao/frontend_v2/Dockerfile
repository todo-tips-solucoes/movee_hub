FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV BACKEND_URL=https://envmassapihomologacao.todo-tips.com
# `NEXT_PUBLIC_*` é INLINADA no bundle do cliente em tempo de build — não se
# resolve por env do serviço no Swarm. Sem esta linha a var ficava ausente na
# imagem de produção e o fail-safe do `components/hub/env-badge.tsx` exibia
# "HOMOLOGAÇÃO — dados fictícios" para os clientes, sobre os dados reais deles.
# Default `production` porque ESTE Dockerfile é só de produção (fixa a URL da
# API de produção logo acima). O `Dockerfile.hub` segue SEM default — lá a
# ausência da var deve mesmo acender o banner.
ARG NEXT_PUBLIC_APP_ENV=production
ENV NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV BACKEND_URL=https://envmassapihomologacao.todo-tips.com
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
