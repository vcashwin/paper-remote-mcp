# paper-remote-mcp serve: the hosted remote MCP server. See DEPLOYMENT.md.
# The Playwright image ships Node and the Chromium build matching the locked playwright version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 PAPER_MCP_DATA=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.js", "serve"]
