terraform {
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  use_oidc = true
}

provider "azapi" {
  use_oidc = true
}
