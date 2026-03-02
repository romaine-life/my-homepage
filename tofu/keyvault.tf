# ============================================================================
# Azure Key Vault (data source)
# ============================================================================
# Reads secrets from the shared Key Vault created by the bootstrap script.
# The vault name is passed via the Spacelift global context (TF_VAR_key_vault_name).

data "azurerm_key_vault" "main" {
  name                = var.key_vault_name
  resource_group_name = local.infra.resource_group_name
}

data "azurerm_key_vault_secret" "auth0_client_secret" {
  name         = "auth0-client-secret"
  key_vault_id = data.azurerm_key_vault.main.id
}

resource "random_password" "jwt_signing_secret" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "jwt_signing_secret" {
  name         = "my-homepage-jwt-signing-secret"
  value        = random_password.jwt_signing_secret.result
  key_vault_id = data.azurerm_key_vault.main.id
}
