# Keep the tag in step with the exact playwright version in package.json (browsers ship in the image).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=pwuser:pwuser . .
USER pwuser
EXPOSE 8080
CMD ["node", "server.js"]
