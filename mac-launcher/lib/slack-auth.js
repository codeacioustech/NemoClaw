const express = require('express');
const { shell } = require('electron');
const { WebClient } = require('@slack/web-api');
const { writeCredential } = require('./secure-credentials');

let authServer = null;

function startSlackAuthFlow(webContents) {
  if (authServer) {
    console.log('[slack-auth] Flow already in progress.');
    return;
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[slack-auth] SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is missing from .env');
    webContents.send('slack-auth-error', 'Missing Slack credentials in .env');
    return;
  }

  const app = express();
  const PORT = 3000;
  const redirectUri = `http://localhost:${PORT}/callback`;

  app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
      res.send('<html><body><h2>Authorization failed</h2><p>No code provided.</p></body></html>');
      return;
    }

    try {
      const slackClient = new WebClient();
      const response = await slackClient.oauth.v2.access({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri
      });

      if (response.ok) {
        const botToken = response.access_token; // the xoxb- token
        // Store it securely using our existing logic
        writeCredential('slack_token', botToken);
        
        res.send('<html><body><h2>Slack connected successfully!</h2><p>You can now close this tab and return to the app.</p></body></html>');
        
        // Notify the renderer
        webContents.send('slack-auth-success');
        
        // Re-initialize the socket mode client if possible, or just log
        const { initSlackSocket } = require('./slack-socket');
        initSlackSocket();

      } else {
        res.send(`<html><body><h2>Authorization failed</h2><p>Error from Slack: ${response.error}</p></body></html>`);
        webContents.send('slack-auth-error', response.error);
      }
    } catch (error) {
      console.error('[slack-auth] Error exchanging code:', error);
      res.send(`<html><body><h2>Authorization failed</h2><p>${error.message}</p></body></html>`);
      webContents.send('slack-auth-error', error.message);
    } finally {
      // Shut down server
      if (authServer) {
        authServer.close();
        authServer = null;
      }
    }
  });

  authServer = app.listen(PORT, () => {
    console.log(`[slack-auth] Listening on port ${PORT}`);
    const scopes = 'channels:read,channels:history,chat:write,app_mentions:read,connections:write';
    const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;
    shell.openExternal(authUrl);
  });
}

module.exports = { startSlackAuthFlow };
