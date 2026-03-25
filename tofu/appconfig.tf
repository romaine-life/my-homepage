# ============================================================================
# Azure App Configuration Key-Values
# ============================================================================
# These keys are read at runtime by the backend via fetchAppConfig() in
# backend/startup/appConfig.js. The Container App's managed identity has the
# "App Configuration Data Reader" role assigned in backend.tf.

resource "azurerm_app_configuration_key" "cosmos_db_endpoint" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/cosmos_db_endpoint"
  value                  = "https://${local.infra.cosmos_db_account_name}.documents.azure.com:443/"
}

resource "azurerm_app_configuration_key" "auth0_apple_client_id" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/AUTH0_APPLE_CLIENT_ID"
  value                  = auth0_client.backend_apple.client_id
}

resource "azurerm_app_configuration_key" "auth0_apple_client_secret" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/AUTH0_APPLE_CLIENT_SECRET"
  value                  = auth0_client_credentials.backend_apple.client_secret
}

resource "azurerm_app_configuration_key" "auth0_domain" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/AUTH0_DOMAIN"
  value                  = local.infra.auth0_domain
}

resource "azurerm_app_configuration_key" "storage_account_endpoint" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/storage_account_endpoint"
  value                  = azurerm_storage_account.profile_pictures.primary_blob_endpoint
}

resource "azurerm_app_configuration_key" "swa_default_hostname" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/swa_default_hostname"
  value                  = azurerm_static_web_app.homepage.default_host_name
}
