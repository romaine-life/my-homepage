locals {
  _sub = "aee0cbd2-8074-4001-b610-0f8edb4eaa3c"
  _rg  = "infra"
  _dns = "romaine.life"
}

import {
  to = azurerm_resource_group.homepage
  id = "/subscriptions/${local._sub}/resourceGroups/homepage-rg"
}

import {
  to = azurerm_static_web_app.homepage
  id = "/subscriptions/${local._sub}/resourceGroups/homepage-rg/providers/Microsoft.Web/staticSites/homepage-app"
}

import {
  to = azurerm_dns_cname_record.homepage
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.Network/dnsZones/${local._dns}/CNAME/homepage"
}

import {
  to = azurerm_static_web_app_custom_domain.homepage
  id = "/subscriptions/${local._sub}/resourceGroups/homepage-rg/providers/Microsoft.Web/staticSites/homepage-app/customDomains/homepage.romaine.life"
}

import {
  to = azurerm_container_app.homepage_api["homepage-api"]
  id = "/subscriptions/${local._sub}/resourceGroups/homepage-rg/providers/Microsoft.App/containerApps/homepage-api"
}

import {
  to = azurerm_dns_txt_record.homepage_api_verification
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.Network/dnsZones/${local._dns}/TXT/asuid.homepage.api"
}

import {
  to = azurerm_dns_cname_record.homepage_api
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.Network/dnsZones/${local._dns}/CNAME/homepage.api"
}

import {
  to = azurerm_cosmosdb_sql_database.homepage
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.DocumentDB/databaseAccounts/infra-cosmos/sqlDatabases/HomepageDB"
}

import {
  to = azurerm_cosmosdb_sql_container.userdata
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.DocumentDB/databaseAccounts/infra-cosmos/sqlDatabases/HomepageDB/containers/userdata"
}

import {
  to = azurerm_storage_account.profile_pictures
  id = "/subscriptions/${local._sub}/resourceGroups/homepage-rg/providers/Microsoft.Storage/storageAccounts/homepageprofilepics"
}

import {
  to = azurerm_storage_container.profile_pictures
  id = "https://homepageprofilepics.blob.core.windows.net/profile-pictures"
}

import {
  to = azurerm_app_configuration_key.cosmos_db_endpoint
  id = "https://infra-appconfig.azconfig.io/kv/homepage%2Fcosmos_db_endpoint?label="
}

import {
  to = azurerm_app_configuration_key.auth0_apple_client_id
  id = "https://infra-appconfig.azconfig.io/kv/homepage%2FAUTH0_APPLE_CLIENT_ID?label="
}

import {
  to = azurerm_app_configuration_key.auth0_apple_client_secret
  id = "https://infra-appconfig.azconfig.io/kv/homepage%2FAUTH0_APPLE_CLIENT_SECRET?label="
}

import {
  to = azurerm_app_configuration_key.auth0_domain
  id = "https://infra-appconfig.azconfig.io/kv/homepage%2FAUTH0_DOMAIN?label="
}

import {
  to = azurerm_app_configuration_key.storage_account_endpoint
  id = "https://infra-appconfig.azconfig.io/kv/homepage%2Fstorage_account_endpoint?label="
}

import {
  to = azurerm_key_vault_secret.jwt_signing_secret
  id = "https://romaine-kv.vault.azure.net/secrets/my-homepage-jwt-signing-secret/e22bdf7d93c04d5dae9270c7279a6e46"
}

import {
  to = azapi_resource.homepage_api_managed_cert
  id = "/subscriptions/${local._sub}/resourceGroups/${local._rg}/providers/Microsoft.App/managedEnvironments/infra-aca/managedCertificates/homepage-api-cert"
}
