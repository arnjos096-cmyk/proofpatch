FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY examples ./examples
RUN npm run build && npm prune --omit=dev && chown -R node:node /app
USER node
ENV PROOFPATCH_HOST=0.0.0.0
EXPOSE 4317
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["demo", "--serve"]
