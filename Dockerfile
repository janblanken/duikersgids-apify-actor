FROM apify/actor-node:20 AS builder

COPY package*.json tsconfig.json ./
RUN npm install --include=dev --audit=false

COPY . ./
RUN npm run build

FROM apify/actor-node:20

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true)

COPY --from=builder /usr/src/app/dist ./dist
COPY .actor ./.actor

CMD ["npm", "run", "start:prod"]
