const { PublicClientApplication } = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'e1c0fc4e-ecd1-455a-8dc2-e9d86f650d93';
const TENANT = '168f7184-878a-473d-8175-02882b27b76a';
const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'offline_access'];
const TOKEN_FILE = path.join(__dirname, '..', '.m365-token.json');

const pca = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT}`,
  },
});

async function getToken() {
  // Check existing token
  if (fs.existsSync(TOKEN_FILE)) {
    const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (cached.refreshToken) {
      try {
        const result = await pca.acquireTokenByRefreshToken({
          refreshToken: cached.refreshToken,
          scopes: SCOPES,
        });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || cached.refreshToken,
          expiresOn: result.expiresOn,
          homeAccountId: result.account?.homeAccountId || cached.homeAccountId || null,
          username: result.account?.username || cached.username || null,
        }, null, 2));
        return result.accessToken;
      } catch (e) {
        console.warn('[m365] Refresh token expired, re-authenticating...');
      }
    }
  }

  // Device code flow
  const deviceCodes = await pca.acquireTokenByDeviceCode({
    deviceCodeCallback: (response) => {
      console.log('\n==========================================');
      console.log('AUTHENTICATION REQUIRED');
      console.log('==========================================');
      console.log('1. Go to: ' + response.verificationUri);
      console.log('2. Enter code: ' + response.userCode);
      console.log('3. Sign in as support@reconenterprises.net');
      console.log('4. Grant permissions for Mail.Read + Mail.ReadWrite');
      console.log('==========================================\n');
    },
    scopes: SCOPES,
  });

  // Store token — device code flow always returns refreshToken for M365 work accounts
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    accessToken: deviceCodes.accessToken,
    refreshToken: deviceCodes.refreshToken,
    expiresOn: deviceCodes.expiresOn,
    homeAccountId: deviceCodes.account?.homeAccountId || null,
    username: deviceCodes.account?.username || null,
  }, null, 2));

  console.log('[m365] Token stored in .m365-token.json');
  return deviceCodes.accessToken;
}

if (require.main === module) {
  getToken().then(token => {
    console.log('[m365] Authenticated successfully');
  }).catch(err => {
    console.error('[m365] Auth failed:', err.message);
    process.exit(1);
  });
}

module.exports = { getToken };
