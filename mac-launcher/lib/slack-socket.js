const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');
const { getDecrypted, hasCredential } = require('./secure-credentials');

let socketClient = null;
let webClient = null;

async function initSlackSocket() {
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken) {
    console.warn('[slack-socket] SLACK_APP_TOKEN is missing from .env');
    return;
  }

  // Check if we have an authorized bot token
  if (!hasCredential('slack_token')) {
    console.log('[slack-socket] No Slack bot token found. Socket mode will start when connected.');
    return;
  }

  const botToken = getDecrypted('slack_token');
  if (!botToken) {
    console.warn('[slack-socket] Found slack_token but could not decrypt it.');
    return;
  }

  if (socketClient) {
    console.log('[slack-socket] Socket already initialized. Reconnecting...');
    await socketClient.disconnect();
  }

  webClient = new WebClient(botToken);
  socketClient = new SocketModeClient({
    appToken: appToken,
    logLevel: 'warn'
  });

  socketClient.on('app_mention', async ({ event, body, ack }) => {
    try {
      await ack();
      console.log('Slack Mention:', event);
    } catch (e) {
      console.error('[slack-socket] Error acking app_mention:', e);
    }
  });

  try {
    await socketClient.start();
    console.log('[slack-socket] Connected to Slack Socket Mode!');
  } catch (err) {
    console.error('[slack-socket] Failed to start socket mode:', err);
  }
}

module.exports = { initSlackSocket };
