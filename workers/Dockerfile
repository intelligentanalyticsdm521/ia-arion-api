# Site Provisioner Worker — Azure Container App image.
# Uses Microsoft's official Playwright image which ships Chromium + system deps.
# Base bumped to v1.49.0 to match arion-api's package.json playwright version
# (browser binary version is tied to the npm package version).
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Copy only what the worker needs — not the whole arion-api tree.
# (Container Apps deployment script can rsync the right subset, or we can
# expand to the whole repo and trim with .dockerignore.)
COPY package.json package-lock.json* ./
# Drop --ignore-scripts so playwright's postinstall hook runs (creates bin links).
# Chromium binaries come from the base image (v1.49.0 ships chromium-1148).
RUN npm install --omit=dev \
 && node node_modules/playwright/cli.js install chromium

# Copy worker + the lib modules it imports
COPY workers/ ./workers/
COPY lib/hostinger.js ./lib/

ENV NODE_ENV=production
ENV PROVISIONER_PORT=8080
EXPOSE 8080

# Container Apps expects the listener on a single port, no graceful-shutdown
# hooks needed because Playwright cleans up on SIGTERM.
CMD ["node", "workers/siteProvisioner.js"]
