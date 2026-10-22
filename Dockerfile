FROM node:22-alpine

WORKDIR /app
COPY . .

ENV PORT=3000
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
