import { AppConfigurationClient } from '@azure/app-configuration';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * Fetches application configuration from Azure App Configuration and
 * Azure Key Vault.
 *
 * - Per-app values live in App Config under a prefix (e.g. "homepage/…").
 * - Shared OAuth credentials are App Config Key Vault references (unprefixed).
 *   The value is JSON containing the Key Vault secret URI, which we resolve.
 * - GitHub OAuth + JWT signing secret are read directly from Key Vault.
 *
 * Environment variables consumed:
 *   AZURE_APP_CONFIG_ENDPOINT  – App Configuration endpoint URL
 *   APP_CONFIG_PREFIX          – key prefix (e.g. "homepage")
 *   KEY_VAULT_URL              – Key Vault endpoint URL
 */
export async function fetchAppConfig() {
  const appConfigEndpoint = process.env.AZURE_APP_CONFIG_ENDPOINT;
  if (!appConfigEndpoint) {
    throw new Error('AZURE_APP_CONFIG_ENDPOINT environment variable is not set.');
  }

  const prefix = process.env.APP_CONFIG_PREFIX;
  if (!prefix) {
    throw new Error('APP_CONFIG_PREFIX environment variable is not set.');
  }

  const keyVaultUrl = process.env.KEY_VAULT_URL;
  if (!keyVaultUrl) {
    throw new Error('KEY_VAULT_URL environment variable is not set.');
  }

  const credential = new DefaultAzureCredential();
  const appConfigClient = new AppConfigurationClient(appConfigEndpoint, credential);
  const kvClient = new SecretClient(keyVaultUrl, credential);

  // Resolve an App Config Key Vault reference → actual secret value
  async function resolveKvReference(setting) {
    const { uri } = JSON.parse(setting.value);
    const secretName = new URL(uri).pathname.split('/')[2];
    return (await kvClient.getSecret(secretName)).value;
  }

  // ── App Configuration: per-app values (prefixed) ────────────────────
  const [cosmosEndpointSetting, auth0DomainSetting, auth0AppleClientIdSetting, auth0AppleClientSecretSetting, storageEndpointSetting] =
    await Promise.all([
      appConfigClient.getConfigurationSetting({ key: `${prefix}/cosmos_db_endpoint` }),
      appConfigClient.getConfigurationSetting({ key: `${prefix}/AUTH0_DOMAIN` }),
      appConfigClient.getConfigurationSetting({ key: `${prefix}/AUTH0_APPLE_CLIENT_ID` }),
      appConfigClient.getConfigurationSetting({ key: `${prefix}/AUTH0_APPLE_CLIENT_SECRET` }),
      appConfigClient.getConfigurationSetting({ key: `${prefix}/storage_account_endpoint` }),
    ]);

  // ── App Configuration: shared OAuth KV references (unprefixed) ──────
  const [googleClientIdSetting, googleClientSecretSetting, microsoftClientIdSetting, microsoftClientSecretSetting] =
    await Promise.all([
      appConfigClient.getConfigurationSetting({ key: 'google_oauth_client_id' }),
      appConfigClient.getConfigurationSetting({ key: 'google_oauth_client_secret' }),
      appConfigClient.getConfigurationSetting({ key: 'microsoft_oauth_client_id' }),
      appConfigClient.getConfigurationSetting({ key: 'microsoft_oauth_client_secret' }),
    ]);

  const [googleClientId, googleClientSecret, microsoftClientId, microsoftClientSecret] =
    await Promise.all([
      resolveKvReference(googleClientIdSetting),
      resolveKvReference(googleClientSecretSetting),
      resolveKvReference(microsoftClientIdSetting),
      resolveKvReference(microsoftClientSecretSetting),
    ]);

  // ── Key Vault: per-app secrets (GitHub OAuth + JWT) ─────────────────
  const [githubClientId, githubClientSecret, jwtSigningSecret] = (
    await Promise.all([
      kvClient.getSecret('github-oauth-client-id'),
      kvClient.getSecret('github-oauth-client-secret'),
      kvClient.getSecret('my-homepage-jwt-signing-secret'),
    ])
  ).map((s) => s.value);

  const config = {
    cosmosDbEndpoint: cosmosEndpointSetting.value,
    githubClientId,
    githubClientSecret,
    googleClientId,
    googleClientSecret,
    microsoftClientId,
    microsoftClientSecret,
    jwtSigningSecret,
    auth0Domain: auth0DomainSetting.value,
    auth0AppleClientId: auth0AppleClientIdSetting.value,
    auth0AppleClientSecret: auth0AppleClientSecretSetting.value,
    storageAccountEndpoint: storageEndpointSetting.value,
  };

  for (const [key, value] of Object.entries(config)) {
    if (!value) {
      throw new Error(`Configuration value "${key}" is missing or empty.`);
    }
  }

  console.log('[appConfig] Application config loaded from App Configuration + Key Vault');
  return config;
}
