# ============================================================================
# Azure Blob Storage — Homepage Assets
# ============================================================================
# Shared storage account for profile pictures (public) and bookmarks (private).
# The shared workload identity (infra-shared-identity) gets "Storage Blob
# Data Contributor" so the backend can read/write blobs.

resource "azurerm_storage_account" "profile_pictures" {
  name                     = "homepageprofilepics"
  resource_group_name      = azurerm_resource_group.homepage.name
  location                 = azurerm_resource_group.homepage.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  blob_properties {
    versioning_enabled = true

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

data "azurerm_user_assigned_identity" "shared" {
  name                = "infra-shared-identity"
  resource_group_name = local.infra.resource_group_name
}

resource "azurerm_role_assignment" "shared_api_storage_contributor" {
  scope                = azurerm_storage_account.profile_pictures.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_user_assigned_identity.shared.principal_id
}
