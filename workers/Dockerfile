# Site Provisioner Worker — Azure Container App image.
# Uses Microsoft's official Playwright image which ships Chromium + system deps.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Copy only what the worker needs — not the whole arion-api tree.
# (Container Apps deployment script can rsync the right subset, or we can
# expand to the whole repo and trim with .dockerignore.)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

# Copy worker + the lib modules it imports
COPY workers/ ./workers/
COPY lib/hostinger.js ./lib/

ENV NODE_ENV=production
ENV PROVISIONER_PORT=8080
EXPOSE 8080

# Container Apps expects the listener on a single port, no graceful-shutdown
# hooks needed because Playwright cleans up on SIGTERM.
CMD ["node", "workers/siteProvisioner.js"]
