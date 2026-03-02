# ============================================================================
# Azure Blob Storage — Profile Pictures
# ============================================================================
# App-specific storage account with a public-access container for user
# profile pictures. The Container App's managed identity gets
# "Storage Blob Data Contributor" so the backend can upload/delete blobs.

resource "azurerm_storage_account" "profile_pictures" {
  name                     = "homepageprofilepics"
  resource_group_name      = azurerm_resource_group.homepage.name
  location                 = azurerm_resource_group.homepage.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  blob_properties {
    cors_rule {
      allowed_origins    = ["*"]
      allowed_methods    = ["GET"]
      allowed_headers    = ["*"]
      exposed_headers    = ["*"]
      max_age_in_seconds = 3600
    }
  }
}

resource "azurerm_storage_container" "profile_pictures" {
  name                  = "profile-pictures"
  storage_account_id    = azurerm_storage_account.profile_pictures.id
  container_access_type = "blob"
}

# Grant Container App managed identity write access to the blob container
resource "azurerm_role_assignment" "container_app_storage_contributor" {
  scope                = azurerm_storage_account.profile_pictures.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_container_app.homepage_api["homepage-api"].identity[0].principal_id
}
