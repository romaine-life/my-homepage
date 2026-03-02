# required_providers is sourced at runtime using a hook in spacelift from infra-bootstrap.

provider "azurerm" {
  features {}
  use_oidc = true
}

provider "azapi" {
  use_oidc = true
}

provider "auth0" {
  domain        = "dev-gtdi5x5p0nmticqd.us.auth0.com"
  client_id     = "7qsN7zrBAh7TwhjEUcgtU46yOSs9TXbg"
  client_secret = data.azurerm_key_vault_secret.auth0_client_secret.value
}
