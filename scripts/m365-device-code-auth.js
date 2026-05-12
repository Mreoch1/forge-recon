const { PublicClientApplication, TokenCache } = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'e1c0fc4e-ecd1-455a-8dc2-e9d86f650d93';
const TENANT = '168f7184-878a-473d-8175-02882b27b76a';
const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'offline_access'];
const TOKEN_FILE = path.join(__dirname, '..', '.m365-token.json');
const CACHE_FILE = path.join(__dirname, '..', '.m365-cache.json');

// Load persisted cache or start fresh
let cacheData = {};
if (fs.existsSync(CACHE_FILE)) {
  try { cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
}

const pca = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT}`,
  },
  cache: {
    cacheLocation: 'file',
    cachePlugin: {
      beforeCacheAccess: async (cacheContext) => {
        cacheContext.tokenCache.deserialize(JSON.stringify(cacheData));
      },
      afterCacheAccess: async (cacheContext) => {
        if (cacheContext.cacheHasChanged) {
          cacheData = JSON.parse(cacheContext.tokenCache.serialize());
          fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        }
      },
    },
  },
});

async function getToken() {
  // Try to find an existing account in the cache
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({
        account: accounts[0],
        scopes: SCOPES,
      });
      console.log('[m365] Token refreshed from cache');
      return result.accessToken;
    } catch (e) {
      console.warn('[m365] Silent refresh failed:', e.message);
    }
  }

  // Check legacy simple token file (if it exists from a prior version)
  if (fs.existsSync(TOKEN_FILE)) {
    const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (cached.refreshToken) {
      try {
        const result = await pca.acquireTokenByRefreshToken({
          refreshToken: cached.refreshToken,
          scopes: SCOPES,
        });
        return result.accessToken;
      } catch (e) {
        console.warn('[m365] Legacy refresh token expired');
      }
    }
  }

  // Device code flow — stores result in MSAL cache automatically
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

  console.log('[m365] Token stored in MSAL cache');
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
