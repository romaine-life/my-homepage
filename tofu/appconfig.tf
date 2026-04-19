# ============================================================================
# Azure App Configuration Key-Values
# ============================================================================

resource "azurerm_app_configuration_key" "cosmos_db_endpoint" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/cosmos_db_endpoint"
  value                  = "https://${local.infra.cosmos_db_account_name}.documents.azure.com:443/"
}

resource "azurerm_app_configuration_key" "storage_account_endpoint" {
  configuration_store_id = local.infra.azure_app_config_resource_id
  key                    = "${local.front_app_dns_name}/storage_account_endpoint"
  value                  = azurerm_storage_account.profile_pictures.primary_blob_endpoint
}
